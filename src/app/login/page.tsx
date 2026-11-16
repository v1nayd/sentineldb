import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/current-user";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await currentUser()) redirect("/incidents");
  return (
    <div className="login-wrap">
      <div className="card login-card stack">
        <div>
          <div className="brand" style={{ marginBottom: 6 }}><span className="brand-mark" /> SentinelDB</div>
          <p className="muted small" style={{ margin: 0 }}>Incident intelligence · synthetic data only</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
