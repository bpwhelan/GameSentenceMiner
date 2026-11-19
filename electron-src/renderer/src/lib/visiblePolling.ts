/** UI refreshes sleep while hidden and never overlap a slow IPC/network request. */
declare global {
  interface Window { __GSM_NATIVE_WINDOW_VISIBLE__?: boolean }
}

export const NATIVE_VISIBILITY_EVENT = 'gsm-native-visibilitychange';
export const isDocumentVisible = () => document.visibilityState !== 'hidden' && window.__GSM_NATIVE_WINDOW_VISIBLE__ !== false;

export function startVisiblePolling(poll: () => void | Promise<unknown>, intervalMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pending = false;
  const visible = isDocumentVisible;
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
  window.addEventListener(NATIVE_VISIBILITY_EVENT, changed);
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener(NATIVE_VISIBILITY_EVENT, changed);
  };
}

/** Keep small, JSON IPC snapshots referentially stable when nothing changed. */
export function retainEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
