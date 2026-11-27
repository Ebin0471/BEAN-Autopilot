import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import { computeParamHash, canonicalBinding, IdempotencyConflictError } from "@/lib/commands/canonical";
import { AuditService } from "./audit";
import { PolicyEngine, AuthorizationError } from "./policy";
import { RiskClassifier } from "./risk";
import {
  PASSPORT_TRANSITIONS,
  type ActionRequest,
  type PassportState,
  type Permission,
} from "./types";

export interface Passport {
  id: string;
  workspace_id: string;
  initiator_user_id: string;
  agent_id: string | null;
  actor_type: string;
  target_type: string;
  target_id: string;
  command: string;
  operation: string;
  data_scope: string;
  permission_scope: string;
  risk_class: string;
  param_hash: string;
  params_canonical: string;
  approval_policy: string;
  status: PassportState;
  idempotency_key: string;
  verification_req: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  audit_ref: string | null;
}

export class PassportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassportError";
  }
}

/**
 * Action Passport service. Every consequential action is bound to one
 * workspace, one exact command/target, and canonicalised parameters. Approval
 * cannot expand scope; agents cannot expand authority; expired/revoked/
 * consumed passports cannot be used; invalid transitions fail.
 */
export class ActionPassportService {
  constructor(
    private db: Db,
    private policy: PolicyEngine,
    private audit: AuditService,
    private risk: RiskClassifier,
  ) {}

  createRequest(
    actor: { userId: string; workspaceId: string; agentId?: string | null },
    action: ActionRequest,
    opts?: { ttlHours?: number },
  ): { passport: Passport; created: boolean } {
    // Server-side workspace + permission enforcement (deny-by-default).
    this.policy.require(actor.userId, actor.workspaceId, "actions.request");

    // The requested permission scope must be a subset of the actor's effective
    // permissions. Approval/delegation can never expand beyond this bound.
    const actorEff = this.policy.resolve(actor.userId, actor.workspaceId);
    if (!actorEff) throw new AuthorizationError("Workspace access denied");
    for (const p of action.permissionScope) {
      if (!actorEff.permissions.includes(p)) {
        throw new AuthorizationError("Cannot request a permission that is not held: " + p);
      }
    }

    // Server-authoritative risk classification (client-proposed risk is ignored;
    // the ruleset is the only source, so a client can never lower risk).
    const { risk } = this.risk.classify({
      command: action.command,
      operation: action.operation,
    });

    // Use the gateway-computed full-payload binding when supplied (CORE-02);
    // otherwise fall back to the CORE-01-compatible hash over the action shape.
    const paramHash = action.paramHash && action.paramHash.length > 0 ? action.paramHash : computeParamHash(action);
    const paramsCanonical =
      action.paramsCanonical ??
      canonicalBinding({
        workspaceId: actor.workspaceId,
        commandId: action.command,
        commandVersion: "1",
        targetType: action.targetType,
        targetId: action.targetId,
        args: action.params ?? {},
        executionOptions: { dataScope: action.dataScope },
      });

    // Idempotency is scoped to (workspace, key) AND the complete canonical
    // binding. The same key reused for a different canonical payload must
    // never return the unrelated prior passport.
    const existing = this.db
      .prepare("SELECT * FROM action_passports WHERE workspace_id = ? AND idempotency_key = ?")
      .get(actor.workspaceId, action.idempotencyKey) as Passport | undefined;
    if (existing) {
      if (existing.param_hash === paramHash && existing.params_canonical === paramsCanonical) {
        return { passport: this.expireIfNeeded(existing.id), created: false };
      }
      throw new IdempotencyConflictError(
        "Idempotency key reused for a different request in workspace " + actor.workspaceId,
        actor.workspaceId,
        action.idempotencyKey,
      );
    }
    const id = uuid();
    const ts = now();
    const ttlHours = opts?.ttlHours ?? 24;
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

    const actorType = actor.agentId ? "AGENT" : "USER";
    const approvalRequired = this.risk.policyFor(risk).approvalRequired;
    const status: PassportState = approvalRequired ? "PENDING_APPROVAL" : "AUTHORISED";

    try {
      this.db
        .prepare(
          `INSERT INTO action_passports
           (id, workspace_id, initiator_user_id, agent_id, actor_type, target_type, target_id,
            command, operation, data_scope, permission_scope, risk_class, param_hash, params_canonical, approval_policy,
            status, idempotency_key, verification_req, created_at, updated_at, expires_at, consumed_at, revoked_at, audit_ref)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`,
        )
        .run(
          id,
          actor.workspaceId,
          actor.userId,
          actor.agentId ?? null,
          actorType,
          action.targetType,
          action.targetId,
          action.command,
          action.operation,
          action.dataScope,
          JSON.stringify(action.permissionScope),
          risk,
          paramHash,
          paramsCanonical,
          action.approvalPolicy,
          status,
          action.idempotencyKey,
          JSON.stringify(action.verificationRequirements),
          ts,
          ts,
          expiresAt,
        );
    } catch (err) {
      // Concurrent duplicate insert: the (workspace, key) UNIQUE constraint
      // fired. Re-read and reconcile — same canonical payload replays, a
      // different one is an explicit conflict.
      if (isUniqueConstraintError(err)) {
        const raced = this.db
          .prepare("SELECT * FROM action_passports WHERE workspace_id = ? AND idempotency_key = ?")
          .get(actor.workspaceId, action.idempotencyKey) as Passport | undefined;
        if (raced && raced.param_hash === paramHash && raced.params_canonical === paramsCanonical) {
          return { passport: this.expireIfNeeded(raced.id), created: false };
        }
        if (raced) {
          throw new IdempotencyConflictError(
            "Idempotency key reused for a different request in workspace " + actor.workspaceId,
            actor.workspaceId,
            action.idempotencyKey,
          );
        }
      }
      throw err;
    }


    const auditRef = this.audit.append({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      actorType: "USER",
      eventType: "PASSPORT_ISSUED",
      targetType: "passport",
      targetId: id,
      result: "SUCCESS",
      metadata: { risk, status, command: action.command },
    });
    this.db.prepare("UPDATE action_passports SET audit_ref = ? WHERE id = ?").run(auditRef, id);

    return { passport: this.get(id)!, created: true };
  }

