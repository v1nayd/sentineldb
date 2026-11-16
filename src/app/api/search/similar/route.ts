import { similarToText, textSearchSchema } from "@/lib/correlate";
import { api, json, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/search/similar {text, iocs?, asset_ids?, k?} — "have we seen this before?" for a description not yet filed. */
export const POST = api("user", async ({ req, user }) => json(await similarToText(user!, await readJson(req, textSearchSchema))));
