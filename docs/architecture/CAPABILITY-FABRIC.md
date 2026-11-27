# Capability Fabric

**Milestone:** CORE-02 · **Module:** `lib/commands/{capability,builtin-capabilities}.ts`

## Abstract

A capability is a registered, versioned execution surface — a connector or
platform service that a command may require. The Capability Fabric tracks what
each capability is, what commands it supports, what scopes it needs, what
workspace types it works in, its risk constraints, and its **availability
state**. It is the mechanism by which capability identity is bound to a command
execution without ever expanding a user's permissions.

## Capability model

`CapabilityDefinition` (`lib/commands/types.ts`):

| Field | Meaning |
|-------|---------|
| `capabilityId`, `version` | Stable identity. |
| `name`, `category`, `provider`, `description` | Metadata. |
| `supportedCommands` | Command ids this capability can serve. |
| `requiredScopes` | Scopes the capability needs (narrowest possible). |
| `supportedWorkspaceTypes` | `PERSONAL` / `PROFESSIONAL` / `BUSINESS`. |
| `riskConstraints` | R classes the capability permits (never exceeds command). |
| `availabilityStatus` | Lifecycle state (see below). |
| `healthStatus`, `trustLevel` | Operational state. |
| `verificationSupport`, `compensationSupport` | Contract support. |

## Availability states

`PLANNED` → `REGISTERED` → `CONFIGURATION_REQUIRED` → `AVAILABLE`; plus
`DEGRADED`, `UNAVAILABLE`, `DISABLED`, `REVOKED`.

States are **not** interchangeable with command status vocabulary
(`DESIGNED`/`IMPLEMENTED`/`TESTED`/`REGISTERED`/…) or lifecycle states. The
Connections UI renders the real state and disables Connect for anything that is
not `AVAILABLE`.

## Registry operations (`CapabilityRegistry`)

- `register(cap)` / `registerAll(caps)`.
- `get(capabilityId, version?)` — null when absent.
- `list(category?)` — discovery listing.
- `assertUsable(cap, workspaceType)` — throws `CapabilityError` when the
  capability cannot serve the workspace type.
- `assertNoEscalation(cap, effectivePermissions)` — **security invariant:** a
  capability's `requiredScopes` must never exceed the caller's effective
  permissions. This is enforced at gateway time; a capability can never grant
  permissions the user does not already have.

## Registered capabilities

`lib/commands/builtin-capabilities.ts`:

- `platform.registry` — **AVAILABLE**. The real, workspace-scoped registry
  capability backing the platform commands.
- `browser.automation`, `email`, `calendar`, `file.storage`, `crm`,
  `desktop.windows`, `iot.smart-home` — **PLANNED**. Registered as plans only;
  not connected in CORE-02.

**Constraint:** no real email/CRM/banking/desktop/browser integrations this
milestone. Connectors are test-only adapters.

## See also

- `docs/architecture/COMMAND-REGISTRY.md`
- `docs/architecture/COMMAND-GATEWAY.md`
- `docs/security/COMMAND-PASSPORT-BINDING.md`
