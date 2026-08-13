/**
 * The pod-agent control plane.
 *
 * Four endpoints, all authenticated with the shared agent secret and all
 * fenced by a lease id. Pods dial out to these — nothing ever connects to a
 * pod — so a rented GPU box needs no inbound reachability, no tunnel of its
 * own, and no DNS record.
 *
 *   POST /v1/agent/poll                  register + heartbeat + renew + claim
 *   GET  /v1/agent/jobs/:id/input        the source image bytes
 *   POST /v1/agent/jobs/:id/artifact     the generated mp4 (raw body)
 *   POST /v1/agent/jobs/:id/result       terminal outcome
 *
 * ## Why long-poll and not a WebSocket
 *
 * The correctness requirements (leases, fencing, requeue) are identical either
 * way; a socket would only shave the dispatch latency. What it would add is a
 * reconnect state machine, per-connection send buffers, and a hard dependency
 * on Cloudflare's *undocumented* WebSocket idle timeout. A 25-second poll sits
 * comfortably inside the documented 125-second proxy read timeout and needs
 * none of that.
 */
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { AppContext } from '../context.js';
import { claimForPod, freeSlots, type Assignment } from '../scheduler/claim.js';
import { isSafeFilename } from '../domain/filenames.js';
import { newSessionId } from '../lib/ids.js';
import { ArtifactTooLarge } from '../artifacts/store.js';
import type { Artifact } from '../domain/types.js';
import { apiError } from '../domain/errors.js';

interface InFlightReport {
  job_id?: unknown;
  lease_id?: unknown;
  progress?: unknown;
  phase?: unknown;
  upstream_id?: unknown;
}

interface PollBody {
  pod_id?: unknown;
  agent_version?: unknown;
  max_in_flight?: unknown;
  model_path?: unknown;
  lora_path?: unknown;
  gpu?: unknown;
  sglang_ready?: unknown;
  in_flight?: unknown;
  wait_s?: unknown;
}

