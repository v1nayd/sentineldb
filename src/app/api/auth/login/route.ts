import { z } from "zod";
import { login } from "@/lib/auth/login";
import { sessionCookie } from "@/lib/auth/session";
import { api, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";
const schema = z.object({ email: z.string().trim().min(1).max(150), password: z.string().min(1).max(128) }).strict();

/** POST /api/auth/login — every failure looks the same (no account enumeration); repeated failures are rate-limited. */
export const POST = api("public", async ({ req, clientIp }) => {
  const body = await readJson(req, schema);
  const r = await login(body.email, body.password, { ip: clientIp, userAgent: req.headers.get("user-agent") });
  if (!r.ok && r.reason === "rate_limited") {
    return json({ error: { code: "rate_limited", message: "too many failed attempts; try again later" } }, 429, { "Retry-After": "900" });
  }
  if (!r.ok) return json({ error: { code: "invalid_credentials", message: "invalid e-mail or password" } }, 401);
  return json({ user: r.user }, 200, { "Set-Cookie": sessionCookie(r.token) });
});
