# CORE-01 — Identity, Multi-Workspace Security, Permission Engine, Audit System & Action Passport

**Milestone:** CORE-01 (foundational backend security layer)
**Branch:** `arena/efd799fd-bean-autopilot`
**Baseline:** `dcfc0cb76b6f69c2a89b6f065f83db1323406337` (UI-01 merge on `main`)
**Status:** IMPLEMENTED + TESTED (server-enforced, not UI-only)

## 1. Purpose

Transform the UI-01 frontend into the foundation of a secure, multi-workspace AI
operating platform. CORE-01 delivers the server-side security core — identity,
workspace isolation, a central deny-by-default permission engine, a server-side
risk classifier, the Action Passport lifecycle + approval engine, and an
append-only hash-chained audit system. **No agent execution or external
integrations are implemented in CORE-01** — the infrastructure is built to
support agents and integrations registered in future milestones.

## 2. Scope (delivered)

### CORE-01A — Identity
- Provider-neutral identity service. Accounts are keyed by a stable
  **(provider, provider_user_id)** identity — never by an unverified email alone.
- Email is a profile attribute (not a unique key): two distinct provider
  identities may legitimately share an email.
- Session management over HTTP-only cookies. The raw session token is never
  stored — only its SHA-256 hash. Sessions support expiry and revocation.
- **Authentication is CLOSED by default in production.** Sign-in is enabled only
  when `BEAN_DEV_AUTH_ENABLED=true` (dev/test). There is no production
  dev-bypass. A real OIDC/OAuth provider is the production path (future
  milestone); the identity layer is provider-neutral and ready for it.

### CORE-01B — Workspace security & policy
- Universal workspace kinds: **PERSONAL** (private, per-user), **PROFESSIONAL**,
  **BUSINESS** (multi-member, roles).
- **Mandatory server-side isolation.** A workspace selector is not a security
  boundary. Every request verifies: authenticated user, requested workspace,
  active membership, required permission, resource ownership, applicable policy.
- **Central deny-by-default RBAC** (`PolicyEngine`). Roles:
  `OWNER`, `ADMIN`, `OPERATOR`, `MEMBER`, `VIEWER`. Permissions are explicit
  `resource.action` scopes (18 total). All authorisation flows through ONE
  central policy service — never scattered in components.
- Owner protection: the final owner cannot be removed without a verified
  transfer; owner-only controls (`workspace.delete`, `policy.manage`) are
  withheld from ADMIN.

### CORE-01C — Action Passport & approvals
- Every consequential operation is bound to **ONE workspace, ONE exact action,
  ONE exact target**, and canonicalised parameters (a param change invalidates
  approval via the parameter hash).
- Server-side **R0–R4 risk classifier**. Clients can **never lower** risk —
  the ruleset is the only source of truth.
- Passport state machine:
  `REQUESTED → PENDING_APPROVAL → APPROVED → AUTHORISED`, plus terminal
  `REJECTED / EXPIRED / REVOKED / CONSUMED / BLOCKED`. Invalid transitions fail.
- Approval engine: request/approve/reject/revoke/authorise/list. Enforces
  approver authority (`actions.approve`), **separation of duties** (no
  self-approval), configurable approver roles, and **dual approval** for R4.
- Expired / revoked / consumed passports are unusable; replay is prevented by
  one-time consumption; approval cannot expand scope (requested permission
  scope must be a subset of the actor's effective permissions).

### CORE-01D — Audit, API & hardening
- Append-only, **hash-chained** audit service. Each event carries a prev-event
  hash and an event hash; `verifyChain()` recomputes and detects tampering.
- Sensitive fields (password/token/secret/cookie/otp/key/credential/session)
  are **redacted** before storage.
- Typed Next.js Route Handlers with zod schema validation. Endpoints:
  `/api/auth/session` (GET/POST), `/api/auth/signout`, `/api/workspaces`,
  `/api/permissions`, `/api/passports`, `/api/passports/[id]/approve`,
  `/api/passports/[id]/authorise`, `/api/passports/[id]/revoke`, `/api/audit`.
- Uniform errors that do **not** reveal the existence of inaccessible private
  resources.

## 3. Not in scope (explicitly)
- Agent execution or the agent workforce (future milestones). Agent Workforce
  remains labelled **planned**.
- External integrations / OIDC provider wiring (identity layer is provider
  neutral and ready, but no provider is configured).
- PostgreSQL production deployment (data layer is portable; see ADR-002).
- No fabricated seed users or production accounts.

## 4. Verification

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | pass |
| Lint | `npx next lint` | clean |
| Unit + integration tests | `npx vitest run` | **56 passed** (39 CORE-01 security + 17 UI-01) |
| Production build | `npx next build` | 8 API routes + 8 UI routes compiled |
| Live API smoke test | `next start` + curl | sign-in, workspace create, permissions, passport lifecycle, self-approval blocked, audit chain valid |

The 39 CORE-01 tests are **real database integration tests** over `node:sqlite`
(in-memory), covering: unauth/expired/revoked sessions, cross-workspace
isolation, VIEWER/MEMBER/ADMIN/owner permission boundaries, risk
downgrade prevention, passport binding/idempotency/expiry/revocation/replay,
self-approval, dual approval, and audit redaction + hash-chain verification.

## 5. Related docs
- `docs/architecture/CORE-01-ARCHITECTURE.md` — architecture, data flow, DB schema
- `docs/architecture/DECISIONS.md` — ADRs (incl. node:sqlite deviation)
- `docs/security/THREAT-MODEL.md`, `docs/security/PERMISSION-MATRIX.md`,
  `docs/security/ACTION-PASSPORT.md`
- `docs/development/LOCAL-SETUP.md`

## 6. DOC-02 status (honest)
The authoritative 117-agent Universal Workforce archive (DOC-02) was **not
available** for CORE-01. CORE-01 proceeded using the available repo docs
(`BEAN-AUTOPILOT-MASTER-MINDMAP.md`, `MILESTONE-1-DISCOVERY-AND-ARCHITECTURE.md`,
`README.md`) as the provisional architecture baseline. **DOC-02 remains
incomplete** — 0/117 agent contracts imported. CORE-01 does not fabricate agent
specs; the security infrastructure is designed to support agents that will be
registered in future milestones.
