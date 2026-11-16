/**
 * The outbox worker as a process (src/lib/sync.ts).
 *   npm run sync:worker              keep running: process due jobs, then poll every 2 s (Ctrl+C to stop)
 *   npm run sync:worker -- --once    process everything due now and exit (scripts, CI)
 *   npm run sync:worker -- --repair  reconcile MySQL with Qdrant, re-queue / delete what differs, process, print the result
 * Runs as the least-privilege app account: it can only move jobs through their states and read incidents.
 */
import { loadEnv } from "../src/lib/env";
await loadEnv();
const { closeAppPool, appPool } = await import("../src/lib/db");
const { newWorkerId, repair, runSync } = await import("../src/lib/sync");
const { reconcile } = await import("../src/lib/reconcile");

const args = new Set(process.argv.slice(2));
const workerId = newWorkerId();
const line = (r: Awaited<ReturnType<typeof runSync>>) =>
  `claimed=${r.claimed} done=${r.done} superseded=${r.superseded} retried=${r.retried} failed=${r.failed} requeued=${r.requeued}`;
const summary = (rep: Awaited<ReturnType<typeof reconcile>>) =>
  `mysql=${rep.mysqlIndexable} qdrant=${rep.qdrantPoints} ok=${rep.ok.length} missing=${rep.missing.length} orphaned=${rep.orphaned.length} stale=${rep.stale.length} incompatible=${rep.incompatible.length} -> ${rep.inSync ? "IN SYNC" : "NOT IN SYNC"}`;

let stop = false;
process.on("SIGINT", () => { stop = true; });
try {
  if (args.has("--repair")) {
    const { before, queued, deleted } = await repair();
    console.log(`before:  ${summary(before)}`);
    console.log(`repair:  queued=${queued} deleted_points=${deleted}`);
  }
  if (args.has("--once") || args.has("--repair")) {
    const t0 = performance.now();
    const r = await runSync({ workerId });
    console.log(`${workerId}: ${line(r)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`after:   ${summary(await reconcile(appPool()))}`);
  } else {
    console.log(`${workerId} polling every 2 s (Ctrl+C to stop)`);
    while (!stop) {
      const r = await runSync({ workerId });
      if (r.claimed > 0) console.log(`${new Date().toISOString()} ${line(r)}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
} finally {
  await closeAppPool();
}
