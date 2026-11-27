# CORE-01 Threat Model

A focused threat model for the CORE-01 security core. Each threat maps to the
control that mitigates it and how it is tested.

## 1. Scope & assets

**Assets:** user identities, sessions, workspace data, memberships, roles,
passports, approvals, audit records.

**Trust boundary:** the browser is untrusted. Everything from cookie value to
workspace ID to proposed risk class is treated as hostile input.

## 2. Threats & mitigations

| # | Threat | Mitigation | Tested |
|---|---|---|---|
| T1 | Unauthenticated access to API/data | Session verification on every route handler; no valid session → 401 | ✅ unauth rejected |
| T2 | Session hijacking / replay | Raw token never stored (only SHA-256 hash); random 256-bit token | ✅ valid token required |
| T3 | Expired / revoked session use | Expiry + revocation checks in `verify()` | ✅ expired + revoked rejected |
| T4 | Cross-workspace data access (tenant isolation) | Membership resolved server-side; non-member denied uniformly | ✅ A≠B, unjoined switch denied |
| T5 | Client-supplied workspace ID trusted | Workspace ID is only a lookup key; membership/permission always server-resolved | ✅ cross-tenant denial |
| T6 | Privilege escalation via role | Roles from server membership only; deny-by-default; unknown permission denied | ✅ client roles ignored |
| T7 | VIEWER/MEMBER writing or managing members | Explicit role→permission grants; ADMIN withheld owner-only grants | ✅ VIEWER/MEMBER/ADMIN boundaries |
| T8 | Revocation not taking effect | Membership deleted → permission resolves to null immediately | ✅ removal blocks immediately |
| T9 | Risk downgrade by client | `RiskClassifier` is server-authoritative; proposed risk ignored | ✅ downgrade prevented |
| T10 | Silent autonomous execution of consequential actions | R3/R4 require approval before AUTHORISED | ✅ R3/R4 approval required |
| T11 | Passport replay / reuse | One-time consumption (CONSUMED terminal) | ✅ replay rejected |
| T12 | Approval scope expansion | Requested permission scope ⊆ actor's effective permissions | ✅ scope expansion rejected |
| T13 | Self-approval (circumventing separation of duties) | Approver ≠ initiator; dual approval needs 2 distinct approvers | ✅ self-approval blocked, dual enforced |
| T14 | Altered parameters after approval | Parameter hash binds command/target/scope; mismatch fails | ✅ altered params rejected |
| T15 | Expired/revoked passport use | State checks on every transition + execution | ✅ expired/revoked unusable |
| T16 | Invalid passport state transition | Explicit state machine; illegal transitions throw | ✅ invalid transitions rejected |
| T17 | Secrets leaked to logs/audit | `redact()` strips sensitive keys before storage | ✅ redaction tested |
| T18 | Audit tampering / gaps | Hash-chained append-only events; `verifyChain()` detects breaks | ✅ tamper detected |
| T19 | Final owner removal / lockout | Final owner cannot be removed without transfer | ✅ owner protection tested |
| T20 | Revealing existence of private resources | Uniform 403 for unknown/unjoined workspaces & passports | ✅ no distinguishable errors |

## 3. Attack scenarios

**Scenario A — Tenant hop:** User A knows B's workspace ID and calls
`/api/permissions?workspaceId=B`. The engine resolves A's membership on B → null
→ uniform 403. A learns nothing about whether B exists.

**Scenario B — Role injection:** A client sends `role: "OWNER"` in a request
body. The service ignores it; role is read from the DB membership. Deny-by-default
applies.

**Scenario C — Risk laundering:** A client submits a destructive action with
`riskClass: "R0"`. `RiskClassifier` classifies by command/operation, ignoring the
proposed value → R4, approval required.

**Scenario D — Passport forgery/replay:** A client replays an approved passport.
`assertExecutable` consumes it once; the second attempt hits CONSUMED and fails.

**Scenario E — Self-approval:** The initiator tries to approve their own R3
passport. Separation of duties rejects it.

## 4. Residual risks & limitations

- **Auth provider:** provider-neutral identity is in place; a real OIDC provider
  is not configured. Production auth is closed by default until wired.
- **Audit:** tamper-evident via hash chain, but not backed by an external
  write-once store (see ADR-006).
- **RLS:** app-level checks are mandatory and tested; PostgreSQL RLS is
  defence-in-depth to be enabled in production (ADR-003) and tested there.
- **Rate limiting:** route handlers are structured for rate limiting, but a
  dedicated rate-limit layer is not yet wired.
- **Timing/enumeration:** uniform error responses reduce enumeration; residual
  timing differences are not exhaustively tested.
