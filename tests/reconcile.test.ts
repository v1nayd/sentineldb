import { createHash } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "mysql2/promise";
import { appPool, closeAppPool, migratorConn } from "../src/lib/db";
import { EMBEDDING_MODEL_NAME, embedText } from "../src/lib/embedding";
import { collectionName, countVectors, ensureCollection, IncompatibleVectorError, qdrant, searchSimilar, upsertIncidentVector } from "../src/lib/qdrant";
import { reconcile } from "../src/lib/reconcile";
import { migrate, resetSchema } from "../src/lib/migrate";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const N: Record<number, string> = {
  1: "Hundreds of failed password attempts against the bastion host from a single overseas address.",
  2: "Staff received a fake helpdesk message linking to a page that harvested their credentials.",
  3: "Every shared file was renamed and a note demanded cryptocurrency payment.",
  4: "Café résumé naïve — Zürich ✓ 日本語 🚨 mixed-script narrative to prove MySQL SHA2 == Node sha256 on UTF-8.",
};
let admin: Connection;

async function index(id: number, text: string) {
  const { vector, truncated } = await embedText(text);
  await upsertIncidentVector(id, vector, { incident_id: id, content_sha256: sha(text), model: EMBEDDING_MODEL_NAME, truncated, embedded_at: new Date().toISOString() });
}

async function reindexFromMysql() {
  const [rows] = await admin.query<import("mysql2/promise").RowDataPacket[]>("SELECT incident_id, narrative FROM Incidents");
  for (const row of rows) await index(row.incident_id as number, row.narrative as string);
}

beforeAll(async () => {
  admin = await migratorConn("sentineldb_test");
  await resetSchema(admin, "sentineldb_test");
  await migrate(admin, path.resolve(import.meta.dirname, "../db/migrations"));
  await admin.query("INSERT INTO Users (user_id,name,email,password_hash,role) VALUES (1,'A','a@x.example','h','analyst'),(2,'M','m@x.example','h','admin')");
  await admin.query("SET @sentinel_actor = 1"); // M2 triggers require an acting user for every incident write
  for (const [id, text] of Object.entries(N)) {
    await admin.query("INSERT INTO Incidents (incident_id,title,narrative,severity,reported_by) VALUES (?,?,?,?,1)", [Number(id), `incident ${id}`, text, "low"]);
  }
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await ensureCollection();
});
afterAll(async () => {
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await admin?.end();
  await closeAppPool();
});

