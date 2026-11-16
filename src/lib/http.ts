import { z } from "zod";
import { appPool } from "./db";
import { env } from "./env";
import { LifecycleError, toLifecycleError, type LifecycleCode } from "./lifecycle";
import { resolveSession, type SessionUser } from "./auth/session";

/**
 * The one wrapper every API route goes through, so the security checks cannot be forgotten route by route:
 *
 *   1. CSRF: a state-changing request (anything but GET/HEAD) must come from APP_ORIGIN (Origin header), or carry
 *      Sec-Fetch-Site: same-origin when a browser omits Origin. Cross-site form posts and fetches are refused (403).
 *   2. Authentication: the session cookie is resolved server-side (src/lib/auth/session.ts); "user" and "admin" routes
 *      answer 401 without a valid session; "admin" routes answer 403 for analysts.
 *   3. A per-user (or per-anonymous) request budget: 300 requests per minute, in memory, per process.
 *   4. Errors become JSON { error: { code, message } } with a status code. Database rule violations (SDBnn) map to 4xx;
 *      anything unexpected is logged server-side and answered as a generic 500 (no SQL, no stack traces to clients).
 *   5. Every response is marked no-store and nosniff.
 * Request bodies are parsed with strict zod schemas: unknown fields (e.g. "status", "assigned_to", "reported_by" in an
 * incident PATCH) are rejected with 400 instead of being silently ignored — no mass assignment.
 */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const notFound = (what = "incident") => new HttpError(404, "not_found", `${what} not found`);

export type Access = "public" | "user" | "admin";
export interface ApiContext<P> {
  req: Request;
  params: P;
  user: SessionUser | null;
  tokenHash: string | null;
  clientIp: string | null;
}
type RouteContext = { params: Promise<Record<string, string>> };

const SECURITY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

const STATUS_BY_CODE: Partial<Record<LifecycleCode, number>> = {
  SDB01: 500, SDB02: 401, SDB10: 409, SDB11: 403, SDB12: 409, SDB13: 409, SDB14: 409, SDB15: 409,
  SDB16: 400, SDB17: 400, SDB30: 400, SDB31: 404, SDB40: 409, SDB41: 403, SDB42: 400, SDB43: 500, SDB44: 404,
};

export function errorResponse(err: unknown): Response {
  const e = toLifecycleError(err); // raw SIGNAL errors from repository queries become LifecycleErrors too
  if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
  if (e instanceof LifecycleError) {
    const status = STATUS_BY_CODE[e.code] ?? 400;
    if (status >= 500) {
      console.error(`[api] database rule ${e.code} reached from the API (a bug):`, e.message);
      return json({ error: { code: "internal", message: "internal error" } }, status);
    }
    return json({ error: { code: e.kind, rule: e.code, message: e.message } }, status);
  }
  if (e instanceof z.ZodError) {
    const message = e.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    return json({ error: { code: "invalid_request", message } }, 400);
  }
  const errno = (e as { errno?: number })?.errno;
  if (errno === 1062) return json({ error: { code: "conflict", message: "already exists" } }, 409);
  if (errno === 1452) return json({ error: { code: "invalid_reference", message: "referenced record does not exist" } }, 400);
  console.error("[api] unexpected error:", e);
  return json({ error: { code: "internal", message: "internal error" } }, 500);
}

function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (origin !== env().APP_ORIGIN) throw new HttpError(403, "cross_origin", "cross-origin request refused");
    return;
  }
  if (req.headers.get("sec-fetch-site") !== "same-origin") throw new HttpError(403, "cross_origin", "request origin could not be verified");
}

export function clientIp(req: Request): string | null {
  if (env().TRUST_PROXY_HEADERS !== "true") return null;
  const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && first.length <= 45 ? first : null;
}

// Fixed-window request budget per key. In memory and per process: a brake on runaway clients, not a security boundary
// (login brute force is limited separately in MySQL, src/lib/auth/login.ts).
const BUDGET = { requests: 300, windowMs: 60_000 };
const windows = new Map<string, { start: number; count: number }>();
function spend(key: string): void {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= BUDGET.windowMs) {
    if (windows.size > 10_000) windows.clear();
    windows.set(key, { start: now, count: 1 });
    return;
  }
  if (++w.count > BUDGET.requests) throw new HttpError(429, "rate_limited", "too many requests");
}
export function resetRequestBudgets(): void { windows.clear(); } // tests

export function api<P extends Record<string, string> = Record<string, never>>(
  access: Access, handler: (ctx: ApiContext<P>) => Promise<Response>,
): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, routeCtx) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const session = await resolveSession(appPool(), req);
      if (access !== "public" && !session) throw new HttpError(401, "unauthenticated", "sign in required");
      if (access === "admin" && session!.user.role !== "admin") throw new HttpError(403, "forbidden", "admin role required");
      const ip = clientIp(req);
      spend(session ? `u:${session.user.id}` : `a:${ip ?? "unknown"}`);
      const params = ((await routeCtx?.params) ?? {}) as P;
      return await handler({ req, params, user: session?.user ?? null, tokenHash: session?.tokenHash ?? null, clientIp: ip });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

const MAX_BODY_BYTES = 64 * 1024;
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "send application/json");
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "request body too large");
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new HttpError(400, "invalid_json", "body is not valid JSON"); }
  return schema.parse(data);
}

export function searchParams<T>(req: Request, schema: z.ZodType<T>): T {
  return schema.parse(Object.fromEntries(new URL(req.url).searchParams));
}

/** Route ids are positive integers; anything else is "not found" (it cannot name a row). */
export function idParam(raw: string | undefined, what = "incident"): number {
  if (!raw || !/^[1-9][0-9]{0,9}$/.test(raw)) throw notFound(what);
  return Number(raw);
}
