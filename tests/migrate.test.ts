import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { migratorConn } from "../src/lib/db";
import { loadMigrations, migrate, resetSchema } from "../src/lib/migrate";

let conn: Connection;
let dir: string;
const DB = "sentineldb_test";

beforeAll(async () => {
  conn = await migratorConn(DB);
  dir = await mkdtemp(path.join(os.tmpdir(), "sdb-mig-"));
});
afterAll(async () => { await conn?.end(); await rm(dir, { recursive: true, force: true }); });

describe("migration runner (real MySQL)", () => {
  it("applies each file once, in order, and is idempotent on re-run", async () => {
    await resetSchema(conn, DB);
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE t1 (id INT PRIMARY KEY);");
    await writeFile(path.join(dir, "0002_b.sql"), "CREATE TABLE t2 (id INT PRIMARY KEY, t1_id INT, FOREIGN KEY (t1_id) REFERENCES t1(id));");
    const r1 = await migrate(conn, dir);
    expect(r1.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    const r2 = await migrate(conn, dir);
    expect(r2.applied).toEqual([]);
    expect(r2.alreadyApplied).toHaveLength(2);
    const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) n FROM schema_migrations");
    expect(rows[0]!.n).toBe(2);
  });

  it("refuses to continue when an already-applied migration file was edited", async () => {
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE t1 (id INT PRIMARY KEY, sneaky INT);");
    await expect(migrate(conn, dir)).rejects.toThrow(/modified after being applied/);
  });

  it("rejects bad file names and duplicate versions", async () => {
    const d2 = await mkdtemp(path.join(os.tmpdir(), "sdb-mig2-"));
    await writeFile(path.join(d2, "1_bad.sql"), "SELECT 1;");
    await expect(loadMigrations(d2)).rejects.toThrow(/must look like/);
    await rm(path.join(d2, "1_bad.sql"));
    await writeFile(path.join(d2, "0001_a.sql"), "SELECT 1;");
    await writeFile(path.join(d2, "0001_b.sql"), "SELECT 1;");
    await expect(loadMigrations(d2)).rejects.toThrow(/Duplicate/);
    await rm(d2, { recursive: true, force: true });
  });

  it("does not record a migration whose SQL fails (so it can be fixed and re-run)", async () => {
    await resetSchema(conn, DB);
    const d3 = await mkdtemp(path.join(os.tmpdir(), "sdb-mig3-"));
    await writeFile(path.join(d3, "0001_ok.sql"), "CREATE TABLE ok1 (id INT PRIMARY KEY);");
    await writeFile(path.join(d3, "0002_broken.sql"), "CREATE TABLE ok2 (id INT PRIMARY KEY); THIS IS NOT SQL;");
    await expect(migrate(conn, d3)).rejects.toThrow();
    const [rows] = await conn.query<RowDataPacket[]>("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.map((r) => r.version)).toEqual([1]);
    await rm(d3, { recursive: true, force: true });
  });

  it("refuses to reset an unsafe database name", async () => {
    await expect(resetSchema(conn, "x`; DROP DATABASE mysql; --")).rejects.toThrow(/Unsafe/);
  });

  it("serialises concurrent runs with a schema-scoped lock (second runner refuses instead of interleaving DDL)", async () => {
    await resetSchema(conn, DB);
    const d4 = await mkdtemp(path.join(os.tmpdir(), "sdb-mig4-"));
    await writeFile(path.join(d4, "0001_a.sql"), "CREATE TABLE lk (id INT PRIMARY KEY);");
    const other = await migratorConn(DB);
    try {
      const [[held]] = await other.query<RowDataPacket[][]>("SELECT GET_LOCK('sentineldb:migrate:sentineldb_test', 0) AS got");
      expect((held as RowDataPacket).got).toBe(1);
      await expect(migrate(conn, d4, { lockTimeoutSec: 1 })).rejects.toThrow(/Another migration run holds the lock/);
      await other.query("SELECT RELEASE_LOCK('sentineldb:migrate:sentineldb_test')");
      expect((await migrate(conn, d4, { lockTimeoutSec: 1 })).applied).toEqual(["0001_a.sql"]);
    } finally {
      await other.end();
      await rm(d4, { recursive: true, force: true });
    }
  });
});
