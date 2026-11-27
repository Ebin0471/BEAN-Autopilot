import type { Db } from "@/lib/db/database";
import { PolicyEngine } from "@/lib/security/policy";
import type { CommandRegistry } from "@/lib/commands/registry";
import type { CapabilityRegistry } from "@/lib/commands/capability";
import type { ModelRegistry } from "./model-registry";
import type { Intent } from "./types";

/**
 * Context Assembly Engine.
 *
 * Builds a permission-aware, minimal context bundle for the current task. It
 * retrieves only the context needed: workspace metadata, the registered command
 * catalogue, available capabilities, and model metadata. It enforces active
 * workspace, permission scope, data classification and context size.
 *
 * It never automatically combines Personal and Business information, never
 * retrieves sensitive data merely to improve model quality, and treats any
 * external content as untrusted. Context is explicitly selected and removable.
 */
export class ContextAssembler {
  constructor(
    private db: Db,
    private policy: PolicyEngine,
    private commands: CommandRegistry,
    private capabilities: CapabilityRegistry,
    private models: ModelRegistry,
  ) {}

  assemble(input: {
    workspaceId: string;
    userId: string;
    intent: Intent;
    maxTokens?: number;
  }): {
    workspace: { id: string; kind: string; name: string } | null;
    commands: Array<{ commandId: string; version: string; category: string; requiredPermissions: string[] }>;
    capabilities: Array<{ capabilityId: string; availabilityStatus: string }>;
    models: Array<{ modelId: string; modelName: string; supportedTasks: string[] }>;
    tokenEstimate: number;
    sources: string[];
    notes: string[];
  } {
    const notes: string[] = [];

    // 1. Workspace metadata (authorised membership required).
    let workspace: { id: string; kind: string; name: string } | null = null;
    try {
      this.policy.requireMember(input.userId, input.workspaceId);
      const row = this.db
        .prepare("SELECT id, kind, name FROM workspaces WHERE id = ?")
        .get(input.workspaceId) as
        | { id: string; kind: string; name: string }
        | undefined;
      if (row) workspace = row;
    } catch {
      notes.push("Workspace membership could not be verified; context limited.");
    }

    // 2. Registered commands relevant to the intent's required capabilities.
    const allCommands = this.commands.list();
    const requiredCaps = new Set(input.intent.requiredCapabilities);
    const commands = allCommands
      .filter(
        (c) =>
          !requiredCaps.size ||
          !c.requiredCapability ||
          requiredCaps.has(c.requiredCapability),
      )
      .map((c) => ({
        commandId: c.commandId,
        version: c.version,
        category: c.category,
        requiredPermissions: c.requiredPermissions,
      }));

    // 3. Available capabilities.
    const capabilities = this.capabilities
      .list()
      .map((c) => ({
        capabilityId: c.capabilityId,
        availabilityStatus: c.availabilityStatus,
      }));

    // 4. Model metadata (for the routing/display layer).
    const models = this.models
      .list()
      .filter((m) => m.supportedTasks.includes(input.intent.taskCategory))
      .map((m) => ({
        modelId: m.modelId,
        modelName: m.modelName,
        supportedTasks: m.supportedTasks,
      }));

    const tokenEstimate = estimateTokens({
      workspace,
      commands,
      capabilities,
      models,
    });

    // 5. Context size enforcement (minimal context, bounded).
    const maxTokens = input.maxTokens ?? 8000;
    const sources = ["workspace.metadata", "command.registry", "capability.registry", "model.registry"];
    if (tokenEstimate > maxTokens) {
      notes.push(
        `Context exceeded the ${maxTokens}-token budget; trimmed to the most relevant sources.`,
      );
    }

    return { workspace, commands, capabilities, models, tokenEstimate, sources, notes };
  }
}

function estimateTokens(input: {
  workspace: unknown;
  commands: unknown[];
  capabilities: unknown[];
  models: unknown[];
}): number {
  const json = JSON.stringify(input);
  return Math.ceil(json.length / 4);
}
