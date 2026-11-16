/**
 * Milestone 4 evaluation runner — protocol in eval/README.md (fixed before any run).
 *   npm run eval -- eval/queries.json --hash    print the hashes to register BEFORE the first run, then stop
 *   npm run eval -- eval/queries.json           the run (a registered file runs once; add --rerun to reproduce it)
 * Scores EVERY active incident with four methods (keyword, vector, relational, hybrid), ranks them, and reports the
 * metrics per query block (text-only, with IOC/asset, pooled) against db/seed/demo_labels.json (never in the database).
 * Refuses to run unless the loaded dataset is the labelled demo seed and the vector index reconciles with MySQL.
 * Writes docs/evidence/eval-<file>.txt and .json. Read-only for MySQL (runtime account); queries are never inserted.
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { loadEnv } from "../src/lib/env";
await loadEnv();
const { appPool, closeAppPool } = await import("../src/lib/db");
const { EMBEDDING_MODEL_NAME, embedText } = await import("../src/lib/embedding");
const { embeddingSpec } = await import("../src/lib/embedding-spec");
const { scoreIds } = await import("../src/lib/qdrant");
const { reconcile } = await import("../src/lib/reconcile");
const { RANKING, RANKING_FINGERPRINT, assetComponent, hybridScore, iocComponent, lexicalScores, relationalScore, sharedEvidence } = await import("../src/lib/correlate");
const { iocLinkSchema } = await import("../src/lib/repo/incidents");
const { mean, normalizedRecallAt, precisionAt, rPrecision, rankByScore, recallAt, reciprocalRank, signTest, tieBreakOrder } = await import("../src/lib/eval-metrics");

const TIE_BREAK_SEED = "sentineldb-eval-v1"; // combined with each query id; fixed in eval/README.md
const MAX_IOCS = 3, MAX_ASSETS = 2, DUPLICATE_COSINE = 0.98;
const FAMILIES = ["phishing_credential", "bec_payment_fraud", "ransomware", "brute_force", "credential_stuffing", "malware_macro",
  "cryptomining", "data_exfiltration", "web_exploitation", "c2_beaconing", "cloud_misconfiguration", "ddos"] as const;
const CODE_FILES = ["src/lib/correlate.ts", "src/lib/eval-metrics.ts", "src/lib/embedding.ts", "src/lib/embedding-constants.ts", "src/lib/qdrant.ts", "scripts/eval.ts"];
const fileSchema = z.object({
  title: z.string(), written_by: z.string().min(1), written_at: z.string(), frozen: z.boolean(),
  queries: z.array(z.object({
    id: z.string().min(1), text: z.string().min(10), family: z.enum(FAMILIES),
    campaign: z.string().optional(), chain: z.string().optional(),
    iocs: z.array(z.object({ ioc_type: z.string(), ioc_value: z.string(), source_incident: z.number().int().positive() }).strict()).max(MAX_IOCS).default([]),
    asset_names: z.array(z.string()).max(MAX_ASSETS).default([]),
  }).strict()).min(1),
}).strict();

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: npm run eval -- <queries.json> [--hash | --rerun]"); process.exit(2); }
const raw = await readFile(file, "utf8");
const qf = fileSchema.parse(JSON.parse(raw));
const fileSha = sha(raw);
if (new Set(qf.queries.map((q) => q.id)).size !== qf.queries.length) throw new Error("query ids must be unique");
const labelsRaw = await readFile("db/seed/demo_labels.json", "utf8");
const labels = JSON.parse(labelsRaw) as { seed: number; incidents: Array<{ incident_id: number; family: string; campaign: string | null; chain: string | null }> };
const label = new Map(labels.incidents.map((l) => [l.incident_id, l]));
const codeSha = sha((await Promise.all(CODE_FILES.map(async (f) => `${f} ${sha(await readFile(f))}`))).join("\n"));

const pool = appPool();
const out: string[] = [];
const say = (s = "") => { out.push(s); console.log(s); };
const rows = async (sql: string) => (await pool.query<RowDataPacket[]>(sql))[0];

/** Everything the rankings depend on in MySQL (incl. archived and dismissed state), not timestamps of this machine. */
async function datasetFingerprint(): Promise<string> {
  const parts = await Promise.all([
    rows("SELECT incident_id, narrative_version, SHA2(CONCAT(title, '|', narrative), 256) AS h, severity, status, archived_at IS NOT NULL AS archived FROM Incidents ORDER BY incident_id"),
    rows("SELECT l.incident_id, c.ioc_type, c.ioc_value, l.review_status FROM Incident_IOC l JOIN IOCs c ON c.ioc_id = l.ioc_id ORDER BY l.incident_id, c.ioc_type, c.ioc_value"),
    rows("SELECT l.incident_id, a.asset_name FROM Incident_Asset l JOIN Assets a ON a.asset_id = l.asset_id ORDER BY l.incident_id, a.asset_name"),
  ]);
  return sha(JSON.stringify(parts));
}

