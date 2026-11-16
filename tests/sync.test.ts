import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Connection, RowDataPacket } from "mysql2/promise";
import type { SessionUser } from "../src/lib/auth/session";
import { appPool, closeAppPool } from "../src/lib/db";
import { collectionName, ensureCollection, pointPayload, qdrant } from "../src/lib/qdrant";
import { reconcile } from "../src/lib/reconcile";
import { archive, close, createIncident, reassign, transition, updateIncident } from "../src/lib/repo/incidents";
import { repair, runSync, syncStatus } from "../src/lib/sync";
import { embedText, EMBEDDING_MODEL_NAME } from "../src/lib/embedding";
import { upsertIncidentVector } from "../src/lib/qdrant";
import { ANA, MAX, count, freshSchema, one } from "./fixtures";

/** Milestone 4 outbox (migration 0015) + worker (src/lib/sync.ts), on real MySQL and real Qdrant. */
const ana: SessionUser = { id: ANA, name: "Ana Analyst", email: "ana@test.example", role: "analyst" };
const max: SessionUser = { id: MAX, name: "Max Admin", email: "max@test.example", role: "admin" };
let admin: Connection;

const jobs = async (id: number) => (await admin.query<RowDataPacket[]>(
  "SELECT narrative_version, action, status FROM Embedding_Jobs WHERE incident_id = ? ORDER BY job_id", [id]))[0]
  .map((r) => `${r.action}@v${r.narrative_version}:${r.status}`);
const syncState = async (id: number) => String((await one(admin, "SELECT sync_status FROM incident_sync_view WHERE incident_id = ?", [id])).sync_status);
const newIncident = (narrative = "Repeated failed logins against the VPN gateway from one foreign address.") =>
  createIncident(ana, { title: "Sync test", narrative, severity: "medium" });

async function closeIt(id: number) {
  await reassign(max, id, ANA, "triage");
  await transition(ana, id, "investigating");
  await transition(ana, id, "resolved");
  await close(max, id);
}

beforeAll(async () => {
  admin = await freshSchema();
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await ensureCollection();
});
beforeEach(async () => {
  await runSync(); // start every test with an empty queue
});
afterAll(async () => {
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await admin?.end();
  await closeAppPool();
});

describe("outbox: jobs are written by triggers in the changing transaction", () => {
  it("a new incident queues exactly one upsert for narrative_version 1", async () => {
    const id = await newIncident();
    expect(await jobs(id)).toEqual(["upsert@v1:pending"]);
    expect(await syncState(id)).toBe("pending");
  });

  it("no-op and title/severity-only updates queue nothing; a narrative edit queues the new version and supersedes the old pending job", async () => {
    const id = await newIncident();
    await updateIncident(ana, id, { title: "Renamed", severity: "high" });
    expect(await jobs(id)).toEqual(["upsert@v1:pending"]);
    await updateIncident(ana, id, { narrative: "Rewritten narrative about a password spraying attack." });
    expect(await jobs(id)).toEqual(["upsert@v1:superseded", "upsert@v2:pending"]);
  });

  it("a rolled-back narrative edit leaves no job behind (same transaction)", async () => {
    const id = await newIncident();
    const conn = await appPool().getConnection();
    try {
      await conn.query("SET @sentinel_actor = ?", [ANA]);
      await conn.beginTransaction();
      await conn.query("UPDATE Incidents SET narrative = 'edit that will be rolled back' WHERE incident_id = ?", [id]);
      expect(await count(admin, "SELECT COUNT(*) FROM Embedding_Jobs WHERE incident_id = ?", [id])).toBe(1); // not visible outside yet
      await conn.rollback();
    } finally {
      await conn.query("SET @sentinel_actor = NULL");
      conn.release();
    }
    expect(await jobs(id)).toEqual(["upsert@v1:pending"]);
  });

  it("archiving queues a delete and supersedes pending upserts", async () => {
    const id = await newIncident();
    await closeIt(id);
    await updateIncident(ana, id, { narrative: "x" }).catch(() => undefined); // closed: refused by the trigger, no job
    await archive(max, id, "done");
    expect(await jobs(id)).toEqual(["upsert@v1:superseded", "delete@v1:pending"]);
    expect(await syncState(id)).toBe("archived");
  });

  it("the app account can neither create arbitrary job states nor delete jobs", async () => {
    const id = await newIncident();
    await expect(appPool().query("DELETE FROM Embedding_Jobs WHERE incident_id = ?", [id])).rejects.toMatchObject({ errno: 1142 });
    await expect(appPool().query("INSERT INTO Embedding_Jobs (incident_id, narrative_version, action, status) VALUES (?, 1, 'upsert', 'done')", [id]))
      .rejects.toMatchObject({ errno: 1143 });
    await expect(appPool().query("UPDATE Embedding_Jobs SET status = 'done' WHERE incident_id = ?", [id])).rejects.toMatchObject({ errno: 3819 }); // CHECK: done needs finished_at
  });
});

