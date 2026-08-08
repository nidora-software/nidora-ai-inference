/**
 * Environment parsing. Everything the gateway can be tuned with lives here so
 * there is exactly one place to look up a default.
 *
 * Two secrets are load-bearing and the process refuses to boot without them:
 * this service is internet-facing (via the Cloudflare Tunnel) and a gateway
 * that accidentally starts unauthenticated hands out GPU time to strangers.
 */

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${raw}`);
  return parsed;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  logLevel: string;

  apiKeys: string[];
  agentSecret: string;
  adminKeys: string[];

  /** How long a dispatched job stays owned by a pod without a renewing poll. */
  leaseTtlMs: number;
  /** Upper bound the agent's long-poll is clamped to (CF read timeout is 125s). */
  maxPollWaitMs: number;
  /**
   * Wall-clock budget from job creation to a terminal state. Deliberately
   * inside the consumer's 20-minute deadline so a doomed job returns a legible
   * error instead of an opaque client-side timeout.
   */
  jobTtlMs: number;
  /** Dispatch attempts before a job is failed rather than requeued. */
  maxAttempts: number;
  reaperIntervalMs: number;
  /** Grace after DELETE before a running job is force-cancelled. */
  cancelGraceMs: number;
  /**
   * A pod is "connected" if it polled within this window. Sized at a few poll
   * cycles so one dropped request doesn't drop the pod off the dashboard.
   */
  podStaleMs: number;

  artifactTtlMs: number;
  jobRetentionMs: number;
  cleanupIntervalMs: number;

  maxInputBytes: number;
  maxArtifactBytes: number;
  bodyLimitBytes: number;
  /** Hard ceiling on queued jobs; admission control refuses beyond it. */
  maxQueueDepth: number;
}

export function loadConfig(env: Env = process.env): Config {
  const apiKeys = list(env, 'GATEWAY_API_KEYS');
  if (apiKeys.length === 0) {
    throw new Error('GATEWAY_API_KEYS is required (comma-separated; rotation-friendly)');
  }
  const agentSecret = env.AGENT_SHARED_SECRET ?? '';
  if (!agentSecret) throw new Error('AGENT_SHARED_SECRET is required');

  return {
    port: num(env, 'PORT', 8080),
    host: env.HOST ?? '0.0.0.0',
    dataDir: env.DATA_DIR ?? '/data',
    logLevel: env.LOG_LEVEL ?? 'info',

    apiKeys,
    agentSecret,
    adminKeys: list(env, 'ADMIN_KEYS'),

    leaseTtlMs: num(env, 'LEASE_TTL_S', 120) * 1000,
    maxPollWaitMs: num(env, 'MAX_POLL_WAIT_S', 25) * 1000,
    jobTtlMs: num(env, 'JOB_TTL_S', 18 * 60) * 1000,
    maxAttempts: num(env, 'MAX_ATTEMPTS', 2),
    reaperIntervalMs: num(env, 'REAPER_INTERVAL_S', 10) * 1000,
    cancelGraceMs: num(env, 'CANCEL_GRACE_S', 60) * 1000,
    podStaleMs: num(env, 'POD_STALE_S', 90) * 1000,

    artifactTtlMs: num(env, 'ARTIFACT_TTL_HOURS', 24) * 3600 * 1000,
    jobRetentionMs: num(env, 'JOB_RETENTION_DAYS', 7) * 86400 * 1000,
    cleanupIntervalMs: num(env, 'CLEANUP_INTERVAL_S', 900) * 1000,

    maxInputBytes: num(env, 'MAX_INPUT_BYTES', 20 * 1024 * 1024),
    maxArtifactBytes: num(env, 'MAX_ARTIFACT_BYTES', 200 * 1024 * 1024),
    bodyLimitBytes: num(env, 'BODY_LIMIT_BYTES', 32 * 1024 * 1024),
    maxQueueDepth: num(env, 'MAX_QUEUE_DEPTH', 200),
  };
}
