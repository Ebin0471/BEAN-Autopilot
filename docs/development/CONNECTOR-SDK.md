# Connector / Execution Adapter SDK

**Milestone:** CORE-02 · **Module:** `lib/commands/adapter.ts`

## Abstract

The adapter SDK is the pluggable execution boundary between the governed
lifecycle and a concrete execution surface. An adapter is a server-side
component that the gateway and lifecycle manager call; it is never selected or
named by the client.

## Interface

```ts
interface ExecutionAdapter {
  adapterId: string;
  supportedCommands: string[];
  requiredPermissions: Permission[];
  execute(request: CommandRequest, context: ExecutionContext): Promise<AdapterResult>;
  cancel(executionId: string): Promise<void>;
}
```

- `supportedCommands` — the command ids this adapter can serve. The gateway
  refuses a command whose capability resolves to an adapter that does not
  support it.
- `requiredPermissions` — the permissions the adapter needs; combined with the
  command's permissions, these must all be satisfied by the caller's effective
  permissions (deny-by-default).
- `execute` — performs the real work and returns a structured result for the
  verification contract to check.
- `cancel` — cooperative cancellation for cancellable executions.

## ExecutionContext

Provided by the lifecycle manager: `workspaceId`, `actor`, `passportId`,
`paramsHash`, `lifecycle execution id`, and the canonical params. The adapter
must operate strictly within the authorised scope and must not re-open
authorisation.

## Adapter selection is server-side

The gateway resolves the capability → adapter mapping server-side. The client
submits a command request and never names an adapter, sets risk, grants
permissions, or decides approval. This keeps authorisation in one place.

## Test-only adapter (CORE-02)

`TestCommandAdapter` implements the interface for tests and local dry-runs. It
records invocations so the lifecycle, idempotency and verification paths can be
exercised end-to-end without a real connector.

**No real email/CRM/banking/desktop/browser adapters are implemented this
milestone.** Connectors remain registered as PLANNED capabilities.

## Adding a real adapter (future work)

1. Register the capability in `builtin-capabilities.ts` with its real
   `availabilityStatus` (move `PLANNED` → `CONFIGURATION_REQUIRED` →
   `AVAILABLE` as it lands).
2. Implement `ExecutionAdapter` for the surface; declare the narrowest
   `requiredPermissions`.
3. Wire it into the gateway's capability → adapter resolution (server-side).
4. Add integration tests covering execute, cancel, timeout and failure
   compensation; keep the fail-closed gateway tests green.

## See also

- `docs/architecture/COMMAND-LIFECYCLE.md`
- `docs/development/COMMAND-DEFINITION-GUIDE.md`