interface PollResponse {
  session_id: string;
  lease_ttl_s: number;
  poll_wait_s: number;
  assign: Assignment[];
  /** Jobs the pod should stop working on because a client cancelled them. */
  cancel: string[];
  /** Jobs the pod thinks it owns but no longer does — abandon them locally. */
  orphan: string[];
  drain: boolean;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export default async function agentRoutes(
  app: FastifyInstance,
  opts: FastifyPluginOptions & { ctx: AppContext },
): Promise<void> {
  const { ctx } = opts;
  const { config, jobs, pods, artifacts, waiters } = ctx;

  app.addHook('onRequest', ctx.requireAgentSecret);

  // Artifact uploads arrive as a raw media body. This parser hands the route
  // the untouched stream so the bytes go to disk without ever being buffered
  // in the heap; JSON parsing for the other routes is unaffected.
  app.addContentTypeParser(
    ['video/mp4', 'application/octet-stream'],
    (_request, payload, done) => done(null, payload),
  );

  /**
   * Registration, heartbeat, lease renewal, progress and dispatch in one round
   * trip. Folding them together means an idle pod costs exactly one in-flight
   * request and a busy pod renews its leases for free.
   */
  app.post<{ Body: PollBody }>('/v1/agent/poll', async (request, reply) => {
    const body = request.body ?? {};
    const podId = str(body.pod_id);
    if (!podId) return reply.code(400).send(apiError(400, 'pod_id is required', { code: 'missing_parameter', param: 'pod_id' }));

    const now = Date.now();

    const pod = pods.touch(
      {
        pod_id: podId,
        session_id: newSessionId(),
        agent_version: str(body.agent_version),
        model_path: str(body.model_path),
        lora_path: str(body.lora_path),
        gpu: str(body.gpu),
        max_in_flight: Math.max(
          1,
          typeof body.max_in_flight === 'number' ? Math.floor(body.max_in_flight) : 1,
        ),
        sglang_ready: body.sglang_ready === true,
      },
      now,
    );

    // Renew the lease on everything the agent still claims to be working on.
    // A lease we no longer recognise means the job was requeued and possibly
    // finished elsewhere: tell the agent to drop it rather than let it upload.
    const reported = Array.isArray(body.in_flight) ? (body.in_flight as InFlightReport[]) : [];
    const orphan: string[] = [];
    const cancel: string[] = [];
    const stillOwned = new Set<string>();

    for (const item of reported) {
      const jobId = str(item.job_id);
      const leaseId = str(item.lease_id);
      if (!jobId || !leaseId) continue;

      const progress =
        typeof item.progress === 'number' && item.progress >= 0 && item.progress <= 1
          ? item.progress
          : undefined;
      const renewed = jobs.renewLease(
        jobId,
        leaseId,
        now + config.leaseTtlMs,
        progress,
        str(item.upstream_id),
      );
      if (!renewed) {
        orphan.push(jobId);
        continue;
      }
      stillOwned.add(jobId);
      if (jobs.get(jobId)?.cancel_requested) cancel.push(jobId);
    }

    // A pod that restarted its agent may have lost track of jobs we still
    // consider its own; surface them so it can cancel them upstream.
    for (const job of jobs.listByPod(podId)) {
      if (!stillOwned.has(job.id) && job.cancel_requested) cancel.push(job.id);
    }

    const slots = freeSlots(pod, stillOwned.size);
    let assign = claimForPod(jobs, pod, slots, config.leaseTtlMs, now);

    // Nothing to do — park until work shows up or the poll window closes.
    if (assign.length === 0 && slots > 0 && !pod.draining) {
      const requested =
        typeof body.wait_s === 'number' ? body.wait_s * 1000 : config.maxPollWaitMs;
      const waitMs = Math.min(Math.max(requested, 0), config.maxPollWaitMs);
      const woken = await waiters.wait(waitMs, ctx.shutdownSignal);
      if (woken) {
        assign = claimForPod(jobs, pod, slots, config.leaseTtlMs, Date.now());
      }
    }

    if (assign.length > 0) {
      request.log.info(
        { podId, jobIds: assign.map((a) => a.job_id) },
        'dispatched jobs to pod',
      );
    }

    const response: PollResponse = {
      session_id: pod.session_id,
      lease_ttl_s: Math.round(config.leaseTtlMs / 1000),
      poll_wait_s: Math.round(config.maxPollWaitMs / 1000),
      assign,
      cancel: [...new Set(cancel)],
      orphan,
      drain: pod.draining,
    };
    return reply.send(response);
  });

  /** The source image. Lease-fenced so a stale pod can't read another's input. */
  app.get<{ Params: { id: string }; Querystring: { lease_id?: string } }>(
    '/v1/agent/jobs/:id/input',
    async (request, reply) => {
      const job = jobs.get(request.params.id);
      if (!job) return reply.code(404).send(apiError(404, 'job not found', { code: 'video_not_found' }));
      if (!job.lease_id || job.lease_id !== request.query.lease_id) {
        return reply.code(409).send(apiError(409, 'lease is no longer current', { code: 'stale_lease' }));
      }
      if (!job.input_path) return reply.code(410).send(apiError(410, 'input expired', { code: 'input_expired' }));

      const size = await artifacts.exists(job.input_path);
      if (size === null) return reply.code(410).send(apiError(410, 'input expired', { code: 'input_expired' }));

      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(size))
        .send(createReadStream(job.input_path));
    },
  );

