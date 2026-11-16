import { createHash, randomBytes } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { appPool, placeholders } from "./db";
import { EMBEDDING_MODEL_NAME, embedText } from "./embedding";
import { deletePoints, ensureCollection, pointPayload, upsertIncidentVector } from "./qdrant";
import { reconcile, type ReconcileReport } from "./reconcile";

/**
 * Outbox worker: propagates MySQL changes to Qdrant (migration 0015, docs/DECISIONS.md ADR-5).
 *
 * One run:
 *   1. CLAIM (one short transaction): pending jobs whose backoff has elapsed, oldest first, FOR UPDATE SKIP LOCKED so
 *      several workers never take the same job. At most one job per incident is claimed (older ones of the same
 *      incident in the batch are superseded) and an incident that already has a running job is skipped. Jobs left
 *      'running' by a crashed worker for more than LOCK_TIMEOUT go back to pending first.
 *   2. PROCESS each job outside any transaction (embedding takes ~100 ms; no lock is held meanwhile):
 *        upsert: re-read the incident; skip (superseded) if it is archived or already at a newer version; refuse to
 *                overwrite a point that carries a NEWER narrative_version; embed + upsert; then re-read the version:
 *                if it moved on while we embedded, mark superseded and re-queue the current version if it was
 *                already marked done (our write may have overwritten its newer vector).
 *        delete: remove the point.
 *   3. FINISH: done / superseded, or on error back to pending with exponential backoff, 'failed' after MAX_ATTEMPTS.
 *      Every state change is fenced on (status = 'running' AND locked_by = this worker).
 * There is no cross-system atomicity; reconcile() (+ repair()) is the backstop for whatever slips through.
 */
export const SYNC = { batch: 25, maxAttempts: 5, lockTimeoutMinutes: 10, backoffBaseSeconds: 5, backoffMaxSeconds: 600 } as const;

export interface SyncReport { claimed: number; done: number; superseded: number; retried: number; failed: number; requeued: number }
interface Job { job_id: number; incident_id: number; narrative_version: number; action: "upsert" | "delete"; attempts: number }

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const newWorkerId = () => `worker-${process.pid}-${randomBytes(3).toString("hex")}`;

// Two workers claiming at the same moment can deadlock in InnoDB (each claim moves rows into the status = 'running'
// range of idx_jobs_claim that the other has gap-locked). MySQL then rolls one back with errno 1213; the statement holds
// no external side effects, so it is simply retried (found by the parallel-workers test). This applies to BOTH statements
// of a claim: the stale-lock recovery below scans the same 'running' range and deadlocked the same way (seen in the
// parallel-workers test on a Docker MySQL: "Deadlock found when trying to get lock" from the recovery UPDATE).
async function retryOnDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { errno?: number }).errno !== 1213 || attempt >= 5) throw e;
      await new Promise((res) => setTimeout(res, 20 * attempt + Math.floor(Math.random() * 30)));
    }
  }
}

async function claim(pool: Pool, workerId: string, batch: number): Promise<Job[]> {
  // Stale-lock recovery runs on its own (autocommit), not inside the claim transaction: it scans the 'running' range.
  await retryOnDeadlock(() => pool.query(
    `UPDATE Embedding_Jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, last_error = 'lock expired (worker died?)'
      WHERE status = 'running' AND locked_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE`, [SYNC.lockTimeoutMinutes]));
  return retryOnDeadlock(() => claimOnce(pool, workerId, batch));
}

