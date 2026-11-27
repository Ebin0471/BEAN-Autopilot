import type { Db } from "@/lib/db/database";
import { now, uuid, sha256 } from "@/lib/db/util";
import type { ActorType } from "./types";

export interface AuditInput {
  workspaceId: string;
  actorId: string;
  actorType: ActorType;
  eventType: string;
  targetType?: string | null;
  targetId?: string | null;
  result: "SUCCESS" | "DENIED" | "FAILURE";
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

export interface AuditEvent {
  id: string;
  workspace_id: string;
  actor_id: string;
  actor_type: string;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  metadata: string;
  prev_hash: string | null;
  event_hash: string;
  request_id: string | null;
  created_at: string;
}

/** Keys that must never be persisted to audit metadata. */
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|otp|private[_-]?key|credential|session)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Append-only audit service with a global hash chain for tamper detection.
 * Reads are workspace-scoped. Integrity is verified by recomputing the chain.
 */
export class AuditService {
  constructor(private db: Db) {}

  append(input: AuditInput): string {
    const eventId = uuid();
    const createdAt = now();
    const prevHash = this.lastHash();
    const metadata = JSON.stringify(redact(input.metadata ?? {}));
    const canonical = [
      eventId,
      input.workspaceId,
      input.actorId,
      input.actorType,
      input.eventType,
      input.targetType ?? "",
      input.targetId ?? "",
      input.result,
      metadata,
      prevHash ?? "",
      input.requestId ?? "",
      createdAt,
    ].join("|");
    const eventHash = sha256(canonical);

    this.db
      .prepare(
        `INSERT INTO audit_events
         (id, workspace_id, actor_id, actor_type, event_type, target_type, target_id,
          result, metadata, prev_hash, event_hash, request_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        input.workspaceId,
        input.actorId,
        input.actorType,
        input.eventType,
        input.targetType ?? null,
        input.targetId ?? null,
        input.result,
        metadata,
        prevHash,
        eventHash,
        input.requestId ?? null,
        createdAt,
      );
    return eventId;
  }

  private lastHash(): string | null {
    const row = this.db
      .prepare("SELECT event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1")
      .get() as { event_hash: string } | undefined;
    return row?.event_hash ?? null;
  }

  list(workspaceId: string, limit = 100): AuditEvent[] {
    return this.db
      .prepare("SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY rowid DESC LIMIT ?")
      .all(workspaceId, limit) as unknown as AuditEvent[];
  }

  /** Recompute the hash chain. Returns validity and the number of events checked. */
  verifyChain(): { valid: boolean; count: number; breakAt?: string } {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY rowid ASC")
      .all() as unknown as AuditEvent[];
    let prev: string | null = null;
    for (const row of rows) {
      const canonical = [
        row.id,
        row.workspace_id,
        row.actor_id,
        row.actor_type,
        row.event_type,
        row.target_type ?? "",
        row.target_id ?? "",
        row.result,
        row.metadata,
        row.prev_hash ?? "",
        row.request_id ?? "",
        row.created_at,
      ].join("|");
      if (sha256(canonical) !== row.event_hash) return { valid: false, count: rows.length, breakAt: row.id };
      if (prev !== null && row.prev_hash !== prev) return { valid: false, count: rows.length, breakAt: row.id };
      prev = row.event_hash;
    }
    return { valid: true, count: rows.length };
  }
}
