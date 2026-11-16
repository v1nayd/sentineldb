import type { ReactNode } from "react";

/** Small presentational pieces shared by server and client components (no data access here). */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const STATUSES = ["open", "investigating", "contained", "resolved", "closed"] as const;
export const IOC_TYPES = ["ip", "domain", "file_hash", "email", "url"] as const;

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge sev-${severity}`}>{severity}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge st-${status}`}>{status}</span>;
}
export function IndexBadge({ state }: { state: string }) {
  const label: Record<string, string> = { synced: "indexed", pending: "index pending", missing: "not indexed", failed: "index failed", archived: "archived" };
  return <span className={`badge ix-${state}`} title="Vector index state for this incident's current narrative">{label[state] ?? state}</span>;
}

const fmt = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export function When({ at }: { at: Date | string | null | undefined }) {
  if (!at) return <span className="muted">—</span>;
  const d = typeof at === "string" ? new Date(at) : at;
  return <time dateTime={d.toISOString()}>{fmt.format(d)} UTC</time>;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>{title && <h2 style={{ margin: 0 }}>{title}</h2>}{actions}</div>}
      {children}
    </section>
  );
}
