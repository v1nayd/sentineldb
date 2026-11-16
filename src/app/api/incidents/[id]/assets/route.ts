import { api, idParam, json, readJson } from "@/lib/http";
import { assetLinkSchema, linkAsset } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";

/** POST /api/incidents/:id/assets {asset_id, impact_description?} — link an affected asset. */
export const POST = api<{ id: string }>("user", async ({ req, params, user }) => {
  await linkAsset(user!, idParam(params.id), await readJson(req, assetLinkSchema));
  return json({ ok: true }, 201);
});
