// Chrome MV3 lifecycle for the shared offscreen engine document.
// SPDX-License-Identifier: GPL-3.0-or-later

import { extensionApi as chrome } from "./browser-api.js";

let creating = null;

export function chromeOffscreenSupported() {
  return typeof chrome.runtime.getContexts === "function"
    && typeof chrome.offscreen?.createDocument === "function";
}

async function offscreenExists(url) {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(url)],
  });
  return contexts.length > 0;
}

async function createOffscreen(url) {
  try {
    await chrome.offscreen.createDocument({
      url,
      // CLIPBOARD: the search page's clipboard monitor reads through it (#639).
      reasons: ["DOM_SCRAPING", "AUDIO_PLAYBACK", "CLIPBOARD"],
      justification:
        "Runs the local dictionary engine and pronunciation audio, and reads the clipboard for the search page.",
    });
  } catch (error) {
    // Another extension context may have won the race; only a genuine absence
    // is a failure.
    if (!(await offscreenExists(url))) throw error;
  } finally {
    creating = null;
  }
}

// Firefox has no offscreen documents: its background page, background.html,
// holds the engine document in a frame. The page's load event follows the
// frame's, by which time offscreen.js is listening.
function backgroundPageLoaded() {
  if (globalThis.document === undefined || globalThis.document.readyState === "complete") return Promise.resolve();
  return new Promise(resolve => globalThis.addEventListener("load", resolve, { once: true }));
}

export async function ensureChromeOffscreen(url) {
  if (!chromeOffscreenSupported()) return backgroundPageLoaded();
  if (await offscreenExists(url)) return;
  if (creating === null) creating = createOffscreen(url);
  await creating;
}
