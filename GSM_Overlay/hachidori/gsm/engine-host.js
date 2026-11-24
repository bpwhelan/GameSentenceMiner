// Decide engine ownership before loading offscreen.html in a hosted window.
import { chromeOffscreenSupported, ensureChromeOffscreen } from '../chrome-offscreen.js';
import { extensionApi as chrome } from '../browser-api.js';

globalThis.GsmHachidoriEngineHost = (async () => {
  if (!chromeOffscreenSupported()) return false;
  try {
    await ensureChromeOffscreen('offscreen.html');
  } catch (error) {
    // Electron can report an empty getContexts result while the background
    // creates the document. Its single-document error still proves ownership.
    if (!/Only a single offscreen document may be created/i.test(String(error?.message ?? error))) throw error;
  }
  // Creating the document does not mean its persisted dictionaries are loaded.
  // Status bypasses the engine's lookup queue, so wait here before admitting the
  // first lookup (including on a rapid native desktop restart).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let timer;
    const status = await Promise.race([
      chrome.runtime.sendMessage({ target: 'hoshidicts-offscreen', type: 'hd_status' }).catch(error => {
        // A new offscreen document may still be registering its message listeners.
        if (/Receiving end does not exist/i.test(String(error?.message ?? error))) return null;
        throw error;
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Dictionary engine status timed out')), 5000); }),
    ]).finally(() => clearTimeout(timer));
    if (status?.ok && status.ready && !status.loading) return true;
    if (status?.error) throw new Error(String(status.error));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Dictionary engine did not become ready');
})();
