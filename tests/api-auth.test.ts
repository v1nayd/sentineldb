import type { Connection, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as loginRoute from "../src/app/api/auth/login/route";
import * as logoutRoute from "../src/app/api/auth/logout/route";
import * as meRoute from "../src/app/api/auth/me/route";
import * as passwordRoute from "../src/app/api/auth/password/route";
import * as usersRoute from "../src/app/api/users/[id]/route";
import { LOGIN_LIMITS } from "../src/lib/auth/login";
import { hashPassword, hashPasswordWith, SCRYPT, verifyPassword } from "../src/lib/auth/password";
import { hashToken } from "../src/lib/auth/session";
import { closeAppPool } from "../src/lib/db";
import { resetRequestBudgets } from "../src/lib/http";
import { count, freshSchema, one } from "./fixtures";
import { PASSWORD, call, cookieFrom, login, setPasswords } from "./http";

/** Authentication and sessions, through the real route handlers and the real database. */
let admin: Connection;
const me = (cookie: string | null) => call(meRoute.GET, "GET", { path: "/api/auth/me", cookie });
const attempt = (email: string, password: string) => call(loginRoute.POST, "POST", { path: "/api/auth/login", body: { email, password } });

beforeAll(async () => { admin = await freshSchema(); await setPasswords(admin); });
afterAll(async () => { await closeAppPool(); await admin?.end(); });
beforeEach(() => resetRequestBudgets());

describe("passwords", () => {
  it("are stored as salted scrypt (OWASP parameters); verification is exact; malformed hashes never verify", async () => {
    const h1 = await hashPassword("a long enough password");
    const h2 = await hashPassword("a long enough password");
    expect(h1).toMatch(/^\$scrypt\$ln=17,r=8,p=1\$/);
    expect(h1).not.toBe(h2); // salted
    expect((await verifyPassword(h1, "a long enough password")).ok).toBe(true);
    expect((await verifyPassword(h1, "a long enough passworD")).ok).toBe(false);
    for (const bad of [null, "", "!SEED-NO-LOGIN!", "h", "$scrypt$ln=30,r=8,p=1$AAAA$AAAA"]) expect((await verifyPassword(bad, "x")).ok).toBe(false);
    expect(SCRYPT.ln).toBeGreaterThanOrEqual(17);
  });
  it("a hash made with weaker parameters still verifies, is flagged, and is upgraded transparently at the next login", async () => {
    const weak = await hashPasswordWith(PASSWORD, { ...SCRYPT, ln: 15 });
    expect(await verifyPassword(weak, PASSWORD)).toEqual({ ok: true, needsRehash: true });
    await admin.query("UPDATE Users SET password_hash = ? WHERE user_id = 4", [weak]);
    expect((await attempt("dee@test.example", PASSWORD)).status).toBe(200);
    const [rows] = await admin.query<RowDataPacket[]>("CALL auth_lookup('dee@test.example')");
    expect(String((rows as unknown as RowDataPacket[][])[0]![0]!.password_hash)).toMatch(/^\$scrypt\$ln=17,/);
    expect((await attempt("dee@test.example", PASSWORD)).status).toBe(200); // the session opened after the upgrade, and the new hash works
  });
});

describe("login", () => {
  it("sets an HttpOnly, SameSite=Lax session cookie; the database stores only the token's SHA-256", async () => {
    const r = await attempt("ana@test.example", PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body.user).toEqual({ id: 1, name: "Ana Analyst", email: "ana@test.example", role: "analyst" });
    const set = r.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    const token = cookieFrom(r).split("=")[1]!;
    expect(await count(admin, "SELECT COUNT(*) FROM Sessions WHERE token_hash = ?", [token])).toBe(0);
    expect(await count(admin, "SELECT COUNT(*) FROM Sessions WHERE token_hash = ?", [hashToken(token)])).toBe(1);
    expect((await me(cookieFrom(r))).body.user.email).toBe("ana@test.example");
  });

  it("e-mail is case-insensitive; every failure gives the same 401 (wrong password, unknown e-mail, no usable hash)", async () => {
    expect((await attempt("  ANA@Test.Example ", PASSWORD)).status).toBe(200);
    await admin.query("UPDATE Users SET password_hash = '!SEED-NO-LOGIN!' WHERE user_id = 3");
    const answers = [await attempt("ana@test.example", "wrong password!!"), await attempt("nobody@test.example", PASSWORD), await attempt("cy@test.example", PASSWORD)];
    for (const a of answers) expect([a.status, a.body]).toEqual([401, { error: { code: "invalid_credentials", message: "invalid e-mail or password" } }]);
    await setPasswords(admin);
  });

  it("strict body: unknown fields and non-JSON are rejected", async () => {
    expect((await call(loginRoute.POST, "POST", { body: { email: "ana@test.example", password: PASSWORD, role: "admin" } })).status).toBe(400);
    expect((await call(loginRoute.POST, "POST", { rawBody: "email=ana", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
  });

  it("login CSRF: a login posted from another origin is refused", async () => {
    expect((await call(loginRoute.POST, "POST", { body: { email: "ana@test.example", password: PASSWORD }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(loginRoute.POST, "POST", { body: { email: "ana@test.example", password: PASSWORD }, origin: null })).status).toBe(403);
    expect((await call(loginRoute.POST, "POST", { body: { email: "ana@test.example", password: PASSWORD }, origin: null, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  it(`after ${LOGIN_LIMITS.perEmail} failures an account is locked for the window, even with the right password; other accounts are unaffected`, async () => {
    for (let k = 0; k < LOGIN_LIMITS.perEmail; k++) expect((await attempt("dee@test.example", `wrong guess ${k}!!`)).status).toBe(401);
    const blocked = await attempt("dee@test.example", PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
    expect((await attempt("max@test.example", PASSWORD)).status).toBe(200);
    expect(await count(admin, "SELECT COUNT(*) FROM Auth_Events WHERE email_attempted = 'dee@test.example' AND event_type = 'login_blocked'")).toBe(1);
    // the lock is counted from the append-only log, so not even the privileged account can quietly clear it
    await expect(admin.query("DELETE FROM Auth_Events WHERE email_attempted = 'dee@test.example'")).rejects.toMatchObject({ sqlMessage: expect.stringMatching(/^SDB20/) });
  });

  it("deactivated users cannot log in, and deactivation ends their existing sessions at once", async () => {
    const cookie = await login("cy@test.example");
    expect((await me(cookie)).status).toBe(200);
    const adminCookie = await login("max@test.example");
    expect((await call(usersRoute.PATCH, "PATCH", { cookie: adminCookie, params: { id: "3" }, body: { active: false } })).status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    expect((await attempt("cy@test.example", PASSWORD)).status).toBe(401);
    await call(usersRoute.PATCH, "PATCH", { cookie: adminCookie, params: { id: "3" }, body: { active: true } });
    expect((await attempt("cy@test.example", PASSWORD)).status).toBe(200);
  });
});

describe("sessions", () => {
  it("logout revokes the session server-side: the same cookie no longer works", async () => {
    const cookie = await login("ana@test.example");
    const out = await call(logoutRoute.POST, "POST", { cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await me(cookie)).status).toBe(401);
  });

  it("expired (absolute 8 h) and idle (30 min) sessions are rejected; garbage cookies are ignored", async () => {
    const a = await login("ana@test.example");
    const b = await login("ana@test.example");
    const hashOf = (c: string) => hashToken(c.split("=")[1]!);
    // time travel for the test, done by the privileged account (the runtime account cannot touch expires_at)
    await admin.query("UPDATE Sessions SET expires_at = created_at + INTERVAL 1 SECOND WHERE token_hash = ?", [hashOf(a)]);
    await admin.query("UPDATE Sessions SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 31 MINUTE WHERE token_hash = ?", [hashOf(b)]);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(401);
    for (const junk of ["sdb_session=", "sdb_session=../../etc", "sdb_session=" + "A".repeat(43), "other=1"]) expect((await me(junk)).status).toBe(401);
  });

  it("the database refuses sessions for deactivated users and never lets a revoked session come back", async () => {
    const c = await login("ana@test.example");
    const h = hashToken(c.split("=")[1]!);
    await call(logoutRoute.POST, "POST", { cookie: c });
    await expect(admin.query("UPDATE Sessions SET revoked_at = NULL WHERE token_hash = ?", [h])).rejects.toMatchObject({ sqlMessage: expect.stringMatching(/^SDB17/) });
  });

  it("changing your password needs the current one, ends ALL your sessions, and returns a fresh session", async () => {
    const other = await login("ana@test.example");
    const cookie = await login("ana@test.example");
    const wrong = await call(passwordRoute.POST, "POST", { cookie, body: { current_password: "not it at all", new_password: "a brand new passphrase" } });
    expect(wrong.status).toBe(403);
    const short = await call(passwordRoute.POST, "POST", { cookie, body: { current_password: PASSWORD, new_password: "short" } });
    expect(short.status).toBe(400);
    const ok = await call(passwordRoute.POST, "POST", { cookie, body: { current_password: PASSWORD, new_password: "a brand new passphrase" } });
    expect(ok.status).toBe(200);
    expect((await me(other)).status).toBe(401);
    expect((await me(cookie)).status).toBe(401);
    expect((await me(cookieFrom(ok))).status).toBe(200);
    expect((await attempt("ana@test.example", "a brand new passphrase")).status).toBe(200);
    const hist = await one(admin, "SELECT action, changed_by FROM User_Account_History WHERE user_id = 1 ORDER BY account_event_id DESC LIMIT 1");
    expect(hist).toEqual({ action: "password_changed", changed_by: 1 });
  });
});
