# CORE-03G — Endpoint Safety (SSRF)

All outbound AI provider requests are gated by `lib/ai/endpoint-safety.ts`.
Base URLs come **only** from trusted server-side environment configuration —
never from a chat message, model output, or arbitrary request body.

## Policy

Before a request is made, `validateBaseUrl(rawUrl, policy)` enforces:

1. **Scheme** — must be `http` or `https`.
2. **Parseable** — must be a valid absolute URL with a host.
3. **No embedded credentials** — `user:pass@` is rejected.
4. **No query string / fragment** — the adapter constructs the path.
5. **Host policy** — loopback, private, link-local, multicast, and cloud
   metadata hosts are blocked unless `allowLocalEndpoints` is explicitly enabled.
6. **Production HTTPS** — in `NODE_ENV === "production"`, only `https` is
   accepted.

## Blocked hosts

- IPv4 loopback (`127.x`), private ranges (`10.x`, `172.16-31.x`, `192.168.x`),
  link-local (`169.254.x`), `0.x` (this host), multicast/reserved (`224+`).
- IPv6 loopback (`::1`), link-local (`fe80:`), unique-local (`fc`/`fd`).
- `localhost`, `0.0.0.0`, and cloud metadata hosts
  (`metadata.google.internal`, `instance-data`, `.internal` suffixes).

## Redirect control

The shared HTTP client (`lib/ai/http.ts`) sets `redirect: "manual"` — it never
follows redirects. This prevents a redirect destination from bypassing the
endpoint-safety policy (an SSRF-via-redirect attack).

## Local endpoints

Local inference requires an explicit opt-in:

```
BEAN_AI_ALLOW_LOCAL_ENDPOINTS=1
```

Without it, the `LocalInferenceAdapter` is registered `CONFIGURATION_REQUIRED`
and every local endpoint is rejected by the policy. Local endpoints are a
deliberate trade-off, never a default.

## Construction-time validation

Adapters validate the base URL **at construction** (`new
BeanIntelligenceAdapter(...)` calls `validateBaseUrl` in its constructor). A
misconfigured or unsafe base URL fails at bootstrap, where the provider is
registered `CONFIGURATION_REQUIRED`/`DEGRADED` rather than silently producing a
broken adapter.
