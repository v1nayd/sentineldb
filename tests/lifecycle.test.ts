import type { Connection, Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "../src/lib/actor";
import { createAppPool } from "../src/lib/db";
import { closeIncident, LifecycleError, reassignIncident, transitionIncident, archiveIncident } from "../src/lib/lifecycle";
import { ANA, CY, MAX, TEST_DB, appConn, as, count, errnoOf, freshSchema, makeIncident, one, rejection, sdbCode } from "./fixtures";

/**
 * Incident lifecycle (migrations 0004, 0007, 0009). Writes go through the runtime TEST account via withActor() and the
 * procedures, exactly as the app will; privileged-path cases use the migrator to show the triggers hold even there.
 */
let admin: Connection;
let pool: Pool;
let app: Connection;

const history = async (id: number) => (await admin.query<RowDataPacket[]>(
  "SELECT old_status, new_status, changed_by, reason FROM Incident_Status_History WHERE incident_id = ? ORDER BY history_id", [id]))[0];
const incident = (id: number) => one(admin, "SELECT * FROM Incidents WHERE incident_id = ?", [id]);

beforeAll(async () => { admin = await freshSchema(); pool = createAppPool({ connectionLimit: 2 }); app = await appConn(); });
afterAll(async () => { await app?.end(); await pool?.end(); await admin?.end(); });

describe("creation", () => {
  it("the app creates an incident as open/unassigned/unresolved, and the origin row NULL -> open is written by the trigger", async () => {
    const id = await withActor(ANA, async (c) => {
      const [r] = await c.query("INSERT INTO Incidents (title, narrative, severity, reported_by) VALUES ('t', 'n', 'low', 1)");
      return (r as { insertId: number }).insertId;
    }, pool);
    expect(await incident(id)).toMatchObject({ status: "open", assigned_to: null, resolved_at: null, narrative_version: 1, archived_at: null });
    const h = await one(admin, "SELECT * FROM Incident_Status_History WHERE incident_id = ?", [id]);
    expect(h).toMatchObject({ old_status: null, new_status: "open", changed_by: ANA, actor_name_snapshot: "Ana Analyst", source: "runtime" });
    expect(String(h.db_account)).toMatch(/^sentinel_app_test@/);
  });

  it("a write with no acting user is rejected (SDB01), even a plain INSERT", async () => {
    const e = await rejection(app.query("INSERT INTO Incidents (title, narrative, severity, reported_by) VALUES ('t', 'n', 'low', 1)"));
    expect(sdbCode(e)).toBe("SDB01");
  });

  it("D1/D4 for privileged accounts too: inserting directly as closed, assigned or resolved is rejected (SDB10)", async () => {
    for (const cols of ["status) VALUES ('x','n','low',1,'closed')", "assigned_to) VALUES ('x','n','low',1,1)", "resolved_at) VALUES ('x','n','low',1,NOW())"]) {
      const e = await rejection(as(admin, ANA, () => admin.query(`INSERT INTO Incidents (title, narrative, severity, reported_by, ${cols}`)));
      expect(sdbCode(e), cols).toBe("SDB10");
    }
  });
});

describe("state machine", () => {
  beforeAll(async () => { await makeIncident(admin, 100); });

  it("D1: open -> closed / resolved / contained are rejected and change nothing", async () => {
    const before = await history(100);
    for (const to of ["resolved", "contained"] as const) {
      const e = await rejection(withActor(MAX, (c) => transitionIncident(c, 100, to), pool));
      expect(e).toBeInstanceOf(LifecycleError);
      expect((e as LifecycleError).code).toBe("SDB10");
    }
    expect(sdbCode(await rejection(withActor(MAX, (c) => closeIncident(c, 100), pool)))).toBe("SDB12"); // not resolved
    // even the privileged account cannot jump with a direct UPDATE
    expect(sdbCode(await rejection(as(admin, MAX, () => admin.query("UPDATE Incidents SET status = 'closed' WHERE incident_id = 100"))))).toBe("SDB10");
    expect((await incident(100)).status).toBe("open");
    expect(await history(100)).toEqual(before);
  });

  it("status changes need an assignee (SDB15), then only the assignee or an admin may move it (SDB11)", async () => {
    expect(sdbCode(await rejection(withActor(MAX, (c) => transitionIncident(c, 100, "investigating"), pool)))).toBe("SDB15");
    await withActor(MAX, (c) => reassignIncident(c, 100, ANA, "triage"), pool);
    expect(sdbCode(await rejection(withActor(CY, (c) => transitionIncident(c, 100, "investigating"), pool)))).toBe("SDB11");
  });

  it("each valid transition writes exactly one history row with the actor; resolved_at follows the status", async () => {
    await withActor(ANA, (c) => transitionIncident(c, 100, "investigating"), pool);
    await withActor(ANA, (c) => transitionIncident(c, 100, "contained"), pool);
    expect(sdbCode(await rejection(withActor(ANA, (c) => transitionIncident(c, 100, "investigating"), pool)))).toBe("SDB10"); // needs a reason
    await withActor(ANA, (c) => transitionIncident(c, 100, "investigating", "containment failed"), pool);
    await withActor(ANA, (c) => transitionIncident(c, 100, "resolved"), pool);
    const h = await history(100);
    expect(h.map((r) => `${r.old_status}->${r.new_status}`)).toEqual([
      "null->open", "open->investigating", "investigating->contained", "contained->investigating", "investigating->resolved"]);
    expect(h.slice(1).every((r) => r.changed_by === ANA)).toBe(true);
    expect(h[3]!.reason).toBe("containment failed");
    const i = await incident(100);
    expect(i.status).toBe("resolved");
    expect(i.resolved_at).toBeInstanceOf(Date);
  });

  it("transition_incident refuses 'closed' (closing has its own rules)", async () => {
    expect(sdbCode(await rejection(withActor(MAX, (c) => c.query("CALL transition_incident(100, 'closed', NULL)"), pool)))).toBe("SDB10");
  });
});

describe("ADR-6: only REAL changes are audited", () => {
  beforeAll(async () => { await makeIncident(admin, 110, "investigating"); });

  it("no-op updates (SET status = status, same title, same narrative) write no history and do not move updated_at", async () => {
    const before = { h: await history(110), i: await incident(110) };
    await as(admin, ANA, () => admin.query("UPDATE Incidents SET status = status WHERE incident_id = 110"));
    await admin.query("UPDATE Incidents SET status = status WHERE incident_id = 110"); // no actor needed for a no-op
    await withActor(ANA, (c) => c.query("UPDATE Incidents SET title = title, narrative = narrative, severity = severity WHERE incident_id = 110"), pool);
    expect(await history(110)).toEqual(before.h);
    expect((await incident(110)).updated_at).toEqual(before.i.updated_at);
  });

  it("editing other columns writes no status row; a narrative edit bumps narrative_version, even a case-only edit", async () => {
    const h = await history(110);
    await withActor(ANA, (c) => c.query("UPDATE Incidents SET title = 'renamed', severity = 'critical' WHERE incident_id = 110"), pool);
    expect((await incident(110)).narrative_version).toBe(1);
    await withActor(ANA, (c) => c.query("UPDATE Incidents SET narrative = 'Narrative of incident 110' WHERE incident_id = 110"), pool); // only N -> n
    expect((await incident(110)).narrative_version).toBe(2);
    await withActor(ANA, (c) => c.query("UPDATE Incidents SET narrative = 'a different text' WHERE incident_id = 110"), pool);
    expect((await incident(110)).narrative_version).toBe(3);
    expect(await history(110)).toEqual(h);
  });

  it("derived and identity columns cannot be written, not even by the privileged account", async () => {
    for (const [set, code] of [["resolved_at = NOW()", "SDB17"], ["updated_at = '2020-01-01'", "SDB17"], ["narrative_version = 9", "SDB17"],
      ["reported_by = 2", "SDB16"], ["created_at = '2020-01-01'", "SDB16"]] as const) {
      expect(sdbCode(await rejection(as(admin, ANA, () => admin.query(`UPDATE Incidents SET ${set} WHERE incident_id = 110`)))), set).toBe(code);
    }
    expect(errnoOf(await rejection(as(app, ANA, () => app.query("UPDATE Incidents SET status = 'resolved' WHERE incident_id = 110"))))).toBe(1143);
  });
});

describe("closure rule (close_incident, Phase 1 spec section 16)", () => {
  beforeAll(async () => { await makeIncident(admin, 120, "resolved", { iocs: [1, 2], assets: [1], review: false, impact: false }); });

  it("analysts cannot close (SDB11); closure is blocked while an IOC is unreviewed or an asset impact is undescribed", async () => {
    expect(sdbCode(await rejection(withActor(ANA, (c) => closeIncident(c, 120), pool)))).toBe("SDB11");
    const e = await rejection(withActor(MAX, (c) => closeIncident(c, 120), pool));
    expect((e as LifecycleError).code).toBe("SDB12");
    expect((e as LifecycleError).message).toMatch(/2 IOC\(s\) unreviewed, 1 asset\(s\) without impact description/);
    await withActor(ANA, (c) => c.query("UPDATE Incident_IOC SET review_status = 'confirmed' WHERE incident_id = 120 AND ioc_id = 1"), pool);
    await withActor(ANA, (c) => c.query("UPDATE Incident_IOC SET review_status = 'dismissed' WHERE incident_id = 120 AND ioc_id = 2"), pool);
    expect((await rejection(withActor(MAX, (c) => closeIncident(c, 120), pool)) as Error).message).toMatch(/0 IOC\(s\) unreviewed, 1 asset/);
    await withActor(ANA, (c) => c.query("UPDATE Incident_Asset SET impact_description = '   ' WHERE incident_id = 120"), pool); // blank does not count
    expect(sdbCode(await rejection(withActor(MAX, (c) => closeIncident(c, 120), pool)))).toBe("SDB12");
    expect((await incident(120)).status).toBe("resolved");
  });

  it("succeeds once the evidence is complete; the history row carries the admin and reason; resolved_at is kept", async () => {
    const resolvedAt = (await incident(120)).resolved_at;
    await withActor(ANA, (c) => c.query("UPDATE Incident_Asset SET impact_description = 'login endpoint targeted' WHERE incident_id = 120"), pool);
    await withActor(MAX, (c) => closeIncident(c, 120, "evidence reviewed"), pool);
    const i = await incident(120);
    expect(i.status).toBe("closed");
    expect(i.resolved_at).toEqual(resolvedAt);
    expect((await history(120)).at(-1)).toMatchObject({ old_status: "resolved", new_status: "closed", changed_by: MAX, reason: "evidence reviewed" });
  });

  it("the rule cannot be bypassed: the trigger re-checks it on a direct privileged UPDATE", async () => {
    await makeIncident(admin, 121, "resolved", { iocs: [1], review: false });
    expect(sdbCode(await rejection(as(admin, MAX, () => admin.query("UPDATE Incidents SET status = 'closed' WHERE incident_id = 121"))))).toBe("SDB12");
  });

  it("a closed incident is frozen: no edits, no evidence changes, no reassignment; notes are still allowed", async () => {
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("UPDATE Incidents SET title = 'x' WHERE incident_id = 120"), pool)))).toBe("SDB13");
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("INSERT INTO Incident_IOC (incident_id, ioc_id) VALUES (120, 3)"), pool)))).toBe("SDB13");
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("DELETE FROM Incident_IOC WHERE incident_id = 120"), pool)))).toBe("SDB13");
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("UPDATE Incident_IOC SET review_status = 'pending' WHERE incident_id = 120"), pool)))).toBe("SDB13");
    expect(sdbCode(await rejection(withActor(MAX, (c) => reassignIncident(c, 120, CY, "handover"), pool)))).toBe("SDB13");
    await withActor(ANA, (c) => c.query("INSERT INTO Notes (incident_id, author_id, content) VALUES (120, 1, 'post-incident note')"), pool);
  });

  it("reopening a closed incident is admin-only and needs a reason; it clears resolved_at", async () => {
    expect(sdbCode(await rejection(withActor(ANA, (c) => transitionIncident(c, 120, "investigating", "again"), pool)))).toBe("SDB11");
    expect(sdbCode(await rejection(withActor(MAX, (c) => transitionIncident(c, 120, "investigating"), pool)))).toBe("SDB10");
    await withActor(MAX, (c) => transitionIncident(c, 120, "investigating", "indicator seen again"), pool);
    expect(await incident(120)).toMatchObject({ status: "investigating", resolved_at: null });
  });
});

