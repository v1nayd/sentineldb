"use client";

import { useState } from "react";
import { api, describeError } from "../../_ui/api";
import { Card, IOC_TYPES } from "../../_ui/bits";
import { ResultsList, type Correlation } from "../incidents/[id]/panels";

/** IOC lines: "type value", one per line (e.g. "domain docs-account35.example"). */
function parseIocs(text: string): Array<{ ioc_type: string; ioc_value: string }> | string {
  const out: Array<{ ioc_type: string; ioc_value: string }> = [];
  for (const [n, line] of text.split("\n").map((l) => l.trim()).entries()) {
    if (!line) continue;
    const [type, ...rest] = line.split(/\s+/);
    if (!type || !(IOC_TYPES as readonly string[]).includes(type) || rest.length === 0) return `Line ${n + 1}: write "<type> <value>", type one of ${IOC_TYPES.join(", ")}.`;
    out.push({ ioc_type: type, ioc_value: rest.join(" ") });
  }
  return out;
}

export function SearchForm() {
  const [text, setText] = useState("");
  const [iocText, setIocText] = useState("");
  const [data, setData] = useState<Correlation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const iocs = parseIocs(iocText);
    if (typeof iocs === "string") { setError(iocs); return; }
    setBusy(true); setError(null);
    try { setData(await api<Correlation>("/api/search/similar", { method: "POST", body: { text, iocs, k: 10 } })); }
    catch (err) { setError(describeError(err)); } finally { setBusy(false); }
  }

  return (
    <div className="grid-2">
      <Card title="Results">{data ? <ResultsList data={data} /> : <p className="muted">Results appear here, each with the reasons for its rank.</p>}</Card>
      <form className="card stack" onSubmit={submit}>
        <label>Description<textarea value={text} onChange={(e) => setText(e.target.value)} required minLength={3} maxLength={5000} placeholder="e.g. Staff got an email from 'IT' asking them to re-enter their password on a web page." /></label>
        <label>Indicators (optional, one per line)<textarea value={iocText} onChange={(e) => setIocText(e.target.value)} style={{ minHeight: 80 }} placeholder={"domain docs-account35.example\nip 192.0.2.157"} className="mono" /></label>
        {error && <div className="alert error" role="alert">{error}</div>}
        <button className="primary" type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>
    </div>
  );
}
