/**
 * Liveness and fleet metrics.
 *
 * Unauthenticated on purpose: the Docker healthcheck, the tunnel, and any
 * uptime probe need it, and it exposes only aggregate counts. `queue_depth`
 * keeps the legacy stack's meaning (queued + running) so existing dashboards
 * don't silently change definition.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AppContext } from '../context.js';
import { freeSlots } from '../scheduler/claim.js';

interface FleetSnapshot {
  connected: number;
  ready: number;
  draining: number;
  slots_total: number;
  slots_busy: number;
}

function fleet(ctx: AppContext, now: number): FleetSnapshot {
  const connected = ctx.pods.listConnected(now - ctx.config.podStaleMs);
  const snapshot: FleetSnapshot = {
    connected: connected.length,
    ready: 0,
    draining: 0,
    slots_total: 0,
    slots_busy: 0,
  };
  for (const pod of connected) {
    if (pod.draining) snapshot.draining += 1;
    if (pod.sglang_ready && !pod.draining) snapshot.ready += 1;
    const inFlight = ctx.jobs.listByPod(pod.pod_id).length;
    snapshot.slots_busy += inFlight;
    snapshot.slots_total += freeSlots(pod, inFlight) + inFlight;
  }
  return snapshot;
}

export default async function healthRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext; version: string },
): Promise<void> {
  const { ctx, version } = opts;

  app.get('/health', async (_request, reply) => {
    const now = Date.now();
    const counts = ctx.jobs.counts();
    return reply.send({
      status: 'ok',
      version,
      queue_depth: counts.queued + counts.running,
      queued: counts.queued,
      running: counts.running,
      oldest_queued_age_s: counts.oldest_queued_at
        ? Math.round((now - counts.oldest_queued_at) / 1000)
        : 0,
      pods: fleet(ctx, now),
    });
  });

  /**
   * Prometheus exposition. The series here are exactly the inputs an
   * autoscaler needs — queue depth, how long the oldest job has waited, and
   * how much of the fleet's capacity is in use — so adding one later is a
   * matter of reading these, not instrumenting anything new.
   */
  app.get('/metrics', async (_request, reply) => {
    const now = Date.now();
    const counts = ctx.jobs.counts();
    const f = fleet(ctx, now);
    const oldest = counts.oldest_queued_at ? (now - counts.oldest_queued_at) / 1000 : 0;

    const lines = [
      '# HELP nidora_queue_depth Jobs queued or running.',
      '# TYPE nidora_queue_depth gauge',
      `nidora_queue_depth ${counts.queued + counts.running}`,
      '# HELP nidora_jobs_queued Jobs waiting for a pod.',
      '# TYPE nidora_jobs_queued gauge',
      `nidora_jobs_queued ${counts.queued}`,
      '# HELP nidora_jobs_running Jobs currently assigned to a pod.',
      '# TYPE nidora_jobs_running gauge',
      `nidora_jobs_running ${counts.running}`,
      '# HELP nidora_oldest_queued_seconds Age of the oldest queued job.',
      '# TYPE nidora_oldest_queued_seconds gauge',
      `nidora_oldest_queued_seconds ${oldest.toFixed(0)}`,
      '# HELP nidora_pods_connected Pods that polled within the staleness window.',
      '# TYPE nidora_pods_connected gauge',
      `nidora_pods_connected ${f.connected}`,
      '# HELP nidora_pods_ready Connected pods with a warmed SGLang server.',
      '# TYPE nidora_pods_ready gauge',
      `nidora_pods_ready ${f.ready}`,
      '# HELP nidora_pod_slots_total Total concurrent job slots across ready pods.',
      '# TYPE nidora_pod_slots_total gauge',
      `nidora_pod_slots_total ${f.slots_total}`,
      '# HELP nidora_pod_slots_busy Slots currently occupied.',
      '# TYPE nidora_pod_slots_busy gauge',
      `nidora_pod_slots_busy ${f.slots_busy}`,
      '',
    ];
    return reply.header('content-type', 'text/plain; version=0.0.4').send(lines.join('\n'));
  });
}
