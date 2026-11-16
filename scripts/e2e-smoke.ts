import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { hashPassword } from "../src/lib/auth/password";
import { migratorConn } from "../src/lib/db";
import { env, loadEnv } from "../src/lib/env";
import { resetAndMigrate } from "../src/lib/migrate";

/**
 * End-to-end smoke test through a REAL `next start` server (the vitest suites call the route handlers directly; this
 * proves the built app serves them the same way: routing, cookies over HTTP, headers).
 * Uses the TEST schema and the test runtime account, never dev data:
 *   rebuild <db>_test -> load the spike seed -> give two accounts a random password -> start the production build on a
 *   spare port -> run the checks -> stop the server. Needs `npm run build` first. Exits non-zero on any failure.
 */
await loadEnv();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = `${env().MYSQL_DATABASE.replace(/_test$/, "")}_test`;
const PORT = 3123;
const ORIGIN = `http://localhost:${PORT}`;

const conn = await migratorConn(db);
await resetAndMigrate(conn, db, path.join(root, "db/migrations"));
await conn.query(await readFile(path.join(root, "db/seed/spike_seed.sql"), "utf8"));
const pw = { admin: `adm-${Date.now()}-smoke-pass`, analyst: `ana-${Date.now()}-smoke-pass` };
await conn.query("SET @sentinel_actor = NULL");
await conn.query("UPDATE Users SET password_hash = ? WHERE email = 'bob@sentinel.example'", [await hashPassword(pw.admin)]);
await conn.query("UPDATE Users SET password_hash = ? WHERE email = 'alice@sentinel.example'", [await hashPassword(pw.analyst)]);
await conn.end();

const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "production", MYSQL_DATABASE: db, MYSQL_APP_USER: env().MYSQL_APP_TEST_USER, MYSQL_APP_PASSWORD: env().MYSQL_APP_TEST_PASSWORD, APP_ORIGIN: ORIGIN },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));

