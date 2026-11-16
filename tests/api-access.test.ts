import type { Connection } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as analytics from "../src/app/api/analytics/route";
import * as assets from "../src/app/api/assets/route";
import * as incidents from "../src/app/api/incidents/route";
import * as incident from "../src/app/api/incidents/[id]/route";
import * as archive from "../src/app/api/incidents/[id]/archive/route";
import * as assetLinks from "../src/app/api/incidents/[id]/assets/route";
import * as assetLink from "../src/app/api/incidents/[id]/assets/[assetId]/route";
import * as closeR from "../src/app/api/incidents/[id]/close/route";
import * as iocs from "../src/app/api/incidents/[id]/iocs/route";
import * as ioc from "../src/app/api/incidents/[id]/iocs/[iocId]/route";
import * as notes from "../src/app/api/incidents/[id]/notes/route";
import * as reassign from "../src/app/api/incidents/[id]/reassign/route";
import * as transition from "../src/app/api/incidents/[id]/transition/route";
import * as users from "../src/app/api/users/route";
import * as user from "../src/app/api/users/[id]/route";
import * as userPassword from "../src/app/api/users/[id]/password/route";
import { closeAppPool } from "../src/lib/db";
import { resetRequestBudgets } from "../src/lib/http";
import { ANA, CY, count, freshSchema, makeIncident, one } from "./fixtures";
import { call, login, setPasswords, type Result } from "./http";

/**
 * Access control at the HTTP boundary (spec section 10, ADR-1 option A). Incidents:
 *   10  reported by Ana, assigned to Ana          (Ana's)
 *   20  reported by Ana, assigned to Cy           (both see it; only Cy works it)
 *   30  reported by Cy, unassigned                (Cy's)
 *   40  reported by Ana as the import account, assigned to Cy, investigating, with an IOC and an asset (Cy's work, Ana reported)
 *   50  reported by Max (admin), assigned to Cy   (NOT Ana's: the IDOR target)
 */
let db: Connection;
let ana: string, cy: string, max: string;
const p = (id: number | string, extra: Record<string, string> = {}) => ({ params: { id: String(id), ...extra } });

beforeAll(async () => {
  db = await freshSchema();
  await setPasswords(db);
  await makeIncident(db, 10, "assigned", { assignee: ANA });
  await makeIncident(db, 20, "assigned", { assignee: CY });
  await db.query("SET @sentinel_actor = 3");
  await db.query("INSERT INTO Incidents (incident_id, title, narrative, severity, reported_by) VALUES (30, 'cy own', 'n', 'low', 3)");
  await makeIncident(db, 40, "investigating", { assignee: CY, iocs: [1], assets: [1] });
  await db.query("SET @sentinel_actor = 2");
  await db.query("INSERT INTO Incidents (incident_id, title, narrative, severity, reported_by) VALUES (50, 'secret', 'confidential narrative', 'critical', 2)");
  await db.query("CALL reassign_incident(50, 3, 'triage')");
  await db.query("SET @sentinel_actor = NULL");
  [ana, cy, max] = [await login("ana@test.example"), await login("cy@test.example"), await login("max@test.example")];
});
afterAll(async () => { await closeAppPool(); await db?.end(); });
beforeEach(() => resetRequestBudgets());

const ids = (r: Result) => (r.body.incidents as Array<{ incident_id: number }>).map((i) => i.incident_id).sort((a, b) => a - b);

