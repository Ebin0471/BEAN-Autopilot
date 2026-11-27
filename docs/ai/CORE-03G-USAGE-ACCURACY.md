# CORE-03G — Usage Accuracy Labelling

Token usage is labelled honestly. `UsageMetadata.accuracy` has four values:

| Value | Meaning |
|-------|---------|
| `PROVIDER_REPORTED_EXACT` | The provider reported exact token counts. |
| `PROVIDER_REPORTED_ESTIMATE` | The provider reported counts, but they are estimates. |
| `APPLICATION_ESTIMATE` | Autopilot estimated the count (e.g. ≈4 chars/token). |
| `UNKNOWN` | No usage reported. |

## Rule

**Provider-reported estimates are never labelled exact.** An estimate is only
`PROVIDER_REPORTED_EXACT` when the provider explicitly signals exactness.

## Per-adapter behaviour

- **BEAN Intelligence** — the gateway returns `usage: { tokensIn, tokensOut,
  exact }`. `exact === true` → `PROVIDER_REPORTED_EXACT`; otherwise
  `PROVIDER_REPORTED_ESTIMATE`.
- **OpenAI-compatible** — the endpoint reports
  `usage: { prompt_tokens, completion_tokens }`. When usage is reported (and
  `streamUsage` is supported), it is `PROVIDER_REPORTED_EXACT`; if the endpoint
  does not report usage, it is `UNKNOWN`.
- **Local inference** — depends on the server; defaults to `UNKNOWN` when no
  usage is reported.
- **Test provider** — uses `APPLICATION_ESTIMATE` (a rough char/token
  estimate). It is never labelled exact.

## Streaming usage

For streaming, the BEAN gateway's terminal `done` frame may carry `usage`; the
SSE parser captures it and the adapter maps it through the same accuracy
rule. If no usage is available on the terminal frame, usage is `UNKNOWN` —
never fabricated.

## Storage

Usage metadata (with its `accuracy` label) flows through `AIResponse.usage`
and `AIStreamEvent.usage` and is persisted alongside the assistant message. The
label is preserved so downstream consumers can distinguish exact counts from
estimates.
