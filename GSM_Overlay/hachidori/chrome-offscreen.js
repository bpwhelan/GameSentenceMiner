// Chrome MV3 lifecycle for the shared offscreen engine document.
// Firefox imports this shared module but never calls its guarded Chrome path.
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
      reasons: ["DOM_SCRAPING", "AUDIO_PLAYBACK", "DISPLAY_MEDIA"],
      justification:
        "Runs the dictionary engine and pronunciation audio, and owns explicitly started local display capture across control-page closure.",
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
