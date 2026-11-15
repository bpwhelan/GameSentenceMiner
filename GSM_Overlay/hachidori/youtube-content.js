// SPDX-License-Identifier: GPL-3.0-or-later

// YouTube mining, the reader's side. youtube.js registers this classic script
// after the video-site layer it uses (netflix-subtitles.js, netflix-audio.js
// and netflix-content.js) in the content scripts' world on
// https://www.youtube.com/* (top frame, document_start) while Settings → Anki
// → Video mining → YouTube mining is on. It says where
// YouTube keeps its player, video and captions; the page script,
// netflix-page.js, posts the caption files the player loads and which video it
// plays.
(function () {
  "use strict";

  // The watch page's player, which the miniplayer keeps; not the Shorts
  // player or the inline previews of other pages.
  const PLAYER = "#movie_player";

  const YOUTUBE = Object.freeze({
    name: "YouTube",
    field: "youtube",
    pageEvent: "hachidori-youtube-page",
    commandEvent: "hachidori-youtube-command",
    movieId: /^[\w-]{11}$/u,
    statuses: new Set(["live", "failed"]),
    formats: new Set(["json3"]),
    // The page says which video its player plays; the address need not, as
    // in the miniplayer.
    reportsVideo: true,
    // Each caption file names its language, which picks the profile of a
    // lookup in it with automatic language switching (docs/languages.md 8.5).
    trackLanguage: true,
    video: document => document.querySelector(`${PLAYER} video.html5-main-video`)
      ?? document.querySelector(`${PLAYER} video`),
    adShowing: document => document.querySelector(PLAYER)?.classList.contains("ad-showing") === true,
    // YouTube's captions: the layer in the player, and a caption window in it.
    subtitle: `${PLAYER} .ytp-caption-window-container`,
    line: ".caption-window",
    recorderPage: "youtube-recorder.html",
    requests: { start: "hd_youtube_capture_start", finish: "hd_youtube_capture_finish",
      cancel: "hd_youtube_capture_cancel", lineAudio: "hd_youtube_line_audio" },
    // The page does not replay a line while an ad plays.
    replayErrors: new Set(["ad"]),
    // A GIF of the tab keeps only the video, which shares the page with
    // YouTube's other content.
    cropToVideo: true,
  });

  globalThis.HDYouTube = globalThis.HDVideoSite.createVideoSite(globalThis, YOUTUBE);
}());
