/**
 * The job store. Every SQL statement touching `jobs` / `job_events` lives here,
 * so swapping SQLite for Postgres later is a one-file change.
 *
 * ## Lease fencing
 *
 * A job dispatched to a pod carries a `lease_id`. Every subsequent agent call
 * about that job must present the same lease, and each terminal write is a
 * compare-and-swap on `(id, state, lease_id)`. This single rule eliminates the
 * whole duplicate-delivery hazard class: a pod that finishes work after its
 * lease expired and the job was requeued cannot clobber the result the pod that
 * actually finished it wrote. Callers treat a `false` return as "you no longer
 * own this job" and give up.
 */
import type { Db } from './sqlite.js';
import {
  isVideoStatus,
  type Artifact,
  type Job,
  type JobEventKind,
  type JobParams,
  type VideoStatus,
} from '../domain/types.js';

interface JobRow {
  id: string;
  model: string;
  params: string;
  input_path: string | null;
  input_sha256: string | null;
  input_bytes: number | null;
  state: string;
  progress: number;
  error: string | null;
  artifacts: string;
  pod_id: string | null;
  lease_id: string | null;
  lease_expires_at: number | null;
  upstream_id: string | null;
  attempts: number;
  cancel_requested: number;
  cancel_requested_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  deadline_at: number;
}

function hydrate(row: JobRow): Job {
  const state = row.state;
  if (!isVideoStatus(state)) {
    // Only reachable via hand-editing the database; fail loudly rather than
    // shipping an unmappable state to the client (which would make the
    // consumer's toJob() throw).
    throw new Error(`job ${row.id} has an unknown state ${JSON.stringify(state)}`);
  }
  return {
    id: row.id,
    model: row.model,
    params: JSON.parse(row.params) as JobParams,
    input_path: row.input_path,
    input_sha256: row.input_sha256,
    input_bytes: row.input_bytes,
    state,
    progress: row.progress,
    error: row.error,
    artifacts: JSON.parse(row.artifacts) as Artifact[],
    pod_id: row.pod_id,
    lease_id: row.lease_id,
    lease_expires_at: row.lease_expires_at,
    upstream_id: row.upstream_id,
    attempts: row.attempts,
    cancel_requested: row.cancel_requested === 1,
    cancel_requested_at: row.cancel_requested_at,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    deadline_at: row.deadline_at,
  };
}

export interface NewJob {
  id: string;
  model: string;
  params: JobParams;
  input_path: string;
  input_sha256: string;
  input_bytes: number;
  created_at: number;
  deadline_at: number;
}

export interface QueueCounts {
  queued: number;
  running: number;
  oldest_queued_at: number | null;
}

export class JobStore {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- creation

  create(job: NewJob): Job {
    this.db
      .prepare(
        `INSERT INTO jobs (id, model, params, input_path, input_sha256, input_bytes,
                           state, created_at, deadline_at)
         VALUES (@id, @model, @params, @input_path, @input_sha256, @input_bytes,
                 'queued', @created_at, @deadline_at)`,
      )
      .run({ ...job, params: JSON.stringify(job.params) });
    this.addEvent(job.id, 'created', null, job.model);
    return this.get(job.id)!;
  }

