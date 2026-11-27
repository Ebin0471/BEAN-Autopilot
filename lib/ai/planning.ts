import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import type { ProviderRegistry } from "./provider-registry";
import type { ModelRegistry } from "./model-registry";
import type { ModelRouter } from "./routing";
import type { CommandRegistry } from "@/lib/commands/registry";
import type { CapabilityRegistry } from "@/lib/commands/capability";
import { PolicyEngine } from "@/lib/security/policy";
import { RiskClassifier } from "@/lib/security/risk";
import { z } from "zod";
import type { ContextBundle, Intent, RoutingConstraints, TaskPlan, PlanTask } from "./types";

export class PlanningError extends Error {
  constructor(message: string, public code = "PLANNING_ERROR") {
    super(message);
    this.name = "PlanningError";
  }
}

/** Strict schema for the model's structured plan proposal (untrusted input). */
const PlanTaskSchema = z.object({
  description: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  parallelisable: z.boolean().default(false),
  requiredAgentId: z.string().nullable().default(null),
  candidateCommandIds: z.array(z.string()).default([]),
  requiredCapabilities: z.array(z.string()).default([]),
  permissionRequirements: z.array(z.string()).default([]),
  riskClass: z.enum(["R0", "R1", "R2", "R3", "R4"]),
  approvalRequired: z.boolean(),
  expectedOutput: z.string().min(1),
  verificationCriteria: z.array(z.string()).default([]),
  humanCheckpoint: z.boolean().default(false),
});

const PlanSchema = z.object({
  objective: z.string().min(1),
  tasks: z.array(PlanTaskSchema).min(1),
  requiredAgents: z.array(z.string()).default([]),
  requiredCapabilities: z.array(z.string()).default([]),
  expectedOutputs: z.array(z.string()).default([]),
  verificationCriteria: z.array(z.string()).default([]),
  estimatedComplexity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  unresolvedQuestions: z.array(z.string()).default([]),
});

/**
 * Task Planning Engine.
 *
 * Converts a validated intent into a structured, inspectable proposed plan.
 * Uses a reasoning-capable model to propose tasks, then validates every
 * candidate command id against the Command Registry (unknown commands are
 * rejected) and computes the permission/risk requirements server-side.
 *
 * The planner NEVER executes actions itself — it produces an inspectable plan
 * with a clear status lifecycle (PROPOSED → … → VERIFIED).
 */
export class PlanningEngine {
  constructor(
    private db: Db,
    private router: ModelRouter,
    private providers: ProviderRegistry,
    private models: ModelRegistry,
    private commands: CommandRegistry,
    private capabilities: CapabilityRegistry,
    private policy: PolicyEngine,
    private risk: RiskClassifier,
  ) {}

