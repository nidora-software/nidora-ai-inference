import { randomBytes, randomUUID } from 'node:crypto';

/** `video_<12 hex>` — the id shape SGLang and OpenAI hand back for a video. */
export function newVideoId(): string {
  return `video_${randomBytes(6).toString('hex')}`;
}

export function newLeaseId(): string {
  return randomUUID();
}

export function newSessionId(): string {
  return randomUUID();
}
