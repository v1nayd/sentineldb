import { isIP } from "node:net";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { withActor } from "../actor";
import type { SessionUser } from "../auth/session";
import { appPool } from "../db";
import { HttpError, notFound } from "../http";
import { INCIDENT_STATUSES, archiveIncident, closeIncident, reassignIncident, reviewIncidentIoc, transitionIncident } from "../lifecycle";
import { incidentScope, visibleIncident } from "../visibility";

/**
 * Incident use cases for the API. Reads use the pool; every write goes through withActor() (ADR-7), so the database
 * triggers know who acts. Every operation first resolves the incident through visibleIncident() (404 outside the
 * user's scope); the database then enforces the lifecycle rules (roles, assignee, closure, frozen states).
 */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const text = (max: number) => z.string().trim().min(1).max(max);

export const createIncidentSchema = z.object({ title: text(200), narrative: text(10_000), severity: z.enum(SEVERITIES) }).strict();
export const updateIncidentSchema = z.object({ title: text(200).optional(), narrative: text(10_000).optional(), severity: z.enum(SEVERITIES).optional() })
  .strict().refine((p) => Object.keys(p).length > 0, "nothing to update");
export const transitionSchema = z.object({ to: z.enum(INCIDENT_STATUSES).exclude(["closed"]), reason: text(500).optional() }).strict();
export const reasonSchema = z.object({ reason: text(500).optional() }).strict();
export const requiredReasonSchema = z.object({ reason: text(500) }).strict();
export const reassignSchema = z.object({ assignee: z.number().int().positive(), reason: text(500) }).strict();
export const noteSchema = z.object({ content: text(5_000) }).strict();
export const assetLinkSchema = z.object({ asset_id: z.number().int().positive(), impact_description: text(2_000).optional() }).strict();
export const assetImpactSchema = z.object({ impact_description: text(2_000) }).strict();
export const reviewSchema = z.object({ review_status: z.enum(["pending", "confirmed", "dismissed"]) }).strict();

// IOC values are validated and normalised per type before they reach the database.
const HEX = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const EMAIL = /^[^\s@]{1,64}@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const iocLinkSchema = z.object({
  ioc_type: z.enum(["ip", "domain", "file_hash", "email", "url"]),
  ioc_value: z.string().trim().min(1).max(255),
  threat_level: z.enum(SEVERITIES).optional(),
  notes: text(2_000).optional(),
}).strict().transform((v, ctx) => {
  const value = v.ioc_type === "url" || v.ioc_type === "ip" ? v.ioc_value : v.ioc_value.toLowerCase();
  const ok = v.ioc_type === "ip" ? isIP(value) !== 0
    : v.ioc_type === "file_hash" ? HEX.test(value)
    : v.ioc_type === "domain" ? DOMAIN.test(value)
    : v.ioc_type === "email" ? EMAIL.test(value)
    : (() => { try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } })();
  if (!ok) ctx.addIssue({ code: "custom", path: ["ioc_value"], message: `not a valid ${v.ioc_type}` });
  return { ...v, ioc_value: value };
});

