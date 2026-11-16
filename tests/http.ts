import type { Connection } from "mysql2/promise";
import { hashPassword } from "../src/lib/auth/password";
import { sessionCookieName } from "../src/lib/auth/session";
import * as loginRoute from "../src/app/api/auth/login/route";

/**
 * HTTP-level test helpers. Route handlers are plain (Request, context) => Response functions, so the tests call the
 * exact exported handlers Next.js serves, with real Request objects, cookies and headers, against the real test
 * database (no mocks). tests/e2e-smoke.ts additionally exercises them through a running `next start`.
 */
export const ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";
export const PASSWORD = "correct horse battery staple"; // test-only, >= 12 characters
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export interface CallOptions {
  path?: string;
  body?: unknown;
  cookie?: string | null;
  params?: Record<string, string>;
  origin?: string | null;      // null = send no Origin header
  headers?: Record<string, string>;
  rawBody?: string;
}
export interface Result { status: number; body: any; headers: Headers; text: string }

export async function call(handler: Handler | undefined, method: string, o: CallOptions = {}): Promise<Result> {
  if (!handler) throw new Error(`route does not export ${method}`);
  const headers: Record<string, string> = { ...o.headers };
  if (o.cookie) headers.cookie = o.cookie;
  if (method !== "GET" && o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.body !== undefined || o.rawBody !== undefined) headers["content-type"] ??= "application/json";
  const req = new Request(`${ORIGIN}${o.path ?? "/api/test"}`, {
    method, headers, body: o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
  });
  const res = await handler(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers, text };
}

/** "name=value" from a Set-Cookie header, ready to send back as a Cookie header. */
export function cookieFrom(res: Result): string {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error(`no Set-Cookie in response (status ${res.status}: ${res.text})`);
  return set.split(";")[0]!;
}

export async function login(email: string, password = PASSWORD): Promise<string> {
  const r = await call(loginRoute.POST, "POST", { path: "/api/auth/login", body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${r.text}`);
  return cookieFrom(r);
}

let shared: Promise<string> | undefined;
/** Gives every fixture user the same real scrypt hash of PASSWORD (computed once per test file). */
export async function setPasswords(admin: Connection): Promise<void> {
  const hash = await (shared ??= hashPassword(PASSWORD));
  await admin.query("SET @sentinel_actor = NULL");
  await admin.query("UPDATE Users SET password_hash = ?", [hash]); // import account, bootstrap path (no actor)
}

export const cookieName = sessionCookieName;
