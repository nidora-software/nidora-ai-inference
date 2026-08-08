/**
 * Disk lifecycle.
 *
 * Expiry is an availability control, not housekeeping: a gateway co-located with
 * anything stateful takes it down with a full volume, and a stateful service
 * that cannot write is usually a worse outage than a lost clip. Artifacts are
 * only needed until the client has downloaded and stored its own copy, which
 * happens within seconds; the 24h default is pure slack.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from './store.js';
import type { JobStore } from '../db/jobs.js';
import type { PodStore } from '../db/pods.js';

export interface CleanupDeps {
  jobs: JobStore;
  pods: PodStore;
  artifacts: ArtifactStore;
  artifactTtlMs: number;
  jobRetentionMs: number;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export interface CleanupResult {
  expiredArtifacts: number;
  purgedJobs: number;
  orphanDirs: number;
  purgedPods: number;
}

export async function cleanup(deps: CleanupDeps, now = Date.now()): Promise<CleanupResult> {
  const { jobs, pods, artifacts, artifactTtlMs, jobRetentionMs, log } = deps;
  const result: CleanupResult = {
    expiredArtifacts: 0,
    purgedJobs: 0,
    orphanDirs: 0,
    purgedPods: 0,
  };

  // Expire media for jobs that finished long enough ago.
  for (const job of jobs.finishedBefore(now - artifactTtlMs)) {
    await artifacts.removeJob(job.id);
    jobs.setArtifacts(job.id, []);
    jobs.clearInput(job.id);
    result.expiredArtifacts += 1;
  }

  // Directories with no surviving job row (crash between write and commit, or
  // a job purged below). Age-gated so an in-flight job is never swept.
  for (const dir of [artifacts.inputsDir, artifacts.artifactsDir]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (jobs.get(entry)) continue;
      try {
        const info = await stat(join(dir, entry));
        if (now - info.mtimeMs < artifactTtlMs) continue;
      } catch {
        continue;
      }
      await artifacts.removeJob(entry);
      result.orphanDirs += 1;
    }
  }

  result.purgedJobs = jobs.purgeBefore(now - jobRetentionMs);
  // Pods are cheap rows; keep them well past the job window so /v1/pods still
  // explains where yesterday's work went.
  result.purgedPods = pods.purgeBefore(now - jobRetentionMs);

  if (result.expiredArtifacts || result.purgedJobs || result.orphanDirs) {
    log.info({ ...result }, 'cleanup sweep');
  }
  return result;
}

export function startCleanup(deps: CleanupDeps, intervalMs: number): () => void {
  const timer = setInterval(() => {
    cleanup(deps).catch((error) => deps.log.warn({ err: String(error) }, 'cleanup sweep failed'));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
