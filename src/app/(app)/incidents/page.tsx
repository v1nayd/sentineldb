import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { listIncidents, listSchema } from "@/lib/repo/incidents";
import { SEVERITIES, STATUSES, SeverityBadge, StatusBadge, When } from "../../_ui/bits";

export const metadata = { title: "Incidents" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function IncidentsPage({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const sp = await searchParams;
  const raw = { status: first(sp.status), severity: first(sp.severity), assigned: first(sp.assigned), q: first(sp.q), page: first(sp.page) };
  const parsed = listSchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)));
  const filters = parsed.success ? parsed.data : listSchema.parse({});
  const data = await listIncidents(user, filters);
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  const link = (page: number) => `/incidents?${new URLSearchParams({ ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => v && k !== "page")) as Record<string, string>, page: String(page) })}`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="muted" style={{ margin: 0 }}>
            {user.role === "admin" ? "All active incidents." : "Active incidents you reported or are assigned to."} {data.total} match{data.total === 1 ? "" : "es"}.
          </p>
        </div>
        <Link className="btn primary" href="/incidents/new">Report incident</Link>
      </div>

      <form className="card form-grid" method="get" action="/incidents">
        <label>Keyword<input name="q" defaultValue={raw.q ?? ""} placeholder="title or narrative" maxLength={100} /></label>
        <label>Status
          <select name="status" defaultValue={raw.status ?? ""}><option value="">Any</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <label>Severity
          <select name="severity" defaultValue={raw.severity ?? ""}><option value="">Any</option>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <label>Assignment
          <select name="assigned" defaultValue={raw.assigned ?? ""}><option value="">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option></select>
        </label>
        <div className="row"><button className="primary" type="submit">Filter</button><Link className="btn" href="/incidents">Clear</Link></div>
      </form>
      {!parsed.success && <div className="alert warn">Some filters were not valid and were ignored.</div>}

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr><th>#</th><th>Title</th><th>Severity</th><th>Status</th><th>Assignee</th><th className="num">IOCs</th><th className="num">Assets</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {data.incidents.map((i) => (
              <tr key={i.incident_id}>
                <td className="mono">{i.incident_id}</td>
                <td><Link href={`/incidents/${i.incident_id}`}>{i.title}</Link>{Number(i.pending_ioc_count) > 0 && <div className="small muted">{i.pending_ioc_count} IOC review(s) pending</div>}</td>
                <td><SeverityBadge severity={i.severity} /></td>
                <td><StatusBadge status={i.status} /></td>
                <td>{i.assignee_name ?? <span className="muted">unassigned</span>}</td>
                <td className="num">{i.ioc_count}</td>
                <td className="num">{i.asset_count}</td>
                <td className="small"><When at={i.updated_at} /></td>
              </tr>
            ))}
            {data.incidents.length === 0 && <tr><td colSpan={8} className="muted">No incidents match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          {data.page > 1 && <Link className="btn" href={link(data.page - 1)}>← Previous</Link>}
          <span className="muted small">Page {data.page} of {pages}</span>
          {data.page < pages && <Link className="btn" href={link(data.page + 1)}>Next →</Link>}
        </div>
      )}
    </div>
  );
}
