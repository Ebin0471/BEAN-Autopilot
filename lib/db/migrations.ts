import type { Db } from "./database";

/**
 * Additive database migrations.
 *
 * `schema.sql` uses CREATE TABLE IF NOT EXISTS, which does NOT add new columns
 * to tables that already exist in an older database. These migrations close
 * that gap: each step is idempotent (guarded by a PRAGMA column check) so it is
 * safe to run on every startup. New columns always have a default, so existing
 * rows are preserved unchanged.
 */

interface Migration {
  name: string;
  table: string;
  column: string;
  ddl: string;
}

const MIGRATIONS: Migration[] = [
  {
    name: "ai_providers.structured_output_mode",
    table: "ai_providers",
    column: "structured_output_mode",
    ddl: "ALTER TABLE ai_providers ADD COLUMN structured_output_mode TEXT NOT NULL DEFAULT 'NONE'",
  },
  {
    name: "ai_models.structured_output_mode",
    table: "ai_models",
    column: "structured_output_mode",
    ddl: "ALTER TABLE ai_models ADD COLUMN structured_output_mode TEXT NOT NULL DEFAULT 'NONE'",
  },
];

function columnsOf(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

/** Apply all additive migrations (idempotent). */
export function runMigrations(db: Db): void {
  for (const m of MIGRATIONS) {
    const cols = columnsOf(db, m.table);
    if (!cols.has(m.column)) {
      db.exec(m.ddl);
    }
  }
}
