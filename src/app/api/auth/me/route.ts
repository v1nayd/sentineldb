import { api, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/auth/me — the signed-in user (id, name, e-mail, role). */
export const GET = api("user", async ({ user }) => json({ user }));
