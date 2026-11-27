# CORE-01 Architecture

Secure **modular monolith**. No premature microservices. The frontend (UI-01,
Next.js 14 App Router + React 18) is preserved intact; CORE-01 adds a server-side
security core behind typed Next.js Route Handlers and a typed service layer.

## 1. High-level architecture

```
                      ┌──────────────────────────────────────────────┐
   Browser (UI-01)   │  Next.js App Router (preserved)               │
   sidebar / pages   │  Home · Chat · Automation · Agents · …        │
   workspace switcher└───────────────┬──────────────────────────────┘
                                     │  fetch /api/*  (HTTP-only cookie)
                                     ▼
                      ┌─────────────────────────────────────────────┐
                      │  Route Handlers (app/api/**/route.ts)       │
                      │  zod validation · requireAuth · uniform errs │
                      └───────────────┬─────────────────────────────┘
                                      ▼
                      ┌─────────────────────────────────────────────┐
                      │  Service layer (lib/security/*)             │
                      │  Identity · Session · Workspace · RBAC ·   │
                      │  PolicyEngine · RiskClassifier · Passport  │
                      │  Approval · Audit                          │
                      └───────────────┬─────────────────────────────┘
                                      ▼
                      ┌─────────────────────────────────────────────┐
                      │  Data layer (lib/db/*)                      │
                      │  node:sqlite (dev/test) · PostgreSQL (prod) │
                      │  schema.sql · seed.ts · transactions       │
                      └─────────────────────────────────────────────┘
```

## 2. Request data flow (every server request)

1. **Authenticate** — extract the HTTP-only session cookie; verify token hash,
   revocation, expiry. No valid session → `401`.
2. **Resolve identity** — map session → user; reject non-`ACTIVE` users.
3. **Validate input** — zod schema parse; reject malformed requests.
4. **Resolve workspace context** — `PolicyEngine.resolve(userId, workspaceId)`
   joins membership; a non-member gets a uniform denial (no existence leak).
5. **Authorise** — `PolicyEngine.require(userId, workspaceId, permission)`
   enforces the central deny-by-default RBAC. Deny → `403`.
6. **Classify & issue passport** (for consequential actions) — the server
   computes the risk class; a client-proposed risk is ignored.
7. **Execute / record** — for passport-bound actions, verify and consume the
   passport (one-time, bound to exact params).
8. **Audit** — every sensitive action appends an immutable, hash-chained event.

**The browser-supplied workspace ID is never trusted as an authorisation
source.** Membership and permissions are always resolved server-side.

## 3. Module map

| Module | File | Responsibility |
|---|---|---|
| Types | `lib/security/types.ts` | Workspace kinds, roles, permissions, risk policy, passport state machine |
| Database | `lib/db/database.ts` | `node:sqlite` connection, schema apply, transactions |
| Schema | `lib/db/schema.sql` | Relational DDL (users → audit_events) |
| Seed | `lib/db/seed.ts` | Idempotent role→permission defaults (deny-by-default) |
| Util | `lib/db/util.ts` | `now`, `uuid`, `sha256` |
| Audit | `lib/security/audit.ts` | Append-only, hash-chained, redaction, `verifyChain` |
| Permissions | `lib/security/permissions.ts` | Role→permission mapping, effective permissions |
| Policy | `lib/security/policy.ts` | **Central** `PolicyEngine` (deny-by-default) |
| Risk | `lib/security/risk.ts` | Server-side R0–R4 `RiskClassifier` |
| Identity | `lib/security/identity.ts` | Users + provider-linked auth accounts |
| Session | `lib/security/session.ts` | Token-hashed sessions, expiry, revocation |
| Workspace | `lib/security/workspace.ts` | Workspaces, memberships, owner protection |
| Passport | `lib/security/passport.ts` | Action Passport lifecycle + enforcement |
| Approval | `lib/security/approval.ts` | Approval decisions, pending list |
| Container | `lib/security/container.ts` | Wire services around one DB |
| HTTP | `lib/api/http.ts` | Cookie extraction, auth context, uniform responses |

## 4. Data model (relational)

Core tables (see `lib/db/schema.sql` for full DDL):

- `users` — id, email (profile attr, not a key), display_name, status, email_verified, timestamps
- `auth_accounts` — (provider, provider_user_id) unique stable identity → user_id
- `sessions` — id = sha256(token), user_id, device_label, expires_at, revoked_at
- `workspaces` — id, kind (PERSONAL/PROFESSIONAL/BUSINESS), owner_user_id, status
- `workspace_memberships` — (workspace_id, user_id) unique, role
- `role_permissions` — (role, permission) seeded grants
- `invitations` — workspace, invitee_email, role, status
- `action_passports` — workspace-bound, command/target, param_hash, risk_class, status, idempotency_key, expiry, audit_ref
- `passport_approvals` — approver, decision, comment, timestamp
- `audit_events` — workspace_id, actor, type, target, prev_hash, event_hash, metadata (redacted)
- `workspace_policies`, `user_preferences`, `schema_migrations`

All tables use stable UUIDs, timestamps, foreign keys, and indexes. Workspace
ownership is enforced by FK + app-level checks.

## 5. API contracts (typed Route Handlers)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/auth/session` | yes | Current user + server-authorised workspaces |
| POST | `/api/auth/session` | dev-gate | Sign in (provider-neutral); issues session cookie |
| POST | `/api/auth/signout` | — | Revoke session, clear cookie |
| GET | `/api/workspaces` | yes | List joined workspaces + roles |
| POST | `/api/workspaces` | yes | Create workspace (creator = OWNER) |
| GET | `/api/permissions?workspaceId=` | yes | Effective role + permissions (server-resolved) |
| GET | `/api/passports?workspaceId=` | yes | List passports for a workspace |
| POST | `/api/passports` | yes | Create action request (server-issued passport) |
| POST | `/api/passports/[id]/approve` | yes | Approve / reject (authority + separation of duties) |
| POST | `/api/passports/[id]/authorise` | yes | APPROVED → AUTHORISED |
| POST | `/api/passports/[id]/revoke` | yes | Revoke unconsumed passport (owner) |
| GET | `/api/audit?workspaceId=` | yes | Workspace-scoped audit events + integrity |

## 6. Security enforcement model

- **One central policy service.** No authorisation in components; all checks go
  through `PolicyEngine`.
- **Deny-by-default.** Unknown permission, missing membership, missing grant → deny.
- **Least privilege.** Role grants are explicit and seeded; ADMIN cannot delete
  workspace or manage policy.
- **Server-authoritative risk.** `RiskClassifier` is the only source; clients
  cannot lower risk.
- **Bounded authority.** A passport's requested permission scope must be a
  subset of the actor's effective permissions — approval/delegation cannot
  expand scope.
- **Defence in depth.** App-level checks are mandatory; PostgreSQL RLS is
  documented as an additional layer for production (see ADR-003).

## 7. Known limitations (honest)

- **Data layer:** `node:sqlite` is used for dev/test (see ADR-002). PostgreSQL
  is the documented production target; the SQL is written portably but the
  production DDL/RLS has not been exercised in this environment.
- **Auth:** provider-neutral identity is implemented; a real OIDC/OAuth provider
  is not yet wired. Production auth is closed by default.
- **Audit integrity:** append-only + hash chaining detects tampering of stored
  rows, but the chain is not backed by an external write-once store. It is
  tamper-evident, not unconditionally tamper-proof.
- **Agent execution:** not implemented (future milestone). Passports and
  approvals exist; no automated execution consumes them yet.
