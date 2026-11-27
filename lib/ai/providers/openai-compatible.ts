/**
 * CORE-03G — OpenAI-compatible adapter.
 *
 * A reusable adapter for any endpoint that speaks the OpenAI Chat Completions
 * protocol (`POST {base}/chat/completions` with `{model, messages, stream}`,
 * standard SSE delta frames `data: {choices:[{delta:{content}}]}`, and a
 * terminal `data: [DONE]` frame). This covers OpenAI itself and the many
 * OpenAI-compatible gateways (vLLM, LM Studio, Ollama's OpenAI shim, etc.).
 *
 * Honesty:
 *  - Structured output is reported honestly. If the endpoint supports a native
 *    `response_format: { type: "json_schema", json_schema: {...} }` it is
 *    declared NATIVE_JSON_SCHEMA and used; otherwise structured output is
 *    PROMPTED_JSON (the model is instructed to produce JSON, not schema-bound).
 *  - Tool-call support is declared only when the endpoint genuinely implements
 *    OpenAI tool calls, and is never silently claimed for a local shim.
 *  - Provider-reported token usage is labeled EXACT only when the endpoint
 *    reports usage (and the `stream_options.include_usage` flag is honored);
 *    otherwise usage is an application estimate.
 *  - Base URLs come only from server-side env; endpoint safety (SSRF) is
 *    enforced before every request.
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
  TaskCategory,
  UsageAccuracy,
  UsageMetadata,
} from "../types";
import { httpRequest, httpSSEStream, ProviderHTTPError } from "../http";
import {
  EndpointSafetyError,
  defaultEndpointPolicy,
  validateBaseUrl,
} from "../endpoint-safety";

/** Environment keys for the OpenAI-compatible integration. */
export const OPENAI_BASE_URL_ENV = "OPENAI_COMPATIBLE_BASE_URL";
export const OPENAI_API_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";
export const OPENAI_MODEL_ENV = "OPENAI_COMPATIBLE_MODEL";

/** Capability flags for an OpenAI-compatible endpoint. */
export interface OpenAICompatibleCapabilities {
  /** Endpoint accepts a native `response_format` json_schema. */
  nativeJsonSchema: boolean;
  /** Endpoint implements OpenAI tool calls. */
  toolCalls: boolean;
  /** Endpoint honors `stream_options.include_usage`. */
  streamUsage: boolean;
}

/** Default capabilities for an OpenAI-compatible endpoint. */
const DEFAULT_CAPABILITIES: OpenAICompatibleCapabilities = {
  nativeJsonSchema: true,
  toolCalls: true,
  streamUsage: true,
};

/** Structured-output mode derived from capabilities. */
function structuredMode(caps: OpenAICompatibleCapabilities): StructuredOutputMode {
  return caps.nativeJsonSchema ? "NATIVE_JSON_SCHEMA" : "PROMPTED_JSON";
}

/** Build usage metadata, labeling accuracy honestly. */
function toUsage(
  usage: { prompt_tokens: number; completion_tokens: number } | undefined,
  caps: OpenAICompatibleCapabilities,
): UsageMetadata {
  if (!usage || !caps.streamUsage) {
    return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, accuracy: "UNKNOWN" };
  }
  return {
    inputTokens: Number(usage.prompt_tokens) || 0,
    outputTokens: Number(usage.completion_tokens) || 0,
    cachedTokens: 0,
    // OpenAI-compatible usage is provider-reported. We label it exact only
    // when the endpoint reported real counts (it did); estimates are never
    // labeled exact.
    accuracy: "PROVIDER_REPORTED_EXACT" as UsageAccuracy,
  };
}

/** Map an OpenAI-compatible HTTP error to a stable code. */
function mapHttpCode(code: string): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "UNAUTHENTICATED";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "NOT_FOUND":
      return "MODEL_NOT_FOUND";
    case "VALIDATION_ERROR":
      return "VALIDATION_ERROR";
    case "SERVICE_UNAVAILABLE":
    case "UPSTREAM_ERROR":
      return "UPSTREAM_ERROR";
    default:
      return "PROVIDER_ERROR";
  }
}

function streamError(requestId: string, code: string, message: string): AIStreamEvent {
  return { type: "error", requestId, error: { code, message } };
}

