import { api, idParam, json, readJson } from "@/lib/http";
import { resetPassword, resetPasswordSchema } from "@/lib/repo/admin";

export const dynamic = "force-dynamic";

/** POST /api/users/:id/password {password} — admin password reset; ends all of that user's sessions. */
export const POST = api<{ id: string }>("admin", async ({ req, params, user }) => {
  await resetPassword(user!, idParam(params.id, "user"), (await readJson(req, resetPasswordSchema)).password);
  return json({ ok: true });
});
