// SPDX-License-Identifier: GPL-3.0-or-later

let application = Promise.resolve();

// The scripts Settings → Advanced → Experimental features → Netflix mining
// registers, top frame only because Netflix reaches /watch/ by navigating
// inside one document: netflix-page.js in the page's main world, before
// Netflix's own bundle, and the reader's netflix-subtitles.js, netflix-audio.js
// and netflix-content.js beside the manifest's content scripts.
export const NETFLIX_SCRIPTS = Object.freeze([
  Object.freeze({
    id: "hachidori-netflix-page",
    matches: ["https://www.netflix.com/*"],
    js: ["netflix-page.js"],
    runAt: "document_start",
    allFrames: false,
    world: "MAIN",
  }),
  Object.freeze({
    id: "hachidori-netflix-content",
    matches: ["https://www.netflix.com/*"],
    js: ["netflix-subtitles.js", "netflix-audio.js", "netflix-content.js"],
    runAt: "document_start",
    allFrames: false,
    world: "ISOLATED",
  }),
]);
const SCRIPT_IDS = NETFLIX_SCRIPTS.map(script => script.id);

async function apply(browser, enabled) {
  const scripting = browser.scripting;
  if (typeof scripting?.registerContentScripts !== "function") return { supported: false, registered: false };
  const existing = new Set((await scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS })).map(script => script.id));
  if (!enabled) {
    if (existing.size > 0) await scripting.unregisterContentScripts({ ids: [...existing] });
    return { supported: true, registered: false };
  }
  const missing = NETFLIX_SCRIPTS.filter(script => !existing.has(script.id));
  if (missing.length > 0) await scripting.registerContentScripts(missing);
  return { supported: true, registered: true };
}

// Serialised like applyGoogleDocsFlag, so rapid toggles apply in order.
export function applyNetflixFlag(browser, enabled) {
  application = application.catch(() => {}).then(() => apply(browser, enabled));
  return application;
}
