import path from "node:path";
import mysql from "mysql2/promise";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { migratorConn } from "../src/lib/db";
import { resetAndMigrate } from "../src/lib/migrate";

/** Shared fixtures for the Milestone 2 database tests (real MySQL, test schema, test runtime account). */

export const TEST_DB = "sentineldb_test";
export const MIGRATIONS = path.resolve(import.meta.dirname, "../db/migrations");
export const ROOT = path.resolve(import.meta.dirname, "..");

/** Users every M2 test can rely on. 1 and 3 are analysts, 2 and 4 are admins. */
export const ANA = 1, MAX = 2, CY = 3, DEE = 4;

export const errnoOf = (e: unknown): number => (e as { errno?: number })?.errno ?? -1;
/** "SDB12" from a SIGNAL raised by our triggers/procedures, or null. Works for raw mysql2 errors and LifecycleError. */
export const sdbCode = (e: unknown): string | null => {
  const err = e as { code?: string; sqlMessage?: string; message?: string };
  if (typeof err?.code === "string" && /^SDB\d{2}$/.test(err.code)) return err.code;
  return /^(SDB\d{2}):/.exec(err?.sqlMessage ?? err?.message ?? "")?.[1] ?? null;
};
/** Awaits a promise that must fail; returns the error (fails the test if it resolves). */
export async function rejection(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected the operation to be rejected, but it succeeded");
}

/** Fresh, fully migrated test schema; returns a migrator (import-account) connection. */
export async function freshSchema(): Promise<Connection> {
  const admin = await migratorConn(TEST_DB);
  await resetAndMigrate(admin, TEST_DB, MIGRATIONS);
  await admin.query(
    `INSERT INTO Users (user_id, name, email, password_hash, role) VALUES
       (1, 'Ana Analyst', 'ana@test.example', 'h', 'analyst'), (2, 'Max Admin', 'max@test.example', 'h', 'admin'),
       (3, 'Cy Analyst', 'cy@test.example', 'h', 'analyst'),   (4, 'Dee Admin', 'dee@test.example', 'h', 'admin')`,
  );
  await admin.query(
    `INSERT INTO IOCs (ioc_id, ioc_type, ioc_value, threat_level) VALUES
       (1, 'ip', '203.0.113.10', 'high'), (2, 'domain', 'login-check.example', 'high'), (3, 'ip', '198.51.100.20', 'low')`,
  );
  await admin.query(
    `INSERT INTO Assets (asset_id, asset_name, asset_type, criticality_level) VALUES (1, 'srv-a', 'server', 4), (2, 'ws-b', 'workstation', 2)`,
  );
  return admin;
}

/** A single connection as the runtime TEST account (same grants as the web app's account). */
export async function appConn(): Promise<Connection> {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? "127.0.0.1", port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_APP_USER, password: process.env.MYSQL_APP_PASSWORD, database: TEST_DB,
    charset: "utf8mb4_0900_ai_ci",
    timezone: "Z", // same as the app pool: DATETIMEs are UTC (without this, mysql2 reads them as local time)
  });
  await c.query("SET time_zone = '+00:00'");
  try { await c.query("SELECT 1 FROM Status_Transitions LIMIT 1"); } catch (e) {
    await c.end();
    if (errnoOf(e) === 1142) throw new Error("Runtime grants are not applied to the test schema. Run: npm run db:grants");
    throw e;
  }
  return c;
}

/** Runs SQL as `actor` on a connection, then clears the actor (tests that don't go through withActor). */
export async function as<T>(conn: Connection, actor: number, fn: () => Promise<T>): Promise<T> {
  await conn.query("SET @sentinel_actor = ?", [actor]);
  try { return await fn(); } finally { await conn.query("SET @sentinel_actor = NULL, @sentinel_reason = NULL"); }
}

export async function one<T = RowDataPacket>(conn: Connection, sql: string, params: unknown[] = []): Promise<T> {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  if (rows.length !== 1) throw new Error(`expected exactly one row from: ${sql} (got ${rows.length})`);
  return rows[0] as T;
}
export async function count(conn: Connection, sql: string, params: unknown[] = []): Promise<number> {
  return Number(Object.values(await one(conn, sql, params))[0]);
}

/**
 * Creates incident `id` as `reporter` (import account), optionally driving it to a status through the procedures,
 * so tests can start from any lifecycle point. Assignee defaults to ANA; admin steps use MAX.
 */
export async function makeIncident(admin: Connection, id: number, to: "open" | "assigned" | "investigating" | "contained" | "resolved" | "closed" = "open",
  opts: { assignee?: number; iocs?: number[]; assets?: number[]; review?: boolean; impact?: boolean } = {}): Promise<void> {
  const assignee = opts.assignee ?? ANA;
  await as(admin, ANA, () => admin.query("INSERT INTO Incidents (incident_id, title, narrative, severity, reported_by) VALUES (?, ?, ?, 'high', 1)", [id, `incident ${id}`, `narrative of incident ${id}`]));
  await as(admin, ANA, async () => {
    for (const ioc of opts.iocs ?? []) await admin.query("INSERT INTO Incident_IOC (incident_id, ioc_id) VALUES (?, ?)", [id, ioc]);
    for (const a of opts.assets ?? []) await admin.query("INSERT INTO Incident_Asset (incident_id, asset_id, impact_description) VALUES (?, ?, ?)", [id, a, opts.impact === false ? null : "impact described"]);
  });
  if (to === "open") return;
  await as(admin, MAX, () => admin.query("CALL reassign_incident(?, ?, 'triage')", [id, assignee]));
  if (to === "assigned") return;
  await as(admin, assignee, () => admin.query("CALL transition_incident(?, 'investigating', NULL)", [id]));
  if (to === "investigating") return;
  if (to === "contained") { await as(admin, assignee, () => admin.query("CALL transition_incident(?, 'contained', NULL)", [id])); return; }
  if (opts.review !== false) await as(admin, assignee, () => admin.query("UPDATE Incident_IOC SET review_status = 'confirmed' WHERE incident_id = ?", [id]));
  await as(admin, assignee, () => admin.query("CALL transition_incident(?, 'resolved', NULL)", [id]));
  if (to === "resolved") return;
  await as(admin, MAX, () => admin.query("CALL close_incident(?, 'done')", [id]));
}
