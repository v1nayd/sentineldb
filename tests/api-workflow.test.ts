import type { Connection } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as loginRoute from "../src/app/api/auth/login/route";
import * as assetsR from "../src/app/api/assets/route";
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
import { loadNamedQueries } from "../src/lib/reports";
import { ANA, MAX, ROOT, appConn, freshSchema } from "./fixtures";
import { PASSWORD, call, login, setPasswords } from "./http";
import path from "node:path";

/** A full incident lifecycle and account administration, driven only through the HTTP API. */
let db: Connection;
let ana: string, max: string;
const p = (id: number, extra: Record<string, string> = {}) => ({ params: { id: String(id), ...extra } });

beforeAll(async () => {
  db = await freshSchema();
  await setPasswords(db);
  [ana, max] = [await login("ana@test.example"), await login("max@test.example")];
});
afterAll(async () => { await closeAppPool(); await db?.end(); });
beforeEach(() => resetRequestBudgets());

describe("incident lifecycle over HTTP; database rules surface as precise status codes", () => {
  let id = 0;
  it("report -> triage -> investigate -> evidence -> resolve -> blocked close -> fix evidence -> close -> frozen -> reopen -> close -> archive", async () => {
    const created = await call(incidents.POST, "POST", { cookie: ana, body: { title: "Phishing wave", narrative: "Fake sign-in page.", severity: "high" } });
    expect(created.status).toBe(201);
    id = created.body.incident_id;
    expect(created.headers.get("location")).toBe(`/api/incidents/${id}`);

    expect((await call(transition.POST, "POST", { cookie: ana, ...p(id), body: { to: "investigating" } })).body.error.rule).toBe("SDB15"); // unassigned
    expect((await call(reassign.POST, "POST", { cookie: max, ...p(id), body: { assignee: ANA, reason: "triage" } })).status).toBe(200);
    expect((await call(transition.POST, "POST", { cookie: ana, ...p(id), body: { to: "closed" } })).status).toBe(400); // closing has its own endpoint
    const bad = await call(transition.POST, "POST", { cookie: ana, ...p(id), body: { to: "resolved" } });
    expect([bad.status, bad.body.error.rule]).toEqual([409, "SDB10"]); // open -> resolved is not a transition
    expect((await call(transition.POST, "POST", { cookie: ana, ...p(id), body: { to: "investigating" } })).body.incident.status).toBe("investigating");

    const linked = await call(iocs.POST, "POST", { cookie: ana, ...p(id), body: { ioc_type: "domain", ioc_value: "login-verify.example", threat_level: "high", notes: "landing page" } });
    expect(linked.status).toBe(201);
    const iocId = linked.body.ioc_id as number;
    expect((await call(assetLinks.POST, "POST", { cookie: ana, ...p(id), body: { asset_id: 1 } })).status).toBe(201);
    expect((await call(assetLinks.POST, "POST", { cookie: ana, ...p(id), body: { asset_id: 999 } })).status).toBe(404);
    expect((await call(notes.POST, "POST", { cookie: ana, ...p(id), body: { content: "Blocked the domain at the proxy." } })).status).toBe(201);
    expect((await call(transition.POST, "POST", { cookie: ana, ...p(id), body: { to: "resolved" } })).body.incident.status).toBe("resolved");

    const blocked = await call(closeR.POST, "POST", { cookie: max, ...p(id), body: { reason: "done" } });
    expect([blocked.status, blocked.body.error.rule]).toEqual([409, "SDB12"]);
    expect(blocked.body.error.message).toMatch(/1 IOC\(s\) unreviewed, 1 asset\(s\) without impact description/);

    expect((await call(ioc.PATCH, "PATCH", { cookie: ana, ...p(id, { iocId: String(iocId) }), body: { review_status: "confirmed" } })).status).toBe(200);
    expect((await call(assetLink.PATCH, "PATCH", { cookie: ana, ...p(id, { assetId: "1" }), body: { impact_description: "credentials entered" } })).status).toBe(200);
    const closed = await call(closeR.POST, "POST", { cookie: max, ...p(id), body: { reason: "evidence complete" } });
    expect(closed.body.incident.status).toBe("closed");

    const frozen = await call(incident.PATCH, "PATCH", { cookie: ana, ...p(id), body: { title: "edited" } });
    expect([frozen.status, frozen.body.error.rule]).toEqual([409, "SDB13"]);
    expect((await call(archive.POST, "POST", { cookie: max, ...p(id), body: {} })).status).toBe(400); // reason required by the schema
    const reopenNoReason = await call(transition.POST, "POST", { cookie: max, ...p(id), body: { to: "investigating" } });
    expect([reopenNoReason.status, reopenNoReason.body.error.rule]).toEqual([409, "SDB10"]);
    expect((await call(transition.POST, "POST", { cookie: max, ...p(id), body: { to: "investigating", reason: "seen again" } })).body.incident.resolved_at).toBeNull();
    const notClosed = await call(archive.POST, "POST", { cookie: max, ...p(id), body: { reason: "retention" } });
    expect([notClosed.status, notClosed.body.error.rule]).toEqual([409, "SDB14"]);
    await call(transition.POST, "POST", { cookie: ana, ...p(id), body: { to: "resolved" } });
    await call(closeR.POST, "POST", { cookie: max, ...p(id), body: {} });
    const archived = await call(archive.POST, "POST", { cookie: max, ...p(id), body: { reason: "retention" } });
    expect(archived.body.incident.archived_at).not.toBeNull();
    expect(archived.body.allowed_transitions).toEqual([]);
    expect((await call(incidents.GET, "GET", { cookie: ana })).body.incidents.map((i: { incident_id: number }) => i.incident_id)).not.toContain(id);
  });

  it("the detail view carries the complete, actor-attributed timeline", async () => {
    const d = (await call(incident.GET, "GET", { cookie: max, ...p(id) })).body;
    expect(d.status_history.map((h: { old_status: string | null; new_status: string }) => `${h.old_status}->${h.new_status}`)).toEqual([
      "null->open", "open->investigating", "investigating->resolved", "resolved->closed", "closed->investigating", "investigating->resolved", "resolved->closed"]);
    expect(d.status_history[0].changed_by).toBe(ANA);
    expect(d.status_history[3]).toMatchObject({ changed_by: MAX, reason: "evidence complete" });
    expect(d.assignment_history).toHaveLength(1);
    expect(d.evidence_history.map((e: { action: string }) => e.action)).toEqual(["linked", "linked", "reviewed"]);
    expect(d.notes.map((n: { content: string }) => n.content)).toEqual(["Assigned to Ana Analyst: triage", "Blocked the domain at the proxy."]);
  });

  it("the audit trail written through the API passes every integrity check", async () => {
    const app = await appConn();
    try {
      for (const q of await loadNamedQueries(path.join(ROOT, "db/reports/integrity.sql"))) expect((await app.query(q.sql))[0], q.name).toEqual([]);
    } finally { await app.end(); }
  });
});

