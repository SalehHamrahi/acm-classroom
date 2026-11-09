/**
 * Runs a periodic task only while the page is visible. Tasks never overlap,
 * and returning to a visible tab triggers an immediate refresh.
 * The returned function removes all timers and listeners.
 */
export function scheduleVisibleInterval(callback, intervalMs, host = globalThis) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const interval = Math.max(250, Number(intervalMs) || 1000);
  let stopped = false;
  let running = false;

  const run = () => {
    if (stopped || running || host.document?.visibilityState === 'hidden') return;
    running = true;
    Promise.resolve()
      .then(callback)
      .catch(() => {})
      .finally(() => { running = false; });
  };
  const onVisibilityChange = () => {
    if (host.document?.visibilityState === 'visible') run();
  };

  const timer = host.setInterval(run, interval);
  host.document?.addEventListener?.('visibilitychange', onVisibilityChange);
  return () => {
    if (stopped) return;
    stopped = true;
    host.clearInterval(timer);
    host.document?.removeEventListener?.('visibilitychange', onVisibilityChange);
  };
}
