/**
 * The contract guard.
 *
 * `parseJob` below is a deliberately *strict* model of how a well-written client
 * consumes this API, written against the documented contract in docs/api.md and
 * docs/gateway.md — not a copy of any particular client. Every gateway response,
 * in every job state, is run through it.
 *
 * The point is to make the contract executable. A refactor that renames a field,
 * changes a state string, or makes an artifact URL absolute fails here, at build
 * time, instead of silently breaking integrations at run time.
 *
 * Being strict is the whole design: it maps exactly the five documented states
 * and treats anything else as an error, and it refuses an artifact path that is
 * not this job's own output. Loosening it to make a test pass defeats the
 * purpose — change the gateway, or change the documented contract and the
 * clients along with it.
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

/** The five documented states, mapped to a generic client-side vocabulary. */
const STATUS_MAP: Record<string, string> = {
  queued: 'starting',
  running: 'processing',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'canceled',
};

function baseUrl(cfg: { host: string }): string {
  return cfg.host.replace(/\/+$/, '');
}

/**
 * A client sends credentials with the artifact request, so it must satisfy
 * itself that the path is this job's own output before following it — the
 * gateway validates, but a client should not have to trust that.
 */
function safeArtifactPath(url: unknown, jobId: string): boolean {
  if (typeof url !== 'string') return false;
  if (url.includes('..') || url.includes('\\') || url.includes('%')) return false;
  const expected = `/v1/outputs/${jobId}/`;
  if (!url.startsWith(expected)) return false;
  return /^[A-Za-z0-9._-]+$/.test(url.slice(expected.length));
}

/** Returns null when the payload is not a job a strict client would accept. */
function parseJob(payload: unknown, cfg: { host: string }) {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const status = typeof raw.state === 'string' ? STATUS_MAP[raw.state] : undefined;
  if (!status) return null;

  let outputUrl: string | null = null;
  if (Array.isArray(raw.artifacts) && raw.artifacts.length > 0) {
    const first = raw.artifacts[0] as Record<string, unknown>;
    if (safeArtifactPath(first?.url, raw.id)) {
      outputUrl = `${baseUrl(cfg)}${first.url as string}`;
    }
  }
  return {
    id: raw.id,
    status,
    outputUrl,
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
  };
}

const CFG = { host: 'https://inference.example.com' };

describe('client contract', () => {
  // A fresh harness per test: these cases claim jobs from the queue, and a
  // shared queue would let one test's poll pick up another test's job.
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('parses a freshly created job as "starting"', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: authHeaders,
      payload: createJobBody(),
    });
    assert.equal(created.statusCode, 202);

    const job = parseJob(created.json(), CFG);
    assert.ok(job, 'a strict client must be able to parse the create response');
    assert.equal(job.status, 'starting');
    assert.match(job.id, /^j_[0-9a-f]{12}$/);
    assert.equal(job.outputUrl, null);
    assert.equal(job.error, null);
  });

  it('parses every reachable state, and never emits an unmapped one', async () => {
    // A cancel of a queued job — the only terminal state reachable without a pod.
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: authHeaders,
      payload: createJobBody(),
    });
    const id = created.json().id as string;

    const cancelled = await h.app.inject({
      method: 'DELETE',
      url: `/v1/jobs/${id}`,
      headers: authHeaders,
    });
    assert.equal(cancelled.statusCode, 200);

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/jobs/${id}`,
      headers: authHeaders,
    });
    const job = parseJob(fetched.json(), CFG);
    assert.ok(job, 'a cancelled job must still parse');
    assert.equal(job.status, 'canceled');
  });

  it('reports a running job as "processing", never as "cancelling"', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: authHeaders,
      payload: createJobBody(),
    });
    const id = created.json().id as string;

    // A pod claims it.
    await h.app.inject({
      method: 'POST',
      url: '/agent/v1/poll',
      headers: agentHeaders,
      payload: pollBody(),
    });

    // The client cancels mid-flight. The DELETE body may say "cancelling",
    // but the job's own state must remain one a client can map.
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/v1/jobs/${id}`,
      headers: authHeaders,
    });
    assert.equal(del.json().state, 'cancelling');

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/jobs/${id}`,
      headers: authHeaders,
    });
    assert.equal(fetched.json().state, 'running');
    const job = parseJob(fetched.json(), CFG);
    assert.ok(job, 'a job being cancelled must not break a strict client');
    assert.equal(job.status, 'processing');
  });

  it('yields a relative artifact URL a client can resolve and download', async () => {
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
      payload: pollBody({ pod_id: 'pod-artifact' }),
    });
    const assignment = poll.json().assign[0];
    assert.equal(assignment.job_id, id);

    const media = Buffer.from('fake mp4 bytes');
    const upload = await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/artifact?lease_id=${assignment.lease_id}`,
      headers: { ...agentHeaders, 'content-type': 'video/mp4' },
      payload: media,
    });
    assert.equal(upload.statusCode, 200);

    await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/result?lease_id=${assignment.lease_id}`,
      headers: agentHeaders,
      payload: { state: 'completed', filename: 'output.mp4', bytes: media.length },
    });

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/jobs/${id}`,
      headers: authHeaders,
    });
    const job = parseJob(fetched.json(), CFG);
    assert.ok(job);
    assert.equal(job.status, 'succeeded');
    // A client builds `${host}${url}`, requires https, pins the host, and
    // fetches with redirect:'error'. A relative URL on our own host is the
    // only shape that survives all three checks.
    assert.equal(job.outputUrl, `https://inference.example.com/v1/outputs/${id}/output.mp4`);

    const download = await h.app.inject({
      method: 'GET',
      url: `/v1/outputs/${id}/output.mp4`,
      headers: authHeaders,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'video/mp4');
    assert.deepEqual(download.rawPayload, media);
  });

  it('a strict client refuses a poisoned artifact path even if one were emitted', () => {
    // Belt to the gateway's braces: the gateway now validates the filename, but
    // a client must independently refuse anything outside this job's own
    // output path. `new URL()` collapses `..` before a host check, so a
    // traversal that reached a client would be fetched with its API key.
    for (const url of [
      '/v1/outputs/j_aaaaaaaaaaaa/../../jobs',
      '/v1/outputs/j_aaaaaaaaaaaa/../j_OTHER/output.mp4',
      '/v1/jobs',
      '/v1/outputs/j_OTHER/output.mp4',
      '/v1/outputs/j_aaaaaaaaaaaa/sub/dir.mp4',
      '/v1/outputs/j_aaaaaaaaaaaa/..%2f..%2fjobs',
      'https://evil.example/clip.mp4',
    ]) {
      const job = parseJob(
        {
          id: 'j_aaaaaaaaaaaa',
          state: 'completed',
          error: null,
          artifacts: [{ url }],
        },
        CFG,
      );
      assert.ok(job, 'the job itself must still parse');
      assert.equal(job.outputUrl, null, `${url} must not become a download target`);
    }
  });

  it('exposes a failure message through the field a client reads', async () => {
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
      payload: pollBody({ pod_id: 'pod-fail' }),
    });
    const { lease_id } = poll.json().assign[0];

    await h.app.inject({
      method: 'POST',
      url: `/agent/v1/jobs/${id}/result?lease_id=${lease_id}`,
      headers: agentHeaders,
      payload: { state: 'failed', error: 'sglang rejected the request (422)', retryable: false },
    });

    const fetched = await h.app.inject({
      method: 'GET',
      url: `/v1/jobs/${id}`,
      headers: authHeaders,
    });
    const job = parseJob(fetched.json(), CFG);
    assert.ok(job);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'sglang rejected the request (422)');
  });
});
