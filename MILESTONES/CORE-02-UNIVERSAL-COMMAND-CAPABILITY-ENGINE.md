# CORE-02 — Universal Command & Capability Engine

**Status:** Implemented, tested, registered.
**Milestone type:** Implementation (not a mockup).
**Baseline:** branched from `main` at `4b090c7921aad70bca5dda1fdd99d1a1a2e3c31a`.
**Successor to:** CORE-01 (security foundation, merged via PR #3).
**Successor:** CORE-03 (agent reasoning/execution — NOT started in this milestone).

## 1. Purpose

CORE-02 establishes one governed execution architecture for every future agent,
UI surface and external integration. Instead of each caller inventing its own
permission checks, risk decisions, approval flow, execution adapter and audit
record, all executions flow through a single **Command Gateway** that reuses the
CORE-01 security services (`PolicyEngine`, `RiskClassifier`,
`ActionPassportService`, `AuditService`). There is no second permission,
passport, audit or risk system.

The client (browser, agent, integration) must **never** choose risk class,
permissions, approval policy, adapter or authorisation. It submits a command
request and receives the server-side outcome.

## 2. Components (CORE-02A → CORE-02D)

| Phase | Component | Module | Status |
|-------|-----------|--------|--------|
| 02A | Typed registry foundation | `lib/commands/{types,registry,canonical}.ts` | Implemented, tested |
| 02A | Capability registry | `lib/commands/{capability,builtin-capabilities}.ts` | Implemented, tested |
| 02A | Built-in safe commands | `lib/commands/builtin.ts` | Implemented, tested |
| 02B | Command gateway + security | `lib/commands/gateway.ts` | Implemented, tested |
| 02B | Full-payload passport binding | `lib/commands/canonical.ts` + `lib/security/passport.ts` | Implemented, tested |
| 02C | Execution adapter interface | `lib/commands/adapter.ts` | Implemented, tested (test-only adapter) |
| 02C | Execution lifecycle manager | `lib/commands/lifecycle.ts` | Implemented, tested |
| 02C | Verification contract | `CommandDefinition.verificationContract` | Implemented, tested |
| 02C | Command audit integration | `lib/commands/{gateway,lifecycle}.ts` → `AuditService` | Implemented, tested |
| 02D | Discovery API | `app/api/commands/**`, `app/api/capabilities/**` | Implemented, tested |
| 02D | UI wiring | Automation, Connections, Chat, Activity, Agents | Implemented, truthful |
| 02D | Client catalogue | `lib/commands/catalogue.ts` | Implemented |

## 3. CORE-01 reuse (no second system)

The gateway delegates every security-critical decision to CORE-01:

- **Permissions** — `PolicyEngine.requireMember()` / `resolve()` (deny-by-default
  RBAC). A capability can never expand a user's permissions;
  `CapabilityRegistry.assertNoEscalation()` enforces this.
- **Risk** — `RiskClassifier`. The effective risk is the maximum of the
  classifier's assessment and the command's declared `serverRiskClass`, so a
  command cannot downgrade risk.
- **Passport** — `ActionPassportService.createRequest()`. CORE-02 supplies a
  **full-payload** `paramHash` + `paramsCanonical` (see §5), so the passport
  binds the exact args that were executed, not just command+target.
- **Approval** — `ApprovalService`. Approval-gated commands follow the CORE-01
  passport state machine.
- **Audit** — `AuditService`. Every blocked/executed command writes an
  append-only, hash-chained audit record.

## 4. Fail-closed behaviour

The gateway returns `BLOCKED` (HTTP 403 at the API) for:

- non-workspace members (`WORKSPACE_DENIED`);
- unknown commands (`UNKNOWN_COMMAND`);
- invalid args (`INVALID_ARGS`);
- unavailable capabilities (`CAPABILITY_UNAVAILABLE`);
- capability/permission escalation (`CAPABILITY_ESCALATION`);
- missing permissions (`PERMISSION_DENIED`).

Every block is audited with a `COMMAND_BLOCKED` event. No partial execution
occurs before all gates pass.

## 5. Full-payload Action Passport binding (CORE-01 `computeParamHash` fix)

CORE-01's original `computeParamHash` folded only
`command|targetType|targetId|dataScope` and ignored the actual arguments, so two
different invocations of the same command could produce the same passport hash.
This was a real binding gap.

**Fix:** `lib/commands/canonical.ts` implements `canonicalize()` /
`computeParamHash()` / `computeBindingHash()`, producing a deterministic
canonical JSON of **workspace + command id/version + capability id/version +
target + ALL arguments + execution options**. `computeParamHash` is a
backward-compatible wrapper that folds `params` into the canonical binding.

`ActionPassportService.createRequest()` now honours a gateway-supplied
`paramHash` + `paramsCanonical`. The gateway computes these once and passes
them in, so the passport binds the exact executed payload. The CORE-01 test
suite (39 tests) still passes, and `tests/core02-commands.test.ts` includes a
**regression assertion** proving that two invocations with different arguments
produce different param hashes.

## 6. Execution lifecycle

`ExecutionLifecycleManager` enforces a valid-transition state machine:

```
RECEIVED → VALIDATING → VALIDATED → AWAITING_APPROVAL → AUTHORISED → READY
                                                          → RUNNING → VERIFYING
                                                          → VERIFIED / PARTIAL / FAILED
BLOCKED, CANCELLED, COMPENSATION_PENDING, COMPENSATED
```

Invalid transitions throw `LifecycleError`. Terminal records short-circuit.

## 7. Idempotency, timeout and retry safety

- `CommandGateway.submit()` accepts an `idempotencyKey`. Idempotency is scoped
  to **(workspace, key) AND the complete canonical request** — not just the key.
- The same key reused for a **different** canonical payload (different command,
  arguments, capability, target, version or execution options) is rejected with
  an explicit `IDEMPOTENCY_CONFLICT` (`BLOCKED`); the unrelated prior
  execution/passport is **never** returned.
- The same key + same canonical payload safely replays the existing execution and
  passport (same `executionId`), so a retried request does not re-execute.
- `ActionPassportService.createRequest()` compares `param_hash` **and**
  `params_canonical` before returning an existing passport, and
  `ExecutionLifecycleManager.create()` compares `params_hash` before returning
  an existing execution. Both raise `IdempotencyConflictError` on a mismatch.
- Concurrent duplicate inserts are reconciled via the
  `(workspace_id, idempotency_key)` UNIQUE constraint: the loser re-reads and
  returns the winner`s record (same payload) or raises a conflict (different
  payload), so no inconsistent passports or executions are created.
- Terminal states (`VERIFIED`, `PARTIAL`, `FAILED`, `BLOCKED`, `CANCELLED`,
  `COMPENSATED`) are idempotent and never re-enter `RUNNING`.
- `CommandGateway.preview()` is synchronous and **never** creates a passport or
  lifecycle record — it is a pure dry-run.

## 8. Built-in safe commands

Only safe, registry/validation/workspace-scoped commands are registered in this
milestone. No fake business commands:

- `platform.commands.list` / `platform.commands.describe`
- `platform.capabilities.list` / `platform.capabilities.describe`
- `platform.command.validate` / `platform.command.preview`
- `workspace.members.list`
- `workspace.audit.list`

All built-in commands are R1 (read-only) and operate on real workspace data.

## 9. Capability registry

Registered capabilities (state vocabulary: `PLANNED`/`REGISTERED`/
`CONFIGURATION_REQUIRED`/`AVAILABLE`/`DEGRADED`/`UNAVAILABLE`/`DISABLED`/
`REVOKED`):

- `platform.registry` — AVAILABLE (real, workspace-scoped).
- `browser.automation`, `email`, `calendar`, `file.storage`, `crm`,
  `desktop.windows`, `iot.smart-home` — PLANNED (registered, not connected).

**No real email/CRM/banking/desktop/browser integrations this milestone.**
Connectors are test-only adapters.

## 10. Discovery API (enforces identity + workspace + permission)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/commands?category=` | List registered commands |
| GET | `/api/commands/[id]?version=` | Describe a command |
| POST | `/api/commands/validate` | Dry-validate args (no execution) |
| POST | `/api/commands/preview` | Dry-run preview (no execution, no passport) |
| POST | `/api/commands` | Submit through the gateway |
| GET | `/api/commands/executions?workspaceId=` | List lifecycle records |
| GET | `/api/capabilities?category=` | List capabilities |
| GET | `/api/capabilities/[id]?version=` | Describe a capability |

All routes require an authenticated session (`requireAuth`). The discovery list
routes enforce `workspace.read`-level authorisation. Submission enforces the
full gateway chain.

## 11. UI wiring (UI-01 preserved, truthful states)

- **Automation Studio** — real `COMMAND_CATALOGUE` palette; adding a command
  creates a real command node with metadata badges (commandId@version, risk,
  approval, permissions).
- **Connections** — real `CAPABILITY_CATALOGUE` availability states; Connect is
  disabled for non-AVAILABLE capabilities. No fabricated "connected" states.
- **Chat** — honest system message: the command catalogue exists, but real
  agent reasoning/execution is CORE-03+. No fabricated plan.
- **Activity** — real command-lifecycle summary card; demo receipts are clearly
  separated from real security records.
- **Agents** — references the real command catalogue count; agents remain
  planned, no fabricated execution.

## 12. Verification

- `npx tsc --noEmit` — clean.
- `npx next lint` — clean.
- `npx vitest run` — 107 tests pass (39 CORE-01 + 37 CORE-02 engine + 14
  CORE-02D routes + 13 pages + 4 navigation).
- `npx next build` — clean; all API routes and UI routes build.

## 13. Explicitly out of scope

- CORE-03 agent reasoning/execution (not started).
- Real connector integrations (email/CRM/desktop/browser) — test-only adapters.
- DOC-02 (117-agent archive) — stays incomplete/honest; archive absent.
