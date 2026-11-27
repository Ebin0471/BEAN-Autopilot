# CORE-03G — Structured Output (Prompted JSON)

CORE-03G supports structured model output in three modes, declared per
provider/model via `structuredOutputMode`:

| Mode | Meaning |
|------|---------|
| `NONE` | No structured output. |
| `PROMPTED_JSON` | Autopilot requests a JSON object in text and parses it; the model is **not** schema-bound. |
| `NATIVE_JSON_SCHEMA` | The provider enforces a JSON schema natively (`response_format`). |

## BEAN Intelligence: PROMPTED_JSON

The BEAN gateway does **not** implement native `response_format` or tool
calls. Therefore the BEAN adapter is always `PROMPTED_JSON` with
`toolCallSupported: false`. When a `responseSchema` is requested, the adapter:

- adds a system instruction: *"Respond with a single JSON object that exactly
  matches the required schema. Do not include markdown fences or any text
  outside the JSON object."*;
- sends `format: "json"`.

It **never** claims provider-native constrained JSON or tool calls for BEAN.

## OpenAI-compatible: conditional

The OpenAI-compatible adapter uses `NATIVE_JSON_SCHEMA` when
`capabilities.nativeJsonSchema` is `true` (sends
`response_format: { type: "json_schema", json_schema: { ... }, strict: true }`).
When the endpoint does not support it, it falls back to `PROMPTED_JSON`
(`response_format: { type: "json_object" }` + a system instruction).

## Local inference: PROMPTED_JSON

Local servers may not implement native schema; the local adapter defaults to
`nativeJsonSchema: false` and therefore `PROMPTED_JSON`.

## Untrusted output

Structured output from the model is **untrusted input**. The intent engine
validates it against a strict Zod schema before accepting it (malformed output
is rejected, never coerced). The orchestrator uses the model's text response
only as the response surface — it is **not** re-parsed into commands, plan, or
approvals.

## No fabrication

Capabilities are never invented. A provider that does not support tool calls
reports `toolCallSupported: false`; a provider without native schema reports
`PROMPTED_JSON`. Models, costs, and token counts are never fabricated.
