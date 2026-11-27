// Minimal type shim for Node's built-in experimental `node:sqlite` module.
// The runtime is provided by Node >= 22.5; @types/node 20 does not yet declare it.
declare module "node:sqlite" {
  export interface StatementResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    run(...params: unknown[]): StatementResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export interface DatabaseSyncOptions {
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }
  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