let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };
const req = (p: string, init: RequestInit & { cookie?: string } = {}) => fetch(`${ORIGIN}${p}`, {
  ...init, redirect: "manual",
  headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.method && init.method !== "GET" ? { origin: ORIGIN } : {}), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string>) },
});
const loginAs = async (email: string, password: string) => {
  const r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  const set = r.headers.get("set-cookie") ?? "";
  return { status: r.status, set, cookie: set.split(";")[0] ?? "" };
};

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${ORIGIN}/api/health`)).status < 600; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  if (!up) throw new Error(`server did not start:\n${log}`);
  console.log(`next start on ${ORIGIN} against schema ${db}`);

  check((await req("/api/incidents")).status === 401, "anonymous GET /api/incidents -> 401");
  const bad = await loginAs("alice@sentinel.example", "wrong-password-123");
  check(bad.status === 401, "wrong password -> 401");
  const alice = await loginAs("alice@sentinel.example", pw.analyst);
  check(alice.status === 200 && /HttpOnly/i.test(alice.set) && /SameSite=Lax/i.test(alice.set) && /Secure/i.test(alice.set) && alice.cookie.startsWith("__Host-sdb_session="),
    "login sets a __Host-, Secure, HttpOnly, SameSite=Lax cookie (production mode)");
  const list = await req("/api/incidents", { cookie: alice.cookie });
  const visible = ((await list.json()) as { incidents: Array<{ reported_by: number; assigned_to: number | null }> }).incidents;
  check(list.status === 200 && visible.length > 0 && visible.every((i) => i.reported_by === 1 || i.assigned_to === 1), `analyst list shows only own incidents (${visible.length})`);
  check(list.headers.get("cache-control") === "no-store", "API responses are no-store");
  const hidden = await req("/api/incidents/3", { cookie: alice.cookie }); // reported and assigned by Carol
  check(hidden.status === 404, "another analyst's incident -> 404");
  const created = await req("/api/incidents", { method: "POST", cookie: alice.cookie, body: JSON.stringify({ title: "Smoke test", narrative: "Created through next start.", severity: "low" }) });
  const createdId = ((await created.json()) as { incident_id: number }).incident_id;
  check(created.status === 201, `POST /api/incidents -> 201 (#${createdId})`);
  const csrf = await req("/api/incidents", { method: "POST", cookie: alice.cookie, headers: { origin: "https://evil.example" }, body: JSON.stringify({ title: "x", narrative: "x", severity: "low" }) });
  check(csrf.status === 403, "cross-origin POST -> 403");
  check((await req("/api/users", { cookie: alice.cookie })).status === 403, "analyst GET /api/users -> 403");
  const bob = await loginAs("bob@sentinel.example", pw.admin);
  const users = await req("/api/users", { cookie: bob.cookie });
  const usersText = await users.text();
  check(users.status === 200 && !/password_hash|\$scrypt\$/.test(usersText), "admin GET /api/users -> 200, no password hashes");
  const reassigned = await req(`/api/incidents/${createdId}/reassign`, { method: "POST", cookie: bob.cookie, body: JSON.stringify({ assignee: 1, reason: "smoke triage" }) });
  check(reassigned.status === 200, "admin reassigns through the procedure -> 200");
  // Milestone 5: the server-rendered UI enforces the same session and visibility rules as the API.
  const page = async (p: string, cookie?: string) => { const r = await req(p, cookie ? { cookie } : {}); return { status: r.status, location: r.headers.get("location") ?? "", html: r.status === 200 ? await r.text() : "" }; };
  const anonList = await page("/incidents");
  check(anonList.status >= 300 && anonList.status < 400 && anonList.location.includes("/login"), `UI: signed-out /incidents redirects to /login (${anonList.status})`);
  check((await page("/login")).html.includes("Sign in"), "UI: /login renders the sign-in form");
  const carols = await (await req("/api/incidents/3", { cookie: bob.cookie })).json() as { incident: { title: string } }; // Carol's incident
  const aliceList = await page("/incidents", alice.cookie);
  check(aliceList.status === 200 && aliceList.html.includes((visible[0] as unknown as { title: string }).title) && !aliceList.html.includes(carols.incident.title),
    "UI: analyst's incident list shows her incidents and not another analyst's");
  check((await page("/incidents/3", alice.cookie)).status === 404, "UI: another analyst's incident page -> 404");
  const own = await page(`/incidents/${createdId}`, alice.cookie);
  check(own.status === 200 && own.html.includes("Smoke test") && own.html.includes("Audit timeline"), "UI: own incident page renders with its audit timeline");
  check((await page("/analytics", alice.cookie)).status === 404, "UI: admin page /analytics -> 404 for an analyst");
  const dash = await page("/analytics", bob.cookie);
  check(dash.status === 200 && dash.html.includes("Severity × status"), "UI: admin sees the analytics dashboard");
  check((await page("/admin/sync", bob.cookie)).html.includes("Reconciliation"), "UI: admin sees the index sync page");

  const out = await req("/api/auth/logout", { method: "POST", cookie: alice.cookie });
  check(out.status === 200 && (await req("/api/auth/me", { cookie: alice.cookie })).status === 401, "logout revokes the session server-side");

  const v = await migratorConn(db);
  const [[h]] = await v.query<RowDataPacket[][]>("SELECT COUNT(*) AS n FROM Incident_Status_History WHERE incident_id = ? AND db_account LIKE ?", [createdId, `${env().MYSQL_APP_TEST_USER}@%`]) as unknown as [[RowDataPacket]];
  check(Number(h.n) === 1, "the new incident's origin row was written by the trigger, as the runtime account");
  await v.end();
} catch (e) {
  console.error(e); failures++;
} finally {
  server.kill();
}
console.log(failures === 0 ? "\nE2E SMOKE OK" : `\nE2E SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
