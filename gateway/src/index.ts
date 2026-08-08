/**
 * Process bootstrap: config, app, background sweeps, graceful shutdown.
 */
import { buildApp, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { startCleanup } from './artifacts/cleanup.js';
import { startReaper } from './scheduler/reaper.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, ctx, db, shutdown } = await buildApp({ config });

  /*
   * Restart recovery. Running jobs are deliberately NOT failed: unlike the
   * legacy in-process worker, the work is on a pod that neither knows nor cares
   * that the gateway bounced. Their leases are pushed out by one poll window;
   * agents re-claim them within seconds and the reaper requeues whatever nobody
   * claims. This is why /data must be a volume — the input images have to
   * survive too.
   */
  const recovered = ctx.jobs.recoverOnStartup(Date.now(), config.maxPollWaitMs * 2);
  if (recovered > 0) {
    app.log.info({ jobs: recovered }, 'extended leases on in-flight jobs after restart');
  }

  const stopReaper = startReaper(
    {
      jobs: ctx.jobs,
      pods: ctx.pods,
      artifacts: ctx.artifacts,
      waiters: ctx.waiters,
      maxAttempts: config.maxAttempts,
      cancelGraceMs: config.cancelGraceMs,
      podStaleMs: config.podStaleMs,
      log: app.log,
    },
    config.reaperIntervalMs,
  );

  const stopCleanup = startCleanup(
    {
      jobs: ctx.jobs,
      pods: ctx.pods,
      artifacts: ctx.artifacts,
      artifactTtlMs: config.artifactTtlMs,
      jobRetentionMs: config.jobRetentionMs,
      log: app.log,
    },
    config.cleanupIntervalMs,
  );

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { version: VERSION, port: config.port, dataDir: config.dataDir },
    'inference gateway listening',
  );

  let closing = false;
  const stop = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    // Release parked long-polls first; otherwise close() waits out the full
    // poll window on every idle pod.
    shutdown.abort();
    stopReaper();
    stopCleanup();
    ctx.waiters.kick();
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((error) => {
  console.error('[gateway] failed to start:', error);
  process.exit(1);
});
