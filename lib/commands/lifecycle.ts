import type { Db } from "@/lib/db/database";
import { now, uuid } from "@/lib/db/util";
import { AuditService } from "@/lib/security/audit";
import { EXECUTION_TRANSITIONS, type ExecutionState } from "./types";
import { IdempotencyConflictError } from "./canonical";

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export interface ExecutionRecord {
  id: string;
  workspace_id: string;
  actor_id: string;
  command_id: string;
  command_version: string;
  capability_id: string | null;
  passport_id: string | null;
  target_type: string | null;
  target_id: string | null;
  params_hash: string;
  status: ExecutionState;
  idempotency_key: string;
  adapter_id: string | null;
  result: string | null;
  evidence: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * Execution lifecycle manager. Tracks accepted, blocked, pending, executing,
 * verified and failed operations with an explicit state machine. Invalid
 * transitions fail. Records are persisted and audited.
 */
export class ExecutionLifecycleManager {
  constructor(private db: Db, private audit: AuditService) {}

  create(input: {
    workspaceId: string;
    actorId: string;
    commandId: string;
    commandVersion: string;
    capabilityId?: string | null;
    passportId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    paramsHash: string;
    idempotencyKey: string;
  }): ExecutionRecord {
    const id = uuid();
    const ts = now();

    // Idempotency is scoped to (workspace, key) AND the complete canonical
    // request. The same key reused for a different canonical payload (command,
    // args, capability, target, version or execution options) is a conflict and
    // must never return the unrelated prior record.
    const existing = this.findByIdempotency(input.workspaceId, input.idempotencyKey);
    if (existing) {
      if (existing.params_hash === input.paramsHash) {
        // Identical canonical request: safely return the existing record.
        return existing;
      }
      throw new IdempotencyConflictError(
        `Idempotency key reused for a different request in workspace ${input.workspaceId}`,
        input.workspaceId,
        input.idempotencyKey,
      );
    }

    try {
      this.db
        .prepare(
          `INSERT INTO command_executions
           (id, workspace_id, actor_id, command_id, command_version, capability_id, passport_id,
            target_type, target_id, params_hash, status, idempotency_key, adapter_id, result, evidence,
            error_code, created_at, updated_at, completed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'RECEIVED', ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          id,
          input.workspaceId,
          input.actorId,
          input.commandId,
          input.commandVersion,
          input.capabilityId ?? null,
          input.passportId ?? null,
          input.targetType ?? null,
          input.targetId ?? null,
          input.paramsHash,
          input.idempotencyKey,
          ts,
          ts,
        );
    } catch (err) {
      // Concurrent duplicate insert: the (workspace, key) UNIQUE constraint
      // fired. Re-read and reconcile — same canonical payload replays, a
      // different one is an explicit conflict.
      if (isUniqueConstraintError(err)) {
        const raced = this.findByIdempotency(input.workspaceId, input.idempotencyKey);
        if (raced && raced.params_hash === input.paramsHash) return raced;
        if (raced) {
          throw new IdempotencyConflictError(
            `Idempotency key reused for a different request in workspace ${input.workspaceId}`,
            input.workspaceId,
            input.idempotencyKey,
          );
        }
      }
      throw err;
    }
    return this.get(id)!;
  }

  get(id: string): ExecutionRecord | undefined {
    return this.db.prepare("SELECT * FROM command_executions WHERE id = ?").get(id) as
      | ExecutionRecord
      | undefined;
  }

  list(workspaceId: string, limit = 50): ExecutionRecord[] {
    return this.db
      .prepare("SELECT * FROM command_executions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, limit) as unknown as ExecutionRecord[];
  }

  /** Find an execution by workspace + idempotency key (for idempotent replay). */
  findByIdempotency(workspaceId: string, idempotencyKey: string): ExecutionRecord | undefined {
    return this.db
      .prepare("SELECT * FROM command_executions WHERE workspace_id = ? AND idempotency_key = ?")
      .get(workspaceId, idempotencyKey) as ExecutionRecord | undefined;
  }

  /** Transition an execution, enforcing the state machine. */
  transition(
    id: string,
    to: ExecutionState,
    opts?: { result?: unknown; evidence?: unknown; errorCode?: string; adapterId?: string },
  ): ExecutionRecord {
    const rec = this.get(id);
    if (!rec) throw new LifecycleError("Execution not found");
    if (!EXECUTION_TRANSITIONS[rec.status].includes(to)) {
      throw new LifecycleError(`Invalid transition ${rec.status} -> ${to}`);
    }
    const ts = now();
    this.db
      .prepare(
        `UPDATE command_executions
         SET status = ?, result = ?, evidence = ?, error_code = ?, adapter_id = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        to,
        opts?.result ? JSON.stringify(opts.result) : null,
        opts?.evidence ? JSON.stringify(opts.evidence) : null,
        opts?.errorCode ?? null,
        opts?.adapterId ?? null,
        ts,
        isTerminal(to) ? ts : null,
        id,
      );
    this.audit.append({
      workspaceId: rec.workspace_id,
      actorId: rec.actor_id,
      actorType: "USER",
      eventType: "COMMAND_LIFECYCLE",
      targetType: "execution",
      targetId: id,
      result: to === "FAILED" || to === "CANCELLED" ? "FAILURE" : "SUCCESS",
      metadata: { from: rec.status, to, commandId: rec.command_id },
    });
    return this.get(id)!;
  }
}

function isTerminal(state: ExecutionState): boolean {
  return (
    state === "VERIFIED" ||
    state === "FAILED" ||
    state === "CANCELLED" ||
    state === "COMPENSATED"
  );
}

/** True when the thrown error is a SQLite UNIQUE constraint violation. */
function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}
