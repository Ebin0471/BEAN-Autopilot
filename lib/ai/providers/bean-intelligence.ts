/**
 * CORE-03G — BEAN Intelligence gateway adapter.
 *
 * Integrates Autopilot with the BEAN Intelligence public gateway (the hosted
 * AI gateway at `BEAN_INTELLIGENCE_BASE_URL`) via its documented `/api/v1`
 * surface. This is an HTTP integration over the public gateway contract — the
 * BEAN application's own source is NOT copied into Autopilot.
 *
 * Contract highlights:
 *  - Auth: `Authorization: Bearer bgk_...` (server-side env only).
 *  - `POST /api/v1/chat/completions` accepts OpenAI-style `{model, messages,
 *    stream, temperature, max_tokens|maxTokens}` and returns either the JSON
 *    envelope (`{ok, content, model, provider, finishReason, usage, durationMs}`)
 *    or an SSE stream (`data:{"delta"}` frames, a single terminal
 *    `data:{"done":true,...}` frame, `: keepalive` comments, and typed error
 *    frames `data:{"error","code","partial"}`).
 *  - `GET /api/v1/models` returns the public model projection (no endpoints, no
 *    credentials).
 *  - `GET /api/v1/health` reports live service + per-class availability.
 *
 * Honesty: the BEAN gateway does NOT implement native tool calls or
 * `response_format`. Structured output is therefore PROMPTED_JSON and
 * `toolCallSupported` is `false` — never claimed otherwise.
 */

import type {
  AIProviderAdapter,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ModelMetadata,
  ProviderAvailability,
  ProviderHealth,
  ProviderHealthResult,
  ProviderMetadata,
  StructuredOutputMode,
  TaskCategory,
  UsageAccuracy,
  UsageMetadata,
} from "../types";
import { httpRequest, httpSSEStream, ProviderHTTPError } from "../http";
import { parseSSEStream, type SSEStreamResult } from "../sse";
import {
  EndpointSafetyError,
  defaultEndpointPolicy,
  validateBaseUrl,
} from "../endpoint-safety";

/** Environment keys for the BEAN Intelligence gateway integration. */
export const BEAN_BASE_URL_ENV = "BEAN_INTELLIGENCE_BASE_URL";
export const BEAN_API_KEY_ENV = "BEAN_INTELLIGENCE_API_KEY";

/** BEAN gateway model ids (public contract). */
const BEAN_CHAT_MODEL = "bean-chat-hosted";
const BEAN_CODE_MODEL = "bean-code-hosted";

/** Provider-reported usage accuracy from the `usage.exact` flag. */
function usageAccuracy(exact: unknown): UsageAccuracy {
  return exact === true ? "PROVIDER_REPORTED_EXACT" : "PROVIDER_REPORTED_ESTIMATE";
}

/** Build usage metadata from a BEAN envelope's usage object. */
function toUsage(
  usage: { tokensIn: number; tokensOut: number; exact: boolean } | undefined,
): UsageMetadata {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, accuracy: "UNKNOWN" };
  }
  return {
    inputTokens: Number(usage.tokensIn) || 0,
    outputTokens: Number(usage.tokensOut) || 0,
    cachedTokens: 0,
    accuracy: usageAccuracy(usage.exact),
  };
}

/** Map a BEAN gateway error frame / HTTP error to a stable code. */
function beanErrorCode(code: string | undefined, fallback: string): string {
  switch (code) {
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "UNAUTHENTICATED":
    case "AUTH_REQUIRED":
      return "UNAUTHENTICATED";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "QUOTA_EXCEEDED":
      return "QUOTA_EXCEEDED";
    case "VALIDATION_ERROR":
      return "VALIDATION_ERROR";
    case "MODEL_NOT_FOUND":
    case "NOT_FOUND":
      return "MODEL_NOT_FOUND";
    case "UPSTREAM_ERROR":
    case "SERVICE_UNAVAILABLE":
      return "UPSTREAM_ERROR";
    default:
      return fallback;
  }
}

