// Decide engine ownership before loading offscreen.html in a hosted window.
import { chromeOffscreenSupported } from '../chrome-offscreen.js';
import { extensionApi as chrome } from '../browser-api.js';

globalThis.GsmHachidoriEngineHost = (async () => {
  if (!chromeOffscreenSupported()) return false;
  // The service worker creates (or finds) the offscreen document when it
  // relays hd_status. Creating it here races a second creator in that worker.
  // A successful status reply also confirms persisted dictionaries are ready.
  const deadline = Date.now() + 60_000;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    let timer;
    const status = await Promise.race([
      chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_status' }).catch(error => {
        // A new offscreen document may still be registering its message listeners.
        if (/Receiving end does not exist/i.test(String(error?.message ?? error))) return null;
        throw error;
      }),
      // The worker may start before the offscreen document is able to answer.
      // Recheck readiness until the startup deadline, including after a lost reply.
      new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.min(5000, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    if (status?.ok && status.ready && !status.loading) return true;
    if (status?.error) throw new Error(String(status.error));
    lastStatus = status ? `ready=${status.ready}, loading=${status.loading}` : 'no response';
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Dictionary engine did not become ready (${lastStatus})`);
})();
