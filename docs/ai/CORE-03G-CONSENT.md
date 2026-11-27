# CORE-03G — Workspace External-AI Consent

A workspace must **explicitly consent** before any `EXTERNAL` privacy-class AI
provider is used. Consent is enforced **server-side** — the workspace id is
resolved from the session, never trusted from the client.

## Storage

Consent is stored in the `workspace_ai_consent` table (additive migration):

| Column | Meaning |
|--------|---------|
| `workspace_id` | PK, FK → `workspaces(id)` (ON DELETE CASCADE). |
| `external_ai_allowed` | 0/1 — whether external AI is permitted. |
| `allowed_external_provider_ids` | JSON array of explicitly allowed provider ids. |
| `consent_version` | Consent schema version (`1.0.0`). |
| `consented_by` / `consented_at` / `updated_at` | Provenance. |

## Enforcement (`lib/ai/consent.ts`)

`assertProviderAllowed(db, workspaceId, privacyClass, providerId?)` is the
single decision point:

- **INTERNAL / LOCAL** → always permitted (no external-AI consent needed).
- **EXTERNAL** → requires consent:
  - `external_ai_allowed` must be `true` (else `CONSENT_REQUIRED`);
  - when an allowed-provider list is non-empty, `providerId` must be in it
    (else `PROVIDER_NOT_ALLOWED`).

**Fail-closed**: an absent or revoked consent means external AI is unavailable.

## Where it is enforced

- **Orchestrator** — `composeModelResponse` calls `assertProviderAllowed`
  before routing to an EXTERNAL provider. A consent gap pushes an honest
  limitation and falls back to the template response (never a fabricated model
  output).
- **Chat route** — the authoritative check is in the orchestrator; a purely
  internal turn is never blocked.

## API

```ts
getConsent(db, workspaceId): WorkspaceAiConsent
setConsent(db, workspaceId, { externalAiAllowed, allowedExternalProviderIds, consentedBy })
assertProviderAllowed(db, workspaceId, privacyClass, providerId?)
hasExternalAiConsent(db, workspaceId): boolean
```

`setConsent` is idempotent (upsert on conflict). Granting consent does **not**
expand caller authority or bypass any other policy — it only permits the
external-AI privacy class for that workspace.
