import { QdrantClient } from "@qdrant/js-client-rest";
import { env } from "./env";
import { EMBEDDING_DIM, EMBEDDING_MODEL_NAME } from "./embedding-constants";
import { embeddingSpec } from "./embedding-spec";

/**
 * Qdrant holds DERIVED data only: one point per incident, id = incident_id, vector = embedding of the narrative.
 * Payload is deliberately minimal (no narrative text, no title) so a vector hit never leaks incident content;
 * callers must resolve ids against MySQL (the authority) and apply access control there.
 *
 * Compatibility model: the collection NAME embeds the embedding-spec fingerprint (`<base>__<fp12>`), and every
 * point carries the full fingerprint. A different model/recipe therefore lands in a different collection (rebuild),
 * and any foreign vector that sneaks into the current one is detected on read, never silently ranked.
 */

export interface VectorPayload {
  incident_id: number;
  /** sha256 of the exact narrative text that was embedded; lets us detect stale vectors. */
  content_sha256: string;
  /** Full embedding-spec fingerprint the vector was produced under. */
  embedding_fp: string;
  model: string;
  truncated: boolean;
  embedded_at: string; // ISO-8601 UTC
  /** Incidents.narrative_version the vector was computed from (written by the M4 sync worker; absent on older points). */
  narrative_version?: number;
}

export class IncompatibleVectorError extends Error {}

let client: QdrantClient | undefined;
export function qdrant(): QdrantClient {
  // checkCompatibility stays on: it warns if client/server versions drift apart.
  return (client ??= new QdrantClient({ url: env().QDRANT_URL }));
}

/** `<QDRANT_COLLECTION>__<spec fingerprint, 12 hex>` */
export const collectionName = () => `${env().QDRANT_COLLECTION}__${embeddingSpec().short}`;
export const currentFingerprint = () => embeddingSpec().fingerprint;

export type PayloadVerdict =
  | { ok: true; payload: VectorPayload }
  | { ok: false; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validates a point's payload against the point's own id and the CURRENT embedding spec. Used on every read path
 * (search, reconciliation) and on write, so identity metadata can never be internally inconsistent:
 *   - payload.incident_id must equal the point id (a payload that names another incident would attach this vector's
 *     similarity to the wrong record),
 *   - embedding_fp must be the current fingerprint, model must be the current model,
 *   - content_sha256 must be a sha256 hex digest, other fields must have the right types.
 */
export function validatePayload(pointId: string | number, raw: unknown): PayloadVerdict {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "payload missing" };
  const p = raw as Record<string, unknown>;
  const id = Number(pointId);
  if (!Number.isInteger(id) || id < 1) return { ok: false, reason: `point id ${String(pointId)} is not a positive integer` };
  if (p.incident_id !== id) return { ok: false, reason: `payload.incident_id ${JSON.stringify(p.incident_id)} does not match point id ${id}` };
  if (p.embedding_fp !== currentFingerprint()) return { ok: false, reason: "embedding_fp differs from the current embedding spec" };
  if (p.model !== EMBEDDING_MODEL_NAME) return { ok: false, reason: `model ${JSON.stringify(p.model)} is not ${EMBEDDING_MODEL_NAME}` };
  if (typeof p.content_sha256 !== "string" || !HEX64.test(p.content_sha256)) return { ok: false, reason: "content_sha256 is not a sha256 hex digest" };
  if (typeof p.truncated !== "boolean") return { ok: false, reason: "truncated is not a boolean" };
  if (typeof p.embedded_at !== "string" || Number.isNaN(Date.parse(p.embedded_at))) return { ok: false, reason: "embedded_at is not an ISO timestamp" };
  if (p.narrative_version !== undefined && !(Number.isInteger(p.narrative_version) && (p.narrative_version as number) >= 1)) return { ok: false, reason: "narrative_version is not a positive integer" };
  return { ok: true, payload: p as unknown as VectorPayload };
}

/** Reject malformed vectors at the boundary instead of trusting callers. */
export function assertValidVector(v: unknown): asserts v is number[] {
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
    throw new Error(`Vector must be an array of ${EMBEDDING_DIM} numbers (got ${Array.isArray(v) ? v.length : typeof v}).`);
  }
  let sumSq = 0;
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("Vector contains a non-finite or non-numeric value.");
    sumSq += x * x;
  }
  // Our pipeline L2-normalises. A vector far from unit length was not produced by it.
  if (Math.abs(Math.sqrt(sumSq) - 1) > 1e-3) throw new Error(`Vector is not L2-normalised (norm ${Math.sqrt(sumSq).toFixed(4)}).`);
}

