// SPDX-License-Identifier: GPL-3.0-or-later
import { siteScriptSwitch } from "./site-scripts.js";

// The scripts Settings → Advanced → Experimental features → YouTube mining
// registers on www.youtube.com, top frame only because YouTube moves between
// videos inside one document (and embedded players are not supported): the
// video-site page script, netflix-page.js, in the page's main world, before
// YouTube's player (on www.youtube.com it reads YouTube's captions), and the
// reader's video-site layer (netflix-subtitles.js, netflix-audio.js,
// netflix-content.js) with youtube-content.js beside the manifest's content
// scripts.
export const YOUTUBE_SCRIPTS = Object.freeze([
  Object.freeze({
    id: "hachidori-youtube-page",
    matches: ["https://www.youtube.com/*"],
    js: ["netflix-page.js"],
    runAt: "document_start",
    allFrames: false,
    world: "MAIN",
  }),
  Object.freeze({
    id: "hachidori-youtube-content",
    matches: ["https://www.youtube.com/*"],
    js: ["netflix-subtitles.js", "netflix-audio.js", "netflix-content.js", "youtube-content.js"],
    runAt: "document_start",
    allFrames: false,
    world: "ISOLATED",
  }),
]);

export const applyYouTubeFlag = siteScriptSwitch(YOUTUBE_SCRIPTS);
