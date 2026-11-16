// Optional real-browser check of the UI (Milestone 5): headless Edge/Chrome driven over the DevTools protocol with
// Node's built-in WebSocket (no packages). Signs in through the login FORM, opens an incident, waits for the similar-
// incidents panel, adds a note through the UI (a real browser POST, so the CSRF origin check is exercised) and signs out.
//   npm run build && npm start                     (or npm run dev), demo seed loaded, passwords from npm run dev:logins
//   node scripts/ui-browser-check.mjs <email> <password> <incident id visible to that user>
// Env: BASE (default http://localhost:3000; must equal APP_ORIGIN), BROWSER (path to msedge.exe / chrome.exe).
// Not part of verify-all.sh: it needs a desktop browser. Leaves one note on the incident (notes are append-only).
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const [email, password, incidentId] = process.argv.slice(2);
const BASE = process.env.BASE ?? "http://localhost:3000";
const proc = spawn(process.env.BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ["--headless=new", "--disable-gpu", "--remote-debugging-port=9334", `--user-data-dir=${path.join(os.tmpdir(), `sdb-flow-${Date.now()}`)}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) { try { target = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((t) => t.type === "page"); } catch { await sleep(250); } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const waiting = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await js(expr)) return true; await sleep(250); } return false; };
// React-controlled inputs need the native setter + an input event.
const fill = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };

await cdp("Page.navigate", { url: `${BASE}/incidents` });
check(await waitFor(`location.pathname === "/login" && !!document.querySelector('input[name=email]')`), "signed out: /incidents sends the browser to the login form");
await fill("input[name=email]", "wrong@sentinel.example"); await fill("input[name=password]", "not-the-password");
await js(`document.querySelector('form button[type=submit]').click()`);
check(await waitFor(`document.body.innerText.includes("Invalid e-mail or password")`), "wrong password shows a generic error in the form");
await fill("input[name=email]", email); await fill("input[name=password]", password);
await js(`document.querySelector('form button[type=submit]').click()`);
check(await waitFor(`location.pathname === "/incidents" && document.querySelector("h1")?.innerText === "Incidents"`), "sign-in through the form lands on the incident list");

const note = `UI flow note ${Date.now()}`;
await cdp("Page.navigate", { url: `${BASE}/incidents/${incidentId}` });
check(await waitFor(`!!document.querySelector('textarea[aria-label=Note]')`), `incident #${incidentId} page loads with the note form`);
check(await waitFor(`[...document.querySelectorAll(".result")].length > 0 || document.body.innerText.includes("No similar incidents")`, 20000), "similar-incidents panel loads results in the browser");
await fill("textarea[aria-label=Note]", note);
await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Add note").click()`);
check(await waitFor(`document.body.innerText.includes(${JSON.stringify(note)})`), "adding a note through the UI (POST from the browser, CSRF origin check) shows it in the audit timeline");

await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Sign out").click()`);
check(await waitFor(`location.pathname === "/login"`), "sign out returns to the login page");
ws.close(); proc.kill();
console.log(failures === 0 ? "UI FLOW OK" : `UI FLOW FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
