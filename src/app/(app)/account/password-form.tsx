"use client";

import { useState } from "react";
import { api, describeError } from "../../_ui/api";

export function PasswordForm() {
  const [f, setF] = useState({ current_password: "", new_password: "", confirm: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.new_password !== f.confirm) { setMsg({ ok: false, text: "The new passwords do not match." }); return; }
    setBusy(true); setMsg(null);
    try {
      await api("/api/auth/password", { method: "POST", body: { current_password: f.current_password, new_password: f.new_password } });
      setF({ current_password: "", new_password: "", confirm: "" });
      setMsg({ ok: true, text: "Password changed. Your other sessions have been signed out." });
    } catch (err) { setMsg({ ok: false, text: describeError(err) }); } finally { setBusy(false); }
  }
  return (
    <form className="stack" onSubmit={submit}>
      <label>Current password<input type="password" autoComplete="current-password" value={f.current_password} onChange={(e) => setF({ ...f, current_password: e.target.value })} required /></label>
      <label>New password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={f.new_password} onChange={(e) => setF({ ...f, new_password: e.target.value })} required /></label>
      <label>Repeat new password<input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></label>
      {msg && <div className={`alert ${msg.ok ? "ok" : "error"}`} role="status">{msg.text}</div>}
      <button className="primary" type="submit" disabled={busy}>Change password</button>
    </form>
  );
}
