// SPDX-License-Identifier: GPL-3.0-or-later

const SCRIPT_ID = "hachidori-google-docs";
let application = Promise.resolve();

// The one script Settings → Advanced → Experimental features → Google Docs
// registers: google-docs-flag.js in the page's main world before Docs' bundle
// runs, on every Docs frame. Chrome accepts `world`.
export const GOOGLE_DOCS_SCRIPT = Object.freeze({
  id: SCRIPT_ID,
  matches: ["*://docs.google.com/*"],
  js: ["google-docs-flag.js"],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",
});

async function apply(browser, enabled) {
  const scripting = browser.scripting;
  if (typeof scripting?.registerContentScripts !== "function") return { supported: false, registered: false };
  const [existing] = await scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!enabled) {
    if (existing) await scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return { supported: true, registered: false };
  }
  if (!existing) await scripting.registerContentScripts([GOOGLE_DOCS_SCRIPT]);
  return { supported: true, registered: true };
}

// Serialised like applyCustomJavaScript, so rapid toggles apply in order.
export function applyGoogleDocsFlag(browser, enabled) {
  application = application.catch(() => {}).then(() => apply(browser, enabled));
  return application;
}
