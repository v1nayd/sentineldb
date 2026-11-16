"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, describeError } from "../../../_ui/api";
import { Card, SEVERITIES } from "../../../_ui/bits";
import { ResultsList, type Correlation } from "../[id]/panels";

export function NewIncidentForm() {
  const router = useRouter();
  const [f, setF] = useState({ title: "", narrative: "", severity: "medium" });
  const [similar, setSimilar] = useState<Correlation | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy("check"); setError(null);
    try { setSimilar(await api<Correlation>("/api/search/similar", { method: "POST", body: { text: f.narrative, k: 5 } })); }
    catch (e) { setError(describeError(e)); } finally { setBusy(null); }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save"); setError(null);
    try {
      const r = await api<{ incident_id: number }>("/api/incidents", { method: "POST", body: f });
      router.push(`/incidents/${r.incident_id}`);
    } catch (err) { setError(describeError(err)); setBusy(null); }
  }

  return (
    <div className="grid-2">
      <form className="card stack" onSubmit={save}>
        <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} required /></label>
        <label>Severity<select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>What happened?<textarea value={f.narrative} onChange={(e) => setF({ ...f, narrative: e.target.value })} maxLength={10000} required style={{ minHeight: 180 }} placeholder="Describe the incident in your own words." /></label>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="row">
          <button type="button" disabled={busy !== null || f.narrative.trim().length < 3} onClick={check}>{busy === "check" ? "Searching…" : "Check for similar incidents"}</button>
          <button className="primary" type="submit" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Report incident"}</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Indicators and affected assets are added on the incident page after reporting.</p>
      </form>
      <Card title="Similar past incidents">
        {similar ? <ResultsList data={similar} /> : <p className="muted small">Check before filing: a similar incident may already exist, or tell you what was done last time.</p>}
      </Card>
    </div>
  );
}
