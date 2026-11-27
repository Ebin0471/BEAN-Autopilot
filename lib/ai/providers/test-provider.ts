import { now, uuid } from "@/lib/db/util";
import type {
  AIProviderAdapter,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ModelMetadata,
  ProviderHealthResult,
  ProviderMetadata,
  StructuredOutputMode,
  TaskCategory,
  UsageAccuracy,
} from "../types";

/**
 * Deterministic test provider adapter.
 *
 * A provider-neutral, dependency-free adapter that produces deterministic,
 * predictable responses. It is used by the test suite and for local
 * development so the full CORE-03 pipeline (routing, conversation, streaming,
 * intent, planning, tool selection) can be exercised WITHOUT any real AI
 * provider, paid account or external dependency.
 *
 * It is NOT a production AI provider. It never claims real model capabilities
 * beyond what it declares, and it never fabricates tool execution results —
 * it only produces text and structured proposals that the governed
 * CORE-02 gateway validates and executes.
 */

export interface TestProviderOptions {
  providerId: string;
  providerName: string;
  /** Models this test provider exposes. */
  models: ModelMetadata[];
  /** Optional canned structured response keyed by task category. */
  structuredResponder?: (task: TaskCategory, request: AIRequest) => unknown;
}

export class TestProviderAdapter implements AIProviderAdapter {
  private meta: ProviderMetadata;

  constructor(private opts: TestProviderOptions) {
    this.meta = {
      providerId: opts.providerId,
      providerName: opts.providerName,
      version: "1.0.0",
      adapterType: "test",
      endpointRef: null,
      authRef: null,
      supportedModalities: ["text", "structured"],
      streamingSupported: true,
      structuredOutputSupported: true,
      structuredOutputMode: "PROMPTED_JSON" as StructuredOutputMode,
      toolCallSupported: true,
      contextWindow: 128000,
      rateLimit: { maxRequests: 600, windowSeconds: 60 },
      privacyClass: "INTERNAL",
      availabilityStatus: "AVAILABLE",
      healthStatus: "HEALTHY",
    };
  }

  describe(): ProviderMetadata {
    return { ...this.meta };
  }

  listModels(): Promise<ModelMetadata[]> {
    return Promise.resolve(this.opts.models.map((m) => ({ ...m })));
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    return {
      providerId: this.opts.providerId,
      healthy: true,
      health: "HEALTHY",
      latencyMs: 1,
      message: "Test provider is deterministic and available",
      checkedAt: now(),
    };
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.assertNotProduction();
    const start = Date.now();
    const model = this.opts.models.find((m) => m.modelId === request.modelId) ?? this.opts.models[0];
    const content = this.composeText(request);
    const structured = this.opts.structuredResponder
      ? this.opts.structuredResponder(request.taskCategory, request)
      : undefined;
    return {
      requestId: request.requestId,
      modelId: model.modelId,
      providerId: this.opts.providerId,
      content,
      structured,
      toolCalls: [],
      usage: {
        inputTokens: estimateTokens(request),
        outputTokens: estimateTokens(content),
        cachedTokens: 0,
        accuracy: "APPLICATION_ESTIMATE" as UsageAccuracy,
      },
      latencyMs: Date.now() - start,
      fallbackUsed: false,
    };
  }

  async *stream(request: AIRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
    this.assertNotProduction();
    const content = this.composeText(request);
    // Emit the content in deterministic word-chunks to simulate streaming.
    const words = content.split(/(\s+)/);
    for (const chunk of words) {
      if (signal?.aborted) {
        yield { type: "cancelled", requestId: request.requestId };
        return;
      }
      if (chunk) {
        yield { type: "delta", requestId: request.requestId, delta: chunk };
      }
    }
    yield {
      type: "complete",
      requestId: request.requestId,
      content,
      usage: {
        inputTokens: estimateTokens(request),
        outputTokens: estimateTokens(content),
        cachedTokens: 0,
        accuracy: "APPLICATION_ESTIMATE" as UsageAccuracy,
      },
    };
  }

  async cancel(_requestId: string): Promise<void> {
    // Deterministic test provider: cancellation is cooperative via the signal.
  }

