import { requireUser } from "@/lib/auth/current-user";
import { Card } from "../../_ui/bits";
import { PasswordForm } from "./password-form";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();
  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <h1>Your account</h1>
      <Card title="Profile">
        <dl className="kv"><dt>Name</dt><dd>{user.name}</dd><dt>E-mail</dt><dd>{user.email}</dd><dt>Role</dt><dd>{user.role}</dd></dl>
      </Card>
      <Card title="Change password">
        <p className="muted small">At least 12 characters. All your sessions end; you stay signed in here with a fresh one.</p>
        <PasswordForm />
      </Card>
    </div>
  );
}