describe("full MySQL<->Qdrant reconciliation (real MySQL + real Qdrant)", () => {
  it("reports a fully indexed, consistent state as in sync (incl. non-ASCII narrative: SHA2 == sha256 of UTF-8)", async () => {
    for (const [id, text] of Object.entries(N)) await index(Number(id), text);
    const r = await reconcile(appPool());
    expect(r).toMatchObject({ mysqlIndexable: 4, qdrantPoints: 4, ok: [1, 2, 3, 4], missing: [], orphaned: [], stale: [], incompatible: [], inSync: true });
  });

  it("detects missing, orphaned, stale and incompatible vectors even when the point COUNT looks perfect", async () => {
    await qdrant().delete(collectionName(), { wait: true, points: [1] });                  // #1 missing
    await index(999, "A vector for an incident that does not exist in MySQL.");            // orphan (offsets the missing one)
    await admin.query("UPDATE Incidents SET narrative = ? WHERE incident_id = 2", ["Narrative edited after it was indexed."]); // #2 stale
    await qdrant().setPayload(collectionName(), { wait: true, payload: { embedding_fp: "some-other-model-fingerprint" }, points: [3] }); // #3 incompatible

    // The naive check from the Milestone 1 spike is fooled: 4 points in Qdrant, 4 incidents in MySQL.
    expect(await countVectors()).toBe(4);
    const r = await reconcile(appPool());
    expect(r.mysqlIndexable).toBe(4);
    expect(r.qdrantPoints).toBe(4);
    expect(r.missing).toEqual([1]);
    expect(r.orphaned).toEqual(["999"]);
    expect(r.stale).toEqual([2]);
    expect(r.incompatible).toEqual(["3"]);
    expect(r.ok).toEqual([4]);
    expect(r.inSync).toBe(false);
  });

  it("is repairable: re-indexing every indexable incident and removing the orphan restores sync", async () => {
    const [rows] = await admin.query<import("mysql2/promise").RowDataPacket[]>("SELECT incident_id, narrative FROM Incidents");
    for (const row of rows) await index(row.incident_id as number, row.narrative as string);
    await qdrant().delete(collectionName(), { wait: true, points: [999] });
    expect((await reconcile(appPool())).inSync).toBe(true);
  });

  it("classifies a payload whose incident_id disagrees with its point id as incompatible, and search refuses it", async () => {
    // Correct fingerprint, correct content hash, wrong identity: the case a hash-only comparison would call "ok".
    await qdrant().setPayload(collectionName(), { wait: true, payload: { incident_id: 1 }, points: [4] });
    const r = await reconcile(appPool());
    expect(r.incompatible).toEqual(["4"]);
    expect(r.incompatibleReasons["4"]).toMatch(/does not match point id 4/);
    expect(r.ok).toEqual([1, 2, 3]);
    expect(r.inSync).toBe(false);
    const [rows4] = await admin.query<import("mysql2/promise").RowDataPacket[]>("SELECT narrative FROM Incidents WHERE incident_id = 4");
    const probe = (await embedText(String(rows4[0]!.narrative))).vector; // would be point 4's nearest neighbour
    await expect(searchSimilar(probe, 4)).rejects.toBeInstanceOf(IncompatibleVectorError);
    await reindexFromMysql(); // repair
    expect((await reconcile(appPool())).inSync).toBe(true);
  });

  it("classifies a wrong model name or malformed content hash as incompatible too", async () => {
    await qdrant().setPayload(collectionName(), { wait: true, payload: { model: "some/other-model" }, points: [1] });
    await qdrant().setPayload(collectionName(), { wait: true, payload: { content_sha256: "not-a-digest" }, points: [2] });
    const r = await reconcile(appPool());
    expect(r.incompatible).toEqual(["1", "2"]);
    expect(r.incompatibleReasons["1"]).toMatch(/model/);
    expect(r.incompatibleReasons["2"]).toMatch(/sha256/);
    await reindexFromMysql(); // always repair from the authority (MySQL), never from a stale copy of the text
    expect((await reconcile(appPool())).inSync).toBe(true);
  });

  it("a narrative changed after indexing stays visibly stale until it is re-indexed (a failed re-index is never silent)", async () => {
    await admin.query("UPDATE Incidents SET narrative = ? WHERE incident_id = 3", ["Edited again; the re-index job has not run (or failed)."]);
    expect((await reconcile(appPool())).stale).toEqual([3]);
    expect((await reconcile(appPool())).stale).toEqual([3]); // still stale on the next look: nothing clears it but a successful re-index
    await index(3, "Edited again; the re-index job has not run (or failed).");
    expect((await reconcile(appPool())).inSync).toBe(true);
  });

  it("only accepts a closed set of named indexable policies, never a SQL fragment", async () => {
    await expect(reconcile(appPool(), "1=1 OR 1=1" as never)).rejects.toThrow(/Unknown indexable policy/);
    await expect(reconcile(appPool(), "incident_id <> 4" as never)).rejects.toThrow(/Unknown indexable policy/);
    expect((await reconcile(appPool(), "all")).inSync).toBe(true);
  });

  it("under the default 'active' policy, the vector of an archived incident is reported as orphaned (to be removed)", async () => {
    // drive incident 4 through the real lifecycle to archived (migration 0009 procedures)
    const step = async (actor: number, sql: string) => { await admin.query("SET @sentinel_actor = ?", [actor]); await admin.query(sql); };
    await step(2, "CALL reassign_incident(4, 1, 'triage')");
    await step(1, "CALL transition_incident(4, 'investigating', NULL)");
    await step(1, "CALL transition_incident(4, 'resolved', NULL)");
    await step(2, "CALL close_incident(4, 'done')");
    await step(2, "CALL archive_incident(4, 'retention')");
    const r = await reconcile(appPool());
    expect(r).toMatchObject({ mysqlIndexable: 3, orphaned: ["4"], ok: [1, 2, 3], inSync: false });
    expect((await reconcile(appPool(), "all")).inSync).toBe(true); // diagnostics policy still sees it as a normal row
  });
});
