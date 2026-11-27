import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SqliteDb } from "./sqlite-shim";
import { runMigrations } from "./migrations";

// Resolve the schema relative to the project root. `process.cwd()` is reliable
// in both `next dev` and `next start`, whereas `import.meta.url` is mis-bundled
// by webpack for server route handlers.
const SCHEMA_PATH = path.join(process.cwd(), "lib", "db", "schema.sql");
const SCHEMA = fs.readFileSync(SCHEMA_PATH, "utf8");

export type Db = SqliteDb;

let db: Db | null = null;

/** Initialise (or re-initialise) a database at the given location and apply the schema. */
export function initDb(location: string): Db {
  if (location !== ":memory:") {
    fs.mkdirSync(path.dirname(location), { recursive: true });
  }
  const database = new DatabaseSync(location, { enableForeignKeyConstraints: true });
  database.exec(SCHEMA);
  runMigrations(database);
  return database;
}

/** Application singleton, configured via BEAN_DB_PATH (defaults to ./.bean/bean.db). */
export function getDb(): Db {
  if (!db) {
    const location = process.env.BEAN_DB_PATH ?? path.join(process.cwd(), ".bean", "bean.db");
    db = initDb(location);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Run a callback inside a transaction, rolling back on any thrown error. */
export function withTransaction<T>(database: Db, fn: () => T): T {
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}
