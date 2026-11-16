import type { ReactNode } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { LogoutButton, NavLinks } from "./nav";

export const dynamic = "force-dynamic";

/** Every page in this group requires a signed-in user; admin links are only shown to admins (and admin pages 404 for others). */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const links = [
    { href: "/incidents", label: "Incidents" },
    { href: "/incidents/new", label: "Report" },
    { href: "/search", label: "Similar search" },
    ...(user.role === "admin" ? [
      { href: "/analytics", label: "Analytics" },
      { href: "/admin/users", label: "Users" },
      { href: "/admin/assets", label: "Assets" },
      { href: "/admin/sync", label: "Index sync" },
    ] : []),
  ];
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/incidents" className="brand"><span className="brand-mark" /> SentinelDB</Link>
          <NavLinks links={links} />
          <div className="who">
            <Link href="/account">{user.name}</Link>
            <span className="badge">{user.role}</span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
