import { api, idParam, json, readJson } from "@/lib/http";
import { updateAsset, updateAssetSchema } from "@/lib/repo/admin";

export const dynamic = "force-dynamic";

/** PATCH /api/assets/:id — update inventory fields (the asset type is immutable, see db/grants.sql.tpl). */
export const PATCH = api<{ id: string }>("admin", async ({ req, params, user }) => {
  await updateAsset(user!, idParam(params.id, "asset"), await readJson(req, updateAssetSchema));
  return json({ ok: true });
});
