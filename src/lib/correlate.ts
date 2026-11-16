import { createHash } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { SessionUser } from "./auth/session";
import { appPool, placeholders } from "./db";
import { embedText } from "./embedding";
import { iocLinkSchema } from "./repo/incidents";
import { scoreIds, searchSimilar } from "./qdrant";
import { incidentScope, visibleIncident } from "./visibility";

/**
 * "Have we seen this before?" — explainable hybrid ranking (Milestone 4, docs/RANKING.md).
 *
 * Score of a candidate incident d for a query q (a narrative plus, optionally, its IOCs and assets):
 *
 *   text(q,d)   = max(0, cosine(embedding(q), embedding(d)))                       in [0, 1]
 *   iocs(q,d)   = min(shared distinct IOCs, 2) / 2                                  in [0, 1]
 *   assets(q,d) = min(shared distinct assets, 1)                                    in [0, 1]
 *   hybrid      = 0.6 * text + 0.3 * iocs + 0.1 * assets                            in [0, 1]
 *
 * No double counting: the narrative is scored ONCE (semantic similarity; the keyword score is never added on top), an
 * IOC counts once however it is linked, an IOC link reviewed as 'dismissed' (a false positive) on either side counts
 * zero, and an asset counts once. Weights are fixed a priori (text is always present; shared indicators are strong but
 * sparse; shared assets are weak because a domain controller appears in many unrelated incidents) and are NOT tuned on
 * evaluation queries; RANKING_FINGERPRINT is printed with every evaluation so a change is visible.
 *
 * Authorisation: candidates are filtered by incidentScope() (ADR-1 option A) in MySQL AFTER retrieval; Qdrant returns
 * ids only. Because filtering happens after retrieval, the vector search over-fetches and says so when fewer than k
 * authorised results remain. Shared IOC values / asset names are only shown for incidents the user may see.
 *
 * Degraded mode: if Qdrant or the embedding model fails, the text component is the MySQL FULLTEXT score (normalised by
 * the best candidate) and the response says mode = "lexical_fallback" — it is never presented as semantic.
 */
export const RANKING = {
  version: "hybrid-v1",
  weights: { text: 0.6, iocs: 0.3, assets: 0.1 },
  iocSaturation: 2,
  assetSaturation: 1,
  vectorCandidates: 100,
  lexicalCandidates: 100,
} as const;
export const RANKING_FINGERPRINT = createHash("sha256").update(JSON.stringify(RANKING)).digest("hex").slice(0, 12);

export type Mode = "hybrid" | "lexical_fallback";
export interface Evidence { iocs: Set<number>; assets: Set<number> }
export interface Features { text: number; iocs: number; assets: number; sharedIocs: number[]; sharedAssets: number[] }

export const iocComponent = (n: number) => Math.min(n, RANKING.iocSaturation) / RANKING.iocSaturation;
export const assetComponent = (n: number) => Math.min(n, RANKING.assetSaturation) / RANKING.assetSaturation;
export function hybridScore(f: Pick<Features, "text" | "iocs" | "assets">): number {
  const w = RANKING.weights;
  return w.text * f.text + w.iocs * f.iocs + w.assets * f.assets;
}
export const relationalScore = (f: Pick<Features, "iocs" | "assets">) =>
  (RANKING.weights.iocs * f.iocs + RANKING.weights.assets * f.assets) / (RANKING.weights.iocs + RANKING.weights.assets);

/** Incidents sharing (non-dismissed) IOCs or assets with the query, restricted to `among` when given. */
export async function sharedEvidence(pool: Pool, iocIds: number[], assetIds: number[], among?: number[]): Promise<Map<number, Evidence>> {
  const out = new Map<number, Evidence>();
  const get = (id: number) => { let e = out.get(id); if (!e) out.set(id, (e = { iocs: new Set(), assets: new Set() })); return e; };
  const restrict = among && among.length > 0 ? ` AND incident_id IN (${placeholders(among.length)})` : "";
  if (among && among.length === 0) return out;
  if (iocIds.length > 0) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT incident_id, ioc_id FROM Incident_IOC WHERE review_status <> 'dismissed' AND ioc_id IN (${placeholders(iocIds.length)})${restrict}`,
      [...iocIds, ...(among ?? [])]);
    for (const r of rows) get(Number(r.incident_id)).iocs.add(Number(r.ioc_id));
  }
  if (assetIds.length > 0) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT incident_id, asset_id FROM Incident_Asset WHERE asset_id IN (${placeholders(assetIds.length)})${restrict}`, [...assetIds, ...(among ?? [])]);
    for (const r of rows) get(Number(r.incident_id)).assets.add(Number(r.asset_id));
  }
  return out;
}

