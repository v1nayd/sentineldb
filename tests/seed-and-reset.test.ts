import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { migratorConn } from "../src/lib/db";
import { loadMigrations, migrate, resetAndMigrate, resetSchema, withSchemaLock } from "../src/lib/migrate";
import { assertEmptyForSeed, DatabaseNotEmptyError, nonEmptyTables } from "../src/lib/seed-guard";

const DB = "sentineldb_test";
const MIG = path.resolve(import.meta.dirname, "../db/migrations");
const LOCK = `sentineldb:migrate:${DB}`;
let conn: Connection;
let other: Connection;
// Windows MySQL stores table names in lower case (lower_case_table_names = 1); compare case-insensitively.
const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());

beforeAll(async () => { conn = await migratorConn(DB); other = await migratorConn(DB); });
afterAll(async () => { await conn?.end(); await other?.end(); });

describe("seed precondition: EVERY application table must be empty", () => {
  it("accepts a freshly migrated database", async () => {
    await resetAndMigrate(conn, DB, MIG);
    expect(await nonEmptyTables(conn)).toEqual([]);
    await expect(assertEmptyForSeed(conn)).resolves.toBeUndefined();
  });

  it("rejects a partially populated database, naming the offending tables (the old Users+Incidents check passed all of these)", async () => {
    const cases: Array<[string, string]> = [
      ["Assets", "INSERT INTO Assets (asset_name,asset_type,criticality_level) VALUES ('stray','server',1)"],
      ["IOCs", "INSERT INTO IOCs (ioc_type,ioc_value) VALUES ('ip','203.0.113.1')"],
      ["Playbooks", "INSERT INTO Playbooks (name) VALUES ('stray playbook')"],
    ];
    for (const [table, insert] of cases) {
      await resetAndMigrate(conn, DB, MIG);
      await conn.query(insert);
      expect(lower(await nonEmptyTables(conn)), table).toEqual([table.toLowerCase()]);
      const err = await assertEmptyForSeed(conn).catch((e) => e);
      expect(err).toBeInstanceOf(DatabaseNotEmptyError);
      expect(lower((err as DatabaseNotEmptyError).tables)).toEqual([table.toLowerCase()]);
      expect((err as Error).message).toMatch(/db:reset/);
    }
    await resetAndMigrate(conn, DB, MIG);
  });

  it("covers tables added by later migrations automatically (list comes from the live catalog)", async () => {
    await conn.query("CREATE TABLE future_table (id INT PRIMARY KEY)");
    await conn.query("INSERT INTO future_table VALUES (1)");
    expect(await nonEmptyTables(conn)).toEqual(["future_table"]);
    await resetAndMigrate(conn, DB, MIG);
  });

  it("reference tables filled by migrations (TABLE_COMMENT 'reference:...') do not count as data", async () => {
    await resetAndMigrate(conn, DB, MIG);
    const [r] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) n FROM Status_Transitions");
    expect(r[0]!.n).toBeGreaterThan(0);
    expect(await nonEmptyTables(conn)).toEqual([]);
  });

  it("the shipped spike seed loads into an empty database and a second load is refused", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(path.resolve(import.meta.dirname, "../db/seed/spike_seed.sql"), "utf8");
    await withSchemaLock(conn, DB, 5, async () => { await assertEmptyForSeed(conn); await conn.query(sql); });
    const [n] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) c FROM Incidents");
    expect(n[0]!.c).toBe(12);
    await expect(assertEmptyForSeed(conn)).rejects.toBeInstanceOf(DatabaseNotEmptyError);
    await resetAndMigrate(conn, DB, MIG);
  });
});

describe("destructive reset is protected by the same lock as migrations", () => {
  it("refuses to reset while another session holds the schema lock, and leaves the database untouched", async () => {
    await resetAndMigrate(conn, DB, MIG);
    await conn.query("INSERT INTO Assets (asset_name,asset_type,criticality_level) VALUES ('keep me','server',1)");
    const [[held]] = await other.query<RowDataPacket[][]>("SELECT GET_LOCK(?, 0) AS got", [LOCK]);
    expect((held as RowDataPacket).got).toBe(1);
    try {
      await expect(resetSchema(conn, DB, { lockTimeoutSec: 1 })).rejects.toThrow(/holds the lock/);
      await expect(resetAndMigrate(conn, DB, MIG, { lockTimeoutSec: 1 })).rejects.toThrow(/holds the lock/);
      const [a] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) c FROM Assets");
      expect(a[0]!.c).toBe(1); // the DROP never ran
    } finally {
      await other.query("SELECT RELEASE_LOCK(?)", [LOCK]);
    }
    await resetAndMigrate(conn, DB, MIG);
  });

  it("two concurrent reset+migrate runs serialise and both succeed with a consistent schema (no DROP under a running migration)", async () => {
    const [r1, r2] = await Promise.all([
      resetAndMigrate(conn, DB, MIG, { lockTimeoutSec: 60 }),
      resetAndMigrate(other, DB, MIG, { lockTimeoutSec: 60 }),
    ]);
    expect(r1.applied.length).toBeGreaterThan(0);
    expect(r2.applied.length).toBeGreaterThan(0);
    const [t] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'", [DB]);
    // 10 Phase 1 tables + Status_Transitions, Incident_Assignment_History, Incident_Evidence_History (M2)
    // + User_Account_History, Sessions, Auth_Events (M3) + Embedding_Jobs (M4) + schema_migrations
    expect(t[0]!.n).toBe(18);
    const [m] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) n FROM schema_migrations");
    expect(m[0]!.n).toBe((await loadMigrations(MIG)).length);
  });

  it("a failing migration still releases the lock (no stuck lock after an error)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sdb-fail-"));
    try {
      await writeFile(path.join(dir, "0001_bad.sql"), "THIS IS NOT SQL;");
      await expect(resetAndMigrate(conn, DB, dir)).rejects.toThrow();
      const [[free]] = await other.query<RowDataPacket[][]>("SELECT IS_FREE_LOCK(?) AS f", [LOCK]);
      expect((free as RowDataPacket).f).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await resetAndMigrate(conn, DB, MIG);
    }
  });

  it("plain migrate() on an already reset schema still works", async () => {
    expect((await migrate(conn, MIG)).alreadyApplied).toHaveLength((await loadMigrations(MIG)).length);
  });
});
