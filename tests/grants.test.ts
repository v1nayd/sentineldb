import path from "node:path";
import mysql from "mysql2/promise";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratorConn } from "../src/lib/db";
import { migrate, resetSchema } from "../src/lib/migrate";

/**
 * Proves the runtime account's privileges by EXECUTING SQL as that account (not by reading the grant script).
 * Runs as MYSQL_APP_TEST_USER: identical grants to the runtime account, test schema only.
 * Precondition: `npm run db:grants` has been run (table/column grants survive DROP/CREATE of the schema by name).
 */
const TEST_DB = "sentineldb_test";
const base = () => ({ host: process.env.MYSQL_HOST ?? "127.0.0.1", port: Number(process.env.MYSQL_PORT ?? 3306) });

let admin: Connection; // migrator: arranges data only
let app: Connection;   // the account under test

/** Resolves to the MySQL errno of a rejected query, or 0 if it unexpectedly succeeded. */
const errnoOf = async (sql: string, params: unknown[] = []): Promise<number> => {
  try { await app.query(sql, params); return 0; } catch (e) { return (e as { errno?: number }).errno ?? -1; }
};
const TABLE_DENIED = 1142;   // ER_TABLEACCESS_DENIED_ERROR
const COLUMN_DENIED = 1143;  // ER_COLUMNACCESS_DENIED_ERROR

beforeAll(async () => {
  admin = await migratorConn(TEST_DB);
  await resetSchema(admin, TEST_DB);
  await migrate(admin, path.resolve(import.meta.dirname, "../db/migrations"));
  await admin.query("INSERT INTO Users (user_id,name,email,password_hash,role) VALUES (1,'A','a@x.example','h','analyst'),(2,'M','m@x.example','h','admin')");
  // M2: every incident/evidence/note write needs an acting user; the origin history row (NULL -> open) is written by the trigger.
  await admin.query("SET @sentinel_actor = 1");
  await admin.query("INSERT INTO Incidents (incident_id,title,narrative,severity,reported_by) VALUES (1,'seed','seed narrative','low',1)");
  await admin.query("INSERT INTO Notes (incident_id,author_id,content) VALUES (1,1,'seed note')");
  app = await mysql.createConnection({ ...base(), user: process.env.MYSQL_APP_USER, password: process.env.MYSQL_APP_PASSWORD, database: TEST_DB });
  await app.query("SET @sentinel_actor = 1"); // the privilege checks below are about GRANTS; the actor lets permitted writes pass the triggers
  try { await app.query("SELECT 1 FROM Incidents LIMIT 1"); } catch (e) {
    if ((e as { errno?: number }).errno === TABLE_DENIED) throw new Error("Runtime grants are not applied. Run: npm run db:grants");
    throw e;
  }
});
afterAll(async () => { await app?.end(); await admin?.end(); });

describe("runtime account: what it MAY do", () => {
  it("creates an incident with only user-supplied columns; status/resolved_at/created_at take safe defaults", async () => {
    const [r] = await app.query<mysql.ResultSetHeader>("INSERT INTO Incidents (title, narrative, severity, reported_by) VALUES ('t','n','high',1)");
    const [rows] = await app.query<RowDataPacket[]>("SELECT status, resolved_at, assigned_to FROM Incidents WHERE incident_id = ?", [r.insertId]);
    expect(rows[0]).toMatchObject({ status: "open", resolved_at: null, assigned_to: null });
  });
  it("edits descriptive columns, appends notes, links evidence, reads the view", async () => {
    expect(await errnoOf("UPDATE Incidents SET title='renamed', narrative='n2', severity='medium' WHERE incident_id=1")).toBe(0);
    expect(await errnoOf("INSERT INTO Notes (incident_id, author_id, content) VALUES (1,1,'another')")).toBe(0);
    expect(await errnoOf("INSERT INTO IOCs (ioc_type, ioc_value, threat_level) VALUES ('ip','203.0.113.77','low')")).toBe(0);
    expect(await errnoOf("INSERT INTO Incident_IOC (incident_id, ioc_id) SELECT 1, ioc_id FROM IOCs WHERE ioc_value='203.0.113.77'")).toBe(0);
    expect(await errnoOf("DELETE FROM Incident_IOC WHERE incident_id=1")).toBe(0); // association edits are allowed
    expect(await errnoOf("SELECT * FROM analyst_workload_view")).toBe(0);
  });
});

