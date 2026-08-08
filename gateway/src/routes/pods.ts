/**
 * Operator view of the fleet. Separate from the client job API because it
 * authenticates with the admin key, not a client API key.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AppContext } from '../context.js';

export default async function podRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext },
): Promise<void> {
  const { ctx } = opts;
  const { config, jobs, pods } = ctx;

  app.addHook('preHandler', ctx.requireAdminKey);

  app.get('/v1/pods', async (_request, reply) => {
    const now = Date.now();
    return reply.send({
      pods: pods.list().map((pod) => ({
        ...pod,
        connected: now - pod.last_seen_at <= config.podStaleMs,
        last_seen_ago_s: Math.round((now - pod.last_seen_at) / 1000),
        in_flight: jobs.listByPod(pod.pod_id).length,
      })),
    });
  });

  /**
   * Stop giving a pod new work without killing what it is already running —
   * the polite way to retire a rented pod before destroying it.
   */
  app.post<{ Params: { id: string }; Body: { draining?: boolean } }>(
    '/v1/pods/:id/drain',
    async (request, reply) => {
      const draining = request.body?.draining ?? true;
      if (!pods.setDraining(request.params.id, draining)) {
        return reply.code(404).send({ detail: 'pod not found' });
      }
      request.log.info({ podId: request.params.id, draining }, 'pod drain flag changed');
      return reply.send({ pod_id: request.params.id, draining });
    },
  );
}