  /**
   * The generated media, as a raw body rather than multipart — there is nothing
   * for an envelope to carry. Streamed straight to disk so a 50 MB clip never
   * lands in the heap, and idempotent on retry because the part file is simply
   * overwritten.
   */
  app.post<{ Params: { id: string }; Querystring: { lease_id?: string; filename?: string } }>(
    '/v1/agent/jobs/:id/artifact',
    async (request, reply) => {
      const job = jobs.get(request.params.id);
      if (!job) return reply.code(404).send(apiError(404, 'job not found', { code: 'video_not_found' }));
      if (!job.lease_id || job.lease_id !== request.query.lease_id) {
        return reply.code(409).send(apiError(409, 'lease is no longer current', { code: 'stale_lease' }));
      }

      const filename = request.query.filename ?? 'output.mp4';
      if (!isSafeFilename(filename)) {
        return reply.code(400).send(apiError(400, 'invalid filename', { code: 'invalid_filename', param: 'filename' }));
      }

      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > config.maxArtifactBytes) {
        return reply.code(413).send(apiError(413, 'artifact too large', { code: 'artifact_too_large' }));
      }

      let stored;
      try {
        stored = await artifacts.writeArtifact(
          job.id,
          filename,
          request.body as Readable,
          config.maxArtifactBytes,
        );
      } catch (error) {
        if (error instanceof ArtifactTooLarge) {
          return reply.code(413).send(apiError(413, error.message, { code: 'artifact_too_large' }));
        }
        throw error;
      }

      const expected = request.headers['x-content-sha256'];
      if (typeof expected === 'string' && expected && expected !== stored.sha256) {
        await artifacts.removeJob(job.id);
        return reply.code(400).send(apiError(400, 'artifact sha256 mismatch', { code: 'checksum_mismatch' }));
      }

      jobs.addEvent(job.id, 'uploaded', job.pod_id, `${stored.bytes} bytes`);
      return reply.send({ filename, bytes: stored.bytes, sha256: stored.sha256 });
    },
  );

  /**
   * Terminal outcome. The agent only calls this after the artifact upload
   * returned 2xx, so a completed job always has its media on disk.
   */
  app.post<{
    Params: { id: string };
    Querystring: { lease_id?: string };
    Body: {
      state?: unknown;
      error?: unknown;
      retryable?: unknown;
      filename?: unknown;
      bytes?: unknown;
      sha256?: unknown;
      upstream_id?: unknown;
    };
  }>('/v1/agent/jobs/:id/result', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send(apiError(404, 'job not found', { code: 'video_not_found' }));

    const leaseId = request.query.lease_id ?? '';
    if (!job.lease_id || job.lease_id !== leaseId) {
      // The defining guarantee: a pod whose lease was revoked cannot overwrite
      // whatever the pod that actually finished the job wrote.
      return reply.code(409).send(apiError(409, 'lease is no longer current', { code: 'stale_lease' }));
    }

    const body = request.body ?? {};
    const now = Date.now();

    if (body.state === 'completed') {
      // SECURITY: this filename becomes a path segment on the gateway's disk
      // when the content is served back. A pod is a realistic adversary — it
      // runs on rented hardware — so `../../` here must never resolve outside
      // the job's own artifact directory.
      const filename = body.filename === undefined ? 'output.mp4' : body.filename;
      if (!isSafeFilename(filename)) {
        return reply.code(400).send(apiError(400, 'invalid filename', { code: 'invalid_filename', param: 'filename' }));
      }
      const artifact: Artifact = {
        media_type: 'video/mp4',
        filename,
        ...(typeof body.bytes === 'number' ? { bytes: body.bytes } : {}),
        ...(str(body.sha256) ? { sha256: str(body.sha256)! } : {}),
      };
      if (!jobs.complete(job.id, leaseId, [artifact], now)) {
        return reply.code(409).send(apiError(409, 'lease is no longer current', { code: 'stale_lease' }));
      }
      pods.recordOutcome(job.pod_id, 'completed');
      await artifacts.removeInput(job.id);
      jobs.clearInput(job.id);
      request.log.info(
        { jobId: job.id, podId: job.pod_id, ms: now - (job.started_at ?? now) },
        'job completed',
      );
      waiters.kick();
      return reply.send({ id: job.id, state: 'completed' });
    }

    if (body.state === 'cancelled') {
      jobs.markCancelled(job.id, leaseId, now, 'acknowledged by pod');
      await artifacts.removeInput(job.id);
      waiters.kick();
      return reply.send({ id: job.id, state: 'cancelled' });
    }

    const message = str(body.error) ?? 'pod reported an unspecified failure';
    // A 5xx or a dropped connection is worth trying on another pod; a 4xx from
    // SGLang means the parameters are wrong and retrying only burns the
    // client's deadline.
    const retryable = body.retryable === true;
    if (retryable && job.attempts < config.maxAttempts) {
      jobs.requeue(job.id, leaseId, message.slice(0, 200));
      pods.recordOutcome(job.pod_id, 'failed');
      request.log.warn({ jobId: job.id, podId: job.pod_id, message }, 'job requeued after pod failure');
      waiters.kick();
      return reply.send({ id: job.id, state: 'queued' });
    }

    if (!jobs.fail(job.id, leaseId, message, now)) {
      return reply.code(409).send(apiError(409, 'lease is no longer current', { code: 'stale_lease' }));
    }
    pods.recordOutcome(job.pod_id, 'failed');
    await artifacts.removeInput(job.id);
    jobs.clearInput(job.id);
    request.log.warn({ jobId: job.id, podId: job.pod_id, message }, 'job failed');
    waiters.kick();
    return reply.send({ id: job.id, state: 'failed' });
  });
}