export const listSchema = z.object({
  status: z.enum(INCIDENT_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  assigned: z.enum(["me", "unassigned"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Active (non-archived) incidents the user may see, newest activity first, with total for paging. */
export async function listIncidents(user: SessionUser, f: z.infer<typeof listSchema>) {
  const scope = incidentScope(user);
  const where = [scope.sql];
  const params: unknown[] = [...scope.params];
  if (f.status) { where.push("i.status = ?"); params.push(f.status); }
  if (f.severity) { where.push("i.severity = ?"); params.push(f.severity); }
  if (f.assigned === "me") { where.push("i.assigned_to = ?"); params.push(user.id); }
  if (f.assigned === "unassigned") where.push("i.assigned_to IS NULL");
  if (f.q) { // keyword filter only (LIKE); semantic search is Milestone 4
    where.push("(i.title LIKE ? OR EXISTS (SELECT 1 FROM Incidents x WHERE x.incident_id = i.incident_id AND x.narrative LIKE ?))");
    params.push(`%${likeEscape(f.q)}%`, `%${likeEscape(f.q)}%`);
  }
  const sqlWhere = where.join(" AND ");
  const pool = appPool();
  const [counted] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM incident_summary_view i WHERE ${sqlWhere}`, params);
  const total = counted[0]!;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT i.incident_id, i.title, i.severity, i.status, i.reported_by, i.reporter_name, i.assigned_to, i.assignee_name,
            i.created_at, i.updated_at, i.resolved_at, i.ioc_count, i.pending_ioc_count, i.asset_count, i.note_count
       FROM incident_summary_view i WHERE ${sqlWhere}
      ORDER BY i.updated_at DESC, i.incident_id DESC LIMIT ? OFFSET ?`,
    [...params, f.page_size, (f.page - 1) * f.page_size]);
  return { total: Number(total.n), page: f.page, page_size: f.page_size, incidents: rows };
}

/** Everything a detail page needs, or 404 if the user may not see the incident. */
export async function getIncident(user: SessionUser, id: number) {
  const pool = appPool();
  const head = await visibleIncident(pool, user, id);
  const q = async (sql: string) => (await pool.query<RowDataPacket[]>(sql, [id]))[0];
  const [incident] = await q(
    `SELECT i.incident_id, i.title, i.narrative, i.severity, i.status, i.reported_by, r.name AS reporter_name,
            i.assigned_to, a.name AS assignee_name, i.created_at, i.updated_at, i.resolved_at, i.narrative_version,
            i.archived_at, i.archive_reason
       FROM Incidents i JOIN Users r ON r.user_id = i.reported_by LEFT JOIN Users a ON a.user_id = i.assigned_to
      WHERE i.incident_id = ?`);
  const [iocs, assets, notes, statusHistory, assignmentHistory, evidenceHistory, transitions] = await Promise.all([
    q(`SELECT l.ioc_id, c.ioc_type, c.ioc_value, c.threat_level, l.notes, l.review_status, l.reviewed_by, u.name AS reviewer_name, l.reviewed_at
         FROM Incident_IOC l JOIN IOCs c ON c.ioc_id = l.ioc_id LEFT JOIN Users u ON u.user_id = l.reviewed_by
        WHERE l.incident_id = ? ORDER BY l.ioc_id`),
    q(`SELECT ia.asset_id, s.asset_name, s.asset_type, s.criticality_level, ia.impact_description
         FROM Incident_Asset ia JOIN Assets s ON s.asset_id = ia.asset_id WHERE ia.incident_id = ? ORDER BY ia.asset_id`),
    q(`SELECT n.note_id, n.author_id, u.name AS author_name, n.content, n.created_at
         FROM Notes n JOIN Users u ON u.user_id = n.author_id WHERE n.incident_id = ? ORDER BY n.created_at, n.note_id`),
    q(`SELECT old_status, new_status, changed_by, actor_name_snapshot, reason, changed_at FROM Incident_Status_History WHERE incident_id = ? ORDER BY history_id`),
    q(`SELECT h.old_assignee, ou.name AS old_assignee_name, h.new_assignee, nu.name AS new_assignee_name, h.changed_by, h.actor_name_snapshot, h.reason, h.changed_at
         FROM Incident_Assignment_History h LEFT JOIN Users ou ON ou.user_id = h.old_assignee LEFT JOIN Users nu ON nu.user_id = h.new_assignee
        WHERE h.incident_id = ? ORDER BY h.assignment_event_id`),
    q(`SELECT h.ioc_id, c.ioc_type, c.ioc_value, h.asset_id, s.asset_name, h.action, h.detail, h.changed_by, h.actor_name_snapshot, h.changed_at
         FROM Incident_Evidence_History h LEFT JOIN IOCs c ON c.ioc_id = h.ioc_id LEFT JOIN Assets s ON s.asset_id = h.asset_id
        WHERE h.incident_id = ? ORDER BY h.evidence_event_id`),
    pool.query<RowDataPacket[]>("SELECT to_status, requires_role, requires_reason, description FROM Status_Transitions WHERE from_status = ? ORDER BY to_status", [head.status]).then((r) => r[0]),
  ]);
  // What THIS user may do next (the database enforces it either way; this only tells a UI which actions to offer).
  const mayWork = user.role === "admin" || head.assigned_to === user.id;
  const allowed = head.archived_at !== null ? [] : transitions
    .filter((t) => (t.requires_role === "admin" ? user.role === "admin" : mayWork) && (t.to_status === "closed" || head.assigned_to !== null))
    .map((t) => ({ to: String(t.to_status), requires_reason: Boolean(t.requires_reason), description: String(t.description), via: (t.to_status === "closed" ? "close" : "transition") as "close" | "transition" }));
  return { incident, iocs, assets, notes, status_history: statusHistory, assignment_history: assignmentHistory, evidence_history: evidenceHistory, allowed_transitions: allowed };
}

export async function createIncident(user: SessionUser, input: z.infer<typeof createIncidentSchema>): Promise<number> {
  return withActor(user.id, async (c) => {
    const [r] = await c.query("INSERT INTO Incidents (title, narrative, severity, reported_by) VALUES (?, ?, ?, ?)",
      [input.title, input.narrative, input.severity, user.id]); // the reporter is always the signed-in user
    return (r as { insertId: number }).insertId;
  });
}

export async function updateIncident(user: SessionUser, id: number, patch: z.infer<typeof updateIncidentSchema>): Promise<void> {
  await withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    const cols = (["title", "narrative", "severity"] as const).filter((k) => patch[k] !== undefined);
    await c.query(`UPDATE Incidents SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE incident_id = ?`, [...cols.map((k) => patch[k]), id]);
  });
}

export const transition = (user: SessionUser, id: number, to: z.infer<typeof transitionSchema>["to"], reason?: string) =>
  withActor(user.id, async (c) => { await visibleIncident(c, user, id); await transitionIncident(c, id, to, reason); });
export const close = (user: SessionUser, id: number, reason?: string) =>
  withActor(user.id, async (c) => { await visibleIncident(c, user, id); await closeIncident(c, id, reason); });
export const reassign = (user: SessionUser, id: number, assignee: number, reason: string) =>
  withActor(user.id, async (c) => { await visibleIncident(c, user, id); await reassignIncident(c, id, assignee, reason); });
export const archive = (user: SessionUser, id: number, reason: string) =>
  withActor(user.id, async (c) => { await visibleIncident(c, user, id); await archiveIncident(c, id, reason); });

export async function addNote(user: SessionUser, id: number, content: string): Promise<number> {
  return withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    const [r] = await c.query("INSERT INTO Notes (incident_id, author_id, content) VALUES (?, ?, ?)", [id, user.id, content]);
    return (r as { insertId: number }).insertId;
  });
}

