import { randomBytes, randomUUID } from 'node:crypto';

/** `j_<12 hex>` — the id format the legacy stack used and clients already log. */
export function newJobId(): string {
  return `j_${randomBytes(6).toString('hex')}`;
}

export function newLeaseId(): string {
  return randomUUID();
}

export function newSessionId(): string {
  return randomUUID();
}