/** Create the collection if absent; if present, REFUSE to proceed when its shape differs from what we embed. */
export async function ensureCollection(): Promise<"created" | "exists"> {
  const name = collectionName();
  const { collections } = await qdrant().getCollections();
  if (!collections.some((c) => c.name === name)) {
    await qdrant().createCollection(name, { vectors: { size: EMBEDDING_DIM, distance: "Cosine" } });
    return "created";
  }
  const info = await qdrant().getCollection(name);
  const v = info.config.params.vectors;
  if (!v || typeof v !== "object" || !("size" in v) || v.size !== EMBEDDING_DIM || v.distance !== "Cosine") {
    throw new Error(`Qdrant collection "${name}" exists with an incompatible vector config (${JSON.stringify(v)}). Refusing to use it.`);
  }
  return "exists";
}

/** Idempotent: upserting the same incident_id overwrites the same point. */
export async function upsertIncidentVector(incidentId: number, vector: number[], payload: Omit<VectorPayload, "embedding_fp">): Promise<void> {
  if (!Number.isInteger(incidentId) || incidentId < 1) throw new Error("incidentId must be a positive integer");
  assertValidVector(vector);
  if (payload.incident_id !== incidentId) {
    throw new Error(`Refusing to write: payload.incident_id (${String(payload.incident_id)}) does not match the point id (${incidentId}).`);
  }
  const full: VectorPayload = { ...payload, embedding_fp: currentFingerprint() };
  const verdict = validatePayload(incidentId, full);
  if (!verdict.ok) throw new Error(`Refusing to write an invalid payload: ${verdict.reason}.`);
  await qdrant().upsert(collectionName(), {
    wait: true, // do not return until the point is durable/queryable
    points: [{ id: incidentId, vector, payload: { ...full } }],
  });
}

export interface VectorHit {
  incident_id: number;
  score: number; // cosine similarity in [-1, 1]
  payload: VectorPayload;
}

/** Throws IncompatibleVectorError if ANY returned point fails validatePayload (foreign spec OR inconsistent identity). */
export async function searchSimilar(vector: number[], limit: number): Promise<VectorHit[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100");
  assertValidVector(vector);
  const res = await qdrant().query(collectionName(), { query: vector, limit, with_payload: true, with_vector: false });
  return res.points.map((r) => {
    // Never trust a stored payload: it must be internally consistent AND produced by the current spec.
    const v = validatePayload(r.id, r.payload);
    if (!v.ok) {
      throw new IncompatibleVectorError(`Point ${String(r.id)} in ${collectionName()} is not valid for the current index (${v.reason}); run reconciliation and re-index.`);
    }
    return { incident_id: Number(r.id), score: r.score, payload: v.payload };
  });
}

export async function countVectors(): Promise<number> {
  return (await qdrant().count(collectionName(), { exact: true })).count;
}

/** Every point (id + payload, no vectors) in the current collection, via paged scroll. */
export async function scrollAllPayloads(pageSize = 256): Promise<Array<{ id: string; payload: Partial<VectorPayload> | null }>> {
  const out: Array<{ id: string; payload: Partial<VectorPayload> | null }> = [];
  let offset: string | number | Record<string, unknown> | null | undefined = undefined;
  do {
    const page = await qdrant().scroll(collectionName(), { limit: pageSize, with_payload: true, with_vector: false, ...(offset != null ? { offset: offset as string | number } : {}) });
    for (const pt of page.points) out.push({ id: String(pt.id), payload: (pt.payload ?? null) as Partial<VectorPayload> | null });
    offset = page.next_page_offset as typeof offset;
  } while (offset != null);
  return out;
}

/**
 * Cosine scores for exactly these incident ids (Qdrant `has_id` filter), so every ranking method can score the SAME
 * candidate set instead of only whatever happened to land in a top-k. Ids without a valid point are simply absent.
 */
export async function scoreIds(vector: number[], ids: number[]): Promise<Map<number, number>> {
  assertValidVector(vector);
  const out = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 256) {
    const chunk = ids.slice(i, i + 256);
    const res = await qdrant().query(collectionName(), { query: vector, filter: { must: [{ has_id: chunk }] }, limit: chunk.length, with_payload: true, with_vector: false });
    for (const r of res.points) {
      const v = validatePayload(r.id, r.payload);
      if (!v.ok) throw new IncompatibleVectorError(`Point ${String(r.id)} in ${collectionName()} is not valid for the current index (${v.reason}); run reconciliation and re-index.`);
      out.set(Number(r.id), r.score);
    }
  }
  return out;
}

/** The stored payload of one point, or null if there is none (used by the sync worker's version fence). */
export async function pointPayload(incidentId: number): Promise<Partial<VectorPayload> | null> {
  const [pt] = await qdrant().retrieve(collectionName(), { ids: [incidentId], with_payload: true, with_vector: false });
  return (pt?.payload ?? null) as Partial<VectorPayload> | null;
}

export async function deletePoints(ids: Array<number | string>): Promise<void> {
  if (ids.length === 0) return;
  await qdrant().delete(collectionName(), { points: ids.map(Number), wait: true });
}