/** Links an IOC, registering it first if this (type, value) is new. Returns the IOC id. */
export async function linkIoc(user: SessionUser, id: number, input: z.infer<typeof iocLinkSchema>): Promise<number> {
  return withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    const find = async () => (await c.query<RowDataPacket[]>("SELECT ioc_id FROM IOCs WHERE ioc_type = ? AND ioc_value = ?", [input.ioc_type, input.ioc_value]))[0][0]?.ioc_id as number | undefined;
    let iocId = await find();
    if (iocId === undefined) {
      try {
        const [r] = await c.query("INSERT INTO IOCs (ioc_type, ioc_value, threat_level) VALUES (?, ?, ?)", [input.ioc_type, input.ioc_value, input.threat_level ?? null]);
        iocId = (r as { insertId: number }).insertId;
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1062) throw e;
        iocId = await find(); // registered concurrently by someone else
      }
    }
    try {
      await c.query("INSERT INTO Incident_IOC (incident_id, ioc_id, notes) VALUES (?, ?, ?)", [id, iocId, input.notes ?? null]);
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) throw new HttpError(409, "conflict", "this IOC is already linked to the incident");
      throw e;
    }
    return iocId!;
  });
}

export async function reviewIoc(user: SessionUser, id: number, iocId: number, decision: z.infer<typeof reviewSchema>["review_status"]): Promise<void> {
  await withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    if (!(await reviewIncidentIoc(c, id, iocId, decision))) throw notFound("IOC link");
  });
}

export async function unlinkIoc(user: SessionUser, id: number, iocId: number): Promise<void> {
  await withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    const [r] = await c.query("DELETE FROM Incident_IOC WHERE incident_id = ? AND ioc_id = ?", [id, iocId]);
    if ((r as { affectedRows: number }).affectedRows === 0) throw notFound("IOC link");
  });
}

export async function linkAsset(user: SessionUser, id: number, input: z.infer<typeof assetLinkSchema>): Promise<void> {
  await withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    try {
      await c.query("INSERT INTO Incident_Asset (incident_id, asset_id, impact_description) VALUES (?, ?, ?)", [id, input.asset_id, input.impact_description ?? null]);
    } catch (e) {
      const errno = (e as { errno?: number }).errno;
      if (errno === 1062) throw new HttpError(409, "conflict", "this asset is already linked to the incident");
      if (errno === 1452) throw notFound("asset");
      throw e;
    }
  });
}

export async function describeAssetImpact(user: SessionUser, id: number, assetId: number, impact: string): Promise<void> {
  await withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    const [r] = await c.query("UPDATE Incident_Asset SET impact_description = ? WHERE incident_id = ? AND asset_id = ?", [impact, id, assetId]);
    if ((r as { affectedRows: number }).affectedRows === 0) throw notFound("asset link");
  });
}

export async function unlinkAsset(user: SessionUser, id: number, assetId: number): Promise<void> {
  await withActor(user.id, async (c) => {
    await visibleIncident(c, user, id);
    const [r] = await c.query("DELETE FROM Incident_Asset WHERE incident_id = ? AND asset_id = ?", [id, assetId]);
    if ((r as { affectedRows: number }).affectedRows === 0) throw notFound("asset link");
  });
}
