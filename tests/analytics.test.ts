import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratorConn } from "../src/lib/db";
import { resetAndMigrate } from "../src/lib/migrate";
import { loadNamedQueries } from "../src/lib/reports";
import { MIGRATIONS, ROOT, TEST_DB, appConn } from "./fixtures";

/**
 * Analytic views (migration 0010) on the replayed demo dataset. Each view is checked against an INDEPENDENT computation
 * in TypeScript over the raw rows (read as the runtime account), so a wrong JOIN, a missing COALESCE or a GROUP BY that
 * double-counts shows up as a mismatch, not as a plausible-looking number.
 */
let admin: Connection;
let app: Connection;
type R = RowDataPacket;
let incidents: R[];
const rows = async (sql: string) => (await app.query<R[]>(sql))[0];
const minutesBetween = (a: Date, b: Date) => Math.trunc((b.getTime() - a.getTime()) / 60_000); // = TIMESTAMPDIFF(MINUTE)
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const active = () => incidents.filter((i) => i.archived_at === null);

beforeAll(async () => {
  admin = await migratorConn(TEST_DB);
  await resetAndMigrate(admin, TEST_DB, MIGRATIONS);
  await admin.query(await readFile(path.join(ROOT, "db/seed/demo_seed.sql"), "utf8"));
  app = await appConn();
  incidents = await rows("SELECT incident_id, severity, status, assigned_to, created_at, resolved_at, archived_at FROM Incidents");
}, 300_000);
afterAll(async () => { await app?.end(); await admin?.end(); });

