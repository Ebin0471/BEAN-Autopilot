# CORE-03G — Robust SSE Streaming

The SSE parser (`lib/ai/sse.ts`) consumes an async stream of text chunks from a
provider's SSE response and yields a normalized result. It is designed for the
hazards of real network streaming.

## What it handles

| Hazard | Handling |
|--------|----------|
| Arbitrary chunk boundaries | Frames buffered across chunks; evaluated only when a blank line closes the event block. |
| Multiple frames per chunk | A while-loop splits on each separator within a single chunk. |
| CRLF / LF line endings | Normalised (`\r\n` → `\n`) before splitting. |
| Keepalive / comment frames | Lines starting with `:` are ignored. |
| Terminal `done` frame | `data:{"done":true,...}` → `terminal: true`. |
| Typed error frames | `data:{"error","code","partial"}` → `error` with `partial` flag. |
| Partial vs complete | Partial content is accumulated; an error frame preserves `partial: true` when deltas were received. |
| Truncation | A stream ending without a terminal frame → `truncated: true` (never reported as complete). |
| Max size | A hard byte bound (`maxBytes`, default 4 MB) stops consumption and marks truncated. |
| Abort | `AbortSignal` cancels consumption cleanly. |

## Frame shapes

### BEAN gateway
```
data: {"delta":"Hello"}\n\n
data: {"delta":" world"}\n\n
data: {"done":true,"model":"bean-chat-hosted"}\n\n
: keepalive\n\n
data: {"error":"...","code":"RATE_LIMITED","partial":true}\n\n
```

### OpenAI-compatible
```
data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n
data: {"choices":[{"delta":{"content":" world"}}]}\n\n
data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n
data: [DONE]\n\n
```

The OpenAI parser (`parseOpenAIStream` in `openai-compatible.ts`) is a focused
sibling that understands the OpenAI frame shapes and the `[DONE]` terminator.

## Terminal discipline

A stream is only reported **complete** when a valid terminal frame is received
(`done` for BEAN, `[DONE]` for OpenAI). A stream that ends without one is
**truncated** — this is surfaced as an `SSE_TRUNCATED` / `SSE_INCOMPLETE` error
event, never hidden as a successful completion.

## True streaming in the chat route

`app/api/ai/chat/route.ts` calls `orchestrator.handleTurn(..., { streamResponse:
true, onResponseDelta })`. The orchestrator's `composeModelResponse` streams
from the upstream provider's `adapter.stream()` and relays each delta via
`onResponseDelta`, which the route emits as an NDJSON `delta` event. This is
**true upstream streaming** — the tokens come from the real model, not a
post-hoc chunking of a completed response.

## Bounded fallback

Once a delta is emitted, the orchestrator **never** falls back to a different
provider or the template response (that would emit contradictory content). A
failure before the first delta permits an honest template fallback; a failure
after yields the partial content plus an `SSE_TRUNCATED`/`SSE_INCOMPLETE`
limitation.
