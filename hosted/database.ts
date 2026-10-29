import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadHostedConfig, requireHostedEnabled } from "./config";
import type { HostedContext } from "./schema";

const transactionDepth = new WeakMap<DatabaseSync, number>();
export function withHostedTransaction<T>(
  db: DatabaseSync,
  callback: () => T,
): T {
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = `hosted_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  transactionDepth.set(db, depth + 1);
  try {
    const result = callback();
    if (result && typeof result === "object" && "then" in result)
      throw new Error("Hosted transactions must be synchronous");
    db.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(
      depth === 0
        ? "ROLLBACK"
        : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
    );
    throw error;
  } finally {
    transactionDepth.set(db, depth);
  }
}
export function migrateHostedDatabase(db: DatabaseSync): void {
  withHostedTransaction(db, () => {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1)
      throw new Error("Unsupported hosted schema version");
    if (version === 1) return;
    db.exec(
      readFileSync(
        resolve(process.cwd(), "hosted/migrations/001-initial.sql"),
        "utf8",
      ),
    );
    db.prepare(
      "INSERT INTO hosted_metadata(key,value) VALUES('installation_id',?)",
    ).run(randomUUID());
    db.exec("PRAGMA user_version=1");
  });
}
export function openHostedDatabase({
  path,
  busyTimeoutMs = 5000,
}: {
  path: string;
  busyTimeoutMs?: number;
}): DatabaseSync {
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 30000
  )
    throw new Error("Invalid busy timeout");
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA trusted_schema=OFF;`,
    );
    migrateHostedDatabase(db);
    if (path !== ":memory:") chmodSync(path, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
let defaultContext: HostedContext | undefined;
export function getHostedContext(): HostedContext {
  if (defaultContext) return defaultContext;
  const config = loadHostedConfig();
  requireHostedEnabled(config);
  defaultContext = { config, db: openHostedDatabase({ path: config.dbPath }) };
  return defaultContext;
}
