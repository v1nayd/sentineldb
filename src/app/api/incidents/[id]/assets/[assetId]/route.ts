import { api, idParam, json, readJson } from "@/lib/http";
import { assetImpactSchema, describeAssetImpact, unlinkAsset } from "@/lib/repo/incidents";

export const dynamic = "force-dynamic";
type P = { id: string; assetId: string };

/** PATCH /api/incidents/:id/assets/:assetId {impact_description} — describe the impact (needed before closure). */
export const PATCH = api<P>("user", async ({ req, params, user }) => {
  await describeAssetImpact(user!, idParam(params.id), idParam(params.assetId, "asset link"), (await readJson(req, assetImpactSchema)).impact_description);
  return json({ ok: true });
});

/** DELETE /api/incidents/:id/assets/:assetId — unlink (audited). */
export const DELETE = api<P>("user", async ({ params, user }) => {
  await unlinkAsset(user!, idParam(params.id), idParam(params.assetId, "asset link"));
  return json({ ok: true });
});
