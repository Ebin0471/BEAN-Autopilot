import type { ProviderRegistry } from "./provider-registry";
import type { ModelRegistry } from "./model-registry";
import type { AgentRegistry } from "./agents";
import { createDefaultTestProvider } from "./providers/test-provider";
import { BeanIntelligenceAdapter, createUnconfiguredBeanAdapter } from "./providers/bean-intelligence";
import {
  OpenAICompatibleAdapter,
  createUnconfiguredOpenAICompatibleAdapter,
} from "./providers/openai-compatible";
import { LocalInferenceAdapter, createUnconfiguredLocalAdapter } from "./providers/local-inference";
import { loadProviderConfigs, resolveCredential } from "./config";
import type {
  AgentDefinition,
  AIProviderAdapter,
  ModelMetadata,
} from "./types";

/**
 * Register the default AI providers and models into the registries.
 *
 * The deterministic test provider is always registered and available (no
 * credentials, no external dependency), so the CORE-03 pipeline is exercisable
 * out of the box. Real providers (BEAN Intelligence, OpenAI-compatible,
 * local inference) are constructed from their documented contracts when their
 * server-side env is present. When credentials/endpoint are absent, a provider
 * is registered as CONFIGURATION_REQUIRED with a no-op adapter that throws on
 * generate/stream — it is NEVER pretend-connected.
 */
/** Register only the minimum genuine system-level agents (no providers). */
export function registerDefaultAgents(agents: AgentRegistry): void {
  agents.register(systemOrchestratorAgent());
}

export function registerDefaultAIProviders(
  providers: ProviderRegistry,
  models: ModelRegistry,
  agents?: AgentRegistry,
): void {
  // 1. Deterministic test provider (always available).
  const { adapter, models: testModels } = createDefaultTestProvider();
  providers.register(adapter.describe(), adapter);
  for (const m of testModels) {
    models.register({ ...m, status: "AVAILABLE" });
  }

  // 2. Minimum genuine system-level orchestration agent (NOT the 117-agent
  //    workforce — DOC-02 remains incomplete and is not fabricated).
  if (agents) registerDefaultAgents(agents);

  // 3. Optional configured providers (env-driven, opt-in). Each real provider
  //    is constructed from its documented contract; if its credentials/endpoint
  //    are absent it is registered CONFIGURATION_REQUIRED with a no-op adapter
  //    that fails on generate/stream — never pretend-connected.
  for (const cfg of loadProviderConfigs()) {
    if (cfg.providerId === "test.provider") continue;
    if (!cfg.enabled) continue;

    const built = buildProvider(cfg.providerId, cfg);
    if (!built) continue;

    const adapter = built.adapter;
    providers.register(adapter.describe(), adapter);

    // Model listing is async; defer it without blocking bootstrap. The
    // provider's adapter is registered synchronously and remains usable for
    // generate/stream regardless of whether the listing succeeds. A failed
    // listing does NOT make the provider unavailable — healthCheck reports
    // the truth.
    safeRegisterModels(adapter, models);
  }
}

/** Build a real adapter (or an unconfigured no-op) for a config. */
function buildProvider(
  providerId: string,
  cfg: { baseUrl: string | null; apiKeyEnv: string | null },
): { adapter: AIProviderAdapter } | null {
  if (providerId === "bean.intelligence") {
    const apiKey = resolveCredential(cfg.apiKeyEnv);
    if (cfg.baseUrl && apiKey) {
      return {
        adapter: new BeanIntelligenceAdapter(providerId, cfg.baseUrl, apiKey, "BEAN Intelligence"),
      };
    }
    return { adapter: createUnconfiguredBeanAdapter(providerId).adapter };
  }

  if (providerId === "openai.compatible") {
    const apiKey = resolveCredential(cfg.apiKeyEnv);
    const model = process.env.OPENAI_COMPATIBLE_MODEL;
    if (cfg.baseUrl && apiKey && model) {
      return {
        adapter: new OpenAICompatibleAdapter(
          providerId,
          cfg.baseUrl,
          apiKey,
          model,
          model,
        ),
      };
    }
    return { adapter: createUnconfiguredOpenAICompatibleAdapter(providerId).adapter };
  }

  if (providerId === "local.endpoint") {
    const model = process.env.LOCAL_INFERENCE_MODEL;
    if (cfg.baseUrl && model) {
      return {
        adapter: new LocalInferenceAdapter(providerId, cfg.baseUrl, model, model),
      };
    }
    return { adapter: createUnconfiguredLocalAdapter(providerId).adapter };
  }

  // Unknown provider: register nothing rather than fabricate a contract.
  return null;
}

/**
 * Best-effort, non-blocking model registration. Listing failures are swallowed
 * (the provider stays registered; health reflects the true state). Only
 * models that pass the registry's own validation are persisted.
 */
function safeRegisterModels(adapter: AIProviderAdapter, models: ModelRegistry): void {
  try {
    const promise = adapter.listModels();
    if (promise && typeof (promise as Promise<unknown>).then === "function") {
      (promise as Promise<ModelMetadata[]>)
        .then((ms) => {
          for (const m of ms) {
            try {
              models.register(m);
            } catch {
              /* duplicate/invalid model — skip */
            }
          }
        })
        .catch(() => {
          /* listing failed — provider still registered; health reflects it */
        });
    }
  } catch {
    /* listing threw synchronously — ignore */
  }
}

/**
 * The minimum genuine system-level orchestration agent. It coordinates planning
 * and delegates approved work to registered agents. It does NOT pretend to be
 * the 117 specialist agents (DOC-02 remains incomplete).
 */
function systemOrchestratorAgent(): AgentDefinition {
  return {
    agentId: "bean.system.orchestrator",
    name: "BEAN System Orchestrator",
    version: "1.0.0",
    description:
      "System-level orchestration component: understands intent, proposes plans, and delegates approved work to registered agents through the governed CORE-02 gateway.",
    category: "system",
    supportedWorkspaceTypes: ["PERSONAL", "PROFESSIONAL", "BUSINESS"],
    allowedCommandIds: [
      "platform.commands.list",
      "platform.commands.describe",
      "platform.capabilities.list",
      "platform.capabilities.describe",
      "platform.command.validate",
      "platform.command.preview",
      "workspace.members.list",
      "workspace.audit.list",
    ],
    requiredPermissions: ["workspace.read", "actions.execute"],
    requiredCapabilities: [],
    inputSchema: { type: "object", properties: { objective: { type: "string" } } },
    outputSchema: {
      type: "object",
      properties: {
        plan: { type: "object" },
        executions: { type: "array" },
        response: { type: "string" },
      },
    },
    riskConstraints: ["R0", "R1", "R2"],
    delegationPolicy: "BOUNDED",
    maximumSteps: 8,
    timeoutSeconds: 120,
    tokenBudget: null,
    verificationRequirements: ["result_validation"],
    escalationRules: ["Consequential (R3+) actions require human approval."],
    status: "ENABLED",
  };
}
