import { createRequire } from "node:module";

/**
 * Runtime shim for the experimental `node:sqlite` module.
 *
 * Vite 1.6 does not recognise `node:sqlite` as a built-in and mis-resolves it.
 * Loading the built-in through `createRequire` (CJS, resolved at runtime) keeps
 * this working under Vitest/Node without a native add-on.
 */
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqlite = require("node:sqlite") as typeof import("node:sqlite");

/** The SQLite database instance type. */
export type SqliteDb = InstanceType<typeof sqlite.DatabaseSync>;

export const DatabaseSync = sqlite.DatabaseSync;
