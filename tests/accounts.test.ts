import type { Connection, Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "../src/lib/actor";
import { hashPassword } from "../src/lib/auth/password";
import { createAppPool } from "../src/lib/db";
import { ANA, CY, DEE, MAX, appConn, as, count, errnoOf, freshSchema, makeIncident, one, rejection, sdbCode } from "./fixtures";

/** Account rules in the database (migrations 0012-0014), exercised as the runtime test account. */
let db: Connection;
let pool: Pool;
let hash: string;

beforeAll(async () => { db = await freshSchema(); pool = createAppPool({ connectionLimit: 3 }); hash = await hashPassword("long enough password"); });
afterAll(async () => { await pool?.end(); await db?.end(); });

describe("the runtime account and the Users table", () => {
  it("cannot read password_hash or write Users directly; reads the hash only through auth_lookup(email)", async () => {
    const app = await appConn();
    try {
      expect(errnoOf(await rejection(app.query("SELECT password_hash FROM Users")))).toBe(1143);
      expect(errnoOf(await rejection(app.query("SELECT * FROM Users")))).toBe(1142);
      expect(errnoOf(await rejection(app.query("SELECT u.name FROM Users u WHERE u.password_hash LIKE '$%'")))).toBe(1143); // not even in a WHERE
      expect(errnoOf(await rejection(app.query("INSERT INTO Users (name, email, password_hash) VALUES ('x','x@x.example','h')")))).toBe(1142);
      expect(errnoOf(await rejection(app.query("UPDATE Users SET role = 'admin' WHERE user_id = 1")))).toBe(1142);
      const [res] = await app.query<RowDataPacket[][]>("CALL auth_lookup('ana@test.example')");
      expect(res[0]).toHaveLength(1);
      expect(Object.keys(res[0]![0]!).sort()).toEqual(["email", "is_active", "name", "password_hash", "role", "user_id"]);
      const [none] = await app.query<RowDataPacket[][]>("CALL auth_lookup('%')"); // exact match only: no wildcard dumping
      expect(none[0]).toHaveLength(0);
    } finally { await app.end(); }
  });
});

describe("account procedures", () => {
  it("create_user: admins only, and never with something that is not a password hash", async () => {
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("CALL create_user('x', 'x1@test.example', ?, 'admin')", [hash]), pool)))).toBe("SDB11");
    expect(sdbCode(await rejection(withActor(MAX, (c) => c.query("CALL create_user('x', 'x1@test.example', 'my plaintext password', 'analyst')"), pool)))).toBe("SDB43");
    const [res] = await withActor(MAX, (c) => c.query<RowDataPacket[][]>("CALL create_user('New', 'new@test.example', ?, 'analyst')", [hash]), pool);
    const id = Number(res[0]![0]!.user_id);
    expect(await one(db, "SELECT role, is_active, created_at IS NOT NULL AS has_created FROM Users WHERE user_id = ?", [id])).toEqual({ role: "analyst", is_active: 1, has_created: 1 });
    expect(await one(db, "SELECT action, changed_by, source FROM User_Account_History WHERE user_id = ?", [id])).toEqual({ action: "created", changed_by: MAX, source: "runtime" });
  });

  it("users change only their own password and name; role, status and e-mail need an admin", async () => {
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("CALL set_password_hash(?, ?)", [CY, hash]), pool)))).toBe("SDB11");
    await withActor(ANA, (c) => c.query("CALL set_password_hash(?, ?)", [ANA, hash]), pool);
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("CALL set_user_role(?, 'admin')", [ANA]), pool)))).toBe("SDB11");
    expect(sdbCode(await rejection(withActor(ANA, (c) => c.query("CALL set_user_active(?, FALSE)", [CY]), pool)))).toBe("SDB11");
    // the same rules hold on the privileged path (trigger)
    expect(sdbCode(await rejection(as(db, ANA, () => db.query("UPDATE Users SET name = 'x' WHERE user_id = ?", [CY]))))).toBe("SDB11");
    expect(sdbCode(await rejection(as(db, ANA, () => db.query("UPDATE Users SET email = 'a2@test.example' WHERE user_id = ?", [ANA]))))).toBe("SDB11");
    await as(db, ANA, () => db.query("UPDATE Users SET name = 'Ana A.' WHERE user_id = ?", [ANA]));
  });

  it("deactivated users cannot act, cannot be assigned work, and keep their audit trail; users are never deleted", async () => {
    await makeIncident(db, 1, "investigating", { assignee: CY });
    await withActor(MAX, (c) => c.query("CALL set_user_active(?, FALSE)", [CY]), pool);
    expect(sdbCode(await rejection(withActor(CY, (c) => c.query("CALL transition_incident(1, 'contained', NULL)"), pool)))).toBe("SDB02");
    expect(sdbCode(await rejection(withActor(MAX, (c) => c.query("CALL reassign_incident(1, ?, 'x')", [ANA]).then(() => c.query("CALL reassign_incident(1, ?, 'back')", [CY])), pool)))).toBe("SDB42");
    expect(await count(db, "SELECT COUNT(*) FROM Incident_Status_History WHERE changed_by = ?", [CY])).toBeGreaterThan(0);
    expect(await one(db, "SELECT is_active, deactivated_by FROM Users WHERE user_id = ?", [CY])).toEqual({ is_active: 0, deactivated_by: MAX });
    expect(sdbCode(await rejection(db.query("DELETE FROM Users WHERE user_id = ?", [CY])))).toBe("SDB41");
    expect(sdbCode(await rejection(db.query("DELETE FROM User_Account_History")))).toBe("SDB20");
    await withActor(MAX, (c) => c.query("CALL set_user_active(?, TRUE)", [CY]), pool);
    expect(await one(db, "SELECT is_active, deactivated_at FROM Users WHERE user_id = ?", [CY])).toEqual({ is_active: 1, deactivated_at: null });
  });

  it("the last active admin: concurrent self-deactivations by the only two admins cannot both succeed", async () => {
    const a = await appConn();
    const b = await appConn();
    try {
      await a.query("SET @sentinel_actor = ?", [MAX]);
      await b.query("SET @sentinel_actor = ?", [DEE]);
      await a.beginTransaction();
      await a.query("CALL set_user_active(?, FALSE)", [MAX]); // holds the admin rows
      let settled = false;
      const second = b.query("CALL set_user_active(?, FALSE)", [DEE]).then(() => { settled = true; return null; }, (e) => { settled = true; return e; });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      await a.commit();
      expect(sdbCode(await second)).toBe("SDB40");
    } finally { await a.end(); await b.end(); }
    expect(await count(db, "SELECT COUNT(*) FROM Users WHERE role = 'admin' AND is_active")).toBe(1);
    await db.query("SET @sentinel_actor = NULL");
    await db.query("UPDATE Users SET is_active = TRUE WHERE user_id = ?", [MAX]); // restore via the import (bootstrap) path
  });
});
