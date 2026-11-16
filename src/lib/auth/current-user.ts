import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { appPool } from "../db";
import { resolveSession, sessionCookieName, type SessionUser } from "./session";

/**
 * The signed-in user for SERVER-RENDERED PAGES (the API uses api() in src/lib/http.ts). Same session rules: the cookie
 * token is resolved against MySQL (expired, idle, revoked and deactivated sessions give null).
 */
export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return null;
  const req = new Request("http://internal.invalid/", { headers: { cookie: `${sessionCookieName()}=${token}` } });
  return (await resolveSession(appPool(), req))?.user ?? null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Admin-only pages answer 404 to analysts, like the incidents they may not see (no hint that the page exists). */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") notFound();
  return user;
}
