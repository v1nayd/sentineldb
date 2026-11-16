import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { loadEnv, env } from "../src/lib/env";
import { migratorConn } from "../src/lib/db";
import { resetAndMigrate } from "../src/lib/migrate";

/**
 * EXPLAIN-driven index review (roadmap M2; evidence for migration 0011 and docs/INDEXING.md).
 *
 * At 240 incidents every plan is "read the whole table in microseconds", which proves nothing. So this script builds
 * a SCALED copy of the schema in the scratch schema <db>_p1check (also used by the Phase 1 equivalence test; the
 * migrator owns it; dev data is never touched):
 *   - all migrations applied, then the triggers dropped IN THE SCRATCH COPY ONLY so bulk rows can be generated with
 *     INSERT ... SELECT (index choice depends on data distribution, not on triggers);
 *   - 50,000 incidents, ~130,000 status-history rows, 100,000 IOC links, 20,000 IOCs, coherent with every CHECK.
 * For each workload query it compares access paths with index hints (the Phase 1 index vs the Milestone 2 index, or
 * with vs without an index), using EXPLAIN ANALYZE (actual time, MySQL 8.0.18+) and the InnoDB handler counters
 * (rows actually read). Each variant runs 5 times; the median is reported.
 *   npm run db:explain           writes docs/evidence/explain.txt
 */
const N_INCIDENTS = 50_000;
const N_USERS = 50;
const N_IOCS = 20_000;

interface Variant { label: string; hint: string }
interface Case { id: string; query: string; why: string; sql: string; params: unknown[]; variants: Variant[] }

const CASES: Case[] = [
  {
    id: "analyst_queue", query: "an analyst's active queue, newest first",
    why: "0011 replaces idx_incidents_assigned_to(assigned_to) with idx_incidents_assignee_status(assigned_to, status)",
    sql: "SELECT incident_id, title, severity, status, updated_at FROM Incidents i {HINT} WHERE i.assigned_to = ? AND i.status IN ('open','investigating','contained') ORDER BY i.updated_at DESC LIMIT 20",
    params: [17],
    variants: [
      { label: "Phase 1 idx_incidents_assigned_to (assigned_to)", hint: "FORCE INDEX (idx_incidents_assigned_to)" },
      { label: "M2 idx_incidents_assignee_status (assigned_to, status)", hint: "FORCE INDEX (idx_incidents_assignee_status)" },
      { label: "optimizer's own choice (M2 schema)", hint: "IGNORE INDEX (idx_incidents_assigned_to)" },
    ],
  },
  {
    id: "incident_timeline", query: "one incident's status timeline in order",
    why: "CANDIDATE (incident_id, changed_at) vs the existing FK index (incident_id); rejected if it does not help",
    sql: "SELECT history_id, old_status, new_status, changed_by, changed_at FROM Incident_Status_History h {HINT} WHERE h.incident_id = ? ORDER BY h.changed_at",
    params: [31_337],
    variants: [
      { label: "FK-style index (incident_id) + sort, as in the real schema", hint: "FORCE INDEX (idx_ish_incident_only)" },
      { label: "candidate (incident_id, changed_at), created in the scratch copy only", hint: "FORCE INDEX (idx_candidate_ish_incident_time)" },
    ],
  },
  {
    id: "month_range", query: "incidents created in one month, grouped by severity (trend dashboards)",
    why: "0011 adds idx_incidents_created_at(created_at)",
    sql: "SELECT severity, COUNT(*) AS n FROM Incidents i {HINT} WHERE i.created_at >= ? AND i.created_at < ? GROUP BY severity",
    params: ["2025-03-01 00:00:00", "2025-04-01 00:00:00"],
    variants: [
      { label: "no index on created_at (full scan)", hint: "IGNORE INDEX (idx_incidents_created_at)" },
      { label: "M2 idx_incidents_created_at", hint: "FORCE INDEX (idx_incidents_created_at)" },
    ],
  },
  {
    id: "manager_queue", query: "open/investigating high+critical incidents, oldest first (manager dashboard)",
    why: "keeps the Phase 1 idx_incidents_status_severity(status, severity): does it earn its place?",
    sql: "SELECT incident_id, title, severity, status, created_at FROM Incidents i {HINT} WHERE i.status IN ('open','investigating') AND i.severity IN ('high','critical') ORDER BY i.created_at LIMIT 50",
    params: [],
    variants: [
      { label: "without idx_incidents_status_severity", hint: "IGNORE INDEX (idx_incidents_status_severity)" },
      { label: "Phase 1 idx_incidents_status_severity (status, severity)", hint: "FORCE INDEX (idx_incidents_status_severity)" },
      { label: "optimizer's own choice", hint: "" },
    ],
  },
  {
    id: "active_counts", query: "count of active incidents per status and severity (dashboard tiles)",
    why: "the query shape the Phase 1 idx_incidents_status_severity(status, severity) actually fits (covering)",
    sql: "SELECT status, severity, COUNT(*) AS n FROM Incidents i {HINT} WHERE i.status IN ('open','investigating','contained') GROUP BY status, severity",
    params: [],
    variants: [
      { label: "without idx_incidents_status_severity", hint: "IGNORE INDEX (idx_incidents_status_severity)" },
      { label: "Phase 1 idx_incidents_status_severity (status, severity)", hint: "FORCE INDEX (idx_incidents_status_severity)" },
      { label: "optimizer's own choice", hint: "" },
    ],
  },
  {
    id: "ioc_by_value", query: "find an IOC by value alone (pasted indicator, type unknown)",
    why: "defect D8: is idx_iocs_value(ioc_value) needed next to uq_iocs_type_value(ioc_type, ioc_value)?",
    sql: "SELECT ioc_id, ioc_type FROM IOCs c {HINT} WHERE c.ioc_value = ?",
    params: ["scale-ioc-12345.example"],
    variants: [
      { label: "without idx_iocs_value (MySQL 8 may skip-scan uq_iocs_type_value)", hint: "IGNORE INDEX (idx_iocs_value)" },
      { label: "Phase 1 idx_iocs_value (ioc_value)", hint: "FORCE INDEX (idx_iocs_value)" },
    ],
  },
  {
    id: "incidents_sharing_ioc", query: "all incidents linked to one IOC (correlation)",
    why: "relies on the implicit foreign-key index on Incident_IOC(ioc_id); no new index needed",
    sql: "SELECT l.incident_id FROM Incident_IOC l {HINT} WHERE l.ioc_id = ?",
    params: [777],
    variants: [
      { label: "without the FK index: full index scan", hint: "IGNORE INDEX (fk_iioc_ioc)" },
      { label: "FK index fk_iioc_ioc (ioc_id)", hint: "FORCE INDEX (fk_iioc_ioc)" },
    ],
  },
];

