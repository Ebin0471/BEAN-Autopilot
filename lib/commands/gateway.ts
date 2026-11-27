import type { Db } from "@/lib/db/database";
import { computeBindingHash, canonicalBinding } from "./canonical";
import { AuditService } from "@/lib/security/audit";
import { PolicyEngine, AuthorizationError } from "@/lib/security/policy";
import { RiskClassifier } from "@/lib/security/risk";
import { ActionPassportService } from "@/lib/security/passport";
import { CommandRegistry } from "./registry";
import { CapabilityRegistry } from "./capability";
import { ExecutionLifecycleManager } from "./lifecycle";
import type { CommandAdapter, AdapterResult } from "./adapter";
import {
  type CommandRequest,
  type CommandDefinition,
  type ExecutionState,
} from "./types";
import type { PassportState, Permission, RiskClass } from "@/lib/security/types";

export class GatewayError extends Error {
  constructor(message: string, public code = "GATEWAY_ERROR") {
    super(message);
    this.name = "GatewayError";
  }
}

export interface CommandOutcome {
  executionId: string;
  commandId: string;
  commandVersion: string;
  status: ExecutionState;
  riskClass: RiskClass;
  capabilityId: string | null;
  passportId: string | null;
  passportStatus: PassportState | null;
  paramsHash: string;
  result?: unknown;
  evidence?: unknown;
  errorCode?: string;
  message: string;
}

const RISK_RANK: Record<RiskClass, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

/**
 * The single controlled path through which command requests are validated and
 * routed. Implements the full lifecycle as explicit steps. All security
 * decisions (permissions, risk, passport) remain server-side and reuse CORE-01
 * services — there is no second permission engine, risk classifier or passport.
 */
export class CommandGateway {
  private adapters = new Map<string, CommandAdapter>();

  constructor(
    private db: Db,
    private policy: PolicyEngine,
    private risk: RiskClassifier,
    private passport: ActionPassportService,
    private audit: AuditService,
    private commands: CommandRegistry,
    private capabilities: CapabilityRegistry,
    private lifecycle: ExecutionLifecycleManager,
  ) {}

  /** Register an execution adapter (controlled; for verified integrations/tests). */
  registerAdapter(adapter: CommandAdapter): void {
    this.adapters.set(adapter.adapterId, adapter);
  }

  /**
   * Validate a request and resolve the full plan WITHOUT executing or creating
   * a passport. Used by the preview command and the validate endpoint.
   */
  preview(
    request: CommandRequest,
    actor: { userId: string; workspaceId: string },
  ): {
    command: CommandDefinition;
    capabilityId: string | null;
    capabilityUsable: boolean;
    permissionsOk: boolean;
    riskClass: RiskClass;
    approvalRequired: boolean;
    paramsHash: string;
    errors: string[];
  } {
    const errors: string[] = [];
    let command: CommandDefinition;
    try {
      command = this.commands.assertSupported(request.commandId, request.version);
    } catch (e) {
      errors.push((e as Error).message);
      // Return a minimal stub so the caller can inspect the error.
      return this.emptyPreview(request, (e as Error).message);
    }
    const capabilityId = command.requiredCapability;
    let capabilityUsable = false;
    if (capabilityId) {
      const cap = this.capabilities.get(capabilityId);
      if (!cap) errors.push(`Unknown capability: ${capabilityId}`);
      else {
        capabilityUsable = this.capabilities.isUsable(capabilityId);
        if (!capabilityUsable) errors.push(`Capability not available: ${capabilityId}`);
      }
    }
    try {
      command.inputSchema.parse(request.args);
    } catch (e) {
      errors.push(`Invalid arguments: ${(e as Error).message}`);
    }
    let permissionsOk = false;
    try {
      this.assertPermissions(actor.userId, actor.workspaceId, command);
      permissionsOk = true;
    } catch (e) {
      errors.push((e as Error).message);
    }
    const riskClass = this.resolveRisk(command);
    const paramsHash = this.computeBinding(actor.workspaceId, command, capabilityId, request).hash;
    return {
      command,
      capabilityId,
      capabilityUsable,
      permissionsOk,
      riskClass,
      approvalRequired: this.risk.policyFor(riskClass).approvalRequired || command.approvalPolicy !== "NONE",
      paramsHash,
      errors,
    };
  }

