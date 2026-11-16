"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, describeError } from "../../../_ui/api";

export function SyncButtons() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(action: "run" | "repair") {
    setBusy(action); setMsg(null);
    try {
      const r = await api<{ run: { claimed: number; done: number; failed: number }; repaired: { queued: number; deleted_points: number } | null }>("/api/sync", { method: "POST", body: { action } });
      setMsg({ ok: r.run.failed === 0, text: `Processed ${r.run.claimed} job(s): ${r.run.done} done, ${r.run.failed} failed.${r.repaired ? ` Repair queued ${r.repaired.queued}, deleted ${r.repaired.deleted_points} point(s).` : ""}` });
      router.refresh();
    } catch (e) { setMsg({ ok: false, text: describeError(e) }); } finally { setBusy(null); }
  }
  return (
    <div className="stack" style={{ alignItems: "flex-end" }}>
      <div className="row">
        <button type="button" disabled={busy !== null} onClick={() => run("run")}>{busy === "run" ? "Processing…" : "Process queue now"}</button>
        <button type="button" className="primary" disabled={busy !== null} onClick={() => run("repair")}>{busy === "repair" ? "Repairing…" : "Reconcile + repair"}</button>
      </div>
      {msg && <div className={`alert ${msg.ok ? "ok" : "error"}`}>{msg.text}</div>}
    </div>
  );
}
