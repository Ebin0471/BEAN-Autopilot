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
12. Execute via adapter                   (ExecutionAdapter)
13. Verify                               (verificationContract)         VERIFIED/PARTIAL
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
