// Experimental YouTube mining in the service worker: YouTube's names for the
// video-site service (background-video.js): the recorder frame's port, line
// recordings, and the WAV the player page cuts from what the viewer heard.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createVideoSiteService } from "./background-video.js";
import { YOUTUBE_SCRIPTS } from "./youtube.js";

// Experimental YouTube mining (docs/architecture.md, YouTube mining). The
// player can play on any page of the site, in its miniplayer.
const YOUTUBE_TARGET = "hachidori-youtube";
const YOUTUBE_RECORDER_PORT = "hachidori-youtube-recorder";
const YOUTUBE_PAGE_URL = /^https:\/\/www\.youtube\.com\//u;

const youtubeMining = createVideoSiteService({
  name: "YouTube",
  flag: "youtubeMining",
  target: YOUTUBE_TARGET,
  recorderPort: YOUTUBE_RECORDER_PORT,
  recorderPage: "youtube-recorder.html",
  origin: "https://www.youtube.com/",
  playerUrl: YOUTUBE_PAGE_URL,
  playing: "showing YouTube",
  movieId: /^[\w-]{11}$/u,
  scripts: YOUTUBE_SCRIPTS,
  requests: { start: "hd_youtube_capture_start", finish: "hd_youtube_capture_finish", cancel: "hd_youtube_capture_cancel",
    lineAudio: "hd_youtube_line_audio", load: "hd_youtube_load" },
});

export { YOUTUBE_PAGE_URL, youtubeMining };
