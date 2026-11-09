// Keeps Firefox's background page, and the engine frame in it, running.
//
// Firefox suspends an idle event page after 30 seconds, and with it the engine
// and every dictionary it has loaded; Chrome keeps the offscreen document for
// the browser session. An extension API call that Firefox answers in its
// parent process, as it does getPlatformInfo(), restarts that idle timer.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";

const KEEP_ALIVE_MS = 20_000;

setInterval(() => {
  chrome.runtime.getPlatformInfo().catch(() => {});
}, KEEP_ALIVE_MS);
