/**
 * Dispatch policy: who gets work, who is passed over, and what happens when
 * nobody can take a job.
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
  MODEL,
  type Harness,
} from './helpers.js';
import { freeSlots } from '../src/scheduler/claim.js';
import { sweep } from '../src/scheduler/reaper.js';

const silentLog = { info: () => {}, warn: () => {} };

describe('scheduling', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /**
   * Creating a video needs a pod serving the model, so every case registers one
   * first. `sglang_ready: false` keeps that pod from claiming what it created —
   * capacity that is warming counts for admission, not for dispatch.
   */
  const create = async (overrides: Record<string, string> = {}) => {
    await registerPod(h, { pod_id: 'pod-admission', sglang_ready: false });
    const res = await submit(h, overrides);
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    return res.json().id as string;
  };

  const poll = async (body = {}) =>
    (
      await h.app.inject({
        method: 'POST',
        url: '/v1/agent/poll',
        headers: agentHeaders,
        payload: pollBody(body),
      })
    ).json();

  it('withholds work from a pod whose model has not finished loading', async () => {
    const id = await create();

    // The agent connects the moment the container starts, but sglang needs
    // ~10 minutes to load a 14B model — and a RAM-starved pod OOM-loops and
    // never becomes ready at all. Treating "the agent is talking" as capacity
    // would route every job to a pod that can never finish one.
    const cold = await poll({ pod_id: 'pod-cold', sglang_ready: false });
    assert.deepEqual(cold.assign, []);

    const warm = await poll({ pod_id: 'pod-warm', sglang_ready: true });
    assert.equal(warm.assign.length, 1);
    assert.equal(warm.assign[0].job_id, id);
  });

  it('derives what a pod serves from its model rather than its say-so', async () => {
    const id = await create();

    // A pod whose weights the registry doesn't recognise is not capacity, no
    // matter how healthy its agent looks.
    const unknown = await poll({ pod_id: 'pod-unknown', model_path: 'someone/some-other-model' });
    assert.deepEqual(unknown.assign, []);
    assert.equal(h.ctx.pods.get('pod-unknown')!.model, null);

    // The same weights reached by local path are the same weights.
    const local = await poll({
      pod_id: 'pod-local',
      model_path: '/workspace/models/Wan2.2-I2V-A14B-Diffusers',
    });
    assert.equal(h.ctx.pods.get('pod-local')!.model, MODEL);
    assert.equal(local.assign.length, 1);
    assert.equal(local.assign[0].job_id, id);
  });

  it('does not let a job for an unserved model block one the pod can run', async () => {
    // Queue a job for a model nothing serves, then a runnable one behind it.
    const blocked = h.ctx.jobs.create({
      id: 'video_blockedblock',
      model: 'someone/some-other-model',
      params: {
        prompt: 'x',
        negative_prompt: '',
        resolution: '480p',
        size: '480x832',
        seconds: 5,
        num_inference_steps: 4,
        guidance_scale: 1,
        seed: null,
      },
      input_path: '/dev/null',
      input_sha256: 'x',
      input_bytes: 1,
      created_at: Date.now() - 10_000, // strictly older, so it sorts first
      deadline_at: Date.now() + 600_000,
    });
    const runnable = await create();

    const result = await poll({ pod_id: 'pod-a' });
    assert.equal(result.assign.length, 1);
    assert.equal(result.assign[0].job_id, runnable);
    assert.equal(h.ctx.jobs.get(blocked.id)!.state, 'queued');
  });

  it('never hands a pod more than its declared concurrency', async () => {
    await create();
    await create();
    await create();

    const first = await poll({ pod_id: 'pod-a', max_in_flight: 2 });
    assert.equal(first.assign.length, 2);

    // Still holding both — the third job must wait.
    const second = await poll({
      pod_id: 'pod-a',
      max_in_flight: 2,
      in_flight: first.assign.map((a: { job_id: string; lease_id: string }) => ({
        job_id: a.job_id,
        lease_id: a.lease_id,
      })),
    });
    assert.deepEqual(second.assign, []);
  });

  it('stops dispatching to a draining pod without disturbing its current work', async () => {
    const first = await create();
    const assigned = await poll({ pod_id: 'pod-retiring' });
    assert.equal(assigned.assign[0].job_id, first);

    h.ctx.pods.setDraining('pod-retiring', true);
    await create();

    const after = await poll({
      pod_id: 'pod-retiring',
      max_in_flight: 4,
      in_flight: [{ job_id: first, lease_id: assigned.assign[0].lease_id }],
    });
    assert.deepEqual(after.assign, []);
    assert.equal(after.drain, true);
    assert.equal(h.ctx.jobs.get(first)!.state, 'in_progress', 'draining must not abandon live work');
  });

  it('drains however an operator spells the request', async () => {
    await registerPod(h, { pod_id: 'pod-drain' });

    // `curl -d '…'` sends form-urlencoded unless you override it, which used
    // to die as a bare 415 before the handler ever ran.
    const shapes: Array<[string, Record<string, string>, string | undefined]> = [
      ['POST', {}, undefined],
      ['POST', { 'content-type': 'application/json' }, JSON.stringify({ draining: true })],
      ['POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'draining=true'],
    ];
    for (const [method, headers, payload] of shapes) {
      const res = await h.app.inject({
        method: method as 'POST',
        url: '/v1/pods/pod-drain/drain',
        headers: { ...authHeaders, ...headers },
        ...(payload === undefined ? {} : { payload }),
      });
      assert.equal(res.statusCode, 200, `${JSON.stringify(headers)} must be accepted`);
      assert.equal(res.json().draining, true);
      assert.equal(h.ctx.pods.get('pod-drain')!.draining, true);
      h.ctx.pods.setDraining('pod-drain', false);
    }

    // Resuming: a JSON false, a form false, or a bodyless DELETE.
    for (const [headers, payload] of [
      [{ 'content-type': 'application/json' }, JSON.stringify({ draining: false })],
      [{ 'content-type': 'application/x-www-form-urlencoded' }, 'draining=false'],
    ] as const) {
      h.ctx.pods.setDraining('pod-drain', true);
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/pods/pod-drain/drain',
        headers: { ...authHeaders, ...headers },
        payload,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(h.ctx.pods.get('pod-drain')!.draining, false, `${payload} must resume`);
    }

    h.ctx.pods.setDraining('pod-drain', true);
    const resumed = await h.app.inject({
      method: 'DELETE',
      url: '/v1/pods/pod-drain/drain',
      headers: authHeaders,
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(h.ctx.pods.get('pod-drain')!.draining, false);

    const missing = await h.app.inject({
      method: 'DELETE',
      url: '/v1/pods/nope/drain',
      headers: authHeaders,
    });
    assert.equal(missing.statusCode, 404);
  });

  it('keeps a job queued while its pod is still warming, and reports the wait', async () => {
    const id = await create();
    const job = await h.app.inject({ method: 'GET', url: `/v1/videos/${id}`, headers: authHeaders });
    assert.equal(job.json().status, 'queued');
    assert.equal(job.json().queue_position, 0);

    const health = await h.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.json().queued, 1);
    assert.equal(health.json().queue_depth, 1);
    assert.equal(health.json().pods.ready, 0);
  });

  it('fails an over-deadline job with an explanation instead of letting the client time out', async () => {
    const id = await create();
    // Pull the deadline into the past, as if the job had sat unclaimed.
    h.db.prepare('UPDATE jobs SET deadline_at = ? WHERE id = ?').run(Date.now() - 1000, id);

    sweep(
      {
        jobs: h.ctx.jobs,
        pods: h.ctx.pods,
        artifacts: h.ctx.artifacts,
        waiters: h.ctx.waiters,
        maxAttempts: 2,
        cancelGraceMs: h.config.cancelGraceMs,
        podStaleMs: h.config.podStaleMs,
        log: silentLog,
      },
      Date.now(),
    );

    const job = await h.app.inject({ method: 'GET', url: `/v1/videos/${id}`, headers: authHeaders });
    assert.equal(job.json().status, 'failed');
    assert.match(job.json().error.message, /exceeded its .* deadline \(queued .*, running .*\)/);
  });

  it('refuses new work once the queue is past its ceiling', async () => {
    const small = await makeHarness({ MAX_QUEUE_DEPTH: '1' });
    try {
      await registerPod(small, { sglang_ready: false });

      const first = await submit(small);
      assert.equal(first.statusCode, 200);

      const rejected = await submit(small);
      assert.equal(rejected.statusCode, 503);
      assert.equal(rejected.headers['retry-after'], '30');
      assert.match(rejected.json().detail, /queue is full/);
    } finally {
      await small.cleanup();
    }
  });

  it('refuses work outright when no pod is serving the model at all', async () => {
    // Nothing registered: the video could only sit in the queue until its
    // deadline, so a fast 503 beats twenty minutes of polling.
    const res = await submit(h);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '30');
    assert.match(res.json().detail, /no pod is serving/);
  });

  it('re-dispatches in-flight work after a gateway restart rather than failing it', async () => {
    const id = await create();
    const assigned = await poll({ pod_id: 'pod-a' });
    const leaseId = assigned.assign[0].lease_id;

    // Simulate the restart path: leases extended, nothing failed.
    const recovered = h.ctx.jobs.recoverOnStartup(Date.now(), 60_000);
    assert.equal(recovered, 1);
    assert.equal(h.ctx.jobs.get(id)!.state, 'in_progress');

    // The pod comes back and re-claims with the lease it still holds.
    const resumed = await poll({
      pod_id: 'pod-a',
      in_flight: [{ job_id: id, lease_id: leaseId, progress: 0.4 }],
    });
    assert.deepEqual(resumed.orphan, []);
    assert.equal(h.ctx.jobs.get(id)!.progress, 0.4);
  });

  it('counts free slots only for pods that can actually take work', () => {
    const base = {
      pod_id: 'p',
      session_id: 's',
      first_seen_at: 0,
      last_seen_at: 0,
      agent_version: null,
      model_path: 'Wan-AI/Wan2.2-I2V-A14B-Diffusers',
      lora_path: null,
      model: MODEL,
      gpu: null,
      max_in_flight: 2,
      jobs_completed: 0,
      jobs_failed: 0,
    };
    assert.equal(freeSlots({ ...base, sglang_ready: true, draining: false }, 0), 2);
    assert.equal(freeSlots({ ...base, sglang_ready: true, draining: false }, 2), 0);
    assert.equal(freeSlots({ ...base, sglang_ready: false, draining: false }, 0), 0);
    assert.equal(freeSlots({ ...base, sglang_ready: true, draining: true }, 0), 0);
  });
});
