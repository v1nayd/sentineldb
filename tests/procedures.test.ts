import type { Connection, Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withActor } from "../src/lib/actor";
import { createAppPool } from "../src/lib/db";
import { reassignIncident, transitionIncident } from "../src/lib/lifecycle";
import { ANA, CY, DEE, MAX, appConn, as, count, freshSchema, makeIncident, one, rejection, sdbCode } from "./fixtures";

/**
 * Transactions (Phase 1 spec: "transactional multi-step reassignment workflow"; roadmap M2: "successful reassignment +
 * forced rollback leaves audit consistent"). reassign_incident does: lock row -> validate -> UPDATE assigned_to
 * (trigger writes the assignment audit row) -> INSERT handover note. The rollback tests make the LAST step fail by
 * injecting a failing trigger on Notes, and prove that the earlier steps (including the trigger-written audit row)
 * are undone, both when the procedure owns the transaction and when it runs inside the caller's.
 */
let admin: Connection;
let pool: Pool;

const FAULT = "zz_fault_injection_notes";
const injectNoteFailure = () => admin.query(
  `CREATE TRIGGER ${FAULT} BEFORE INSERT ON Notes FOR EACH ROW FOLLOWS trg_notes_before_insert
     SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED: note write failed'`);
const removeFault = () => admin.query(`DROP TRIGGER IF EXISTS ${FAULT}`);
const snapshot = async (id: number) => ({
  incident: await one(admin, "SELECT status, assigned_to, updated_at FROM Incidents WHERE incident_id = ?", [id]),
  assignments: await count(admin, "SELECT COUNT(*) FROM Incident_Assignment_History WHERE incident_id = ?", [id]),
  statuses: await count(admin, "SELECT COUNT(*) FROM Incident_Status_History WHERE incident_id = ?", [id]),
  notes: await count(admin, "SELECT COUNT(*) FROM Notes WHERE incident_id = ?", [id]),
});

beforeAll(async () => { admin = await freshSchema(); pool = createAppPool({ connectionLimit: 4 }); });
afterAll(async () => { await removeFault(); await pool?.end(); await admin?.end(); });
beforeEach(removeFault);

describe("reassign_incident: the successful path", () => {
  it("changes the assignee, writes one assignment audit row and one handover note, atomically", async () => {
    await makeIncident(admin, 1, "investigating");
    await withActor(MAX, (c) => reassignIncident(c, 1, CY, "Shift handover"), pool);
    const rows = (await admin.query<RowDataPacket[]>("SELECT old_assignee, new_assignee, changed_by, reason, source FROM Incident_Assignment_History WHERE incident_id = 1 ORDER BY assignment_event_id"))[0];
    expect(rows).toEqual([
      { old_assignee: null, new_assignee: ANA, changed_by: MAX, reason: "triage", source: "import" },
      { old_assignee: ANA, new_assignee: CY, changed_by: MAX, reason: "Shift handover", source: "runtime" },
    ]);
    const note = await one(admin, "SELECT author_id, content FROM Notes WHERE incident_id = 1 ORDER BY note_id DESC LIMIT 1");
    expect(note).toEqual({ author_id: MAX, content: "Reassigned from Ana Analyst to Cy Analyst: Shift handover" });
    // the new assignee can now work it, the old one cannot
    expect(sdbCode(await rejection(withActor(ANA, (c) => transitionIncident(c, 1, "contained"), pool)))).toBe("SDB11");
    await withActor(CY, (c) => transitionIncident(c, 1, "contained"), pool);
  });

  it("validates before writing: analysts cannot reassign; unknown user, same user, missing reason are rejected; nothing changes", async () => {
    await makeIncident(admin, 2, "investigating");
    const before = await snapshot(2);
    expect(sdbCode(await rejection(withActor(ANA, (c) => reassignIncident(c, 2, CY, "mine now"), pool)))).toBe("SDB11");
    expect(sdbCode(await rejection(withActor(MAX, (c) => reassignIncident(c, 2, 999, "x"), pool)))).toBe("SDB30");
    expect(sdbCode(await rejection(withActor(MAX, (c) => reassignIncident(c, 2, ANA, "x"), pool)))).toBe("SDB30");
    expect(sdbCode(await rejection(withActor(MAX, (c) => reassignIncident(c, 2, CY, "  "), pool)))).toBe("SDB30");
    expect(sdbCode(await rejection(withActor(MAX, (c) => reassignIncident(c, 999, CY, "x"), pool)))).toBe("SDB31");
    expect(await snapshot(2)).toEqual(before);
  });
});

