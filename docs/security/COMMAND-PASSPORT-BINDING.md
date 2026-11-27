# Command Passport Binding

**Milestone:** CORE-02 · **Security contract**

## Abstract

An Action Passport authorises one specific, bound action. CORE-02 strengthens the
CORE-01 passport so it binds the **full payload** — the exact arguments of the
execution — not merely command identity and target. This document describes the
canonical binding hash, the CORE-01 `computeParamHash` gap that was fixed, and
the regression guarantee.

## The CORE-01 gap

CORE-01's original `computeParamHash` folded only:

```
sha256([command, targetType, targetId, dataScope].join("|"))
```

The actual arguments were **not** part of the hash. Two invocations of the same
command with different arguments therefore produced the same param hash, and a
passport issued for one payload could be replayed against a different payload
with the same command/target. This was a real binding weakness.

## The fix — full-payload canonical binding

`lib/commands/canonical.ts` implements:

- `canonicalize(value)` — deterministic JSON: object keys sorted recursively,
  arrays preserve order, numbers canonicalised, non-finite/function values
  rejected, and credential-looking keys redacted.
- `computeBindingHash({ workspaceId, commandId, commandVersion, capabilityId,
  capabilityVersion, targetType, targetId, args, options })` — canonical JSON
  of **all** of: workspace, command id+version, capability id+version, target,
  every argument, and execution options.
- `computeParamHash({ workspaceId, commandId, commandVersion, args, ... })` —
  backward-compatible wrapper that folds `params` (the args) into the
  canonical binding.

The gateway computes the binding once and passes `paramHash` + `paramsCanonical`
into `ActionPassportService.createRequest()`. The passport stores
`params_canonical` and its `paramHash` is the full-payload hash.

## What is bound

| Input | Bound |
|-------|-------|
| Workspace | ✅ |
| Command id + version | ✅ |
| Capability id + version | ✅ |
| Target type + id | ✅ |
| **All arguments** | ✅ (the fix) |
| Execution options | ✅ |

Changing **any** of these — including swapping a single argument value — changes
the `paramHash`.

## Regression guarantee

`tests/core02-commands.test.ts` asserts, as a security regression, that two
invocations of the same command with **different arguments** produce
**different** param hashes, and that the canonical form is stable regardless of
key insertion order. The CORE-01 suite (39 tests) continues to pass unchanged.

## Verify-time enforcement

`ActionPassportService.assertExecutable()` re-checks the command, target and
`paramHash` before consumption and consumes a one-time passport. A passport
whose stored hash does not match the executed payload is rejected.

## Client contract

The client supplies the args; the **server** computes the binding hash. The
client cannot influence `paramHash`, risk class, permissions, approval or
authorisation — it submits a request and receives the server-side outcome.

## See also

- `docs/security/ACTION-PASSPORT.md` (CORE-01)
- `docs/architecture/COMMAND-GATEWAY.md`
- `MILESTONES/CORE-02-UNIVERSAL-COMMAND-CAPABILITY-ENGINE.md`
