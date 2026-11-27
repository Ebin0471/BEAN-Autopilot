import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import type { CommandRegistry } from "@/lib/commands/registry";
import { PolicyEngine } from "@/lib/security/policy";
import type { AgentDefinition, AgentLifecycleStatus } from "./types";

export class AgentRegistryError extends Error {
  constructor(message: string, public code = "AGENT_ERROR") {
    super(message);
    this.name = "AgentRegistryError";
  }
}

/**
 * Agent Registry.
 *
 * Typed, versioned runtime registration of agents. Only trusted server-side
 * registration can enable agents; an agent cannot self-register with elevated
 * privileges. Agent versions are explicit, unknown command references are
 * rejected, invalid schemas are rejected, disabled agents cannot receive new
 * tasks, and agents cannot expand user permissions.
 *
 * This is the RUNTIME foundation. DOC-02 (the 117-agent workforce archive)
 * remains incomplete — only the minimum genuine system-level orchestration
 * component is registered here. No specialist agents are fabricated.
 */
export class AgentRegistry {
  private definitions = new Map<string, AgentDefinition>();

  constructor(
    private db: Db,
    private commands: CommandRegistry,
    private policy: PolicyEngine,
  ) {}

  /**
   * Register (or update) an agent definition. Validates command references
   * against the Command Registry and schema shape. Server-side only.
   */
  register(def: AgentDefinition): AgentDefinition {
    // Reject unknown command references (fail-closed).
    for (const cid of def.allowedCommandIds) {
      if (!this.commands.get(cid)) {
        throw new AgentRegistryError(
          `Agent "${def.agentId}" references unknown command "${cid}".`,
          "UNKNOWN_COMMAND_IN_AGENT",
        );
      }
    }
    // Reject schemas that are not plain objects.
    if (
      typeof def.inputSchema !== "object" ||
      def.inputSchema === null ||
      Array.isArray(def.inputSchema)
    ) {
      throw new AgentRegistryError(
        `Agent "${def.agentId}" has an invalid inputSchema.`,
        "INVALID_AGENT_SCHEMA",
      );
    }
    if (
      typeof def.outputSchema !== "object" ||
      def.outputSchema === null ||
      Array.isArray(def.outputSchema)
    ) {
      throw new AgentRegistryError(
        `Agent "${def.agentId}" has an invalid outputSchema.`,
        "INVALID_AGENT_SCHEMA",
      );
    }

    const ts = now();
    // Determine existence against the DB BEFORE caching in-memory, otherwise
    // get() would always find the just-set cache entry and skip the INSERT.
    const existing = this.get(def.agentId);
    this.definitions.set(def.agentId, def);
    if (existing) {
      this.db
        .prepare(
          `UPDATE agents SET name = ?, version = ?, description = ?, category = ?, supported_workspace_types = ?,
             allowed_command_ids = ?, required_permissions = ?, required_capabilities = ?, input_schema = ?,
             output_schema = ?, risk_constraints = ?, delegation_policy = ?, maximum_steps = ?, timeout_seconds = ?,
             token_budget = ?, verification_requirements = ?, escalation_rules = ?, status = ?, updated_at = ?
           WHERE agent_id = ?`,
        )
        .run(
          def.name,
          def.version,
          def.description,
          def.category,
          JSON.stringify(def.supportedWorkspaceTypes),
          JSON.stringify(def.allowedCommandIds),
          JSON.stringify(def.requiredPermissions),
          JSON.stringify(def.requiredCapabilities),
          JSON.stringify(def.inputSchema),
          JSON.stringify(def.outputSchema),
          JSON.stringify(def.riskConstraints),
          def.delegationPolicy,
          def.maximumSteps,
          def.timeoutSeconds,
          def.tokenBudget,
          JSON.stringify(def.verificationRequirements),
          JSON.stringify(def.escalationRules),
          def.status,
          ts,
          def.agentId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO agents
           (id, agent_id, name, version, description, category, supported_workspace_types, allowed_command_ids,
            required_permissions, required_capabilities, input_schema, output_schema, risk_constraints,
            delegation_policy, maximum_steps, timeout_seconds, token_budget, verification_requirements,
            escalation_rules, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          uuid(),
          def.agentId,
          def.name,
          def.version,
          def.description,
          def.category,
          JSON.stringify(def.supportedWorkspaceTypes),
          JSON.stringify(def.allowedCommandIds),
          JSON.stringify(def.requiredPermissions),
          JSON.stringify(def.requiredCapabilities),
          JSON.stringify(def.inputSchema),
          JSON.stringify(def.outputSchema),
          JSON.stringify(def.riskConstraints),
          def.delegationPolicy,
          def.maximumSteps,
          def.timeoutSeconds,
          def.tokenBudget,
          JSON.stringify(def.verificationRequirements),
          JSON.stringify(def.escalationRules),
          def.status,
          ts,
          ts,
        );
    }
    return def;
  }

  get(agentId: string): AgentDefinition | null {
    const cached = this.definitions.get(agentId);
    if (cached) return cached;
    const row = this.db
      .prepare("SELECT * FROM agents WHERE agent_id = ?")
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const def = this.mapRow(row);
    this.definitions.set(agentId, def);
    return def;
  }

  list(): AgentDefinition[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY agent_id")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  setStatus(agentId: string, status: AgentLifecycleStatus): void {
    const def = this.get(agentId);
    if (!def) throw new AgentRegistryError("Agent not found", "NOT_FOUND");
    const updated = { ...def, status };
    this.definitions.set(agentId, updated);
    this.db
      .prepare("UPDATE agents SET status = ?, updated_at = ? WHERE agent_id = ?")
      .run(status, now(), agentId);
  }

  /**
   * True when an agent can receive a new task: it exists, is ENABLED (or
   * VALIDATED for read-only inspection), and the workspace type is supported.
   */
  canAcceptTask(agentId: string, workspaceType: string): boolean {
    const def = this.get(agentId);
    if (!def) return false;
    if (def.status !== "ENABLED" && def.status !== "VALIDATED") return false;
    if (
      def.supportedWorkspaceTypes.length > 0 &&
      !def.supportedWorkspaceTypes.includes(workspaceType)
    ) {
      return false;
    }
    return true;
  }

  /**
   * Validate that a delegation's command set is within the agent's allowed
   * commands and that the agent's required permissions are a subset of the
   * caller's effective permissions (agents cannot expand authority).
   */
  validateDelegationScope(
    agentId: string,
    requestedCommands: string[],
    effectivePermissions: string[],
  ): { ok: boolean; reason?: string } {
    const def = this.get(agentId);
    if (!def) return { ok: false, reason: "Unknown agent" };
    const disallowed = requestedCommands.filter(
      (c) => !def.allowedCommandIds.includes(c),
    );
    if (disallowed.length > 0) {
      return {
        ok: false,
        reason: `Commands not allowed for agent ${agentId}: ${disallowed.join(", ")}`,
      };
    }
    const missing = def.requiredPermissions.filter(
      (p) => !effectivePermissions.includes(p),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Agent ${agentId} requires permissions not held: ${missing.join(", ")}`,
      };
    }
    return { ok: true };
  }

  private mapRow(row: Record<string, unknown>): AgentDefinition {
    return {
      agentId: row.agent_id as string,
      name: row.name as string,
      version: row.version as string,
      description: row.description as string,
      category: row.category as AgentDefinition["category"],
      supportedWorkspaceTypes: JSON.parse((row.supported_workspace_types as string) || "[]"),
      allowedCommandIds: JSON.parse((row.allowed_command_ids as string) || "[]"),
      requiredPermissions: JSON.parse((row.required_permissions as string) || "[]"),
      requiredCapabilities: JSON.parse((row.required_capabilities as string) || "[]"),
      inputSchema: JSON.parse((row.input_schema as string) || "{}"),
      outputSchema: JSON.parse((row.output_schema as string) || "{}"),
      riskConstraints: JSON.parse((row.risk_constraints as string) || "[]"),
      delegationPolicy: row.delegation_policy as AgentDefinition["delegationPolicy"],
      maximumSteps: row.maximum_steps as number,
      timeoutSeconds: row.timeout_seconds as number,
      tokenBudget: (row.token_budget as number) ?? null,
      verificationRequirements: JSON.parse((row.verification_requirements as string) || "[]"),
      escalationRules: JSON.parse((row.escalation_rules as string) || "[]"),
      status: row.status as AgentLifecycleStatus,
    };
  }
}
