# Command Registry

**Milestone:** CORE-02 · **Module:** `lib/commands/{types,registry,builtin}.ts`

## Abstract

The Command Registry is the single, typed source of truth for every command an
agent, UI or integration may execute. A command is a declared, versioned,
self-describing unit with an input schema, the permissions it requires, the
server-side risk class it declares, its approval policy, the capability it
needs (if any), and its verification and compensation contracts.

Nothing executes without first being registered here. The registry is the
gateway's first stop: an unknown command id fails closed.

## Definition model

`CommandDefinition` (`lib/commands/types.ts`):

| Field | Meaning |
|-------|---------|
| `commandId`, `version` | Stable, versioned identity. |
| `name`, `description`, `documentation` | Human-readable metadata. |
| `category` | Grouping (`platform`, `workspace`, …). |
| `inputSchema` | zod schema for args — the contract the validator enforces. |
| `requiredPermissions` | RBAC permissions (CORE-01 `Permission`). |
| `requiredCapability` | Optional capability id; null for platform commands. |
| `serverRiskClass` | Declared R0–R4 (R4 destructive/regulated, human-only). |
| `approvalPolicy` | `NONE` / `AUTO` / `REQUIRED`. |
| `executionMode` | `SYNC` / `ASYNC`. |
| `timeoutPolicy`, `rateLimitPolicy`, `idempotencyPolicy` | Execution controls. |
| `verificationContract` | How the result is independently verified. |
| `compensationContract` | Reversal/compensation support. |
| `availabilityRequirements` | Capability availability gates. |
| `deprecationStatus` | `ACTIVE` / `DEPRECATED` / `REMOVED`. |

## Registry operations (`CommandRegistry`)

- `register(def)` / `registerAll(defs)` — idempotent by `commandId@version`.
- `get(commandId, version?)` — fetch a definition (latest version if omitted).
- `assertSupported(commandId, version?)` — throws `RegistryError` when unknown
  or deprecated-removed; this is the fail-closed gate.
- `list(category?)` — discovery listing.
- `resolve(commandId, version?)` — returns `{ command, deprecationStatus }`.

## Built-in registry

`lib/commands/builtin.ts` registers eight safe, workspace-scoped commands (all
R1, real database operations):

`platform.commands.list`, `platform.commands.describe`,
`platform.capabilities.list`, `platform.capabilities.describe`,
`platform.command.validate`, `platform.command.preview`,
`workspace.members.list`, `workspace.audit.list`.

**Constraint:** built-in commands are registry/validation/workspace-scoped only.
No fake business commands are registered in CORE-02.

## Client catalogue

`lib/commands/catalogue.ts` derives a serialisable, React-safe
`COMMAND_CATALOGUE` from the real built-in definitions — a single source of
truth, not a duplicated list. The client renders this catalogue; it never
chooses risk, permissions, approval or adapter.

## See also

- `docs/architecture/COMMAND-GATEWAY.md`
- `docs/architecture/COMMAND-LIFECYCLE.md`
- `MILESTONES/CORE-02-UNIVERSAL-COMMAND-CAPABILITY-ENGINE.md`
