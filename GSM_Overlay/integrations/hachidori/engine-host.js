// Decide engine ownership before loading offscreen.html in a hosted window.
import { chromeOffscreenSupported, ensureChromeOffscreen } from '../chrome-offscreen.js';

globalThis.GsmHachidoriEngineHost = (async () => {
  if (!chromeOffscreenSupported()) return false;
  await ensureChromeOffscreen('offscreen.html');
  return true;
})();
