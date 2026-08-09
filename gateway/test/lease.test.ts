/**
 * Lease fencing — the property the whole design rests on.
 *
 * Once a job's lease is revoked (expiry, requeue, reassignment), the pod that
 * held it must not be able to write a result, upload an artifact, or read the
 * input. Without this, a pod that finishes work after a network partition
 * overwrites whatever the pod that actually completed the job produced.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  agentHeaders,
  authHeaders,
  submit,
  registerPod,
  makeHarness,
  pollBody,
  type Harness,
} from './helpers.js';
import { sweep } from '../src/scheduler/reaper.js';

const silentLog = { info: () => {}, warn: () => {} };

describe('lease fencing', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function createAndClaim(podId = 'pod-a') {
    await registerPod(h, { pod_id: podId });
    const created = await submit(h);
    assert.equal(created.statusCode, 200, JSON.stringify(created.json()));
    const id = created.json().id as string;
    const poll = await h.app.inject({
      method: 'POST',
      url: '/v1/agent/poll',
      headers: agentHeaders,
      payload: pollBody({ pod_id: podId }),
    });
    const assignment = poll.json().assign[0];
    assert.ok(assignment, 'expected the pod to be handed the queued job');
    return { id, leaseId: assignment.lease_id as string };
  }

  it('rejects a result carrying a lease that is no longer current', async () => {
    const { id } = await createAndClaim();

    const result = await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/result?lease_id=not-the-real-lease`,
      headers: agentHeaders,
      payload: { state: 'completed' },
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().detail, 'stale_lease');

    const job = await h.app.inject({ method: 'GET', url: `/v1/videos/${id}`, headers: authHeaders });
    assert.equal(job.json().status, 'in_progress', 'the impostor must not have moved the job');
  });

  it('stops a superseded pod from clobbering a job another pod completed', async () => {
    const { id, leaseId: firstLease } = await createAndClaim('pod-slow');

    // The slow pod goes silent; its lease expires and the job is requeued.
    h.ctx.jobs.renewLease(id, firstLease, Date.now() - 1000);
    const swept = sweep(
      {
        jobs: h.ctx.jobs,
        pods: h.ctx.pods,
        artifacts: h.ctx.artifacts,
        waiters: h.ctx.waiters,
        maxAttempts: 5,
        cancelGraceMs: h.config.cancelGraceMs,
        podStaleMs: h.config.podStaleMs,
        log: silentLog,
      },
      Date.now(),
    );
    assert.equal(swept.requeued, 1);

    // A second pod picks it up and finishes.
    const poll = await h.app.inject({
      method: 'POST',
      url: '/v1/agent/poll',
      headers: agentHeaders,
      payload: pollBody({ pod_id: 'pod-fast' }),
    });
    const secondLease = poll.json().assign[0].lease_id as string;
    assert.notEqual(secondLease, firstLease);

    await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/artifact?lease_id=${secondLease}`,
      headers: { ...agentHeaders, 'content-type': 'video/mp4' },
      payload: Buffer.from('the real clip'),
    });
    await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/result?lease_id=${secondLease}`,
      headers: agentHeaders,
      payload: { state: 'completed', bytes: 13 },
    });

    // Now the slow pod finally wakes up and tries to report its own result.
    const zombie = await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/result?lease_id=${firstLease}`,
      headers: agentHeaders,
      payload: { state: 'failed', error: 'stale result from a partitioned pod' },
    });
    assert.equal(zombie.statusCode, 409);

    const job = await h.app.inject({ method: 'GET', url: `/v1/videos/${id}`, headers: authHeaders });
    assert.equal(job.json().status, 'completed');
    assert.equal(job.json().error, null);

    const media = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}/content`,
      headers: authHeaders,
    });
    assert.equal(media.rawPayload.toString(), 'the real clip');
  });

  it('refuses an artifact upload under a stale lease before writing bytes', async () => {
    const { id } = await createAndClaim();
    const upload = await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/artifact?lease_id=wrong`,
      headers: { ...agentHeaders, 'content-type': 'video/mp4' },
      payload: Buffer.from('should never land'),
    });
    assert.equal(upload.statusCode, 409);

    const download = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}/content`,
      headers: authHeaders,
    });
    // Still in flight and no artifact recorded: the rejected bytes never became
    // downloadable content.
    assert.equal(download.statusCode, 409);
  });

  it('refuses to hand the input image to a pod that no longer owns the job', async () => {
    const { id, leaseId } = await createAndClaim();

    const ok = await h.app.inject({
      method: 'GET',
      url: `/v1/agent/jobs/${id}/input?lease_id=${leaseId}`,
      headers: agentHeaders,
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.rawPayload.length > 0);

    const denied = await h.app.inject({
      method: 'GET',
      url: `/v1/agent/jobs/${id}/input?lease_id=someone-elses-lease`,
      headers: agentHeaders,
    });
    assert.equal(denied.statusCode, 409);
  });

  it('tells a pod its job was orphaned rather than silently ignoring it', async () => {
    const { id, leaseId } = await createAndClaim('pod-partitioned');
    h.ctx.jobs.requeue(id, leaseId, 'test');

    const poll = await h.app.inject({
      method: 'POST',
      url: '/v1/agent/poll',
      headers: agentHeaders,
      payload: pollBody({
        pod_id: 'pod-partitioned',
        in_flight: [{ job_id: id, lease_id: leaseId, progress: 0.5 }],
      }),
    });
    assert.deepEqual(poll.json().orphan, [id]);
  });

  it('fails a job instead of requeueing it forever once attempts run out', async () => {
    const { id, leaseId } = await createAndClaim();
    h.ctx.jobs.renewLease(id, leaseId, Date.now() - 1000);

    const swept = sweep(
      {
        jobs: h.ctx.jobs,
        pods: h.ctx.pods,
        artifacts: h.ctx.artifacts,
        waiters: h.ctx.waiters,
        maxAttempts: 1, // this job already used its single attempt
        cancelGraceMs: h.config.cancelGraceMs,
        podStaleMs: h.config.podStaleMs,
        log: silentLog,
      },
      Date.now(),
    );
    assert.equal(swept.failed, 1);

    const job = await h.app.inject({ method: 'GET', url: `/v1/videos/${id}`, headers: authHeaders });
    assert.equal(job.json().status, 'failed');
    assert.match(job.json().error.message, /pod lost during generation/);
  });
});
