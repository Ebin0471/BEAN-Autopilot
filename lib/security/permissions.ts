import type { Db } from "@/lib/db/database";
import type { Permission, Role } from "./types";

/** Resolves role -> permission mappings and a member's effective permissions. */
export class PermissionService {
  constructor(private db: Db) {}

  rolePermissions(role: Role): Permission[] {
    const rows = this.db
      .prepare("SELECT permission FROM role_permissions WHERE role = ?")
      .all(role) as { permission: string }[];
    return rows.map((r) => r.permission as Permission);
  }

  /** Role held by a user in a workspace, or null if not a member. */
  roleForMembership(workspaceId: string, userId: string): Role | null {
    const row = this.db
      .prepare("SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, userId) as { role: Role } | undefined;
    return row?.role ?? null;
  }

  /** Effective permissions for a member in a workspace. Null when not a member. */
  effectivePermissions(
    workspaceId: string,
    userId: string,
  ): { role: Role; permissions: Permission[] } | null {
    const role = this.roleForMembership(workspaceId, userId);
    if (!role) return null;
    return { role, permissions: this.rolePermissions(role) };
  }

  hasPermission(role: Role, permission: Permission): boolean {
    return this.rolePermissions(role).includes(permission);
  }

  isOwner(workspaceId: string, userId: string): boolean {
    return this.roleForMembership(workspaceId, userId) === "OWNER";
  }
}
