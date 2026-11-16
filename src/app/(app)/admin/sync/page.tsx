import type { RowDataPacket } from "mysql2/promise";
import { requireAdmin } from "@/lib/auth/current-user";
import { appPool } from "@/lib/db";
import { reconcile, type ReconcileReport } from "@/lib/reconcile";
import { syncStatus } from "@/lib/sync";
import { Card, When } from "../../../_ui/bits";
import { SyncButtons } from "./buttons";

export const metadata = { title: "Index sync" };

export default async function SyncPage() {
  await requireAdmin();
  const status = await syncStatus();
  let rep: ReconcileReport | null = null;
  let repError: string | null = null;
  try { rep = await reconcile(appPool()); } catch (e) { repError = (e as Error).message; }
  const states = ["synced", "pending", "failed", "missing", "archived"];
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Vector index sync</h1>
          <p className="muted" style={{ margin: 0 }}>MySQL is the source of truth. Every incident change queues an outbox job in the same transaction; the worker (<code>npm run sync:worker</code>) propagates it to Qdrant.</p>
        </div>
        <SyncButtons />
      </div>
      <div className="grid-cards">
        {states.map((s) => <div key={s} className="card stat"><b>{status.incidents[s] ?? 0}</b><span>incidents {s} (outbox)</span></div>)}
      </div>
      <Card title="Reconciliation (checks Qdrant itself, every id)">
        {repError && <div className="alert error">Qdrant unavailable: {repError}. Similarity search falls back to keyword search, labelled as such.</div>}
        {rep && (
          <>
            <div className={`alert ${rep.inSync ? "ok" : "warn"}`}>{rep.inSync ? "In sync: every active incident has a current vector and Qdrant holds nothing else." : "Not in sync. Run “Repair” to re-queue missing/stale vectors and delete orphans."}</div>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Indexable in MySQL</dt><dd>{rep.mysqlIndexable}</dd><dt>Points in Qdrant</dt><dd>{rep.qdrantPoints}</dd>
              <dt>OK</dt><dd>{rep.ok.length}</dd><dt>Missing</dt><dd>{rep.missing.length}</dd><dt>Stale</dt><dd>{rep.stale.length}</dd>
              <dt>Orphaned</dt><dd>{rep.orphaned.length}</dd><dt>Incompatible</dt><dd>{rep.incompatible.length}</dd>
            </dl>
          </>
        )}
      </Card>
      <div className="grid-cards">
        <Card title="Jobs">
          <table><thead><tr><th>Action</th><th>Status</th><th className="num">Count</th></tr></thead>
            <tbody>{status.jobs.map((j) => <tr key={`${j.action}-${j.status}`}><td>{j.action}</td><td>{j.status}</td><td className="num">{j.count}</td></tr>)}</tbody></table>
        </Card>
        <Card title="Recent failures">
          {(status.recent_failures as RowDataPacket[]).length === 0 ? <p className="muted">None.</p> : (
            <table><thead><tr><th>Incident</th><th>Error</th><th>When</th></tr></thead>
              <tbody>{(status.recent_failures as RowDataPacket[]).map((f) => <tr key={f.job_id}><td>#{f.incident_id} v{f.narrative_version}</td><td className="small">{f.last_error}</td><td className="small"><When at={f.finished_at} /></td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
    </div>
  );
}
