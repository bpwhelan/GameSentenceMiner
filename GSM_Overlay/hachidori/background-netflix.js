// Experimental Netflix mining in the service worker: Netflix's names for the
// video-site service (background-video.js): the recorder frame's port, line
// recordings, and the WAV the player page cuts from what the viewer heard.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createVideoSiteService } from "./background-video.js";
import { NETFLIX_SCRIPTS } from "./netflix.js";

// Experimental Netflix mining (docs/architecture.md, Netflix mining).
const NETFLIX_TARGET = "hachidori-netflix";
const NETFLIX_RECORDER_PORT = "hachidori-netflix-recorder";
const NETFLIX_WATCH_URL = /^https:\/\/www\.netflix\.com\/watch\/\d+/u;

const netflixMining = createVideoSiteService({
  name: "Netflix",
  flag: "netflixMining",
  target: NETFLIX_TARGET,
  recorderPort: NETFLIX_RECORDER_PORT,
  recorderPage: "netflix-recorder.html",
  origin: "https://www.netflix.com/",
  playerUrl: NETFLIX_WATCH_URL,
  playing: "playing a Netflix title",
  movieId: /^\d+$/u,
  scripts: NETFLIX_SCRIPTS,
  requests: { start: "hd_netflix_capture_start", finish: "hd_netflix_capture_finish", cancel: "hd_netflix_capture_cancel",
    lineAudio: "hd_netflix_line_audio", load: "hd_netflix_load" },
});

export { netflixMining };
