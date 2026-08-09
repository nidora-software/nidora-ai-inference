/**
 * Operator view of the fleet. Separate from the client job API because it
 * authenticates with the admin key, not a client API key.
 */
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { AppContext } from '../context.js';

export default async function podRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext },
): Promise<void> {
  const { ctx } = opts;
  const { config, jobs, pods } = ctx;

  app.addHook('preHandler', ctx.requireAdminKey);

  /**
   * These routes are typed by hand into a terminal, so the body arrives in
   * whatever shape curl felt like sending. Both parsers below are scoped to
   * this plugin: the client and agent planes keep strict parsing, where a
   * malformed body really is a caller's bug worth reporting.
   */

  /** A parse failure is the caller's, not ours — say 400, not 500. */
  const badBody = (error: unknown): Error => {
    const err = error as Error & { statusCode?: number };
    err.statusCode = 400;
    return err;
  };

  /**
   * `curl -d '…'` sends `application/x-www-form-urlencoded` unless you
   * remember to override it, and Fastify parses no such body by default — so
   * the request died with a bare 415 before reaching the handler.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(badBody(error), undefined);
      }
    },
  );

  /**
   * An empty body with a JSON content-type is Fastify's other 400. It is the
   * natural thing to type — these routes need no body, so a caller sets the
   * header out of habit and sends nothing — and refusing it while documenting
   * "no body needed" is a contradiction. Absent is read as `{}`; genuinely
   * malformed JSON is still a 400.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = (body as string).trim();
      if (text === '') return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(badBody(error), undefined);
      }
    },
  );

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
   * A form body carries strings, so `draining=false` arrives as `"false"` —
   * which is truthy, and would have quietly drained a pod an operator was
   * trying to bring back. Absent means drain, since a bare POST to /drain has
   * only one sensible meaning.
   */
  function wantsDraining(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    return !(text === 'false' || text === '0' || text === 'no' || text === '');
  }

  function setDrain(id: string, draining: boolean, reply: FastifyReply, log: FastifyRequest['log']) {
    if (!pods.setDraining(id, draining)) {
      return reply.code(404).send({ detail: 'pod not found' });
    }
    log.info({ podId: id, draining }, 'pod drain flag changed');
    return reply.send({ pod_id: id, draining });
  }

  /**
   * Stop giving a pod new work without killing what it is already running —
   * the polite way to retire a rented pod before destroying it.
   *
   * The body is optional: a bare POST drains. `{"draining": false}` resumes,
   * and so does DELETE below, which is the spelling that needs no body and so
   * no content-type to get wrong.
   */
  app.post<{ Params: { id: string }; Body: { draining?: unknown } }>(
    '/v1/pods/:id/drain',
    async (request, reply) =>
      setDrain(request.params.id, wantsDraining(request.body?.draining), reply, request.log),
  );

  /** Resume dispatch to a drained pod. */
  app.delete<{ Params: { id: string } }>(
    '/v1/pods/:id/drain',
    async (request, reply) => setDrain(request.params.id, false, reply, request.log),
  );
}
