# Architecture Decision Records (ADRs)

Lightweight ADRs recording the key CORE-01 decisions and their rationale.

## ADR-001 — Modular monolith, not microservices

**Status:** Accepted
**Context:** The platform must become a secure, multi-workspace AI operating
system without premature operational complexity.
**Decision:** Build a **modular monolith**. Next.js Route Handlers + a typed
service layer + a single data layer. Security modules are separated by
responsibility (identity, policy, passport, audit) but share one process and
one database.
**Rationale:** Avoids distributed-systems auth/audit complexity before the
workload demands it. Module boundaries keep the codebase navigable and allow a
future split if needed.
**Consequences:** Simpler auth/session/audit (no cross-service token relay).
Scaling is per-process; acceptable for the current stage.

## ADR-002 — Portable data layer over `node:sqlite` for dev/test; PostgreSQL for production

**Status:** Accepted (deviation from the "PostgreSQL + Prisma" recommended direction)
**Context:** The recommended stack is PostgreSQL with a mature ORM (Prisma
preferred). In the CORE-01 build environment there is **no system PostgreSQL**
and outbound network is restricted, so the Prisma engine download is
unreachable. Node 22 ships a built-in **`node:sqlite`** module.
**Decision:** Implement the data layer over `node:sqlite` (in-memory for tests,
file-backed for local dev). Write the schema as portable SQL and keep all data
access behind a thin repository/service boundary. **Document PostgreSQL as the
production target**; the port to PostgreSQL (and a mature ORM) is a later,
mechanical step.
**Rationale:** Delivers a real, testable, persistent data layer now without
depending on unreachable artifacts. Keeps the security logic independent of the
specific engine.
**Consequences:**
- Dev/test runs with zero external services — good for reproducible security
  tests.
- Production must swap the data layer to PostgreSQL and apply the same schema.
  SQLite-specific behaviours (e.g. partial indexes, `TEXT` timestamps) are kept
  portable; a migration step and RLS (ADR-003) are required before production.
- `node:sqlite` is experimental and may change; it is isolated behind
  `lib/db/sqlite-shim.ts`.

## ADR-003 — App-level authorisation is mandatory; PostgreSQL RLS as defence-in-depth

**Status:** Accepted (RLS planned for production)
**Context:** Multi-tenant isolation must hold even if application code has a
bug.
**Decision:** Enforce **all** authorisation in the application layer
(`PolicyEngine`, deny-by-default). For production PostgreSQL, additionally enable
**Row-Level Security** with workspace context set transactionally, as a
defence-in-depth layer.
**Rationale:** App-level checks are the primary, testable control. RLS reduces
blast radius if a query bypasses the service layer.
**Consequences:**
- RLS must set workspace context transactionally with the correct role; the
  connection pool must not leak context between requests.
- Cross-workspace denial must be tested at the RLS layer.
- Migrations must not bypass policy (apply with the app role, not a
  superuser).
- App-level checks remain mandatory regardless of RLS.

## ADR-004 — Provider-neutral identity; authentication closed by default in production

**Status:** Accepted
**Context:** A mature OIDC/OAuth library is the target, but no provider is
configured in the build environment.
**Decision:** Build a **provider-neutral identity layer** keyed by stable
`(provider, provider_user_id)`. Sessions use HTTP-only cookies storing only the
token's SHA-256 hash. **Production authentication is closed by default**;
sign-in is enabled only via `BEAN_DEV_AUTH_ENABLED=true` for dev/test. Provide
an honest "authentication-not-configured" response when disabled.
**Rationale:** Avoids hand-rolled crypto. Keeps the production posture safe by
default while allowing local development and tests to run. Test identities are
created only inside an isolated test DB.
**Consequences:** Real OIDC wiring is a follow-up. There is no unrestricted
production bypass.

## ADR-005 — Action Passport as the single gate for consequential actions

**Status:** Accepted
**Context:** Consequential and destructive operations must be human-approved and
auditable, with no silent autonomous execution and no replay.
**Decision:** Every consequential action requires a server-issued **Action
Passport** bound to one workspace, one exact command/target, and canonicalised
params. Risk is classified server-side (R0–R4). Approval cannot expand scope;
delegation cannot expand authority; expiry/revocation/consumption render a
passport unusable.
**Rationale:** A single, auditable lifecycle gives a clear approval gate and a
verifiable record. Client-supplied risk is ignored so risk cannot be lowered.
**Consequences:** Passport is foundational; execution that consumes it arrives
with agent/integration milestones. The lifecycle and enforcement are in place
and tested now.

## ADR-006 — Append-only hash-chained audit

**Status:** Accepted
**Context:** Security-sensitive operations must be recorded and verifiable.
**Decision:** A central `AuditService` appends events with a global hash chain
(`prev_hash → event_hash` via SHA-256) and redacts sensitive metadata. `verifyChain()`
recomputes the chain to detect tampering.
**Rationale:** A lightweight, self-verifying integrity model without an
external write-once store.
**Consequences:** The chain is **tamper-evident**, not unconditionally
tamper-proof. For higher assurance, back the chain with an external append-only
store (future). Redaction prevents secrets from ever being stored.