describe("account administration over HTTP", () => {
  it("an admin creates an account; it can log in; duplicates (any case) are refused; weak passwords are refused", async () => {
    const created = await call(users.POST, "POST", { cookie: max, body: { name: "New Analyst", email: "New.Analyst@Test.Example", password: "a sufficiently long one", role: "analyst" } });
    expect(created.status).toBe(201);
    expect((await call(users.POST, "POST", { cookie: max, body: { name: "Dup", email: "new.analyst@test.example", password: "a sufficiently long one", role: "analyst" } })).status).toBe(409);
    expect((await call(users.POST, "POST", { cookie: max, body: { name: "Weak", email: "weak@test.example", password: "short", role: "analyst" } })).status).toBe(400);
    expect((await call(loginRoute.POST, "POST", { body: { email: "new.analyst@test.example", password: "a sufficiently long one" } })).status).toBe(200);
    const hist = (await call(user.GET, "GET", { cookie: max, ...p(created.body.user_id) })).body.history;
    expect(hist[0]).toMatchObject({ action: "created", changed_by: MAX, source: "runtime" });
  });

  it("role changes and the last-admin rule: demoting the second-to-last admin works, the last one is protected (409)", async () => {
    expect((await call(user.PATCH, "PATCH", { cookie: max, ...p(4), body: { role: "analyst" } })).body.user.role).toBe("analyst");
    const last = await call(user.PATCH, "PATCH", { cookie: max, ...p(MAX), body: { active: false } });
    expect([last.status, last.body.error.rule]).toEqual([409, "SDB40"]);
    expect((await call(user.PATCH, "PATCH", { cookie: max, ...p(MAX), body: { role: "analyst" } })).status).toBe(409);
    expect((await call(user.PATCH, "PATCH", { cookie: max, ...p(999), body: { role: "admin" } })).status).toBe(404);
  });

  it("an admin password reset ends the user's sessions; the new password works, the old one does not", async () => {
    const before = await login("ana@test.example");
    expect((await call(userPassword.POST, "POST", { cookie: max, ...p(ANA), body: { password: "reset by the admin today" } })).status).toBe(200);
    expect((await call(incidents.GET, "GET", { cookie: before })).status).toBe(401);
    expect((await call(loginRoute.POST, "POST", { body: { email: "ana@test.example", password: PASSWORD } })).status).toBe(401);
    expect((await call(loginRoute.POST, "POST", { body: { email: "ana@test.example", password: "reset by the admin today" } })).status).toBe(200);
  });

  it("assets: everyone reads the inventory, admins maintain it", async () => {
    expect((await call(assetsR.GET, "GET", { cookie: max })).body.assets.length).toBe(2);
    expect((await call(assetsR.POST, "POST", { cookie: max, body: { asset_name: "new-srv", asset_type: "server", criticality_level: 3 } })).status).toBe(201);
  });
});
