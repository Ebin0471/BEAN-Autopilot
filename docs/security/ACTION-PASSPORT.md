# CORE-01 Action Passport

The Action Passport is the single, auditable gate for consequential actions.
It binds an action to **one workspace, one exact command, one exact target**,
with canonicalised parameters, a server-computed risk class, an approval
requirement, and a full lifecycle.

## 1. Binding

A passport is bound to:
- **One workspace** — never spans tenants.
- **One exact action** — `command` + `operation`.
- **One exact target** — `targetType` + `targetId`.
- **Canonicalised parameters** — a `param_hash` over
  `command | targetType | targetId | dataScope`. Any parameter change
  invalidates the approval (the hash mismatches on execution).

## 2. State machine

```
        ┌────────────┐   approve(SINGLE)   ┌─────────────┐  authorise  ┌─────────────┐
        │  REQUESTED │ ───────────────────▶ │ APPROVED    │ ───────────▶ │  AUTHORISED │
        └─────┬──────┘                     └─────────────┘              └──────┬──────┘
              │                                  ▲                          │ consume
              │ no approval (R0–R2)             │ reject                    ▼
              └─────────────────────────────────┘                  ┌─────────────┐
                                                                   │  CONSUMED   │ (terminal)
        REJECTED / EXPIRED / REVOKED / BLOCKED                          └─────────────┘
        (terminal)
```

**Explicit valid transitions** (`PASSPORT_TRANSITIONS` in `lib/security/types.ts`):

| From | Allowed → |
|---|---|
| REQUESTED | PENDING_APPROVAL, AUTHORISED, REJECTED, EXPIRED, BLOCKED |
| PENDING_APPROVAL | APPROVED, REJECTED, EXPIRED, REVOKED, BLOCKED |
| APPROVED | AUTHORISED, EXPIRED, REVOKED, BLOCKED |
| AUTHORISED | CONSUMED, EXPIRED, REVOKED, BLOCKED |
| REJECTED / EXPIRED / REVOKED / CONSUMED / BLOCKED | *(terminal — no transitions)* |

**Invalid transitions fail** with a `PassportError`.

## 3. Lifecycle & enforcement

### Create (`createRequest`)
1. Server verifies the actor has `actions.request` in the workspace (deny-by-default).
2. The requested `permissionScope` must be a **subset** of the actor's effective
   permissions — approval/delegation can never expand scope.
3. The server computes the **authoritative risk class** (client-proposed risk ignored).
4. If approval is required (R3/R4), status = `PENDING_APPROVAL`; else `AUTHORISED`.
5. Idempotency: same `(workspaceId, idempotencyKey)` returns the existing passport.

### Approve / reject (`approve`)
- Approver must hold `actions.approve`.
- **Separation of duties:** the initiator cannot approve their own passport.
- `DUAL` policy requires **two distinct** approvers before `APPROVED`.
- Each decision is recorded with comment + timestamp (`passport_approvals`).

### Authorise (`authorise`)
- Moves `APPROVED → AUTHORISED`. Caller must hold `actions.execute`.

### Execute (`assertExecutable`)
- Re-checks state (`AUTHORISED`), expiry, revocation.
- Verifies the **exact** command, target, and `param_hash` (altered params fail).
- Consumes the passport (`AUTHORISED → CONSUMED`) — **one-time, no replay**.

### Revoke (`revoke`)
- Owner-only. Unconsumed passports only. Expired/consumed handled per state.

## 4. Risk & approval matrix

| Class | Example commands | Approval | Autonomous execution |
|---|---|---|---|
| R0 | local draft | No | Allowed |
| R1 | read, list, get | No (read permission) | Allowed |
| R2 | scoped reversible writes | No (scoped permission; recorded) | Allowed |
| R3 | send, email, purchase, deploy | **Human approval required** | Blocked |
| R4 | delete, purge, destroy, regulated | **Human approval required; dual where configured** | Blocked |

## 5. Invariants (tested)

- ✅ Exact action accepted; wrong workspace / target rejected.
- ✅ Altered parameters rejected (param hash mismatch).
- ✅ Expired / revoked / consumed passports unusable.
- ✅ Replay rejected (one-time consumption).
- ✅ Duplicate idempotent (same key returns same passport).
- ✅ Invalid transitions rejected.
- ✅ Self-approval restricted.
- ✅ R3 approval required; R4 dual approval + agent execution denied.
- ✅ Approval cannot expand scope beyond the actor's permissions.

## 6. Relationship to execution

CORE-01 implements the passport **lifecycle, binding, approval, and enforcement
infrastructure**. Automated agent execution that *consumes* a passport is a
future milestone. The passport is the gate; execution is the consumer. No claim
of already-existing execution is made.
