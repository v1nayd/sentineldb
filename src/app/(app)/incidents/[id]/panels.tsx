"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, describeError } from "../../../_ui/api";
import { Card, IOC_TYPES, IndexBadge, SEVERITIES, SeverityBadge, StatusBadge } from "../../../_ui/bits";

/** Runs an API call, then re-renders the server page so every panel shows the database's new state. */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setError(null);
    try { await fn(); after?.(); router.refresh(); } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  }
  return { busy, error, run, setError };
}
const Err = ({ error }: { error: string | null }) => (error ? <div className="alert error" role="alert">{error}</div> : null);

interface Allowed { to: string; requires_reason: boolean; description: string; via: "transition" | "close" }

export function ActionsPanel({ id, status, allowed, isAdmin, assignee, users }: {
  id: number; status: string; allowed: Allowed[]; isAdmin: boolean; assignee: number | null; users: Array<{ user_id: number; name: string; role: string }>;
}) {
  const a = useAction();
  const [reason, setReason] = useState("");
  const [to, setTo] = useState(assignee ?? users[0]?.user_id ?? 0);
  const [reassignReason, setReassignReason] = useState("");
  const [archiveReason, setArchiveReason] = useState("");
  return (
    <Card title="Actions">
      <div className="stack">
        {allowed.length === 0 && status !== "closed" && <p className="muted small">{assignee === null ? "Waiting for an admin to assign this incident." : "Only the assignee or an admin can move this incident."}</p>}
        {allowed.length > 0 && (
          <>
            <label>Reason (required for backward moves)<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="optional unless marked *" /></label>
            <div className="row">
              {allowed.map((t) => (
                <button key={t.to} type="button" className={t.via === "close" ? "primary" : undefined} disabled={a.busy} title={t.description}
                  onClick={() => a.run(() => api(`/api/incidents/${id}/${t.via === "close" ? "close" : "transition"}`, { method: "POST", body: t.via === "close" ? (reason ? { reason } : {}) : { to: t.to, ...(reason ? { reason } : {}) } }), () => setReason(""))}>
                  {t.via === "close" ? "Close" : `→ ${t.to}`}{t.requires_reason ? " *" : ""}
                </button>
              ))}
            </div>
          </>
        )}
        {isAdmin && status !== "closed" && (
          <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <h3>Assign</h3>
            <label>Analyst<select value={to} onChange={(e) => setTo(Number(e.target.value))}>{users.map((u) => <option key={u.user_id} value={u.user_id}>{u.name} ({u.role})</option>)}</select></label>
            <label>Handover reason<input value={reassignReason} onChange={(e) => setReassignReason(e.target.value)} maxLength={500} /></label>
            <button type="button" disabled={a.busy || !reassignReason.trim()} onClick={() => a.run(() => api(`/api/incidents/${id}/reassign`, { method: "POST", body: { assignee: to, reason: reassignReason } }), () => setReassignReason(""))}>
              {assignee === null ? "Assign" : "Reassign"}
            </button>
          </div>
        )}
        {isAdmin && status === "closed" && (
          <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <h3>Archive</h3>
            <label>Reason<input value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} maxLength={500} /></label>
            <button type="button" className="danger" disabled={a.busy || !archiveReason.trim()} onClick={() => a.run(() => api(`/api/incidents/${id}/archive`, { method: "POST", body: { reason: archiveReason } }))}>Archive incident</button>
          </div>
        )}
        <Err error={a.error} />
      </div>
    </Card>
  );
}

export function EditPanel({ id, title, narrative, severity }: { id: number; title: string; narrative: string; severity: string }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title, narrative, severity });
  if (!open) return <button type="button" onClick={() => setOpen(true)}>Edit</button>;
  const patch = Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== ({ title, narrative, severity } as Record<string, string>)[k]));
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); a.run(() => api(`/api/incidents/${id}`, { method: "PATCH", body: patch }), () => setOpen(false)); }}>
      <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} required /></label>
      <label>Severity<select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
      <label>Narrative<textarea value={f.narrative} onChange={(e) => setF({ ...f, narrative: e.target.value })} maxLength={10000} required /></label>
      <p className="muted small">Changing the narrative creates a new version and queues re-indexing for similarity search.</p>
      <Err error={a.error} />
      <div className="row"><button className="primary" type="submit" disabled={a.busy || Object.keys(patch).length === 0}>Save</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

