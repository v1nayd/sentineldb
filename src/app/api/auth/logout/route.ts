import { logout } from "@/lib/auth/login";
import { clearedSessionCookie } from "@/lib/auth/session";
import { api, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/auth/logout — revokes the session server-side (clearing the cookie alone would not be enough). */
export const POST = api("user", async ({ user, tokenHash, clientIp }) => {
  await logout(user!, tokenHash!, clientIp);
  return json({ ok: true }, 200, { "Set-Cookie": clearedSessionCookie() });
});