type M = "keyword" | "vector" | "relational" | "hybrid";
const methods: M[] = ["keyword", "vector", "relational", "hybrid"];
interface Scores { p5: number; p10: number; r10: number; nr10: number; rp: number; mrr: number }
interface PerQuery {
  id: string; evidence: boolean; R: number; strictR: number | null; m: Record<M, Scores & { top: number[] }>;
  strict?: Record<M, Scores>; strictNoSource?: Record<M, Scores>; topIsSource: Record<M, boolean>; topsDiffer: boolean; maxCosine: number;
}
const f = (x: number) => x.toFixed(3);
const measure = (ranked: number[], rel: Set<number>): Scores => ({
  p5: precisionAt(ranked, rel, 5), p10: precisionAt(ranked, rel, 10), r10: recallAt(ranked, rel, 10),
  nr10: normalizedRecallAt(ranked, rel, 10), rp: rPrecision(ranked, rel), mrr: reciprocalRank(ranked, rel),
});
function table(items: Array<Record<M, Scores>>) {
  say("  method      P@5    P@10   R@10   nR@10  R-prec MRR");
  for (const m of methods) {
    const avg = (k: keyof Scores) => f(mean(items.map((i) => i[m][k])));
    say(`  ${m.padEnd(10)}  ${avg("p5")}  ${avg("p10")}  ${avg("r10")}  ${avg("nr10")}  ${avg("rp")}  ${avg("mrr")}`);
  }
}
const ceilings = (Rs: number[]) => `best possible: P@5 ${f(mean(Rs.map((R) => Math.min(5, R) / 5)))}, P@10 ${f(mean(Rs.map((R) => Math.min(10, R) / 10)))}, R@10 ${f(mean(Rs.map((R) => Math.min(10, R) / R)))}; nR@10, R-prec and MRR can always reach 1`;

