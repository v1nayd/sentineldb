import { changeOwnPassword } from "@/lib/auth/login";
import { sessionCookie } from "@/lib/auth/session";
import { api, HttpError, json, readJson } from "@/lib/http";
import { changeOwnPasswordSchema } from "@/lib/repo/admin";

export const dynamic = "force-dynamic";

/** POST /api/auth/password — change your own password. All your sessions end; this response carries a fresh one. */
export const POST = api("user", async ({ req, user, clientIp }) => {
  const body = await readJson(req, changeOwnPasswordSchema);
  const r = await changeOwnPassword(user!, body.current_password, body.new_password, { ip: clientIp, userAgent: req.headers.get("user-agent") });
  if (!r.ok) throw new HttpError(403, "invalid_credentials", "current password is not correct");
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(r.token) });
});