  /**
   * Production restriction: the deterministic test provider must never serve
   * production traffic. It is registered so the pipeline is exercisable out of
   * the box in non-production, but the router excludes it in production and
   * these guards fail closed if it is invoked directly anyway.
   */
  private assertNotProduction(): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "The deterministic test provider is not permitted in production.",
      );
    }
  }

  private composeText(request: AIRequest): string {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const subject = lastUser?.content?.trim() || "your request";
    return `[test-provider] I understand: "${subject}". This is a deterministic test-provider response used to exercise the CORE-03 intelligence pipeline without a real AI provider. No external system was contacted.`;
  }
}

/** Rough token estimate (≈4 chars/token) for usage metadata only. */
function estimateTokens(input: { messages?: { content: string }[] } | string): number {
  const text =
    typeof input === "string"
      ? input
      : (input.messages ?? []).map((m) => m.content).join(" ");
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Convenience factory for a default deterministic test provider + models. */
export function createDefaultTestProvider(): {
  adapter: TestProviderAdapter;
  models: ModelMetadata[];
} {
  const models: ModelMetadata[] = [
    {
      modelId: "test.general",
      providerId: "test.provider",
      modelName: "Test General",
      modelVersion: "1.0.0",
      supportedTasks: ["GENERAL_CHAT", "RESEARCH", "SUMMARISATION", "TRANSLATION"],
      supportedModalities: ["text", "structured"],
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
      structuredOutput: true,
      structuredOutputMode: "PROMPTED_JSON" as StructuredOutputMode,
      toolCall: true,
      streaming: true,
      reasoning: false,
      latencyMetadata: null,
      costMetadata: null,
      privacyClass: "INTERNAL",
      status: "AVAILABLE",
      availabilityEvidence: "Deterministic test provider",
    },
    {
      modelId: "test.reasoning",
      providerId: "test.provider",
      modelName: "Test Reasoning",
      modelVersion: "1.0.0",
      supportedTasks: ["REASONING", "PLANNING", "WORKFLOW_DESIGN", "TOOL_SELECTION"],
      supportedModalities: ["text", "structured"],
      maxContextTokens: 128000,
      maxOutputTokens: 8192,
      structuredOutput: true,
      structuredOutputMode: "PROMPTED_JSON" as StructuredOutputMode,
      toolCall: true,
      streaming: true,
      reasoning: true,
      latencyMetadata: null,
      costMetadata: null,
      privacyClass: "INTERNAL",
      status: "AVAILABLE",
      availabilityEvidence: "Deterministic test provider",
    },
  ];
  const adapter = new TestProviderAdapter({
    providerId: "test.provider",
    providerName: "BEAN Test Provider",
    models,
    structuredResponder: deterministicStructuredResponder,
  });
  return { adapter, models };
}

/**
 * Deterministic structured responder for the default test provider. It
 * inspects the request's system prompt and returns a valid, minimal intent
 * or plan payload so the full CORE-03 pipeline (intent -> plan -> execute)
 * can be exercised deterministically with no real provider.
 */
function deterministicStructuredResponder(task: TaskCategory, request: AIRequest): unknown {
  const messages = request.messages ?? [];
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  if (sys.includes("intent classifier")) {
    return {
      taskCategory: "GENERAL_CHAT",
      desiredOutcome: "Fulfil the user request",
      entities: [],
      constraints: [],
      preferences: [],
      deadlines: [],
      amounts: [],
      targets: [],
      requestedActions: ["list_commands"],
      requiredCapabilities: [],
      sensitivityClassification: "INTERNAL",
      ambiguityList: [],
      missingInformation: [],
      confidence: 0.8,
      requiresClarification: false,
    };
  }
  if (sys.includes("task planner")) {
    return {
      objective: "Fulfil the user request",
      tasks: [
        {
          description: "Inspect the available command catalogue",
          dependsOn: [],
          parallelisable: false,
          requiredAgentId: null,
          candidateCommandIds: ["platform.commands.list"],
          requiredCapabilities: [],
          permissionRequirements: ["workspace.read"],
          riskClass: "R0",
          approvalRequired: false,
          expectedOutput: "registered command catalogue",
          verificationCriteria: ["result_validated"],
          humanCheckpoint: false,
        },
      ],
      requiredAgents: [],
      requiredCapabilities: [],
      expectedOutputs: ["command_list"],
      estimatedComplexity: "LOW",
      unresolvedQuestions: [],
    };
  }
  return undefined;
}

export { uuid };
