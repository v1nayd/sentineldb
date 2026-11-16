import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Connection, RowDataPacket } from "mysql2/promise";

/**
 * Minimal, explicit SQL migration runner.
 *  - Files: db/migrations/NNNN_name.sql, applied in numeric order, each exactly once.
 *  - Applied files are checksummed (sha256). If an applied file is later edited, we refuse to continue:
 *    history is immutable; fixes go in a new migration.
 *  - MySQL DDL auto-commits, so a migration is NOT atomic. A failed file can leave partial changes; the
 *    runner records a migration only after it fully succeeds, and migrations are written to be re-runnable
 *    after a manual `db:reset` in development. (This is a MySQL limitation, documented in docs/.)
 */

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const out: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const file of entries) {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Migration file name must look like 0001_snake_case.sql, got: ${file}`);
    const version = Number(m[1]);
    const name = m[2]!;
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    const sql = await readFile(path.join(dir, file), "utf8");
    out.push({ version, name, file, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return out;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrateOptions {
  /** Seconds to wait for another migration/reset/seed run on the same schema before giving up. */
  lockTimeoutSec?: number;
}

const SAFE_DB = /^[A-Za-z0-9_]+$/;
const lockNameFor = (database: string) => `sentineldb:migrate:${database}`.slice(0, 64);

/**
 * Runs `fn` while holding a server-side named lock scoped to the schema. Migrations, destructive resets and seeds all
 * take THE SAME lock, so none can interleave with another (non-atomic DDL, DROP DATABASE under a running migration,
 * two seeders racing past the emptiness check). GET_LOCK is by name, not by schema, so it works even while the schema
 * itself is being dropped; it is released automatically if the connection dies.
 */
export async function withSchemaLock<T>(conn: Connection, database: string, lockTimeoutSec: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (!SAFE_DB.test(database)) throw new Error("Unsafe database name");
  const lockName = lockNameFor(database);
  const [[lockRow]] = await conn.query<RowDataPacket[][]>("SELECT GET_LOCK(?, ?) AS got", [lockName, lockTimeoutSec ?? 30]);
  if ((lockRow as RowDataPacket | undefined)?.got !== 1) {
    throw new Error("Another migration run holds the lock for this schema; refusing to run concurrently.");
  }
  try {
    return await fn();
  } finally {
    await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
  }
}

export async function migrate(conn: Connection, dir: string, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const [[dbRow]] = await conn.query<RowDataPacket[][]>("SELECT DATABASE() AS d");
  const database = String((dbRow as RowDataPacket | undefined)?.d ?? "");
  return withSchemaLock(conn, database, opts.lockTimeoutSec, () => applyAll(conn, dir));
}

async function applyAll(conn: Connection, dir: string): Promise<MigrateResult> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      checksum   CHAR(64) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

  const [rows] = await conn.query<RowDataPacket[]>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
  const done = new Map<number, string>(rows.map((r) => [r.version as number, r.checksum as string]));

  const files = await loadMigrations(dir);
  const result: MigrateResult = { applied: [], alreadyApplied: [] };

  for (const f of files) {
    const recorded = done.get(f.version);
    if (recorded !== undefined) {
      if (recorded !== f.checksum) {
        throw new Error(`Migration ${f.file} was modified after being applied (checksum mismatch). Add a new migration instead.`);
      }
      result.alreadyApplied.push(f.file);
      continue;
    }
    await conn.query(f.sql);
    await conn.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)", [f.version, f.name, f.checksum]);
    result.applied.push(f.file);
  }
  return result;
}

async function dropAndCreate(conn: Connection, database: string): Promise<void> {
  await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await conn.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await conn.query(`USE \`${database}\``);
}

/** Drop every object in the schema and recreate it empty. Dev/test only: callers must guard the schema name. Takes the schema lock. */
export async function resetSchema(conn: Connection, database: string, opts: MigrateOptions = {}): Promise<void> {
  await withSchemaLock(conn, database, opts.lockTimeoutSec, () => dropAndCreate(conn, database));
}

/** Reset then migrate under ONE continuous lock, so nothing can slip in between the DROP and the first migration. */
export async function resetAndMigrate(conn: Connection, database: string, dir: string, opts: MigrateOptions = {}): Promise<MigrateResult> {
  return withSchemaLock(conn, database, opts.lockTimeoutSec, async () => {
    await dropAndCreate(conn, database);
    return applyAll(conn, dir);
  });
}
