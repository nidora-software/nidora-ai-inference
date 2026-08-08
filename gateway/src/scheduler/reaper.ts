/**
 * Periodic sweep for jobs no agent will ever finish.
 *
 * Three independent timers guard a job, and any one of them unsticks it:
 *   - the lease  — the owning pod stopped polling
 *   - the deadline — the job blew its wall-clock budget wherever it sat
 *   - the cancel grace — a cancel the pod never acknowledged
 */
import type { JobStore } from '../db/jobs.js';
import type { PodStore } from '../db/pods.js';
import type { Waiters } from './waiters.js';
import type { ArtifactStore } from '../artifacts/store.js';

export interface ReaperDeps {
  jobs: JobStore;
  pods: PodStore;
  artifacts: ArtifactStore;
  waiters: Waiters;
  maxAttempts: number;
  cancelGraceMs: number;
  podStaleMs: number;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export interface SweepResult {
  requeued: number;
  failed: number;
  cancelled: number;
}

function humanMs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function sweep(deps: ReaperDeps, now = Date.now()): SweepResult {
  const { jobs, pods, waiters, maxAttempts, cancelGraceMs, log } = deps;
  const result: SweepResult = { requeued: 0, failed: 0, cancelled: 0 };

  // 1. Leases the owning pod stopped renewing. The work is presumed lost, but
  //    it may simply have been slow — the lease TTL is the tolerance for that.
  for (const job of jobs.expiredLeases(now)) {
    const podId = job.pod_id;
    if (job.attempts >= maxAttempts) {
      if (
        jobs.fail(
          job.id,
          job.lease_id,
          `pod lost during generation (${job.attempts} attempt${job.attempts === 1 ? '' : 's'})`,
          now,
        )
      ) {
        result.failed += 1;
        if (podId) pods.recordOutcome(podId, 'failed');
        log.warn({ jobId: job.id, podId }, 'job failed: lease expired at attempt cap');
      }
    } else if (jobs.requeue(job.id, job.lease_id, 'lease expired')) {
      result.requeued += 1;
      jobs.addEvent(job.id, 'lease_expired', podId, `attempt ${job.attempts}`);
      log.warn({ jobId: job.id, podId }, 'job requeued: lease expired');
    }
  }

  // 2. Wall-clock budget. Deliberately inside the client's own 20-minute
  //    timeout so the failure is legible instead of an opaque client abort.
  for (const job of jobs.overdue(now)) {
    const queuedFor = (job.started_at ?? now) - job.created_at;
    const runningFor = job.started_at ? now - job.started_at : 0;
    const detail = `job exceeded its ${humanMs(job.deadline_at - job.created_at)} deadline (queued ${humanMs(queuedFor)}, running ${humanMs(runningFor)})`;
    if (jobs.fail(job.id, null, detail, now)) {
      result.failed += 1;
      jobs.addEvent(job.id, 'deadline_exceeded', job.pod_id, null);
      if (job.pod_id) pods.recordOutcome(job.pod_id, 'failed');
      log.warn({ jobId: job.id, podId: job.pod_id }, 'job failed: deadline exceeded');
    }
  }

  // 3. Cancels a pod never acknowledged — it may have died holding the job.
  for (const job of jobs.staleCancels(now - cancelGraceMs)) {
    if (jobs.markCancelled(job.id, null, now, 'pod did not acknowledge the cancel')) {
      result.cancelled += 1;
      log.info({ jobId: job.id, podId: job.pod_id }, 'job cancelled: pod never acknowledged');
    }
  }

  if (result.requeued > 0) waiters.kick();
  return result;
}

export function startReaper(deps: ReaperDeps, intervalMs: number): () => void {
  const timer = setInterval(() => {
    try {
      sweep(deps);
    } catch (error) {
      deps.log.warn({ err: String(error) }, 'reaper sweep failed');
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
