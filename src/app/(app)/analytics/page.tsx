import type { RowDataPacket } from "mysql2/promise";
import { requireAdmin } from "@/lib/auth/current-user";
import { analyticsOverview } from "@/lib/repo/admin";
import { Card, SeverityBadge, When } from "../../_ui/bits";

export const metadata = { title: "Analytics" };

const n = (x: unknown) => Number(x ?? 0);
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
const STATUS_COLS = ["open", "investigating", "contained", "resolved", "closed"] as const;

/** Horizontal single-series bars: the value is always written beside the bar (no colour-only reading), hover shows detail. */
function Bars({ rows, max, cls, unit }: { rows: Array<{ label: string; value: number; title: string }>; max: number; cls?: string; unit?: string }) {
  return (
    <div className="bars" role="list">
      {rows.map((r) => (
        <div className="bar-row" key={r.label} role="listitem" title={r.title}>
          <span className="small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
          <div className="bar-track"><div className={`bar-fill ${cls ?? ""}`} style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }} /></div>
          <span className="bar-val small">{r.value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}{unit ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

export default async function AnalyticsPage() {
  await requireAdmin();
  const a = await analyticsOverview();
  const matrix = a.severity_status as RowDataPacket[];
  const total = matrix.reduce((s, r) => s + n(r.total_count), 0);
  const active = matrix.reduce((s, r) => s + n(r.open_count) + n(r.investigating_count) + n(r.contained_count), 0);
  const critActive = matrix.filter((r) => r.severity === "critical").reduce((s, r) => s + n(r.open_count) + n(r.investigating_count) + n(r.contained_count), 0);
  const awaitingClose = matrix.reduce((s, r) => s + n(r.resolved_count), 0);
  const workload = (a.workload as RowDataPacket[]).filter((w) => n(w.active_incidents) > 0 || w.role !== null);
  const mttr = a.mttr as RowDataPacket[];
  const trend = a.monthly_trend as RowDataPacket[];
  const maxCreated = Math.max(1, ...trend.map((t) => n(t.created)));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="muted" style={{ margin: 0 }}>Organisation-wide (admins only). Computed live from the MySQL views; archived incidents are excluded from operational figures.</p>
        </div>
      </div>

      <div className="grid-cards">
        <div className="card stat"><b>{total}</b><span>incidents on record (archived excluded)</span></div>
        <div className="card stat"><b>{active}</b><span>open, investigating or contained</span></div>
        <div className="card stat"><b>{critActive}</b><span>critical and still in progress</span></div>
        <div className="card stat"><b>{awaitingClose}</b><span>resolved, awaiting admin close</span></div>
      </div>

      <Card title="Severity × status">
        <div className="table-wrap">
          <table className="heat">
            <thead><tr><th>Severity</th>{STATUS_COLS.map((s) => <th key={s} className="num">{s}</th>)}<th className="num">total</th></tr></thead>
            <tbody>
              {matrix.map((r) => (
                <tr key={r.severity}>
                  <td><SeverityBadge severity={r.severity} /></td>
                  {STATUS_COLS.map((s) => <td key={s} className="num">{n(r[`${s}_count`]) || <span className="muted">0</span>}</td>)}
                  <td className="num"><b>{n(r.total_count)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>View <code>severity_status_matrix_view</code>: conditional aggregation over a derived table.</p>
      </Card>

      <div className="grid-cards">
        <Card title="Active incidents per assignee">
          <Bars max={Math.max(1, ...workload.map((w) => n(w.active_incidents)))}
            rows={workload.map((w) => ({ label: w.name, value: n(w.active_incidents), title: `${w.name}: ${n(w.active_incidents)} active (${n(w.active_high_or_critical)} high/critical), ${n(w.resolved_incidents)} resolved` }))} />
          <p className="muted small" style={{ marginTop: 8 }}>Includes analysts with no incidents and the unassigned queue (<code>workload_by_assignee_view</code>, LEFT JOIN + UNION ALL).</p>
        </Card>
        <Card title="Mean hours to first resolution">
          <Bars cls="c2" unit=" h" max={Math.max(1, ...mttr.map((m) => n(m.mean_hours_to_first_resolution)))}
            rows={mttr.map((m) => ({ label: m.severity, value: n(m.mean_hours_to_first_resolution), title: `${m.severity}: ${n(m.resolved_incidents)} resolved, range ${n(m.min_hours)}–${n(m.max_hours)} h` }))} />
          <p className="muted small" style={{ marginTop: 8 }}>From the audit trail: first <code>→ resolved</code> per incident (<code>mttr_by_severity_view</code>).</p>
        </Card>
      </div>

      <Card title="Incidents reported per month">
        <div className="cols" role="list">
          {trend.map((t) => (
            <div className="col" key={t.month} role="listitem" title={`${t.month}: ${n(t.created)} reported (${n(t.critical)} critical, ${n(t.high)} high), ${n(t.resolved_or_closed)} resolved or closed`}>
              <span className="col-val">{n(t.created)}</span>
              <div className="col-fill" style={{ height: `${(n(t.created) / maxCreated) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="col-labels" aria-hidden="true">{trend.map((t) => <span key={t.month}>{monthLabel(String(t.month))}</span>)}</div>
        <details style={{ marginTop: 10 }}>
          <summary className="small">Show as table</summary>
          <div className="table-wrap"><table>
            <thead><tr><th>Month</th><th className="num">Reported</th><th className="num">Critical</th><th className="num">High</th><th className="num">Medium</th><th className="num">Low</th><th className="num">Resolved/closed</th></tr></thead>
            <tbody>{trend.map((t) => <tr key={t.month}><td>{t.month}</td>{["created", "critical", "high", "medium", "low", "resolved_or_closed"].map((k) => <td key={k} className="num">{n(t[k])}</td>)}</tr>)}</tbody>
          </table></div>
        </details>
      </Card>

      <Card title="Recurring indicators (in 2+ incidents)">
        <div className="table-wrap"><table>
          <thead><tr><th>Type</th><th>Value</th><th>Threat</th><th className="num">Incidents</th><th>Last seen</th></tr></thead>
          <tbody>{(a.recurring_iocs as RowDataPacket[]).map((r) => (
            <tr key={r.ioc_id}><td>{r.ioc_type}</td><td className="mono" style={{ wordBreak: "break-all" }}>{r.ioc_value}</td><td>{r.threat_level ? <SeverityBadge severity={r.threat_level} /> : "—"}</td><td className="num">{n(r.incident_count)}</td><td className="small"><When at={r.last_incident_at} /></td></tr>
          ))}</tbody>
        </table></div>
        <p className="muted small" style={{ marginTop: 8 }}><code>recurring_ioc_view</code>: GROUP BY … HAVING COUNT(DISTINCT incident_id) &gt;= 2.</p>
      </Card>
    </div>
  );
}
