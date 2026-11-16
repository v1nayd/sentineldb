import { api, idParam, json, readJson } from "@/lib/http";
import { getIncident, updateIncident, updateIncidentSchema } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** GET /api/incidents/:id — detail, evidence, notes, audit timeline and the actions you may take. 404 if not visible. */
export const GET = api<{ id: string }>("user", async ({ params, user }) => json(await getIncident(user!, idParam(params.id))));

/** PATCH /api/incidents/:id — title / narrative / severity only. Status, assignment etc. have their own endpoints. */
export const PATCH = api<{ id: string }>("user", async ({ req, params, user }) => {
  const id = idParam(params.id);
  await updateIncident(user!, id, await readJson(req, updateIncidentSchema));
  return json(await getIncident(user!, id));
});
