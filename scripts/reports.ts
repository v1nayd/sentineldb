import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { loadEnv } from "../src/lib/env";
import { appPool, closeAppPool } from "../src/lib/db";
import { loadNamedQueries } from "../src/lib/reports";

/**
 * Runs db/reports/<set>.sql as the least-privilege RUNTIME account and prints every result.
 *   npm run db:reports -- analytics     analytic reports
 *   npm run db:reports -- integrity     audit-trail checks; exits 1 if any check returns a row
 */
await loadEnv();
const set = process.argv[2] ?? "analytics";
if (!/^[a-z]+$/.test(set)) throw new Error("report set must be [a-z]+");
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../db/reports/${set}.sql`);
const pool = appPool();
let violations = 0;
try {
  for (const q of await loadNamedQueries(file)) {
    const t0 = performance.now();
    const [rows] = await pool.query<RowDataPacket[]>(q.sql);
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`\n== ${q.name}  (${rows.length} row${rows.length === 1 ? "" : "s"}, ${ms} ms)`);
    for (const n of q.notes) console.log(`   ${n}`);
    if (set === "integrity") {
      if (rows.length > 0) { violations++; console.table(rows.slice(0, 20)); } else console.log("   OK: no violations");
    } else if (rows.length > 0) {
      console.table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 16).replace("T", " ") : v]))));
    }
  }
} finally {
  await closeAppPool();
}
if (set === "integrity") {
  console.log(`\nintegrity: ${violations === 0 ? "PASS (all checks returned zero rows)" : `FAIL (${violations} check(s) found violations)`}`);
  if (violations) process.exit(1);
}
