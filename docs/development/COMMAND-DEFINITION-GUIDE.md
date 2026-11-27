# Command Definition Guide

**Milestone:** CORE-02 · **Module:** `lib/commands/{types,registry,builtin}.ts`

## Abstract

How to add a new command to the universal registry without weakening the
governed execution model. A command is a declared, versioned, self-describing
unit. Every field is enforced server-side by the gateway; the client renders
only the read-only catalogue.

## The rule

**A command never expands authority.** It declares the permissions it needs and
the risk it represents; the gateway combines these with the caller's effective
permissions (deny-by-default) and the capability's scope (escalation-checked).
The command definition is a contract, not a grant.

## Anatomy

```ts
const myCommand: CommandDefinition = {
  commandId: "acme.reports.list",     // stable, dotted, unique
  version: "1.0.0",                   // semver; immutable once published
  name: "List reports",
  description: "List workspace reports.",
  category: "acme",                   // grouping for discovery
  inputSchema: z.object({              // the args contract
    limit: z.number().int().positive().optional(),
  }),
  requiredPermissions: ["workspace.read"],   // CORE-01 permissions
  requiredCapability: "acme.reports",          // or null for platform cmds
  serverRiskClass: "R1",                        // R0..R4, never below classifier
  approvalPolicy: "NONE",                       // NONE / AUTO / REQUIRED
  executionMode: "SYNC",                        // SYNC / ASYNC
  timeoutPolicy: { maxSeconds: 30, cancellable: true },
  rateLimitPolicy: { maxRequests: 60, windowSeconds: 60 },
  idempotencyPolicy: { enforced: true, scope: "workspace" },
  verificationContract: {
    type: "result_validation",
    description: "Row count matches the query result.",
    independentCheck: true,
  },
  compensationContract: { supported: false, description: "" },
  availabilityRequirements: [{ capabilityId: "acme.reports", status: "AVAILABLE" }],
  targetRequirements: { required: false },
  deprecationStatus: "ACTIVE",
  documentation: "How to use this command.",
};
```

## Steps to register

1. **Define the schema** (`inputSchema`). It is the single validation contract;
   the gateway's `INVALID_ARGS` gate enforces it.
2. **Pick the narrowest permissions.** List exactly the CORE-01 permissions the
   command needs. Do not add permissions you do not use.
3. **Declare the true risk.** `serverRiskClass` must not understate the
   classifier's assessment — the gateway takes the max. Use `R3` for
   consequential actions (human approval) and `R4` for destructive/regulated
   actions (human-only).
4. **Set the approval policy honestly.** `REQUIRED` when a human must approve.
5. **Bind a capability** (`requiredCapability`) if the command serves a
   connector surface; otherwise `null`. The capability's `supportedCommands`
   must list this command id.
6. **Register** via `registry.register(def)` (or add to `BUILTIN_COMMANDS`).
   Registration is idempotent by `commandId@version`.
7. **Add tests:** validation (valid + invalid args), permission denial,
   capability escalation denial, and the full-payload binding hash.

## Versioning

- Publish an immutable `version`. To change behaviour, register a new
  `commandId@version`.
- `assertSupported(commandId, version?)` resolves the requested version or the
  latest when omitted, and fails closed on `REMOVED` commands.

## Constraints (CORE-02)

- Register only safe, real, workspace-scoped commands in this milestone.
- No fake business commands.
- No real connector integrations — test-only adapters.
- Do not make the client choose risk, permissions, approval, adapter or
  authorisation.

## See also

- `docs/architecture/COMMAND-REGISTRY.md`
- `docs/development/CONNECTOR-SDK.md`
- `MILESTONES/CORE-02-UNIVERSAL-COMMAND-CAPABILITY-ENGINE.md`
