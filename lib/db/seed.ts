import type { Db } from "./database";
import type { Permission, Role } from "@/lib/security/types";
import { PERMISSIONS } from "@/lib/security/types";

/**
 * Default role -> permission mapping (deny-by-default). Inserted idempotently.
 * OWNER-only controls are withheld from every other role.
 */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  OWNER: [...PERMISSIONS],
  ADMIN: PERMISSIONS.filter((p) => p !== "workspace.delete" && p !== "policy.manage"),
  OPERATOR: [
    "workspace.read",
    "workspace.update",
    "files.read",
    "files.write",
    "memory.read",
    "memory.write",
    "agents.read",
    "agents.configure",
    "actions.request",
    "connections.manage",
  ],
  MEMBER: [
    "workspace.read",
    "files.read",
    "files.write",
    "memory.read",
    "memory.write",
    "agents.read",
    "actions.request",
  ],
  VIEWER: ["workspace.read", "files.read", "memory.read", "agents.read", "audit.read"],
};

export function seedDefaults(db: Db): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)",
  );
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const perm of perms) {
      stmt.run(role, perm);
    }
  }
}
