/**
 * Milestone 1 vertical slice — proves the whole chain on REAL services:
 *   MySQL (authority) -> embed narratives -> Qdrant (derived index) -> embed a NEW, differently-worded query
 *   -> Qdrant nearest neighbours -> resolve ids back to authoritative MySQL rows -> staleness check.
 *
 * Exits non-zero if any assertion fails, so it can be used as a smoke test.
 * Uses the least-privilege APP account for MySQL: this script never writes to MySQL.
 */
import { createHash } from "node:crypto";
import { loadEnv } from "../src/lib/env";
await loadEnv();

const { appPool, closeAppPool, placeholders } = await import("../src/lib/db");
const { embedText } = await import("../src/lib/embedding");
const { ensureCollection, searchSimilar, collectionName } = await import("../src/lib/qdrant");
const { repair, runSync } = await import("../src/lib/sync");
const { reconcile } = await import("../src/lib/reconcile");
import type { RowDataPacket } from "mysql2/promise";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
};

const pool = appPool();

// 1) Index through the Milestone 4 path: the seed's inserts queued outbox jobs (triggers); repair() also removes vectors
//    left over from a previous dataset (a MySQL reset does not touch Qdrant), then the worker embeds and upserts.
console.log(`collection: ${await ensureCollection()} (${collectionName()})`);
const [incidents] = await pool.query<RowDataPacket[]>("SELECT incident_id FROM Incidents");
if (incidents.length === 0) throw new Error("No incidents in MySQL. Run: npm run db:seed -- spike");
const t0 = performance.now();
const repaired = await repair(pool);
const run = await runSync({ pool });
console.log(`sync worker: ${run.done} job(s) done, ${run.superseded} superseded, ${run.failed} failed; repair deleted ${repaired.deleted} stray point(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
// Full reconciliation across BOTH stores (not just a point count, which missing+orphan vectors can fool).
const rep = await reconcile(pool);
console.log(`reconcile: mysql=${rep.mysqlIndexable} qdrant=${rep.qdrantPoints} ok=${rep.ok.length} missing=${rep.missing.length} orphaned=${rep.orphaned.length} stale=${rep.stale.length} incompatible=${rep.incompatible.length}`);
check(rep.inSync, "MySQL and Qdrant fully reconciled (no missing, orphaned, stale or incompatible vectors)");

// 2) Query with NEW narratives that share (almost) no vocabulary with the stored ones.
interface Case { name: string; query: string; relevant: number[] }
const cases: Case[] = [
  { name: "credential attack, reworded", relevant: [1, 2, 3],
    query: "Our VPN gateway recorded a burst of unsuccessful sign-in attempts from a handful of foreign addresses, and then one session was accepted at three in the morning." },
  { name: "phishing, reworded", relevant: [4, 5, 6],
    query: "A colleague clicked a link in a message that looked like it came from the corporate support desk and typed their password into a page that turned out not to be ours." },
  { name: "ransomware, reworded", relevant: [7],
    query: "Employees cannot open documents on the shared drive and a note in each directory is demanding bitcoin to get them back." },
];

for (const c of cases) {
  console.log(`\n--- ${c.name}\n    "${c.query}"`);
  const { vector } = await embedText(c.query);
  const hits = await searchSimilar(vector, 5);

  // 3) Resolve candidate ids against MySQL (the authority). Qdrant payload never carries narrative text.
  const ids = hits.map((h) => h.incident_id);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT i.incident_id, i.title, i.severity, i.status, i.narrative,
            COUNT(DISTINCT ii.ioc_id) AS iocs, COUNT(DISTINCT ia.asset_id) AS assets
       FROM Incidents i
       LEFT JOIN Incident_IOC ii ON ii.incident_id = i.incident_id
       LEFT JOIN Incident_Asset ia ON ia.incident_id = i.incident_id
      WHERE i.incident_id IN (${placeholders(ids.length)})
      GROUP BY i.incident_id, i.title, i.severity, i.status, i.narrative`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.incident_id as number, r]));

  console.log("    rank  score   id  sev       status         iocs assets  sync   title");
  hits.forEach((h, i) => {
    const r = byId.get(h.incident_id);
    if (!r) { console.log(`    ${i + 1}     ${h.score.toFixed(3)}  ${h.incident_id}  <orphan vector: no MySQL row>`); return; }
    // Staleness: the vector is only trustworthy if it was computed from the narrative currently in MySQL.
    const synced = h.payload.content_sha256 === sha256(r.narrative as string);
    console.log(`    ${String(i + 1).padEnd(5)} ${h.score.toFixed(3)}  ${String(r.incident_id).padEnd(3)} ${String(r.severity).padEnd(9)} ${String(r.status).padEnd(14)} ${String(r.iocs).padEnd(4)} ${String(r.assets).padEnd(6)} ${synced ? "ok   " : "STALE"}  ${r.title}`);
  });

  check(hits.every((h) => byId.has(h.incident_id)), "every Qdrant hit resolves to a MySQL row (no orphan vectors)");
  check(hits.every((h) => byId.has(h.incident_id) && h.payload.content_sha256 === sha256(byId.get(h.incident_id)!.narrative as string)), "no stale vectors among hits");
  check(c.relevant.includes(hits[0]!.incident_id), `top-1 (#${hits[0]!.incident_id}) is in the expected family [${c.relevant.join(", ")}]`);
  const top3 = hits.slice(0, 3).filter((h) => c.relevant.includes(h.incident_id)).length;
  check(top3 >= Math.min(2, c.relevant.length), `>= ${Math.min(2, c.relevant.length)} of top-3 are in the expected family (got ${top3})`);
}

await closeAppPool();
console.log(failures === 0 ? "\nSPIKE OK" : `\nSPIKE FAILED (${failures} failed checks)`);
process.exit(failures === 0 ? 0 : 1);