/** MySQL FULLTEXT (natural language mode) relevance per incident; only matching incidents appear. */
export async function lexicalScores(pool: Pool, text: string, limit: number, among?: number[]): Promise<Map<number, number>> {
  if (among && among.length === 0) return new Map();
  const restrict = among ? ` AND incident_id IN (${placeholders(among.length)})` : "";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT incident_id, MATCH(title, narrative) AGAINST (? IN NATURAL LANGUAGE MODE) AS s FROM Incidents
      WHERE MATCH(title, narrative) AGAINST (? IN NATURAL LANGUAGE MODE)${restrict} ORDER BY s DESC, incident_id LIMIT ?`,
    [text, text, ...(among ?? []), limit]);
  return new Map(rows.map((r) => [Number(r.incident_id), Number(r.s)]));
}

export interface CorrelationInput { text: string; iocIds: number[]; assetIds: number[]; exclude?: number }
export interface RankedIncident {
  incident_id: number; title: string; severity: string; status: string; created_at: Date; index_state: string;
  score: number;
  components: { text: number; text_kind: "semantic" | "lexical"; iocs: number; assets: number };
  contributions: { text: number; iocs: number; assets: number };
  shared_iocs: Array<{ ioc_id: number; ioc_type: string; ioc_value: string }>;
  shared_assets: Array<{ asset_id: number; asset_name: string }>;
  explanation: string;
}
export interface CorrelationResult { mode: Mode; ranking: string; ranking_fingerprint: string; k: number; results: RankedIncident[]; notes: string[] }

/** Core ranking shared by the incident and free-text endpoints. */
export async function correlate(user: SessionUser, q: CorrelationInput, k: number, pool: Pool = appPool()): Promise<CorrelationResult> {
  const notes: string[] = [];
  let mode: Mode = "hybrid";
  let vector: number[] | null = null;
  const textScore = new Map<number, number>();

  const evidence = await sharedEvidence(pool, q.iocIds, q.assetIds);
  const pool0 = new Set<number>(evidence.keys());
  try {
    vector = (await embedText(q.text)).vector;
    for (const h of await searchSimilar(vector, RANKING.vectorCandidates)) { pool0.add(h.incident_id); textScore.set(h.incident_id, Math.max(0, h.score)); }
  } catch (e) {
    console.error("[correlate] semantic search unavailable, using lexical fallback:", (e as Error).message);
    mode = "lexical_fallback";
    vector = null;
    notes.push("Semantic search is unavailable (vector index or model down). Text similarity below is KEYWORD-based (MySQL FULLTEXT), not semantic.");
    for (const id of (await lexicalScores(pool, q.text, RANKING.lexicalCandidates)).keys()) pool0.add(id);
  }
  if (q.exclude !== undefined) pool0.delete(q.exclude);
  if (pool0.size === 0) return { mode, ranking: RANKING.version, ranking_fingerprint: RANKING_FINGERPRINT, k, results: [], notes: [...notes, "No candidate incidents."] };

  // Authorise in MySQL: active incidents in the user's scope only.
  const scope = incidentScope(user);
  const ids = [...pool0];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT i.incident_id, i.title, i.severity, i.status, i.created_at, COALESCE(s.sync_status, 'missing') AS index_state
       FROM Incidents i LEFT JOIN incident_sync_view s ON s.incident_id = i.incident_id
      WHERE i.incident_id IN (${placeholders(ids.length)}) AND i.archived_at IS NULL AND ${scope.sql}`,
    [...ids, ...scope.params]);
  const allowed = rows.map((r) => Number(r.incident_id));
  if (user.role !== "admin") notes.push("Only incidents you reported or are assigned to are ranked (visibility policy).");

  if (mode === "hybrid" && vector) {
    const missing = allowed.filter((id) => !textScore.has(id)); // relational-only candidates still get a true cosine
    if (missing.length > 0) for (const [id, s] of await scoreIds(vector, missing)) textScore.set(id, Math.max(0, s));
  } else if (allowed.length > 0) {
    const lex = await lexicalScores(pool, q.text, allowed.length, allowed);
    const best = Math.max(0, ...lex.values());
    for (const [id, s] of lex) textScore.set(id, best > 0 ? s / best : 0);
  }

  const ranked = rows.map((r) => {
    const id = Number(r.incident_id);
    const ev = evidence.get(id);
    const f = { text: textScore.get(id) ?? 0, iocs: iocComponent(ev?.iocs.size ?? 0), assets: assetComponent(ev?.assets.size ?? 0) };
    return { r, id, ev, f, score: hybridScore(f) };
  }).sort((a, b) => b.score - a.score || a.id - b.id).slice(0, k);

  // Names for the shared evidence of the shown results only.
  const iocIds = [...new Set(ranked.flatMap((x) => [...(x.ev?.iocs ?? [])]))];
  const assetIds = [...new Set(ranked.flatMap((x) => [...(x.ev?.assets ?? [])]))];
  const iocNames = new Map<number, { ioc_type: string; ioc_value: string }>();
  const assetNames = new Map<number, string>();
  if (iocIds.length > 0) for (const r of (await pool.query<RowDataPacket[]>(`SELECT ioc_id, ioc_type, ioc_value FROM IOCs WHERE ioc_id IN (${placeholders(iocIds.length)})`, iocIds))[0]) iocNames.set(Number(r.ioc_id), { ioc_type: r.ioc_type, ioc_value: r.ioc_value });
  if (assetIds.length > 0) for (const r of (await pool.query<RowDataPacket[]>(`SELECT asset_id, asset_name FROM Assets WHERE asset_id IN (${placeholders(assetIds.length)})`, assetIds))[0]) assetNames.set(Number(r.asset_id), String(r.asset_name));

  const w = RANKING.weights;
  const results: RankedIncident[] = ranked.map(({ r, id, ev, f, score }) => {
    const sharedIocs = [...(ev?.iocs ?? [])].sort((a, b) => a - b).map((i) => ({ ioc_id: i, ...iocNames.get(i)! }));
    const sharedAssets = [...(ev?.assets ?? [])].sort((a, b) => a - b).map((a) => ({ asset_id: a, asset_name: assetNames.get(a)! }));
    const parts = [`${Math.round(f.text * 100)}% ${mode === "hybrid" ? "semantic" : "keyword"} text similarity`];
    if (sharedIocs.length > 0) parts.push(`shares ${sharedIocs.length} IOC${sharedIocs.length > 1 ? "s" : ""} (${sharedIocs.map((s) => s.ioc_value).join(", ")})`);
    if (sharedAssets.length > 0) parts.push(`same asset${sharedAssets.length > 1 ? "s" : ""} ${sharedAssets.map((s) => s.asset_name).join(", ")}`);
    if (r.index_state !== "synced" && mode === "hybrid") parts.push(`vector index ${r.index_state}: text score may be out of date`);
    return {
      incident_id: id, title: r.title, severity: r.severity, status: r.status, created_at: r.created_at, index_state: r.index_state,
      score: round(score),
      components: { text: round(f.text), text_kind: mode === "hybrid" ? "semantic" : "lexical", iocs: round(f.iocs), assets: round(f.assets) },
      contributions: { text: round(w.text * f.text), iocs: round(w.iocs * f.iocs), assets: round(w.assets * f.assets) },
      shared_iocs: sharedIocs, shared_assets: sharedAssets, explanation: parts.join(" · "),
    };
  });
  if (results.length < k) notes.push(`Only ${results.length} authorised candidate incident(s) matched; fewer than the ${k} requested.`);
  return { mode, ranking: RANKING.version, ranking_fingerprint: RANKING_FINGERPRINT, k, results, notes };
}
const round = (x: number) => Math.round(x * 1000) / 1000;

