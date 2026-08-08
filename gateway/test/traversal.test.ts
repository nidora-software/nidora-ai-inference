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
  submit,
  registerPod,
  makeHarness,
  pollBody,
  type Harness,
} from './helpers.js';
import { isSafeFilename } from '../src/domain/filenames.js';

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
    await registerPod(h, { pod_id: podId });
    const created = await submit(h);
    assert.equal(created.statusCode, 200, JSON.stringify(created.json()));
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

      // And the video must not have been marked completed off the back of it.
      const video = await h.app.inject({
        method: 'GET',
        url: `/v1/videos/${id}`,
        headers: authHeaders,
      });
      assert.equal(video.json().status, 'in_progress');
      assert.deepEqual(h.ctx.jobs.get(id)!.artifacts, []);
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

  it('never puts a pod-supplied filename in front of a client at all', async () => {
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

    // The original bug needed a filename to travel from the pod, through the
    // video object, into a URL the backend fetched. The video object no longer
    // carries one: content lives at a fixed path derived from the id, so there
    // is nothing for a malicious filename to steer.
    const video = await h.app.inject({
      method: 'GET',
      url: `/v1/videos/${id}`,
      headers: authHeaders,
    });
    const body = video.json();
    assert.equal(body.artifacts, undefined, 'no artifact list, so no pod-controlled URL');
    assert.equal(
      JSON.stringify(body).includes('output.mp4'),
      false,
      'no filename should appear in the client payload',
    );

    // The consumer resolves the content path against its configured host.
    // Assert the same way it does — WHATWG URL parsing.
    const resolved = new URL(`/v1/videos/${id}/content`, 'https://inference.example.com');
    assert.equal(resolved.pathname, `/v1/videos/${id}/content`);
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
        url: `/v1/videos/${id}/content`,
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

describe('content addressing', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('resolves content by video id, so a client never supplies a path segment', async () => {
    // The old `/v1/outputs/:jobId/:filename` route took two attacker-influenced
    // segments. This one takes an id that has to match a row we wrote.
    for (const target of [
      '/v1/videos/..%2f..%2fetc%2fpasswd/content',
      '/v1/videos/%2e%2e%2f%2e%2e/content',
      '/v1/videos/video_aaaaaaaaaaaa/content',
    ]) {
      const res = await h.app.inject({ method: 'GET', url: target, headers: authHeaders });
      assert.ok(
        res.statusCode === 404 || res.statusCode === 400,
        `${target} must not be served (got ${res.statusCode})`,
      );
    }
  });
});
