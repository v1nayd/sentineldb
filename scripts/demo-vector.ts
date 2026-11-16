/**
 * Demo of the vector database on whatever dataset is loaded (normally the 240-incident demo seed):
 *   1. run the outbox worker (and repair) so Qdrant matches MySQL, then reconcile
 *   2. embed the query text, ask Qdrant for the nearest incidents, resolve the ids to authoritative MySQL rows
 *   npm run demo:vector -- "free-text description of a new incident"     (no text: two built-in example queries)
 * Reads MySQL with the least-privilege app account and never writes to it. Admin view: no visibility filter (that
 * belongs to the API, M4). Vector-only ranking; the hybrid ranking with relational evidence is Milestone 4.
 */
import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { loadEnv } from "../src/lib/env";
await loadEnv();

const { appPool, closeAppPool, placeholders } = await import("../src/lib/db");
const { embedText } = await import("../src/lib/embedding");
const { ensureCollection, searchSimilar, collectionName } = await import("../src/lib/qdrant");
const { repair, runSync } = await import("../src/lib/sync");
const { reconcile } = await import("../src/lib/reconcile");

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const pool = appPool();

console.log(`Qdrant collection ${collectionName()} (${await ensureCollection()})`);
// Same path as production: the outbox worker indexes whatever is queued, and repair() catches anything else.
await repair(pool);
const run = await runSync({ pool });
if (run.claimed > 0) console.log(`sync worker: indexed/updated ${run.done}, superseded ${run.superseded}, failed ${run.failed}`);
const rep = await reconcile(pool);
console.log(`reconcile: mysql=${rep.mysqlIndexable} qdrant=${rep.qdrantPoints} ok=${rep.ok.length} missing=${rep.missing.length} orphaned=${rep.orphaned.length} stale=${rep.stale.length} -> ${rep.inSync ? "IN SYNC" : "NOT IN SYNC"}`);

const queries = process.argv.slice(2).filter((a) => a.trim() !== "");
if (queries.length === 0) {
  queries.push(
    "Several staff got an email that looked like it came from IT asking them to re-enter their password on a web page.",
    "Files on the shared drive were renamed with a strange extension and a text file asks for payment to unlock them.",
  );
}

for (const query of queries) {
  console.log(`\nQuery: "${query}"`);
  const hits = await searchSimilar((await embedText(query)).vector, 5);
  if (hits.length === 0) { console.log("  no vectors indexed"); continue; }
  const ids = hits.map((h) => h.incident_id);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT i.incident_id, i.title, i.severity, i.status, i.narrative, COUNT(DISTINCT ii.ioc_id) AS iocs, COUNT(DISTINCT ia.asset_id) AS assets
       FROM Incidents i
       LEFT JOIN Incident_IOC ii ON ii.incident_id = i.incident_id
       LEFT JOIN Incident_Asset ia ON ia.incident_id = i.incident_id
      WHERE i.incident_id IN (${placeholders(ids.length)})
      GROUP BY i.incident_id, i.title, i.severity, i.status, i.narrative`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.incident_id as number, r]));
  console.log("  rank score  id   severity  status         iocs assets vector  title (from MySQL)");
  hits.forEach((h, i) => {
    const r = byId.get(h.incident_id);
    if (!r) { console.log(`  ${i + 1}    ${h.score.toFixed(3)}  #${h.incident_id}  <no MySQL row: orphan vector, ignored>`); return; }
    const fresh = h.payload.content_sha256 === sha256(r.narrative as string) ? "current" : "STALE  ";
    console.log(`  ${i + 1}    ${h.score.toFixed(3)}  ${`#${r.incident_id}`.padEnd(4)} ${String(r.severity).padEnd(9)} ${String(r.status).padEnd(14)} ${String(r.iocs).padEnd(4)} ${String(r.assets).padEnd(6)} ${fresh} ${r.title}`);
  });
}
await closeAppPool();
