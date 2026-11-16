import { requireAdmin } from "@/lib/auth/current-user";
import { listAssets } from "@/lib/repo/admin";
import { Card, When } from "../../../_ui/bits";
import { AssetForm, CriticalityEditor } from "./forms";

export const metadata = { title: "Assets" };

export default async function AssetsPage() {
  await requireAdmin();
  const assets = await listAssets();
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Assets</h1><p className="muted" style={{ margin: 0 }}>{assets.length} assets. The asset type is fixed once created.</p></div></div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>IP</th><th>Department</th><th>Criticality (1–5)</th><th>Last audited</th></tr></thead>
          <tbody>{assets.map((a) => (
            <tr key={a.asset_id}>
              <td>{a.asset_name}</td><td>{a.asset_type}</td><td className="mono">{a.ip_address ?? "—"}</td><td>{a.owner_department ?? "—"}</td>
              <td><CriticalityEditor id={Number(a.asset_id)} value={Number(a.criticality_level)} /></td>
              <td className="small"><When at={a.last_audited_at} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Card title="Add asset"><AssetForm /></Card>
    </div>
  );
}
