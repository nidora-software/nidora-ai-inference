/**
 * Job row → client JSON, in SGLang's (and therefore OpenAI's) video shape.
 *
 * CONTRACT (docs/api.md): a video carries a non-empty string `id`, `object`
 * `"video"`, and a `status` from the five documented values. Timestamps are
 * unix **seconds**, not milliseconds and not ISO strings, because that is what
 * an OpenAI-shaped client parses. `progress` is an integer percentage for the
 * same reason, though it is stored internally as a 0-1 fraction.
 *
 * The rendered media is not linked from here: it is at
 * `GET /v1/videos/{id}/content`, by convention rather than by URL, exactly as
 * SGLang does it. That removes the whole class of bugs where a gateway-built
 * URL escapes its own prefix.
 */
import type { Job, VideoResponse } from './types.js';

function seconds(ms: number | null): number | null {
  return ms === null ? null : Math.floor(ms / 1000);
}

export function toVideoResponse(
  job: Job,
  queuePosition: number | null,
  artifactTtlMs: number,
): VideoResponse {
  // Only a completed video has media on disk, so only a completed video has a
  // download window that can expire.
  const expiresAt =
    job.state === 'completed' && job.finished_at !== null
      ? seconds(job.finished_at + artifactTtlMs)
      : null;

  return {
    id: job.id,
    object: 'video',
    model: job.model,
    status: job.state,
    progress: Math.round(job.progress * 100),
    created_at: seconds(job.created_at)!,
    completed_at: seconds(job.finished_at),
    expires_at: expiresAt,
    size: job.params.size,
    seconds: job.params.seconds,
    error: job.error ? { code: 'generation_failed', message: job.error } : null,
    pod_id: job.pod_id,
    attempts: job.attempts,
    queue_position: queuePosition,
  };
}
