import type { Connection, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDdlDemo } from "../scripts/ddl-demo";
import { TEST_DB, freshSchema } from "./fixtures";

/** The DDL demonstration (CREATE / ALTER / DROP; Level 3 requirement) runs completely and leaves no trace. */
let admin: Connection;
const catalogFingerprint = async () => {
  const q = async (sql: string) => JSON.stringify((await admin.query<RowDataPacket[]>(sql, [TEST_DB]))[0]);
  return [
    await q("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"),
    await q("SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION"),
    await q("SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX"),
    await q("SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? ORDER BY CONSTRAINT_NAME"),
    await q("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME"),
  ];
};

beforeAll(async () => { admin = await freshSchema(); });
afterAll(async () => { await admin?.end(); });

describe("DDL demo (db/demo/ddl_demo.sql)", () => {
  it("executes CREATE, ALTER, CHECK enforcement, RENAME, VIEW, TRUNCATE and every kind of DROP, then leaves the schema as it was", async () => {
    const before = await catalogFingerprint();
    const results = await runDdlDemo(admin, TEST_DB);
    const sql = results.map((r) => r.sql.split("\n")[0]!.toUpperCase());
    for (const kw of ["CREATE TABLE", "ALTER TABLE DEMO_WATCHLIST ADD COLUMN", "ADD CONSTRAINT", "MODIFY COLUMN", "RENAME COLUMN", "CREATE INDEX",
      "RENAME TABLE", "CREATE VIEW", "TRUNCATE TABLE", "DROP VIEW", "DROP INDEX", "DROP CHECK", "DROP COLUMN", "DROP TABLE"]) {
      expect(sql.some((s) => s.includes(kw)), kw).toBe(true);
    }
    expect(results.filter((r) => !r.ok).map((r) => r.errno)).toEqual([3819]); // the CHECK rejected priority 9
    expect(results.at(-1)!.rows![0]!.demo_objects_left).toBe(0);
    expect(await catalogFingerprint()).toEqual(before);
  });
});
