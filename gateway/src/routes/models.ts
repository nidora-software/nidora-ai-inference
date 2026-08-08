/**
 * `GET /v1/models` — what the fleet can actually run right now.
 *
 * SGLang answers the same question for one server, from the weights it loaded.
 * This answers it for a fleet, the same way: a model appears only while a
 * connected pod is serving it. Advertising a model no pod has loaded would be
 * advertising an indefinite queue, so an empty fleet returns an empty list.
 *
 * The registry behind it stays closed and compiled in — see domain/models.ts
 * for why `model` must never become a value that reaches a path.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AppContext } from '../context.js';
import { getModel } from '../domain/models.js';

export default async function modelRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext },
): Promise<void> {
  const { ctx } = opts;
  const { config, pods } = ctx;

  app.addHook('preHandler', ctx.requireApiKey);

  app.get('/v1/models', async (_request, reply) => {
    const connected = pods.listConnected(Date.now() - config.podStaleMs);

    //: model id -> how many pods can take work for it right now
    const ready = new Map<string, number>();
    for (const pod of connected) {
      if (!pod.model) continue;
      const usable = pod.sglang_ready && !pod.draining;
      ready.set(pod.model, (ready.get(pod.model) ?? 0) + (usable ? 1 : 0));
    }

    const data = [...ready.keys()]
      .sort()
      .map((id) => {
        const spec = getModel(id)!;
        return {
          id,
          object: 'model' as const,
          task: spec.task,
          /* Gateway extras: what a client needs to build a valid request. */
          resolutions: spec.resolutions,
          defaults: spec.defaults,
          limits: spec.limits,
          pods_ready: ready.get(id) ?? 0,
        };
      });

    return reply.send({ object: 'list', data });
  });
}
