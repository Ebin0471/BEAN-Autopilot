import type { Db } from "@/lib/db/database";
import { now } from "@/lib/db/util";
import { BUILTIN_CAPABILITIES } from "./builtin-capabilities";
import type { CapabilityAvailability, CapabilityDefinition } from "./types";

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

const key = (capabilityId: string, version: string) => `${capabilityId}@${version}`;

/**
 * Capability fabric registry. Tracks available/potential execution surfaces
 * with explicit availability and health states. Distinguishes a supported
 * capability (REGISTERED) from a connected, healthy one (AVAILABLE).
 */
export class CapabilityRegistry {
  private defs = new Map<string, CapabilityDefinition>();

  constructor(private db: Db) {
    this.seedBuiltins();
  }

  private seedBuiltins(): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO capabilities
       (capability_id, version, name, category, provider, description, supported_commands,
        required_scopes, supported_workspace_types, risk_constraints, availability_status,
        health_status, connection_requirements, rate_limits, timeout_limits,
        verification_support, compensation_support, documentation, trust_level, registered_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const ts = now();
    for (const def of BUILTIN_CAPABILITIES) {
      this.defs.set(key(def.capabilityId, def.version), def);
      stmt.run(
        def.capabilityId,
        def.version,
        def.name,
        def.category,
        def.provider,
        def.description,
        JSON.stringify(def.supportedCommands),
        JSON.stringify(def.requiredScopes),
        JSON.stringify(def.supportedWorkspaceTypes),
        JSON.stringify(def.riskConstraints),
        def.availabilityStatus,
        def.healthStatus,
        JSON.stringify(def.connectionRequirements),
        JSON.stringify(def.rateLimits),
        JSON.stringify(def.timeoutLimits),
        def.verificationSupport ? 1 : 0,
        def.compensationSupport ? 1 : 0,
        def.documentation,
        def.trustLevel,
        "system",
        ts,
        ts,
      );
    }
  }

  register(def: CapabilityDefinition, actorId: string): CapabilityDefinition {
    if (this.defs.has(key(def.capabilityId, def.version))) {
      throw new CapabilityError(`Capability already registered: ${def.capabilityId}@${def.version}`);
    }
    this.defs.set(key(def.capabilityId, def.version), def);
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO capabilities
         (capability_id, version, name, category, provider, description, supported_commands,
          required_scopes, supported_workspace_types, risk_constraints, availability_status,
          health_status, connection_requirements, rate_limits, timeout_limits,
          verification_support, compensation_support, documentation, trust_level, registered_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        def.capabilityId,
        def.version,
        def.name,
        def.category,
        def.provider,
        def.description,
        JSON.stringify(def.supportedCommands),
        JSON.stringify(def.requiredScopes),
        JSON.stringify(def.supportedWorkspaceTypes),
        JSON.stringify(def.riskConstraints),
        def.availabilityStatus,
        def.healthStatus,
        JSON.stringify(def.connectionRequirements),
        JSON.stringify(def.rateLimits),
        JSON.stringify(def.timeoutLimits),
        def.verificationSupport ? 1 : 0,
        def.compensationSupport ? 1 : 0,
        def.documentation,
        def.trustLevel,
        actorId,
        ts,
        ts,
      );
    return def;
  }

  get(capabilityId: string, version?: string): CapabilityDefinition | undefined {
    if (version) return this.defs.get(key(capabilityId, version));
    const versions = this.versions(capabilityId);
    if (versions.length === 0) return undefined;
    return versions[versions.length - 1];
  }

  versions(capabilityId: string): CapabilityDefinition[] {
    return [...this.defs.values()].filter((d) => d.capabilityId === capabilityId);
  }

  list(category?: string): CapabilityDefinition[] {
    return [...this.defs.values()].filter((d) => !category || d.category === category);
  }

  /** Update the runtime availability/health state of a capability. */
  setStatus(capabilityId: string, status: CapabilityAvailability, actorId: string): void {
    const def = this.get(capabilityId);
    if (!def) throw new CapabilityError("Capability not found");
    const updated = { ...def, availabilityStatus: status };
    this.defs.set(key(def.capabilityId, def.version), updated);
    this.db
      .prepare("UPDATE capabilities SET availability_status = ?, updated_at = ? WHERE capability_id = ? AND version = ?")
      .run(status, now(), capabilityId, def.version);
    void actorId;
  }

  /** Whether a capability can currently serve commands (available and not disabled/revoked). */
  isUsable(capabilityId: string): boolean {
    const def = this.get(capabilityId);
    if (!def) return false;
    return def.availabilityStatus === "AVAILABLE" || def.availabilityStatus === "DEGRADED";
  }

  /** A capability can never expand the actor's permissions: its scopes must be a subset. */
  assertNoEscalation(capability: CapabilityDefinition, actorPermissions: string[]): void {
    for (const scope of capability.requiredScopes) {
      if (!actorPermissions.includes(scope)) {
        throw new CapabilityError(`Capability requires scope not held: ${scope}`);
      }
    }
  }
}
