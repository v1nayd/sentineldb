"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "../_ui/api";

export function NavLinks({ links }: { links: Array<{ href: string; label: string }> }) {
  const path = usePathname();
  // The most specific matching link is the current one ("/incidents/new" beats "/incidents").
  const current = links.filter((l) => path === l.href || path.startsWith(`${l.href}/`)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav className="nav" aria-label="Main">
      {links.map((l) => <Link key={l.href} href={l.href} aria-current={l.href === current ? "page" : undefined}>{l.label}</Link>)}
    </nav>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button type="button" onClick={async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); router.replace("/login"); router.refresh(); }}>
      Sign out
    </button>
  );
}
