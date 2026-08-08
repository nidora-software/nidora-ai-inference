/**
 * App construction, separated from process bootstrap so tests can build a
 * fully-wired instance against an in-memory database and drive it with
 * `app.inject()` without ever opening a socket.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { makeRequireAdminKey, makeRequireAgentSecret, makeRequireApiKey } from './auth.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { ArtifactStore } from './artifacts/store.js';
import { JobStore } from './db/jobs.js';
import { PodStore } from './db/pods.js';
import { openDatabase } from './db/sqlite.js';
import { Waiters } from './scheduler/waiters.js';
import agentRoutes from './routes/agent.js';
import healthRoutes from './routes/health.js';
import jobRoutes from './routes/jobs.js';
import outputRoutes from './routes/outputs.js';
import podRoutes from './routes/pods.js';
import type { Db } from './db/sqlite.js';

export const VERSION = '0.1.0';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  shutdown: AbortController;
}

export interface BuildOptions {
  config: Config;
  /** Override the SQLite location; tests pass ':memory:'. */
  databaseFile?: string;
}

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const { config } = options;
  const databaseFile = options.databaseFile ?? `${config.dataDir}/db/gateway.sqlite`;

  const db = openDatabase(databaseFile);
  const jobs = new JobStore(db);
  const pods = new PodStore(db);
  const artifacts = new ArtifactStore(config.dataDir);
  await artifacts.init();

  const shutdown = new AbortController();

  const ctx: AppContext = {
    config,
    jobs,
    pods,
    artifacts,
    waiters: new Waiters(),
    shutdownSignal: shutdown.signal,
    requireApiKey: makeRequireApiKey(config.apiKeys),
    requireAgentSecret: makeRequireAgentSecret(config.agentSecret),
    requireAdminKey: makeRequireAdminKey(config.adminKeys, config.apiKeys),
  };

  const app = Fastify({
    // Behind cloudflared, so the socket peer is always the tunnel.
    trustProxy: true,
    // The client sends the input image as a base64 data URI; the 1 MB default
    // would reject every real request.
    bodyLimit: config.bodyLimitBytes,
    // A long-poll occupies a request for up to poll_wait seconds by design.
    requestTimeout: 0,
    connectionTimeout: 0,
    disableRequestLogging: true,
    logger: {
      level: config.logLevel,
      redact: {
        // A base64 JPEG in every request log fills the disk in a week.
        paths: ['req.body.params.image', 'req.headers["x-api-key"]', 'req.headers["x-agent-secret"]'],
        censor: '[redacted]',
      },
    },
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error, url: request.url }, 'request failed');
      // Never leak an internal message to a client; the log has the detail.
      return reply.code(status).send({ detail: 'internal error' });
    }
    return reply.code(status).send({ detail: error.message });
  });

  await app.register(healthRoutes, { ctx, version: VERSION });
  await app.register(jobRoutes, { ctx });
  await app.register(outputRoutes, { ctx });
  await app.register(podRoutes, { ctx });
  await app.register(agentRoutes, { ctx });

  return { app, ctx, db, shutdown };
}
