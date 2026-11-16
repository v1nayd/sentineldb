import type { PoolConnection } from "mysql2/promise";

/**
 * Typed front door to the lifecycle procedures (migration 0009). Call these inside withActor() (src/lib/actor.ts):
 * the procedures join that transaction under a savepoint, so a route handler can combine several steps atomically.
 *
 * Rules live in the database (triggers + procedures); this module only maps their stable error codes to a typed
 * error so the API layer (M3) can turn them into HTTP status codes without parsing strings everywhere.
 */

export const INCIDENT_STATUSES = ["open", "investigating", "contained", "resolved", "closed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** SDBnn codes raised by migrations 0006-0009. `kind` groups them the way an API would answer. */
export const LIFECYCLE_CODES = {
  SDB01: { kind: "no_actor", summary: "no acting user in the session" },
  SDB02: { kind: "no_actor", summary: "acting user is invalid or unknown" },
  SDB03: { kind: "invalid", summary: "import clock is not a valid DATETIME" },
  SDB10: { kind: "invalid_transition", summary: "transition not allowed (or a required reason is missing)" },
  SDB11: { kind: "forbidden", summary: "actor's role or assignment does not allow this" },
  SDB12: { kind: "closure_blocked", summary: "closure rule not met" },
  SDB13: { kind: "conflict", summary: "incident is closed" },
  SDB14: { kind: "conflict", summary: "incident is archived / archive rule" },
  SDB15: { kind: "invalid_transition", summary: "incident must be assigned first" },
  SDB16: { kind: "invalid", summary: "immutable column" },
  SDB17: { kind: "invalid", summary: "column is maintained by the database" },
  SDB18: { kind: "invalid", summary: "import clock moved backwards" },
  SDB19: { kind: "forbidden", summary: "incidents are never deleted" },
  SDB20: { kind: "forbidden", summary: "append-only / immutable audit data" },
  SDB21: { kind: "forbidden", summary: "note author must be the acting user" },
  SDB30: { kind: "invalid", summary: "invalid reassignment" },
  SDB31: { kind: "not_found", summary: "incident not found" },
  SDB40: { kind: "conflict", summary: "the last active admin cannot be demoted or deactivated" },
  SDB41: { kind: "forbidden", summary: "users are deactivated, never deleted" },
  SDB42: { kind: "invalid", summary: "cannot assign to a deactivated user" },
  SDB43: { kind: "invalid", summary: "not a recognised password hash" },
  SDB44: { kind: "not_found", summary: "user not found" },
} as const;
export type LifecycleCode = keyof typeof LIFECYCLE_CODES;
export type LifecycleErrorKind = (typeof LIFECYCLE_CODES)[LifecycleCode]["kind"];

export class LifecycleError extends Error {
  constructor(readonly code: LifecycleCode, readonly kind: LifecycleErrorKind, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LifecycleError";
  }
}

const ER_SIGNAL_EXCEPTION = 1644; // errno MySQL uses for SIGNAL SQLSTATE '45000'

/** Converts a mysql2 error raised by our SIGNALs into a LifecycleError; anything else is returned unchanged. */
export function toLifecycleError(e: unknown): unknown {
  const err = e as { errno?: number; sqlMessage?: string };
  if (err?.errno !== ER_SIGNAL_EXCEPTION || typeof err.sqlMessage !== "string") return e;
  const m = /^(SDB\d{2}): (.*)$/s.exec(err.sqlMessage);
  if (!m || !(m[1]! in LIFECYCLE_CODES)) return e;
  const code = m[1] as LifecycleCode;
  return new LifecycleError(code, LIFECYCLE_CODES[code].kind, m[2]!, e);
}

async function call(conn: PoolConnection, sql: string, params: unknown[]): Promise<void> {
  try {
    await conn.query(sql, params);
  } catch (e) {
    throw toLifecycleError(e);
  }
}

export function transitionIncident(conn: PoolConnection, incidentId: number, to: Exclude<IncidentStatus, "closed">, reason?: string) {
  return call(conn, "CALL transition_incident(?, ?, ?)", [incidentId, to, reason ?? null]);
}

export function closeIncident(conn: PoolConnection, incidentId: number, reason?: string) {
  return call(conn, "CALL close_incident(?, ?)", [incidentId, reason ?? null]);
}

export function reassignIncident(conn: PoolConnection, incidentId: number, newAssignee: number, reason: string) {
  return call(conn, "CALL reassign_incident(?, ?, ?)", [incidentId, newAssignee, reason]);
}

export function archiveIncident(conn: PoolConnection, incidentId: number, reason: string) {
  return call(conn, "CALL archive_incident(?, ?)", [incidentId, reason]);
}

export type IocReview = "pending" | "confirmed" | "dismissed";

/** Records an IOC review decision; the trigger stamps reviewed_by / reviewed_at from the actor and the DB clock. */
export async function reviewIncidentIoc(conn: PoolConnection, incidentId: number, iocId: number, decision: IocReview): Promise<boolean> {
  try {
    const [r] = await conn.query("UPDATE Incident_IOC SET review_status = ? WHERE incident_id = ? AND ioc_id = ?", [decision, incidentId, iocId]);
    return (r as { affectedRows: number }).affectedRows === 1;
  } catch (e) {
    throw toLifecycleError(e);
  }
}