  /**
   * Propose a plan for an intent. Throws PlanningError when no model is
   * available or the plan is invalid (unknown commands, malformed output).
   */
  async propose(input: {
    intent: Intent;
    workspaceId: string;
    userId: string;
    conversationId: string;
    context?: ContextBundle;
  }): Promise<TaskPlan> {
    const constraints: RoutingConstraints = {
      // Planning is itself a PLANNING-class task: route to a reasoning model.
      taskCategory: "PLANNING",
      requiredModalities: ["text", "structured"],
      requireStructuredOutput: true,
      requireReasoning: true,
      requireToolCall: false,
      privacyClass: sensitivityToPrivacy(input.intent.sensitivityClassification),
    };

    const decision = this.router.route(constraints);
    const adapter = this.providers.adapterFor(decision.providerId);
    if (!adapter) {
      throw new PlanningError(
        `No adapter available for provider ${decision.providerId}.`,
        "NO_PROVIDER_ADAPTER",
      );
    }

    const contextHint = JSON.stringify({
      objective: input.intent.desiredOutcome,
      requestedActions: input.intent.requestedActions,
      requiredCapabilities: input.intent.requiredCapabilities,
      ambiguity: input.intent.ambiguityList,
      availableContext: input.context
        ? {
            commands: input.context.commands.map((c) => c.commandId),
            capabilities: input.context.capabilities.map((c) => c.capabilityId),
            models: input.context.models.map((m) => m.modelId),
            tokenEstimate: input.context.tokenEstimate,
            sourcesCount: input.context.sources.length,
          }
        : null,
    });

    const response = await adapter.generate({
      requestId: uuid(),
      modelId: decision.modelId,
      messages: [
        {
          role: "system",
          content:
            "You are BEAN Autopilot's task planner. Respond ONLY with a JSON object matching the plan schema. Propose a sequence of tasks with dependencies, candidate COMMAND ids that must already exist in the registered command catalogue, permission requirements, risk class and verification criteria. Do not invent commands. If information is missing, list it in unresolvedQuestions.",
        },
        { role: "user", content: contextHint },
      ],
      taskCategory: input.intent.taskCategory,
      responseSchema: { type: "object" },
    });

    if (response.error || !response.structured || typeof response.structured !== "object") {
      throw new PlanningError(
        "Model did not return a valid structured plan.",
        "INVALID_PLAN_OUTPUT",
      );
    }

    const parsed = PlanSchema.safeParse(response.structured);
    if (!parsed.success) {
      throw new PlanningError(
        `Plan output failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        "INVALID_PLAN_OUTPUT",
      );
    }
    const data = parsed.data;

    // Validate candidate command ids against the registry (fail-closed).
    const knownCommands = new Set(this.commands.list().map((c) => c.commandId));
    const tasks: PlanTask[] = data.tasks.map((t, i) => {
      const unknown = t.candidateCommandIds.filter((id) => !knownCommands.has(id));
      if (unknown.length > 0) {
        throw new PlanningError(
          `Plan references unknown command(s): ${unknown.join(", ")}.`,
          "UNKNOWN_COMMAND_IN_PLAN",
        );
      }
      // Resolve permissions/risk from the actual command definitions.
      const perms = new Set<string>();
      let maxRisk = "R0" as PlanTask["riskClass"];
      for (const cid of t.candidateCommandIds) {
        const def = this.commands.get(cid);
        if (def) {
          for (const p of def.requiredPermissions) perms.add(p);
          maxRisk = higherRisk(maxRisk, def.serverRiskClass as PlanTask["riskClass"]);
        }
      }
      return {
        taskId: `t${i + 1}`,
        description: t.description,
        dependsOn: t.dependsOn,
        parallelisable: t.parallelisable,
        requiredAgentId: t.requiredAgentId,
        candidateCommandIds: t.candidateCommandIds,
        requiredCapabilities: t.requiredCapabilities,
        permissionRequirements: [...perms, ...t.permissionRequirements],
        riskClass: t.riskClass,
        approvalRequired:
          t.approvalRequired || this.risk.policyFor(t.riskClass).approvalRequired,
        expectedOutput: t.expectedOutput,
        verificationCriteria: t.verificationCriteria,
        humanCheckpoint: t.humanCheckpoint,
      };
    });

    const allCommands = new Set(tasks.flatMap((t) => t.candidateCommandIds));
    const allCaps = new Set(tasks.flatMap((t) => t.requiredCapabilities));
    const allPerms = new Set(tasks.flatMap((t) => t.permissionRequirements));

    const plan: TaskPlan = {
      planId: uuid(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      objective: data.objective,
      tasks,
      requiredAgents: data.requiredAgents,
      requiredCapabilities: [...allCaps, ...data.requiredCapabilities],
      candidateCommands: [...allCommands],
      permissionRequirements: [...allPerms],
      riskClassification: tasks.reduce(
        (acc, t) => higherRisk(acc, t.riskClass),
        "R0" as PlanTask["riskClass"],
      ),
      approvalRequirements: tasks
        .filter((t) => t.approvalRequired)
        .map((t) => `${t.taskId}: ${t.description}`),
      expectedOutputs: data.expectedOutputs,
      verificationCriteria: data.verificationCriteria,
      estimatedComplexity: data.estimatedComplexity,
      unresolvedQuestions: [...data.unresolvedQuestions, ...input.intent.ambiguityList],
      status: "PROPOSED",
    };

    this.persist(plan);
    return plan;
  }

  get(planId: string): TaskPlan | null {
    const row = this.db
      .prepare("SELECT plan_json FROM plans WHERE id = ?")
      .get(planId) as { plan_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.plan_json) as TaskPlan;
  }

  updateStatus(planId: string, status: TaskPlan["status"]): void {
    this.db
      .prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now(), planId);
  }

  private persist(plan: TaskPlan): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO plans (id, conversation_id, workspace_id, objective, plan_json, risk_class, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        plan.planId,
        plan.conversationId,
        plan.workspaceId,
        plan.objective,
        JSON.stringify(plan),
        plan.riskClassification,
        plan.status,
        ts,
        ts,
      );
  }
}

function higherRisk(a: string, b: string): string {
  const rank = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 } as const;
  return (rank[a as keyof typeof rank] ?? 0) >= (rank[b as keyof typeof rank] ?? 0)
    ? a
    : b;
}

function sensitivityToPrivacy(s: string): "INTERNAL" | "LOCAL" | "EXTERNAL" {
  if (s === "PUBLIC") return "EXTERNAL";
  return "INTERNAL";
}