describe("visibility (option A)", () => {
  it("lists: analysts see what they reported or are assigned to; admins see everything", async () => {
    expect(ids(await call(incidents.GET, "GET", { cookie: ana }))).toEqual([10, 20, 40]);
    expect(ids(await call(incidents.GET, "GET", { cookie: cy }))).toEqual([20, 30, 40, 50]);
    expect(ids(await call(incidents.GET, "GET", { cookie: max }))).toEqual([10, 20, 30, 40, 50]);
  });
  it("filters and keyword search never widen the scope (searching for the secret's words finds nothing)", async () => {
    expect(ids(await call(incidents.GET, "GET", { cookie: ana, path: "/api/incidents?q=confidential" }))).toEqual([]);
    expect(ids(await call(incidents.GET, "GET", { cookie: max, path: "/api/incidents?q=confidential" }))).toEqual([50]);
    expect(ids(await call(incidents.GET, "GET", { cookie: ana, path: "/api/incidents?severity=critical" }))).toEqual([]);
    expect(ids(await call(incidents.GET, "GET", { cookie: ana, path: "/api/incidents?q=%25" }))).toEqual([]); // LIKE wildcard is escaped
    expect((await call(incidents.GET, "GET", { cookie: ana, path: "/api/incidents?owner=2" })).status).toBe(400); // unknown filter
  });
  it("IDOR: changing the id to someone else's incident answers 404 on EVERY incident endpoint and changes nothing", async () => {
    const before = await one(db, "SELECT title, status, assigned_to, updated_at FROM Incidents WHERE incident_id = 50");
    const notesBefore = await count(db, "SELECT COUNT(*) FROM Notes WHERE incident_id = 50");
    const attempts: Array<[string, Promise<Result>]> = [
      ["GET detail", call(incident.GET, "GET", { cookie: ana, ...p(50) })],
      ["PATCH", call(incident.PATCH, "PATCH", { cookie: ana, ...p(50), body: { title: "pwned" } })],
      ["transition", call(transition.POST, "POST", { cookie: ana, ...p(50), body: { to: "investigating" } })],
      ["note", call(notes.POST, "POST", { cookie: ana, ...p(50), body: { content: "hello" } })],
      ["link IOC", call(iocs.POST, "POST", { cookie: ana, ...p(50), body: { ioc_type: "ip", ioc_value: "203.0.113.99" } })],
      ["review IOC", call(ioc.PATCH, "PATCH", { cookie: ana, ...p(50, { iocId: "1" }), body: { review_status: "dismissed" } })],
      ["unlink IOC", call(ioc.DELETE, "DELETE", { cookie: ana, ...p(50, { iocId: "1" }) })],
      ["link asset", call(assetLinks.POST, "POST", { cookie: ana, ...p(50), body: { asset_id: 1 } })],
      ["describe asset", call(assetLink.PATCH, "PATCH", { cookie: ana, ...p(50, { assetId: "1" }), body: { impact_description: "x" } })],
      ["unlink asset", call(assetLink.DELETE, "DELETE", { cookie: ana, ...p(50, { assetId: "1" }) })],
      ["nonexistent id", call(incident.GET, "GET", { cookie: ana, ...p(99999) })],
      ["malformed id", call(incident.GET, "GET", { cookie: ana, ...p("50 OR 1=1") })],
    ];
    for (const [what, pr] of attempts) {
      const r = await pr;
      expect([what, r.status], what).toEqual([what, 404]);
      expect(r.text).not.toMatch(/secret|confidential/);
    }
    expect(await one(db, "SELECT title, status, assigned_to, updated_at FROM Incidents WHERE incident_id = 50")).toEqual(before);
    expect(await count(db, "SELECT COUNT(*) FROM Notes WHERE incident_id = 50")).toBe(notesBefore);
  });
  it("seeing is not the same as working: Ana reported #40 but Cy is assigned, so Ana's transition is refused by the database (403)", async () => {
    expect((await call(incident.GET, "GET", { cookie: ana, ...p(40) })).status).toBe(200);
    const r = await call(transition.POST, "POST", { cookie: ana, ...p(40), body: { to: "contained" } });
    expect([r.status, r.body.error.rule]).toEqual([403, "SDB11"]);
    expect((await call(incident.GET, "GET", { cookie: ana, ...p(40) })).body.allowed_transitions).toEqual([]);
    expect((await call(incident.GET, "GET", { cookie: cy, ...p(40) })).body.allowed_transitions.map((t: { to: string }) => t.to).sort()).toEqual(["contained", "resolved"]);
  });
});

