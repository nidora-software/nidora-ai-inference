/**
 * Auth, input validation and the artifact path — the places where a mistake is
 * a security hole rather than a bug.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  agentHeaders,
  authHeaders,
  createJobBody,
  makeHarness,
  pngDataUri,
  pollBody,
  type Harness,
} from './helpers.js';
import { safeEqual } from '../src/auth.js';
import { decodeImage, InputError } from '../src/domain/inputs.js';
import { fitSize } from '../src/domain/sizing.js';
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
      const res = await h.app.inject({ method: 'GET', url: '/v1/jobs', headers });
      assert.equal(res.statusCode, 401);
    }
  });

  it('accepts a bearer token as well as X-Api-Key', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/jobs',
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
      url: '/v1/jobs',
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
          url: '/v1/jobs',
          headers: { 'x-api-key': key },
        });
        assert.equal(res.statusCode, 200, `expected ${key} to be accepted`);
      }
      const res = await rotating.app.inject({
        method: 'GET',
        url: '/v1/jobs',
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
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const post = (payload: unknown) =>
    h.app.inject({ method: 'POST', url: '/v1/jobs', headers: authHeaders, payload });

  it('refuses a URL where image bytes belong', async () => {
    // The SSRF guard: a client-supplied URL must never become a fetch by the
    // gateway or a pod. http://169.254.169.254/... would be instance creds.
    const res = await post(
      createJobBody({ image: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }),
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.json().detail, /URLs are not accepted/);
  });

  it('refuses a payload that is not actually an image', async () => {
    const res = await post(
      createJobBody({ image: `data:image/jpeg;base64,${Buffer.from('#!/bin/sh\nrm -rf /').toString('base64')}` }),
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.json().detail, /not a JPEG, PNG or WebP/);
  });

  it('refuses an unknown pipeline instead of passing it downstream', async () => {
    // A client-chosen pipeline reaching a model or LoRA path would be RCE.
    const res = await post({ pipeline: '../../etc/passwd', params: {} });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json().available, ['wan22-i2v']);
  });

  it('requires a prompt', async () => {
    const res = await post(createJobBody({ prompt: '   ' }));
    assert.equal(res.statusCode, 400);
  });

  it('rejects an unsupported resolution', async () => {
    const res = await post(createJobBody({ resolution: '4k' }));
    assert.equal(res.statusCode, 400);
  });

  it('clamps client-supplied generation knobs to the pipeline limits', async () => {
    // Left unclamped, seconds=600/steps=500 is a queue-starvation lever.
    const res = await post(createJobBody({ seconds: 600, num_inference_steps: 500 }));
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().params.seconds, 10);
    assert.equal(res.json().params.num_inference_steps, 12);
  });

  it('falls back to the pipeline default negative prompt when none is given', async () => {
    const res = await post(createJobBody({ negative_prompt: '' }));
    assert.ok(res.json().params.negative_prompt.length > 0);
  });

  it('enforces the byte cap before decoding', () => {
    const huge = 'A'.repeat(4 * 1024 * 1024);
    assert.throws(() => decodeImage(`data:image/png;base64,${huge}`, 1024), InputError);
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
    const uri = pngDataUri(640, 360);
    const bytes = Buffer.from(uri.split(',')[1]!, 'base64');
    assert.deepEqual(probeDimensions(bytes), { width: 640, height: 360 });
  });

  it('returns null rather than throwing on a truncated header', () => {
    assert.equal(probeDimensions(Buffer.from([0xff, 0xd8, 0xff])), null);
    assert.equal(probeDimensions(Buffer.alloc(0)), null);
  });
});

describe('artifact serving', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('refuses to walk out of the artifact directory', async () => {
    for (const target of [
      '/v1/outputs/..%2f..%2f..%2fetc/passwd',
      '/v1/outputs/j_abc/..%2f..%2fetc%2fpasswd',
      '/v1/outputs/j_abc/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const res = await h.app.inject({ method: 'GET', url: target, headers: authHeaders });
      assert.ok(
        res.statusCode === 404 || res.statusCode === 400,
        `${target} should not be served (got ${res.statusCode})`,
      );
    }
  });

  it('distinguishes an expired artifact from one that never existed', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: authHeaders,
      payload: createJobBody(),
    });
    const id = created.json().id as string;

    const missing = await h.app.inject({
      method: 'GET',
      url: `/v1/outputs/${id}/output.mp4`,
      headers: authHeaders,
    });
    assert.equal(missing.statusCode, 404);

    // Complete the job, then sweep its media away as the TTL would.
    const poll = await h.app.inject({
      method: 'POST',
      url: '/agent/v1/poll',
      headers: agentHeaders,
      payload: pollBody(),
    });
    const leaseId = poll.json().assign[0].lease_id;
    await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/artifact?lease_id=${leaseId}`,
      headers: { ...agentHeaders, 'content-type': 'video/mp4' },
      payload: Buffer.from('clip'),
    });
    await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/result?lease_id=${leaseId}`,
      headers: agentHeaders,
      payload: { state: 'completed' },
    });
    await h.ctx.artifacts.removeJob(id);

    const expired = await h.app.inject({
      method: 'GET',
      url: `/v1/outputs/${id}/output.mp4`,
      headers: authHeaders,
    });
    assert.equal(expired.statusCode, 410, 'a swept artifact is Gone, not Not Found');
  });

  it('rejects an oversized artifact rather than filling the disk', async () => {
    const tiny = await makeHarness({ MAX_ARTIFACT_BYTES: '64' });
    try {
      const created = await tiny.app.inject({
        method: 'POST',
        url: '/v1/jobs',
        headers: authHeaders,
        payload: createJobBody(),
      });
      const id = created.json().id as string;
      const poll = await tiny.app.inject({
        method: 'POST',
        url: '/agent/v1/poll',
        headers: agentHeaders,
        payload: pollBody(),
      });
      const leaseId = poll.json().assign[0].lease_id;

      const res = await tiny.app.inject({
        method: 'POST',
        url: `/agent/v1/jobs/${id}/artifact?lease_id=${leaseId}`,
        headers: { ...agentHeaders, 'content-type': 'video/mp4' },
        payload: Buffer.alloc(1024),
      });
      assert.equal(res.statusCode, 413);
    } finally {
      await tiny.cleanup();
    }
  });

  it('rejects an artifact whose checksum does not match what the agent claimed', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: authHeaders,
      payload: createJobBody(),
    });
    const id = created.json().id as string;
    const poll = await h.app.inject({
      method: 'POST',
      url: '/agent/v1/poll',
      headers: agentHeaders,
      payload: pollBody(),
    });
    const leaseId = poll.json().assign[0].lease_id;

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
