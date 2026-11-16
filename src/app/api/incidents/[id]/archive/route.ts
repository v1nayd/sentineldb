import { api, idParam, json, readJson } from "@/lib/http";
import { archive, getIncident, requiredReasonSchema } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** POST /api/incidents/:id/archive {reason} — admins only, closed incidents only. Archived incidents become read-only. */
export const POST = api<{ id: string }>("admin", async ({ req, params, user }) => {
  const id = idParam(params.id);
  await archive(user!, id, (await readJson(req, requiredReasonSchema)).reason);
  return json(await getIncident(user!, id));
});