  get(id: string): Passport | undefined {
    return this.db.prepare("SELECT * FROM action_passports WHERE id = ?").get(id) as
      | Passport
      | undefined;
  }

  list(workspaceId: string, status?: PassportState): Passport[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM action_passports WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC")
        .all(workspaceId, status) as unknown as Passport[];
    }
    return this.db
      .prepare("SELECT * FROM action_passports WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as unknown as Passport[];
  }

  /** Transition a passport, enforcing the state machine and expiry/revocation. */
  transition(id: string, to: PassportState, actorId: string): Passport {
    const passport = this.get(id);
    if (!passport) throw new PassportError("Passport not found");
    this.expireIfNeeded(id);
    const fresh = this.get(id)!;

    if (fresh.status === "REVOKED" || fresh.status === "EXPIRED" || fresh.status === "CONSUMED" || fresh.status === "REJECTED" || fresh.status === "BLOCKED") {
      throw new PassportError(`Passport is terminal: ${fresh.status}`);
    }
    if (!PASSPORT_TRANSITIONS[fresh.status].includes(to)) {
      throw new PassportError(`Invalid transition ${fresh.status} -> ${to}`);
    }
    this.db
      .prepare("UPDATE action_passports SET status = ?, updated_at = ? WHERE id = ?")
      .run(to, now(), id);
    this.audit.append({
      workspaceId: fresh.workspace_id,
      actorId,
      actorType: "USER",
      eventType: "PASSPORT_TRANSITION",
      targetType: "passport",
      targetId: id,
      result: "SUCCESS",
      metadata: { from: fresh.status, to },
    });
    return this.get(id)!;
  }

