# Command Gateway

**Milestone:** CORE-02 · **Module:** `lib/commands/gateway.ts`

## Abstract

The Command Gateway is the single, governed entry point for every command
execution. It is the only place where a command request is admitted, and it is
the sole place that decides permission, risk, capability, passport and lifecycle
outcome. The client submits a request and receives the server-side result; it
never chooses risk, permissions, approval policy, adapter or authorisation.

The gateway **reuses CORE-01 services** — `PolicyEngine`, `RiskClassifier`,
`ActionPassportService`, `AuditService` — and adds no second permission, risk,
passport or audit system.

## Entry points

### `preview(request, actor)` — synchronous, no side effects

A pure dry-run. Resolves the command, capability, permissions, risk and
binding hash, and returns a plan with `errors`, `riskClass`, `approvalRequired`
and `paramsHash`. It **never** creates a passport or lifecycle record. Used by
the validate and preview API routes.

### `submit(request, actor)` — async, governed execution

The full pipeline:

```
1. Resolve workspace + membership        (PolicyEngine.requireMember)   fail-closed
2. Resolve + assert command supported    (CommandRegistry.assertSupported)
3. Validate args                         (inputSchema)                  INVALID_ARGS
4. Resolve + assert capability usable    (CapabilityRegistry)           CAPABILITY_*
5. assertNoEscalation(cap, permissions)  (CapabilityRegistry)           CAPABILITY_ESCALATION
6. Resolve effective permissions         (PolicyEngine.resolve)          PERMISSION_DENIED
7. Effective risk = max(classifier, command.serverRiskClass)
8. Full-payload binding hash             (computeBindingHash)           paramHash
9. Create Action Passport                 (ActionPassportService.createRequest)
10. Create lifecycle record              (ExecutionLifecycleManager)
11. Approval gate                        (ApprovalService)              AWAITING_APPROVAL
12. Execute via adapter                  (ExecutionAdapter)             PREPARE → EXECUTE (bounded)
13. Verify                               (adapter.verify(), authoritative) VERIFIED/PARTIAL
14. Audit                               (AuditService)
```

Any failure at steps 1–8 returns `BLOCKED` with a specific `errorCode` and
writes a `COMMAND_BLOCKED` audit event. Steps 9–14 proceed only after every
gate passes.

## Fail-closed error codes

| `errorCode` | Meaning |
|-------------|---------|
| `WORKSPACE_DENIED` | Actor is not a member of the workspace. |
| `UNKNOWN_COMMAND` | Command id/version not registered or removed. |
| `INVALID_ARGS` | Args failed the input schema. |
| `CAPABILITY_UNAVAILABLE` | Required capability not usable for the workspace. |
| `CAPABILITY_ESCALATION` | Capability scope would exceed caller permissions. |
| `PERMISSION_DENIED` | Caller lacks a required permission. |
| `IDEMPOTENCY_CONFLICT` | Idempotency key reused for a different canonical request (command, args, capability, target, version or execution options). The prior execution/passport is never returned. |

## Verification (adapter-authoritative)

For adapter-backed commands the gateway invokes the registered adapter's
`verify()` after a successful `execute()` and uses **`AdapterVerification.verified`
as the verification decision**. `Boolean(result.evidence)` is never used as a
substitute: an adapter returning `{ success: true, evidence: {...} }` is not
enough to establish verification.

- **Execution evidence vs verification evidence.** `result.output` is the
  adapter's ordinary execution output; `AdapterVerification.evidence` is the
  verification evidence. They are persisted in distinct columns
  (`command_executions.result` and `command_executions.evidence`) so a user can
  inspect what the adapter returned separately from what verified it.
- **When `VERIFIED` may be reported.** Only when `verify()` resolves with
  `verified: true` **and** the evidence is a non-empty, serialisable object.
  Malformed, non-serialisable or empty evidence is rejected as proof of a
  verified outcome (`VERIFICATION_EVIDENCE_INVALID`).
- **Unsupported verification.** If the command's `verificationContract` requires
  automatic verification (any type other than `manual`, or `independentCheck`)
  and the adapter declares `supportsVerification: false`, the gateway fails
  closed **before execution** (`VERIFICATION_UNSUPPORTED`). A `manual` contract
  is never silently promoted to an automatic `VERIFIED`; it resolves to an
  honest `PARTIAL` (`VERIFICATION_MANUAL_REQUIRED`).
- **Verification failures.** `verify()` returning `verified: false` → `PARTIAL`
  (`VERIFICATION_FAILED`); `verify()` throwing or not completing → `PARTIAL`
  (`VERIFICATION_ERROR`). A verification decision that disagrees with execution
  evidence always wins.

## Timeouts and uncertain side effects

The gateway enforces a server-side bounded execution using the stricter valid
limit `effective timeout = min(command.timeoutPolicy.maxSeconds,
adapter.timeoutSeconds)`, applied to **prepare**, **execute** and **verify**.
Timeout values are validated before use (a non-positive value fails closed with
`TIMEOUT_INVALID`). Each phase receives a cooperative `AbortSignal`; a
cooperative adapter should observe it and stop, but the gateway never assumes
the adapter stopped merely because the phase timed out.

- A prepare timeout prevents execution from beginning (`PREPARE_TIMEOUT`).
- An execution timeout with an uncertain external side effect produces an honest
  **unresolved** `PARTIAL` (`EXECUTION_TIMEOUT`), never a claim that the
  operation definitely did not happen, and never a false success.
- A verification timeout never yields `VERIFIED` (`VERIFICATION_TIMEOUT`).
- Timers and abort listeners are cleaned up on every completion, failure and
  timeout path. No operation whose external outcome is uncertain is automatically
  retried.

## Compensation boundary

The adapter interface declares `compensate()`, but this milestone does **not**
invent rollback behaviour and the gateway never invokes compensation as a
shortcut around the passport or lifecycle. No operation is reported as rolled
back unless a separately authorised and verified compensation operation actually
occurred. `COMPENSATION_PENDING` / `COMPENSATED` semantics are preserved;
automatic compensation is recorded as future work requiring its own governed
design.

## Live-integration status

This milestone hardens the execution boundary but does **not** establish live
integration availability. No real external connector is connected or accepted;
verification and timeout behaviour is exercised with deterministic test adapters
only.

## CommandOutcome

`submit()` returns a `CommandOutcome` with `status` (`BLOCKED` or a lifecycle
terminal state), `commandId`, `commandVersion`, `riskClass`, `capabilityId`,
`passportId`, `passportStatus`, `paramsHash`, `errorCode`, `message`, and the
lifecycle execution id.

## Client contract

The client supplies only: `commandId`, optional `version`, `workspaceId`,
`args`, optional `targetType`/`targetId`, an `idempotencyKey`, and an optional
`agentId`. Everything security-critical is server-side.

## See also

- `docs/architecture/COMMAND-LIFECYCLE.md`
- `docs/security/COMMAND-PASSPORT-BINDING.md`
- `MILESTONES/CORE-02-UNIVERSAL-COMMAND-CAPABILITY-ENGINE.md`
