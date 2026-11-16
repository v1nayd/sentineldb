"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, describeError } from "../../../_ui/api";

const ASSET_TYPES = ["server", "workstation", "network_device", "application"] as const;

export function CriticalityEditor({ id, value }: { id: number; value: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <select aria-label="Criticality" defaultValue={value} onChange={async (e) => {
        setError(null);
        try { await api(`/api/assets/${id}`, { method: "PATCH", body: { criticality_level: Number(e.target.value) } }); router.refresh(); }
        catch (err) { setError(describeError(err)); }
      }}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
      {error && <div className="alert error small">{error}</div>}
    </>
  );
}

export function AssetForm() {
  const router = useRouter();
  const empty = { asset_name: "", asset_type: "server", ip_address: "", criticality_level: 3, owner_department: "" };
  const [f, setF] = useState(empty);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form className="form-grid" onSubmit={async (e) => {
      e.preventDefault(); setMsg(null);
      try {
        await api("/api/assets", { method: "POST", body: { ...f, ip_address: f.ip_address || null, owner_department: f.owner_department || null } });
        setMsg({ ok: true, text: `Added ${f.asset_name}.` }); setF(empty); router.refresh();
      } catch (err) { setMsg({ ok: false, text: describeError(err) }); }
    }}>
      <label>Name<input value={f.asset_name} onChange={(e) => setF({ ...f, asset_name: e.target.value })} required maxLength={150} /></label>
      <label>Type<select value={f.asset_type} onChange={(e) => setF({ ...f, asset_type: e.target.value })}>{ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
      <label>IP (optional)<input value={f.ip_address} onChange={(e) => setF({ ...f, ip_address: e.target.value })} maxLength={45} /></label>
      <label>Department (optional)<input value={f.owner_department} onChange={(e) => setF({ ...f, owner_department: e.target.value })} maxLength={100} /></label>
      <label>Criticality<select value={f.criticality_level} onChange={(e) => setF({ ...f, criticality_level: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <button className="primary" type="submit">Add asset</button>
      {msg && <div className={`alert ${msg.ok ? "ok" : "error"}`} style={{ gridColumn: "1 / -1" }}>{msg.text}</div>}
    </form>
  );
}
