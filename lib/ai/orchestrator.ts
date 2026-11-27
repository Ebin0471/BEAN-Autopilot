import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import { AuditService } from "@/lib/security/audit";
import { PolicyEngine } from "@/lib/security/policy";
import type { CommandGateway, CommandOutcome } from "@/lib/commands/gateway";
import type { CommandRegistry } from "@/lib/commands/registry";
import type { CapabilityRegistry } from "@/lib/commands/capability";
import type { AgentRegistry } from "./agents";
import type { PlanningEngine } from "./planning";
import type { ModelRouter } from "./routing";
import type { ProviderRegistry } from "./provider-registry";
import type { ModelRegistry } from "./model-registry";
import type { ConversationService } from "./conversation";
import type { IntentEngine } from "./intent";
import type { ContextAssembler } from "./context";
import type {
  AgentResult,
  DelegationEnvelope,
  Intent,
  TaskPlan,
} from "./types";

export class OrchestrationError extends Error {
  constructor(message: string, public code = "ORCHESTRATION_ERROR") {
    super(message);
    this.name = "OrchestrationError";
  }
}

/** Bounded delegation limits (prevent unlimited recursive spawning). */
const MAX_DELEGATION_DEPTH = 3;
const MAX_ACTIVE_AGENTS_PER_TASK = 4;
const MAX_SUBTASKS = 8;
const MAX_MODEL_CALLS = 12;

/**
 * Universal Agent Orchestrator.
 *
 * The central coordinator. It receives a structured intent, assembles
 * authorised context, produces a plan, identifies required agents/commands,
 * validates permissions, determines approval requirements, delegates permitted
 * subtasks to registered agents, and executes approved operations ONLY through
 * the CORE-02 Command Gateway. It never calls external tools directly, never
 * bypasses the gateway, and never invents successful results.
 *
 * The orchestrator produces honest statuses and evidence-backed output.
 */
export class AgentOrchestrator {
  constructor(
    private db: Db,
    private audit: AuditService,
    private gateway: CommandGateway,
    private commands: CommandRegistry,
    private capabilities: CapabilityRegistry,
    private agents: AgentRegistry,
    private planner: PlanningEngine,
    private router: ModelRouter,
    private providers: ProviderRegistry,
    private models: ModelRegistry,
    private conversations: ConversationService,
    private intentEngine: IntentEngine,
    private context: ContextAssembler,
    private policy: PolicyEngine,
  ) {}

