import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedText, EMBEDDING_MODEL_NAME } from "../src/lib/embedding";
import { assertValidVector, collectionName, countVectors, currentFingerprint, ensureCollection, IncompatibleVectorError, qdrant, searchSimilar, upsertIncidentVector } from "../src/lib/qdrant";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const N = (id: number, text: string) => ({ id, text });
const docs = [
  N(101, "Hundreds of failed password attempts against the bastion host from a single overseas address."),
  N(102, "Staff received a fake helpdesk message linking to a page that harvested their credentials."),
  N(103, "Every shared file was renamed and a note demanded cryptocurrency payment."),
];

beforeAll(async () => {
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await ensureCollection();
});
afterAll(async () => { await qdrant().deleteCollection(collectionName()).catch(() => undefined); });

async function index(d: { id: number; text: string }) {
  const { vector, truncated } = await embedText(d.text);
  await upsertIncidentVector(d.id, vector, { incident_id: d.id, content_sha256: sha(d.text), model: EMBEDDING_MODEL_NAME, truncated, embedded_at: new Date().toISOString() });
}

describe("Qdrant integration (real server, dedicated test collection)", () => {
  it("creates the collection once and reports 'exists' afterwards", async () => {
    expect(await ensureCollection()).toBe("exists");
  });

  it("upsert is idempotent: re-indexing the same incident does not create duplicates", async () => {
    for (const d of docs) await index(d);
    for (const d of docs) await index(d);
    expect(await countVectors()).toBe(3);
  });

  it("returns the semantically closest incident id first, with cosine score and minimal payload", async () => {
    const { vector } = await embedText("Lots of unsuccessful sign-ins to our VPN from abroad.");
    const hits = await searchSimilar(vector, 3);
    expect(hits[0]!.incident_id).toBe(101);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(Object.keys(hits[0]!.payload).sort()).toEqual(["content_sha256", "embedded_at", "embedding_fp", "incident_id", "model", "truncated"]);
    // Privacy by construction: no narrative text may ever be stored in the vector index.
    expect(JSON.stringify(hits)).not.toContain("bastion");
  });

  it("re-embedding after a narrative edit replaces the vector and the stored hash (staleness is detectable)", async () => {
    const edited = N(101, "A phishing page imitating our portal captured employee passwords.");
    const before = (await searchSimilar((await embedText(docs[0]!.text)).vector, 1))[0]!;
    expect(before.payload.content_sha256).toBe(sha(docs[0]!.text));
    await index(edited);
    const after = (await searchSimilar((await embedText(edited.text)).vector, 1))[0]!;
    expect(after.incident_id).toBe(101);
    expect(after.payload.content_sha256).toBe(sha(edited.text));
    expect(after.payload.content_sha256).not.toBe(before.payload.content_sha256);
    expect(await countVectors()).toBe(3);
  });

  it("refuses to use an existing collection whose vector config does not match the embedding model", async () => {
    await qdrant().deleteCollection(collectionName());
    await qdrant().createCollection(collectionName(), { vectors: { size: 3, distance: "Dot" } });
    await expect(ensureCollection()).rejects.toThrow(/incompatible/i);
    await qdrant().deleteCollection(collectionName());
    await ensureCollection();
  });

  it("validates inputs before talking to the server", async () => {
    await expect(searchSimilar(new Array(384).fill(0.01), 0)).rejects.toThrow(/limit/);
    await expect(upsertIncidentVector(0, new Array(384).fill(0), { incident_id: 0, content_sha256: "", model: "", truncated: false, embedded_at: "" })).rejects.toThrow(/positive integer/);
  });

  it("rejects malformed vectors at the wrapper boundary (wrong length, NaN, Infinity, not normalised)", async () => {
    const good = (await embedText("a valid narrative")).vector;
    expect(() => assertValidVector(good)).not.toThrow();
    expect(() => assertValidVector(good.slice(0, 383))).toThrow(/384/);
    expect(() => assertValidVector([...good.slice(0, 383), Number.NaN])).toThrow(/non-finite/);
    expect(() => assertValidVector([...good.slice(0, 383), Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
    expect(() => assertValidVector(good.map((x) => x * 3))).toThrow(/normalised/);
    const meta = { incident_id: 7, content_sha256: "x", model: "m", truncated: false, embedded_at: "t" };
    await expect(upsertIncidentVector(7, good.slice(0, 10), meta)).rejects.toThrow(/384/);
    await expect(searchSimilar(good.map(() => 0), 3)).rejects.toThrow(/normalised/);
  });

  it("rejects an upsert whose payload.incident_id differs from the point id, and any malformed payload field", async () => {
    const v = (await embedText("identity check narrative")).vector;
    const good = { incident_id: 7, content_sha256: sha("identity check narrative"), model: EMBEDDING_MODEL_NAME, truncated: false, embedded_at: new Date().toISOString() };
    await expect(upsertIncidentVector(8, v, good)).rejects.toThrow(/does not match the point id/);
    await expect(upsertIncidentVector(7, v, { ...good, content_sha256: "xyz" })).rejects.toThrow(/sha256/);
    await expect(upsertIncidentVector(7, v, { ...good, model: "other/model" })).rejects.toThrow(/model/);
    await expect(upsertIncidentVector(7, v, { ...good, embedded_at: "yesterday-ish" })).rejects.toThrow(/ISO/);
    expect(await countVectors()).toBe(0); // nothing was written by any rejected call
  });

  it("search refuses a point whose payload names a different incident, even with the right fingerprint", async () => {
    const v = (await embedText("a point with a lying payload")).vector;
    await qdrant().upsert(collectionName(), { wait: true, points: [{ id: 601, vector: v, payload: { incident_id: 602, embedding_fp: currentFingerprint(), model: EMBEDDING_MODEL_NAME, content_sha256: sha("x"), truncated: false, embedded_at: new Date().toISOString() } }] });
    await expect(searchSimilar(v, 3)).rejects.toThrow(/does not match point id 601/);
    await qdrant().delete(collectionName(), { wait: true, points: [601] });
  });

  it("names the collection after the embedding-spec fingerprint and stamps every point with it", async () => {
    expect(collectionName()).toMatch(new RegExp(`__${currentFingerprint().slice(0, 12)}$`));
    await index(docs[0]!); // the previous test recreated the collection empty
    const hit = (await searchSimilar((await embedText(docs[0]!.text)).vector, 1))[0]!;
    expect(hit.payload.embedding_fp).toBe(currentFingerprint());
  });

  it("fails loudly (IncompatibleVectorError) if a vector from a different embedding spec is in the collection", async () => {
    const v = (await embedText("a foreign-model vector that happens to be 384-d")).vector;
    await qdrant().upsert(collectionName(), { wait: true, points: [{ id: 555, vector: v, payload: { incident_id: 555, embedding_fp: "some-other-model-fingerprint", model: "other", content_sha256: "x", truncated: false, embedded_at: "t" } }] });
    await expect(searchSimilar(v, 3)).rejects.toBeInstanceOf(IncompatibleVectorError);
    await qdrant().delete(collectionName(), { wait: true, points: [555] });
  });
});
