import { api, json, readJson } from "@/lib/http";
import { createAsset, createAssetSchema, listAssets } from "@/lib/repo/admin";

export const dynamic = "force-dynamic";

/** GET /api/assets — the asset inventory (every signed-in user: analysts link assets to incidents). */
export const GET = api("user", async () => json({ assets: await listAssets() }));

/** POST /api/assets — register an asset (admins manage the inventory, spec section 10). */
export const POST = api("admin", async ({ req, user }) => json({ asset_id: await createAsset(user!, await readJson(req, createAssetSchema)) }, 201));