  /** Record an approval decision. Enforces approver authority + separation of duties. */
  approve(id: string, approverId: string, decision: "APPROVED" | "REJECTED", comment?: string): Passport {
    const passport = this.get(id);
    if (!passport) throw new PassportError("Passport not found");
    if (passport.status !== "PENDING_APPROVAL") {
      throw new PassportError(`Passport not pending approval (status: ${passport.status})`);
    }
    // Approver must hold actions.approve in the workspace.
    this.policy.require(approverId, passport.workspace_id, "actions.approve" as Permission);
    // Separation of duties: the initiator cannot self-approve.
    if (approverId === passport.initiator_user_id) {
      throw new PassportError("Self-approval is not permitted");
    }
    this.db
      .prepare(
        "INSERT INTO passport_approvals (id, passport_id, approver_id, decision, comment, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(uuid(), id, approverId, decision, comment ?? null, now());

    if (decision === "REJECTED") {
      return this.transition(id, "REJECTED", approverId);
    }
    // Single approval approves; dual approval requires a second distinct approver.
    const approvals = this.db
      .prepare("SELECT approver_id FROM passport_approvals WHERE passport_id = ? AND decision = 'APPROVED'")
      .all(id) as { approver_id: string }[];
    const distinct = new Set(approvals.map((a) => a.approver_id));
    if (passport.approval_policy === "DUAL" && distinct.size < 2) {
      return this.get(id)!; // still pending a second approver
    }
    return this.transition(id, "APPROVED", approverId);
  }

  /** Move an APPROVED passport to AUTHORISED (ready to execute). */
  authorise(id: string, actorId: string): Passport {
    const passport = this.get(id);
    if (!passport) throw new PassportError("Passport not found");
    this.policy.require(actorId, passport.workspace_id, "actions.execute" as Permission);
    return this.transition(id, "AUTHORISED", actorId);
  }

  /** Revoke an unconsumed passport. */
  revoke(id: string, actorId: string): Passport {
    const passport = this.get(id);
    if (!passport) throw new PassportError("Passport not found");
    this.policy.requireOwner(actorId, passport.workspace_id);
    if (passport.status === "CONSUMED") throw new PassportError("Consumed passport cannot be revoked");
    if (passport.status === "REVOKED") return passport;
    return this.transition(id, "REVOKED", actorId);
  }

  /**
   * Verify a passport is usable for a specific execution and consume it
   * (one-time). Re-checks binding, state, expiry and revocation.
   */
  assertExecutable(
    id: string,
    execution: { command: string; targetId: string; paramHash: string },
  ): Passport {
    const passport = this.get(id);
    if (!passport) throw new PassportError("Passport not found");
    this.expireIfNeeded(id);
    const fresh = this.get(id)!;

    if (fresh.status !== "AUTHORISED") {
      throw new PassportError(`Passport not authorised (status: ${fresh.status})`);
    }
    if (fresh.command !== execution.command) throw new PassportError("Command mismatch");
    if (fresh.target_id !== execution.targetId) throw new PassportError("Target mismatch");
    if (fresh.param_hash !== execution.paramHash) throw new PassportError("Parameter binding mismatch");

    // One-time consumption prevents replay.
    return this.transition(id, "CONSUMED", fresh.initiator_user_id);
  }

  private expireIfNeeded(id: string): Passport {
    const passport = this.get(id);
    if (!passport) throw new PassportError("Passport not found");
    if (
      passport.status !== "EXPIRED" &&
      passport.expires_at <= now() &&
      ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "AUTHORISED"].includes(passport.status)
    ) {
      this.db
        .prepare("UPDATE action_passports SET status = 'EXPIRED', updated_at = ? WHERE id = ?")
        .run(now(), id);
      return this.get(id)!;
    }
    return passport;
  }
}
/** True when the thrown error is a SQLite UNIQUE constraint violation. */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

