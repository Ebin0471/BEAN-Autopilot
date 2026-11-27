/**
 * CORE-03G — Local inference adapter.
 *
 * A thin adapter for a locally-hosted inference server (Ollama's OpenAI
 * shim, LM Studio, vLLM served locally, etc.). It reuses the OpenAI-compatible
 * Chat Completions transport but declares the provider as `local`
 * (`adapterType: "local"`) with `privacyClass: "LOCAL"`.
 *
 * Local endpoints are a deliberate security trade-off: binding to loopback or
 * a private host is only permitted when the server explicitly opts in via
 * `BEAN_AI_ALLOW_LOCAL_ENDPOINTS=1` (see `endpoint-safety.ts`). Without that
 * flag, an unconfigured local adapter is registered as CONFIGURATION_REQUIRED
 * and never dials a local address.
 *
 * Honesty: local servers may not implement native json_schema or tool calls.
 * Capabilities are declared conservatively; when unknown, structured output is
 * PROMPTED_JSON and tool calls are false — never silently claimed.
 */

import type {
  AIProviderAdapter,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ModelMetadata,
  ProviderAvailability,
  ProviderHealthResult,
  ProviderMetadata,
  StructuredOutputMode,
} from "../types";
import { OpenAICompatibleAdapter, type OpenAICompatibleCapabilities } from "./openai-compatible";
import { defaultEndpointPolicy, validateBaseUrl } from "../endpoint-safety";

/** Environment keys for the local inference integration. */
export const LOCAL_BASE_URL_ENV = "LOCAL_INFERENCE_BASE_URL";
export const LOCAL_MODEL_ENV = "LOCAL_INFERENCE_MODEL";

/** Default capabilities for a local server: no native schema, no tool calls. */
const LOCAL_CAPABILITIES: OpenAICompatibleCapabilities = {
  nativeJsonSchema: false,
  toolCalls: false,
  streamUsage: false,
};

/**
 * Local inference adapter. Delegates transport to the OpenAI-compatible
 * adapter but overrides the metadata to reflect local, private execution.
 */
export class LocalInferenceAdapter implements AIProviderAdapter {
  private readonly inner: OpenAICompatibleAdapter;

  constructor(
    private readonly providerId: string,
    baseUrl: string,
    private readonly modelId: string,
    private readonly modelName: string = modelId,
    private readonly capabilities: OpenAICompatibleCapabilities = LOCAL_CAPABILITIES,
  ) {
    // The base URL must pass the endpoint-safety policy. Local hosts require
    // BEAN_AI_ALLOW_LOCAL_ENDPOINTS=1, which is enforced inside the policy.
    const policy = defaultEndpointPolicy();
    validateBaseUrl(baseUrl, policy);
    this.inner = new OpenAICompatibleAdapter(
      providerId,
      baseUrl,
      "",
      modelId,
      modelName,
      capabilities,
      "Local inference",
    );
  }

  describe(): ProviderMetadata {
    const meta = this.inner.describe();
    return {
      ...meta,
      adapterType: "local",
      providerName: "Local inference",
      privacyClass: "LOCAL",
      endpointRef: meta.endpointRef,
    };
  }

  async listModels(): Promise<ModelMetadata[]> {
    const models = await this.inner.listModels();
    return models.map((m) => ({ ...m, privacyClass: "LOCAL" as const }));
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const res = await this.inner.healthCheck();
    return { ...res, message: `Local inference: ${res.message}` };
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    return this.inner.generate(request);
  }

  stream(request: AIRequest): AsyncIterable<AIStreamEvent> {
    return this.inner.stream(request);
  }
}

/**
 * Create an unconfigured local adapter: no base URL/model, or local endpoints
 * not permitted. Registered as CONFIGURATION_REQUIRED; generate/stream fail.
 */
export function createUnconfiguredLocalAdapter(providerId: string): {
  adapter: AIProviderAdapter;
  reason: string;
} {
  const baseUrl = process.env[LOCAL_BASE_URL_ENV];
  const model = process.env[LOCAL_MODEL_ENV];
  const allowLocal =
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS === "1" ||
    process.env.BEAN_AI_ALLOW_LOCAL_ENDPOINTS === "true";

  const missing: string[] = [];
  if (!baseUrl) missing.push(LOCAL_BASE_URL_ENV);
  if (!model) missing.push(LOCAL_MODEL_ENV);
  if (!allowLocal) missing.push("BEAN_AI_ALLOW_LOCAL_ENDPOINTS=1");

  const reason = `Local inference provider is not configured. Missing environment: ${missing.join(", ")}.`;

  const adapter: AIProviderAdapter = {
    describe: () => ({
      providerId,
      providerName: "Local inference",
      version: "1.0.0",
      adapterType: "local",
      endpointRef: null,
      authRef: null,
      supportedModalities: ["text", "structured"],
      streamingSupported: true,
      structuredOutputSupported: true,
      structuredOutputMode: "PROMPTED_JSON" as StructuredOutputMode,
      toolCallSupported: false,
      contextWindow: 128000,
      rateLimit: { maxRequests: 60, windowSeconds: 60 },
      privacyClass: "LOCAL",
      availabilityStatus: "CONFIGURATION_REQUIRED" as ProviderAvailability,
      healthStatus: "UNKNOWN",
    }),
    listModels: async () => [],
    healthCheck: async () => ({
      providerId,
      healthy: false,
      health: "UNAVAILABLE",
      latencyMs: 0,
      message: reason,
      checkedAt: new Date().toISOString(),
    }),
    generate: () => Promise.reject(new Error(`${providerId} is not configured. ${reason}`)),
    stream: () =>
      (async function* (): AsyncIterable<AIStreamEvent> {
        yield {
          type: "error",
          requestId: "unconfigured",
          error: { code: "NOT_CONFIGURED", message: `${providerId} is not configured. ${reason}` },
        };
      })(),
  };

  return { adapter, reason };
}
