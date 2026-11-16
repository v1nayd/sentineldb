import { requireAdmin } from "@/lib/auth/current-user";
import { listUsers } from "@/lib/repo/admin";
import { Card } from "../../../_ui/bits";
import { CreateUserForm, UserRow } from "./forms";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const me = await requireAdmin();
  const users = await listUsers();
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="muted" style={{ margin: 0 }}>Accounts change only through database procedures; the last active admin cannot be demoted or deactivated (rule SDB40). Users are never deleted.</p>
        </div>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Name</th><th>E-mail</th><th>Role</th><th>Status</th><th>Reset password</th></tr></thead>
          <tbody>
            {users.map((u) => <UserRow key={u.user_id} me={me.id} u={{ user_id: Number(u.user_id), name: String(u.name), email: String(u.email), role: String(u.role), is_active: Boolean(u.is_active) }} />)}
          </tbody>
        </table>
      </div>
      <Card title="Create user"><CreateUserForm /></Card>
    </div>
  );
}
