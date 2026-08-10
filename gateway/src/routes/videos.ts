/**
 * The client-facing video API.
 *
 * Deliberately the same surface SGLang Diffusion exposes — which is OpenAI's:
 *
 *   POST   /v1/videos              multipart create, returns a video object
 *   GET    /v1/videos/{id}         status and progress
 *   GET    /v1/videos              list, newest first
 *   DELETE /v1/videos/{id}         cancel
 *   GET    /v1/videos/{id}/content the rendered media
 *   GET    /v1/videos/{id}/events  lifecycle trail (gateway extra)
 *
 * A client that can talk to SGLang directly can talk to a fleet of pods through
 * this gateway by changing the base URL and nothing else. The shape is
 * documented in docs/api.md and pinned by test/contract.test.ts.
 */
import { createReadStream } from 'node:fs';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AppContext } from '../context.js';
import { probeDimensions } from '../domain/probe.js';
import { readImage, InputError } from '../domain/inputs.js';
import { clamp, getModel, modelNames, resolveModelId } from '../domain/models.js';
import { checkSize, fitSize, isResolution, type Resolution } from '../domain/sizing.js';
import { toVideoResponse } from '../domain/serialize.js';
import { apiError } from '../domain/errors.js';
import { isVideoStatus, type JobParams, type VideoStatus } from '../domain/types.js';
import { newVideoId } from '../lib/ids.js';

const MEDIA_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

interface Upload {
  fields: Record<string, string>;
  image: Buffer | null;
}

