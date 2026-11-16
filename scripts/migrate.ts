import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, env } from "../src/lib/env";
import { migratorConn } from "../src/lib/db";
import { migrate, resetAndMigrate } from "../src/lib/migrate";

await loadEnv();
const reset = process.argv.includes("--reset");
const database = env().MYSQL_DATABASE;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");

if (reset) {
  // Guard: only the dev and test schemas may be dropped, and never in production.
  if (env().NODE_ENV === "production" || !/^sentineldb(_test)?$/.test(database)) {
    console.error(`Refusing to reset database "${database}" (NODE_ENV=${env().NODE_ENV}).`);
    process.exit(1);
  }
}

const conn = await migratorConn();
try {
  if (reset) console.log(`reset: dropping and recreating ${database} (under the schema lock)`);
  const r = reset ? await resetAndMigrate(conn, database, dir) : await migrate(conn, dir);
  console.log(`applied: ${r.applied.length ? r.applied.join(", ") : "(none)"}`);
  console.log(`already applied: ${r.alreadyApplied.length}`);
} finally {
  await conn.end();
}
