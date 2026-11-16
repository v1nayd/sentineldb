import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { migratorConn } from "../src/lib/db";
import { migrate, resetSchema } from "../src/lib/migrate";

/**
 * Proves db/migrations/0001 is the SAME schema as the submitted Phase 1 DDL, by loading both into real MySQL
 * and comparing information_schema catalogs (columns, constraints, FKs + rules, CHECK clauses, indexes, view).
 */
const P1 = "sentineldb_p1check";
const TEST = "sentineldb_test";
const root = path.resolve(import.meta.dirname, "..");

let a: Connection, b: Connection;

async function catalog(conn: Connection, schema: string) {
  const q = async (sql: string) => (await conn.query<RowDataPacket[]>(sql, [schema]))[0].map((r) => JSON.stringify(r));
  const skip = "AND TABLE_NAME <> 'schema_migrations'";
  return {
    columns: await q(`SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME
                        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ${skip} ORDER BY TABLE_NAME, ORDINAL_POSITION`),
    constraints: await q(`SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS
                           WHERE TABLE_SCHEMA = ? ${skip} ORDER BY TABLE_NAME, CONSTRAINT_NAME`),
    keyUsage: await q(`SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
                         FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? ${skip} ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`),
    fkRules: await q(`SELECT TABLE_NAME, CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
                       WHERE CONSTRAINT_SCHEMA = ? ORDER BY TABLE_NAME, CONSTRAINT_NAME`),
    checks: await q(`SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? ORDER BY CONSTRAINT_NAME`),
    indexes: await q(`SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
                       WHERE TABLE_SCHEMA = ? ${skip} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`),
    views: (await conn.query<RowDataPacket[]>(`SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [schema]))[0]
      .map((r) => JSON.stringify({ n: r.TABLE_NAME, d: String(r.VIEW_DEFINITION).replaceAll(`\`${schema}\`.`, "") })),
  };
}

beforeAll(async () => {
  // Side A: the submitted Phase 1 file, with only its hard-coded `CREATE DATABASE/USE sentineldb` retargeted.
  a = await migratorConn(P1);
  await resetSchema(a, P1);
  const p1 = (await readFile(path.join(root, "phase1/sentineldb-ddl-mysql.sql"), "utf8"))
    .replace("CREATE DATABASE IF NOT EXISTS sentineldb;", "")
    .replace("USE sentineldb;", "");
  await a.query(p1);
  // Side B: the Phase 2 baseline migration.
  b = await migratorConn(TEST);
  await resetSchema(b, TEST);
  // Equivalence is a statement about migration 0001 ONLY; later migrations are checked separately below.
  const only0001 = await mkdtemp(path.join(os.tmpdir(), "sentineldb-0001-"));
  await copyFile(path.join(root, "db/migrations/0001_baseline_phase1_schema.sql"), path.join(only0001, "0001_baseline_phase1_schema.sql"));
  await migrate(b, only0001);
});
afterAll(async () => { await a?.end(); await b?.end(); });

describe("migration 0001 == submitted Phase 1 DDL", () => {
  it("loads all 10 base tables + the view", async () => {
    const [t] = await b.query<RowDataPacket[]>("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME <> 'schema_migrations'", [TEST]);
    expect(t[0]!.n).toBe(10);
  });
  for (const part of ["columns", "constraints", "keyUsage", "fkRules", "checks", "indexes", "views"] as const) {
    it(`catalog section "${part}" is identical`, async () => {
      const [ca, cb] = [await catalog(a, P1), await catalog(b, TEST)];
      expect(cb[part].length).toBeGreaterThan(0);
      expect(cb[part]).toEqual(ca[part]);
    });
  }
});

describe("schema delta register: the Milestone 1 follow-up changed ONLY what is documented", () => {
  // Scope: migrations 0001-0002. Milestone 2 (0003+) changes the schema on purpose; those changes are asserted by their
  // own tests (lifecycle, actor-context, procedures, evidence, analytics, grants) and listed in docs/DATA_DICTIONARY.md.
  it("after 0001-0002, the single difference from Phase 1 is Users.role DEFAULT 'analyst' (migration 0002)", async () => {
    const upTo0002 = await mkdtemp(path.join(os.tmpdir(), "sentineldb-0002-"));
    for (const f of ["0001_baseline_phase1_schema.sql", "0002_users_role_default_analyst.sql"]) {
      await copyFile(path.join(root, "db/migrations", f), path.join(upTo0002, f));
    }
    await migrate(b, upTo0002);
    const [ca, cb] = [await catalog(a, P1), await catalog(b, TEST)];
    const diff = cb.columns.filter((x) => !ca.columns.includes(x));
    expect(diff).toHaveLength(1);
    const d = JSON.parse(diff[0]!);
    expect({ ...d, TABLE_NAME: String(d.TABLE_NAME).toLowerCase() }).toMatchObject({ TABLE_NAME: "users", COLUMN_NAME: "role", COLUMN_DEFAULT: "analyst" });
    for (const part of ["constraints", "keyUsage", "fkRules", "checks", "indexes", "views"] as const) expect(cb[part]).toEqual(ca[part]);
  });
});