async function claimOnce(pool: Pool, workerId: string, batch: number): Promise<Job[]> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT job_id, incident_id, narrative_version, action, attempts FROM Embedding_Jobs
        WHERE status = 'pending' AND available_at <= UTC_TIMESTAMP()
        ORDER BY job_id LIMIT ? FOR UPDATE SKIP LOCKED`, [batch]);
    let jobs = rows as Job[];
    if (jobs.length > 0) {
      const ids = [...new Set(jobs.map((j) => j.incident_id))];
      const [busy] = await conn.query<RowDataPacket[]>(
        `SELECT DISTINCT incident_id FROM Embedding_Jobs WHERE status = 'running' AND incident_id IN (${placeholders(ids.length)})`, ids);
      const busyIds = new Set(busy.map((b) => Number(b.incident_id)));
      jobs = jobs.filter((j) => !busyIds.has(j.incident_id));
      // One job per incident: the latest one (a delete beats an upsert of the same version).
      const latest = new Map<number, Job>();
      for (const j of jobs) {
        const cur = latest.get(j.incident_id);
        if (!cur || j.narrative_version > cur.narrative_version || (j.narrative_version === cur.narrative_version && j.action === "delete")) latest.set(j.incident_id, j);
      }
      const keep = new Set([...latest.values()].map((j) => j.job_id));
      const drop = jobs.filter((j) => !keep.has(j.job_id)).map((j) => j.job_id);
      if (drop.length > 0) {
        await conn.query(`UPDATE Embedding_Jobs SET status = 'superseded', finished_at = UTC_TIMESTAMP(), last_error = 'newer job for the same incident'
                           WHERE job_id IN (${placeholders(drop.length)})`, drop);
      }
      jobs = jobs.filter((j) => keep.has(j.job_id));
      if (jobs.length > 0) {
        // Fenced on status = 'pending' and re-read by locked_by: even without the locking read above (or under a
        // weaker isolation level) a job another worker already took is not taken again. The locking read is what
        // keeps workers from blocking on, and wasting claims on, each other's rows.
        await conn.query(`UPDATE Embedding_Jobs SET status = 'running', locked_at = UTC_TIMESTAMP(), locked_by = ?, attempts = attempts + 1
                           WHERE job_id IN (${placeholders(jobs.length)}) AND status = 'pending'`, [workerId, ...jobs.map((j) => j.job_id)]);
        const [mine] = await conn.query<RowDataPacket[]>(
          `SELECT job_id FROM Embedding_Jobs WHERE job_id IN (${placeholders(jobs.length)}) AND status = 'running' AND locked_by = ?`,
          [...jobs.map((j) => j.job_id), workerId]);
        const got = new Set(mine.map((m) => Number(m.job_id)));
        jobs = jobs.filter((j) => got.has(j.job_id));
      }
    }
    await conn.commit();
    return jobs;
  } catch (e) {
    await conn.rollback().catch(() => undefined);
    throw e;
  } finally {
    conn.release();
  }
}

// Job-state updates lock the job's primary-key row first and then its idx_jobs_claim entry; a worker's claim scan
// (SELECT ... FOR UPDATE SKIP LOCKED over that index) takes the same locks in the opposite order, so InnoDB can pick
// either as a deadlock victim (errno 1213). Without a retry, a finished job was reported as failed and requeued
// ("Deadlock found..." in last_error). The updates are fenced on status = 'running' AND locked_by, so a retry is safe.
const updateJob = (pool: Pool, sql: string, params: unknown[]) => retryOnDeadlock(() => pool.query(sql, params));

async function finish(pool: Pool, job: Job, workerId: string, status: "done" | "superseded", note: string | null = null): Promise<void> {
  await updateJob(pool,
    `UPDATE Embedding_Jobs SET status = ?, locked_at = NULL, locked_by = NULL, finished_at = UTC_TIMESTAMP(), last_error = ?
      WHERE job_id = ? AND status = 'running' AND locked_by = ?`, [status, note, job.job_id, workerId]);
}

async function fail(pool: Pool, job: Job, workerId: string, err: unknown): Promise<"retried" | "failed"> {
  const message = String((err as Error)?.message ?? err).slice(0, 500);
  const attempts = job.attempts + 1;
  if (attempts >= SYNC.maxAttempts) {
    await updateJob(pool, `UPDATE Embedding_Jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, finished_at = UTC_TIMESTAMP(), last_error = ?
                       WHERE job_id = ? AND status = 'running' AND locked_by = ?`, [message, job.job_id, workerId]);
    return "failed";
  }
  const delay = Math.min(SYNC.backoffMaxSeconds, SYNC.backoffBaseSeconds * 2 ** (attempts - 1));
  await updateJob(pool, `UPDATE Embedding_Jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, last_error = ?, available_at = UTC_TIMESTAMP() + INTERVAL ? SECOND
                     WHERE job_id = ? AND status = 'running' AND locked_by = ?`, [message, delay, job.job_id, workerId]);
  return "retried";
}

async function currentState(pool: Pool, id: number) {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT narrative, narrative_version, archived_at FROM Incidents WHERE incident_id = ?", [id]);
  return rows[0] as { narrative: string; narrative_version: number; archived_at: Date | null } | undefined;
}

async function process1(pool: Pool, job: Job, workerId: string, r: SyncReport): Promise<void> {
  if (job.action === "delete") {
    await deletePoints([job.incident_id]);
    await finish(pool, job, workerId, "done");
    r.done++;
    return;
  }
  const before = await currentState(pool, job.incident_id);
  if (!before || before.archived_at !== null || before.narrative_version > job.narrative_version) {
    await finish(pool, job, workerId, "superseded", before?.archived_at ? "incident archived" : "newer narrative version exists");
    r.superseded++;
    return;
  }
  const existing = await pointPayload(job.incident_id);
  if (typeof existing?.narrative_version === "number" && existing.narrative_version > job.narrative_version) {
    await finish(pool, job, workerId, "superseded", "index already holds a newer version");
    r.superseded++;
    return;
  }
  const { vector, truncated } = await embedText(before.narrative);
  await upsertIncidentVector(job.incident_id, vector, {
    incident_id: job.incident_id, content_sha256: sha256(before.narrative), model: EMBEDDING_MODEL_NAME, truncated,
    embedded_at: new Date().toISOString(), narrative_version: job.narrative_version,
  });
  const after = await currentState(pool, job.incident_id);
  if (!after || after.narrative_version !== job.narrative_version || after.archived_at !== null) {
    await finish(pool, job, workerId, "superseded", "incident changed while embedding");
    r.superseded++;
    // Our write may have replaced a newer vector that another worker already finished: queue that version again.
    if (after && after.archived_at === null) {
      const [u] = await updateJob(pool, `UPDATE Embedding_Jobs SET status = 'pending', finished_at = NULL, available_at = UTC_TIMESTAMP(), attempts = 0, last_error = 'requeued after a lost update'
                                     WHERE incident_id = ? AND narrative_version = ? AND action = 'upsert' AND status = 'done'`, [job.incident_id, after.narrative_version]);
      r.requeued += (u as { affectedRows: number }).affectedRows;
    }
    return;
  }
  await finish(pool, job, workerId, "done");
  r.done++;
}

/** Processes claimed batches until the queue has nothing due (or maxJobs is reached). */
export async function runSync(opts: { pool?: Pool; workerId?: string; maxJobs?: number; batch?: number } = {}): Promise<SyncReport> {
  const pool = opts.pool ?? appPool();
  const workerId = opts.workerId ?? newWorkerId();
  const r: SyncReport = { claimed: 0, done: 0, superseded: 0, retried: 0, failed: 0, requeued: 0 };
  await ensureCollection();
  while (r.claimed < (opts.maxJobs ?? Infinity)) {
    const jobs = await claim(pool, workerId, Math.min(opts.batch ?? SYNC.batch, (opts.maxJobs ?? Infinity) - r.claimed));
    if (jobs.length === 0) break;
    r.claimed += jobs.length;
    for (const job of jobs) {
      try {
        await process1(pool, job, workerId, r);
      } catch (e) {
        r[await fail(pool, job, workerId, e)]++;
      }
    }
  }
  return r;
}

/**
 * Reconcile both stores and repair what the outbox did not fix: missing / stale / incompatible -> (re)queue an upsert
 * for the current version; orphaned points (archived or unknown incidents) and incompatible points -> deleted.
 * Returns the report from BEFORE the repair; run runSync() afterwards to process the queued jobs.
 */
export async function repair(pool: Pool = appPool()): Promise<{ before: ReconcileReport; queued: number; deleted: number }> {
  await ensureCollection();
  const before = await reconcile(pool);
  await deletePoints([...before.orphaned, ...before.incompatible]);
  const ids = [...before.missing, ...before.stale, ...before.incompatible.map(Number).filter((id) => !before.orphaned.includes(String(id)))];
  let queued = 0;
  for (const id of ids) {
    const [[inc]] = await pool.query<RowDataPacket[][]>("SELECT narrative_version FROM Incidents WHERE incident_id = ? AND archived_at IS NULL", [id]) as unknown as [[RowDataPacket | undefined]];
    if (!inc) continue;
    const [r] = await pool.query(
      `INSERT INTO Embedding_Jobs (incident_id, narrative_version, action) VALUES (?, ?, 'upsert')
       ON DUPLICATE KEY UPDATE attempts = IF(status = 'running', attempts, 0), available_at = UTC_TIMESTAMP(),
                               last_error = IF(status = 'running', last_error, 'requeued by repair'),
                               finished_at = IF(status = 'running', finished_at, NULL),
                               status = IF(status = 'running', status, 'pending')`, [id, Number(inc.narrative_version)]);
    if ((r as { affectedRows: number }).affectedRows > 0) queued++;
  }
  return { before, queued, deleted: before.orphaned.length + before.incompatible.length };
}

export async function syncStatus(pool: Pool = appPool()) {
  const [jobs] = await pool.query<RowDataPacket[]>("SELECT action, status, COUNT(*) AS n FROM Embedding_Jobs GROUP BY action, status ORDER BY action, status");
  const [states] = await pool.query<RowDataPacket[]>("SELECT sync_status, COUNT(*) AS n FROM incident_sync_view GROUP BY sync_status ORDER BY sync_status");
  const [failures] = await pool.query<RowDataPacket[]>(
    "SELECT job_id, incident_id, narrative_version, action, attempts, last_error, finished_at FROM Embedding_Jobs WHERE status = 'failed' ORDER BY job_id DESC LIMIT 20");
  return {
    jobs: jobs.map((j) => ({ action: j.action, status: j.status, count: Number(j.n) })),
    incidents: Object.fromEntries(states.map((s) => [String(s.sync_status), Number(s.n)])),
    recent_failures: failures,
  };
}