async function buildScaledCopy(conn: Connection, db: string): Promise<void> {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
  await resetAndMigrate(conn, db, dir);
  const [trg] = await conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?", [db]);
  for (const t of trg) await conn.query(`DROP TRIGGER \`${String(t.TRIGGER_NAME)}\``); // scratch copy only (see header)
  await conn.query("SET SESSION cte_max_recursion_depth = 1000000");
  await conn.query(`INSERT INTO Users (user_id, name, email, password_hash, role)
    WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${N_USERS})
    SELECT n, CONCAT('User ', n), CONCAT('u', n, '@scale.example'), 'x', IF(n <= 5, 'admin', 'analyst') FROM s`);
  // status mix ~ 70% closed, 10% resolved, 5% contained, 10% investigating, 5% open (like a mature SOC); created_at
  // spread over ~3.5 years; resolved_at coherent with the CHECK constraints.
  await conn.query(`INSERT INTO Incidents (incident_id, title, narrative, severity, status, reported_by, assigned_to, created_at, resolved_at, updated_at)
    WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${N_INCIDENTS})
    SELECT n, CONCAT('Scaled incident ', n), CONCAT('Synthetic narrative for scaled incident ', n),
           ELT(1 + (n * 7) % 4, 'low', 'medium', 'high', 'critical'), st,
           1 + n % ${N_USERS}, IF(st = 'open' AND n % 2 = 0, NULL, 6 + n % ${N_USERS - 5}),
           created, IF(st IN ('resolved', 'closed'), created + INTERVAL (1 + n % 200) HOUR, NULL),
           created + INTERVAL (n % 300) HOUR
    FROM (SELECT n, TIMESTAMP('2023-01-01') + INTERVAL (n * 37) MINUTE AS created,
                 CASE WHEN (n * 7919) % 100 < 70 THEN 'closed' WHEN (n * 7919) % 100 < 80 THEN 'resolved'
                      WHEN (n * 7919) % 100 < 85 THEN 'contained' WHEN (n * 7919) % 100 < 95 THEN 'investigating' ELSE 'open' END AS st
            FROM s) x`);
  const hist = (cols: string, from: string, where = "") => conn.query(
    `INSERT INTO Incident_Status_History (incident_id, old_status, new_status, changed_by, actor_name_snapshot, db_account, source, changed_at)
     SELECT incident_id, ${cols}, reported_by, 'scale', 'scale', 'import', ${from} FROM Incidents ${where}`);
  await hist("NULL, 'open'", "created_at");
  await hist("'open', 'investigating'", "created_at + INTERVAL 1 HOUR", "WHERE status <> 'open'");
  await hist("'investigating', 'resolved'", "resolved_at", "WHERE status IN ('resolved', 'closed')");
  await hist("'resolved', 'closed'", "resolved_at + INTERVAL 1 HOUR", "WHERE status = 'closed'");
  await conn.query(`INSERT INTO IOCs (ioc_id, ioc_type, ioc_value, threat_level)
    WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${N_IOCS})
    SELECT n, ELT(1 + n % 3, 'ip', 'domain', 'url'), CONCAT('scale-ioc-', n, '.example'), ELT(1 + n % 4, 'low', 'medium', 'high', 'critical') FROM s`);
  await conn.query(`INSERT INTO Incident_IOC (incident_id, ioc_id) SELECT incident_id, 1 + (incident_id * 13) % ${N_IOCS} FROM Incidents`);
  await conn.query(`INSERT IGNORE INTO Incident_IOC (incident_id, ioc_id) SELECT incident_id, 1 + (incident_id * 29 + 7) % ${N_IOCS} FROM Incidents`);
  // IN THE SCRATCH COPY ONLY: the Phase 1 index that 0011 replaced (to measure the old plan) and a rejected candidate.
  await conn.query("CREATE INDEX idx_incidents_assigned_to ON Incidents (assigned_to)");
  await conn.query("CREATE INDEX idx_candidate_ish_incident_time ON Incident_Status_History (incident_id, changed_at)");
  // Creating the candidate makes MySQL silently drop the implicit FK index fk_ish_incident (the candidate can serve the
  // FK). Recreate an equivalent single-column index explicitly so both plans can be measured side by side.
  await conn.query("CREATE INDEX idx_ish_incident_only ON Incident_Status_History (incident_id)");
  for (const t of ["Users", "Incidents", "Incident_Status_History", "IOCs", "Incident_IOC"]) await conn.query(`ANALYZE TABLE ${t}`);
}

