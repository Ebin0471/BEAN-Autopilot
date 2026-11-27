# CORE-03G — Provider Status Vocabulary

Provider availability is reported with a fixed vocabulary. The UI renders these
labels and **never invents** an availability state — registration is **not**
availability.

## Vocabulary

| Status | Meaning |
|--------|---------|
| `PLANNED` | Declared but not yet wired. |
| `REGISTERED` | Definition exists; no adapter/health yet. |
| `CONFIGURATION_REQUIRED` | Env/credentials absent; no-op adapter (throws on use). |
| `AVAILABLE` | Configured and healthy enough to serve requests. |
| `DEGRADED` | Reachable but degraded (e.g. a class unavailable). |
| `UNAVAILABLE` | Reachable but not serving; will retry. |
| `DISABLED` | Deliberately turned off. |
| `REVOKED` | Consent or policy revoked; must not be used. |

These are exposed to the UI via `PROVIDER_STATUS_LABELS` in
`lib/ai/catalogue.ts` and rendered as a badge in the chat composer bar.

## Availability is derived, never assumed

`ProviderRegistry.isAvailable(providerId)` returns `true` **only** when:

1. the provider's `availabilityStatus` is `AVAILABLE` or `DEGRADED`; **and**
2. `healthStatus` is not `UNAVAILABLE` or `FAILING`.

Registering a provider (inserting its row) does **not** make it available. A
provider with no credentials is registered `CONFIGURATION_REQUIRED`; a provider
whose health check fails is set `DEGRADED`/`FAILING`.

## Health

`ProviderRegistry.healthCheck(providerId)` runs the adapter's `healthCheck()`
and persists the result via `setStatus()`:

- healthy → `AVAILABLE` / `HEALTHY`
- reachable but not fully healthy → `DEGRADED`
- failure → `DEGRADED` / `FAILING`

## Privacy class

Each provider carries a `privacyClass`:

- `INTERNAL` — the deterministic test provider (no external dependency).
- `LOCAL` — locally-hosted inference (opt-in, SSRF-guarded).
- `EXTERNAL` — BEAN Intelligence, OpenAI-compatible, any remote endpoint.

The router never routes private data to a provider of a lower privacy class
(INTERNAL > LOCAL > EXTERNAL), and external providers additionally require
workspace consent.

## Test provider production restriction

The deterministic test provider is `INTERNAL` and is excluded from routing in
production (`NODE_ENV === "production"`). Its `generate`/`stream` throw if
invoked directly in production, so it can never serve real traffic.
