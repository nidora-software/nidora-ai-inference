/**
 * Artifact download.
 *
 * The consumer fetches this URL with `redirect: 'error'`, so the response must
 * be a 200 with a body — never a redirect to object storage. It also sends the
 * same `X-Api-Key`, which is why this route is behind the client-key hook.
 */
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AppContext } from '../context.js';

const MEDIA_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export default async function outputRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext },
): Promise<void> {
  const { ctx } = opts;
  const { jobs, artifacts } = ctx;

  app.addHook('preHandler', ctx.requireApiKey);

  app.get<{ Params: { jobId: string; filename: string } }>(
    '/v1/outputs/:jobId/:filename',
    async (request, reply) => {
      const { jobId, filename } = request.params;

      const path = artifacts.resolveArtifact(jobId, filename);
      if (!path) return reply.code(404).send({ detail: 'artifact not found' });

      const size = await artifacts.exists(path);
      if (size === null) {
        // Distinguish "never existed" from "swept by the TTL": both are a
        // failed download to the client, but only one is a bug.
        const job = jobs.get(jobId);
        if (job && job.state === 'completed') {
          return reply.code(410).send({ detail: 'artifact expired' });
        }
        return reply.code(404).send({ detail: 'artifact not found' });
      }

      const extension = filename.split('.').pop()?.toLowerCase() ?? '';
      return reply
        .header('content-type', MEDIA_TYPES[extension] ?? 'application/octet-stream')
        .header('content-length', String(size))
        .header('cache-control', 'private, max-age=300')
        .send(createReadStream(path));
    },
  );
}