describe("worker: MySQL -> Qdrant", () => {
  it("processes a new incident: point written with its narrative_version, job done, both stores reconcile", async () => {
    const id = await newIncident();
    const r = await runSync();
    expect(r).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect(await jobs(id)).toEqual(["upsert@v1:done"]);
    expect(await syncState(id)).toBe("synced");
    expect((await pointPayload(id))?.narrative_version).toBe(1);
    expect((await reconcile(appPool())).inSync).toBe(true);
  });

  it("a narrative edit makes the vector stale until the worker runs, then it carries version 2", async () => {
    const id = await newIncident();
    await runSync();
    await updateIncident(ana, id, { narrative: "Ransom note found on the file share after files were encrypted." });
    expect((await reconcile(appPool())).stale).toContain(id);
    await runSync();
    expect((await pointPayload(id))?.narrative_version).toBe(2);
    expect((await reconcile(appPool())).inSync).toBe(true);
  });

  it("one job per incident per claim: with v1 and v2 both pending, only v2 is processed", async () => {
    const id = await newIncident();
    await updateIncident(ana, id, { narrative: "Second version of the narrative." });
    await admin.query("UPDATE Embedding_Jobs SET status = 'pending', finished_at = NULL, last_error = NULL WHERE incident_id = ? AND narrative_version = 1", [id]);
    await runSync();
    expect(await jobs(id)).toEqual(["upsert@v1:superseded", "upsert@v2:done"]);
    expect((await pointPayload(id))?.narrative_version).toBe(2);
  });

  it("version fence 1: a job for an outdated narrative never writes (the incident is already at a newer version)", async () => {
    const id = await newIncident();
    await updateIncident(ana, id, { narrative: "Second version, whose own job we pretend was lost." });
    await admin.query("UPDATE Embedding_Jobs SET status = 'superseded', finished_at = UTC_TIMESTAMP() WHERE incident_id = ? AND narrative_version = 2", [id]);
    await admin.query("UPDATE Embedding_Jobs SET status = 'pending', finished_at = NULL WHERE incident_id = ? AND narrative_version = 1", [id]);
    await runSync();
    expect(await jobs(id)).toEqual(["upsert@v1:superseded", "upsert@v2:superseded"]);
    expect(await pointPayload(id)).toBeNull(); // nothing written under a wrong version (reconcile reports it missing -> repair)
    expect((await reconcile(appPool())).missing).toContain(id);
  });

  it("version fence 2: a job never overwrites a point that already carries a newer narrative_version", async () => {
    const id = await newIncident();
    await runSync();
    await qdrant().setPayload(collectionName(), { wait: true, points: [id], payload: { narrative_version: 7 } }); // as if a newer write landed
    await admin.query("UPDATE Embedding_Jobs SET status = 'pending', finished_at = NULL WHERE incident_id = ?", [id]);
    await runSync();
    expect(await jobs(id)).toEqual(["upsert@v1:superseded"]);
    expect((await pointPayload(id))?.narrative_version).toBe(7);
    await qdrant().delete(collectionName(), { points: [id], wait: true });
    await repair();
    await runSync();
  });

  it("archiving removes the point; the index then reconciles under the 'active' policy", async () => {
    const id = await newIncident();
    await runSync();
    await closeIt(id);
    await archive(max, id, "done");
    await runSync();
    expect(await pointPayload(id)).toBeNull();
    expect(await jobs(id)).toEqual(["upsert@v1:done", "delete@v1:done"]);
    expect((await reconcile(appPool())).inSync).toBe(true);
  });

  it("four workers in parallel never process the same job twice (locking read + fenced claim)", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(await newIncident(`Parallel worker test incident number ${i}: beaconing to a rare domain.`));
    const runs = await Promise.all(["wA", "wB", "wC", "wD"].map((w) => runSync({ workerId: w, batch: 1 })));
    expect(runs.reduce((s, r) => s + r.claimed, 0)).toBe(12);
    expect(runs.reduce((s, r) => s + r.done, 0)).toBe(12);
    for (const id of ids) expect(await jobs(id)).toEqual(["upsert@v1:done"]);
    const [att] = await admin.query<RowDataPacket[]>(`SELECT MAX(attempts) AS a FROM Embedding_Jobs WHERE incident_id IN (${ids.join(",")})`);
    expect(Number(att[0]!.a)).toBe(1); // each job was claimed exactly once
  });

  it("a job left running by a dead worker is taken over after the lock timeout", async () => {
    const id = await newIncident();
    await admin.query("UPDATE Embedding_Jobs SET status = 'running', locked_by = 'dead', locked_at = UTC_TIMESTAMP() - INTERVAL 11 MINUTE WHERE incident_id = ?", [id]);
    await runSync();
    expect(await jobs(id)).toEqual(["upsert@v1:done"]);
  });

  it("repair(): a point deleted behind the outbox's back and a foreign orphan point are fixed", async () => {
    const id = await newIncident();
    await runSync();
    await qdrant().delete(collectionName(), { points: [id], wait: true });
    const { vector } = await embedText("orphan");
    await upsertIncidentVector(99_999, vector, { incident_id: 99_999, content_sha256: "0".repeat(64), model: EMBEDDING_MODEL_NAME, truncated: false, embedded_at: new Date().toISOString() });
    const { before, queued, deleted } = await repair();
    expect(before.missing).toContain(id);
    expect(before.orphaned).toContain("99999");
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(deleted).toBeGreaterThanOrEqual(1);
    await runSync();
    expect((await reconcile(appPool())).inSync).toBe(true);
    expect((await syncStatus()).incidents.synced).toBeGreaterThanOrEqual(1);
  });
});
