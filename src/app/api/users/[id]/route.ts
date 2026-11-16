import { api, idParam, json, readJson } from "@/lib/http";
import { accountHistory, getUser, updateUser, updateUserSchema } from "@/lib/repo/admin";

export const dynamic = "force-dynamic";

/** GET /api/users/:id — account and its audit history (admins only). */
export const GET = api<{ id: string }>("admin", async ({ params }) => {
  const id = idParam(params.id, "user");
  return json({ user: await getUser(id), history: await accountHistory(id) });
});

/** PATCH /api/users/:id {role?, active?} — change role or (de)activate (admins only; the last admin is protected). */
export const PATCH = api<{ id: string }>("admin", async ({ req, params, user }) => {
  const id = idParam(params.id, "user");
  await updateUser(user!, id, await readJson(req, updateUserSchema));
  return json({ user: await getUser(id) });
});
