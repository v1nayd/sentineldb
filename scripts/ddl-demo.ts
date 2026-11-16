import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { loadEnv, env } from "../src/lib/env";
import { migratorConn } from "../src/lib/db";
import { withSchemaLock } from "../src/lib/migrate";

/**
 * Executes db/demo/ddl_demo.sql statement by statement as the migrator (DDL) account and prints each statement with
 * its result, so the run itself is the evidence. Statements marked "-- expect-error: N" must fail with errno N.
 *   npm run db:ddl-demo              against the dev schema (leaves it exactly as it found it)
 *   npm run db:ddl-demo -- --test    against the test schema
 */
export interface DemoStatement { step: string; sql: string; expectErrno: number | null }
export interface DemoResult { step: string; sql: string; ok: boolean; errno?: number; rows?: RowDataPacket[] }

export function parseDemo(text: string): DemoStatement[] {
  const out: DemoStatement[] = [];
  let step = "", buf: string[] = [], expect: number | null = null;
  for (const line of text.split("\n")) {
    const s = /^-- step: (.*)$/.exec(line);
    const e = /^-- expect-error: (\d+)$/.exec(line);
    if (s) { step = s[1]!.trim(); continue; }
    if (e) { expect = Number(e[1]); continue; }
    if (line.startsWith("--") || (!line.trim() && buf.length === 0)) continue;
    buf.push(line);
    if (line.trimEnd().endsWith(";")) {
      out.push({ step, sql: buf.join("\n").trim().replace(/;$/, ""), expectErrno: expect });
      buf = []; expect = null;
    }
  }
  return out;
}

export async function runDdlDemo(conn: Connection, database: string, log: (s: string) => void = () => {}): Promise<DemoResult[]> {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/demo/ddl_demo.sql");
  const statements = parseDemo(await readFile(file, "utf8"));
  const results: DemoResult[] = [];
  await withSchemaLock(conn, database, 30, async () => {
    let lastStep = "";
    for (const st of statements) {
      if (st.step !== lastStep) { log(`\n## ${st.step}`); lastStep = st.step; }
      log(`mysql> ${st.sql.replace(/\n/g, "\n    -> ")};`);
      try {
        const [res] = await conn.query(st.sql);
        if (st.expectErrno !== null) throw new Error(`expected error ${st.expectErrno} but the statement succeeded: ${st.sql}`);
        const rows = Array.isArray(res) ? (res as RowDataPacket[]) : undefined;
        if (rows) for (const r of rows) log("   " + Object.entries(r).map(([k, v]) => `${k}=${String(v).replace(/\n/g, "\n      ")}`).join("  "));
        else log(`   OK (${(res as { affectedRows?: number }).affectedRows ?? 0} rows affected)`);
        results.push({ step: st.step, sql: st.sql, ok: true, rows });
      } catch (e) {
        const errno = (e as { errno?: number }).errno;
        if (st.expectErrno === null || errno !== st.expectErrno) throw e;
        log(`   ERROR ${errno} (expected): ${(e as { sqlMessage?: string }).sqlMessage}`);
        results.push({ step: st.step, sql: st.sql, ok: false, errno });
      }
    }
  });
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await loadEnv();
  const database = process.argv.includes("--test") ? `${env().MYSQL_DATABASE}_test` : env().MYSQL_DATABASE;
  const conn = await migratorConn(database);
  try {
    console.log(`DDL demo on schema ${database} (MySQL ${(await conn.query<RowDataPacket[]>("SELECT VERSION() v"))[0][0]!.v})`);
    const r = await runDdlDemo(conn, database, console.log);
    console.log(`\n${r.length} statements executed, ${r.filter((x) => !x.ok).length} expected rejection(s).`);
  } finally {
    await conn.end();
  }
}
