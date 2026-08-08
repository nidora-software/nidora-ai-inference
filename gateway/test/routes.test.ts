/**
 * Auth, input validation and the artifact path — the places where a mistake is
 * a security hole rather than a bug.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  agentHeaders,
  authHeaders,
  makeHarness,
  multipart,
  pngBytes,
  pollBody,
  registerPod,
  submit,
  MODEL,
  type Harness,
} from './helpers.js';
import { safeEqual } from '../src/auth.js';
import { readImage, InputError } from '../src/domain/inputs.js';
import { checkSize, fitSize } from '../src/domain/sizing.js';
import { probeDimensions } from '../src/domain/probe.js';

describe('auth', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('rejects the client API without a key, and with a wrong one', async () => {
    for (const headers of [{}, { 'x-api-key': 'nope' }]) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/videos', headers });
      assert.equal(res.statusCode, 401);
    }
  });

  it('accepts a bearer token as well as X-Api-Key', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/videos',
      headers: { authorization: 'Bearer test-api-key' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('rejects the agent plane without the shared secret', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/agent/v1/poll',
      payload: pollBody(),
    });
    assert.equal(res.statusCode, 401);
  });

  it('does not accept a client API key on the agent plane, or vice versa', async () => {
    const asClient = await h.app.inject({
      method: 'POST',
      url: '/agent/v1/poll',
      headers: authHeaders,
      payload: pollBody(),
    });
    assert.equal(asClient.statusCode, 401);

    const asAgent = await h.app.inject({
      method: 'GET',
      url: '/v1/videos',
      headers: agentHeaders,
    });
    assert.equal(asAgent.statusCode, 401);
  });

  it('supports multiple keys so one can be rotated without downtime', async () => {
    const rotating = await makeHarness({ GATEWAY_API_KEYS: 'old-key, new-key' });
    try {
      for (const key of ['old-key', 'new-key']) {
        const res = await rotating.app.inject({
          method: 'GET',
          url: '/v1/videos',
          headers: { 'x-api-key': key },
        });
        assert.equal(res.statusCode, 200, `expected ${key} to be accepted`);
      }
      const res = await rotating.app.inject({
        method: 'GET',
        url: '/v1/videos',
        headers: { 'x-api-key': 'retired-key' },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await rotating.cleanup();
    }
  });

  it('compares secrets of differing lengths without throwing', () => {
    assert.equal(safeEqual('a', 'a'), true);
    assert.equal(safeEqual('short', 'a-much-longer-secret'), false);
    assert.equal(safeEqual('', ''), true);
  });

  it('never tells an unauthenticated caller that an admin credential exists', async () => {
    // A distinct "invalid or missing admin key" on /v1/pods would hand a prober
    // the one fact worth having: which surface carries the privileged key.
    const routes = [
      ['GET', '/v1/videos'],
      ['GET', '/v1/models'],
      ['GET', '/v1/pods'],
      ['POST', '/v1/pods/p1/drain'],
    ] as const;

    for (const [method, url] of routes) {
      for (const headers of [{}, { 'x-api-key': 'nope' }, { 'x-admin-key': 'nope' }]) {
        const res = await h.app.inject({ method, url, headers });
        assert.equal(res.statusCode, 401, `${method} ${url} must reject`);
        assert.deepEqual(
          res.json(),
          { detail: 'invalid or missing API key' },
          `${url} must not describe which credential was missing`,
        );
      }
    }
  });

  it('leaves /health open so probes and the tunnel work', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
  });
});

describe('input validation', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    // Creation requires a pod serving the model, so every validation case needs
    // one present or it would 503 before reaching the check under test.
    await registerPod(h);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('has no field in which a URL could be supplied where bytes belong', async () => {
    // The SSRF guard is structural now: the image arrives as an uploaded file
    // part, so http://169.254.169.254/... has nowhere to go. A client that
    // sends the URL as a text field simply has no reference image.
    const body = await multipart(
      {
        model: MODEL,
        prompt: 'a woman waves',
        input_reference: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      },
      null,
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: { ...authHeaders, ...body.headers },
      payload: body.payload,
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().detail, /input_reference is required/);
  });

  it('refuses a payload that is not actually an image', async () => {
    const res = await submit(h, {}, Buffer.from('#!/bin/sh\nrm -rf /'));
    assert.equal(res.statusCode, 400);
    assert.match(res.json().detail, /not a JPEG, PNG or WebP/);
  });

  it('refuses an unknown model instead of passing it downstream', async () => {
    // A client-chosen model reaching a model or LoRA path would be RCE.
    const res = await submit(h, { model: '../../etc/passwd' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json().available, [MODEL]);
  });

  it('requires a prompt', async () => {
    const res = await submit(h, { prompt: '   ' });
    assert.equal(res.statusCode, 400);
  });

  it('rejects a size the model cannot render', async () => {
    for (const size of ['4k', '1920x1080', '833x481']) {
      const res = await submit(h, { size });
      assert.equal(res.statusCode, 400, `${size} should be refused`);
    }
  });

  it('accepts an explicit size the model can render, as SGLang does', async () => {
    const res = await submit(h, { size: '480x832' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().size, '480x832');
  });

  it('derives an aspect-preserving size when the client omits one', async () => {
    const res = await submit(h, {}, pngBytes(1000, 1000));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().size, '624x624');
  });

  it('clamps client-supplied generation knobs to the model limits', async () => {
    // Left unclamped, seconds=600/steps=500 is a queue-starvation lever.
    const res = await submit(h, { seconds: '600', num_inference_steps: '500' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().seconds, 10);
    const job = h.ctx.jobs.get(res.json().id)!;
    assert.equal(job.params.num_inference_steps, 12);
  });

  it('falls back to the model default negative prompt when none is given', async () => {
    const res = await submit(h, { negative_prompt: '' });
    const job = h.ctx.jobs.get(res.json().id)!;
    assert.ok(job.params.negative_prompt.length > 0);
  });

  it('refuses a body that is not multipart at all', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: authHeaders,
      payload: { model: MODEL, prompt: 'hi' },
    });
    assert.equal(res.statusCode, 415);
  });

  it('enforces the byte cap', () => {
    assert.throws(() => readImage(Buffer.alloc(4096), 1024), InputError);
  });
});

describe('sizing', () => {
  it('preserves aspect ratio within the resolution budget, aligned to 16px', () => {
    assert.equal(fitSize(832, 480, '480p'), '832x480');
    assert.equal(fitSize(480, 832, '480p'), '480x832');
    // A square input gets a square frame of the same pixel budget.
    assert.equal(fitSize(1000, 1000, '480p'), '624x624');
    // 720p is the larger budget.
    assert.equal(fitSize(1280, 720, '720p'), '1280x720');
  });

  it('clamps a pathological aspect ratio to a frame the model can render', () => {
    // Area budget alone would give 63184x16 here — inside the pixel budget but
    // impossible to generate. The long side must be bounded too.
    assert.equal(fitSize(10000, 1, '480p'), '832x16');
    assert.equal(fitSize(1, 10000, '720p'), '16x1280');

    for (const [w, h] of [
      [10000, 1],
      [1, 10000],
      [4000, 100],
      [3, 7],
    ] as const) {
      for (const res of ['480p', '720p'] as const) {
        const [outW, outH] = fitSize(w, h, res).split('x').map(Number) as [number, number];
        assert.ok(outW >= 16 && outH >= 16, `${w}x${h} @${res} fell below a macroblock`);
        assert.ok(outW % 16 === 0 && outH % 16 === 0, `${w}x${h} @${res} is not 16-aligned`);
        const limit = res === '480p' ? 832 : 1280;
        assert.ok(
          Math.max(outW, outH) <= limit,
          `${w}x${h} @${res} exceeded the frame bound: ${outW}x${outH}`,
        );
      }
    }
  });

  it('reads dimensions out of real PNG headers', () => {
    assert.deepEqual(probeDimensions(pngBytes(640, 360)), { width: 640, height: 360 });
  });

  it('accepts only 16-aligned client sizes inside a resolution budget', () => {
    const allowed = ['480p', '720p'] as const;
    assert.deepEqual(checkSize('480x832', allowed), { size: '480x832', resolution: '480p' });
    // Fits 720p's budget but not 480p's, so it lands in the larger bucket.
    assert.deepEqual(checkSize('1280x720', allowed), { size: '1280x720', resolution: '720p' });
    // Past every budget, misaligned, or not a size at all.
    assert.equal(checkSize('1920x1080', allowed), null);
    assert.equal(checkSize('481x833', allowed), null);
    assert.equal(checkSize('480p', allowed), null);
    // A model that only offers 480p cannot be talked into a 720p frame.
    assert.equal(checkSize('1280x720', ['480p']), null);
  });

  it('returns null rather than throwing on a truncated header', () => {
    assert.equal(probeDimensions(Buffer.from([0xff, 0xd8, 0xff])), null);
    assert.equal(probeDimensions(Buffer.alloc(0)), null);
  });
});

describe('content serving', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    await registerPod(h);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /** Create, claim, upload and complete — the whole path to a downloadable clip. */
  const completed = async (harness: Harness, bytes = Buffer.from('clip')) => {
    const created = await submit(harness);
    const id = created.json().id as string;
    const poll = await registerPod(harness);
    const leaseId = poll.assign[0].lease_id;
    const upload = await harness.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/artifact?lease_id=${leaseId}`,
      headers: { ...agentHeaders, 'content-type': 'video/mp4' },
      payload: bytes,
    });
    return { id, leaseId, upload };
  };

  it('serves the media without a client-supplied path segment', async () => {
    const { id, leaseId } = await completed(h);
    await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/result?lease_id=${leaseId}`,
      headers: agentHeaders,
      payload: { state: 'completed' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}/content`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.rawPayload.toString(), 'clip');
  });

  it('says the video is not ready rather than 404 when it has not finished', async () => {
    const created = await submit(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${created.json().id}/content`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 409);
  });

  it('distinguishes expired content from a video that never existed', async () => {
    const missing = await h.app.inject({
      method: 'GET',
      url: '/v1/videos/video_deadbeefdead/content',
      headers: authHeaders,
    });
    assert.equal(missing.statusCode, 404);

    const { id, leaseId } = await completed(h);
    await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/result?lease_id=${leaseId}`,
      headers: agentHeaders,
      payload: { state: 'completed' },
    });
    await h.ctx.artifacts.removeJob(id);

    const expired = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}/content`,
      headers: authHeaders,
    });
    assert.equal(expired.statusCode, 410, 'swept media is Gone, not Not Found');
  });

  it('rejects an oversized artifact rather than filling the disk', async () => {
    const tiny = await makeHarness({ MAX_ARTIFACT_BYTES: '64' });
    try {
      await registerPod(tiny);
      const { upload } = await completed(tiny, Buffer.alloc(1024));
      assert.equal(upload.statusCode, 413);
    } finally {
      await tiny.cleanup();
    }
  });

  it('rejects an artifact whose checksum does not match what the agent claimed', async () => {
    const created = await submit(h);
    const id = created.json().id as string;
    const poll = await registerPod(h);
    const leaseId = poll.assign[0].lease_id;

    const res = await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/artifact?lease_id=${leaseId}`,
      headers: {
        ...agentHeaders,
        'content-type': 'video/mp4',
        'x-content-sha256': 'deadbeef',
      },
      payload: Buffer.from('clip'),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().detail, /sha256 mismatch/);
  });
});
