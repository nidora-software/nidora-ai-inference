/**
 * Long-poll parking lot.
 *
 * An agent that finds no work parks here instead of returning immediately, so
 * a job submitted a second later dispatches at once rather than on the agent's
 * next poll. Single-process only — which is the same constraint SQLite already
 * imposes, so it costs nothing extra today. A multi-replica gateway would swap
 * this for a pub/sub channel and change nothing else.
 */
export class Waiters {
  private waiting = new Set<() => void>();

  /**
   * Resolves true if work arrived, false on timeout. Always settles: the timer
   * is cleared and the waiter deregistered on both paths.
   */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);
    if (signal?.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (woken: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiting.delete(notify);
        signal?.removeEventListener('abort', onAbort);
        resolve(woken);
      };

      const notify = () => finish(true);
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      // Don't hold the event loop open on shutdown.
      timer.unref?.();

      this.waiting.add(notify);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Wake every parked poller. Called whenever new work becomes claimable. */
  kick(): void {
    const pending = [...this.waiting];
    this.waiting.clear();
    for (const notify of pending) notify();
  }

  get size(): number {
    return this.waiting.size;
  }
}
