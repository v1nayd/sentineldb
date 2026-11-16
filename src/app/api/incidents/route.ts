import { api, json, readJson, searchParams } from "@/lib/http";
import { createIncident, createIncidentSchema, listIncidents, listSchema } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** GET /api/incidents — active incidents visible to you (analysts: reported by or assigned to you). */
export const GET = api("user", async ({ req, user }) => json(await listIncidents(user!, searchParams(req, listSchema))));

/** POST /api/incidents — report an incident; you are the reporter, it starts open and unassigned. */
export const POST = api("user", async ({ req, user }) => {
  const id = await createIncident(user!, await readJson(req, createIncidentSchema));
  return json({ incident_id: id }, 201, { Location: `/api/incidents/${id}` });
});
