/**
 * Wire and storage types.
 *
 * CONTRACT WARNING: `VideoStatus` is part of the public API (docs/api.md) and
 * mirrors SGLang's — which mirrors OpenAI's. Clients are entitled to map
 * exactly these five strings and treat anything else as an error, so adding one
 * is a breaking change. In particular there is no `cancelling` status: a cancel
 * in flight is an `in_progress` video with `cancel_requested` set.
 */
export const VIDEO_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const TERMINAL_STATES: readonly VideoStatus[] = ['completed', 'failed', 'cancelled'];

export function isVideoStatus(value: unknown): value is VideoStatus {
  return typeof value === 'string' && (VIDEO_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(state: VideoStatus): boolean {
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
  media_type: string;
  filename: string;
  bytes?: number;
  sha256?: string;
}

/** A row of the `jobs` table, with JSON columns already decoded. */
export interface Job {
  id: string;
  /** Canonical registry id, resolved from the client's `model` on create. */
  model: string;
  params: JobParams;
  input_path: string | null;
  input_sha256: string | null;
  input_bytes: number | null;
  state: VideoStatus;
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
  /** Raw value the agent reported, whatever SGLang was pointed at. */
  model_path: string | null;
  lora_path: string | null;
  /** Canonical registry id for `model_path`, or null if unrecognised. */
  model: string | null;
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
 * The video object handed back to clients — the shape SGLang and OpenAI use.
 * `created_at` and `completed_at` are unix seconds, `progress` is an integer
 * percentage. See docs/api.md; pinned by test/contract.test.ts.
 */
export interface VideoResponse {
  id: string;
  object: 'video';
  model: string;
  status: VideoStatus;
  /** 0-100, integer. Stored internally as a 0-1 fraction. */
  progress: number;
  created_at: number;
  completed_at: number | null;
  /** When the rendered media is swept, so a client knows its download window. */
  expires_at: number | null;
  size: string;
  seconds: number;
  error: { code: string; message: string } | null;
  /* Gateway extras — unknown to an OpenAI client, useful to operators. */
  pod_id: string | null;
  attempts: number;
  queue_position: number | null;
}