export function IocPanel({ id, iocs, canReview, editable }: {
  id: number; iocs: Array<{ ioc_id: number; ioc_type: string; ioc_value: string; threat_level: string | null; review_status: string; reviewer_name: string | null }>; canReview: boolean; editable: boolean;
}) {
  const a = useAction();
  const [type, setType] = useState<string>("ip");
  const [value, setValue] = useState("");
  const pending = iocs.filter((x) => x.review_status === "pending").length;
  return (
    <Card title={`Indicators (${iocs.length})`} actions={pending > 0 ? <span className="badge ix-pending">{pending} awaiting review</span> : undefined}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Type</th><th>Value</th><th>Threat</th><th>Review</th>{editable && <th />}</tr></thead>
          <tbody>
            {iocs.map((x) => (
              <tr key={x.ioc_id}>
                <td>{x.ioc_type}</td>
                <td className="mono" style={{ wordBreak: "break-all" }}>{x.ioc_value}</td>
                <td>{x.threat_level ? <SeverityBadge severity={x.threat_level} /> : <span className="muted">—</span>}</td>
                <td>
                  {canReview ? (
                    <select aria-label={`Review ${x.ioc_value}`} value={x.review_status} disabled={a.busy}
                      onChange={(e) => a.run(() => api(`/api/incidents/${id}/iocs/${x.ioc_id}`, { method: "PATCH", body: { review_status: e.target.value } }))}>
                      <option value="pending">pending</option><option value="confirmed">confirmed</option><option value="dismissed">dismissed (false positive)</option>
                    </select>
                  ) : <span>{x.review_status}</span>}
                  {x.reviewer_name && <div className="small muted">by {x.reviewer_name}</div>}
                </td>
                {editable && <td><button type="button" className="danger" disabled={a.busy} onClick={() => a.run(() => api(`/api/incidents/${id}/iocs/${x.ioc_id}`, { method: "DELETE" }))}>Unlink</button></td>}
              </tr>
            ))}
            {iocs.length === 0 && <tr><td colSpan={5} className="muted">No indicators linked.</td></tr>}
          </tbody>
        </table>
      </div>
      {editable && (
        <form className="form-grid" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); a.run(() => api(`/api/incidents/${id}/iocs`, { method: "POST", body: { ioc_type: type, ioc_value: value } }), () => setValue("")); }}>
          <label>Type<select value={type} onChange={(e) => setType(e.target.value)}>{IOC_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label style={{ gridColumn: "span 2" }}>Value<input value={value} onChange={(e) => setValue(e.target.value)} required maxLength={255} placeholder="e.g. 203.0.113.7" /></label>
          <button type="submit" disabled={a.busy}>Link IOC</button>
        </form>
      )}
      <Err error={a.error} />
    </Card>
  );
}

export function AssetPanel({ id, linked, all, editable }: {
  id: number; linked: Array<{ asset_id: number; asset_name: string; asset_type: string; criticality_level: number; impact_description: string | null }>;
  all: Array<{ asset_id: number; asset_name: string; asset_type: string }>; editable: boolean;
}) {
  const a = useAction();
  const free = all.filter((x) => !linked.some((l) => l.asset_id === x.asset_id));
  const [pick, setPick] = useState(free[0]?.asset_id ?? 0);
  const [impact, setImpact] = useState<Record<number, string>>({});
  return (
    <Card title={`Affected assets (${linked.length})`}>
      <div className="stack">
        {linked.map((x) => (
          <div key={x.asset_id} className="stack" style={{ gap: 6, borderBottom: "1px solid var(--border)", paddingBottom: 10 }}>
            <div className="row"><b>{x.asset_name}</b><span className="muted small">{x.asset_type} · criticality {x.criticality_level}/5</span>
              {editable && <button type="button" className="danger" style={{ marginLeft: "auto" }} disabled={a.busy} onClick={() => a.run(() => api(`/api/incidents/${id}/assets/${x.asset_id}`, { method: "DELETE" }))}>Unlink</button>}</div>
            {editable ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(() => api(`/api/incidents/${id}/assets/${x.asset_id}`, { method: "PATCH", body: { impact_description: impact[x.asset_id] ?? x.impact_description ?? "" } })); }}>
                <input aria-label={`Impact on ${x.asset_name}`} style={{ flex: 1 }} value={impact[x.asset_id] ?? x.impact_description ?? ""} onChange={(e) => setImpact({ ...impact, [x.asset_id]: e.target.value })} placeholder="Describe the impact (required before closing)" maxLength={2000} />
                <button type="submit" disabled={a.busy}>Save</button>
              </form>
            ) : <p className="small">{x.impact_description ?? <span className="muted">No impact described.</span>}</p>}
          </div>
        ))}
        {linked.length === 0 && <p className="muted">No assets linked.</p>}
        {editable && free.length > 0 && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(() => api(`/api/incidents/${id}/assets`, { method: "POST", body: { asset_id: pick } })); }}>
            <select aria-label="Asset to link" value={pick} onChange={(e) => setPick(Number(e.target.value))}>{free.map((x) => <option key={x.asset_id} value={x.asset_id}>{x.asset_name} ({x.asset_type})</option>)}</select>
            <button type="submit" disabled={a.busy}>Link asset</button>
          </form>
        )}
        <Err error={a.error} />
      </div>
    </Card>
  );
}

