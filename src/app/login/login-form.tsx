"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, api } from "../_ui/api";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { email: String(f.get("email")), password: String(f.get("password")) } });
      router.replace("/incidents");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? "Too many failed attempts. Try again in 15 minutes." : "Invalid e-mail or password.");
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>E-mail<input name="email" type="email" autoComplete="username" required autoFocus /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button className="primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
