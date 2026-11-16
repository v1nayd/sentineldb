import type { Pool, RowDataPacket } from "mysql2/promise";
import { scrollAllPayloads, validatePayload } from "./qdrant";

/**
 * Full MySQL <-> Qdrant reconciliation. Unlike a point-count check, this classifies EVERY id across both stores,
 * so a missing vector and an orphan vector cannot cancel each other out.
 *
 *   missing       in MySQL (indexable), no point in Qdrant
 *   orphaned      point in Qdrant, no matching indexable MySQL row (deleted, archived, or never existed)
 *   stale         both exist but the narrative changed since the vector was computed (hash differs)
 *   incompatible  point produced under a different embedding spec (or payload unreadable)
 *   ok            exists in both, hash matches, same spec
 *
 * "incompatible" covers everything validatePayload rejects: a foreign embedding spec, a wrong model, a payload whose
 * incident_id disagrees with the point id, or malformed fields. The reason for each is in `incompatibleReasons`.
 *
 * Which incidents SHOULD be indexed is chosen from a CLOSED set of named policies (`INDEXABLE_POLICIES`), never from a
 * caller-supplied SQL fragment, so no future endpoint can route user input into this statement. "active" (archived
 * incidents excluded, migration 0004) is what the index should contain; under it the vector of an archived incident
 * shows up as orphaned, to be removed or quarantined by the sync worker (M4). "all" is kept for diagnostics.
 */
export const INDEXABLE_POLICIES = {
  all: "1=1",
  active: "archived_at IS NULL",
} as const;
export type IndexablePolicy = keyof typeof INDEXABLE_POLICIES;

export interface ReconcileReport {
  mysqlIndexable: number;
  qdrantPoints: number;
  ok: number[];
  missing: number[];
  orphaned: string[];
  stale: number[];
  incompatible: string[];
  incompatibleReasons: Record<string, string>;
  inSync: boolean;
}

export async function reconcile(pool: Pool, policy: IndexablePolicy = "active"): Promise<ReconcileReport> {
  const indexableWhere = INDEXABLE_POLICIES[policy]; // throws below if a caller smuggles in an unknown policy
  if (indexableWhere === undefined) throw new Error(`Unknown indexable policy: ${String(policy)}`);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT incident_id, SHA2(narrative, 256) AS h FROM Incidents WHERE ${indexableWhere} ORDER BY incident_id`,
  );
  const mysql = new Map<string, string>(rows.map((r) => [String(r.incident_id), String(r.h)]));
  const points = await scrollAllPayloads();

  const rep: ReconcileReport = { mysqlIndexable: mysql.size, qdrantPoints: points.length, ok: [], missing: [], orphaned: [], stale: [], incompatible: [], incompatibleReasons: {}, inSync: false };
  const seen = new Set<string>();
  for (const pt of points) {
    seen.add(pt.id);
    const h = mysql.get(pt.id);
    if (h === undefined) { rep.orphaned.push(pt.id); continue; }
    const v = validatePayload(pt.id, pt.payload);
    if (!v.ok) { rep.incompatible.push(pt.id); rep.incompatibleReasons[pt.id] = v.reason; continue; }
    if (v.payload.content_sha256 !== h) { rep.stale.push(Number(pt.id)); continue; }
    rep.ok.push(Number(pt.id));
  }
  for (const id of mysql.keys()) if (!seen.has(id)) rep.missing.push(Number(id));
  for (const k of ["ok", "missing", "stale"] as const) rep[k].sort((a, b) => a - b);
  rep.orphaned.sort(); rep.incompatible.sort();
  rep.inSync = rep.missing.length + rep.orphaned.length + rep.stale.length + rep.incompatible.length === 0;
  return rep;
}
