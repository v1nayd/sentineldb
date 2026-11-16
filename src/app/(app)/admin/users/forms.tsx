"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, describeError } from "../../../_ui/api";

interface U { user_id: number; name: string; email: string; role: string; is_active: boolean }

export function UserRow({ u, me }: { u: U; me: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); router.refresh(); } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  }
  return (
    <tr>
      <td>{u.name}{u.user_id === me && <span className="muted small"> (you)</span>}{error && <div className="alert error small" style={{ marginTop: 6 }}>{error}</div>}</td>
      <td className="small">{u.email}</td>
      <td>
        <select aria-label={`Role of ${u.name}`} value={u.role} disabled={busy} onChange={(e) => run(() => api(`/api/users/${u.user_id}`, { method: "PATCH", body: { role: e.target.value } }))}>
          <option value="analyst">analyst</option><option value="admin">admin</option>
        </select>
      </td>
      <td>
        <button type="button" disabled={busy} className={u.is_active ? "danger" : undefined} onClick={() => run(() => api(`/api/users/${u.user_id}`, { method: "PATCH", body: { active: !u.is_active } }))}>
          {u.is_active ? "Deactivate" : "Reactivate"}
        </button>
        {!u.is_active && <div className="small muted">deactivated</div>}
      </td>
      <td>
        <form className="row" onSubmit={(e) => { e.preventDefault(); run(() => api(`/api/users/${u.user_id}/password`, { method: "POST", body: { password: pw } }).then(() => setPw(""))); }}>
          <input type="password" aria-label={`New password for ${u.name}`} autoComplete="new-password" minLength={12} maxLength={128} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="≥ 12 characters" style={{ width: 150 }} />
          <button type="submit" disabled={busy || pw.length < 12}>Set</button>
        </form>
      </td>
    </tr>
  );
}

export function CreateUserForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", email: "", password: "", role: "analyst" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form className="form-grid" onSubmit={async (e) => {
      e.preventDefault(); setMsg(null);
      try { await api("/api/users", { method: "POST", body: f }); setMsg({ ok: true, text: `Created ${f.email}.` }); setF({ name: "", email: "", password: "", role: "analyst" }); router.refresh(); }
      catch (err) { setMsg({ ok: false, text: describeError(err) }); }
    }}>
      <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} /></label>
      <label>E-mail<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required maxLength={150} /></label>
      <label>Initial password<input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={12} maxLength={128} /></label>
      <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option>analyst</option><option>admin</option></select></label>
      <button className="primary" type="submit">Create</button>
      {msg && <div className={`alert ${msg.ok ? "ok" : "error"}`} style={{ gridColumn: "1 / -1" }}>{msg.text}</div>}
    </form>
  );
}
