import { api, idParam, json, readJson } from "@/lib/http";
import { getIncident, transition, transitionSchema } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** POST /api/incidents/:id/transition {to, reason?} — move along the lifecycle (not to closed: use /close). */
export const POST = api<{ id: string }>("user", async ({ req, params, user }) => {
  const id = idParam(params.id);
  const body = await readJson(req, transitionSchema);
  await transition(user!, id, body.to, body.reason);
  return json(await getIncident(user!, id));
});
