import { randomUUID, createHash } from "node:crypto";

/** ISO-8601 UTC timestamp (portable across SQLite/PostgreSQL as TEXT). */
export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return randomUUID();
}

/** Hash arbitrary data to a stable hex digest (used for passport parameter binding). */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
