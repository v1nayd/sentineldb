import { api, idParam, json, readJson } from "@/lib/http";
import { getIncident, reassign, reassignSchema } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** POST /api/incidents/:id/reassign {assignee, reason} — admins only; atomic with its audit row and handover note. */
export const POST = api<{ id: string }>("admin", async ({ req, params, user }) => {
  const id = idParam(params.id);
  const body = await readJson(req, reassignSchema);
  await reassign(user!, id, body.assignee, body.reason);
  return json(await getIncident(user!, id));
});
