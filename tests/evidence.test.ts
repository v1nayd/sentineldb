import type { Connection, Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "../src/lib/actor";
import { createAppPool } from "../src/lib/db";
import { closeIncident, reviewIncidentIoc } from "../src/lib/lifecycle";
import { ANA, CY, MAX, as, errnoOf, freshSchema, makeIncident, one, rejection, sdbCode } from "./fixtures";

/** Evidence links and IOC review (migration 0008): who linked, unlinked and reviewed what is always recorded. */
let admin: Connection;
let pool: Pool;
const events = async (id: number) => (await admin.query<RowDataPacket[]>(
  "SELECT ioc_id, asset_id, action, detail, changed_by FROM Incident_Evidence_History WHERE incident_id = ? ORDER BY evidence_event_id", [id]))[0];

beforeAll(async () => { admin = await freshSchema(); pool = createAppPool({ connectionLimit: 2 }); await makeIncident(admin, 1, "investigating"); });
afterAll(async () => { await pool?.end(); await admin?.end(); });

describe("evidence audit", () => {
  it("linking, reviewing and unlinking are each recorded with the actor; an unlink records the review state it destroyed", async () => {
    await withActor(ANA, async (c) => {
      await c.query("INSERT INTO Incident_IOC (incident_id, ioc_id, notes) VALUES (1, 1, 'source'), (1, 2, 'maybe')");
      await c.query("INSERT INTO Incident_Asset (incident_id, asset_id) VALUES (1, 1)");
    }, pool);
    await withActor(ANA, (c) => reviewIncidentIoc(c, 1, 1, "confirmed"), pool);
    await withActor(ANA, (c) => c.query("DELETE FROM Incident_IOC WHERE incident_id = 1 AND ioc_id = 2"), pool);
    await withActor(ANA, (c) => c.query("DELETE FROM Incident_Asset WHERE incident_id = 1 AND asset_id = 1"), pool);
    expect(await events(1)).toEqual([
      { ioc_id: 1, asset_id: null, action: "linked", detail: null, changed_by: ANA },
      { ioc_id: 2, asset_id: null, action: "linked", detail: null, changed_by: ANA },
      { ioc_id: null, asset_id: 1, action: "linked", detail: null, changed_by: ANA },
      { ioc_id: 1, asset_id: null, action: "reviewed", detail: "pending -> confirmed", changed_by: ANA },
      { ioc_id: 2, asset_id: null, action: "unlinked", detail: "review state at unlink: pending", changed_by: ANA },
      { ioc_id: null, asset_id: 1, action: "unlinked", detail: null, changed_by: ANA },
    ]);
  });

  it("reviewing stamps reviewer and time; resetting to pending clears both; editing link notes is not a review", async () => {
    await withActor(ANA, (c) => c.query("UPDATE Incident_IOC SET notes = 'edited' WHERE incident_id = 1 AND ioc_id = 1"), pool);
    expect((await events(1)).filter((e) => e.action === "reviewed")).toHaveLength(1);
    await withActor(ANA, (c) => reviewIncidentIoc(c, 1, 1, "pending"), pool);
    expect(await one(admin, "SELECT review_status, reviewed_by, reviewed_at FROM Incident_IOC WHERE incident_id = 1 AND ioc_id = 1"))
      .toEqual({ review_status: "pending", reviewed_by: null, reviewed_at: null });
    await withActor(MAX, (c) => reviewIncidentIoc(c, 1, 1, "dismissed"), pool); // admins may review too
    expect((await one(admin, "SELECT reviewed_by FROM Incident_IOC WHERE incident_id = 1 AND ioc_id = 1")).reviewed_by).toBe(MAX);
  });

  it("only the assignee or an admin may review (SDB11); a link cannot be re-pointed (SDB16); a new link cannot arrive pre-reviewed (SDB17)", async () => {
    expect(sdbCode(await rejection(withActor(CY, (c) => reviewIncidentIoc(c, 1, 1, "confirmed"), pool)))).toBe("SDB11");
    // the app cannot even name ioc_id in an UPDATE (no column grant: 1143); the privileged account hits the trigger
    expect(errnoOf(await rejection(withActor(ANA, (c) => c.query("UPDATE Incident_IOC SET ioc_id = 3 WHERE incident_id = 1 AND ioc_id = 1"), pool)))).toBe(1143);
    expect(sdbCode(await rejection(as(admin, ANA, () => admin.query("UPDATE Incident_IOC SET ioc_id = 3 WHERE incident_id = 1 AND ioc_id = 1"))))).toBe("SDB16");
    expect(sdbCode(await rejection(as(admin, ANA, () => admin.query("INSERT INTO Incident_IOC (incident_id, ioc_id, review_status) VALUES (1, 3, 'confirmed')"))))).toBe("SDB17");
  });

  it("a dismissed IOC counts as reviewed for closure", async () => {
    await makeIncident(admin, 2, "investigating", { iocs: [1, 2] });
    await withActor(ANA, async (c) => { await reviewIncidentIoc(c, 2, 1, "confirmed"); await reviewIncidentIoc(c, 2, 2, "dismissed"); }, pool);
    await withActor(ANA, (c) => c.query("CALL transition_incident(2, 'resolved', NULL)"), pool);
    await withActor(MAX, (c) => closeIncident(c, 2), pool);
    expect((await one(admin, "SELECT status FROM Incidents WHERE incident_id = 2")).status).toBe("closed");
  });
});
