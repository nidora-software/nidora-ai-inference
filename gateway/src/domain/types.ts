/**
 * Wire and storage types.
 *
 * CONTRACT WARNING: `JobState` is part of the public API (docs/api.md). Clients
 * are entitled to map exactly these five strings and treat anything else as an
 * error, so adding a state is a breaking change and needs a coordinated client
 * rollout. In particular there is no `cancelling` state: a cancel in flight is
 * a running job with `cancel_requested` set.
 */
export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled'];

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Client-supplied generation parameters, after validation and clamping. */
export interface JobParams {
  prompt: string;
  negative_prompt: string;
  resolution: '480p' | '720p';
  /** Computed server-side from the input image's aspect ratio, e.g. "464x832". */
  size: string;
  seconds: number;
  num_inference_steps: number;
  guidance_scale: number;
  seed: number | null;
}

export interface Artifact {
  url: string;
  media_type: string;
  filename: string;
  bytes?: number;
  sha256?: string;
}

/** A row of the `jobs` table, with JSON columns already decoded. */
export interface Job {
  id: string;
  pipeline: string;
  params: JobParams;
  input_path: string | null;
  input_sha256: string | null;
  input_bytes: number | null;
  state: JobState;
  progress: number;
  error: string | null;
  artifacts: Artifact[];
  pod_id: string | null;
  lease_id: string | null;
  lease_expires_at: number | null;
  upstream_id: string | null;
  attempts: number;
  cancel_requested: boolean;
  cancel_requested_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  deadline_at: number;
}

export interface Pod {
  pod_id: string;
  session_id: string;
  first_seen_at: number;
  last_seen_at: number;
  agent_version: string | null;
  model_path: string | null;
  lora_path: string | null;
  pipelines: string[];
  gpu: string | null;
  max_in_flight: number;
  sglang_ready: boolean;
  draining: boolean;
  jobs_completed: number;
  jobs_failed: number;
}

export type JobEventKind =
  | 'created'
  | 'assigned'
  | 'progress'
  | 'uploaded'
  | 'completed'
  | 'failed'
  | 'requeued'
  | 'lease_expired'
  | 'deadline_exceeded'
  | 'cancel_requested'
  | 'cancelled'
  | 'recovered';

/**
 * The JSON body handed back to clients. Field names and the ISO-8601 timestamp
 * format are the documented wire shape — see docs/api.md.
 */
export interface JobResponse {
  id: string;
  pipeline: string;
  state: JobState;
  progress: number;
  error: string | null;
  params: JobParams;
  artifacts: Artifact[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /* Gateway extras — ignored by the consumer, useful to operators. */
  pod_id: string | null;
  attempts: number;
  queue_position: number | null;
}