/** Construct headers for BEAN requests (credentials never logged). */
function beanHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

/** A typed stream error event. */
function streamError(
  requestId: string,
  code: string,
  message: string,
): AIStreamEvent {
  return { type: "error", requestId, error: { code, message } };
}

/**
 * BEAN Intelligence gateway adapter.
 *
 * A base URL + API key must be supplied. If absent, construct with
 * `createUnconfiguredBeanAdapter()` (a no-op that reports
 * CONFIGURATION_REQUIRED and throws on generate/stream).
 */
export class BeanIntelligenceAdapter implements AIProviderAdapter {
  private readonly endpoint: URL;

  constructor(
    readonly providerId: string,
    baseUrl: string,
    private readonly apiKey: string,
    private readonly providerName: string = "BEAN Intelligence",
  ) {
    // Validate the endpoint up front. This throws synchronously so a
    // misconfigured (or unsafe) base URL never produces a silently-broken
    // adapter — it fails at construction, where the bootstrap can register it
    // as CONFIGURATION_REQUIRED / DEGRADED rather than pretending connected.
    this.endpoint = validateBaseUrl(baseUrl, defaultEndpointPolicy());
  }

  describe(): ProviderMetadata {
    return {
      providerId: this.providerId,
      providerName: this.providerName,
      version: "1.0.0",
      adapterType: "native",
      // Only the configured host is retained, never a full credentialed URL.
      endpointRef: `${this.endpoint.protocol}//${this.endpoint.host}`,
      authRef: "Bearer (server-side env credential)",
      supportedModalities: ["text", "structured"],
      streamingSupported: true,
      structuredOutputSupported: true,
      structuredOutputMode: "PROMPTED_JSON" as StructuredOutputMode,
      toolCallSupported: false,
      contextWindow: 128000,
      rateLimit: { maxRequests: 60, windowSeconds: 60 },
      privacyClass: "EXTERNAL",
      availabilityStatus: "AVAILABLE" as ProviderAvailability,
      healthStatus: "UNKNOWN",
    };
  }

  /** Build the model list from the public model projection (no credentials). */
  async listModels(): Promise<ModelMetadata[]> {
    const res = await httpRequest<{ models?: Array<Record<string, unknown>> }>({
      method: "GET",
      url: `${this.endpoint.href}api/v1/models`,
      headers: beanHeaders(this.apiKey),
    });

    const models: ModelMetadata[] = [];
    const listed = res.data.models ?? [];
    for (const m of listed) {
      const id = String(m.id ?? "").trim();
      if (!id) continue;
      const capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
      const supportsChat = capabilities.includes("chat");
      const supportsStreaming =
        typeof m.streaming === "boolean"
          ? m.streaming
          : capabilities.includes("streaming");
      models.push({
        modelId: id,
        providerId: this.providerId,
        modelName: String(m.displayName ?? id),
        modelVersion: "1.0.0",
        supportedTasks: this.tasksForModel(id),
        supportedModalities: ["text", "structured"],
        maxContextTokens: 128000,
        maxOutputTokens: 32000,
        structuredOutput: true,
        structuredOutputMode: "PROMPTED_JSON" as StructuredOutputMode,
        toolCall: false,
        streaming: supportsStreaming,
        reasoning: false,
        latencyMetadata: { p50Ms: 500, p95Ms: 2000 },
        costMetadata: null,
        privacyClass: "EXTERNAL",
        status: supportsChat ? "AVAILABLE" : "REGISTERED",
        availabilityEvidence: `gateway model projection: ${id}`,
      });
    }
    return models;
  }

