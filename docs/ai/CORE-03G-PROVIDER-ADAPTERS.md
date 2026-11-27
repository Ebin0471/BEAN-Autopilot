# CORE-03G — Provider Adapters

Three adapters implement the `AIProviderAdapter` contract
(`describe` / `listModels` / `healthCheck` / `generate` / `stream` / `cancel?`).
Each is constructed from server-side environment configuration and validated
against endpoint safety at construction time.

## `BeanIntelligenceAdapter` (`lib/ai/providers/bean-intelligence.ts`)

Integrates with the **BEAN Intelligence public gateway** via its documented
`/api/v1` surface. This is an HTTP integration over the public contract — the
BEAN application's own source is **not** copied into Autopilot.

- **Auth**: `Authorization: Bearer bgk_...` (server-side env only).
- **Endpoints**: `POST /api/v1/chat/completions`, `GET /api/v1/models`,
  `GET /api/v1/health`.
- **JSON response**: `{ok, content, model, provider, finishReason, usage:{tokensIn,tokensOut,exact}, durationMs}`.
- **SSE**: `data:{"delta"}` frames, a single terminal `data:{"done":true,...}`,
  `: keepalive` comments, and typed error frames `data:{"error","code","partial"}`.
- **Honesty**: no native tool calls, no native `response_format`. Structured
  output is `PROMPTED_JSON`; `toolCallSupported` is `false`.

### Construction

```ts
new BeanIntelligenceAdapter("bean.intelligence", baseUrl, apiKey, "BEAN Intelligence")
```

If `BEAN_INTELLIGENCE_BASE_URL` or `BEAN_INTELLIGENCE_API_KEY` is absent,
`createUnconfiguredBeanAdapter()` returns a no-op adapter registered as
`CONFIGURATION_REQUIRED` that throws on `generate`/`stream`.

## `OpenAICompatibleAdapter` (`lib/ai/providers/openai-compatible.ts`)

A reusable adapter for any endpoint speaking the OpenAI Chat Completions
protocol (`POST {base}/v1/chat/completions` with `{model, messages, stream}`).

- **SSE**: OpenAI frame shape — `data:{"choices":[{"delta":{"content"}}]}`,
  terminal `data: [DONE]`, usage in a final frame (via
  `stream_options.include_usage`).
- **Structured output**: when the endpoint supports a native
  `response_format` json_schema, it is declared `NATIVE_JSON_SCHEMA` and used;
  otherwise `PROMPTED_JSON`.
- **Capabilities** are declared via `OpenAICompatibleCapabilities`
  (`nativeJsonSchema`, `toolCalls`, `streamUsage`) and never silently claimed.

### Construction

```ts
new OpenAICompatibleAdapter(providerId, baseUrl, apiKey, modelId, modelName, capabilities)
```

## `LocalInferenceAdapter` (`lib/ai/providers/local-inference.ts`)

A thin adapter for a locally-hosted inference server (Ollama's OpenAI shim,
LM Studio, vLLM locally). It reuses the OpenAI-compatible transport but
declares `adapterType: "local"` and `privacyClass: "LOCAL"`.

- Local endpoints are permitted **only** when
  `BEAN_AI_ALLOW_LOCAL_ENDPOINTS=1`. Without it, endpoint safety blocks
  loopback/private hosts and the adapter is registered `CONFIGURATION_REQUIRED`.
- Capabilities default conservatively: `nativeJsonSchema: false`,
  `toolCalls: false`, `streamUsage: false`.

## Usage-accuracy labelling

Every adapter labels `UsageMetadata.accuracy` honestly:

- `PROVIDER_REPORTED_EXACT` — the endpoint reported real token counts
  (BEAN `usage.exact: true`; OpenAI-compatible with usage reported).
- `PROVIDER_REPORTED_ESTIMATE` — provider-reported but not exact.
- `APPLICATION_ESTIMATE` — estimated by Autopilot (test provider).
- `UNKNOWN` — no usage reported.

Provider-reported estimates are **never** labelled exact.

## Production restriction

The deterministic **test provider** never serves production traffic. The router
excludes it when `NODE_ENV === "production"`, and the test provider's own
`generate`/`stream` throw if invoked directly in production.
