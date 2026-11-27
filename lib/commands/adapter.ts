import type { CapabilityDefinition, CommandDefinition } from "./types";

/* ============================================================
   CORE-02 — Command execution adapter SDK.
   Defines the contract future verified integrations implement.
   CORE-02 ships the interface + test-only adapters; no real
   external integration is connected.
   ============================================================ */

export interface AdapterPrepareContext {
  workspaceId: string;
  command: CommandDefinition;
  capability: CapabilityDefinition | null;
  args: Record<string, unknown>;
  targetType?: string;
  targetId?: string;
}

export interface AdapterExecuteContext extends AdapterPrepareContext {
  passportId: string;
  paramsHash: string;
}

export interface AdapterResult {
  success: boolean;
  /** Structured output matching the command output schema (informational). */
  output?: unknown;
  /** Evidence supporting verification. */
  evidence?: Record<string, unknown>;
  /** Structured failure code when success is false. */
  errorCode?: string;
  /** Whether the operation may be safely retried. */
  retryable?: boolean;
}

/** A verification result from the adapter's evidence contract. */
export interface AdapterVerification {
  verified: boolean;
  evidence: Record<string, unknown>;
  reason?: string;
}

/**
 * The execution adapter contract. Every adapter declares identity, supported
 * commands, workspace types, permissions, risk restrictions, timeouts,
 * idempotency behaviour and verification/compensation capabilities.
 */
export interface CommandAdapter {
  /** Adapter identity and version. */
  readonly adapterId: string;
  readonly version: string;
  /** Command ids this adapter can execute. */
  readonly supportedCommands: string[];
  /** Workspace kinds this adapter supports. */
  readonly supportedWorkspaceTypes: string[];
  /** Permissions the adapter requires (must be a subset of the actor's). */
  readonly requiredPermissions: string[];
  /** Risk classes this adapter will refuse to execute. */
  readonly riskRestrictions: string[];
  /** Maximum execution time in seconds. */
  readonly timeoutSeconds: number;
  /** Whether the adapter enforces idempotency. */
  readonly idempotent: boolean;
  /** Whether the adapter can produce verification evidence. */
  readonly supportsVerification: boolean;
  /** Whether the adapter supports compensation. */
  readonly supportsCompensation: boolean;

  describe(): Record<string, unknown>;
  validate(command: CommandDefinition, args: Record<string, unknown>): void;
  prepare(ctx: AdapterPrepareContext): Promise<void>;
  execute(ctx: AdapterExecuteContext): Promise<AdapterResult>;
  verify(ctx: AdapterExecuteContext, result: AdapterResult): Promise<AdapterVerification>;
  compensate(ctx: AdapterExecuteContext, result: AdapterResult): Promise<AdapterResult>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}

/* ============================================================
   Test-only adapters. Never presented as production integrations.
   ============================================================ */

/**
 * A deterministic in-memory adapter used exclusively by automated tests.
 * It records calls and returns configurable results. It performs no real
 * external action and must never be registered as a production integration.
 */
export class TestCommandAdapter implements CommandAdapter {
  readonly adapterId: string;
  readonly version = "1.0.0";
  readonly supportedCommands: string[];
  readonly supportedWorkspaceTypes: string[];
  readonly requiredPermissions: string[];
  readonly riskRestrictions: string[];
  readonly timeoutSeconds: number;
  readonly idempotent: boolean;
  readonly supportsVerification: boolean;
  readonly supportsCompensation: boolean;

  public calls: string[] = [];
  public executeResult: AdapterResult = { success: true, output: { ok: true } };
  public verifyResult: AdapterVerification = { verified: true, evidence: { checked: true } };
  public health: { healthy: boolean; detail?: string } = { healthy: true };

  constructor(opts: {
    adapterId: string;
    supportedCommands: string[];
    requiredPermissions?: string[];
    riskRestrictions?: string[];
    timeoutSeconds?: number;
    idempotent?: boolean;
    supportsVerification?: boolean;
    supportsCompensation?: boolean;
    supportedWorkspaceTypes?: string[];
  }) {
    this.adapterId = opts.adapterId;
    this.supportedCommands = opts.supportedCommands;
    this.supportedWorkspaceTypes = opts.supportedWorkspaceTypes ?? ["PERSONAL", "PROFESSIONAL", "BUSINESS"];
    this.requiredPermissions = opts.requiredPermissions ?? [];
    this.riskRestrictions = opts.riskRestrictions ?? [];
    this.timeoutSeconds = opts.timeoutSeconds ?? 10;
    this.idempotent = opts.idempotent ?? true;
    this.supportsVerification = opts.supportsVerification ?? true;
    this.supportsCompensation = opts.supportsCompensation ?? true;
  }

  describe() {
    return { adapterId: this.adapterId, version: this.version, supportedCommands: this.supportedCommands, testOnly: true };
  }
  validate() {
    /* test adapter accepts anything the gateway already validated */
  }
  async prepare() {
    this.calls.push("prepare");
  }
  async execute() {
    this.calls.push("execute");
    return this.executeResult;
  }
  async verify() {
    this.calls.push("verify");
    return this.verifyResult;
  }
  async compensate() {
    this.calls.push("compensate");
    return { success: true, output: { compensated: true } };
  }
  async healthCheck() {
    return this.health;
  }
}