describe("forced rollback: the last step fails, nothing of the earlier steps survives", () => {
  it("procedure-owned transaction (autocommit caller): assignment and its audit row are rolled back", async () => {
    await makeIncident(admin, 3, "investigating");
    const before = await snapshot(3);
    await injectNoteFailure();
    const app = await appConn();
    try {
      const e = await rejection(as(app, MAX, () => app.query("CALL reassign_incident(3, 3, 'handover')")));
      expect((e as { sqlMessage: string }).sqlMessage).toBe("INJECTED: note write failed");
      expect((await app.query<RowDataPacket[]>("SELECT @sentinel_reason AS r"))[0][0]!.r).toBeNull(); // the handler cleared it
    } finally { await app.end(); }
    expect(await snapshot(3)).toEqual(before);
  });

  it("caller-owned transaction (withActor): the whole unit, including the caller's earlier step, is rolled back", async () => {
    await makeIncident(admin, 4, "investigating");
    const before = await snapshot(4);
    await injectNoteFailure();
    const e = await rejection(withActor(MAX, async (c) => {
      await transitionIncident(c, 4, "contained");        // step 1 succeeds inside the caller's transaction
      await reassignIncident(c, 4, CY, "handover");        // step 2 fails at its last statement
    }, pool));
    expect((e as { sqlMessage: string }).sqlMessage).toBe("INJECTED: note write failed");
    expect(await snapshot(4)).toEqual(before);
  });

  it("savepoint semantics: inside a caller's transaction a failed procedure undoes ONLY its own work", async () => {
    await makeIncident(admin, 5, "investigating");
    await injectNoteFailure();
    const app = await appConn();
    try {
      await app.query("SET @sentinel_actor = ?", [MAX]);
      await app.beginTransaction();
      await app.query("CALL transition_incident(5, 'contained', NULL)");            // caller's step, kept
      await expect(app.query("CALL reassign_incident(5, 3, 'handover')")).rejects.toMatchObject({ sqlMessage: "INJECTED: note write failed" });
      await app.commit();                                                          // the caller decides to keep step 1
      await app.query("SET @sentinel_actor = NULL");
    } finally { await app.end(); }
    const after = await snapshot(5);
    expect(after.incident).toMatchObject({ status: "contained", assigned_to: ANA }); // transition kept, reassignment gone
    expect(after.assignments).toBe(1);                                              // only the triage row
  });
});

describe("concurrency (two sessions, real row locks)", () => {
  it("concurrent reassignments serialise on the row lock: the second sees the first's result (no lost update)", async () => {
    await makeIncident(admin, 6, "investigating");
    const a = await appConn();
    const b = await appConn();
    try {
      await a.query("SET @sentinel_actor = ?", [MAX]);
      await b.query("SET @sentinel_actor = ?", [DEE]);
      await a.beginTransaction();
      await a.query("CALL reassign_incident(6, 3, 'first')");     // holds the incident row lock until commit
      let bDone = false;
      const bCall = b.query("CALL reassign_incident(6, 2, 'second')").then(() => { bDone = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(bDone).toBe(false);                                   // B is blocked on A's lock
      await a.commit();
      await bCall;
    } finally { await a.end(); await b.end(); }
    const rows = (await admin.query<RowDataPacket[]>("SELECT old_assignee, new_assignee, reason FROM Incident_Assignment_History WHERE incident_id = 6 ORDER BY assignment_event_id"))[0];
    expect(rows.map((r) => [r.old_assignee, r.new_assignee, r.reason])).toEqual([[null, ANA, "triage"], [ANA, CY, "first"], [CY, MAX, "second"]]);
    // B's note names A's assignee as the previous one: it read the row AFTER A committed (FOR UPDATE), not a stale snapshot
    expect((await one(admin, "SELECT content FROM Notes WHERE incident_id = 6 ORDER BY note_id DESC LIMIT 1")).content).toBe("Reassigned from Cy Analyst to Max Admin: second");
  });

  it("closure vs. a concurrent IOC link: the link waits for close_incident and is then refused (no unreviewed IOC on a closed incident)", async () => {
    await makeIncident(admin, 7, "resolved", { iocs: [1] });
    const closer = await appConn();
    const linker = await appConn();
    try {
      await closer.query("SET @sentinel_actor = ?", [MAX]);
      await linker.query("SET @sentinel_actor = ?", [ANA]);
      await closer.beginTransaction();
      await closer.query("CALL close_incident(7, 'done')");
      let settled = false;
      const link = linker.query("INSERT INTO Incident_IOC (incident_id, ioc_id) VALUES (7, 2)").then(
        () => { settled = true; return null; }, (e) => { settled = true; return e; });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);                                 // blocked by the closer's lock on the incident
      await closer.commit();
      expect(sdbCode(await link)).toBe("SDB13");
    } finally { await closer.end(); await linker.end(); }
    expect(await count(admin, "SELECT COUNT(*) FROM Incident_IOC WHERE incident_id = 7")).toBe(1);
  });
});

describe("procedures are the only lifecycle path for the runtime account", () => {
  it("the app account can EXECUTE the lifecycle (M2) and account (M3) procedures but none of the internal sdb_* routines", async () => {
    const app = await appConn();
    try {
      const [rows] = await app.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER()");
      const procs = rows.map((r) => String(Object.values(r)[0])).filter((l) => /EXECUTE ON PROCEDURE/i.test(l))
        .map((l) => /PROCEDURE `[^`]+`\.`([^`]+)`/i.exec(l)![1]!.toLowerCase()).sort();
      expect(procs).toEqual(["archive_incident", "auth_lookup", "close_incident", "create_user", "reassign_incident",
        "set_password_hash", "set_user_active", "set_user_role", "transition_incident"]);
      await expect(app.query("CALL sdb_assert_incident_writable(1, TRUE)")).rejects.toMatchObject({ errno: 1370 });
      await expect(app.query("SELECT sdb_now()")).rejects.toMatchObject({ errno: 1370 });
    } finally { await app.end(); }
  });
});
