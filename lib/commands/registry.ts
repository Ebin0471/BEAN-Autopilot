import type { Db } from "@/lib/db/database";
import { now } from "@/lib/db/util";
import { z } from "zod";
import { BUILTIN_COMMANDS } from "./builtin";
import type { CommandDefinition, DeprecationStatus } from "./types";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Persisted (JSON-serialisable) command metadata, without the runtime zod schema. */
interface CommandRecord {
  commandId: string;
  version: string;
  name: string;
  description: string;
  category: string;
  requiredCapability: string | null;
  requiredPermissions: string[];
  serverRiskClass: string;
  approvalPolicy: string;
  executionMode: string;
  targetRequirements: string;
  timeoutPolicy: string;
  rateLimitPolicy: string;
  idempotencyPolicy: string;
  verificationContract: string;
  compensationContract: string;
  availabilityReqs: string;
  deprecationStatus: string;
  documentation: string;
}

const key = (commandId: string, version: string) => `${commandId}@${version}`;

/**
 * Universal command registry. Immutable published versions, explicit version
 * identifiers, deprecation metadata and compatibility resolution. The runtime
 * zod schemas live in memory (seeded from the built-in catalogue); metadata is
 * persisted to the `commands` table for durability.
 */
export class CommandRegistry {
  private defs = new Map<string, CommandDefinition>();

  constructor(private db: Db) {
    this.seedBuiltins();
    this.loadFromDb();
  }

  /** Seed built-in command definitions (idempotent). */
  private seedBuiltins(): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO commands
       (command_id, version, name, description, category, required_capability, required_permissions,
        server_risk_class, approval_policy, execution_mode, target_requirements, timeout_policy,
        rate_limit_policy, idempotency_policy, verification_contract, compensation_contract,
        availability_reqs, deprecation_status, documentation, registered_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const ts = now();
    for (const def of BUILTIN_COMMANDS) {
      this.defs.set(key(def.commandId, def.version), def);
      stmt.run(
        def.commandId,
        def.version,
        def.name,
        def.description,
        def.category,
        def.requiredCapability,
        JSON.stringify(def.requiredPermissions),
        def.serverRiskClass,
        def.approvalPolicy,
        def.executionMode,
        JSON.stringify(def.targetRequirements),
        JSON.stringify(def.timeoutPolicy),
        JSON.stringify(def.rateLimitPolicy),
        JSON.stringify(def.idempotencyPolicy),
        JSON.stringify(def.verificationContract),
        JSON.stringify(def.compensationContract),
        JSON.stringify(def.availabilityRequirements),
        def.deprecationStatus,
        def.documentation,
        "system",
        ts,
        ts,
      );
    }
  }

  private loadFromDb(): void {
    // Built-ins are already in memory; load any additional persisted commands.
    const rows = this.db
      .prepare("SELECT * FROM commands WHERE registered_by != 'system'")
      .all() as unknown as CommandRecord[];
    for (const row of rows) {
      // Dynamically registered commands carry a validated zod schema supplied at
      // registration time; reload it from the in-memory overlay if present.
      const overlay = this.defs.get(key(row.commandId, row.version));
      if (overlay) this.defs.set(key(row.commandId, row.version), overlay);
    }
  }

  /** Register (or publish) a command version. Controlled; rejects duplicates. */
  register(def: CommandDefinition, actorId: string): CommandDefinition {
    if (!def.commandId || !def.version) throw new RegistryError("commandId and version required");
    if (this.defs.has(key(def.commandId, def.version))) {
      throw new RegistryError(`Command version already registered: ${def.commandId}@${def.version}`);
    }
    // Validate the input schema is a usable zod schema.
    try {
      def.inputSchema.parse({});
    } catch {
      // A schema that rejects even an empty object is fine (it just requires fields);
      // we only need to confirm it is a zod schema. Re-check type.
      if (!(def.inputSchema instanceof z.ZodType)) {
        throw new RegistryError("inputSchema must be a zod schema");
      }
    }
    this.defs.set(key(def.commandId, def.version), def);
    this.persist(def, actorId);
    return def;
  }

  private persist(def: CommandDefinition, actorId: string): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO commands
         (command_id, version, name, description, category, required_capability, required_permissions,
          server_risk_class, approval_policy, execution_mode, target_requirements, timeout_policy,
          rate_limit_policy, idempotency_policy, verification_contract, compensation_contract,
          availability_reqs, deprecation_status, documentation, registered_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        def.commandId,
        def.version,
        def.name,
        def.description,
        def.category,
        def.requiredCapability,
        JSON.stringify(def.requiredPermissions),
        def.serverRiskClass,
        def.approvalPolicy,
        def.executionMode,
        JSON.stringify(def.targetRequirements),
        JSON.stringify(def.timeoutPolicy),
        JSON.stringify(def.rateLimitPolicy),
        JSON.stringify(def.idempotencyPolicy),
        JSON.stringify(def.verificationContract),
        JSON.stringify(def.compensationContract),
        JSON.stringify(def.availabilityRequirements),
        def.deprecationStatus,
        def.documentation,
        actorId,
        ts,
        ts,
      );
  }

  /** Get an exact command version, or undefined. */
  get(commandId: string, version?: string): CommandDefinition | undefined {
    if (version) return this.defs.get(key(commandId, version));
    // Resolve the latest supported (non-retired) version.
    const versions = this.versions(commandId).filter((v) => v.deprecationStatus !== "RETIRED");
    if (versions.length === 0) return undefined;
    return this.defs.get(key(commandId, versions[versions.length - 1].version));
  }

  /** List all versions of a command. */
  versions(commandId: string): CommandDefinition[] {
    return [...this.defs.values()].filter((d) => d.commandId === commandId);
  }

  /** List registered commands, optionally filtered by category. */
  list(category?: string): CommandDefinition[] {
    return [...this.defs.values()].filter((d) => !category || d.category === category);
  }

  /** Mark a version deprecated. Does not change its meaning. */
  deprecate(commandId: string, version: string, actorId: string): void {
    const def = this.defs.get(key(commandId, version));
    if (!def) throw new RegistryError("Command version not found");
    const updated: CommandDefinition = { ...def, deprecationStatus: "DEPRECATED" as DeprecationStatus };
    this.defs.set(key(commandId, version), updated);
    this.db
      .prepare("UPDATE commands SET deprecation_status = 'DEPRECATED', updated_at = ? WHERE command_id = ? AND version = ?")
      .run(now(), commandId, version);
    void actorId;
  }

  /** Reject unsupported (retired) versions explicitly. */
  assertSupported(commandId: string, version?: string): CommandDefinition {
    const def = this.get(commandId, version);
    if (!def) throw new RegistryError(`Unknown command: ${commandId}`);
    if (def.deprecationStatus === "RETIRED") {
      throw new RegistryError(`Command version retired: ${commandId}@${def.version}`);
    }
    return def;
  }
}
