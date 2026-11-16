import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { closeAppPool } from "../src/lib/db";
import { collectionName, ensureCollection, qdrant } from "../src/lib/qdrant";
import { createIncident } from "../src/lib/repo/incidents";
import { SYNC, runSync } from "../src/lib/sync";
import { ANA, freshSchema } from "./fixtures";

// The embedding model "fails" in this file only: the worker must retry with backoff, then give up as 'failed'.
vi.mock("../src/lib/embedding", async (orig) => ({
  ...(await orig<typeof import("../src/lib/embedding")>()),
  embedText: async () => { throw new Error("model unavailable (simulated)"); },
}));

let admin: Connection;
beforeAll(async () => {
  admin = await freshSchema();
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await ensureCollection();
});
afterAll(async () => {
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await admin?.end();
  await closeAppPool();
});

describe("worker failure handling", () => {
  it("retries with exponential backoff, then marks the job failed after the maximum number of attempts", async () => {
    const id = await createIncident({ id: ANA, name: "Ana", email: "ana@test.example", role: "analyst" }, { title: "t", narrative: "n", severity: "low" });
    const job = async () => (await admin.query<RowDataPacket[]>(
      "SELECT status, attempts, last_error, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), available_at) AS wait_s FROM Embedding_Jobs WHERE incident_id = ?", [id]))[0][0]!;

    expect(await runSync()).toMatchObject({ claimed: 1, retried: 1, done: 0 });
    let j = await job();
    expect(j).toMatchObject({ status: "pending", attempts: 1, last_error: "model unavailable (simulated)" });
    expect(Number(j.wait_s)).toBeGreaterThanOrEqual(SYNC.backoffBaseSeconds - 1);
    expect(await runSync()).toMatchObject({ claimed: 0 }); // not due yet: backoff is honoured

    for (let attempt = 2; attempt <= SYNC.maxAttempts; attempt++) {
      await admin.query("UPDATE Embedding_Jobs SET available_at = UTC_TIMESTAMP() WHERE incident_id = ?", [id]); // skip the wait
      await runSync();
    }
    j = await job();
    expect(j).toMatchObject({ status: "failed", attempts: SYNC.maxAttempts });
    const [v] = await admin.query<RowDataPacket[]>("SELECT sync_status FROM incident_sync_view WHERE incident_id = ?", [id]);
    expect(v[0]!.sync_status).toBe("failed");
  });
});
