import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratorConn } from "../src/lib/db";
import { resetAndMigrate, withSchemaLock } from "../src/lib/migrate";
import { loadNamedQueries } from "../src/lib/reports";
import { assertEmptyForSeed } from "../src/lib/seed-guard";
import { generatedFiles } from "../scripts/generate-seed";
import { buildDemoSeed, type DemoLabels } from "../scripts/seed/demo";
import { MIGRATIONS, ROOT, TEST_DB, appConn, count } from "./fixtures";

/**
 * The demo dataset (ADR-2): ~240 synthetic incidents REPLAYED through the real procedures and triggers. Loading it at
 * all is an end-to-end test of the lifecycle; the integrity queries then check the audit trail it produced.
 */
let admin: Connection;
let app: Connection;
const SEED = path.join(ROOT, "db/seed");

beforeAll(async () => {
  admin = await migratorConn(TEST_DB);
  await resetAndMigrate(admin, TEST_DB, MIGRATIONS);
  const sql = await readFile(path.join(SEED, "demo_seed.sql"), "utf8");
  await withSchemaLock(admin, TEST_DB, 30, async () => { await assertEmptyForSeed(admin); await admin.query(sql); });
  app = await appConn();
}, 300_000);
afterAll(async () => { await app?.end(); await admin?.end(); });

describe("generator", () => {
  it("is deterministic and the committed seed files are exactly what it generates", async () => {
    expect(buildDemoSeed().sql).toBe(buildDemoSeed().sql);
    for (const [name, content] of Object.entries(generatedFiles())) {
      expect(await readFile(path.join(SEED, name), "utf8"), `${name} is stale: run npm run db:seed:generate`).toBe(content);
    }
  });
});

describe("loaded dataset", () => {
  it("has 150-300 incidents, every status, archived and reopened incidents, handovers, unlinks and dismissals", async () => {
    const n = await count(admin, "SELECT COUNT(*) FROM Incidents");
    expect(n).toBeGreaterThanOrEqual(150);
    expect(n).toBeLessThanOrEqual(300);
    const [st] = await admin.query<RowDataPacket[]>("SELECT status, COUNT(*) n FROM Incidents GROUP BY status");
    expect(st.map((r) => String(r.status)).sort()).toEqual(["closed", "contained", "investigating", "open", "resolved"]);
    expect(await count(admin, "SELECT COUNT(*) FROM Incidents WHERE archived_at IS NOT NULL")).toBeGreaterThan(0);
    expect(await count(admin, "SELECT COUNT(DISTINCT incident_id) FROM Incident_Status_History WHERE old_status = 'closed'")).toBeGreaterThan(0);
    expect(await count(admin, "SELECT COUNT(*) FROM Incident_Status_History WHERE old_status = 'contained' AND new_status = 'investigating'")).toBeGreaterThan(0);
    expect(await count(admin, "SELECT COUNT(*) FROM Incident_Assignment_History WHERE old_assignee IS NOT NULL")).toBeGreaterThan(0);
    expect(await count(admin, "SELECT COUNT(*) FROM Incident_Evidence_History WHERE action = 'unlinked'")).toBeGreaterThan(0);
    expect(await count(admin, "SELECT COUNT(*) FROM Incident_IOC WHERE review_status = 'dismissed'")).toBeGreaterThan(0);
    expect(await count(admin, "SELECT COUNT(*) FROM Incidents WHERE status = 'open' AND assigned_to IS NULL")).toBeGreaterThan(0);
  });

  it("every audit row was written by the triggers under the import account, at back-dated times inside the dataset window", async () => {
    for (const t of ["Incident_Status_History", "Incident_Assignment_History", "Incident_Evidence_History"]) {
      expect(await count(admin, `SELECT COUNT(*) FROM ${t} WHERE source <> 'import'`), t).toBe(0);
      expect(await count(admin, `SELECT COUNT(*) FROM ${t} WHERE changed_at < '2026-01-01' OR changed_at > '2026-10-01'`), t).toBe(0);
    }
  });

  it("passes every audit-trail integrity check in db/reports/integrity.sql (run as the runtime account)", async () => {
    const queries = await loadNamedQueries(path.join(ROOT, "db/reports/integrity.sql"));
    expect(queries.length).toBeGreaterThanOrEqual(10);
    for (const q of queries) {
      const [rows] = await app.query<RowDataPacket[]>(q.sql);
      expect(rows, q.name).toEqual([]);
    }
  });

  it("the integrity checks have teeth: a forged history row is caught", async () => {
    const queries = await loadNamedQueries(path.join(ROOT, "db/reports/integrity.sql"));
    const id = (await admin.query<RowDataPacket[]>("SELECT incident_id FROM Incidents WHERE status = 'investigating' AND archived_at IS NULL LIMIT 1"))[0][0]!.incident_id;
    // a privileged account can still INSERT into the audit table directly (the migrator is trusted with DDL); the checks expose it
    await admin.query(
      "INSERT INTO Incident_Status_History (incident_id, old_status, new_status, changed_by, actor_name_snapshot, db_account, source, changed_at) VALUES (?, 'resolved', 'closed', 1, 'forger', USER(), 'import', '2026-09-30 00:00:00')", [id]);
    const failing: string[] = [];
    for (const q of queries) if ((await app.query<RowDataPacket[]>(q.sql))[0].length > 0) failing.push(q.name);
    expect(failing).toEqual(expect.arrayContaining(["status_chain_broken", "current_status_disagrees_with_history"]));
  });
});

describe("ground-truth labels (for the M4 evaluation; never loaded into the database)", () => {
  it("label every incident; campaign members and chain members really share IOCs in the database", async () => {
    const labels = JSON.parse(await readFile(path.join(SEED, "demo_labels.json"), "utf8")) as DemoLabels;
    expect(labels.incidents).toHaveLength(await count(admin, "SELECT COUNT(*) FROM Incidents"));
    const groups = new Map<string, number[]>();
    for (const l of labels.incidents) for (const g of [l.campaign, l.chain]) if (g) groups.set(g, [...(groups.get(g) ?? []), l.incident_id]);
    expect([...groups.keys()].filter((g) => g.startsWith("chain#"))).toHaveLength(3);
    for (const [g, ids] of groups) {
      const shared = await count(admin,
        `SELECT COUNT(*) FROM (SELECT ioc_id FROM Incident_IOC WHERE incident_id IN (?) GROUP BY ioc_id HAVING COUNT(*) >= 2) x`, [ids]);
      expect(shared, `${g} members share at least one IOC`).toBeGreaterThan(0);
    }
    const chainFamilies = labels.incidents.filter((l) => l.chain === "chain#1").map((l) => l.family).sort();
    expect(chainFamilies).toEqual(["c2_beaconing", "data_exfiltration", "malware_macro"]);
  });
});