/** Pull the form fields and the single `input_reference` file out of the body. */
async function readUpload(request: {
  parts: () => AsyncIterableIterator<
    | { type: 'file'; fieldname: string; toBuffer: () => Promise<Buffer> }
    | { type: 'field'; fieldname: string; value: unknown }
  >;
}): Promise<Upload> {
  const fields: Record<string, string> = {};
  let image: Buffer | null = null;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      // Every file part must be drained or the request stalls, even the ones
      // we have no use for.
      const bytes = await part.toBuffer();
      if (part.fieldname === 'input_reference' && image === null) image = bytes;
    } else {
      fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
    }
  }
  return { fields, image };
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function videoRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext },
): Promise<void> {
  const { ctx } = opts;
  const { config, jobs, pods, artifacts, waiters } = ctx;

  app.addHook('preHandler', ctx.requireApiKey);

  // Registered inside this plugin so the agent's raw-body parser for artifact
  // uploads is untouched.
  await app.register(multipart, {
    limits: { fileSize: config.maxInputBytes, files: 2, fields: 20 },
  });

  const respond = (job: Parameters<typeof toVideoResponse>[0]) =>
    toVideoResponse(job, jobs.queuePosition(job), config.artifactTtlMs);

  const noSuchVideo = (id: string) =>
    apiError(404, `no such video ${id}`, { code: 'video_not_found', param: 'id' });

  app.post('/v1/videos', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply
        .code(415)
        .send(
          apiError(415, 'POST /v1/videos takes multipart/form-data with an input_reference file', {
            code: 'unsupported_media_type',
          }),
        );
    }

    let upload: Upload;
    try {
      upload = await readUpload(request as never);
    } catch (error) {
      // The multipart plugin aborts the stream the moment the file exceeds the
      // limit, so the bytes never accumulate anywhere.
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply
          .code(413)
          .send(
            apiError(413, `input_reference exceeds the ${config.maxInputBytes} byte limit`, {
              code: 'input_too_large',
              param: 'input_reference',
            }),
          );
      }
      throw error;
    }

    const { fields } = upload;
    const spec = getModel(fields.model);
    if (!spec) {
      return reply.code(404).send({
        ...apiError(404, `unknown model ${JSON.stringify(fields.model ?? null)}`, {
          code: 'model_not_found',
          param: 'model',
        }),
        available: modelNames(),
      });
    }
    const model = resolveModelId(fields.model)!;

    const prompt = (fields.prompt ?? '').trim();
    if (!prompt) {
      return reply
        .code(400)
        .send(apiError(400, 'prompt is required', { code: 'missing_parameter', param: 'prompt' }));
    }
    if (prompt.length > spec.maxPromptChars) {
      return reply
        .code(400)
        .send(
          apiError(400, `prompt exceeds ${spec.maxPromptChars} characters`, {
            code: 'prompt_too_long',
            param: 'prompt',
          }),
        );
    }

    // No pod in the fleet loaded these weights, so this job could only ever sit
    // in the queue until its deadline. A pod that is connected but still
    // warming counts: capacity that is arriving in ten minutes is capacity.
    const servingPods = pods
      .listConnected(Date.now() - config.podStaleMs)
      .filter((pod) => pod.model === model && !pod.draining);
    if (servingPods.length === 0) {
      return reply
        .code(503)
        .header('retry-after', '30')
        .send({
          ...apiError(503, `no pod is serving ${model}`, {
            code: 'no_capacity',
            param: 'model',
          }),
          model,
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
        .send({
          ...apiError(503, 'inference queue is full', { code: 'queue_full' }),
          queue_depth: counts.queued + counts.running,
        });
    }

    if (!upload.image) {
      return reply.code(400).send(
        apiError(400, 'input_reference is required', {
          code: 'missing_parameter',
          param: 'input_reference',
        }),
      );
    }

    let image;
    try {
      image = readImage(upload.image, config.maxInputBytes);
    } catch (error) {
      if (error instanceof InputError) {
        return reply
          .code(400)
          .send(apiError(400, error.message, { code: 'invalid_image', param: 'input_reference' }));
      }
      throw error;
    }

    const dims = probeDimensions(image.bytes);
    if (!dims) {
      return reply.code(400).send(
        apiError(400, 'input_reference header could not be read', {
          code: 'invalid_image',
          param: 'input_reference',
        }),
      );
    }

    // `size` is optional: name a frame and it is validated, or omit it and the
    // gateway derives an aspect-preserving one from the image itself.
    let size: string;
    let resolution: Resolution;
    const requested = (fields.size ?? '').trim();
    if (requested === '') {
      resolution = '480p';
      size = fitSize(dims.width, dims.height, resolution);
    } else if (isResolution(requested)) {
      if (!spec.resolutions.includes(requested)) {
        return reply
          .code(400)
          .send(
            apiError(400, `size must be one of ${spec.resolutions.join(', ')} or WxH`, {
              code: 'invalid_size',
              param: 'size',
            }),
          );
      }
      resolution = requested;
      size = fitSize(dims.width, dims.height, resolution);
    } else {
      const checked = checkSize(requested, spec.resolutions);
      if (!checked) {
        return reply.code(400).send(
          apiError(
            400,
            `size ${JSON.stringify(requested)} is not a 16-aligned frame within ${spec.resolutions.join(
              '/',
            )} limits`,
            { code: 'invalid_size', param: 'size' },
          ),
        );
      }
      size = checked.size;
      resolution = checked.resolution;
    }

    const negative = (fields.negative_prompt ?? '').trim() || spec.negativePrompt;

    // Step count, duration and guidance are gateway-owned and clamped: a
    // client-chosen step count is a queue-starvation lever, not a feature.
    const seed = num(fields.seed);
    const jobParams: JobParams = {
      prompt,
      negative_prompt: negative,
      resolution,
      size,
      seconds: clamp(num(fields.seconds) ?? spec.defaults.seconds, 1, spec.limits.maxSeconds),
      num_inference_steps: clamp(
        Math.round(num(fields.num_inference_steps) ?? spec.defaults.num_inference_steps),
        1,
        spec.limits.maxSteps,
      ),
      guidance_scale: spec.defaults.guidance_scale,
      seed: seed !== null && Number.isSafeInteger(seed) ? seed : null,
    };

    const now = Date.now();
    const id = newVideoId();
    const inputPath = await artifacts.writeInput(id, image.extension, image.bytes);

    const job = jobs.create({
      id,
      model,
      params: jobParams,
      input_path: inputPath,
      input_sha256: image.sha256,
      input_bytes: image.bytes.length,
      created_at: now,
      deadline_at: now + config.jobTtlMs,
    });

    // Wake any pod parked in a long-poll so this dispatches now, not in 25s.
    waiters.kick();

    request.log.info({ videoId: id, model, size, queued: counts.queued + 1 }, 'video created');
    return reply.send(respond(job));
  });

  app.get<{ Params: { id: string } }>('/v1/videos/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send(noSuchVideo(request.params.id));
    return reply.send(respond(job));
  });

  app.get<{ Querystring: { limit?: string; status?: string } }>(
    '/v1/videos',
    async (request, reply) => {
      const { limit, status } = request.query;
      if (status !== undefined && !isVideoStatus(status)) {
        return reply.code(400).send(
          apiError(400, `unknown status ${JSON.stringify(status)}`, {
            code: 'invalid_status',
            param: 'status',
          }),
        );
      }
      const list = jobs.list({
        state: status as VideoStatus | undefined,
        limit: limit ? Number(limit) : undefined,
      });
      return reply.send({ object: 'list', data: list.map(respond) });
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/videos/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send(noSuchVideo(request.params.id));

    const now = Date.now();
    if (job.state === 'queued') {
      if (jobs.cancelQueued(job.id, now)) return reply.send(respond(jobs.get(job.id)!));
      // Lost a race with a claiming poll — fall through and treat as in-flight.
    }

    if (jobs.get(job.id)?.state === 'in_progress') {
      // The video stays `in_progress` until the pod acknowledges or the reaper
      // forces it: there is deliberately no `cancelling` status, because a
      // client is entitled to map exactly the five documented ones.
      jobs.requestCancel(job.id, now);
      return reply.code(202).send(respond(jobs.get(job.id)!));
    }

    return reply.code(409).send(
      apiError(409, `video is already ${jobs.get(job.id)?.state}`, { code: 'already_finished' }),
    );
  });

  /**
   * The rendered media. The filename is read from the job record rather than
   * the URL, so there is no client-supplied path segment to validate — a pod
   * can still only ever write a filename that passed `isSafeFilename`.
   */
  app.get<{ Params: { id: string } }>('/v1/videos/:id/content', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send(noSuchVideo(request.params.id));

    const artifact = job.artifacts[0];
    if (!artifact) {
      if (job.state === 'completed') {
        return reply.code(410).send(
          apiError(410, 'content expired', { code: 'content_expired' }),
        );
      }
      return reply.code(409).send(
        apiError(409, `video is ${job.state}, no content yet`, { code: 'content_not_ready' }),
      );
    }

    const path = artifacts.resolveArtifact(job.id, artifact.filename);
    if (!path) {
      return reply.code(404).send(apiError(404, 'content not found', { code: 'content_not_found' }));
    }

    const size = await artifacts.exists(path);
    if (size === null) {
      // Distinguish "never existed" from "swept by the TTL": both are a failed
      // download to the client, but only one is a bug.
      return reply.code(410).send(apiError(410, 'content expired', { code: 'content_expired' }));
    }

    const extension = artifact.filename.split('.').pop()?.toLowerCase() ?? '';
    const reply200 = reply
      .header('content-type', MEDIA_TYPES[extension] ?? artifact.media_type ?? 'application/octet-stream')
      .header('content-length', String(size))
      .header('content-disposition', `inline; filename="${artifact.filename}"`);
    if (artifact.sha256) reply200.header('x-content-sha256', artifact.sha256);
    return reply200.send(createReadStream(path));
  });

  app.get<{ Params: { id: string } }>('/v1/videos/:id/events', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send(noSuchVideo(request.params.id));
    // The list envelope, like every other collection this API returns.
    return reply.send({ object: 'list', data: jobs.events(job.id) });
  });
}
