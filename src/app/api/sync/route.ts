import { z } from "zod";
import { api, json, readJson } from "@/lib/http";
import { repair, runSync, syncStatus } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** GET /api/sync — outbox state: jobs by action/status, incidents by index state, recent failures (admin). */
export const GET = api("admin", async () => json(await syncStatus()));

const runSchema = z.object({ action: z.enum(["run", "repair"]) }).strict();

/**
 * POST /api/sync {action} — admin: "run" processes due jobs now (at most 500 per request); "repair" first reconciles
 * MySQL with Qdrant and re-queues / deletes what differs. Normally the worker process (npm run sync:worker) does this.
 */
export const POST = api("admin", async ({ req }) => {
  const { action } = await readJson(req, runSchema);
  const repaired = action === "repair" ? await repair() : null;
  const run = await runSync({ maxJobs: 500 });
  return json({ repaired: repaired && { queued: repaired.queued, deleted_points: repaired.deleted, in_sync_before: repaired.before.inSync }, run, status: await syncStatus() });
});
