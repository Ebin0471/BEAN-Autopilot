# Command Execution Lifecycle

**Milestone:** CORE-02 · **Module:** `lib/commands/{lifecycle,adapter}.ts`

## Abstract

Every governed execution is an explicit, auditable lifecycle record. The
`ExecutionLifecycleManager` owns the record and enforces a valid-transition
state machine. It integrates with the CORE-01 `AuditService` so each transition
and outcome is hash-chained and verifiable.

## Lifecycle state machine

```
RECEIVED
  → VALIDATING
    → VALIDATED
      → AWAITING_APPROVAL   (when approvalPolicy = REQUIRED)
        → AUTHORISED
          → READY
            → RUNNING
              → VERIFYING
                → VERIFIED       (all checks pass)
                → PARTIAL         (some checks pass)
                → FAILED
  → BLOCKED                  (any gate failure)
  → CANCELLED
  → COMPENSATION_PENDING     (when compensation is required and unsupported)
  → COMPENSATED
```

Terminal states: `BLOCKED`, `CANCELLED`, `COMPENSATION_PENDING`,
`COMPENSATED`, `VERIFIED`, `PARTIAL`, `FAILED`.

## Valid-transition enforcement

`advance(executionId, toState)` only permits transitions defined by the
state machine. An illegal transition throws `LifecycleError` and leaves the
record unchanged — a record cannot jump from `RECEIVED` to `RUNNING`, re-enter
`RUNNING` after a terminal state, or bypass the approval gate.

## Idempotency and retry safety

- Idempotency is scoped to **(workspace, key) AND the complete canonical request
  hash** (`params_hash`). `create()` compares the canonical payload before
  returning an existing record.
- The same key reused for a **different** canonical payload (command, args,
  capability, target, version or execution options) raises
  `IdempotencyConflictError` — the unrelated prior record is never returned.
- A **terminal** record short-circuits: `submit()` for a key that already
  reached a terminal state returns the stored outcome instead of re-executing.
- Concurrent duplicate inserts are reconciled via the
  `(workspace_id, idempotency_key)` UNIQUE constraint: the loser re-reads and
  returns the winner`s record (same payload) or raises a conflict (different
  payload).
- `preview()` never creates a record, so dry-runs are never retried.

## Adapter interface

`CommandAdapter` (`lib/commands/adapter.ts`) is the pluggable execution
boundary. An adapter declares `adapterId`, `supportedCommands`,
`requiredPermissions`, `timeoutSeconds`, `supportsVerification` and
`supportsCompensation`, and implements `prepare`, `execute`, `verify`,
`compensate` and `healthCheck`.

- **Verification is authoritative.** After a successful `execute()`, the gateway
  calls `adapter.verify(ctx, result)` and reports `VERIFIED` only when
  `AdapterVerification.verified` is true **and** the evidence is a non-empty,
  serialisable object. Execution output (`result.output`) and verification
  evidence (`AdapterVerification.evidence`) are persisted in distinct columns.
  An adapter that cannot provide a required verification method fails closed
  before execution; a `manual` contract is never auto-verified.
- **Bounded phases.** `prepare`, `execute` and `verify` are each bounded by
  `effective timeout = min(command.timeoutPolicy.maxSeconds,
  adapter.timeoutSeconds)` and receive a cooperative `AbortSignal`. A timeout
  yields an honest unresolved `PARTIAL` (never a false success); verification
  timeouts never yield `VERIFIED`.
- **Compensation.** `compensate()` is declared but not invoked by the gateway
  this milestone; automatic compensation/rollback is future work and is never
  claimed unless a separately authorised, verified compensation occurs.
- CORE-02/CORE-04A ship a **test-only** `TestCommandAdapter`; no real connector
  adapters exist this milestone and no live integration is accepted.
- The adapter is chosen **server-side** by the gateway/lifecycle manager. The
  client never selects or names an adapter.

## Audit integration

Each lifecycle transition writes an event through the CORE-01 `AuditService`
(append-only, sha256 hash chain). Blocked commands and every terminal outcome
are audited. Verification uses the CORE-01 chain verification
(`verifyChain()`), so lifecycle integrity is part of the global audit chain.

## See also

- `docs/architecture/COMMAND-GATEWAY.md`
- `docs/security/COMMAND-PASSPORT-BINDING.md`
- `docs/development/CONNECTOR-SDK.md`