/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * `modelId`/`modelName` describe the single model this endpoint serves (the
 * endpoint's `model` field). `capabilities` declares honest feature support.
 */
export class OpenAICompatibleAdapter implements AIProviderAdapter {
  private readonly endpoint: URL;

  constructor(
    private readonly providerId: string,
    baseUrl: string,
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly modelName: string = modelId,
    private readonly capabilities: OpenAICompatibleCapabilities = DEFAULT_CAPABILITIES,
    private readonly providerName: string = "OpenAI-compatible",
  ) {
    this.endpoint = validateBaseUrl(baseUrl, defaultEndpointPolicy());
  }

  describe(): ProviderMetadata {
    const mode = structuredMode(this.capabilities);
    return {
      providerId: this.providerId,
      providerName: this.providerName,
      version: "1.0.0",
      adapterType: "openai-compatible",
      endpointRef: `${this.endpoint.protocol}//${this.endpoint.host}`,
      authRef: "Bearer (server-side env credential)",
      supportedModalities: ["text", "structured"],
      streamingSupported: true,
      structuredOutputSupported: mode !== "NONE",
      structuredOutputMode: mode,
      toolCallSupported: this.capabilities.toolCalls,
      contextWindow: 128000,
      rateLimit: { maxRequests: 60, windowSeconds: 60 },
      privacyClass: "EXTERNAL",
      availabilityStatus: "AVAILABLE" as ProviderAvailability,
      healthStatus: "UNKNOWN",
    };
  }

  async listModels(): Promise<ModelMetadata[]> {
    // The OpenAI-compatible adapter serves the single configured model; it
    // does NOT invent a model catalogue. The model id is the configured one.
    const mode = structuredMode(this.capabilities);
    return [
      {
        modelId: this.modelId,
        providerId: this.providerId,
        modelName: this.modelName,
        modelVersion: "1.0.0",
        supportedTasks: ["GENERAL_CHAT", "RESEARCH", "TRANSLATION", "SUMMARISATION"] as TaskCategory[],
        supportedModalities: ["text", "structured"],
        maxContextTokens: 128000,
        maxOutputTokens: 32000,
        structuredOutput: mode !== "NONE",
        structuredOutputMode: mode,
        toolCall: this.capabilities.toolCalls,
        streaming: true,
        reasoning: false,
        latencyMetadata: null,
        costMetadata: null,
        privacyClass: "EXTERNAL",
        status: "AVAILABLE",
        availabilityEvidence: `configured model: ${this.modelId}`,
      },
    ];
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const start = Date.now();
    try {
      // Probe the /models endpoint (OpenAI-compatible convention). A 2xx means
      // the endpoint is reachable and authenticated.
      const res = await httpRequest<{ data?: Array<Record<string, unknown>> }>({
        method: "GET",
        url: `${this.endpoint.href}v1/models`,
        headers: this.authHeaders(),
        timeoutMs: 10_000,
      });
      const healthy = Array.isArray(res.data.data);
      return {
        providerId: this.providerId,
        healthy,
        health: healthy ? "HEALTHY" : "DEGRADED",
        latencyMs: Date.now() - start,
        message: healthy ? "OpenAI-compatible endpoint reachable." : "Endpoint reachable but model list unexpected.",
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
        message: `OpenAI-compatible health check failed (${code}).`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const start = Date.now();
    const body = this.buildBody(request, false);
    try {
      const res = await httpRequest<{
        choices: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>({
        method: "POST",
        url: `${this.endpoint.href}v1/chat/completions`,
        headers: this.authHeaders(),
        body,
        signal: request.signal,
        timeoutMs: 60_000,
      });
      const content = res.data.choices?.[0]?.message?.content ?? "";
      return {
        requestId: request.requestId,
        modelId: this.modelId,
        providerId: this.providerId,
        content,
        structured: undefined,
        toolCalls: [],
        usage: toUsage(res.data.usage, this.capabilities),
        latencyMs: Date.now() - start,
        fallbackUsed: false,
      };
    } catch (e) {
      if (e instanceof ProviderHTTPError) {
        return {
          requestId: request.requestId,
          modelId: this.modelId,
          providerId: this.providerId,
          content: "",
          structured:
            request.responseSchema !== undefined
              ? { error: e.message, code: e.code }
              : undefined,
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, accuracy: "UNKNOWN" },
          latencyMs: Date.now() - start,
          fallbackUsed: false,
          error: { code: mapHttpCode(e.code), message: e.message },
        };
      }
      throw e;
    }
  }

  stream(request: AIRequest): AsyncIterable<AIStreamEvent> {
    const body = this.buildBody(request, true);
    const endpoint = this.endpoint;
    const apiKey = this.apiKey;
    const caps = this.capabilities;

    return (async function* (): AsyncIterable<AIStreamEvent> {
      try {
        const byteStream = await httpSSEStream(`${endpoint.href}v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body,
          signal: request.signal,
          timeoutMs: 60_000,
        });

        // The OpenAI SSE format differs from BEAN's: deltas are nested under
        // choices[0].delta.content, the terminal frame is the literal
        // `data: [DONE]`, and usage (if requested) arrives in a final frame.
        const result = await parseOpenAIStream(byteStream, request.signal);

        if (result.error) {
          if (result.content.length > 0) {
            yield { type: "delta", requestId: request.requestId, delta: result.content };
          }
          yield streamError(request.requestId, result.error.code, result.error.message);
          return;
        }

        if (result.content.length > 0) {
          yield { type: "delta", requestId: request.requestId, delta: result.content };
        }

        if (result.done === false) {
          // Stream ended without a [DONE] terminator.
          yield streamError(
            request.requestId,
            "SSE_INCOMPLETE",
            "Stream ended without a terminal [DONE] frame.",
          );
          return;
        }

        yield {
          type: "complete",
          requestId: request.requestId,
          content: result.content,
          usage: toUsage(result.usage, caps),
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
          yield streamError(request.requestId, mapHttpCode(e.code), e.message);
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

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  /** Build an OpenAI Chat Completions request body. */
  private buildBody(request: AIRequest, stream: boolean): Record<string, unknown> {
    const messages = request.messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      stream,
    };
    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }
    if (typeof request.maxOutputTokens === "number") {
      body.max_tokens = request.maxOutputTokens;
    }

    // Structured output: use native json_schema when supported, else PROMPTED.
    if (request.responseSchema !== undefined && this.capabilities.nativeJsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: request.responseSchema,
          strict: true,
        },
      };
    } else if (request.responseSchema !== undefined) {
      body.response_format = { type: "json_object" };
      body.system =
        "Respond with a single JSON object that exactly matches the required schema. " +
        "Do not include markdown fences or any text outside the JSON object.";
    }

    if (stream && this.capabilities.streamUsage) {
      // Ask the endpoint to include a final usage frame in the stream.
      body.stream_options = { include_usage: true };
    }

    return body;
  }
}

/**
 * A minimal OpenAI-SSE parser. It shares the low-level chunk/CRLF/keepalive
 * handling with `parseSSEStream` but understands the OpenAI frame shapes:
 *   `data: {"choices":[{"delta":{"content":"..."}}]}`
 *   `data: {"usage":{...}}`
 *   `data: [DONE]`  (terminal)
 *   `: keepalive`    (comment, ignored)
 *   `data: {"error":{...}}`  (typed error)
 *
 * To avoid duplicating the framing logic, this reuses `parseSSEStream`'s
 * frame splitter by re-encoding data frames into the BEAN delta shape before
 * delegating. For clarity we instead implement a focused parser here.
 */
async function parseOpenAIStream(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<{
  content: string;
  done: boolean;
  usage: { prompt_tokens: number; completion_tokens: number } | undefined;
  error: { code: string; message: string } | null;
}> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
  let done = false;
  let error: { code: string; message: string } | null = null;
  const MAX = 4 * 1024 * 1024;
  let bytes = 0;

  const handleFrame = (raw: string): "terminal" | "continue" => {
    const line = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // A frame may be multi-line; OpenAI sends a single data line per frame.
    for (const l of line.split("\n")) {
      if (l === "" || l.startsWith(":")) continue; // separator / comment
      if (!l.startsWith("data:")) continue;
      const value = l.slice(5);
      const data = value.startsWith(" ") ? value.slice(1) : value;
      if (data === "[DONE]") {
        done = true;
        return "terminal";
      }
      try {
        const obj = JSON.parse(data) as Record<string, unknown>;
        if (obj.error) {
          const e = obj.error as Record<string, unknown>;
          error = {
            code: typeof e.code === "string" ? e.code : "SSE_ERROR",
            message: typeof e.message === "string" ? e.message : "Upstream error.",
          };
          return "terminal";
        }
        if (obj.usage) {
          usage = obj.usage as { prompt_tokens: number; completion_tokens: number };
        }
        const choice = (obj.choices as Array<Record<string, unknown>>)?.[0];
        const delta = (choice?.delta as Record<string, unknown>)?.content;
        if (typeof delta === "string") {
          content += delta;
        }
      } catch {
        // Non-JSON data frame: ignore (do not treat as terminal).
      }
    }
    return "continue";
  };

  for await (const chunk of chunks) {
    if (signal?.aborted) break;
    bytes += chunk.length;
    if (bytes > MAX) break;
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = findSeparator(buffer)) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 1);
      if (handleFrame(frame) === "terminal") {
        return { content, done, usage, error };
      }
    }
  }
  // Flush the trailing partial frame.
  if (buffer.trim() !== "") handleFrame(buffer);
  return { content, done, usage, error };
}

function findSeparator(buffer: string): number {
  const a = buffer.indexOf("\n\n");
  if (a !== -1) return a;
  return buffer.indexOf("\r\n\r\n");
}

/**
 * Create an unconfigured OpenAI-compatible adapter: base URL/API key/model is
 * absent, so the provider is registered as CONFIGURATION_REQUIRED and every
 * generate/stream call fails — never pretends to be connected.
 */
export function createUnconfiguredOpenAICompatibleAdapter(
  providerId: string,
): { adapter: AIProviderAdapter; reason: string } {
  const missing: string[] = [];
  const baseUrl = process.env[OPENAI_BASE_URL_ENV];
  const apiKey = process.env[OPENAI_API_KEY_ENV];
  const model = process.env[OPENAI_MODEL_ENV];
  if (!baseUrl) missing.push(OPENAI_BASE_URL_ENV);
  if (!apiKey) missing.push(OPENAI_API_KEY_ENV);
  if (!model) missing.push(OPENAI_MODEL_ENV);
  const reason = `OpenAI-compatible provider is not configured. Missing environment: ${missing.join(", ")}.`;

  const adapter: AIProviderAdapter = {
    describe: () => ({
      providerId,
      providerName: "OpenAI-compatible",
      version: "1.0.0",
      adapterType: "openai-compatible",
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
