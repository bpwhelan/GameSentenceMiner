// SPDX-License-Identifier: GPL-3.0-or-later
import { siteScriptSwitch } from "./site-scripts.js";

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

export const applyNetflixFlag = siteScriptSwitch(NETFLIX_SCRIPTS);
