# CORE-03G — Acceptance & Security Testing

## Live acceptance script

`tests/core03g-acceptance.test.ts` exercises the **real** provider adapters
against their live endpoints when credentials are present in the environment:

```
npx vitest run tests/core03g-acceptance.test.ts
```

For each configured provider it verifies:

1. **Health** — the endpoint is reachable and reports the provider.
2. **listModels** — returns a non-empty, honest model projection.
3. **generate** — returns real model content (non-empty).
4. **stream** — returns real delta content and a terminal `complete` frame.

**Skips cleanly when no credentials are set.** If a provider is not configured,
its checks are skipped with an honest reason — the script never fabricates a
result and never falls back to the test provider. Exit code reflects whether
any *configured* provider failed.

Configure via environment (see `.env.example`):

```
BEAN_INTELLIGENCE_BASE_URL=  BEAN_INTELLIGENCE_API_KEY=
OPENAI_COMPATIBLE_BASE_URL=  OPENAI_COMPATIBLE_API_KEY=  OPENAI_COMPATIBLE_MODEL=
LOCAL_INFERENCE_BASE_URL=    LOCAL_INFERENCE_MODEL=    BEAN_AI_ALLOW_LOCAL_ENDPOINTS=
```

## Security tests

`tests/core03g-security.test.ts` covers the fail-safe pieces:

### SSE parser
- Normal delta + terminal `done`.
- Arbitrary chunk boundaries (frame split across chunks).
- CRLF line endings.
- Keepalive comment frames ignored.
- Typed error frame surfaced as terminal.
- Stream without terminal → truncated (not complete).
- Max-size bound enforced.
- Abort stops consumption cleanly.
- Non-JSON data frames treated as raw delta text.
- Partial-vs-complete honesty (partial content + `partial: true`).

### Endpoint safety (SSRF)
- Valid HTTPS accepted.
- Non-http schemes rejected.
- Loopback / private / link-local / metadata hosts blocked.
- Embedded credentials rejected.
- Query string / fragment rejected.
- Invalid URLs rejected.
- Local host permitted only with explicit opt-in.
- Default policy reflects `BEAN_AI_ALLOW_LOCAL_ENDPOINTS`.

### Consent
- External AI denied by default (fail-closed).
- Internal/local allowed without consent.
- External AI allowed after consent granted.
- Provider not in allowed list rejected.
- Re-grant is idempotent.

### Provider honesty
- Unconfigured BEAN adapter reports `CONFIGURATION_REQUIRED`, null
  endpoint/auth refs, `toolCallSupported: false`, `PROMPTED_JSON`, and throws
  on `generate`.
- Test provider reports `PROMPTED_JSON` (never native schema).

### Test-provider production restriction
- `generate` throws in production.
- `stream` throws in production.

## Full suite

```
npm test        # vitest run — all CORE-01/02/03/03G tests
npm run typecheck
npm run build
```

All must pass. The production build (`next build`) is a hard requirement.
