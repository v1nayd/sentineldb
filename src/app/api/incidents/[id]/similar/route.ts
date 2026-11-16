import { similarQuerySchema, similarToIncident } from "@/lib/correlate";
import { api, idParam, json, searchParams } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/incidents/:id/similar?k=10 — incidents like this one, ranked by text similarity + shared IOCs + shared assets,
 * each with its score components and a plain-language explanation. Only incidents you may see are ranked.
 */
export const GET = api<{ id: string }>("user", async ({ req, params, user }) =>
  json(await similarToIncident(user!, idParam(params.id), searchParams(req, similarQuerySchema).k)));
