/**
 * Everything the routes need, assembled once and passed down explicitly rather
 * than reached for through module state — which is what lets the tests build a
 * whole app against an in-memory database and a temp directory.
 */
import type { preHandlerHookHandler } from 'fastify';
import type { Config } from './config.js';
import type { JobStore } from './db/jobs.js';
import type { PodStore } from './db/pods.js';
import type { ArtifactStore } from './artifacts/store.js';
import type { Waiters } from './scheduler/waiters.js';

export interface AppContext {
  config: Config;
  jobs: JobStore;
  pods: PodStore;
  artifacts: ArtifactStore;
  waiters: Waiters;
  /** Aborted on SIGTERM so parked long-polls return instead of blocking exit. */
  shutdownSignal: AbortSignal;
  requireApiKey: preHandlerHookHandler;
  requireAgentSecret: preHandlerHookHandler;
  requireAdminKey: preHandlerHookHandler;
}