  private tasksForModel(modelId: string): TaskCategory[] {
    if (modelId === BEAN_CODE_MODEL) {
      return ["PLANNING", "TOOL_SELECTION", "RESEARCH"];
    }
    return ["GENERAL_CHAT", "RESEARCH", "TRANSLATION", "SUMMARISATION"];
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const start = Date.now();
    try {
      const res = await httpRequest<{
        live?: boolean;
        chatClass?: { available?: boolean };
        imageClass?: { available?: boolean };
        functionsClass?: { available?: boolean };
      }>({
        method: "GET",
        url: `${this.endpoint.href}api/v1/health`,
        headers: beanHeaders(this.apiKey),
        timeoutMs: 10_000,
      });
      const chatAvailable = res.data.chatClass?.available === true;
      const live = res.data.live === true;
      const health: ProviderHealth = live && chatAvailable ? "HEALTHY" : "DEGRADED";
      return {
        providerId: this.providerId,
        healthy: live && chatAvailable,
        health,
        latencyMs: Date.now() - start,
        message: live && chatAvailable
          ? "BEAN gateway reachable; chat class available."
          : `BEAN gateway reachable (live=${String(live)}, chatAvailable=${String(chatAvailable)}).`,
        checkedAt: new Date().toISOString(),
      };
    } catch (e) {
      const code =
        e instanceof ProviderHTTPError
          ? e.code
          : e instanceof EndpointSafetyError
            ? e.code
            : "UNKNOWN";
      return {
        providerId: this.providerId,
        healthy: false,
        health: "UNAVAILABLE",
        latencyMs: Date.now() - start,
        message: `BEAN gateway health check failed (${code}).`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const modelId = this.resolveModel(request.modelId);
    const body = this.buildBody(modelId, request, false);
    const start = Date.now();

    try {
      const res = await httpRequest<{
        ok: boolean;
        content: string;
        model: string;
        provider: string;
        finishReason: string;
        usage: { tokensIn: number; tokensOut: number; exact: boolean };
        durationMs: number;
      }>({
        method: "POST",
        url: `${this.endpoint.href}api/v1/chat/completions`,
        headers: beanHeaders(this.apiKey),
        body,
        signal: request.signal,
        timeoutMs: 60_000,
      });

      const data = res.data;
      return {
        requestId: request.requestId,
        modelId: data.model ?? modelId,
        providerId: this.providerId,
        content: typeof data.content === "string" ? data.content : "",
        structured: undefined,
        toolCalls: [],
        usage: toUsage(data.usage),
        latencyMs: Date.now() - start,
        fallbackUsed: false,
      };
    } catch (e) {
      if (e instanceof ProviderHTTPError) {
        const structured =
          request.responseSchema !== undefined
            ? { error: e.message, code: e.code }
            : undefined;
        return {
          requestId: request.requestId,
          modelId,
          providerId: this.providerId,
          content: "",
          structured,
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, accuracy: "UNKNOWN" },
          latencyMs: Date.now() - start,
          fallbackUsed: false,
          error: { code: beanErrorCode(e.code, "PROVIDER_ERROR"), message: e.message },
        };
      }
      throw e;
    }
  }

  stream(request: AIRequest): AsyncIterable<AIStreamEvent> {
    const modelId = this.resolveModel(request.modelId);
    const body = this.buildBody(modelId, request, true);
    const endpoint = this.endpoint;
    const apiKey = this.apiKey;

    return (async function* (): AsyncIterable<AIStreamEvent> {
      try {
        const byteStream = await httpSSEStream(
          `${endpoint.href}api/v1/chat/completions`,
          {
            method: "POST",
            headers: beanHeaders(apiKey),
            body,
            signal: request.signal,
            timeoutMs: 60_000,
          },
        );

        const result: SSEStreamResult = await parseSSEStream(byteStream, request.signal, {
          maxBytes: 4 * 1024 * 1024,
        });

        // Stream accumulated deltas even on terminal errors: the gateway
        // sends partial content before an error, and the SSE parser has
        // accumulated it into `result.content`.
        if (result.content.length > 0) {
          yield { type: "delta", requestId: request.requestId, delta: result.content };
        }

        if (result.error) {
          // Typed error frame. Whether partial content arrived is conveyed by
          // the deltas already yielded (honest partial-vs-complete).
          yield streamError(
            request.requestId,
            beanErrorCode(result.error.code, "SSE_ERROR"),
            result.error.partial
              ? `${result.error.message} (partial response streamed)`
              : result.error.message,
          );
          return;
        }

        // A stream that ended without a terminal frame is TRUNCATED — never
        // reported as a complete response.
        if (!result.terminal) {
          yield streamError(
            request.requestId,
            result.truncated ? "SSE_TRUNCATED" : "SSE_INCOMPLETE",
            result.truncated
              ? "Stream exceeded the maximum response size without a terminal frame."
              : "Stream ended without a terminal frame.",
          );
          return;
        }

        const done = (result.done ?? {}) as Record<string, unknown>;
        yield {
          type: "complete",
          requestId: request.requestId,
          content: result.content,
          usage: toUsage(
            done.usage as { tokensIn: number; tokensOut: number; exact: boolean } | undefined,
          ),
        };
      } catch (e) {
        if (request.signal?.aborted) {
          yield {
            type: "cancelled",
            requestId: request.requestId,
            error: { code: "ABORTED", message: "Request was aborted by the client." },
          };
          return;
        }
        if (e instanceof ProviderHTTPError) {
          yield streamError(
            request.requestId,
            beanErrorCode(e.code, "PROVIDER_ERROR"),
            e.message,
          );
          return;
        }
        yield streamError(
          request.requestId,
          "PROVIDER_ERROR",
          e instanceof Error ? e.message : "Stream failed.",
        );
      }
    })();
  }

  /** Resolve a requested model id to a BEAN gateway model id. */
  private resolveModel(requested: string): string {
    if (!requested || requested === "default") {
      return BEAN_CHAT_MODEL;
    }
    // Pass through known ids; an unknown id is forwarded unchanged and the
    // gateway rejects it — we never silently map to a different model.
    return requested;
  }

  /** Build the BEAN chat-completions request body. */
  private buildBody(
    modelId: string,
    request: AIRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = request.messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: m.content,
    }));

    const body: Record<string, unknown> = { model: modelId, messages, stream };
    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }
    if (typeof request.maxOutputTokens === "number") {
      // BEAN accepts both snake_case and camelCase; send max_tokens.
      body.max_tokens = request.maxOutputTokens;
    }

    // PROMPTED_JSON mode: when a structured schema is requested, we do NOT
    // send a native `response_format` (the gateway does not support it).
    // Instead we instruct the model to produce JSON via the system message.
    if (request.responseSchema !== undefined) {
      body.system =
        "Respond with a single JSON object that exactly matches the required schema. " +
        "Do not include markdown fences or any text outside the JSON object.";
      body.format = "json";
    }

    return body;
  }
}

