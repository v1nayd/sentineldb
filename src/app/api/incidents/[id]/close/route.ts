import { api, idParam, json, readJson } from "@/lib/http";
import { close, getIncident, reasonSchema } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** POST /api/incidents/:id/close {reason?} — admins only; 409 while an IOC is unreviewed or an asset impact undescribed. */
export const POST = api<{ id: string }>("admin", async ({ req, params, user }) => {
  const id = idParam(params.id);
  await close(user!, id, (await readJson(req, reasonSchema)).reason);
  return json(await getIncident(user!, id));
});