  private emptyPreview(request: CommandRequest, message: string) {
    return {
      command: { commandId: request.commandId, version: "0.0.0", name: request.commandId, description: "", category: "platform" as const, inputSchema: {} as never, requiredCapability: null, requiredPermissions: [], serverRiskClass: "R2" as RiskClass, approvalPolicy: "NONE" as const, targetRequirements: { required: false }, executionMode: "SYNC" as const, timeoutPolicy: { maxSeconds: 0, cancellable: true }, rateLimitPolicy: { maxRequests: 0, windowSeconds: 60 }, idempotencyPolicy: { enforced: false, scope: "workspace" as const }, verificationContract: { type: "result_validation" as const, description: "", independentCheck: false }, compensationContract: { supported: false, description: "" }, availabilityRequirements: [], deprecationStatus: "ACTIVE" as const, documentation: "" },
      capabilityId: null,
      capabilityUsable: false,
      permissionsOk: false,
      riskClass: "R2" as RiskClass,
      approvalRequired: false,
      paramsHash: "",
      errors: [message],
    };
  }

  /** Submit a command request through the full gateway lifecycle. */
  async submit(request: CommandRequest, actor: { userId: string; workspaceId: string }): Promise<CommandOutcome> {
    // 1. Resolve workspace + membership (deny-by-default).
    try {
      this.policy.requireMember(actor.userId, actor.workspaceId);
    } catch {
      return this.block(actor, request, null, "Workspace access denied", "WORKSPACE_DENIED");
    }

    // 2. Look up command version.
    let command: CommandDefinition;
    try {
      command = this.commands.assertSupported(request.commandId, request.version);
    } catch (e) {
      return this.block(actor, request, null, (e as Error).message, "UNKNOWN_COMMAND");
    }

    // 3. Validate input schema.
    let args: Record<string, unknown>;
    try {
      args = command.inputSchema.parse(request.args) as Record<string, unknown>;
    } catch (e) {
      return this.block(actor, request, command, (e as Error).message, "INVALID_ARGS");
    }

    // 4. Resolve capability (if required).
    let capabilityId: string | null = null;
    if (command.requiredCapability) {
      const cap = this.capabilities.get(command.requiredCapability);
      if (!cap) return this.block(actor, request, command, `Unknown capability: ${command.requiredCapability}`, "UNKNOWN_CAPABILITY");
      if (!this.capabilities.isUsable(command.requiredCapability)) {
        return this.block(actor, request, command, `Capability not available: ${command.requiredCapability}`, "CAPABILITY_UNAVAILABLE");
      }
      const eff = this.policy.resolve(actor.userId, actor.workspaceId)!;
      try {
        this.capabilities.assertNoEscalation(cap, eff.permissions);
      } catch (e) {
        return this.block(actor, request, command, (e as Error).message, "CAPABILITY_ESCALATION");
      }
      capabilityId = command.requiredCapability;
    }

    // 5. Check permissions (deny-by-default).
    try {
      this.assertPermissions(actor.userId, actor.workspaceId, command);
    } catch (e) {
      return this.block(actor, request, command, (e as Error).message, "PERMISSION_DENIED");
    }

    // 6. Classify risk (server-authoritative; never from the client).
    const riskClass = this.resolveRisk(command);

    // 7. Canonicalise the complete payload (hash + canonical string).
    const { hash: paramsHash, canonical: paramsCanonical } = this.computeBinding(actor.workspaceId, command, capabilityId, request, args);

    // 8. Create / check Action Passport bound to the FULL payload.
    const passport = this.passport.createRequest(
      { userId: actor.userId, workspaceId: actor.workspaceId, agentId: request.agentId ?? null },
      {
        workspaceId: actor.workspaceId,
        targetType: request.targetType ?? command.targetRequirements.type ?? "none",
        targetId: request.targetId ?? "none",
        command: command.commandId,
        operation: command.name,
        dataScope: actor.workspaceId,
        permissionScope: command.requiredPermissions as Permission[],
        riskClass,
        paramHash: paramsHash,
        params: args,
        paramsCanonical,
        idempotencyKey: request.idempotencyKey,
        approvalPolicy: command.approvalPolicy,
        verificationRequirements: [command.verificationContract.type],
        agentId: request.agentId ?? null,
      },
    ).passport;

    // 9. Execution lifecycle record (idempotent).
    const prior = this.lifecycle.findByIdempotency(actor.workspaceId, request.idempotencyKey);
    if (prior && isTerminalState(prior.status)) {
      return this.outcomeFromRecord(prior, command, riskClass, capabilityId, paramsHash);
    }
    const execution = this.lifecycle.create({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      commandId: command.commandId,
      commandVersion: command.version,
      capabilityId,
      passportId: passport.id,
      targetType: request.targetType ?? null,
      targetId: request.targetId ?? null,
      paramsHash,
      idempotencyKey: request.idempotencyKey,
    });

    // 10. Check approval + execution policy.
    const approvalRequired = this.risk.policyFor(riskClass).approvalRequired || command.approvalPolicy !== "NONE";
    if (approvalRequired && passport.status !== "AUTHORISED") {
      this.lifecycle.transition(execution.id, "VALIDATED");
      this.lifecycle.transition(execution.id, "AWAITING_APPROVAL");
      return this.outcome(execution.id, command, riskClass, capabilityId, passport, paramsHash, "AWAITING_APPROVAL", "Command awaiting approval");
    }

    // 11. Route only if authorised.
    return this.execute(execution.id, command, capabilityId, actor, request, args, paramsHash, passport.id);
  }