/**
 * Create an unconfigured BEAN adapter: the base URL or API key is absent, so
 * the provider is registered as CONFIGURATION_REQUIRED. Every method reports
 * the gap and generate/stream throw — it NEVER pretends to be connected.
 */
export function createUnconfiguredBeanAdapter(providerId: string): {
  adapter: AIProviderAdapter;
  reason: string;
} {
  const missing: string[] = [];
  const baseUrl = process.env[BEAN_BASE_URL_ENV];
  const apiKey = process.env[BEAN_API_KEY_ENV];
  if (!baseUrl) missing.push(BEAN_BASE_URL_ENV);
  if (!apiKey) missing.push(BEAN_API_KEY_ENV);

  const reason = `BEAN Intelligence gateway is not configured. Missing environment: ${missing.join(", ")}.`;

  const adapter: AIProviderAdapter = {
    describe: () => ({
      providerId,
      providerName: "BEAN Intelligence",
      version: "1.0.0",
      adapterType: "native",
      endpointRef: null,
      authRef: null,
      supportedModalities: ["text", "structured"],
      streamingSupported: true,
      structuredOutputSupported: true,
      structuredOutputMode: "PROMPTED_JSON" as StructuredOutputMode,
      toolCallSupported: false,
      contextWindow: 128000,
      rateLimit: { maxRequests: 60, windowSeconds: 60 },
      privacyClass: "EXTERNAL",
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
    generate: () =>
      Promise.reject(new Error(`${providerId} is not configured. ${reason}`)),
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