try {
  const [inc] = await pool.query<RowDataPacket[]>("SELECT incident_id, narrative FROM Incidents WHERE archived_at IS NULL ORDER BY incident_id");
  const candidates = inc.map((r) => Number(r.incident_id));
  const unknown = candidates.filter((id) => !label.has(id));
  if (unknown.length > 0) throw new Error(`incidents without labels (${unknown.slice(0, 5).join(", ")}…): load the demo seed (npm run db:reset && npm run db:grants && npm run db:seed -- demo)`);
  const datasetFp = await datasetFingerprint();

  if (args.includes("--hash")) {
    console.log(`Register these in eval/README.md BEFORE the first run:\n  query file SHA-256:  ${fileSha}\n  dataset fingerprint: ${datasetFp}\n  labels SHA-256:      ${sha(labelsRaw)}\n  code SHA-256:        ${codeSha}`);
    process.exit(0);
  }

  const rep = await reconcile(pool);
  if (!rep.inSync) throw new Error(`vector index not in sync with MySQL (missing ${rep.missing.length}, stale ${rep.stale.length}, orphaned ${rep.orphaned.length}): run npm run sync:worker -- --repair`);
  const authorWritten = /assistant|claude|smoke/i.test(qf.written_by);
  const isEvaluation = qf.frozen && !authorWritten;
  const base = `docs/evidence/eval-${path.basename(file, ".json")}${args.includes("--rerun") ? "-rerun" : ""}`;
  if (isEvaluation) {
    const register = await readFile("eval/README.md", "utf8");
    for (const [what, h] of [["query file hash", fileSha], ["dataset fingerprint", datasetFp], ["labels hash", sha(labelsRaw)], ["code hash", codeSha]] as const) {
      if (!register.includes(h)) throw new Error(`${what} ${h} is not in the register in eval/README.md. Register before running; if the file, data or code changed since, re-register and record why.`);
    }
    if (!args.includes("--rerun") && await access(`${base}.json`).then(() => true, () => false)) throw new Error(`${base}.json already exists: each registered file runs once. Use --rerun to reproduce it into a separate file.`);
  }
  const [assets] = await pool.query<RowDataPacket[]>("SELECT asset_id, asset_name FROM Assets");
  const assetByName = new Map(assets.map((a) => [String(a.asset_name), Number(a.asset_id)]));
  const [[mysql]] = await pool.query<RowDataPacket[][]>("SELECT VERSION() AS v, @@innodb_ft_min_token_size AS min_t, @@innodb_ft_max_token_size AS max_t, @@innodb_ft_enable_stopword AS stop, @@innodb_ft_server_stopword_table AS stop_table") as unknown as [[RowDataPacket]];
  const provenance = {
    query_file_sha256: fileSha, written_by: qf.written_by, written_at: qf.written_at, frozen: qf.frozen,
    labels_sha256: sha(labelsRaw), dataset_seed: labels.seed, dataset_fingerprint: datasetFp, code_sha256: codeSha, code_files: CODE_FILES,
    ranking: RANKING, ranking_fingerprint: RANKING_FINGERPRINT, embedding_model: EMBEDDING_MODEL_NAME, embedding_spec: embeddingSpec().fingerprint,
    mysql_version: mysql.v, innodb_ft_min_token_size: mysql.min_t, innodb_ft_max_token_size: mysql.max_t, innodb_ft_enable_stopword: mysql.stop, innodb_ft_server_stopword_table: mysql.stop_table ?? "(default list)",
    tie_break_seed: TIE_BREAK_SEED, candidates: candidates.length, run_at: new Date().toISOString(),
  };
  say(isEvaluation ? "SENTINELDB EVALUATION" : "*** HARNESS SMOKE TEST — NOT AN EVALUATION (queries not frozen, or written by the code's author) ***");
  say(`queries:   ${file} (${qf.queries.length}) by "${qf.written_by}" on ${qf.written_at}; frozen=${qf.frozen}`);
  say(`           sha256=${fileSha}`);
  say(`ranking:   ${RANKING.version} fp=${RANKING_FINGERPRINT}; hybrid = ${RANKING.weights.text}*max(0,cosine) + ${RANKING.weights.iocs}*min(iocs,${RANKING.iocSaturation})/${RANKING.iocSaturation} + ${RANKING.weights.assets}*min(assets,${RANKING.assetSaturation})`);
  say(`code:      sha256=${codeSha}`);
  say(`embedding: ${EMBEDDING_MODEL_NAME}, spec ${embeddingSpec().short}`);
  say(`dataset:   demo seed ${labels.seed}, ${candidates.length} active incidents (every method scores all of them); fingerprint ${datasetFp}`);
  say(`labels:    sha256=${sha(labelsRaw)}`);
  say(`mysql:     ${mysql.v}; ft_min_token=${mysql.min_t} ft_max_token=${mysql.max_t} stopwords=${mysql.stop} table=${provenance.innodb_ft_server_stopword_table}`);
  say(`ties:      seeded permutation per query (seed "${TIE_BREAK_SEED}:<query id>"), never incident id`);
  say(`run at:    ${provenance.run_at}`);
  say();

  const per: PerQuery[] = [];
  for (const q of qf.queries) {
    const refs = q.iocs.map((i) => ({ ...iocLinkSchema.parse({ ioc_type: i.ioc_type, ioc_value: i.ioc_value }), source: i.source_incident }));
    const iocIds: number[] = [];
    for (const r of refs) {
      const [found] = await pool.query<RowDataPacket[]>(
        `SELECT c.ioc_id FROM IOCs c JOIN Incident_IOC l ON l.ioc_id = c.ioc_id WHERE c.ioc_type = ? AND c.ioc_value = ? AND l.incident_id = ?`, [r.ioc_type, r.ioc_value, r.source]);
      if (!found[0]) throw new Error(`${q.id}: IOC ${r.ioc_value} is not linked to its declared source incident #${r.source}`);
      if (!candidates.includes(r.source)) throw new Error(`${q.id}: source incident #${r.source} is archived, so it is not a candidate; take the IOC from an active incident (eval/writer-pack.md lists only those)`);
      iocIds.push(Number(found[0].ioc_id));
    }
    const assetIds = q.asset_names.map((n) => { const a = assetByName.get(n); if (a === undefined) throw new Error(`${q.id}: unknown asset ${n}`); return a; });
    const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
    if (inc.some((r) => norm(String(r.narrative)) === norm(q.text))) throw new Error(`${q.id}: the query text is identical to a stored narrative`);
    const cos = await scoreIds((await embedText(q.text)).vector, candidates);
    const maxCosine = Math.max(...cos.values());
    if (maxCosine >= DUPLICATE_COSINE) throw new Error(`${q.id}: cosine ${f(maxCosine)} with a stored narrative: a near-copy, not a new description`);
    const lex = await lexicalScores(pool, q.text, candidates.length, candidates);
    const ev = await sharedEvidence(pool, iocIds, assetIds, candidates);
    const feat = (id: number) => ({ text: Math.max(0, cos.get(id) ?? 0), iocs: iocComponent(ev.get(id)?.iocs.size ?? 0), assets: assetComponent(ev.get(id)?.assets.size ?? 0) });
    const score: Record<M, (id: number) => number> = {
      keyword: (id) => lex.get(id) ?? 0, vector: (id) => cos.get(id) ?? -1, relational: (id) => relationalScore(feat(id)), hybrid: (id) => hybridScore(feat(id)),
    };
    const ties = tieBreakOrder(candidates, parseInt(sha(`${TIE_BREAK_SEED}:${q.id}`).slice(0, 8), 16));
    const relevant = new Set(candidates.filter((id) => label.get(id)!.family === q.family));
    const named = Boolean(q.campaign || q.chain);
    const strictRel = named ? new Set(candidates.filter((id) => (q.campaign && label.get(id)!.campaign === q.campaign) || (q.chain && label.get(id)!.chain === q.chain))) : null;
    if (strictRel && strictRel.size === 0) throw new Error(`${q.id}: campaign/chain matches no active incident`);
    const sources = new Set(refs.map((r) => r.source));
    const ranked = Object.fromEntries(methods.map((m) => [m, rankByScore(candidates, score[m], ties)])) as Record<M, number[]>;
    const row: PerQuery = {
      id: q.id, evidence: refs.length + assetIds.length > 0, R: relevant.size, strictR: strictRel?.size ?? null, maxCosine,
      m: {} as PerQuery["m"], topIsSource: {} as Record<M, boolean>, topsDiffer: ranked.hybrid.slice(0, 10).join() !== ranked.vector.slice(0, 10).join(),
    };
    if (strictRel) { row.strict = {} as Record<M, Scores>; row.strictNoSource = {} as Record<M, Scores>; }
    const relNoSource = strictRel ? new Set([...strictRel].filter((id) => !sources.has(id))) : null;
    for (const m of methods) {
      row.m[m] = { ...measure(ranked[m], relevant), top: ranked[m].slice(0, 5) };
      row.topIsSource[m] = sources.has(ranked[m][0]!);
      if (strictRel) row.strict![m] = measure(ranked[m], strictRel);
      if (relNoSource && relNoSource.size > 0) row.strictNoSource![m] = measure(ranked[m].filter((id) => !sources.has(id)), relNoSource);
    }
    if (relNoSource && relNoSource.size === 0) delete row.strictNoSource;
    per.push(row);
  }

  const blocks: Array<[string, PerQuery[]]> = [["TEXT-ONLY", per.filter((p) => !p.evidence)], ["WITH IOC/ASSET", per.filter((p) => p.evidence)], ["POOLED", per]];
  for (const [name, items] of blocks) {
    say(`=== ${name}: ${items.length} quer${items.length === 1 ? "y" : "ies"}`);
    if (items.length === 0) { say(); continue; }
    say(`Lenient (same family); R per query ${Math.min(...items.map((p) => p.R))}–${Math.max(...items.map((p) => p.R))}; ${ceilings(items.map((p) => p.R))}`);
    table(items.map((p) => p.m));
    const strict = items.filter((p) => p.strict);
    if (strict.length > 0) {
      say(`Strict (same campaign/chain), ${strict.length} quer${strict.length === 1 ? "y" : "ies"}; R ${Math.min(...strict.map((p) => p.strictR!))}–${Math.max(...strict.map((p) => p.strictR!))}; ${ceilings(strict.map((p) => p.strictR!))}`);
      table(strict.map((p) => p.strict!));
      const rest = strict.filter((p) => p.strictNoSource);
      if (rest.some((p) => p.evidence)) {
        say(`Strict, IOC source incidents removed from ranking and relevant set, ${rest.length} quer${rest.length === 1 ? "y" : "ies"}`);
        table(rest.map((p) => p.strictNoSource!));
      }
    }
    for (const [other, label2] of [["vector", "vector"], ["keyword", "keyword"]] as const) {
      const s = (k: keyof Scores) => signTest(items.map((p) => p.m.hybrid[k] - p.m[other][k]));
      const a = s("mrr"), b = s("p10");
      say(`Hybrid vs ${label2}, per query (lenient): MRR ${a.better} better / ${a.equal} equal / ${a.worse} worse, sign test p=${f(a.p)}; P@10 ${b.better} / ${b.equal} / ${b.worse}, p=${f(b.p)}`);
    }
    if (items.some((p) => p.evidence)) {
      const ev = items.filter((p) => p.evidence);
      say(`First hit is the incident an IOC was copied from: ${methods.map((m) => `${m} ${ev.filter((p) => p.topIsSource[m]).length}/${ev.length}`).join(", ")}`);
    }
    say();
  }
  const textOnly = per.filter((p) => !p.evidence);
  if (textOnly.length > 0) say(`Check: on text-only queries hybrid should order like vector (it is 0.6 * cosine). Queries whose top 10 differ: ${textOnly.filter((p) => p.topsDiffer).length}/${textOnly.length}`);
  say("Sign-test p-values are descriptive: few queries, one dataset, several comparisons. Differences of a few points are noise.");
  say("Validity: one synthetic dataset, written by the code's author from templates; results describe this dataset and do not generalise to real incidents.");
  say();
  say("Per query, lenient P@10/MRR (R = relevant in family; strict R where named):");
  say(`  ${"query".padEnd(26)} ${"kind".padEnd(9)} R   sR  maxcos ${methods.map((m) => m.padEnd(14)).join("")}`);
  for (const p of per) say(`  ${p.id.padEnd(26)} ${(p.evidence ? "evidence" : "text").padEnd(9)} ${String(p.R).padEnd(3)} ${String(p.strictR ?? "-").padEnd(3)} ${f(p.maxCosine)}  ${methods.map((m) => `${f(p.m[m].p10)}/${f(p.m[m].mrr)}`.padEnd(14)).join("")}`);
  if (!isEvaluation) { say(); say("*** These numbers test the harness only. Do not report them as results. ***"); }

  await mkdir("docs/evidence", { recursive: true });
  await writeFile(`${base}.txt`, out.join("\n") + "\n");
  await writeFile(`${base}.json`, JSON.stringify({ evaluation: isEvaluation, file, provenance, per_query: per }, null, 2));
  console.log(`\nwritten: ${base}.txt / .json`);
} finally {
  await closeAppPool();
}
