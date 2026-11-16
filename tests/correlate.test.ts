import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connection } from "mysql2/promise";
import * as similarRoute from "../src/app/api/incidents/[id]/similar/route";
import * as searchRoute from "../src/app/api/search/similar/route";
import * as syncRoute from "../src/app/api/sync/route";
import type { SessionUser } from "../src/lib/auth/session";
import { RANKING, correlate, hybridScore, similarToIncident, similarToText } from "../src/lib/correlate";
import { closeAppPool } from "../src/lib/db";
import { resetRequestBudgets } from "../src/lib/http";
import { collectionName, ensureCollection, qdrant } from "../src/lib/qdrant";
import { runSync } from "../src/lib/sync";
import { ANA, CY, MAX, as, freshSchema, makeIncident } from "./fixtures";
import { call, login, setPasswords } from "./http";

/**
 * Hybrid ranking (src/lib/correlate.ts) on real MySQL + Qdrant. IOC 2 = login-check.example, asset 1 = srv-a.
 *   1  Ana: helpdesk phishing                  IOC 2, asset 1        (the query incident)
 *   2  Ana: credential phishing, reworded      IOC 2                 -> similar text AND shared IOC
 *   3  Ana: phishing, reworded                 -                     -> similar text only
 *   4  Ana: ransomware                         asset 1               -> unrelated text, shared asset
 *   5  Ana: ransomware                         IOC 2 DISMISSED       -> the dismissed link must not count
 *   6  Cy:  helpdesk phishing                  IOC 2                 -> out of Ana's scope (option A)
 */
const ana: SessionUser = { id: ANA, name: "Ana Analyst", email: "ana@test.example", role: "analyst" };
const max: SessionUser = { id: MAX, name: "Max Admin", email: "max@test.example", role: "admin" };
let db: Connection;
const N: Record<number, [number, string]> = {
  1: [ANA, "Staff received an email pretending to be the IT helpdesk; the link led to a fake sign-in page that captured their passwords."],
  2: [ANA, "Several employees typed their credentials into a counterfeit login portal after a message that claimed to come from IT support."],
  3: [ANA, "Users were tricked by a phishing message into entering their passwords on a look-alike website."],
  4: [ANA, "Files on the finance server were encrypted overnight and a ransom note demanded payment in bitcoin."],
  5: [ANA, "Ransomware encrypted the shared drive and left instructions for paying the attackers."],
  6: [CY, "A phishing email impersonating the helpdesk harvested credentials through a fake page."],
};

beforeAll(async () => {
  db = await freshSchema();
  await setPasswords(db);
  for (const [id, [reporter, text]] of Object.entries(N)) {
    await as(db, reporter, () => db.query("INSERT INTO Incidents (incident_id, title, narrative, severity, reported_by) VALUES (?, ?, ?, 'high', ?)", [Number(id), `incident ${id}`, text, reporter]));
  }
  await as(db, MAX, async () => {
    for (const id of [1, 2, 5, 6]) await db.query("INSERT INTO Incident_IOC (incident_id, ioc_id) VALUES (?, 2)", [id]);
    for (const id of [1, 4]) await db.query("INSERT INTO Incident_Asset (incident_id, asset_id) VALUES (?, 1)", [id]);
    await db.query("UPDATE Incident_IOC SET review_status = 'dismissed' WHERE incident_id = 5");
  });
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await ensureCollection();
  await runSync();
});
afterAll(async () => {
  await qdrant().deleteCollection(collectionName()).catch(() => undefined);
  await db?.end();
  await closeAppPool();
});