  /**
   * Run a full governed turn for a user message:
   * understand intent → assemble context → propose plan → (if approved and
   * safe) execute permitted commands via the gateway → produce a response.
   *
   * By default this PROPOSES a plan and executes only R0/R1 read-only internal
   * commands that do not require approval. Consequential commands are left
   * AWAITING_APPROVAL for a human. The model never decides authorisation.
   */
  async handleTurn(input: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    message: string;
    autoExecuteSafe?: boolean;
  }): Promise<{
    intent: Intent;
    plan: TaskPlan;
    executions: CommandOutcome[];
    response: string;
    status: string;
    limitations: string[];
  }> {
    const limitations: string[] = [];

    // 1. Understand intent (structured, validated).
    const intent = await this.intentEngine.recognise({
      requestText: input.message,
      workspaceId: input.workspaceId,
    });

    // 2. Assemble permission-aware context.
    const ctx = this.context.assemble({
      workspaceId: input.workspaceId,
      userId: input.userId,
      intent,
    });

    // 3. Propose a plan (inspectable; the planner never executes).
    const plan = await this.planner.propose({
      intent,
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: input.conversationId,
      context: ctx,
    });

    const executions: CommandOutcome[] = [];

    // 4. Execute only permitted, approval-free, read-only commands through the
    //    CORE-02 gateway. Consequential commands require human approval and are
    //    left AWAITING_APPROVAL — the orchestrator never auto-approves.
    const autoExecute = input.autoExecuteSafe ?? true;
    for (const task of plan.tasks) {
      if (task.approvalRequired || task.riskClass !== "R0" && task.riskClass !== "R1") {
        limitations.push(
          `Task "${task.description}" (${task.riskClass}) requires human approval and was not executed.`,
        );
        continue;
      }
      if (!autoExecute) {
        limitations.push(`Task "${task.description}" was proposed but not executed.`);
        continue;
      }
      for (const commandId of task.candidateCommandIds) {
        const outcome = await this.executeCommandViaGateway({
          workspaceId: input.workspaceId,
          userId: input.userId,
          commandId,
          args: {},
          idempotencyKey: `${plan.planId}:${task.taskId}:${commandId}`,
        });
        executions.push(outcome);
      }
    }

    // 5. Determine final status honestly.
    const anyVerified = executions.some((e) => e.status === "VERIFIED");
    const anyBlocked = executions.some((e) => e.status === "BLOCKED");
    const status = anyVerified && !anyBlocked
      ? "VERIFIED"
      : anyBlocked
        ? "PARTIAL"
        : "PROPOSED";

    // 6. Produce an evidence-backed response.
    const response = this.composeResponse(intent, plan, executions, limitations);

    this.planner.updateStatus(plan.planId, status as TaskPlan["status"]);

    this.audit.append({
      workspaceId: input.workspaceId,
      actorId: input.userId,
      actorType: "USER",
      eventType: "AGENT_TURN",
      targetType: "plan",
      targetId: plan.planId,
      result: status === "VERIFIED" ? "SUCCESS" : "FAILURE",
      metadata: {
        taskCategory: intent.taskCategory,
        executions: executions.length,
        limitations: limitations.length,
      },
    });

    return { intent, plan, executions, response, status, limitations };
  }

  /**
   * Execute a single command through the CORE-02 gateway. The gateway enforces
   * identity, workspace, permissions, risk, capability, passport and lifecycle.
   * The orchestrator supplies only the command request — never risk, permissions,
   * approval, adapter or authorisation choices.
   */
  private async executeCommandViaGateway(input: {
    workspaceId: string;
    userId: string;
    commandId: string;
    args: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<CommandOutcome> {
    return this.gateway.submit(
      {
        commandId: input.commandId,
        workspaceId: input.workspaceId,
        args: input.args,
        idempotencyKey: input.idempotencyKey,
      },
      { userId: input.userId, workspaceId: input.workspaceId },
    );
  }

  /**
   * Delegate a subtask to a registered agent within a bounded envelope. The
   * delegated agent inherits a RESTRICTIVE permission scope: it cannot change
   * workspace, add permissions, request broader authority, reassign to an
   * untrusted agent, access unrelated conversations, or read unrelated
   * documents.
   */
  delegate(input: {
    workspaceId: string;
    userId: string;
    parentTaskId: string | null;
    agentId: string;
    objective: string;
    allowedCommands: string[];
    depth: number;
  }): { envelope: DelegationEnvelope; allowed: boolean; reason?: string } {
    if (input.depth > MAX_DELEGATION_DEPTH) {
      return {
        envelope: this.emptyEnvelope(input),
        allowed: false,
        reason: `Delegation depth ${input.depth} exceeds the maximum of ${MAX_DELEGATION_DEPTH}.`,
      };
    }

    const def = this.agents.get(input.agentId);
    if (!def) {
      return { envelope: this.emptyEnvelope(input), allowed: false, reason: "Unknown agent." };
    }
    if (!this.agents.canAcceptTask(input.agentId, this.workspaceType(input.workspaceId))) {
      return {
        envelope: this.emptyEnvelope(input),
        allowed: false,
        reason: `Agent ${input.agentId} is not enabled for this workspace.`,
      };
    }

    // Resolve the caller's effective permissions (deny-by-default).
    const eff = this.effectivePermissions(input.userId, input.workspaceId);
    const scopeCheck = this.agents.validateDelegationScope(
      input.agentId,
      input.allowedCommands,
      eff,
    );
    if (!scopeCheck.ok) {
      return { envelope: this.emptyEnvelope(input), allowed: false, reason: scopeCheck.reason };
    }

    // Risk ceiling: the agent cannot exceed its own risk constraints.
    const riskCeiling = def.riskConstraints[def.riskConstraints.length - 1] ?? "R2";

    const envelope: DelegationEnvelope = {
      parentTaskId: input.parentTaskId,
      childTaskId: uuid(),
      initiatingUserId: input.userId,
      workspaceId: input.workspaceId,
      objective: input.objective,
      allowedContext: ["workspace.metadata", "command.registry"],
      allowedCommands: input.allowedCommands.filter((c) =>
        def.allowedCommandIds.includes(c),
      ),
      permissionScope: def.requiredPermissions,
      capabilityConstraints: def.requiredCapabilities,
      riskCeiling,
      deadline: null,
      maximumSteps: def.maximumSteps,
      expectedResultSchema: def.outputSchema,
      verificationRequirements: def.verificationRequirements,
      depth: input.depth,
    };

    return { envelope, allowed: true };
  }

  /**
   * Validate an agent result against its expected schema and the delegation
   * envelope. Rejects malformed, unsupported or unauthorised results. Agent
   * output is treated as untrusted until validated.
   */
  validateAgentResult(
    envelope: DelegationEnvelope,
    result: AgentResult,
  ): { valid: boolean; reason?: string } {
    if (result.taskId !== envelope.childTaskId) {
      return { valid: false, reason: "Result task id does not match the delegation." };
    }
    // The agent must not have executed commands outside its allowed set.
    const unauthorised = result.executedOperations.filter(
      (op) => !envelope.allowedCommands.includes(op),
    );
    if (unauthorised.length > 0) {
      return {
        valid: false,
        reason: `Agent executed operations outside its delegated scope: ${unauthorised.join(", ")}`,
      };
    }
    // Passport references must exist (evidence of governed execution).
    // (The gateway already enforces passports; here we require the agent to
    // report them honestly for reconciliation.)
    if (result.success && result.executedOperations.length > 0 && result.passportReferences.length === 0) {
      return {
        valid: false,
        reason: "Agent reported executed operations without passport references.",
      };
    }
    return { valid: true };
  }

  private emptyEnvelope(input: {
    workspaceId: string;
    userId: string;
    parentTaskId: string | null;
    agentId: string;
    objective: string;
    depth: number;
  }): DelegationEnvelope {
    return {
      parentTaskId: input.parentTaskId,
      childTaskId: uuid(),
      initiatingUserId: input.userId,
      workspaceId: input.workspaceId,
      objective: input.objective,
      allowedContext: [],
      allowedCommands: [],
      permissionScope: [],
      capabilityConstraints: [],
      riskCeiling: "R0",
      deadline: null,
      maximumSteps: 0,
      expectedResultSchema: {},
      verificationRequirements: [],
      depth: input.depth,
    };
  }

  private composeResponse(
    intent: Intent,
    plan: TaskPlan,
    executions: CommandOutcome[],
    limitations: string[],
  ): string {
    const lines: string[] = [];
    lines.push(`Understood: ${intent.desiredOutcome}`);
    lines.push(`Planned ${plan.tasks.length} step(s) (complexity: ${plan.estimatedComplexity}).`);
    const verified = executions.filter((e) => e.status === "VERIFIED");
    if (verified.length > 0) {
      lines.push(`Executed ${verified.length} permitted command(s) through the governed gateway.`);
    }
    if (plan.approvalRequirements.length > 0) {
      lines.push(`Awaiting human approval for: ${plan.approvalRequirements.join("; ")}.`);
    }
    for (const l of limitations) {
      lines.push(`Note: ${l}`);
    }
    if (intent.requiresClarification && intent.missingInformation.length > 0) {
      lines.push(`Clarification needed: ${intent.missingInformation.join("; ")}.`);
    }
    return lines.join("\n");
  }

  private workspaceType(workspaceId: string): string {
    const row = this.db
      .prepare("SELECT kind FROM workspaces WHERE id = ?")
      .get(workspaceId) as { kind: string } | undefined;
    return row?.kind ?? "PERSONAL";
  }

  private effectivePermissions(userId: string, workspaceId: string): string[] {
    // Reuse the CORE-01 policy engine (deny-by-default). The orchestrator only
    // reads the resolved permission set; it never grants authority.
    const eff = this.policy.resolve(userId, workspaceId);
    return eff?.permissions ?? [];
  }
}

export { MAX_DELEGATION_DEPTH, MAX_ACTIVE_AGENTS_PER_TASK, MAX_SUBTASKS, MAX_MODEL_CALLS, now };
