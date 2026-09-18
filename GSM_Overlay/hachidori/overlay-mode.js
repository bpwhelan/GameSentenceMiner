// Hosts that embed Hachidori in an overlay, such as the GSM overlay, set this to true in their copy.
// SPDX-License-Identifier: GPL-3.0-or-later

export const OVERLAY_MODE = true;

// Electron's extension host deliberately exposes less of Chrome than a normal
// browser window. Keep every host-owned capability in one place so shared
// settings cannot make an unavailable control live again in an overlay.
export const HOST_CAPABILITIES = Object.freeze({

  browserShortcuts: !OVERLAY_MODE,
  customLinks: true,
  externalLinkHost: OVERLAY_MODE,
  localFileAccessPrompt: !OVERLAY_MODE,
  mediaCapture: !OVERLAY_MODE,
});

export const MINING_CAPABILITIES = Object.freeze({
  screenshot: !OVERLAY_MODE,
  browserSpeech: !OVERLAY_MODE,
});