describe("hybrid ranking", () => {
  it("similar text + shared IOC ranks first; every score equals the sum of its weighted components", async () => {
    const r = await similarToIncident(max, 1, 10);
    expect(r.mode).toBe("hybrid");
    // 2 and 6 both have similar text AND the shared IOC (6 is Cy's, visible to an admin); both beat 3 (text only)
    expect(r.results.slice(0, 2).map((x) => x.incident_id).sort()).toEqual([2, 6]);
    expect(r.results[2]!.incident_id).toBe(3);
    for (const x of r.results) {
      expect(x.score).toBeCloseTo(hybridScore(x.components), 2);
      expect(x.score).toBeCloseTo(x.contributions.text + x.contributions.iocs + x.contributions.assets, 2);
    }
    const top = r.results[0]!;
    expect(top.shared_iocs.map((s) => s.ioc_value)).toEqual(["login-check.example"]);
    expect(top.explanation).toMatch(/semantic text similarity · shares 1 IOC \(login-check\.example\)/);
    expect(top.components.iocs).toBe(1 / RANKING.iocSaturation);
  });

  it("excludes the query incident itself", async () => {
    expect((await similarToIncident(max, 1, 10)).results.map((x) => x.incident_id)).not.toContain(1);
  });

  it("an IOC link reviewed as dismissed (false positive) contributes nothing", async () => {
    const five = (await similarToIncident(max, 1, 10)).results.find((x) => x.incident_id === 5)!;
    expect(five.components.iocs).toBe(0);
    expect(five.shared_iocs).toEqual([]);
  });

  it("a shared asset is evidence too, but weak: the ransomware incident on the same server stays below the phishing ones", async () => {
    const r = (await similarToIncident(max, 1, 10)).results;
    const four = r.find((x) => x.incident_id === 4)!;
    expect(four.shared_assets.map((a) => a.asset_name)).toEqual(["srv-a"]);
    expect(r.findIndex((x) => x.incident_id === 4)).toBeGreaterThan(r.findIndex((x) => x.incident_id === 3));
  });

  it("visibility (option A): an analyst only gets incidents in her scope, and Cy's incident never appears", async () => {
    const r = await similarToIncident(ana, 1, 10);
    expect(r.results.map((x) => x.incident_id)).not.toContain(6);
    expect(r.notes.join(" ")).toMatch(/Only incidents you reported or are assigned to/);
    expect((await similarToIncident(max, 1, 10)).results.map((x) => x.incident_id)).toContain(6);
  });

  it("an archived incident never appears, even when it shares the IOC (relational path, not only the vector path)", async () => {
    await makeIncident(db, 7, "closed", { iocs: [2] });
    await as(db, MAX, () => db.query("CALL archive_incident(7, 'test')"));
    await runSync();
    const ids = (await similarToIncident(max, 1, 50)).results.map((x) => x.incident_id);
    expect(ids).not.toContain(7);
    expect(ids).toContain(2);
  });

  it("free text with an IOC typed in another case is normalised and matched", async () => {
    const r = await similarToText(max, { text: "someone entered their password on a fake helpdesk page", iocs: [{ ioc_type: "domain", ioc_value: "LOGIN-CHECK.example" }], asset_ids: [], k: 3 });
    expect(r.results[0]!.shared_iocs.map((s) => s.ioc_value)).toEqual(["login-check.example"]);
  });

  it("lexical fallback when the vector index is unavailable: labelled, never presented as semantic", async () => {
    await qdrant().deleteCollection(collectionName());
    try {
      const r = await correlate(max, { text: "ransom note bitcoin encrypted files", iocIds: [], assetIds: [] }, 5);
      expect(r.mode).toBe("lexical_fallback");
      expect(r.notes.join(" ")).toMatch(/KEYWORD-based/);
      expect(r.results.every((x) => x.components.text_kind === "lexical")).toBe(true);
      expect(r.results[0]!.incident_id === 4 || r.results[0]!.incident_id === 5).toBe(true);
    } finally {
      await ensureCollection();
      await db.query("UPDATE Embedding_Jobs SET status = 'pending', finished_at = NULL, attempts = 0");
      await runSync();
    }
  });
});

describe("HTTP", () => {
  it("GET /api/incidents/:id/similar: 200 for your incident, 404 for one outside your scope; POST /api/search/similar works", async () => {
    resetRequestBudgets();
    const ana = await login("ana@test.example");
    const mine = await call(similarRoute.GET, "GET", { cookie: ana, params: { id: "1" }, path: "/api/incidents/1/similar?k=3" });
    expect(mine.status).toBe(200);
    expect(mine.body.results.length).toBeLessThanOrEqual(3);
    expect((await call(similarRoute.GET, "GET", { cookie: ana, params: { id: "6" }, path: "/api/incidents/6/similar" })).status).toBe(404);
    const s = await call(searchRoute.POST, "POST", { cookie: ana, path: "/api/search/similar", body: { text: "fake login page from the helpdesk" } });
    expect(s.status).toBe(200);
    expect(s.body.results.map((x: { incident_id: number }) => x.incident_id)).not.toContain(6);
    expect((await call(searchRoute.POST, "POST", { cookie: ana, path: "/api/search/similar", body: { text: "x y z", status: "closed" } })).status).toBe(400);
  });

  it("/api/sync is admin-only; an admin sees the outbox state and can run it", async () => {
    const ana = await login("ana@test.example");
    expect((await call(syncRoute.GET, "GET", { cookie: ana, path: "/api/sync" })).status).toBe(403);
    const max = await login("max@test.example");
    const st = await call(syncRoute.GET, "GET", { cookie: max, path: "/api/sync" });
    expect(st.status).toBe(200);
    expect(st.body.incidents.synced).toBe(6);
    const run = await call(syncRoute.POST, "POST", { cookie: max, path: "/api/sync", body: { action: "repair" } });
    expect(run.status).toBe(200);
    expect(run.body.repaired.in_sync_before).toBe(true);
  });
});
