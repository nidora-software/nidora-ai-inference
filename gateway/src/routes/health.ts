/**
 * Liveness and fleet capacity.
 *
 * Unauthenticated on purpose: the Docker healthcheck hits it over loopback and
 * it exposes only aggregate counts. `queue_depth` keeps the legacy stack's
 * meaning (queued + running) so existing dashboards don't silently change
 * definition.
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
      // Unix seconds, matching every other timestamp this API emits. Worth the
      // one line: a caller comparing its own clock against `expires_at` on a
      // video needs to know the two agree, and a response cached anywhere
      // between here and the client shows up as a `time` that stopped moving.
      time: Math.floor(now / 1000),
      queue_depth: counts.queued + counts.running,
      queued: counts.queued,
      running: counts.running,
      oldest_queued_age_s: counts.oldest_queued_at
        ? Math.round((now - counts.oldest_queued_at) / 1000)
        : 0,
      pods: fleet(ctx, now),
    });
  });
}
