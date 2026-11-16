import type { Connection, Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidActorError, withActor } from "../src/lib/actor";
import { createAppPool } from "../src/lib/db";
import { ANA, CY, MAX, as, count, errnoOf, freshSchema, makeIncident, one, rejection, sdbCode } from "./fixtures";

/**
 * ADR-7: actor identity and the import clock travel in session variables, which outlive transactions on a pooled
 * connection. These are the four tests the ADR requires, run on a pool LIMITED TO ONE CONNECTION so every call is
 * guaranteed to reuse the same physical session.
 */
let admin: Connection;
let pool: Pool;
const sessionVars = async () => (await pool.query<RowDataPacket[]>("SELECT @sentinel_actor AS a, @sentinel_reason AS r, @sentinel_clock AS c, CONNECTION_ID() AS id"))[0][0]!;
const insertIncident = (c: { query: Pool["query"] }, title: string) => c.query("INSERT INTO Incidents (title, narrative, severity, reported_by) VALUES (?, 'n', 'low', 1)", [title]);

beforeAll(async () => { admin = await freshSchema(); pool = createAppPool({ connectionLimit: 1 }); });
afterAll(async () => { await pool?.end(); await admin?.end(); });

describe("ADR-7 required tests (one physical connection)", () => {
  it("(a)+(d) after a failed, rolled-back unit of work, the same connection carries no actor; the failed work is undone", async () => {
    const { id: conn } = await sessionVars();
    const before = await count(admin, "SELECT COUNT(*) FROM Incidents");
    const e = await rejection(withActor(MAX, async (c) => {
      await insertIncident(c, "will be rolled back");
      await c.query("SET @sentinel_reason = 'leaky'");
      throw new Error("boom");
    }, pool));
    expect((e as Error).message).toBe("boom");
    const v = await sessionVars();
    expect(v.id).toBe(conn); // really the same physical session
    expect([v.a, v.r, v.c]).toEqual([null, null, null]);
    expect(await count(admin, "SELECT COUNT(*) FROM Incidents")).toBe(before);
    // and a write on that connection without withActor is refused instead of inheriting MAX
    expect(sdbCode(await rejection(insertIncident(pool, "no actor")))).toBe("SDB01");
  });

  it("(a) also after a database-side rejection inside a procedure", async () => {
    await makeIncident(admin, 10);
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("CALL close_incident(10, 'x')"), pool)))).toBe("SDB11");
    const v = await sessionVars();
    expect([v.a, v.r]).toEqual([null, null]);
  });

  it("(b) alternating actors on one connection attribute every audit row correctly", async () => {
    const ids: Array<[number, number]> = [];
    for (const actor of [ANA, MAX, CY, ANA, MAX, CY]) {
      const id = await withActor(actor, async (c) => (await insertIncident(c, `by ${actor}`))[0] as unknown as { insertId: number }, pool);
      ids.push([id.insertId, actor]);
    }
    for (const [id, actor] of ids) {
      expect((await one(admin, "SELECT changed_by FROM Incident_Status_History WHERE incident_id = ?", [id])).changed_by, `incident ${id}`).toBe(actor);
    }
    const [conns] = await admin.query<RowDataPacket[]>("SELECT COUNT(DISTINCT db_account) n FROM Incident_Status_History WHERE incident_id IN (?)", [ids.map(([i]) => i)]);
    expect(conns[0]!.n).toBe(1);
  });

  it("(c) the runtime account cannot back-date: @sentinel_clock is ignored unless the session is the import account", async () => {
    const id = await withActor(ANA, async (c) => {
      await c.query("SET @sentinel_clock = '2001-01-01 00:00:00'");
      return ((await insertIncident(c, "attempted back-date"))[0] as unknown as { insertId: number }).insertId;
    }, pool);
    const { created_at } = await one(admin, "SELECT created_at FROM Incidents WHERE incident_id = ?", [id]);
    expect(Math.abs((created_at as Date).getTime() - Date.now())).toBeLessThan(5 * 60_000);
    // positive control: the import account's clock IS honoured
    await admin.query("SET @sentinel_clock = '2001-01-01 00:00:00'");
    try {
      await as(admin, ANA, () => insertIncident(admin as unknown as Pool, "imported"));
      expect((await one(admin, "SELECT created_at FROM Incidents WHERE title = 'imported'")).created_at).toEqual(new Date("2001-01-01T00:00:00Z"));
    } finally { await admin.query("SET @sentinel_clock = NULL"); }
  });
});

describe("actor validation", () => {
  it("rejects non-integer or non-positive ids before touching the database", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(withActor(bad, async () => 1, pool)).rejects.toBeInstanceOf(InvalidActorError);
  });
  it("an actor id that is not a user is rejected by the database (SDB02); so is a non-numeric session value", async () => {
    expect(sdbCode(await rejection(withActor(999, (c) => insertIncident(c, "ghost"), pool)))).toBe("SDB02");
    expect(sdbCode(await rejection(as(admin, "1 OR 1=1" as unknown as number, () => insertIncident(admin as unknown as Pool, "x"))))).toBe("SDB02");
  });
  it("a note's author must be the acting user (SDB21): nobody can post as someone else", async () => {
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("INSERT INTO Notes (incident_id, author_id, content) VALUES (10, 2, 'as Max')"), pool)))).toBe("SDB21");
  });
  it("review attribution cannot be forged: reviewed_by is not writable (app) and is maintained by the trigger (migrator)", async () => {
    await makeIncident(admin, 500, "investigating", { iocs: [1] }); // explicit id well above the auto-increment ids used above
    expect(errnoOf(await rejection(withActor(ANA, (c) => c.query("UPDATE Incident_IOC SET reviewed_by = 2 WHERE incident_id = 500"), pool)))).toBe(1143);
    expect(sdbCode(await rejection(as(admin, ANA, () => admin.query("UPDATE Incident_IOC SET review_status = 'confirmed', reviewed_by = 2 WHERE incident_id = 500"))))).toBe("SDB17");
    await withActor(ANA, (c) => c.query("UPDATE Incident_IOC SET review_status = 'confirmed' WHERE incident_id = 500"), pool);
    expect((await one(admin, "SELECT reviewed_by FROM Incident_IOC WHERE incident_id = 500")).reviewed_by).toBe(ANA);
  });
});
