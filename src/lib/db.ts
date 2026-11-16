import mysql from "mysql2/promise";
import type { Pool, PoolOptions, RowDataPacket } from "mysql2/promise";
import { env } from "./env";

/**
 * Two kinds of MySQL access, deliberately separated:
 *  - appPool():      runtime account used by the web server (least privilege, parameterised queries only).
 *  - migratorConn(): DDL account used by migrations / seeds / tests. Never imported by route handlers.
 */

const COMMON: Partial<PoolOptions> = {
  // The schema's collation, not mysql2's "utf8mb4" default (utf8mb4_general_ci). Stored routines and triggers capture
  // the creating connection's collation for their string literals; a mismatch makes comparisons such as
  // sdb_role(x) <> 'admin' fail with error 1267 "Illegal mix of collations" (found in M2).
  charset: "utf8mb4_0900_ai_ci",
  timezone: "Z", // DATETIME values are exchanged as UTC
  dateStrings: false,
  decimalNumbers: true,
  namedPlaceholders: false,
  multipleStatements: false, // never enabled for the app account: limits SQL-injection blast radius
};

let pool: Pool | undefined;

/** A new runtime-account pool. The app uses the shared appPool(); tests create small pools (e.g. one connection, ADR-7). */
export function createAppPool(opts: { connectionLimit?: number } = {}): Pool {
  const e = env();
  const p = mysql.createPool({
    ...COMMON,
    host: e.MYSQL_HOST,
    port: e.MYSQL_PORT,
    user: e.MYSQL_APP_USER,
    password: e.MYSQL_APP_PASSWORD,
    database: e.MYSQL_DATABASE,
    connectionLimit: opts.connectionLimit ?? 10,
    waitForConnections: true,
  });
  // Pin every pooled session to UTC so NOW()/CURRENT_TIMESTAMP agree with the driver's timezone.
  p.pool.on("connection", (c) => c.query("SET time_zone = '+00:00'"));
  return p;
}

export function appPool(): Pool {
  if (!pool) pool = createAppPool();
  return pool;
}

export async function migratorConn(database?: string) {
  const e = env();
  if (!e.MYSQL_MIGRATOR_USER || !e.MYSQL_MIGRATOR_PASSWORD) {
    throw new Error("MYSQL_MIGRATOR_USER / MYSQL_MIGRATOR_PASSWORD are required for migrations.");
  }
  const conn = await mysql.createConnection({
    ...COMMON,
    host: e.MYSQL_HOST,
    port: e.MYSQL_PORT,
    user: e.MYSQL_MIGRATOR_USER,
    password: e.MYSQL_MIGRATOR_PASSWORD,
    database: database ?? e.MYSQL_DATABASE,
    multipleStatements: true, // migration files contain several statements, incl. trigger bodies
  });
  await conn.query("SET time_zone = '+00:00'");
  return conn;
}

export async function closeAppPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Build "?, ?, ?" for a server-side prepared IN-list. Throws on empty input (an empty IN () is invalid SQL). */
export function placeholders(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error("placeholders(n) needs n >= 1");
  return Array.from({ length: n }, () => "?").join(", ");
}

export type Row<T> = T & RowDataPacket;
