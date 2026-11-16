import { createHash, randomBytes } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

/**
 * Server-side sessions (table Sessions, migration 0012).
 *
 *  - The cookie carries 32 random bytes (base64url). The database stores only SHA-256(token): reading the Sessions
 *    table (backup, SQL injection, a curious DBA) does not give anyone a usable login.
 *  - Absolute lifetime 8 hours (set by the database trigger, not by the app), idle timeout 30 minutes (checked here).
 *  - Logout revokes the row; deactivation and password changes revoke all of a user's rows (Users trigger, 0013).
 *  - Cookie: HttpOnly (no JavaScript access), SameSite=Lax (not sent on cross-site POSTs), Path=/, and in production
 *    Secure plus the __Host- prefix (only over HTTPS, only for this exact host).
 * Why not a JWT: a self-contained token cannot be revoked before it expires, and deactivating a user must take effect
 * immediately.
 */
export const SESSION_IDLE_MINUTES = 30;
export const SESSION_MAX_AGE_SECONDS = 8 * 3600; // matches the trigger; the database is authoritative
const TOUCH_AFTER_SECONDS = 60;

export type Role = "analyst" | "admin";
export interface SessionUser { id: number; name: string; email: string; role: Role }

const production = () => process.env.NODE_ENV === "production";
export const sessionCookieName = () => (production() ? "__Host-sdb_session" : "sdb_session");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export function sessionCookie(token: string): string {
  return `${sessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${production() ? "; Secure" : ""}`;
}
export function clearedSessionCookie(): string {
  return `${sessionCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${production() ? "; Secure" : ""}`;
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function openSession(pool: Pool, userId: number, meta: { ip: string | null; userAgent: string | null }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO Sessions (token_hash, user_id, ip, user_agent) VALUES (?, ?, ?, ?)",
    [hashToken(token), userId, meta.ip, meta.userAgent?.slice(0, 200) ?? null]);
  return token;
}

/** The signed-in user for this request, or null. Expired, idle, revoked and deactivated sessions all give null. */
export async function resolveSession(pool: Pool, req: Request): Promise<{ user: SessionUser; tokenHash: string } | null> {
  const token = readCookie(req, sessionCookieName());
  if (!token || !TOKEN.test(token)) return null;
  const tokenHash = hashToken(token);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.user_id, u.name, u.email, u.role, TIMESTAMPDIFF(SECOND, s.last_seen_at, UTC_TIMESTAMP()) AS idle_seconds
       FROM Sessions s JOIN Users u ON u.user_id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
        AND s.last_seen_at > UTC_TIMESTAMP() - INTERVAL ? MINUTE AND u.is_active`,
    [tokenHash, SESSION_IDLE_MINUTES]);
  const r = rows[0];
  if (!r) return null;
  if (Number(r.idle_seconds) >= TOUCH_AFTER_SECONDS) {
    await pool.query("UPDATE Sessions SET last_seen_at = UTC_TIMESTAMP() WHERE token_hash = ? AND revoked_at IS NULL", [tokenHash]);
  }
  return { user: { id: r.user_id, name: r.name, email: r.email, role: r.role }, tokenHash };
}

export async function revokeSession(pool: Pool, tokenHash: string): Promise<void> {
  await pool.query("UPDATE Sessions SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND revoked_at IS NULL", [tokenHash]);
}
