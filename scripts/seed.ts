import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/lib/env";
import { migratorConn } from "../src/lib/db";
import { withSchemaLock } from "../src/lib/migrate";
import { assertEmptyForSeed, DatabaseNotEmptyError } from "../src/lib/seed-guard";
import { env } from "../src/lib/env";

// Usage: npm run db:seed -- spike      (runs db/seed/spike_seed.sql as the migrator account)
await loadEnv();
const name = process.argv[2] ?? "spike";
if (!/^[a-z0-9_]+$/.test(name)) throw new Error("seed name must be [a-z0-9_]+");
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../db/seed/${name}_seed.sql`);
const sql = await readFile(file, "utf8");
const conn = await migratorConn();
try {
  // Same lock as migrations/resets: a seed can neither race another seeder past the emptiness check nor run mid-reset.
  await withSchemaLock(conn, env().MYSQL_DATABASE, 30, async () => {
    // Seeds are a baseline for an EMPTY database (every application table). Refuse to merge into existing data.
    await assertEmptyForSeed(conn);
    await conn.query(sql);
    console.log(`seeded from ${path.basename(file)}`);
  });
} catch (e) {
  if (e instanceof DatabaseNotEmptyError) { console.error(e.message); process.exit(1); }
  throw e;
} finally {
  await conn.end();
}
