/**
 * The contract guard.
 *
 * `parseVideo` below is a deliberately *strict* model of how a well-written
 * OpenAI-shaped client consumes this API, written against the documented
 * contract in docs/api.md — not a copy of any particular client. Every gateway
 * response, in every status, is run through it.
 *
 * The point is to make the contract executable. A refactor that renames a
 * field, changes a status string, or starts emitting millisecond timestamps
 * fails here, at build time, instead of silently breaking integrations at run
 * time.
 *
 * Being strict is the whole design: it maps exactly the five documented
 * statuses and treats anything else as an error. Loosening it to make a test
 * pass defeats the purpose — change the gateway, or change the documented
 * contract and the clients along with it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  agentHeaders,
  authHeaders,
  makeHarness,
  pollBody,
  registerPod,
  submit,
  MODEL,
  type Harness,
} from './helpers.js';

/** The five documented statuses, mapped to a generic client-side vocabulary. */
const STATUS_MAP: Record<string, string> = {
  queued: 'starting',
  in_progress: 'processing',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'canceled',
};

/** Returns null when the payload is not a video a strict client would accept. */
function parseVideo(payload: unknown) {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  if (raw.object !== 'video') return null;
  if (typeof raw.id !== 'string' || !/^video_[0-9a-f]{12}$/.test(raw.id)) return null;
  if (typeof raw.model !== 'string' || raw.model === '') return null;

  const status = typeof raw.status === 'string' ? STATUS_MAP[raw.status] : undefined;
  if (!status) return null;

  // Unix seconds, not milliseconds: a client that multiplies by 1000 to build a
  // Date must not land in the year 57000.
  if (!Number.isInteger(raw.created_at)) return null;
  const createdAt = raw.created_at as number;
  if (createdAt < 1_000_000_000 || createdAt > 4_000_000_000) return null;

  // An integer percentage, like OpenAI's — never a 0-1 fraction.
  if (!Number.isInteger(raw.progress)) return null;
  const progress = raw.progress as number;
  if (progress < 0 || progress > 100) return null;

  let error: string | null = null;
  if (raw.error !== null) {
    if (typeof raw.error !== 'object' || raw.error === null) return null;
    const err = raw.error as Record<string, unknown>;
    if (typeof err.code !== 'string' || typeof err.message !== 'string') return null;
    error = err.message;
  }

  return {
    id: raw.id,
    model: raw.model as string,
    status,
    progress,
    createdAt,
    error,
    /** The download path is derived from the id — the server never hands one over. */
    contentUrl: `/v1/videos/${raw.id}/content`,
  };
}

