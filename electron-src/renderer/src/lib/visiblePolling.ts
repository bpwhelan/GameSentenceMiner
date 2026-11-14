/** UI refreshes sleep while hidden and never overlap a slow IPC/network request. */
export function startVisiblePolling(poll: () => void | Promise<unknown>, intervalMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pending = false;
  const visible = () => document.visibilityState !== 'hidden';
  const run = async () => {
    if (stopped || pending || !visible()) return;
    pending = true;
    try { await poll(); }
    catch { /* Callers own error presentation; a failed refresh must not stop recovery. */ }
    finally {
      pending = false;
      if (!stopped && visible()) timer = setTimeout(run, intervalMs);
    }
  };
  const changed = () => {
    clearTimeout(timer);
    timer = undefined;
    if (visible()) void run();
  };
  document.addEventListener('visibilitychange', changed);
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', changed);
  };
}

/** Keep small, JSON IPC snapshots referentially stable when nothing changed. */
export function retainEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
