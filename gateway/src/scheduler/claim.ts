/**
 * Job → pod matching, run inside the agent's own poll request.
 *
 * With long-polling there is no separate dispatcher loop: the polling pod is
 * right here asking for work, so it claims for itself. That removes an entire
 * moving part, and the CAS in `JobStore.claim` makes concurrent polls safe
 * without any locking.
 */
import { getModel } from '../domain/models.js';
import type { Job, Pod } from '../domain/types.js';
import type { JobStore } from '../db/jobs.js';
import { newLeaseId } from '../lib/ids.js';

export interface Assignment {
  job_id: string;
  lease_id: string;
  model: string;
  deadline_at: number;
  input: { url: string; sha256: string | null; bytes: number | null };
  sglang: { endpoint: string; fields: Record<string, string | number> };
}

/**
 * A pod contributes capacity only when it is reachable, not draining, and its
 * SGLang server has finished loading the model.
 *
 * That last condition is load-bearing. A pod's agent connects the moment the
 * container starts, but `sglang serve` needs ~10 minutes to load a 14B model —
 * and a pod with too little system RAM OOM-loops at load forever. Treating
 * "the agent is talking to us" as "the pod can do work" would send every job to
 * a pod that can never finish one, while the dashboard showed healthy capacity.
 */
export function freeSlots(pod: Pod, inFlight: number): number {
  if (pod.draining || !pod.sglang_ready) return 0;
  return Math.max(0, pod.max_in_flight - inFlight);
}

/** Build the fully-resolved SGLang form fields for a job. The agent adds nothing. */
export function assignmentFor(job: Job, leaseId: string): Assignment {
  const spec = getModel(job.model);
  if (!spec) throw new Error(`job ${job.id} references unknown model ${job.model}`);

  const fields: Record<string, string | number> = {
    prompt: job.params.prompt,
    negative_prompt: job.params.negative_prompt,
    size: job.params.size,
    seconds: job.params.seconds,
    num_inference_steps: job.params.num_inference_steps,
    guidance_scale: job.params.guidance_scale,
  };
  if (job.params.seed !== null) fields.seed = job.params.seed;

  return {
    job_id: job.id,
    lease_id: leaseId,
    model: job.model,
    deadline_at: job.deadline_at,
    input: {
      url: `/v1/agent/jobs/${job.id}/input`,
      sha256: job.input_sha256,
      bytes: job.input_bytes,
    },
    sglang: { endpoint: spec.endpoint, fields },
  };
}

/**
 * Claim up to `slots` queued jobs for `pod`.
 *
 * What the pod serves comes from its `model_path`, not from anything it claims
 * about itself — the weights it loaded decide what it can run.
 *
 * The loop deliberately *continues* past a job the pod can't run rather than
 * stopping: a queued job for a model this pod hasn't loaded must not
 * head-of-line-block one it has.
 */
export function claimForPod(
  store: JobStore,
  pod: Pod,
  slots: number,
  leaseTtlMs: number,
  now: number,
): Assignment[] {
  if (slots <= 0) return [];

  const assignments: Assignment[] = [];

  for (const job of store.listQueued(100)) {
    if (assignments.length >= slots) break;
    if (job.model !== pod.model) continue;
    if (!getModel(job.model)) continue;

    const leaseId = newLeaseId();
    if (!store.claim(job.id, pod.pod_id, leaseId, now + leaseTtlMs, now)) {
      continue; // another poll won the race; try the next job
    }
    assignments.push(assignmentFor(job, leaseId));
  }

  return assignments;
}
