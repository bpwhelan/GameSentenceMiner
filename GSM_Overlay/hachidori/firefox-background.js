// Firefox MV2 persistent background-page entry point.
// SPDX-License-Identifier: GPL-3.0-or-later

// Both imports are static so every runtime listener in background.js exists
// before this module body runs. Firefox delivers runtime.onInstalled and
// runtime.onStartup only to listeners registered during the background page's
// synchronous evaluation; a dynamic import would miss them and first-run setup
// would never open. The host's message listener is attached here, after
// background.js, and before the engine iframe that announces itself to it.
import "./background.js";
import { createFirefoxBackgroundHost } from "./firefox-host.js";

createFirefoxBackgroundHost(document).mount();