  /** Execute an authorised command (internal registry ops or a registered adapter). */
  private async execute(
    executionId: string,
    command: CommandDefinition,
    capabilityId: string | null,
    actor: { userId: string; workspaceId: string },
    request: CommandRequest,
    args: Record<string, unknown>,
    paramsHash: string,
    passportId: string,
  ): Promise<CommandOutcome> {
    const riskClass = this.resolveRisk(command);
    const passport = this.passport.get(passportId);

    // Move into VALIDATING, then consume the passport (one-time, bound to the
    // exact payload). A passport failure is a VALIDATING -> FAILED transition.
    this.lifecycle.transition(executionId, "VALIDATING");
    try {
      this.passport.assertExecutable(passportId, {
        command: command.commandId,
        targetId: request.targetId ?? "none",
        paramHash: paramsHash,
      });
    } catch (e) {
      this.lifecycle.transition(executionId, "FAILED", { errorCode: "PASSPORT_INVALID" });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", (e as Error).message, "PASSPORT_INVALID");
    }

    this.lifecycle.transition(executionId, "VALIDATED");
    this.lifecycle.transition(executionId, "AUTHORISED");
    this.lifecycle.transition(executionId, "READY");
    this.lifecycle.transition(executionId, "RUNNING", { adapterId: capabilityId ?? "internal" });

    let result: AdapterResult;
    try {
      if (capabilityId) {
        const adapter = this.findAdapter(command.commandId);
        if (!adapter) {
          this.lifecycle.transition(executionId, "FAILED", { errorCode: "ADAPTER_UNAVAILABLE" });
          return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", "No adapter registered for capability", "ADAPTER_UNAVAILABLE");
        }
        await adapter.prepare({
          workspaceId: actor.workspaceId,
          command,
          capability: this.capabilities.get(capabilityId) ?? null,
          args,
          targetType: request.targetType,
          targetId: request.targetId,
        });
        result = await adapter.execute({
          workspaceId: actor.workspaceId,
          command,
          capability: this.capabilities.get(capabilityId) ?? null,
          args,
          targetType: request.targetType,
          targetId: request.targetId,
          passportId,
          paramsHash,
        });
      } else {
        result = this.executeInternal(command, actor, args, request);
      }
    } catch (e) {
      this.lifecycle.transition(executionId, "FAILED", { errorCode: "EXECUTION_ERROR" });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", (e as Error).message, "EXECUTION_ERROR");
    }

    if (!result.success) {
      this.lifecycle.transition(executionId, "FAILED", { errorCode: result.errorCode ?? "EXECUTION_FAILED", result: result.output });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", result.errorCode ?? "Execution failed", result.errorCode ?? "EXECUTION_FAILED", result.output);
    }

    // 12. Verify result.
    this.lifecycle.transition(executionId, "VERIFYING");
    const verified = this.verifyResult(command, result, capabilityId, executionId);
    if (verified.verified) {
      this.lifecycle.transition(executionId, "VERIFIED", { result: result.output, evidence: verified.evidence });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "VERIFIED", "Command verified", undefined, result.output, verified.evidence);
    }
    this.lifecycle.transition(executionId, "PARTIAL", { result: result.output, evidence: verified.evidence, errorCode: "VERIFICATION_FAILED" });
    return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "PARTIAL", verified.reason ?? "Verification failed", "VERIFICATION_FAILED", result.output, verified.evidence);
  }

  /* ---------------- Internal execution for built-in commands ---------------- */

  private executeInternal(
    command: CommandDefinition,
    actor: { userId: string; workspaceId: string },
    args: Record<string, unknown>,
    request: CommandRequest,
  ): AdapterResult {
    switch (command.commandId) {
      case "platform.commands.list":
        return { success: true, output: { commands: this.commands.list(args.category as string | undefined).map(summariseCommand) } };
      case "platform.commands.describe":
        return { success: true, output: { command: summariseCommand(this.commands.assertSupported(args.commandId as string, args.version as string | undefined)) } };
      case "platform.capabilities.list":
        return { success: true, output: { capabilities: this.capabilities.list(args.category as string | undefined).map(summariseCapability) } };
      case "platform.capabilities.describe":
        return { success: true, output: { capability: summariseCapability(this.capabilities.get(args.capabilityId as string, args.version as string | undefined)!) } };
      case "platform.command.validate": {
        const plan = this.preview(
          { commandId: args.commandId as string, version: args.version as string | undefined, workspaceId: actor.workspaceId, args: (args.args as Record<string, unknown>) ?? {}, targetType: args.targetType as string | undefined, targetId: args.targetId as string | undefined, idempotencyKey: request.idempotencyKey },
          actor,
        );
        return { success: plan.errors.length === 0, output: { valid: plan.errors.length === 0, errors: plan.errors, riskClass: plan.riskClass }, errorCode: plan.errors.length ? "VALIDATION_FAILED" : undefined };
      }
      case "platform.command.preview": {
        const plan = this.preview(
          { commandId: args.commandId as string, version: args.version as string | undefined, workspaceId: actor.workspaceId, args: (args.args as Record<string, unknown>) ?? {}, targetType: args.targetType as string | undefined, targetId: args.targetId as string | undefined, idempotencyKey: args.idempotencyKey as string },
          actor,
        );
        return { success: true, output: { commandId: plan.command.commandId, version: plan.command.version, capabilityId: plan.capabilityId, capabilityUsable: plan.capabilityUsable, permissionsOk: plan.permissionsOk, riskClass: plan.riskClass, approvalRequired: plan.approvalRequired, paramsHash: plan.paramsHash, errors: plan.errors } };
      }
      case "workspace.members.list": {
        const rows = this.db
          .prepare("SELECT user_id, role FROM workspace_memberships WHERE workspace_id = ?")
          .all(actor.workspaceId) as { user_id: string; role: string }[];
        return { success: true, output: { members: rows } };
      }
      case "workspace.audit.list": {
        const limit = (args.limit as number) ?? 50;
        const events = this.audit.list(actor.workspaceId, limit).map((e) => ({ id: e.id, eventType: e.event_type, actorId: e.actor_id, result: e.result, createdAt: e.created_at }));
        return { success: true, output: { events, integrity: this.audit.verifyChain() } };
      }
      default:
        return { success: false, errorCode: "UNSUPPORTED_INTERNAL_COMMAND" };
    }
  }

  private verifyResult(
    command: CommandDefinition,
    result: AdapterResult,
    capabilityId: string | null,
    executionId: string,
  ): { verified: boolean; evidence: Record<string, unknown>; reason?: string } {
    if (!capabilityId) {
      if (result.success) return { verified: true, evidence: { type: "result_validation", executionId } };
      return { verified: false, evidence: {}, reason: "Internal command did not succeed" };
    }
    // Adapter-backed: rely on the evidence the adapter attached per its contract.
    return {
      verified: Boolean(result.evidence),
      evidence: result.evidence ?? {},
      reason: result.evidence ? undefined : "No verification evidence",
    };
  }

  /* ---------------- Helpers ---------------- */

  private assertPermissions(userId: string, workspaceId: string, command: CommandDefinition): void {
    for (const perm of command.requiredPermissions) {
      if (!this.policy.authorize(userId, workspaceId, perm as Permission)) {
        throw new AuthorizationError(`Permission denied: ${perm}`);
      }
    }
  }

  /** Server-authoritative risk; the higher of the classifier and the command declaration. */
  private resolveRisk(command: CommandDefinition): RiskClass {
    const forced = this.risk.classify({ command: command.commandId, operation: command.name }).risk;
    return RISK_RANK[forced] >= RISK_RANK[command.serverRiskClass] ? forced : command.serverRiskClass;
  }

  private computeBinding(
    workspaceId: string,
    command: CommandDefinition,
    capabilityId: string | null,
    request: CommandRequest,
    args?: Record<string, unknown>,
  ): { hash: string; canonical: string } {
    const fields = {
      workspaceId,
      commandId: command.commandId,
      commandVersion: command.version,
      capabilityId,
      capabilityVersion: capabilityId ? "1.0.0" : null,
      targetType: request.targetType ?? command.targetRequirements.type ?? "none",
      targetId: request.targetId ?? "none",
      args: args ?? request.args,
      executionOptions: request.executionOptions ?? {},
    };
    return { hash: computeBindingHash(fields), canonical: canonicalBinding(fields) };
  }

  private findAdapter(commandId: string): CommandAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.supportedCommands.includes(commandId)) return adapter;
    }
    return undefined;
  }

  private block(
    actor: { userId: string; workspaceId: string },
    request: CommandRequest,
    command: CommandDefinition | null,
    message: string,
    code: string,
  ): CommandOutcome {
    const commandId = command?.commandId ?? request.commandId;
    const commandVersion = command?.version ?? "0.0.0";
    const capabilityId = command?.requiredCapability ?? null;
    const paramsHash = command
      ? this.computeBinding(actor.workspaceId, command, capabilityId, request).hash
      : "";
    const execution = this.lifecycle.create({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      commandId,
      commandVersion,
      capabilityId,
      targetType: request.targetType ?? null,
      targetId: request.targetId ?? null,
      paramsHash,
      idempotencyKey: request.idempotencyKey,
    });
    this.lifecycle.transition(execution.id, "BLOCKED", { errorCode: code });
    this.audit.append({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      actorType: "USER",
      eventType: "COMMAND_BLOCKED",
      targetType: "execution",
      targetId: execution.id,
      result: "DENIED",
      metadata: { commandId, code },
    });
    return {
      executionId: execution.id,
      commandId,
      commandVersion,
      status: "BLOCKED",
      riskClass: command ? this.resolveRisk(command) : "R2",
      capabilityId,
      passportId: null,
      passportStatus: null,
      paramsHash,
      errorCode: code,
      message,
    };
  }

  private outcome(
    executionId: string,
    command: CommandDefinition,
    riskClass: RiskClass,
    capabilityId: string | null,
    passport: { id: string; status: PassportState } | null | undefined,
    paramsHash: string,
    status: ExecutionState,
    message: string,
    errorCode?: string,
    result?: unknown,
    evidence?: unknown,
  ): CommandOutcome {
    return {
      executionId,
      commandId: command.commandId,
      commandVersion: command.version,
      status,
      riskClass,
      capabilityId,
      passportId: passport?.id ?? null,
      passportStatus: passport?.status ?? null,
      paramsHash,
      result,
      evidence,
      errorCode,
      message,
    };
  }
  /** Build an outcome from an existing (idempotent) execution record. */
  private outcomeFromRecord(
    record: { id: string; status: ExecutionState; command_id: string; command_version: string; capability_id: string | null; params_hash: string },
    command: CommandDefinition,
    riskClass: RiskClass,
    capabilityId: string | null,
    paramsHash: string,
  ): CommandOutcome {
    return {
      executionId: record.id,
      commandId: command.commandId,
      commandVersion: command.version,
      status: record.status,
      riskClass,
      capabilityId: capabilityId ?? record.capability_id,
      passportId: null,
      passportStatus: null,
      paramsHash: record.params_hash || paramsHash,
      message: "Idempotent replay of a completed execution",
    };
  }
}

function isTerminalState(state: ExecutionState): boolean {
  return state === "VERIFIED" || state === "FAILED" || state === "CANCELLED" || state === "COMPENSATED";
}

function summariseCommand(c: CommandDefinition) {
  return {
    commandId: c.commandId,
    version: c.version,
    name: c.name,
    category: c.category,
    requiredPermissions: c.requiredPermissions,
    serverRiskClass: c.serverRiskClass,
    approvalPolicy: c.approvalPolicy,
    requiredCapability: c.requiredCapability,
    deprecationStatus: c.deprecationStatus,
  };
}

function summariseCapability(c: { capabilityId: string; version: string; name: string; category: string; availabilityStatus: string; healthStatus: string; trustLevel: string; supportedCommands: string[] }) {
  return {
    capabilityId: c.capabilityId,
    version: c.version,
    name: c.name,
    category: c.category,
    availabilityStatus: c.availabilityStatus,
    healthStatus: c.healthStatus,
    trustLevel: c.trustLevel,
    supportedCommands: c.supportedCommands,
  };
}