export function NotesForm({ id }: { id: number }) {
  const a = useAction();
  const [content, setContent] = useState("");
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); a.run(() => api(`/api/incidents/${id}/notes`, { method: "POST", body: { content } }), () => setContent("")); }}>
      <textarea aria-label="Note" value={content} onChange={(e) => setContent(e.target.value)} maxLength={5000} required placeholder="Notes are append-only and appear in the timeline." style={{ minHeight: 80 }} />
      <Err error={a.error} />
      <button type="submit" disabled={a.busy || !content.trim()}>Add note</button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------- similar incidents
export interface Ranked {
  incident_id: number; title: string; severity: string; status: string; index_state: string; score: number;
  components: { text: number; text_kind: "semantic" | "lexical"; iocs: number; assets: number };
  contributions: { text: number; iocs: number; assets: number };
  shared_iocs: Array<{ ioc_id: number; ioc_type: string; ioc_value: string }>; shared_assets: Array<{ asset_id: number; asset_name: string }>;
  explanation: string;
}
export interface Correlation { mode: "hybrid" | "lexical_fallback"; ranking: string; results: Ranked[]; notes: string[] }

export function ResultsList({ data }: { data: Correlation }) {
  return (
    <div className="stack">
      {data.mode === "lexical_fallback" && <div className="alert warn" role="status"><b>Keyword fallback.</b> Semantic search is unavailable, so text similarity is keyword-based (MySQL FULLTEXT), not semantic.</div>}
      {data.notes.filter((n) => !/KEYWORD-based/.test(n)).map((n) => <p key={n} className="muted small" style={{ margin: 0 }}>{n}</p>)}
      <div className="row small">
        <span className="legend"><i className="seg-text" /> text</span><span className="legend"><i className="seg-iocs" /> shared IOCs</span><span className="legend"><i className="seg-assets" /> shared assets</span>
      </div>
      <div>
        {data.results.map((r, k) => (
          <div key={r.incident_id} className="result">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row"><span className="muted mono">{k + 1}.</span><Link href={`/incidents/${r.incident_id}`}>#{r.incident_id} {r.title}</Link></div>
              <div className="row">
                <div className="scorebar" role="img" aria-label={`score ${r.score}: text ${r.contributions.text}, IOCs ${r.contributions.iocs}, assets ${r.contributions.assets}`}>
                  <span className="seg-text" style={{ width: `${r.contributions.text * 100}%` }} /><span className="seg-iocs" style={{ width: `${r.contributions.iocs * 100}%` }} /><span className="seg-assets" style={{ width: `${r.contributions.assets * 100}%` }} />
                </div>
                <b className="mono">{r.score.toFixed(3)}</b>
              </div>
            </div>
            <div className="row small" style={{ marginTop: 4 }}><SeverityBadge severity={r.severity} /><StatusBadge status={r.status} />{r.index_state !== "synced" && <IndexBadge state={r.index_state} />}</div>
            <p className="small muted" style={{ margin: "4px 0 0" }}>{r.explanation}</p>
          </div>
        ))}
        {data.results.length === 0 && <p className="muted">No similar incidents found.</p>}
      </div>
    </div>
  );
}

export function SimilarPanel({ id }: { id: number }) {
  const [data, setData] = useState<Correlation | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Correlation>(`/api/incidents/${id}/similar?k=8`).then((d) => live && setData(d), (e) => live && setError(describeError(e)));
    return () => { live = false; };
  }, [id]);
  return (
    <Card title="Have we seen this before?" actions={data ? <span className="badge">{data.mode === "hybrid" ? data.ranking : "keyword fallback"}</span> : undefined}>
      <p className="muted small">Ranked by narrative similarity plus shared indicators and assets. Every score is broken down below.</p>
      {error && <div className="alert error">{error}</div>}
      {!data && !error && <p className="muted">Finding similar incidents…</p>}
      {data && <ResultsList data={data} />}
    </Card>
  );
}