describe('client contract', () => {
  // A fresh harness per test: these cases claim work from the queue, and a
  // shared queue would let one test's poll pick up another test's video.
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /** Register a warming pod, so create is admitted but nothing claims it yet. */
  const admit = () => registerPod(h, { pod_id: 'pod-admission', sglang_ready: false });

  it('parses a freshly created video as "starting"', async () => {
    await admit();
    const created = await submit(h);
    assert.equal(created.statusCode, 200);

    const video = parseVideo(created.json());
    assert.ok(video, 'a strict client must be able to parse the create response');
    assert.equal(video.status, 'starting');
    assert.equal(video.model, MODEL);
    assert.equal(video.progress, 0);
    assert.equal(video.error, null);
  });

  it('parses every reachable status, and never emits an unmapped one', async () => {
    await admit();
    const created = await submit(h);
    const id = created.json().id as string;

    // A cancel of a queued video — the only terminal status reachable with no
    // warm pod in the fleet.
    const cancelled = await h.app.inject({
      method: 'DELETE',
      url: `/v1/videos/${id}`,
      headers: authHeaders,
    });
    assert.equal(cancelled.statusCode, 200);

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}`,
      headers: authHeaders,
    });
    const video = parseVideo(fetched.json());
    assert.ok(video, 'a cancelled video must still parse');
    assert.equal(video.status, 'canceled');
  });

  it('reports a cancelling video as "processing", never as "cancelling"', async () => {
    await registerPod(h);
    const created = await submit(h);
    const id = created.json().id as string;
    await registerPod(h); // the pod claims it

    // The client cancels mid-flight. There is no sixth status to leak: the
    // video stays in_progress until the pod acknowledges.
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/v1/videos/${id}`,
      headers: authHeaders,
    });
    assert.equal(del.statusCode, 202);
    assert.equal(del.json().status, 'in_progress');

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}`,
      headers: authHeaders,
    });
    const video = parseVideo(fetched.json());
    assert.ok(video, 'a video being cancelled must not break a strict client');
    assert.equal(video.status, 'processing');
  });

  it('serves the media at the conventional content path', async () => {
    await registerPod(h, { pod_id: 'pod-artifact' });
    const created = await submit(h);
    const id = created.json().id as string;

    const poll = await registerPod(h, { pod_id: 'pod-artifact' });
    const assignment = poll.assign[0];
    assert.equal(assignment.job_id, id);
    assert.equal(assignment.model, MODEL);

    const media = Buffer.from('fake mp4 bytes');
    const upload = await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/artifact?lease_id=${assignment.lease_id}`,
      headers: { ...agentHeaders, 'content-type': 'video/mp4' },
      payload: media,
    });
    assert.equal(upload.statusCode, 200);

    await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/result?lease_id=${assignment.lease_id}`,
      headers: agentHeaders,
      payload: { state: 'completed', filename: 'output.mp4', bytes: media.length },
    });

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}`,
      headers: authHeaders,
    });
    const video = parseVideo(fetched.json());
    assert.ok(video);
    assert.equal(video.status, 'succeeded');
    assert.equal(video.progress, 100);

    // A completed video advertises when its media is swept, so a client knows
    // how long it has to download.
    assert.ok(fetched.json().expires_at > fetched.json().created_at);

    // The path is built from the id alone. There is no server-supplied URL to
    // validate, which is what makes a poisoned filename structurally unable to
    // reach a client's authenticated fetch.
    const download = await h.app.inject({
      method: 'GET',
      url: video.contentUrl,
      headers: authHeaders,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'video/mp4');
    assert.deepEqual(download.rawPayload, media);
  });

  it('rejects a payload a strict client could not map', () => {
    const good = {
      id: 'video_aaaaaaaaaaaa',
      object: 'video',
      model: MODEL,
      status: 'completed',
      progress: 100,
      created_at: 1_800_000_000,
      error: null,
    };
    assert.ok(parseVideo(good));

    for (const bad of [
      { ...good, object: 'job' },
      { ...good, id: 'j_aaaaaaaaaaaa' },
      { ...good, status: 'running' },
      { ...good, status: 'cancelling' },
      { ...good, progress: 0.5 },
      { ...good, progress: 101 },
      { ...good, created_at: 1_800_000_000_000 }, // milliseconds
      { ...good, error: 'a bare string' },
      { ...good, model: '' },
    ]) {
      assert.equal(parseVideo(bad), null, `${JSON.stringify(bad)} must not parse`);
    }
  });

  it('lists videos in the OpenAI list envelope', async () => {
    await admit();
    await submit(h);
    const list = await h.app.inject({ method: 'GET', url: '/v1/videos', headers: authHeaders });
    const body = list.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);
    assert.ok(parseVideo(body.data[0]), 'every listed item must parse as a video');
  });

  it('advertises only models the fleet is actually serving', async () => {
    const empty = await h.app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders });
    assert.deepEqual(empty.json(), { object: 'list', data: [] });

    await registerPod(h);
    const served = await h.app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders });
    const body = served.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, MODEL);
    assert.equal(body.data[0].object, 'model');
    assert.equal(body.data[0].task, 'i2v');
    assert.equal(body.data[0].pods_ready, 1);
  });

  it('returns errors in the envelope an OpenAI client already handles', async () => {
    // { error: { message, type, code, param } } — one error path for SGLang,
    // OpenAI and this gateway.
    const cases = [
      [401, 'authentication_error', { method: 'GET' as const, url: '/v1/videos' }],
      [
        404,
        'not_found_error',
        { method: 'GET' as const, url: '/v1/videos/video_ffffffffffff', headers: authHeaders },
      ],
      [
        415,
        'invalid_request_error',
        {
          method: 'POST' as const,
          url: '/v1/videos',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          payload: {},
        },
      ],
    ] as const;

    for (const [status, type, request] of cases) {
      const res = await h.app.inject(request as never);
      assert.equal(res.statusCode, status, `${request.url} should be ${status}`);
      const body = res.json();
      assert.equal(Object.hasOwn(body, 'detail'), false, 'the old `detail` field must be gone');
      assert.equal(typeof body.error, 'object');
      assert.equal(typeof body.error.message, 'string');
      assert.ok(body.error.message.length > 0);
      assert.equal(body.error.type, type);
      // code and param are always present, null when they do not apply.
      assert.ok(Object.hasOwn(body.error, 'code'));
      assert.ok(Object.hasOwn(body.error, 'param'));
    }
  });

  it('names the offending field in `param` when there is one', async () => {
    await registerPod(h);
    const res = await submit(h, { prompt: '  ' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.param, 'prompt');
    assert.equal(res.json().error.code, 'missing_parameter');
  });

  it('exposes a failure message through the field a client reads', async () => {
    await registerPod(h, { pod_id: 'pod-fail' });
    const created = await submit(h);
    const id = created.json().id as string;

    const poll = await registerPod(h, { pod_id: 'pod-fail' });
    const { lease_id } = poll.assign[0];

    await h.app.inject({
      method: 'POST',
      url: `/v1/agent/jobs/${id}/result?lease_id=${lease_id}`,
      headers: agentHeaders,
      payload: { state: 'failed', error: 'sglang rejected the request (422)', retryable: false },
    });

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}`,
      headers: authHeaders,
    });
    const video = parseVideo(fetched.json());
    assert.ok(video);
    assert.equal(video.status, 'failed');
    assert.equal(video.error, 'sglang rejected the request (422)');
  });
});
