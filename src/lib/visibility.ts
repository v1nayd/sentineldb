import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { SessionUser } from "./auth/session";
import { notFound } from "./http";

/**
 * Incident visibility: THE single place the access policy lives (docs/DECISIONS.md ADR-1).
 *
 * Policy in force: Option A (strict, the Phase 1 spec section 10).
 *   - admin:   every incident;
 *   - analyst: only incidents they reported or are assigned to.
 * Everything that reads or changes an incident on behalf of a user filters with incidentScope(); an incident outside
 * the scope answers 404, exactly like one that does not exist, so ids cannot be probed (IDOR). Switching to option B/C
 * later is a change here, and tests/api-access.test.ts states the expected behaviour.
 *
 * The scope is a CLOSED set of SQL fragments (no caller input is ever concatenated): only the table alias varies, and
 * it is checked against a fixed pattern.
 */
export function incidentScope(user: SessionUser, alias = "i"): { sql: string; params: number[] } {
  if (!/^[a-z]{1,3}$/.test(alias)) throw new Error("incidentScope: bad alias");
  if (user.role === "admin") return { sql: "1=1", params: [] };
  return { sql: `(${alias}.reported_by = ? OR ${alias}.assigned_to = ?)`, params: [user.id, user.id] };
}

export interface IncidentHead { incident_id: number; status: string; reported_by: number; assigned_to: number | null; archived_at: Date | null }

/** Loads the incident if the user may see it; otherwise throws 404 (never 403: existence is not revealed). */
export async function visibleIncident(conn: Pool | PoolConnection, user: SessionUser, id: number): Promise<IncidentHead> {
  const scope = incidentScope(user);
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT i.incident_id, i.status, i.reported_by, i.assigned_to, i.archived_at FROM Incidents i WHERE i.incident_id = ? AND ${scope.sql}`,
    [id, ...scope.params]);
  if (!rows[0]) throw notFound();
  return rows[0] as IncidentHead;
}
