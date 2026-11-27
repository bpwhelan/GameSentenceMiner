// SPDX-License-Identifier: GPL-3.0-or-later
import { siteScriptSwitch } from "./site-scripts.js";

// The scripts Settings → Advanced → Experimental features → Crunchyroll mining
// registers on www.crunchyroll.com, top frame only because Crunchyroll moves
// between episodes inside one document: the video-site page script,
// netflix-page.js, in the page's main world (on Crunchyroll it replays,
// pauses and resumes the player's <video>; a user script posts the
// subtitles), and the reader's video-site layer (netflix-subtitles.js,
// netflix-audio.js, netflix-content.js) with crunchyroll-content.js beside the
// manifest's content scripts.
export const CRUNCHYROLL_SCRIPTS = Object.freeze([
  Object.freeze({
    id: "hachidori-crunchyroll-page",
    matches: ["https://www.crunchyroll.com/*"],
    js: ["netflix-page.js"],
    runAt: "document_start",
    allFrames: false,
    world: "MAIN",
  }),
  Object.freeze({
    id: "hachidori-crunchyroll-content",
    matches: ["https://www.crunchyroll.com/*"],
    js: ["netflix-subtitles.js", "netflix-audio.js", "netflix-content.js", "crunchyroll-content.js"],
    runAt: "document_start",
    allFrames: false,
    world: "ISOLATED",
  }),
]);

export const applyCrunchyrollFlag = siteScriptSwitch(CRUNCHYROLL_SCRIPTS);
