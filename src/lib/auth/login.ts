import type { Pool, RowDataPacket } from "mysql2/promise";
import { withActor } from "../actor";
import { appPool } from "../db";
import { hashPassword, verifyPassword } from "./password";
import { openSession, revokeSession, type SessionUser } from "./session";

/**
 * Login, logout bookkeeping and self-service password change.
 *
 * Rate limiting is counted from Auth_Events in MySQL, so it holds across restarts and across app processes:
 *   - per e-mail: 5 failed attempts in 15 minutes  -> further attempts for that e-mail are refused (even with the right
 *     password) until the window passes;
 *   - per IP: 20 failures in 15 minutes, ONLY when the client IP is known (TRUST_PROXY_HEADERS behind a proxy; Next.js
 *     route handlers do not expose the socket address);
 *   - global: 100 failures in 1 minute across all accounts (crude password-spraying brake that needs no IP).
 * Failures are indistinguishable to the caller: unknown e-mail, wrong password, deactivated account and accounts without
 * a usable hash all return the same answer after the same scrypt cost.
 */
export const LOGIN_LIMITS = { perEmail: 5, perIp: 20, global: 100, windowMinutes: 15, globalWindowMinutes: 1 } as const;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export interface ClientMeta { ip: string | null; userAgent: string | null }
export type LoginResult =
  | { ok: true; user: SessionUser; token: string }
  | { ok: false; reason: "invalid_credentials" | "rate_limited" };

async function authEvent(pool: Pool, type: string, email: string | null, userId: number | null, ip: string | null) {
  await pool.query("INSERT INTO Auth_Events (event_type, email_attempted, user_id, ip) VALUES (?, ?, ?, ?)",
    [type, email?.slice(0, 150) ?? null, userId, ip]);
}

async function isRateLimited(pool: Pool, email: string, ip: string | null): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM Auth_Events WHERE event_type = 'login_failure' AND email_attempted = ?
                AND created_at > UTC_TIMESTAMP() - INTERVAL ? MINUTE) AS by_email,
            (SELECT COUNT(*) FROM Auth_Events WHERE event_type = 'login_failure' AND ip = ?
                AND created_at > UTC_TIMESTAMP() - INTERVAL ? MINUTE) AS by_ip,
            (SELECT COUNT(*) FROM Auth_Events WHERE event_type = 'login_failure'
                AND created_at > UTC_TIMESTAMP() - INTERVAL ? MINUTE) AS global_failures`,
    [email, LOGIN_LIMITS.windowMinutes, ip, LOGIN_LIMITS.windowMinutes, LOGIN_LIMITS.globalWindowMinutes]);
  const r = rows[0]!;
  return Number(r.by_email) >= LOGIN_LIMITS.perEmail
    || (ip !== null && Number(r.by_ip) >= LOGIN_LIMITS.perIp)
    || Number(r.global_failures) >= LOGIN_LIMITS.global;
}

interface Account { user_id: number; name: string; email: string; role: "analyst" | "admin"; is_active: number; password_hash: string }

/** The only read of a password hash in the application: through the DEFINER procedure, one exact e-mail. */
export async function lookupAccount(email: string, pool: Pool = appPool()): Promise<Account | null> {
  const [res] = await pool.query<RowDataPacket[][]>("CALL auth_lookup(?)", [email]);
  return ((res[0] ?? [])[0] as Account | undefined) ?? null;
}

export async function login(emailInput: string, password: string, meta: ClientMeta, pool: Pool = appPool()): Promise<LoginResult> {
  const email = normalizeEmail(emailInput);
  if (await isRateLimited(pool, email, meta.ip)) {
    await authEvent(pool, "login_blocked", email, null, meta.ip);
    return { ok: false, reason: "rate_limited" };
  }
  const account = await lookupAccount(email, pool);
  const check = await verifyPassword(account?.password_hash, password); // same cost whether or not the account exists
  if (!account || !account.is_active || !check.ok) {
    await authEvent(pool, "login_failure", email, account?.user_id ?? null, meta.ip);
    return { ok: false, reason: "invalid_credentials" };
  }
  if (check.needsRehash) {
    // Parameters were raised since this hash was made: upgrade it now that we know the password (before the session
    // opens, because storing a new hash revokes the user's sessions).
    const fresh = await hashPassword(password);
    await withActor(account.user_id, (c) => c.query("CALL set_password_hash(?, ?)", [account.user_id, fresh]), pool);
  }
  const token = await openSession(pool, account.user_id, meta);
  await authEvent(pool, "login_success", email, account.user_id, meta.ip);
  return { ok: true, token, user: { id: account.user_id, name: account.name, email: account.email, role: account.role } };
}

export async function logout(user: SessionUser, tokenHash: string, ip: string | null, pool: Pool = appPool()): Promise<void> {
  await revokeSession(pool, tokenHash);
  await authEvent(pool, "logout", user.email, user.id, ip);
}

/**
 * Changes the signed-in user's own password after re-checking the current one. Storing the new hash revokes ALL of
 * the user's sessions (trigger), including this one; the caller gets a fresh session token back.
 */
export async function changeOwnPassword(user: SessionUser, current: string, next: string, meta: ClientMeta, pool: Pool = appPool()):
  Promise<{ ok: true; token: string } | { ok: false }> {
  const account = await lookupAccount(user.email, pool);
  const check = await verifyPassword(account?.password_hash, current);
  if (!account || account.user_id !== user.id || !check.ok) {
    await authEvent(pool, "login_failure", user.email, user.id, meta.ip); // counts towards the per-account limit
    return { ok: false };
  }
  const fresh = await hashPassword(next);
  await withActor(user.id, (c) => c.query("CALL set_password_hash(?, ?)", [user.id, fresh]), pool);
  await authEvent(pool, "password_changed", user.email, user.id, meta.ip);
  return { ok: true, token: await openSession(pool, user.id, meta) };
}