describe("roles (admin-only endpoints answer 403 to analysts; anonymous requests 401)", () => {
  it("close, reassign, archive, users, password reset, analytics, asset registration", async () => {
    const adminOnly: Array<[string, Promise<Result>]> = [
      ["close", call(closeR.POST, "POST", { cookie: cy, ...p(40), body: {} })],
      ["reassign", call(reassign.POST, "POST", { cookie: cy, ...p(40), body: { assignee: 1, reason: "x" } })],
      ["archive", call(archive.POST, "POST", { cookie: cy, ...p(40), body: { reason: "x" } })],
      ["list users", call(users.GET, "GET", { cookie: cy })],
      ["create user", call(users.POST, "POST", { cookie: cy, body: { name: "x", email: "x@test.example", password: "long enough password", role: "admin" } })],
      ["promote self", call(user.PATCH, "PATCH", { cookie: cy, ...p(3), body: { role: "admin" } })],
      ["reset password", call(userPassword.POST, "POST", { cookie: cy, ...p(2), body: { password: "attacker chosen password" } })],
      ["analytics", call(analytics.GET, "GET", { cookie: cy })],
      ["register asset", call(assets.POST, "POST", { cookie: cy, body: { asset_name: "x", asset_type: "server", criticality_level: 1 } })],
    ];
    for (const [what, pr] of adminOnly) expect([what, (await pr).status]).toEqual([what, 403]);
    expect((await one(db, "SELECT role FROM Users WHERE user_id = 3")).role).toBe("analyst");
    for (const h of [incidents.GET, analytics.GET, users.GET]) expect((await call(h, "GET", {})).status).toBe(401);
    expect((await call(incidents.POST, "POST", { body: { title: "t", narrative: "n", severity: "low" } })).status).toBe(401);
  });
  it("admins can use them", async () => {
    expect((await call(analytics.GET, "GET", { cookie: max })).body.severity_status).toHaveLength(4);
    expect((await call(users.GET, "GET", { cookie: max })).body.users.length).toBe(4);
  });
});

describe("request hygiene", () => {
  it("no mass assignment: status, assignee, reporter, archive or version fields in a PATCH are rejected, not ignored", async () => {
    for (const body of [{ status: "closed" }, { assigned_to: 1 }, { reported_by: 1 }, { title: "ok", archived_at: "2020-01-01" }, { narrative_version: 9 }, {}]) {
      expect((await call(incident.PATCH, "PATCH", { cookie: cy, ...p(40), body })).status, JSON.stringify(body)).toBe(400);
    }
    const created = await call(incidents.POST, "POST", { cookie: ana, body: { title: "t", narrative: "n", severity: "low", reported_by: 2 } });
    expect(created.status).toBe(400);
  });
  it("the reporter of a new incident is always the signed-in user", async () => {
    const r = await call(incidents.POST, "POST", { cookie: ana, body: { title: "new one", narrative: "seen today", severity: "medium" } });
    expect(r.status).toBe(201);
    expect(await one(db, "SELECT reported_by, status, assigned_to FROM Incidents WHERE incident_id = ?", [r.body.incident_id]))
      .toEqual({ reported_by: ANA, status: "open", assigned_to: null });
  });
  it("CSRF: every state-changing endpoint refuses a cross-origin request", async () => {
    const evil = { origin: "https://evil.example" };
    for (const r of [
      await call(incidents.POST, "POST", { cookie: ana, ...evil, body: { title: "t", narrative: "n", severity: "low" } }),
      await call(incident.PATCH, "PATCH", { cookie: cy, ...evil, ...p(40), body: { title: "x" } }),
      await call(notes.POST, "POST", { cookie: cy, ...evil, ...p(40), body: { content: "x" } }),
      await call(user.PATCH, "PATCH", { cookie: max, ...evil, ...p(3), body: { role: "admin" } }),
    ]) expect(r.status).toBe(403);
    expect((await one(db, "SELECT role FROM Users WHERE user_id = 3")).role).toBe("analyst");
  });
  it("IOC values are validated per type and normalised", async () => {
    for (const [type, value] of [["ip", "999.1.1.1"], ["domain", "not a domain"], ["file_hash", "xyz"], ["url", "javascript:alert(1)"], ["email", "nope"]]) {
      expect((await call(iocs.POST, "POST", { cookie: cy, ...p(40), body: { ioc_type: type, ioc_value: value } })).status, `${type} ${value}`).toBe(400);
    }
    const ok = await call(iocs.POST, "POST", { cookie: cy, ...p(40), body: { ioc_type: "domain", ioc_value: "Evil-Login.EXAMPLE" } });
    expect(ok.status).toBe(201);
    expect((await one(db, "SELECT ioc_value FROM IOCs WHERE ioc_id = ?", [ok.body.ioc_id])).ioc_value).toBe("evil-login.example");
    expect((await call(iocs.POST, "POST", { cookie: cy, ...p(40), body: { ioc_type: "domain", ioc_value: "evil-login.example" } })).status).toBe(409);
  });
  it("password hashes never leave the server, in any response", async () => {
    const responses = [
      await call(users.GET, "GET", { cookie: max }),
      await call(user.GET, "GET", { cookie: max, ...p(1) }),
      await call(incident.GET, "GET", { cookie: max, ...p(40) }),
      await call(incidents.GET, "GET", { cookie: max }),
    ];
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/password_hash|\$scrypt\$/);
    }
  });
});
