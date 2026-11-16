import { api, idParam, json, readJson } from "@/lib/http";
import { iocLinkSchema, linkIoc } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** POST /api/incidents/:id/iocs {ioc_type, ioc_value, threat_level?, notes?} — link an IOC (registered if new). */
export const POST = api<{ id: string }>("user", async ({ req, params, user }) => {
  const iocId = await linkIoc(user!, idParam(params.id), await readJson(req, iocLinkSchema));
  return json({ ioc_id: iocId }, 201);
});