describe("runtime account: what it may NOT do (executed, not assumed)", () => {
  it("cannot insert an incident directly in a non-open state or with back-dated timestamps", async () => {
    expect(await errnoOf("INSERT INTO Incidents (title,narrative,severity,reported_by,status) VALUES ('x','x','low',1,'closed')")).toBe(COLUMN_DENIED);
    expect(await errnoOf("INSERT INTO Incidents (title,narrative,severity,reported_by,resolved_at) VALUES ('x','x','low',1,NOW())")).toBe(COLUMN_DENIED);
    expect(await errnoOf("INSERT INTO Incidents (title,narrative,severity,reported_by,created_at) VALUES ('x','x','low',1,'2020-01-01')")).toBe(COLUMN_DENIED);
  });
  it("cannot change status, resolved_at or assignment directly (those go through procedures in Milestone 2)", async () => {
    expect(await errnoOf("UPDATE Incidents SET status='closed' WHERE incident_id=1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Incidents SET resolved_at=NOW() WHERE incident_id=1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Incidents SET assigned_to=2 WHERE incident_id=1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Incidents SET reported_by=2 WHERE incident_id=1")).toBe(COLUMN_DENIED);
  });
  it("cannot write, alter or delete audit history (any of the three audit tables)", async () => {
    const total = async () => (await admin.query<RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM Incident_Status_History) + (SELECT COUNT(*) FROM Incident_Assignment_History) + (SELECT COUNT(*) FROM Incident_Evidence_History) AS n"))[0][0]!.n;
    const before = await total();
    for (const t of ["Incident_Status_History", "Incident_Assignment_History", "Incident_Evidence_History"]) {
      expect(await errnoOf(`INSERT INTO ${t} (incident_id) VALUES (1)`), t).toBe(TABLE_DENIED);
      expect(await errnoOf(`UPDATE ${t} SET incident_id = 1`), t).toBe(TABLE_DENIED);
      expect(await errnoOf(`DELETE FROM ${t}`), t).toBe(TABLE_DENIED);
    }
    expect(await total()).toBe(before); // untouched
  });
  it("cannot change lifecycle reference data or archive/derived/review-attribution columns directly", async () => {
    expect(await errnoOf("INSERT INTO Status_Transitions (from_status,to_status,description) VALUES ('open','closed','shortcut')")).toBe(TABLE_DENIED);
    expect(await errnoOf("UPDATE Incidents SET archived_at = NOW(), archived_by = 1, archive_reason = 'x' WHERE incident_id = 1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Incidents SET narrative_version = 9 WHERE incident_id = 1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Incident_IOC SET reviewed_by = 2")).toBe(COLUMN_DENIED);
  });
  it("cannot delete incidents, users, assets, IOCs or playbooks (so ON DELETE CASCADE can never fire from the app)", async () => {
    for (const t of ["Incidents", "Users", "Assets", "IOCs", "Playbooks"]) {
      expect(await errnoOf(`DELETE FROM ${t}`), `DELETE FROM ${t}`).toBe(TABLE_DENIED);
    }
    expect(await errnoOf("TRUNCATE TABLE Incidents")).toBe(TABLE_DENIED);
  });
  it("notes are append-only", async () => {
    expect(await errnoOf("UPDATE Notes SET content='tampered'")).toBe(TABLE_DENIED);
    expect(await errnoOf("DELETE FROM Notes")).toBe(TABLE_DENIED);
    expect(await errnoOf("INSERT INTO Notes (incident_id,author_id,content,created_at) VALUES (1,1,'backdated','2020-01-01')")).toBe(COLUMN_DENIED);
  });
  it("cannot read migration state, run DDL, or grant privileges", async () => {
    expect(await errnoOf("SELECT * FROM schema_migrations")).toBe(TABLE_DENIED);
    expect(await errnoOf("CREATE TABLE evil (id INT)")).toBe(TABLE_DENIED);
    expect(await errnoOf("ALTER TABLE Incidents ADD COLUMN x INT")).toBe(TABLE_DENIED);
    expect(await errnoOf("DROP TABLE Notes")).toBe(TABLE_DENIED);
    // Rejected (with binary logging on MySQL reports 1419 before it even checks TRIGGER); what matters is that the trigger
    // does not exist (the schema's own M2 triggers do, created by the migrator), and the existing ones cannot be dropped.
    expect(await errnoOf("CREATE TRIGGER evil BEFORE INSERT ON Incidents FOR EACH ROW SET NEW.title = 'x'")).not.toBe(0);
    const [trg] = await admin.query<RowDataPacket[]>("SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = 'evil'", [TEST_DB]);
    expect(trg[0]!.n).toBe(0);
    expect(await errnoOf("DROP TRIGGER trg_incidents_before_update")).not.toBe(0);
    expect(await errnoOf("CREATE PROCEDURE evil_p() SELECT 1")).not.toBe(0);
    expect(await errnoOf("CREATE VIEW evil_v AS SELECT * FROM Users")).toBe(TABLE_DENIED);
    expect([1044, 1045, 1142, 1227]).toContain(await errnoOf("GRANT SELECT ON sentineldb_test.* TO 'sentinel_app_test'@'%'"));
  });
  it("holds no schema-wide or ALL grants (SHOW GRANTS)", async () => {
    const [rows] = await app.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER()");
    const lines = rows.map((r) => String(Object.values(r)[0]));
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) {
      expect(l).not.toMatch(/ALL PRIVILEGES/i);
      expect(l).not.toMatch(/ON `[^`]+`\.\*/); // no db-level grant
      expect(l).not.toMatch(/WITH GRANT OPTION/i);
    }
  });
});

describe("privilege escalation attempts (review: runtime account must not create or promote administrators)", () => {
  const adminCount = async () => (await admin.query<RowDataPacket[]>("SELECT COUNT(*) n FROM Users WHERE role='admin'"))[0][0]!.n as number;

  // Milestone 3: the runtime account has NO write grant on Users (accounts change only through the account procedures,
  // which check the acting admin) and cannot read password_hash (login reads it through auth_lookup).
  it("cannot create users by SQL at all (any column set, upsert or REPLACE)", async () => {
    for (const sql of [
      "INSERT INTO Users (name,email,password_hash) VALUES ('Ord','ord@x.example','h')",
      "INSERT INTO Users (name,email,password_hash,role) VALUES ('Evil','evil@x.example','h','admin')",
      "INSERT INTO Users (name,email,password_hash) VALUES ('A','a@x.example','h') ON DUPLICATE KEY UPDATE role='admin'",
      "REPLACE INTO Users (name,email,password_hash) VALUES ('A','a@x.example','h')",
    ]) expect(await errnoOf(sql), sql).toBe(TABLE_DENIED);
  });
  it("cannot promote an analyst or change any account field by SQL", async () => {
    const before = await adminCount();
    for (const sql of [
      "UPDATE Users SET role='admin' WHERE user_id=1", "UPDATE Users SET role='admin'",
      "UPDATE Users u JOIN Users v ON v.user_id=u.user_id SET u.role=v.role WHERE u.user_id=1",
      "UPDATE Users SET email='takeover@x.example' WHERE user_id=2", "UPDATE Users SET password_hash='h2' WHERE user_id=2",
      "UPDATE Users SET is_active=FALSE WHERE user_id=2", "UPDATE Users SET name='Renamed' WHERE user_id=1",
    ]) expect([TABLE_DENIED, COLUMN_DENIED], sql).toContain(await errnoOf(sql)); // the JOIN form is refused at column level
    expect(await adminCount()).toBe(before);
    const [r] = await admin.query<RowDataPacket[]>("SELECT role FROM Users WHERE user_id=1");
    expect(r[0]!.role).toBe("analyst");
  });
  it("cannot read password hashes, not even indirectly in a WHERE clause; reads every other account column", async () => {
    expect(await errnoOf("SELECT password_hash FROM Users")).toBe(COLUMN_DENIED);
    expect(await errnoOf("SELECT user_id FROM Users WHERE password_hash = 'h'")).toBe(COLUMN_DENIED);
    expect(await errnoOf("SELECT * FROM Users")).toBe(TABLE_DENIED);
    expect(await errnoOf("SELECT user_id, name, email, role, is_active, deactivated_at, deactivated_by, password_changed_at, created_at FROM Users")).toBe(0);
  });
  it("Assets: key and classification are immutable; ordinary inventory fields are editable", async () => {
    await admin.query("INSERT INTO Assets (asset_id,asset_name,asset_type,criticality_level) VALUES (1,'srv','server',3)");
    expect(await errnoOf("UPDATE Assets SET asset_id=77 WHERE asset_id=1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Assets SET asset_type='workstation' WHERE asset_id=1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("INSERT INTO Assets (asset_id,asset_name,asset_type,criticality_level) VALUES (88,'x','server',1)")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Assets SET criticality_level=5, owner_department='IT', ip_address='10.0.0.9', asset_name='srv2', last_audited_at=NOW() WHERE asset_id=1")).toBe(0);
    expect(await errnoOf("INSERT INTO Assets (asset_name,asset_type,criticality_level) VALUES ('new','application',2)")).toBe(0);
  });
  it("Playbooks: key and authorship are immutable; content is editable; Incident_Playbook.applied_at is DB-clocked", async () => {
    await admin.query("INSERT INTO Playbooks (playbook_id,name,created_by) VALUES (1,'pb',2)");
    expect(await errnoOf("UPDATE Playbooks SET created_by=1 WHERE playbook_id=1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Playbooks SET playbook_id=9 WHERE playbook_id=1")).toBe(COLUMN_DENIED);
    expect(await errnoOf("INSERT INTO Playbooks (playbook_id,name) VALUES (50,'x')")).toBe(COLUMN_DENIED);
    expect(await errnoOf("UPDATE Playbooks SET name='pb2', steps_description='s', applicable_incident_type='phishing' WHERE playbook_id=1")).toBe(0);
    expect(await errnoOf("INSERT INTO Playbooks (name, created_by) VALUES ('mine', 1)")).toBe(0);
    expect(await errnoOf("INSERT INTO Incident_Playbook (incident_id,playbook_id,applied_at) VALUES (1,1,'2000-01-01')")).toBe(COLUMN_DENIED);
    expect(await errnoOf("INSERT INTO Incident_Playbook (incident_id,playbook_id) VALUES (1,1)")).toBe(0);
  });
});

describe("exact privilege matrix (guards against future drift: any added grant fails this test)", () => {
  // Source of truth is what MySQL actually reports for the account, compared with an explicit allow-list.
  const EXPECTED_TABLE = [
    "Assets:SELECT", "Incidents:SELECT", "IOCs:SELECT", "IOCs:INSERT",
    "Incident_IOC:SELECT", "Incident_IOC:INSERT", "Incident_IOC:DELETE",
    "Incident_Asset:SELECT", "Incident_Asset:INSERT", "Incident_Asset:DELETE",
    "Playbooks:SELECT", "Incident_Playbook:SELECT", "Incident_Playbook:DELETE",
    "Incident_Status_History:SELECT", "Notes:SELECT", "analyst_workload_view:SELECT",
    // Milestone 2: audit tables and the state machine are read-only; analytic views are read-only
    "Incident_Assignment_History:SELECT", "Incident_Evidence_History:SELECT", "Status_Transitions:SELECT",
    "incident_summary_view:SELECT", "severity_status_matrix_view:SELECT", "workload_by_assignee_view:SELECT",
    "mttr_by_severity_view:SELECT", "recurring_ioc_view:SELECT", "monthly_trend_view:SELECT",
    // Milestone 3: sessions, authentication log and account history (Users itself is column-level only, below)
    "Sessions:SELECT", "Auth_Events:SELECT", "User_Account_History:SELECT",
    // Milestone 4: the outbox (jobs are created by triggers; the worker reads them and moves their state) + sync view
    "Embedding_Jobs:SELECT", "incident_sync_view:SELECT",
  ].map((x) => x.toLowerCase()).sort();
  const col = (t: string, priv: string, cols: string[]) => cols.map((c) => `${t}.${c}:${priv}`);
  const EXPECTED_COLUMN = [
    ...col("Users", "SELECT", ["user_id", "name", "email", "role", "is_active", "deactivated_at", "deactivated_by", "password_changed_at", "created_at"]),
    ...col("Sessions", "INSERT", ["token_hash", "user_id", "ip", "user_agent"]), ...col("Sessions", "UPDATE", ["last_seen_at", "revoked_at"]),
    ...col("Auth_Events", "INSERT", ["event_type", "email_attempted", "user_id", "ip"]),
    ...col("Assets", "INSERT", ["asset_name", "asset_type", "ip_address", "criticality_level", "owner_department"]),
    ...col("Assets", "UPDATE", ["asset_name", "ip_address", "criticality_level", "owner_department", "last_audited_at"]),
    ...col("Incidents", "INSERT", ["title", "narrative", "severity", "reported_by"]), ...col("Incidents", "UPDATE", ["title", "narrative", "severity"]),
    ...col("IOCs", "UPDATE", ["threat_level"]), ...col("Incident_IOC", "UPDATE", ["notes", "review_status"]), ...col("Incident_Asset", "UPDATE", ["impact_description"]),
    ...col("Playbooks", "INSERT", ["name", "applicable_incident_type", "steps_description", "created_by"]),
    ...col("Playbooks", "UPDATE", ["name", "applicable_incident_type", "steps_description"]),
    ...col("Incident_Playbook", "INSERT", ["incident_id", "playbook_id"]),
    ...col("Notes", "INSERT", ["incident_id", "author_id", "content"]),
    ...col("Embedding_Jobs", "INSERT", ["incident_id", "narrative_version", "action"]),
    ...col("Embedding_Jobs", "UPDATE", ["status", "attempts", "available_at", "locked_at", "locked_by", "last_error", "finished_at"]),
  ].map((x) => x.toLowerCase()).sort();
  const EXPECTED_EXECUTE = ["archive_incident", "auth_lookup", "close_incident", "create_user", "reassign_incident",
    "set_password_hash", "set_user_active", "set_user_role", "transition_incident"];

  it("table-level and column-level privileges equal the allow-list, exactly", async () => {
    const [[me]] = await app.query<RowDataPacket[][]>("SELECT CURRENT_USER() AS u");
    const [user, host] = String((me as RowDataPacket).u).split("@");
    const grantee = `'${user}'@'${host}'`;
    const [t] = await app.query<RowDataPacket[]>("SELECT TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ?", [grantee]);
    const [c] = await app.query<RowDataPacket[]>("SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, PRIVILEGE_TYPE FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ?", [grantee]);
    expect(t.every((r) => r.TABLE_SCHEMA === TEST_DB && r.IS_GRANTABLE === "NO")).toBe(true);
    expect(c.every((r) => r.TABLE_SCHEMA === TEST_DB)).toBe(true);
    // lower-cased: on Windows (lower_case_table_names = 1) the catalog reports table names in lower case
    expect(t.map((r) => `${r.TABLE_NAME}:${r.PRIVILEGE_TYPE}`.toLowerCase()).sort()).toEqual(EXPECTED_TABLE);
    expect(c.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}:${r.PRIVILEGE_TYPE}`.toLowerCase()).sort()).toEqual(EXPECTED_COLUMN);
  });
  it("routine privileges: EXECUTE on exactly the four lifecycle procedures, nothing else (SHOW GRANTS)", async () => {
    const [rows] = await app.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER()");
    const routine = rows.map((r) => String(Object.values(r)[0])).filter((l) => /\bON (PROCEDURE|FUNCTION)\b/i.test(l));
    expect(routine.every((l) => /^GRANT EXECUTE ON PROCEDURE /i.test(l))).toBe(true);
    expect(routine.map((l) => /`\.`([^`]+)`/.exec(l)![1]!.toLowerCase()).sort()).toEqual(EXPECTED_EXECUTE);
  });
});

describe("account separation", () => {
  it("the dev runtime account cannot reach the test schema, and the test account cannot reach the dev schema", async () => {
    const devAttempt = mysql.createConnection({ ...base(), user: process.env.DEV_APP_USER, password: process.env.DEV_APP_PASSWORD, database: TEST_DB });
    await expect(devAttempt).rejects.toMatchObject({ errno: 1044 });
    const testAttempt = mysql.createConnection({ ...base(), user: process.env.MYSQL_APP_USER, password: process.env.MYSQL_APP_PASSWORD, database: "sentineldb" });
    await expect(testAttempt).rejects.toMatchObject({ errno: 1044 });
  });
});
