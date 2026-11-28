import type { Db } from "@/lib/db/database";
import { computeBindingHash, canonicalBinding, canonicalize, IdempotencyConflictError } from "./canonical";
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

/**
 * Raised when a gateway-bounded execution phase (prepare / execute / verify)
 * exceeds its effective timeout. The gateway aborts the phase's AbortSignal so
 * a cooperative adapter can stop, but it never assumes the adapter actually
 * stopped — an uncertain external side effect is recorded as an honest
 * unresolved (PARTIAL) outcome, never as a success.
 */
export class PhaseTimeoutError extends Error {
  constructor(public phase: "prepare" | "execute" | "verify", public ms: number) {
    super(`${phase} phase timed out after ${ms}ms`);
    this.name = "PhaseTimeoutError";
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

    // 8. Create / check Action Passport bound to the FULL payload. The passport
    //    service compares the complete canonical binding before reusing an
    //    existing passport and raises an explicit conflict otherwise.
    let passport;
    try {
      passport = this.passport.createRequest(
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
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return this.conflict(actor, request, command, capabilityId, paramsHash, e);
      }
      throw e;
    }

    // 9. Execution lifecycle record. The lifecycle manager compares the
    //    complete canonical request hash before reusing an existing execution
    //    and raises an explicit conflict for a mismatched payload.
    let execution;
    try {
      execution = this.lifecycle.create({
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
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return this.conflict(actor, request, command, capabilityId, paramsHash, e);
      }
      throw e;
    }
    if (isTerminalState(execution.status)) {
      return this.outcomeFromRecord(execution, command, riskClass, capabilityId, paramsHash);
    }

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

  /**
   * Execute an authorised command (internal registry ops or a registered
   * adapter). Adapter-backed commands follow:
   *   VALIDATE → AUTHORISE → PREPARE → EXECUTE → VERIFY → VERIFIED / PARTIAL / FAILED
   * where VERIFY is the adapter's authoritative `verify()` result — never
   * `Boolean(result.evidence)`. Each phase is bounded by the effective timeout
   * `min(command.timeoutPolicy.maxSeconds, adapter.timeoutSeconds)` and uses
   * cooperative cancellation through an AbortSignal.
   */
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
    } catch {
      this.lifecycle.transition(executionId, "FAILED", { errorCode: "PASSPORT_INVALID" });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", "Passport validation failed", "PASSPORT_INVALID");
    }

    // Resolve the adapter and enforce the declared verification capability
    // BEFORE execution. A required verification method the adapter cannot
    // provide fails closed here, before any external side effect.
    let adapter: CommandAdapter | undefined;
    let effectiveMs: number | null = null;
    if (capabilityId) {
      adapter = this.findAdapter(command.commandId);
      if (!adapter) {
        this.lifecycle.transition(executionId, "FAILED", { errorCode: "ADAPTER_UNAVAILABLE" });
        return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", "No adapter registered for capability", "ADAPTER_UNAVAILABLE");
      }
      effectiveMs = this.effectiveTimeoutMs(command, adapter);
      if (effectiveMs === null) {
        this.lifecycle.transition(executionId, "FAILED", { errorCode: "TIMEOUT_INVALID" });
        return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", "Command or adapter timeout is not a positive value", "TIMEOUT_INVALID");
      }
      if (this.requiresVerification(command) && !adapter.supportsVerification) {
        this.lifecycle.transition(executionId, "FAILED", { errorCode: "VERIFICATION_UNSUPPORTED" });
        this.auditVerification(actor, executionId, command, "VERIFICATION_UNSUPPORTED", "pre-execution");
        return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", "Adapter cannot provide the required verification", "VERIFICATION_UNSUPPORTED");
      }
    }

    this.lifecycle.transition(executionId, "VALIDATED");
    this.lifecycle.transition(executionId, "AUTHORISED");
    this.lifecycle.transition(executionId, "READY");
    this.lifecycle.transition(executionId, "RUNNING", { adapterId: capabilityId ?? "internal" });

    const capability = capabilityId ? this.capabilities.get(capabilityId) ?? null : null;
    const baseCtx = {
      workspaceId: actor.workspaceId,
      command,
      capability,
      args,
      targetType: request.targetType,
      targetId: request.targetId,
    };

    let result: AdapterResult;
    if (capabilityId && adapter && effectiveMs !== null) {
      // PREPARE (bounded). A prepare timeout must prevent execution from
      // beginning; the external outcome is uncertain so it is recorded as an
      // honest unresolved PARTIAL, never a success.
      try {
        await this.withTimeout((signal) => adapter!.prepare({ ...baseCtx, signal }), effectiveMs, "prepare");
      } catch (e) {
        return this.phaseFailure(executionId, command, riskClass, capabilityId, passport, paramsHash, actor, "prepare", e);
      }
      // EXECUTE (bounded).
      try {
        result = await this.withTimeout((signal) => adapter!.execute({ ...baseCtx, passportId, paramsHash, signal }), effectiveMs, "execute");
      } catch (e) {
        return this.phaseFailure(executionId, command, riskClass, capabilityId, passport, paramsHash, actor, "execute", e);
      }
    } else {
      result = this.executeInternal(command, actor, args, request);
    }

    if (!result.success) {
      this.lifecycle.transition(executionId, "FAILED", { errorCode: result.errorCode ?? "EXECUTION_FAILED", result: result.output });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "FAILED", "Execution failed", result.errorCode ?? "EXECUTION_FAILED", result.output);
    }

