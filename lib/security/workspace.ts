import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import { AuditService } from "./audit";
import type { Role, WorkspaceKind } from "./types";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  name: string;
  owner_user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Workspace + membership lifecycle. Enforces isolation invariants and
 * owner-protection rules. All cross-tenant reads go through membership checks.
 */
export class WorkspaceService {
  constructor(private db: Db, private audit: AuditService) {}

  createWorkspace(userId: string, kind: WorkspaceKind, name: string): Workspace {
    const id = uuid();
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO workspaces (id, kind, name, owner_user_id, status, created_at, updated_at) VALUES (?,?,?,?, 'ACTIVE', ?, ?)",
      )
      .run(id, kind, name, userId, ts, ts);
    this.setMembership(id, userId, "OWNER", userId);
    this.audit.append({
      workspaceId: id,
      actorId: userId,
      actorType: "USER",
      eventType: "WORKSPACE_CREATED",
      result: "SUCCESS",
      metadata: { kind },
    });
    return this.getWorkspace(id)!;
  }

  /** Create the default private Personal workspace after account creation. */
  createPersonalWorkspace(userId: string): Workspace {
    return this.createWorkspace(userId, "PERSONAL", "Personal");
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | Workspace
      | undefined;
  }

  listForUser(userId: string): Workspace[] {
    return this.db
      .prepare(
        `SELECT w.* FROM workspaces w
         JOIN workspace_memberships m ON m.workspace_id = w.id
         WHERE m.user_id = ? AND w.status = 'ACTIVE'
         ORDER BY w.created_at`,
      )
      .all(userId) as unknown as Workspace[];
  }

  getMembership(workspaceId: string, userId: string): { role: Role } | undefined {
    return this.db
      .prepare("SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, userId) as { role: Role } | undefined;
  }

  setMembership(workspaceId: string, userId: string, role: Role, actorId: string): void {
    const ts = now();
    const existing = this.db
      .prepare("SELECT id FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, userId) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE workspace_memberships SET role = ?, updated_at = ? WHERE id = ?")
        .run(role, ts, existing.id);
    } else {
      this.db
        .prepare(
          "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run(uuid(), workspaceId, userId, role, ts, ts);
    }
    this.audit.append({
      workspaceId,
      actorId,
      actorType: "USER",
      eventType: "MEMBERSHIP_CHANGED",
      targetType: "user",
      targetId: userId,
      result: "SUCCESS",
      metadata: { role },
    });
  }

  countOwners(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM workspace_memberships WHERE workspace_id = ? AND role = 'OWNER'")
      .get(workspaceId) as { c: number };
    return row.c;
  }

  /** Remove a member. The final OWNER cannot be removed without a transfer. */
  removeMember(workspaceId: string, userId: string, actorId: string): void {
    const membership = this.getMembership(workspaceId, userId);
    if (!membership) throw new WorkspaceError("Membership not found");
    if (membership.role === "OWNER" && this.countOwners(workspaceId) <= 1) {
      throw new WorkspaceError("Cannot remove the final workspace owner");
    }
    this.db
      .prepare("DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?")
      .run(workspaceId, userId);
    this.audit.append({
      workspaceId,
      actorId,
      actorType: "USER",
      eventType: "MEMBERSHIP_REMOVED",
      targetType: "user",
      targetId: userId,
      result: "SUCCESS",
    });
  }

  invite(workspaceId: string, email: string, role: Role, actorId: string): string {
    const id = uuid();
    this.db
      .prepare(
        "INSERT INTO invitations (id, workspace_id, invitee_email, role, created_by, status, created_at) VALUES (?,?,?,?,?,'PENDING',?)",
      )
      .run(id, workspaceId, email, role, actorId, now());
    this.audit.append({
      workspaceId,
      actorId,
      actorType: "USER",
      eventType: "INVITATION_CREATED",
      targetType: "invitation",
      targetId: id,
      result: "SUCCESS",
      metadata: { role, email },
    });
    return id;
  }
}
