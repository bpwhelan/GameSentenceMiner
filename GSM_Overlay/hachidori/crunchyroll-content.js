// SPDX-License-Identifier: GPL-3.0-or-later

// Experimental Crunchyroll mining, the reader's side. crunchyroll.js registers
// this classic script after the video-site layer it uses (netflix-subtitles.js,
// netflix-audio.js and netflix-content.js) in the content scripts' world on
// https://www.crunchyroll.com/* (top frame, document_start) while Settings →
// Advanced → Experimental features → Crunchyroll mining is on. Crunchyroll has
// no Japanese subtitles for Hachidori to read, so a user script shows them
// (the Script Store's Jimaku Player) and posts their timing to this reader as
// netflix-page.js does on the other sites (docs/architecture.md, Crunchyroll
// mining). The page script replays, pauses and resumes the player's <video>.
(function () {
  "use strict";

  // /watch/<episode>/<title>, after the address's language (/de/, /pt-br/).
  const WATCH_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/([A-Z\d]+)(?:\/|$)/u;

  const CRUNCHYROLL = Object.freeze({
    name: "Crunchyroll",
    field: "crunchyroll",
    pageEvent: "hachidori-crunchyroll-page",
    commandEvent: "hachidori-crunchyroll-command",
    movieId: /^[A-Z\d]+$/u,
    statuses: new Set(),
    formats: new Set(["webvtt"]),
    // Crunchyroll moves between episodes inside one document.
    watched: location => WATCH_PATH.exec(location.pathname)?.[1] ?? null,
    video: document => document.querySelector(".bitmovinplayer-container video") ?? document.querySelector("video"),
    // The user script's subtitles, and a line in them.
    subtitle: "[data-hachidori-subtitles]",
    line: "[data-hachidori-subtitle-line]",
    recorderPage: "crunchyroll-recorder.html",
    requests: { start: "hd_crunchyroll_capture_start", finish: "hd_crunchyroll_capture_finish",
      cancel: "hd_crunchyroll_capture_cancel", lineAudio: "hd_crunchyroll_line_audio" },
    // A picture of the line is of the video alone: hidden while it is taken
    // are the user script's subtitles and what else it marks, and what the
    // player draws beside its <video> (its controls, title and own subtitles).
    overVideo: "[data-hachidori-subtitles], [data-hachidori-over-video], "
      + ".bitmovinplayer-container > :not(video, :has(video))",
    cropToVideo: true,
  });

  globalThis.HDCrunchyroll = globalThis.HDVideoSite.createVideoSite(globalThis, CRUNCHYROLL);
}());
