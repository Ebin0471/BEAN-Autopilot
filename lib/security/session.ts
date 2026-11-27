import { randomBytes } from "node:crypto";
import type { Db } from "@/lib/db/database";
import { now, sha256 } from "@/lib/db/util";
import { AuditService } from "./audit";

export interface Session {
  id: string; // sha256(token) — the raw token is never stored
  user_id: string;
  device_label: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface SessionToken {
  token: string;
  sessionId: string;
  expiresAt: string;
}

/**
 * Session management. Sessions are identified by a random token whose SHA-256
 * hash is the stored primary key — the raw token is never persisted. Cookies
 * are set HTTP-only by the route handlers; this service handles lifecycle only.
 */
export class SessionService {
  constructor(private db: Db, private audit: AuditService) {}

  createSession(userId: string, deviceLabel?: string | null, ttlHours = 12): SessionToken {
    const token = randomBytes(32).toString("hex");
    const sessionId = sha256(token);
    const ts = now();
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, device_label, created_at, last_seen_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,NULL)",
      )
      .run(sessionId, userId, deviceLabel ?? null, ts, ts, expiresAt);
    return { token, sessionId, expiresAt };
  }

  /** Verify a token. Returns the session only if valid, not revoked and not expired. */
  verify(token: string | undefined | null): Session | null {
    if (!token) return null;
    const sessionId = sha256(token);
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | Session
      | undefined;
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at <= now()) return null;
    return row;
  }

  revoke(token: string | undefined | null): boolean {
    if (!token) return false;
    const sessionId = sha256(token);
    const result = this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now(), sessionId);
    return Number(result.changes) > 0;
  }

  revokeUserSessions(userId: string): void {
    this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(now(), userId);
  }

  touch(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now(), sessionId);
  }
}
