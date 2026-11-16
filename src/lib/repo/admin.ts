import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { withActor } from "../actor";
import { hashPassword, passwordProblem } from "../auth/password";
import { normalizeEmail } from "../auth/login";
import type { SessionUser } from "../auth/session";
import { appPool } from "../db";
import { HttpError, notFound } from "../http";

/**
 * Administration use cases: user accounts, asset inventory, organisation-wide analytics. The routes allow only admins;
 * the account procedures check the actor's role again in the database (defence in depth).
 * Users are always read through SAFE_USER_COLUMNS: the runtime account cannot read password_hash at all.
 */
export const SAFE_USER_COLUMNS = "user_id, name, email, role, is_active, deactivated_at, password_changed_at, created_at";

const password = z.string().superRefine((p, ctx) => { const m = passwordProblem(p); if (m) ctx.addIssue({ code: "custom", message: m }); });
export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(150).email().transform(normalizeEmail),
  password,
  role: z.enum(["analyst", "admin"]),
}).strict();
export const updateUserSchema = z.object({ role: z.enum(["analyst", "admin"]).optional(), active: z.boolean().optional() })
  .strict().refine((p) => p.role !== undefined || p.active !== undefined, "nothing to update");
export const resetPasswordSchema = z.object({ password }).strict();
export const changeOwnPasswordSchema = z.object({ current_password: z.string().min(1).max(128), new_password: password }).strict();

export async function listUsers() {
  return (await appPool().query<RowDataPacket[]>(`SELECT ${SAFE_USER_COLUMNS} FROM Users ORDER BY role, name`))[0];
}
export async function getUser(id: number) {
  const [rows] = await appPool().query<RowDataPacket[]>(`SELECT ${SAFE_USER_COLUMNS} FROM Users WHERE user_id = ?`, [id]);
  if (!rows[0]) throw notFound("user");
  return rows[0];
}

export async function createUser(admin: SessionUser, input: z.infer<typeof createUserSchema>): Promise<number> {
  const hash = await hashPassword(input.password);
  return withActor(admin.id, async (c) => {
    try {
      const [res] = await c.query<RowDataPacket[][]>("CALL create_user(?, ?, ?, ?)", [input.name, input.email, hash, input.role]);
      return Number(res[0]![0]!.user_id);
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) throw new HttpError(409, "conflict", "an account with this e-mail already exists");
      throw e;
    }
  });
}

export async function updateUser(admin: SessionUser, id: number, patch: z.infer<typeof updateUserSchema>): Promise<void> {
  await withActor(admin.id, async (c) => {
    if (patch.role !== undefined) await c.query("CALL set_user_role(?, ?)", [id, patch.role]);
    if (patch.active !== undefined) await c.query("CALL set_user_active(?, ?)", [id, patch.active]);
  });
}

export async function resetPassword(admin: SessionUser, id: number, newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword);
  await withActor(admin.id, (c) => c.query("CALL set_password_hash(?, ?)", [id, hash]));
}

export async function accountHistory(id: number) {
  return (await appPool().query<RowDataPacket[]>(
    "SELECT action, detail, changed_by, actor_name_snapshot, source, changed_at FROM User_Account_History WHERE user_id = ? ORDER BY account_event_id", [id]))[0];
}

// ---------------------------------------------------------------- assets (inventory: read by everyone, managed by admins)
const ASSET_TYPES = ["server", "workstation", "network_device", "application"] as const;
const ipOrNull = z.string().trim().max(45).nullable().optional();
export const createAssetSchema = z.object({
  asset_name: z.string().trim().min(1).max(150), asset_type: z.enum(ASSET_TYPES), ip_address: ipOrNull,
  criticality_level: z.number().int().min(1).max(5), owner_department: z.string().trim().max(100).nullable().optional(),
}).strict();
export const updateAssetSchema = z.object({
  asset_name: z.string().trim().min(1).max(150).optional(), ip_address: ipOrNull,
  criticality_level: z.number().int().min(1).max(5).optional(), owner_department: z.string().trim().max(100).nullable().optional(),
}).strict().refine((p) => Object.keys(p).length > 0, "nothing to update");

export async function listAssets() {
  return (await appPool().query<RowDataPacket[]>(
    "SELECT asset_id, asset_name, asset_type, ip_address, criticality_level, owner_department, last_audited_at FROM Assets ORDER BY asset_name"))[0];
}
export async function createAsset(admin: SessionUser, a: z.infer<typeof createAssetSchema>): Promise<number> {
  return withActor(admin.id, async (c) => {
    const [r] = await c.query("INSERT INTO Assets (asset_name, asset_type, ip_address, criticality_level, owner_department) VALUES (?, ?, ?, ?, ?)",
      [a.asset_name, a.asset_type, a.ip_address ?? null, a.criticality_level, a.owner_department ?? null]);
    return (r as { insertId: number }).insertId;
  });
}
export async function updateAsset(admin: SessionUser, id: number, patch: z.infer<typeof updateAssetSchema>): Promise<void> {
  await withActor(admin.id, async (c) => {
    const cols = (["asset_name", "ip_address", "criticality_level", "owner_department"] as const).filter((k) => patch[k] !== undefined);
    const [r] = await c.query(`UPDATE Assets SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE asset_id = ?`, [...cols.map((k) => patch[k] ?? null), id]);
    if ((r as { affectedRows: number }).affectedRows === 0) throw notFound("asset");
  });
}

// ---------------------------------------------------------------- analytics (organisation-wide: admins only, spec section 10)
export async function analyticsOverview() {
  const q = async (sql: string) => (await appPool().query<RowDataPacket[]>(sql))[0];
  const [matrix, workload, mttr, trend, recurring] = await Promise.all([
    q("SELECT severity, open_count, investigating_count, contained_count, resolved_count, closed_count, total_count FROM severity_status_matrix_view ORDER BY severity_rank DESC"),
    q("SELECT user_id, name, role, active_incidents, active_high_or_critical, resolved_incidents, avg_hours_to_resolve FROM workload_by_assignee_view ORDER BY active_incidents DESC, name"),
    q("SELECT severity, resolved_incidents, mean_hours_to_first_resolution, min_hours, max_hours FROM mttr_by_severity_view ORDER BY FIELD(severity, 'critical', 'high', 'medium', 'low')"),
    q("SELECT month, created, critical, high, medium, low, resolved_or_closed FROM monthly_trend_view ORDER BY month"),
    q("SELECT ioc_id, ioc_type, ioc_value, threat_level, incident_count, last_incident_at FROM recurring_ioc_view ORDER BY incident_count DESC, last_incident_at DESC LIMIT 10"),
  ]);
  return { severity_status: matrix, workload, mttr, monthly_trend: trend, recurring_iocs: recurring };
}
