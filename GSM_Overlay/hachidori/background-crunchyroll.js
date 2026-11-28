// Experimental Crunchyroll mining in the service worker: Crunchyroll's names
// for the video-site service (background-video.js): the recorder frame's port,
// line recordings, and the MP3 the player page cuts from what the viewer heard.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createVideoSiteService } from "./background-video.js";
import { CRUNCHYROLL_SCRIPTS } from "./crunchyroll.js";

// Experimental Crunchyroll mining (docs/architecture.md, Crunchyroll mining).
// An episode's address may start with its language (/de/, /pt-br/).
const CRUNCHYROLL_TARGET = "hachidori-crunchyroll";
const CRUNCHYROLL_RECORDER_PORT = "hachidori-crunchyroll-recorder";
const CRUNCHYROLL_WATCH_URL = /^https:\/\/www\.crunchyroll\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/[A-Z\d]+(?:[/?#]|$)/u;

const crunchyrollMining = createVideoSiteService({
  name: "Crunchyroll",
  enabled: options => options.experimental.crunchyrollMining === true,
  target: CRUNCHYROLL_TARGET,
  recorderPort: CRUNCHYROLL_RECORDER_PORT,
  recorderPage: "crunchyroll-recorder.html",
  origin: "https://www.crunchyroll.com/",
  playerUrl: CRUNCHYROLL_WATCH_URL,
  playing: "playing a Crunchyroll episode",
  movieId: /^[A-Z\d]+$/u,
  scripts: CRUNCHYROLL_SCRIPTS,
  requests: { start: "hd_crunchyroll_capture_start", finish: "hd_crunchyroll_capture_finish",
    cancel: "hd_crunchyroll_capture_cancel", lineAudio: "hd_crunchyroll_line_audio", load: "hd_crunchyroll_load" },
});

export { crunchyrollMining };
