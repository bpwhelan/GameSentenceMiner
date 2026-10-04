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
      reasons: ["DOM_SCRAPING", "AUDIO_PLAYBACK"],
      justification:
        "Runs the local dictionary engine and pronunciation audio.",
    });
  } catch (error) {
    // Another extension context may have won the race; only a genuine absence
    // is a failure.
    if (!(await offscreenExists(url))) throw error;
  } finally {
    creating = null;
  }
}

export async function ensureChromeOffscreen(url) {
  if (!chromeOffscreenSupported()) return;
  if (await offscreenExists(url)) return;
  if (creating === null) creating = createOffscreen(url);
  await creating;
}
