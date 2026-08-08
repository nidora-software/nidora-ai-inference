/**
 * Shared-secret authentication.
 *
 * Two independent principals hit this service:
 *   - clients (the product backend) with `X-Api-Key`
 *   - pod agents with `X-Agent-Secret`
 *
 * Cloudflare Access sits in front of the whole hostname with a service-token
 * policy, so these are the *second* gate, not the only one.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

/**
 * Constant-time comparison of two secrets of arbitrary length. Hashing first
 * normalises the length, which `timingSafeEqual` otherwise refuses to accept
 * (and whose length mismatch would itself leak a bit of information).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** True when `candidate` matches any accepted secret. Never short-circuits. */
export function matchesAny(candidate: string, accepted: readonly string[]): boolean {
  let hit = false;
  for (const secret of accepted) {
    if (safeEqual(candidate, secret)) hit = true;
  }
  return hit;
}

/** `X-Api-Key: <key>` or `Authorization: Bearer <key>`, matching the legacy stack. */
function requestKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

export function makeRequireApiKey(apiKeys: readonly string[]): preHandlerHookHandler {
  return function requireApiKey(request: FastifyRequest, reply: FastifyReply, done) {
    const key = requestKey(request);
    if (!key || !matchesAny(key, apiKeys)) {
      reply.code(401).send({ detail: 'invalid or missing API key' });
      return;
    }
    done();
  };
}

export function makeRequireAgentSecret(secret: string): preHandlerHookHandler {
  return function requireAgentSecret(request: FastifyRequest, reply: FastifyReply, done) {
    const provided = request.headers['x-agent-secret'];
    if (typeof provided !== 'string' || !safeEqual(provided, secret)) {
      reply.code(401).send({ detail: 'invalid or missing agent secret' });
      return;
    }
    done();
  };
}

/**
 * Admin routes accept a dedicated admin key, falling back to any client API key
 * when no admin key is configured — a single-operator deployment shouldn't be
 * forced to invent a second secret.
 */
export function makeRequireAdminKey(
  adminKeys: readonly string[],
  apiKeys: readonly string[],
): preHandlerHookHandler {
  const accepted = adminKeys.length > 0 ? adminKeys : apiKeys;
  return function requireAdminKey(request: FastifyRequest, reply: FastifyReply, done) {
    const key =
      typeof request.headers['x-admin-key'] === 'string'
        ? (request.headers['x-admin-key'] as string)
        : requestKey(request);
    if (!key || !matchesAny(key, accepted)) {
      reply.code(401).send({ detail: 'invalid or missing admin key' });
      return;
    }
    done();
  };
}