describe("views agree with an independent computation", () => {
  it("severity_status_matrix_view", async () => {
    const view = await rows("SELECT * FROM severity_status_matrix_view");
    expect(view).toHaveLength(4);
    for (const v of view) {
      const mine = active().filter((i) => i.severity === v.severity);
      for (const s of ["open", "investigating", "contained", "resolved", "closed"]) {
        expect(v[`${s}_count`], `${v.severity}/${s}`).toBe(mine.filter((i) => i.status === s).length);
      }
      expect(v.total_count).toBe(mine.length);
    }
  });

  it("workload_by_assignee_view: every user (also zero-incident ones) plus the unassigned bucket", async () => {
    const users = await rows("SELECT user_id, name FROM Users");
    const view = await rows("SELECT * FROM workload_by_assignee_view");
    expect(view).toHaveLength(users.length + 1);
    const isActive = (s: string) => ["open", "investigating", "contained"].includes(s);
    for (const v of view) {
      const mine = active().filter((i) => i.assigned_to === v.user_id);
      expect(v.active_incidents, String(v.name)).toBe(mine.filter((i) => isActive(i.status)).length);
      expect(v.active_high_or_critical).toBe(mine.filter((i) => isActive(i.status) && ["high", "critical"].includes(i.severity)).length);
      expect(v.resolved_incidents).toBe(mine.filter((i) => ["resolved", "closed"].includes(i.status)).length);
      const durations = mine.filter((i) => i.resolved_at).map((i) => minutesBetween(i.created_at, i.resolved_at));
      if (v.user_id === null || durations.length === 0) expect(v.avg_hours_to_resolve).toBeNull();
      else expect(Number(v.avg_hours_to_resolve)).toBeCloseTo(avg(durations) / 60, 1);
    }
    expect(view.find((v) => v.name === "Noah Kim")).toMatchObject({ active_incidents: 0, resolved_incidents: 0 });
  });

  it("mttr_by_severity_view: origin row to FIRST resolution, from the audit trail", async () => {
    const h = await rows("SELECT incident_id, old_status, new_status, changed_at FROM Incident_Status_History ORDER BY history_id");
    const origin = new Map<number, Date>(); const firstResolved = new Map<number, Date>();
    for (const r of h) {
      if (r.old_status === null) origin.set(r.incident_id, r.changed_at);
      if (r.new_status === "resolved" && !firstResolved.has(r.incident_id)) firstResolved.set(r.incident_id, r.changed_at);
    }
    for (const v of await rows("SELECT * FROM mttr_by_severity_view")) {
      const ds = incidents.filter((i) => i.severity === v.severity && firstResolved.has(i.incident_id))
        .map((i) => minutesBetween(origin.get(i.incident_id)!, firstResolved.get(i.incident_id)!));
      expect(v.resolved_incidents, String(v.severity)).toBe(ds.length);
      expect(Number(v.mean_hours_to_first_resolution)).toBeCloseTo(avg(ds) / 60, 1);
      expect(Number(v.min_hours)).toBeCloseTo(Math.min(...ds) / 60, 1);
      expect(Number(v.max_hours)).toBeCloseTo(Math.max(...ds) / 60, 1);
    }
  });

  it("recurring_ioc_view: exactly the IOCs in 2+ incidents, ignoring dismissed links", async () => {
    const links = await rows("SELECT incident_id, ioc_id FROM Incident_IOC WHERE review_status <> 'dismissed'");
    const per = new Map<number, Set<number>>();
    for (const l of links) per.set(l.ioc_id, (per.get(l.ioc_id) ?? new Set()).add(l.incident_id));
    const expected = [...per].filter(([, s]) => s.size >= 2).map(([ioc, s]) => [ioc, s.size]).sort((a, b) => a[0]! - b[0]!);
    const view = (await rows("SELECT ioc_id, incident_count FROM recurring_ioc_view ORDER BY ioc_id")).map((r) => [r.ioc_id, r.incident_count]);
    expect(expected.length).toBeGreaterThan(5);
    expect(view).toEqual(expected);
  });

  it("monthly_trend_view", async () => {
    const months = new Map<string, number>();
    for (const i of active()) { const m = (i.created_at as Date).toISOString().slice(0, 7); months.set(m, (months.get(m) ?? 0) + 1); }
    const view = await rows("SELECT month, created FROM monthly_trend_view ORDER BY month");
    expect(view.map((r) => [r.month, r.created])).toEqual([...months].sort());
  });

  it("incident_summary_view: evidence and note counts per incident, archived excluded", async () => {
    const count = async (sql: string) => new Map((await rows(sql)).map((r) => [r.incident_id as number, Number(r.n)]));
    const [iocs, pending, assets, notes] = await Promise.all([
      count("SELECT incident_id, COUNT(*) n FROM Incident_IOC GROUP BY incident_id"),
      count("SELECT incident_id, COUNT(*) n FROM Incident_IOC WHERE review_status = 'pending' GROUP BY incident_id"),
      count("SELECT incident_id, COUNT(*) n FROM Incident_Asset GROUP BY incident_id"),
      count("SELECT incident_id, COUNT(*) n FROM Notes GROUP BY incident_id")]);
    const view = await rows("SELECT incident_id, ioc_count, pending_ioc_count, asset_count, note_count FROM incident_summary_view");
    expect(view).toHaveLength(active().length);
    for (const v of view) {
      expect([v.ioc_count, v.pending_ioc_count, v.asset_count, v.note_count], `incident ${v.incident_id}`)
        .toEqual([iocs.get(v.incident_id) ?? 0, pending.get(v.incident_id) ?? 0, assets.get(v.incident_id) ?? 0, notes.get(v.incident_id) ?? 0]);
    }
  });
});

describe("report queries (db/reports/analytics.sql)", () => {
  it("every report runs as the least-privilege runtime account, and the ones that should find something do", async () => {
    const queries = await loadNamedQueries(path.join(ROOT, "db/reports/analytics.sql"));
    expect(queries.length).toBeGreaterThanOrEqual(12);
    const empty: string[] = [];
    for (const q of queries) if ((await app.query<R[]>(q.sql))[0].length === 0) empty.push(q.name);
    // These depend on the dataset and may legitimately be empty; everything else must return rows.
    expect(empty.filter((n) => !["active_incidents_without_notes", "stalled_investigations", "reopened_incidents"].includes(n))).toEqual([]);
  });
  it("the Phase 1 analyst_workload_view still works unchanged", async () => {
    expect((await rows("SELECT * FROM analyst_workload_view")).length).toBeGreaterThan(0);
  });
});
