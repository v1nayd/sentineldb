import Link from "next/link";
import { notFound } from "next/navigation";
import type { RowDataPacket } from "mysql2/promise";
import { requireUser } from "@/lib/auth/current-user";
import { HttpError } from "@/lib/http";
import { listAssets, listUsers } from "@/lib/repo/admin";
import { getIncident } from "@/lib/repo/incidents";
import { Card, SeverityBadge, StatusBadge, When } from "../../../_ui/bits";
import { ActionsPanel, AssetPanel, EditPanel, IocPanel, NotesForm, SimilarPanel } from "./panels";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return { title: `Incident #${(await params).id}` };
}

export default async function IncidentPage({ params }: { params: Params }) {
  const user = await requireUser();
  const raw = (await params).id;
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) notFound();
  let d: Awaited<ReturnType<typeof getIncident>>;
  try {
    d = await getIncident(user, Number(raw));
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound(); // outside your scope looks exactly like "does not exist"
    throw e;
  }
  const i = d.incident as RowDataPacket;
  const isAdmin = user.role === "admin";
  const archived = i.archived_at !== null;
  const frozen = archived || i.status === "closed";
  const canWork = isAdmin || i.assigned_to === user.id;
  const assets = (await listAssets()).map((a) => ({ asset_id: Number(a.asset_id), asset_name: String(a.asset_name), asset_type: String(a.asset_type) }));
  const users = isAdmin ? (await listUsers()).filter((u) => u.is_active).map((u) => ({ user_id: Number(u.user_id), name: String(u.name), role: String(u.role) })) : [];

  const timeline = [
    ...d.status_history.map((h) => ({ at: h.changed_at as Date, who: h.actor_name_snapshot as string, text: h.old_status ? `${h.old_status} → ${h.new_status}` : `reported (${h.new_status})`, reason: h.reason as string | null })),
    ...d.assignment_history.map((h) => ({ at: h.changed_at as Date, who: h.actor_name_snapshot as string, text: `assigned ${h.old_assignee_name ? `from ${h.old_assignee_name} ` : ""}to ${h.new_assignee_name ?? "nobody"}`, reason: h.reason as string | null })),
    ...d.evidence_history.map((h) => ({ at: h.changed_at as Date, who: h.actor_name_snapshot as string, text: `${h.action} ${h.ioc_id ? `IOC ${h.ioc_value}` : `asset ${h.asset_name}`}`, reason: h.detail as string | null })),
    ...d.notes.map((n) => ({ at: n.created_at as Date, who: n.author_name as string, text: "note", reason: n.content as string })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted small" style={{ margin: 0 }}><Link href="/incidents">Incidents</Link> / #{i.incident_id}</p>
          <h1>{i.title}</h1>
          <div className="row">
            <SeverityBadge severity={i.severity} /><StatusBadge status={i.status} />
            {archived && <span className="badge">archived</span>}
            <span className="muted small">narrative v{i.narrative_version}</span>
          </div>
        </div>
      </div>
      {archived && <div className="alert">Archived <When at={i.archived_at} />: {i.archive_reason}. Archived incidents are read-only and leave the similarity index.</div>}

      <div className="grid-2">
        <div className="stack">
          <Card title="Narrative">
            <p className="narrative">{i.narrative}</p>
            {!frozen && <EditPanel id={i.incident_id} title={i.title} narrative={i.narrative} severity={i.severity} />}
          </Card>
          <IocPanel id={i.incident_id} iocs={d.iocs.map((x) => ({ ioc_id: x.ioc_id, ioc_type: x.ioc_type, ioc_value: x.ioc_value, threat_level: x.threat_level, review_status: x.review_status, reviewer_name: x.reviewer_name }))} canReview={canWork && !frozen} editable={!frozen} />
          <AssetPanel id={i.incident_id} linked={d.assets.map((a) => ({ asset_id: a.asset_id, asset_name: a.asset_name, asset_type: a.asset_type, criticality_level: a.criticality_level, impact_description: a.impact_description }))} all={assets} editable={!frozen} />
          <SimilarPanel id={i.incident_id} />
        </div>
        <div className="stack">
          <Card title="Details">
            <dl className="kv">
              <dt>Reported by</dt><dd>{i.reporter_name}</dd>
              <dt>Assignee</dt><dd>{i.assignee_name ?? <span className="muted">unassigned</span>}</dd>
              <dt>Created</dt><dd><When at={i.created_at} /></dd>
              <dt>Updated</dt><dd><When at={i.updated_at} /></dd>
              <dt>Resolved</dt><dd><When at={i.resolved_at} /></dd>
            </dl>
          </Card>
          {!archived && <ActionsPanel id={i.incident_id} status={i.status} allowed={d.allowed_transitions} isAdmin={isAdmin} assignee={i.assigned_to} users={users} />}
          <Card title="Add note">{archived ? <p className="muted">Archived: read-only.</p> : <NotesForm id={i.incident_id} />}</Card>
          <Card title="Audit timeline">
            <p className="muted small">Written by database triggers only; nobody can edit or delete these rows.</p>
            <ol className="timeline">
              {timeline.map((t, k) => (
                <li key={k}>
                  <div><b>{t.text}</b> <span className="muted small">by {t.who ?? "import"}</span></div>
                  <div className="small muted"><When at={t.at} /></div>
                  {t.reason && <div className="small" style={{ whiteSpace: "pre-wrap" }}>{t.reason}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
