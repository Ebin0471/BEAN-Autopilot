import type { Db } from "@/lib/db/database";
import { PermissionService } from "./permissions";
import type { Permission, Role } from "./types";

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface ResolvedContext {
  userId: string;
  workspaceId: string;
  role: Role;
  permissions: Permission[];
}

/**
 * Central policy service. Every authorisation decision flows through here.
 * Deny-by-default: an unknown permission, a missing membership, or a missing
 * permission always denies. Client-supplied roles/permissions are ignored —
 * only the server-resolved membership is trusted.
 */
export class PolicyEngine {
  private permissions: PermissionService;

  constructor(private db: Db) {
    this.permissions = new PermissionService(db);
  }

  /**
   * Verify a user is an active member of a workspace and resolve their context.
   * Returns null if the user is not a member (so callers can return a uniform
   * response without revealing whether the workspace exists).
   */
  resolve(userId: string, workspaceId: string): ResolvedContext | null {
    const eff = this.permissions.effectivePermissions(workspaceId, userId);
    if (!eff) return null;
    return { userId, workspaceId, role: eff.role, permissions: eff.permissions };
  }

  /** Boolean authorisation check. Never throws. */
  authorize(userId: string, workspaceId: string, permission: Permission): boolean {
    const ctx = this.resolve(userId, workspaceId);
    if (!ctx) return false;
    return ctx.permissions.includes(permission);
  }

  /** Throwing authorisation check for route handlers. */
  require(userId: string, workspaceId: string, permission: Permission): ResolvedContext {
    const ctx = this.resolve(userId, workspaceId);
    if (!ctx) throw new AuthorizationError("Workspace access denied");
    if (!ctx.permissions.includes(permission)) {
      throw new AuthorizationError(`Permission denied: ${permission}`);
    }
    return ctx;
  }

  /** Require membership without a specific permission. */
  requireMember(userId: string, workspaceId: string): ResolvedContext {
    const ctx = this.resolve(userId, workspaceId);
    if (!ctx) throw new AuthorizationError("Workspace access denied");
    return ctx;
  }

  /** Require OWNER role for owner-only controls (e.g. delete workspace, policy). */
  requireOwner(userId: string, workspaceId: string): ResolvedContext {
    const ctx = this.requireMember(userId, workspaceId);
    if (ctx.role !== "OWNER") throw new AuthorizationError("Owner role required");
    return ctx;
  }
}
