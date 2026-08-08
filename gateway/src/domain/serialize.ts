/**
 * Job row → client JSON.
 *
 * CONTRACT (docs/api.md): a job carries a non-empty string `id` and a `state`
 * from the five documented values. `artifacts[0].url` is a path relative to this
 * gateway — clients resolve it against their configured host and fetch it with
 * credentials, refusing redirects, so it must never become absolute or point
 * outside `/v1/outputs/<job id>/`. Timestamps are ISO-8601 `...Z`.
 */
import type { Job, JobResponse } from './types.js';

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function toJobResponse(job: Job, queuePosition: number | null): JobResponse {
  return {
    id: job.id,
    pipeline: job.pipeline,
    state: job.state,
    progress: job.progress,
    error: job.error,
    params: job.params,
    artifacts: job.artifacts,
    created_at: iso(job.created_at)!,
    started_at: iso(job.started_at),
    finished_at: iso(job.finished_at),
    pod_id: job.pod_id,
    attempts: job.attempts,
    queue_position: queuePosition,
  };
}

/**
 * Callers validate both segments with `isSafeFilename` first; encoding here is
 * the second layer, so that a future caller which forgets to validate produces
 * an escaped (harmless) URL rather than a traversal the consumer would follow.
 */
export function artifactUrl(jobId: string, filename: string): string {
  return `/v1/outputs/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
}
