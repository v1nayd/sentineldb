import type { Pool, PoolConnection } from "mysql2/promise";
import { appPool } from "./db";

/**
 * Session context for every write (ADR-7).
 *
 * Triggers and procedures learn WHO is acting from the session variable @sentinel_actor (migration 0006), and read a
 * reason from @sentinel_reason. Session variables live as long as the physical connection, NOT the transaction, so on a
 * pooled connection a value left behind would attribute the next borrower's actions to the previous user.
 *
 * withActor() is therefore the only way application code should get a connection for writing:
 *   1. borrow a connection, SET the context (and explicitly NULL everything else, in case a previous borrower leaked),
 *   2. run `fn` inside a transaction (commit on success, roll back on any error),
 *   3. in `finally`, ALWAYS clear the variables, after success, error and rollback alike;
 *   4. if clearing fails (broken connection), destroy the connection instead of returning it to the pool.
 *
 * @sentinel_clock is cleared too. The runtime account cannot back-date anything (only the import account's clock is
 * honoured, see sdb_now()), but leaving a stray value on a pooled connection would be confusing, so it never survives.
 */

const CLEAR = "SET @sentinel_actor = NULL, @sentinel_reason = NULL, @sentinel_clock = NULL";

export class InvalidActorError extends Error {
  constructor(actorId: unknown) {
    super(`withActor: actor id must be a positive integer, got ${String(actorId)}`);
  }
}

export async function withActor<T>(actorId: number, fn: (conn: PoolConnection) => Promise<T>, pool: Pool = appPool()): Promise<T> {
  if (!Number.isSafeInteger(actorId) || actorId < 1) throw new InvalidActorError(actorId);
  const conn = await pool.getConnection();
  let reusable = true;
  try {
    await conn.query("SET @sentinel_actor = ?, @sentinel_reason = NULL, @sentinel_clock = NULL", [actorId]);
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback().catch(() => { reusable = false; });
      throw e;
    }
  } finally {
    try {
      await conn.query(CLEAR);
    } catch {
      reusable = false;
    }
    if (reusable) conn.release();
    else conn.destroy(); // never hand a connection with unknown session state to the next borrower
  }
}