    // VERIFY (bounded). Adapter-backed commands use the adapter's authoritative
    // verify() decision; internal commands use result_validation only.
    this.lifecycle.transition(executionId, "VERIFYING");
    if (!capabilityId || !adapter || effectiveMs === null) {
      if (result.success) {
        this.lifecycle.transition(executionId, "VERIFIED", { result: result.output, evidence: { type: "result_validation", executionId } });
        return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "VERIFIED", "Command verified", undefined, result.output, { type: "result_validation", executionId });
      }
      this.lifecycle.transition(executionId, "PARTIAL", { result: result.output, errorCode: "VERIFICATION_FAILED" });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "PARTIAL", "Internal command did not succeed", "VERIFICATION_FAILED", result.output, null);
    }

    // A manual-verification contract must never silently become an automatic
    // VERIFIED result.
    if (command.verificationContract.type === "manual") {
      this.lifecycle.transition(executionId, "PARTIAL", { result: result.output, errorCode: "VERIFICATION_MANUAL_REQUIRED" });
      this.auditVerification(actor, executionId, command, "VERIFICATION_MANUAL_REQUIRED", "verify");
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "PARTIAL", "Manual verification is required; automatic verification not claimed", "VERIFICATION_MANUAL_REQUIRED", result.output, null);
    }

    try {
      const verification = await this.withTimeout((signal) => adapter!.verify({ ...baseCtx, passportId, paramsHash, signal }, result), effectiveMs, "verify");
      const evidence = verification.evidence;
      if (!verification.verified) {
        const stored = isPlainObject(evidence) ? evidence : null;
        this.lifecycle.transition(executionId, "PARTIAL", { result: result.output, evidence: stored, errorCode: "VERIFICATION_FAILED" });
        this.auditVerification(actor, executionId, command, "VERIFICATION_FAILED", "verify");
        return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "PARTIAL", verification.reason ?? "Adapter verification reported not verified", "VERIFICATION_FAILED", result.output, stored);
      }
      if (!isValidVerificationEvidence(evidence)) {
        this.lifecycle.transition(executionId, "PARTIAL", { result: result.output, evidence: null, errorCode: "VERIFICATION_EVIDENCE_INVALID" });
        this.auditVerification(actor, executionId, command, "VERIFICATION_EVIDENCE_INVALID", "verify");
        return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "PARTIAL", "Verification evidence is missing, empty or malformed", "VERIFICATION_EVIDENCE_INVALID", result.output, null);
      }
      this.lifecycle.transition(executionId, "VERIFIED", { result: result.output, evidence });
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "VERIFIED", "Command verified", undefined, result.output, evidence);
    } catch (e) {
      const timedOut = e instanceof PhaseTimeoutError;
      const code = timedOut ? "VERIFICATION_TIMEOUT" : "VERIFICATION_ERROR";
      this.lifecycle.transition(executionId, "PARTIAL", { result: result.output, errorCode: code });
      this.auditVerification(actor, executionId, command, code, "verify");
      return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "PARTIAL", timedOut ? "Verification timed out" : "Verification could not complete", code, result.output, null);
    }
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

  /* ---------------- Verification & timeout helpers ---------------- */

  /**
   * Whether the command requires automatic verification. A `manual` contract
   * without an independent check does not require automatic verification (and
   * must never be reported as auto-verified); any other contract type, or an
   * independent check, does.
   */
  private requiresVerification(command: CommandDefinition): boolean {
    const c = command.verificationContract;
    return c.type !== "manual" || c.independentCheck;
  }

  /**
   * Effective bounded execution time in ms: the stricter valid limit of the
   * command's timeout policy and the adapter's declared timeout. Returns null
   * when either value is not a positive finite number (validated before use).
   */
  private effectiveTimeoutMs(command: CommandDefinition, adapter: CommandAdapter): number | null {
    const a = command.timeoutPolicy.maxSeconds;
    const b = adapter.timeoutSeconds;
    if (!isPositiveNumber(a) || !isPositiveNumber(b)) return null;
    return Math.min(a, b) * 1000;
  }

  /**
   * Run a phase promise under a bounded timeout. On timeout the phase's
   * AbortSignal is aborted (so a cooperative adapter can observe cancellation)
   * and the promise rejects with a PhaseTimeoutError. Timers are cleaned up on
   * every completion path. The gateway never assumes the adapter stopped just
   * because the phase timed out.
   */
  private withTimeout<T>(
    op: (signal: AbortSignal) => Promise<T>,
    ms: number,
    phase: "prepare" | "execute" | "verify",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new PhaseTimeoutError(phase, ms));
      }, ms);
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      Promise.resolve()
        .then(() => op(controller.signal))
        .then(
          (value) => finish(() => resolve(value)),
          (err) => finish(() => reject(err)),
        );
    });
  }

  /**
   * Honest unresolved outcome for a prepare/execute phase that failed or
   * timed out. The external outcome is uncertain, so it is recorded as PARTIAL
   * (never a false success) with a stable, specific error code. No automatic
   * retry is attempted.
   */
  private phaseFailure(
    executionId: string,
    command: CommandDefinition,
    riskClass: RiskClass,
    capabilityId: string | null,
    passport: { id: string; status: PassportState } | null | undefined,
    paramsHash: string,
    actor: { userId: string; workspaceId: string },
    phase: "prepare" | "execute",
    err: unknown,
  ): CommandOutcome {
    const timedOut = err instanceof PhaseTimeoutError;
    const label = phase === "execute" ? "EXECUTION" : "PREPARE";
    const code = timedOut ? `${label}_TIMEOUT` : `${label}_ERROR`;
    this.lifecycle.transition(executionId, "PARTIAL", { errorCode: code });
    this.auditVerification(actor, executionId, command, code, phase);
    const message = timedOut
      ? `${phase} timed out; external outcome is uncertain and unresolved`
      : `${phase} failed`;
    return this.outcome(executionId, command, riskClass, capabilityId, passport, paramsHash, "PARTIAL", message, code);
  }

  /** Append a verification/timeout audit event (stable code, no secrets). */
  private auditVerification(
    actor: { userId: string; workspaceId: string },
    executionId: string,
    command: CommandDefinition,
    code: string,
    phase: string,
  ): void {
    this.audit.append({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      actorType: "USER",
      eventType: "COMMAND_VERIFICATION",
      targetType: "execution",
      targetId: executionId,
      result: "FAILURE",
      metadata: { commandId: command.commandId, code, phase },
    });
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
    command: CommandDefinition | null,
    capabilityId: string | null,
    request: CommandRequest,
    args?: Record<string, unknown>,
  ): { hash: string; canonical: string } {
    // When the command could not be resolved (e.g. a blocked unknown command),
    // fall back to the raw request identity so different requests still produce
    // distinct canonical payloads.
    const fields = {
      workspaceId,
      commandId: command ? command.commandId : request.commandId,
      commandVersion: command ? command.version : (request.version ?? "0.0.0"),
      capabilityId,
      capabilityVersion: capabilityId ? "1.0.0" : null,
      targetType: request.targetType ?? (command ? command.targetRequirements.type : undefined) ?? "none",
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
    // Always compute a canonical binding hash (even for an unresolved command)
    // so a reused idempotency key with a different payload is detected.
    const paramsHash = this.computeBinding(actor.workspaceId, command, capabilityId, request).hash;
    let execution;
    try {
      execution = this.lifecycle.create({
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
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return this.conflict(actor, request, command, capabilityId, paramsHash, e);
      }
      throw e;
    }
    // Idempotent replay of an already-blocked execution: do not attempt the
    // invalid BLOCKED -> BLOCKED transition; return the stored outcome.
    if (execution.status === "BLOCKED") {
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
        errorCode: execution.error_code ?? code,
        message: "Idempotent replay of a blocked execution",
      };
    }
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

  /**
   * Explicit idempotency-conflict outcome. The idempotency key already belongs
   * to a DIFFERENT canonical request; the prior execution/passport is never
   * returned. Audited as a blocked command with the conflict code.
   */
  private conflict(
    actor: { userId: string; workspaceId: string },
    request: CommandRequest,
    command: CommandDefinition | null,
    capabilityId: string | null,
    paramsHash: string,
    e: IdempotencyConflictError,
  ): CommandOutcome {
    const commandId = command?.commandId ?? request.commandId;
    const commandVersion = command?.version ?? "0.0.0";
    this.audit.append({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      actorType: "USER",
      eventType: "COMMAND_BLOCKED",
      targetType: "execution",
      targetId: "idempotency",
      result: "DENIED",
      metadata: { commandId, code: "IDEMPOTENCY_CONFLICT", idempotencyKey: request.idempotencyKey },
    });
    return {
      executionId: "",
      commandId,
      commandVersion,
      status: "BLOCKED",
      riskClass: command ? this.resolveRisk(command) : "R2",
      capabilityId,
      passportId: null,
      passportStatus: null,
      paramsHash,
      errorCode: "IDEMPOTENCY_CONFLICT",
      message: e.message,
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
    record: {
      id: string;
      status: ExecutionState;
      command_id: string;
      command_version: string;
      capability_id: string | null;
      passport_id: string | null;
      params_hash: string;
      result: string | null;
      evidence: string | null;
      error_code: string | null;
    },
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
      passportId: record.passport_id ?? null,
      passportStatus: null,
      paramsHash: record.params_hash || paramsHash,
      result: record.result ? safeJsonParse(record.result) : undefined,
      evidence: record.evidence ? safeJsonParse(record.evidence) : undefined,
      errorCode: record.error_code ?? undefined,
      message: "Idempotent replay of a completed execution",
    };
  }
}

function isTerminalState(state: ExecutionState): boolean {
  // PARTIAL is a completed (unresolved) outcome: a replay must never
  // re-execute or re-verify it.
  return state === "VERIFIED" || state === "PARTIAL" || state === "FAILED" || state === "CANCELLED" || state === "COMPENSATED";
}

/** True when a value is a finite number strictly greater than zero. */
function isPositiveNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** True when a value is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Verification evidence must be a non-empty, serialisable object. Malformed,
 * non-serialisable or empty evidence is rejected as proof of a verified outcome
 * (an adapter returning `verified: true` with empty evidence is NOT VERIFIED).
 */
function isValidVerificationEvidence(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length === 0) return false;
  try {
    canonicalize(value);
    return true;
  } catch {
    return false;
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