describe("archive and retention (ADR-4, defect D3)", () => {
  beforeAll(async () => { await makeIncident(admin, 130, "closed"); await makeIncident(admin, 131, "investigating"); });

  it("only admins archive, only closed incidents, only with a reason", async () => {
    expect(sdbCode(await rejection(withActor(ANA, (c) => archiveIncident(c, 130, "retention"), pool)))).toBe("SDB11");
    expect(sdbCode(await rejection(withActor(MAX, (c) => archiveIncident(c, 131, "retention"), pool)))).toBe("SDB14");
    expect(sdbCode(await rejection(withActor(MAX, (c) => archiveIncident(c, 130, "  "), pool)))).toBe("SDB14");
    await withActor(MAX, (c) => archiveIncident(c, 130, "retention review"), pool);
    expect(await incident(130)).toMatchObject({ archived_by: MAX, archive_reason: "retention review" });
  });

  it("an archived incident is read-only for everyone, including reopening and notes; it leaves the summary view", async () => {
    expect(sdbCode(await rejection(withActor(MAX, (c) => transitionIncident(c, 130, "investigating", "x"), pool)))).toBe("SDB14");
    expect(sdbCode(await rejection(as(admin, MAX, () => admin.query("UPDATE Incidents SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE incident_id = 130"))))).toBe("SDB14");
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("INSERT INTO Notes (incident_id, author_id, content) VALUES (130, 1, 'x')"), pool)))).toBe("SDB14");
    expect(await count(admin, "SELECT COUNT(*) FROM incident_summary_view WHERE incident_id = 130")).toBe(0);
  });

  it("incidents are never deleted: the trigger refuses (SDB19) and the app has no DELETE grant", async () => {
    expect(sdbCode(await rejection(admin.query("DELETE FROM Incidents WHERE incident_id = 131")))).toBe("SDB19");
    expect(errnoOf(await rejection(app.query("DELETE FROM Incidents WHERE incident_id = 131")))).toBe(1142);
    expect(await count(admin, "SELECT COUNT(*) FROM Incidents WHERE incident_id = 131")).toBe(1);
  });

  it("D3: no foreign key in the schema can cascade or null out evidence (InnoDB cascades would bypass every trigger)", async () => {
    const [rows] = await admin.query<RowDataPacket[]>(
      "SELECT TABLE_NAME, CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?", [TEST_DB]);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.filter((r) => r.DELETE_RULE !== "RESTRICT")).toEqual([]);
  });

  it("audit rows and notes are immutable even for the privileged account (SDB20)", async () => {
    for (const t of ["Incident_Status_History", "Incident_Assignment_History", "Incident_Evidence_History", "Notes"]) {
      // incident 120 has rows in all four tables (status changes, assignment, IOC/asset links, notes)
      expect(sdbCode(await rejection(admin.query(`DELETE FROM ${t} WHERE incident_id = 120`))), `DELETE ${t}`).toBe("SDB20");
      expect(sdbCode(await rejection(admin.query(`UPDATE ${t} SET incident_id = incident_id + 0 WHERE incident_id = 120`))), `UPDATE ${t}`).toBe("SDB20");
    }
  });

  it("CHECK constraints back the triggers: a self-transition history row is rejected by chk_ish_real_change", async () => {
    const e = await rejection(admin.query(
      "INSERT INTO Incident_Status_History (incident_id, old_status, new_status, changed_by, actor_name_snapshot, db_account, source) VALUES (131, 'open', 'open', 1, 'x', 'x', 'import')"));
    expect(errnoOf(e)).toBe(3819);
  });

  it("the audit keeps the actor's name as it was, even after the user is renamed", async () => {
    await as(admin, ANA, () => admin.query("UPDATE Users SET name = 'Ana Renamed' WHERE user_id = 1")); // users may rename themselves (0013)
    expect((await one(admin, "SELECT actor_name_snapshot FROM Incident_Status_History WHERE incident_id = 131 AND new_status = 'investigating'")).actor_name_snapshot).toBe("Ana Analyst");
  });
});