export const similarQuerySchema = z.object({ k: z.coerce.number().int().min(1).max(50).default(10) }).strict();

/** Incidents similar to an incident the user can see (its narrative, its non-dismissed IOCs and its assets). */
export async function similarToIncident(user: SessionUser, id: number, k: number, pool: Pool = appPool()) {
  await visibleIncident(pool, user, id);
  const [[inc]] = await pool.query<RowDataPacket[][]>("SELECT narrative FROM Incidents WHERE incident_id = ?", [id]) as unknown as [[RowDataPacket]];
  const [iocs] = await pool.query<RowDataPacket[]>("SELECT ioc_id FROM Incident_IOC WHERE incident_id = ? AND review_status <> 'dismissed'", [id]);
  const [assets] = await pool.query<RowDataPacket[]>("SELECT asset_id FROM Incident_Asset WHERE incident_id = ?", [id]);
  return correlate(user, { text: String(inc.narrative), iocIds: iocs.map((r) => Number(r.ioc_id)), assetIds: assets.map((r) => Number(r.asset_id)), exclude: id }, k, pool);
}

export const textSearchSchema = z.object({
  text: z.string().trim().min(3).max(5_000),
  iocs: z.array(z.object({ ioc_type: z.string(), ioc_value: z.string() }).strict()).max(50).default([]),
  asset_ids: z.array(z.number().int().positive()).max(50).default([]),
  k: z.number().int().min(1).max(50).default(10),
}).strict();

/** Free-text "have we seen this before?" (e.g. before filing a new incident). IOC values are normalised per type. */
export async function similarToText(user: SessionUser, input: z.infer<typeof textSearchSchema>, pool: Pool = appPool()) {
  const refs = input.iocs.map((i) => iocLinkSchema.parse(i)); // same validation + normalisation as linking an IOC
  let iocIds: number[] = [];
  if (refs.length > 0) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ioc_id FROM IOCs WHERE (ioc_type, ioc_value) IN (${refs.map(() => "(?, ?)").join(", ")})`, refs.flatMap((r) => [r.ioc_type, r.ioc_value]));
    iocIds = rows.map((r) => Number(r.ioc_id));
  }
  return correlate(user, { text: input.text, iocIds, assetIds: input.asset_ids }, input.k, pool);
}
