import { api, json, readJson } from "@/lib/http";
import { createUser, createUserSchema, listUsers } from "@/lib/repo/admin";

export const dynamic = "force-dynamic";

/** GET /api/users — all accounts (admins only). Never includes password hashes. */
export const GET = api("admin", async () => json({ users: await listUsers() }));

/** POST /api/users {name, email, password, role} — create an account (admins only). */
export const POST = api("admin", async ({ req, user }) => {
  const id = await createUser(user!, await readJson(req, createUserSchema));
  return json({ user_id: id }, 201, { Location: `/api/users/${id}` });
});
