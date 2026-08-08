/**
 * The client-facing job API.
 *
 * Create → poll → download: `POST /v1/jobs` returns immediately with a job id,
 * `GET /v1/jobs/{id}` reports progress, and a completed job carries a relative
 * artifact URL served by this gateway. The shape is documented in docs/api.md
 * and pinned by test/contract.test.ts.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AppContext } from '../context.js';
import { probeDimensions } from '../domain/probe.js';
import { decodeImage, InputError } from '../domain/inputs.js';
import { clamp, getPipeline, pipelineNames } from '../domain/pipelines.js';
import { isResolution } from '../domain/sizing.js';
import { fitSize } from '../domain/sizing.js';
import { toJobResponse } from '../domain/serialize.js';
import { isJobState, type JobParams, type JobState } from '../domain/types.js';
import { newJobId } from '../lib/ids.js';

interface CreateBody {
  pipeline?: unknown;
  params?: Record<string, unknown>;
}

export default async function jobRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext },
): Promise<void> {
  const { ctx } = opts;
  const { config, jobs, artifacts, waiters } = ctx;

  app.addHook('preHandler', ctx.requireApiKey);

  app.post('/v1/jobs', async (request, reply) => {
    const body = (request.body ?? {}) as CreateBody;

    const spec = getPipeline(body.pipeline);
    if (!spec) {
      return reply.code(404).send({
        detail: `unknown pipeline ${JSON.stringify(body.pipeline)}`,
        available: pipelineNames(),
      });
    }

    const params = body.params ?? {};
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (!prompt) return reply.code(400).send({ detail: 'params.prompt is required' });
    if (prompt.length > spec.maxPromptChars) {
      return reply
        .code(400)
        .send({ detail: `params.prompt exceeds ${spec.maxPromptChars} characters` });
    }

    const resolution = params.resolution ?? '480p';
    if (!isResolution(resolution) || !spec.resolutions.includes(resolution)) {
      return reply.code(400).send({
        detail: `params.resolution must be one of ${spec.resolutions.join(', ')}`,
      });
    }

    // Admission control. Queueing past the point where the backlog cannot clear
    // inside the client's deadline just converts "no capacity" into twenty
    // minutes of polling followed by a timeout — a fast 503 is kinder and lets
    // the caller fall back to another provider.
    const counts = jobs.counts();
    if (counts.queued >= config.maxQueueDepth) {
      return reply
        .code(503)
        .header('retry-after', '30')
        .send({ detail: 'inference queue is full', queue_depth: counts.queued + counts.running });
    }

    let image;
    try {
      image = decodeImage(params.image, config.maxInputBytes);
    } catch (error) {
      if (error instanceof InputError) return reply.code(400).send({ detail: error.message });
      throw error;
    }

    const dims = probeDimensions(image.bytes);
    if (!dims) {
      return reply.code(400).send({ detail: 'params.image header could not be read' });
    }
    const size = fitSize(dims.width, dims.height, resolution);

    const negative =
      typeof params.negative_prompt === 'string' && params.negative_prompt.trim()
        ? params.negative_prompt.trim()
        : spec.negativePrompt;

    // Generation knobs are gateway-owned and clamped: a client-chosen step
    // count or duration is a queue-starvation lever, not a feature.
    const jobParams: JobParams = {
      prompt,
      negative_prompt: negative,
      resolution,
      size,
      seconds: clamp(
        typeof params.seconds === 'number' ? params.seconds : spec.defaults.seconds,
        1,
        spec.limits.maxSeconds,
      ),
      num_inference_steps: clamp(
        typeof params.num_inference_steps === 'number'
          ? Math.round(params.num_inference_steps)
          : spec.defaults.num_inference_steps,
        1,
        spec.limits.maxSteps,
      ),
      guidance_scale: spec.defaults.guidance_scale,
      seed:
        typeof params.seed === 'number' && Number.isSafeInteger(params.seed) ? params.seed : null,
    };

    const now = Date.now();
    const id = newJobId();
    const inputPath = await artifacts.writeInput(id, image.extension, image.bytes);

    const job = jobs.create({
      id,
      pipeline: body.pipeline as string,
      params: jobParams,
      input_path: inputPath,
      input_sha256: image.sha256,
      input_bytes: image.bytes.length,
      created_at: now,
      deadline_at: now + config.jobTtlMs,
    });

    // Wake any pod parked in a long-poll so this dispatches now, not in 25s.
    waiters.kick();

    request.log.info(
      { jobId: id, pipeline: job.pipeline, size, queued: counts.queued + 1 },
      'job created',
    );
    return reply.code(202).send(toJobResponse(job, jobs.queuePosition(job)));
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ detail: 'job not found' });
    return reply.send(toJobResponse(job, jobs.queuePosition(job)));
  });

  app.get<{ Querystring: { limit?: string; state?: string } }>('/v1/jobs', async (request, reply) => {
    const { limit, state } = request.query;
    if (state !== undefined && !isJobState(state)) {
      return reply.code(400).send({ detail: `unknown state ${JSON.stringify(state)}` });
    }
    const list = jobs.list({
      state: state as JobState | undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return reply.send({ jobs: list.map((job) => toJobResponse(job, jobs.queuePosition(job))) });
  });

  app.delete<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ detail: 'job not found' });

    const now = Date.now();
    if (job.state === 'queued') {
      if (jobs.cancelQueued(job.id, now)) {
        return reply.send({ id: job.id, state: 'cancelled' });
      }
      // Lost a race with a claiming poll — fall through and treat as running.
    }

    if (jobs.get(job.id)?.state === 'running') {
      jobs.requestCancel(job.id, now);
      // NOTE: `cancelling` is reported here only, never as the job's own
      // `state` — the consumer's toJob() throws on an unmapped state. The job
      // stays `running` until the pod acknowledges or the reaper forces it.
      return reply.send({ id: job.id, state: 'cancelling' });
    }

    return reply.code(409).send({ detail: `job is already ${jobs.get(job.id)?.state}` });
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id/events', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ detail: 'job not found' });
    return reply.send({ id: job.id, events: jobs.events(job.id) });
  });

  app.get('/v1/pipelines', async (_request, reply) => {
    return reply.send({
      pipelines: pipelineNames().map((name) => {
        const spec = getPipeline(name)!;
        return { name, resolutions: spec.resolutions, defaults: spec.defaults };
      }),
    });
  });
}