const HANDLERS = ["Handler_read_first", "Handler_read_key", "Handler_read_last", "Handler_read_next", "Handler_read_prev", "Handler_read_rnd", "Handler_read_rnd_next"];
async function handlerReads(conn: Connection): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(`SHOW SESSION STATUS WHERE Variable_name IN (${HANDLERS.map(() => "?").join(",")})`, HANDLERS);
  return rows.reduce((s, r) => s + Number(r.Value), 0);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

export interface Measurement { case: string; variant: string; access: string; key: string | null; rowsRead: number; ms: number; plan: string }

export async function measure(conn: Connection): Promise<Measurement[]> {
  const out: Measurement[] = [];
  const overhead = await (async () => { const a = await handlerReads(conn); await conn.query("SELECT 1"); return (await handlerReads(conn)) - a; })();
  for (const c of CASES) {
    for (const v of c.variants) {
      const sql = c.sql.replace("{HINT}", v.hint);
      const [[ex]] = await conn.query<RowDataPacket[]>(`EXPLAIN ${sql}`, c.params);
      const times: number[] = []; const reads: number[] = []; let plan = "";
      for (let k = 0; k < 5; k++) {
        const before = await handlerReads(conn);
        await conn.query(sql, c.params);
        reads.push((await handlerReads(conn)) - before - overhead);
        const [[an]] = await conn.query<RowDataPacket[]>(`EXPLAIN ANALYZE ${sql}`, c.params);
        plan = String(Object.values(an!)[0]);
        times.push(Number(/actual time=[\d.]+\.\.([\d.]+)/.exec(plan.split("\n")[0]!)?.[1] ?? NaN));
      }
      out.push({ case: c.id, variant: v.label, access: String(ex!.type), key: ex!.key === null ? null : String(ex!.key), rowsRead: median(reads), ms: median(times), plan });
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await loadEnv();
  const db = `${env().MYSQL_DATABASE}_p1check`;
  const conn = await migratorConn(db);
  const lines: string[] = [];
  const say = (s = "") => { console.log(s); lines.push(s); };
  try {
    const [[v]] = await conn.query<RowDataPacket[]>("SELECT VERSION() AS v");
    const t0 = performance.now();
    await buildScaledCopy(conn, db);
    say(`EXPLAIN review on a scaled copy (${db}), MySQL ${v!.v}, built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    for (const t of ["Incidents", "Incident_Status_History", "IOCs", "Incident_IOC"]) {
      const [[r]] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${t}`);
      say(`  ${t}: ${r!.n} rows`);
    }
    const results = await measure(conn);
    for (const c of CASES) {
      say(`\n== ${c.id}: ${c.query}\n   ${c.why}\n   ${c.sql.replace(" {HINT}", "")}   params=${JSON.stringify(c.params)}`);
      for (const m of results.filter((r) => r.case === c.id)) {
        say(`   - ${m.variant}\n       access=${m.access} key=${m.key ?? "(none)"}  rows read=${m.rowsRead}  time=${m.ms.toFixed(3)} ms (median of 5, EXPLAIN ANALYZE)`);
        for (const l of m.plan.split("\n")) if (l.trim()) say(`         ${l}`);
      }
    }
    const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/evidence/explain.txt");
    await writeFile(out, lines.join("\n") + "\n", "utf8");
    console.log(`\nwritten: docs/evidence/explain.txt`);
  } finally {
    await conn.end();
  }
}