  // ----------------------------------------------------------------- reading

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? hydrate(row) : null;
  }

  list(opts: { state?: VideoStatus; limit?: number } = {}): Job[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = opts.state
      ? (this.db
          .prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?')
          .all(opts.state, limit) as JobRow[])
      : (this.db
          .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
          .all(limit) as JobRow[]);
    return rows.map(hydrate);
  }

  /** Oldest-first, for the claim loop. */
  listQueued(limit = 100): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC LIMIT ?")
      .all(limit) as JobRow[];
    return rows.map(hydrate);
  }

  /** 0-based position in the queue, or null once the job has been dispatched. */
  queuePosition(job: Job): number | null {
    if (job.state !== 'queued') return null;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued' AND created_at < ?")
      .get(job.created_at) as { n: number };
    return row.n;
  }

  counts(): QueueCounts {
    const row = this.db
      .prepare(
        `SELECT
           SUM(state = 'queued')  AS queued,
           SUM(state = 'in_progress') AS running,
           MIN(CASE WHEN state = 'queued' THEN created_at END) AS oldest_queued_at
         FROM jobs WHERE state IN ('queued', 'in_progress')`,
      )
      .get() as { queued: number | null; running: number | null; oldest_queued_at: number | null };
    return {
      queued: row.queued ?? 0,
      running: row.running ?? 0,
      oldest_queued_at: row.oldest_queued_at,
    };
  }

  /** In-flight jobs a pod believes it owns, used to reconcile a reconnecting agent. */
  listByPod(podId: string, state: VideoStatus = 'in_progress'): Job[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE pod_id = ? AND state = ? ORDER BY created_at ASC')
      .all(podId, state) as JobRow[];
    return rows.map(hydrate);
  }

  // ------------------------------------------------------------- transitions

  /**
   * Dispatch: CAS `queued` -> `in_progress`, taking ownership with a fresh lease.
   * Returns false when another poller claimed the job first.
   */
  claim(id: string, podId: string, leaseId: string, expiresAt: number, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs
            SET state = 'in_progress', pod_id = ?, lease_id = ?, lease_expires_at = ?,
                started_at = COALESCE(started_at, ?), attempts = attempts + 1
          WHERE id = ? AND state = 'queued'`,
      )
      .run(podId, leaseId, expiresAt, now, id);
    if (result.changes === 1) this.addEvent(id, 'assigned', podId, `lease=${leaseId}`);
    return result.changes === 1;
  }

  /** Heartbeat: extend the lease and record progress. False = lease no longer valid. */
  renewLease(
    id: string,
    leaseId: string,
    expiresAt: number,
    progress?: number,
    upstreamId?: string | null,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs
            SET lease_expires_at = ?,
                progress = COALESCE(?, progress),
                upstream_id = COALESCE(?, upstream_id)
          WHERE id = ? AND state = 'in_progress' AND lease_id = ?`,
      )
      .run(expiresAt, progress ?? null, upstreamId ?? null, id, leaseId);
    return result.changes === 1;
  }

  complete(id: string, leaseId: string, artifacts: Artifact[], now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs
            SET state = 'completed', progress = 1, error = NULL,
                artifacts = ?, finished_at = ?, lease_id = NULL, lease_expires_at = NULL
          WHERE id = ? AND state = 'in_progress' AND lease_id = ?`,
      )
      .run(JSON.stringify(artifacts), now, id, leaseId);
    if (result.changes === 1) this.addEvent(id, 'completed', null, null);
    return result.changes === 1;
  }

  fail(id: string, leaseId: string | null, error: string, now: number): boolean {
    // A null lease means the caller is the gateway itself (reaper, deadline
    // sweep) rather than a pod, so ownership isn't checked.
    const sql = leaseId
      ? `UPDATE jobs SET state='failed', error=?, finished_at=?, lease_id=NULL, lease_expires_at=NULL
           WHERE id=? AND state='in_progress' AND lease_id=?`
      : `UPDATE jobs SET state='failed', error=?, finished_at=?, lease_id=NULL, lease_expires_at=NULL
           WHERE id=? AND state IN ('queued','in_progress')`;
    const args = leaseId ? [error, now, id, leaseId] : [error, now, id];
    const result = this.db.prepare(sql).run(...args);
    if (result.changes === 1) this.addEvent(id, 'failed', null, error.slice(0, 500));
    return result.changes === 1;
  }

  /**
   * Return an in-flight job to the queue after its pod stopped renewing, or after
   * a retryable pod-side failure. Clears ownership so the next poller can claim it.
   */
  requeue(id: string, leaseId: string | null, reason: string): boolean {
    const sql = leaseId
      ? `UPDATE jobs SET state='queued', pod_id=NULL, lease_id=NULL, lease_expires_at=NULL,
                        progress=0, upstream_id=NULL
           WHERE id=? AND state='in_progress' AND lease_id=?`
      : `UPDATE jobs SET state='queued', pod_id=NULL, lease_id=NULL, lease_expires_at=NULL,
                        progress=0, upstream_id=NULL
           WHERE id=? AND state='in_progress'`;
    const args = leaseId ? [id, leaseId] : [id];
    const result = this.db.prepare(sql).run(...args);
    if (result.changes === 1) this.addEvent(id, 'requeued', null, reason);
    return result.changes === 1;
  }

  /** Cancel a job that has not been dispatched yet. */
  cancelQueued(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs SET state='cancelled', finished_at=?, cancel_requested=1, cancel_requested_at=?
           WHERE id=? AND state='queued'`,
      )
      .run(now, now, id);
    if (result.changes === 1) this.addEvent(id, 'cancelled', null, 'cancelled while queued');
    return result.changes === 1;
  }

  /**
   * Flag an in-flight job for cancellation. The pod picks the flag up on its next
   * poll; the reaper forces the transition if it never acknowledges.
   *
   * Note there is deliberately no `cancelling` job state — see domain/types.ts.
   */
  requestCancel(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs SET cancel_requested=1, cancel_requested_at=COALESCE(cancel_requested_at, ?)
           WHERE id=? AND state='in_progress'`,
      )
      .run(now, id);
    if (result.changes === 1) this.addEvent(id, 'cancel_requested', null, null);
    return result.changes === 1;
  }

  markCancelled(id: string, leaseId: string | null, now: number, detail: string): boolean {
    const sql = leaseId
      ? `UPDATE jobs SET state='cancelled', finished_at=?, lease_id=NULL, lease_expires_at=NULL
           WHERE id=? AND state='in_progress' AND lease_id=?`
      : `UPDATE jobs SET state='cancelled', finished_at=?, lease_id=NULL, lease_expires_at=NULL
           WHERE id=? AND state='in_progress'`;
    const args = leaseId ? [now, id, leaseId] : [now, id];
    const result = this.db.prepare(sql).run(...args);
    if (result.changes === 1) this.addEvent(id, 'cancelled', null, detail);
    return result.changes === 1;
  }

  setArtifacts(id: string, artifacts: Artifact[]): void {
    this.db
      .prepare('UPDATE jobs SET artifacts = ? WHERE id = ?')
      .run(JSON.stringify(artifacts), id);
  }

  clearInput(id: string): void {
    this.db.prepare('UPDATE jobs SET input_path = NULL WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------- sweeping

  /** In-flight jobs whose pod stopped renewing the lease. */
  expiredLeases(now: number): Job[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE state='in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
      )
      .all(now) as JobRow[];
    return rows.map(hydrate);
  }

  /** Jobs that blew their wall-clock budget, whether or not a pod ever took them. */
  overdue(now: number): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE state IN ('queued','in_progress') AND deadline_at < ?")
      .all(now) as JobRow[];
    return rows.map(hydrate);
  }

  /** In-flight jobs whose cancellation was never acknowledged by the pod. */
  staleCancels(before: number): Job[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE state='in_progress' AND cancel_requested=1 AND cancel_requested_at < ?",
      )
      .all(before) as JobRow[];
    return rows.map(hydrate);
  }

  /**
   * Gateway restart. Unlike the legacy in-process worker, the work survives on
   * the pods — so in-flight jobs are NOT failed. Their leases are pushed out by
   * one grace window; agents re-claim them on their next poll (<= 25s), and the
   * reaper requeues whatever nobody claims.
   */
  recoverOnStartup(now: number, graceMs: number): number {
    const result = this.db
      .prepare("UPDATE jobs SET lease_expires_at = ? WHERE state = 'in_progress'")
      .run(now + graceMs);
    if (result.changes > 0) {
      this.db
        .prepare(
          `INSERT INTO job_events (job_id, ts, kind, pod_id, detail)
             SELECT id, ?, 'recovered', pod_id, 'lease extended after gateway restart'
               FROM jobs WHERE state = 'in_progress'`,
        )
        .run(now);
    }
    return result.changes;
  }

  /** Terminal jobs finished before `before` — candidates for artifact expiry. */
  finishedBefore(before: number): Job[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND artifacts != '[]'",
      )
      .all(before) as JobRow[];
    return rows.map(hydrate);
  }

  /** Drop rows past the retention window. Returns how many jobs were deleted. */
  purgeBefore(before: number): number {
    const purge = this.db.transaction((cutoff: number) => {
      this.db
        .prepare(
          'DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?)',
        )
        .run(cutoff);
      return this.db
        .prepare('DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?')
        .run(cutoff).changes;
    });
    return purge(before);
  }

  // ------------------------------------------------------------------ events

  addEvent(jobId: string, kind: JobEventKind, podId: string | null, detail: string | null): void {
    this.db
      .prepare('INSERT INTO job_events (job_id, ts, kind, pod_id, detail) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, Date.now(), kind, podId, detail);
  }

  events(jobId: string, limit = 100): Array<{ ts: number; kind: string; pod_id: string | null; detail: string | null }> {
    return this.db
      .prepare('SELECT ts, kind, pod_id, detail FROM job_events WHERE job_id = ? ORDER BY ts ASC LIMIT ?')
      .all(jobId, limit) as Array<{ ts: number; kind: string; pod_id: string | null; detail: string | null }>;
  }
}
