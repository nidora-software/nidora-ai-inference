/**
 * Regression tests for the artifact-filename traversal.
 *
 * The bug: `POST /agent/v1/jobs/:id/result` accepted any non-empty string as
 * `filename` and interpolated it into the artifact URL. The upload route and
 * the on-disk resolver both validated; the result route did not — and its value
 * is the one handed to clients.
 *
 * Why that mattered: the product backend fetches that URL with its own API key
 * and Cloudflare Access token, and `new URL()` collapses `..` *before* the host
 * allowlist check. So `../../jobs` normalised to `/v1/jobs`, passed the host
 * pin, and made the backend read arbitrary gateway paths for a pod — turning a
 * pod-scoped secret into a read primitive over the client key's namespace.
 *
 * A pod is a realistic adversary: it runs on rented third-party hardware and
 * the agent secret is documented as compromise-prone.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  agentHeaders,
  authHeaders,
  createJobBody,
  makeHarness,
  pollBody,
  type Harness,
} from './helpers.js';
import { isSafeFilename } from '../src/domain/filenames.js';
import { artifactUrl } from '../src/domain/serialize.js';

/** Paths that must never reach a client, with what each would have reached. */
const TRAVERSALS: Array<[string, string]> = [
  ['../../jobs', 'the full job list — every tenant’s prompts'],
  ['../../pods', 'the admin fleet inventory'],
  ['../j_OTHERJOB/output.mp4', "another tenant's generated clip"],
  ['../../../health', 'an unrelated route'],
  ['..%2f..%2fjobs', 'the job list via encoded separators'],
  ['sub/dir/output.mp4', 'a nested path'],
  ['..', 'the job directory itself'],
  ['.', 'the job directory itself'],
  ['....', 'a dot-only name'],
  ['/etc/passwd', 'an absolute path'],
  ['..\\..\\jobs', 'a backslash separator'],
];

describe('artifact filename traversal', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function claimJob(podId = 'pod-a') {
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
      payload: pollBody({ pod_id: podId }),
    });
    return { id, leaseId: poll.json().assign[0].lease_id as string };
  }

  it('rejects a traversing filename on the result route', async () => {
    for (const [filename, reach] of TRAVERSALS) {
      const { id, leaseId } = await claimJob();

      const result = await h.app.inject({
        method: 'POST',
        url: `/agent/v1/jobs/${id}/result?lease_id=${leaseId}`,
        headers: agentHeaders,
        payload: { state: 'completed', filename },
      });

      assert.equal(
        result.statusCode,
        400,
        `filename ${JSON.stringify(filename)} must be refused (would reach ${reach})`,
      );

      // And the job must not have been marked completed with a poisoned URL.
      const job = await h.app.inject({
        method: 'GET',
        url: `/v1/jobs/${id}`,
        headers: authHeaders,
      });
      assert.equal(job.json().state, 'running');
      assert.deepEqual(job.json().artifacts, []);
    }
  });

  it('rejects a traversing filename on the upload route', async () => {
    const { id, leaseId } = await claimJob();
    for (const [filename] of TRAVERSALS) {
      const upload = await h.app.inject({
        method: 'POST',
        url: `/agent/v1/jobs/${id}/artifact?lease_id=${leaseId}&filename=${encodeURIComponent(filename)}`,
        headers: { ...agentHeaders, 'content-type': 'video/mp4' },
        payload: Buffer.from('x'),
      });
      assert.equal(
        upload.statusCode,
        400,
        `upload filename ${JSON.stringify(filename)} must be refused`,
      );
    }
  });

  it('never emits an artifact URL outside the job’s own output path', async () => {
    const { id, leaseId } = await claimJob();
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

    const job = await h.app.inject({
      method: 'GET',
      url: `/v1/jobs/${id}`,
      headers: authHeaders,
    });
    const url = job.json().artifacts[0].url as string;
    assert.equal(url, `/v1/outputs/${id}/output.mp4`);

    // The consumer resolves this against its configured host. Assert the same
    // way it does — WHATWG URL parsing — so a traversal could not survive
    // normalisation into a different path.
    const resolved = new URL(url, 'https://inference.example.com');
    assert.equal(resolved.pathname, `/v1/outputs/${id}/output.mp4`);
  });

  it('still accepts ordinary filenames', async () => {
    for (const filename of ['output.mp4', 'clip-2.webm', 'a_b.C-1.mp4', 'x']) {
      const { id, leaseId } = await claimJob();
      await h.app.inject({
        method: 'POST',
        url: `/agent/v1/jobs/${id}/artifact?lease_id=${leaseId}&filename=${filename}`,
        headers: { ...agentHeaders, 'content-type': 'video/mp4' },
        payload: Buffer.from('clip'),
      });
      const result = await h.app.inject({
        method: 'POST',
        url: `/agent/v1/jobs/${id}/result?lease_id=${leaseId}`,
        headers: agentHeaders,
        payload: { state: 'completed', filename },
      });
      assert.equal(result.statusCode, 200, `${filename} should be accepted`);

      const download = await h.app.inject({
        method: 'GET',
        url: `/v1/outputs/${id}/${filename}`,
        headers: authHeaders,
      });
      assert.equal(download.statusCode, 200);
    }
  });

  it('validates the filename before any bytes are written', async () => {
    const { id, leaseId } = await claimJob();
    await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/artifact?lease_id=${leaseId}&filename=..`,
      headers: { ...agentHeaders, 'content-type': 'video/mp4' },
      payload: Buffer.from('should never land'),
    });
    // `..` previously reached writeArtifact and made rename() target the job
    // directory, leaving a stray part file behind.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(`${h.ctx.artifacts.artifactsDir}/${id}`).catch(() => []);
    assert.deepEqual(entries, [], 'no part file should be left behind');
  });
});

describe('isSafeFilename', () => {
  it('accepts plain names', () => {
    for (const value of ['output.mp4', 'a', 'A-1_b.webm', 'x'.repeat(255)]) {
      assert.equal(isSafeFilename(value), true, `${value} should be safe`);
    }
  });

  it('rejects separators, traversal, dot-only names and non-strings', () => {
    for (const value of [
      '..',
      '.',
      '...',
      '../x',
      'a/b',
      'a\\b',
      '',
      'x'.repeat(256),
      'a b.mp4',
      'a%2fb',
      'a\0b',
      'ünïcode.mp4',
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(isSafeFilename(value), false, `${JSON.stringify(value)} should be rejected`);
    }
  });
});

describe('artifactUrl', () => {
  it('percent-encodes both segments as a second layer', () => {
    // Callers validate first; this guarantees a future caller that forgets
    // produces an escaped, harmless URL rather than a traversal.
    assert.equal(artifactUrl('j_abc', '../../jobs'), '/v1/outputs/j_abc/..%2F..%2Fjobs');
    assert.equal(new URL(artifactUrl('j_abc', '../../jobs'), 'https://h').pathname,
      '/v1/outputs/j_abc/..%2F..%2Fjobs');
    assert.equal(artifactUrl('j_abc', 'output.mp4'), '/v1/outputs/j_abc/output.mp4');
  });
});
