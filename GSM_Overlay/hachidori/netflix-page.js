// SPDX-License-Identifier: GPL-3.0-or-later
//
// Experimental Netflix mining, the page's side. netflix.js registers this script
// in the main world of https://www.netflix.com/* at document_start while
// Settings → Advanced → Experimental features → Netflix mining is on, so the
// JSON hooks are in place before Netflix's own bundle runs. No extension API is
// available here; it talks to netflix-content.js through DOM events whose
// detail is a JSON string.
//
// The JSON.stringify hook that asks Netflix for a WebVTT download of every text
// track, the profile list it looks for, and the JSON.parse hook and track filter
// that read the movie's subtitle tracks are adapted from Subadub
// (https://github.com/rsimmons/subadub, dist/page_script.js at
// a03b1b94e59328c11e31485c6016626fcfeb2790), under this licence:
//
//   The MIT License (MIT)
//
//   Copyright (c) 2018 Russel Simmons
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
(function () {
  "use strict";

  const PAGE_EVENT = "hachidori-netflix-page";
  const COMMAND_EVENT = "hachidori-netflix-command";
  // Subadub's profile: asked for, Netflix lists a WebVTT download for each track.
  const WEBVTT_PROFILE = "webvtt-lssdh-ios8";
  // Subadub's profiles, which identify the manifest request's profile list.
  const NETFLIX_PROFILES = new Set(["heaac-2-dash", "heaac-2hq-dash", "playready-h264mpl30-dash",
    "playready-h264mpl31-dash", "playready-h264hpl30-dash", "playready-h264hpl31-dash",
    "vp9-profile0-L30-dash-cenc", "vp9-profile0-L31-dash-cenc", "dfxp-ls-sdh", "simplesdh", "nflx-cmisc",
    "BIF240", "BIF320"]);
  // What a profile list looks like in JSON: the key Subadub looks for, or one
  // of its profile names. Profile names are letters, digits and hyphens.
  const PROFILE_MARKER = new RegExp(String.raw`"profiles":\s*\[|"(?:${[...NETFLIX_PROFILES].join("|")})"`, "u");
  // Text downloads netflix-subtitles.js reads, in order of preference.
  const DOWNLOADS = [[WEBVTT_PROFILE, "webvtt"], ["imsc1.1", "ttml"], ["dfxp-ls-sdh", "ttml"], ["simplesdh", "ttml"]];
  const POLL_MS = 25;
  const SEEK_TIMEOUT_MS = 10_000;
  // Beyond the line itself, a replay has this long to buffer and play.
  const REPLAY_SLACK_MS = 10_000;
  // A seek that lands after the clip's start is retried this much earlier.
  const PREROLL_MS = 2000;
  const WATCH_PATH = /^\/watch\/(\d+)/u;

  const originalStringify = JSON.stringify;
  const originalParse = JSON.parse;
  const fetchText = window.fetch.bind(window);
  // The subtitles already posted, by movie and track, so a reader that missed
  // them can ask again. Only the movie being watched and the latest manifest's
  // movie (the next episode Netflix prepares) are kept.
  const posted = new Map();
  let replaying = false;

  const post = message => {
    document.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: Reflect.apply(originalStringify, JSON, [message]) }));
  };

  // Subadub searches the request for its profile list rather than naming the
  // property, because Netflix renames it. Only a list of profile names counts.
  // Visited objects are skipped, so a cyclic value still reaches JSON.stringify
  // and gets the TypeError Netflix expects.
  function profileList(value) {
    if (value === null || typeof value !== "object") return null;
    const seen = new Set();
    const stack = [value];
    while (stack.length > 0) {
      const node = stack.pop();
      if (seen.has(node) || ArrayBuffer.isView(node) || node instanceof ArrayBuffer) continue;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child) && child.length > 0 && child.every(item => typeof item === "string")
            && (key === "profiles" || child.some(item => NETFLIX_PROFILES.has(item)))) return child;
        if (child !== null && typeof child === "object") stack.push(child);
      }
    }
    return null;
  }

  // A download's URLs are a list of { url } records, or a map of CDN URLs.
  function firstUrl(urls) {
    if (Array.isArray(urls)) return urls[0];
    return urls && typeof urls === "object" ? Object.values(urls)[0] : null;
  }

  function download(track) {
    for (const [profile, format] of DOWNLOADS) {
      const first = firstUrl(track.downloadables?.[profile]?.urls);
      const url = typeof first === "string" ? first : first?.url;
      if (typeof url === "string" && url !== "") return { url, format };
    }
    return null;
  }

  function japanese(track) {
    const language = String(track.language ?? track.bcp47 ?? "").toLowerCase();
    return language === "ja" || language.startsWith("ja-");
  }

  function trackId(track, index) {
    const id = [track.id, track.trackId, track.new_track_id].find(value => typeof value === "string" || Number.isFinite(value));
    return id === undefined ? `track-${index}` : String(id);
  }

  function retain(movieId) {
    const watched = WATCH_PATH.exec(location.pathname)?.[1];
    for (const id of posted.keys()) if (id !== movieId && id !== watched) posted.delete(id);
    if (!posted.has(movieId)) posted.set(movieId, new Map());
  }

  function publish(movieId, key, message) {
    posted.get(movieId)?.set(key, message);
    post(message);
  }

  function readTracks(result) {
    // Netflix also fetches manifests for previews on its browse pages.
    if (!WATCH_PATH.test(location.pathname)) return;
    const movieId = String(result.movieId);
    if (!/^\d+$/u.test(movieId)) return;
    retain(movieId);
    // Subadub's filter, plus image subtitles, which have no text to time.
    const tracks = result.textTracks.filter(track => track && typeof track === "object"
      && !track.isForcedNarrative && !track.isNoneTrack && japanese(track));
    const text = tracks.map((track, index) => ({ track, index, file: track.isImageBased ? null : download(track) }))
      .filter(entry => entry.file !== null);
    if (text.length === 0) {
      publish(movieId, "status", { kind: "status", movieId, subtitles: tracks.length > 0 ? "image" : "none" });
      return;
    }
    for (const { track, index, file } of text) {
      const id = trackId(track, index);
      const closedCaptions = String(track.rawTrackType).toLowerCase() === "closedcaptions";
      fetchText(file.url)
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then(body => publish(movieId, id, { kind: "subtitle", movieId, trackId: id, closedCaptions, format: file.format, text: body }))
        .catch(() => publish(movieId, "status", { kind: "status", movieId, subtitles: "failed" }));
    }
  }

  JSON.stringify = function stringify() {
    const text = Reflect.apply(originalStringify, this, arguments);
    // Most of Netflix's calls carry no profile list. One scan of their output
    // decides, so only the manifest request is searched and written again.
    if (typeof text !== "string" || !PROFILE_MARKER.test(text)) return text;
    try {
      const profiles = profileList(arguments[0]);
      if (profiles === null || profiles.includes(WEBVTT_PROFILE)) return text;
      profiles.unshift(WEBVTT_PROFILE);
    } catch {
      // A value Hachidori cannot inspect is stringified exactly as Netflix asked.
      return text;
    }
    return Reflect.apply(originalStringify, this, arguments);
  };

  JSON.parse = function parse() {
    const value = Reflect.apply(originalParse, this, arguments);
    try {
      const result = value?.result;
      if (result && typeof result === "object" && result.movieId !== undefined && Array.isArray(result.textTracks)) {
        readTracks(result);
      }
    } catch {
      // Netflix gets its value whatever this script makes of it.
    }
    return value;
  };

  const wallClock = () => performance.timeOrigin + performance.now();

  // Netflix's own player: writing <video>.currentTime makes Netflix stop with
  // error M7375, so seeking goes through its player API. Netflix keeps other
  // sessions beside the watch page's, such as the next episode it prepares, and
  // need not list that one first or last, so the player is chosen as
  // netflix-preview.js chooses it: a `watch` session playing the movie in the
  // address whose element is inside `.watch-video`. A page with a single
  // session keeps that one even when it does not say what it is.
  function netflixPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      const ids = api?.getAllPlayerSessionIds?.() ?? [];
      const movieId = WATCH_PATH.exec(location.pathname)?.[1];
      const watching = [];
      for (const id of ids) {
        const session = typeof id === "string" && id.startsWith("watch") ? api.getVideoPlayerBySessionId?.(id) : null;
        if (typeof session?.getMovieId === "function" && String(session.getMovieId()) === movieId) watching.push(session);
      }
      const root = document.querySelector(".watch-video");
      const shown = watching.filter(session => typeof session.getElement === "function" && root?.contains(session.getElement()));
      let player = null;
      if (shown.length === 1) player = shown[0];
      else if (shown.length === 0 && watching.length === 1 && typeof watching[0].getElement !== "function") player = watching[0];
      else if (shown.length === 0 && ids.length === 1) player = api.getVideoPlayerBySessionId?.(ids[0]);
      return typeof player?.seek === "function" ? player : null;
    } catch {
      return null;
    }
  }

  const mainVideo = () => document.querySelector(".watch-video video") ?? document.querySelector("video");
  const play = (player, video) => Promise.resolve(typeof player.play === "function" ? player.play() : video.play());
  const pause = (player, video) => (typeof player.pause === "function" ? player.pause() : video.pause());

  function seek(player, video, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        video.removeEventListener("seeked", done);
        reject(Object.assign(new Error("seek"), { code: "seek" }));
      }, SEEK_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        resolve(video.currentTime * 1000);
      }
      video.addEventListener("seeked", done, { once: true });
      Promise.resolve(player.seek(Math.max(0, Math.round(ms)))).catch(() => {});
    });
  }

  // Each part of the viewer's state is restored on its own, whatever the
  // others do. A line played on stays where it ended.
  function restore(player, video, saved, seekBack) {
    const steps = [
      () => pause(player, video),
      () => { if (seekBack) Promise.resolve(player.seek(Math.max(0, Math.round(saved.positionMs)))).catch(() => {}); },
      () => { video.playbackRate = saved.rate; },
      () => { if (!saved.paused) play(player, video).catch(() => {}); },
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        // The remaining steps still run.
      }
    }
  }

  // Where the viewer is, by Netflix's own clock when it answers.
  function currentPosition(player, video) {
    try {
      const reported = typeof player.getCurrentTime === "function" ? player.getCurrentTime() : Number.NaN;
      if (Number.isFinite(reported)) return reported;
    } catch {
      // The element's own time is the position to return to.
    }
    return video.currentTime * 1000;
  }

  // (wall-clock ms, media ms) pairs while the video plays forward, until media
  // time `to`; a replay that has not got there by `deadline` failed.
  function sample(video, to, deadline) {
    return new Promise((resolve, reject) => {
      const anchors = [];
      let previous = null;
      const timer = setInterval(() => {
        const media = video.currentTime * 1000;
        if (!video.paused && !video.seeking && previous !== null && media > previous) anchors.push([wallClock(), media]);
        previous = media;
        if (media >= to || video.ended) {
          clearInterval(timer);
          resolve(anchors);
        } else if (wallClock() > deadline) {
          clearInterval(timer);
          reject(Object.assign(new Error("timeout"), { code: "timeout" }));
        }
      }, POLL_MS);
    });
  }

  // Plays the clip once at 1× from just before the cue to just after it and
  // reports (wall-clock ms, media ms) pairs, so the extension can find the
  // line in what it recorded. Position, paused state and speed are restored;
  // with `keepPaused`, the reader's hover pause resumes the video once the
  // recording is over, so a playing video is restored paused. With `playOn`
  // it plays from where the video stands, without seeking, and stays at the
  // clip's end: the reader has heard the rest of the line already.
  async function replay({ id, startMs, endMs, padMs, keepPaused, playOn }) {
    const player = netflixPlayer();
    const video = mainVideo();
    if (player === null || video === null || replaying) {
      post({ kind: "replay", id, ok: false, error: replaying ? "busy" : "player" });
      return;
    }
    replaying = true;
    const saved = { positionMs: currentPosition(player, video), paused: video.paused || keepPaused === true,
      rate: video.playbackRate };
    const from = Math.max(0, startMs - padMs);
    const to = endMs + padMs;
    let reply;
    try {
      video.playbackRate = 1;
      if (playOn !== true) {
        const landed = await seek(player, video, from);
        if (landed > from + 50 && from > 0) await seek(player, video, from - PREROLL_MS);
      }
      await play(player, video);
      const anchors = await sample(video, to, wallClock() + (to - from) + REPLAY_SLACK_MS);
      reply = { kind: "replay", id, ok: true, anchors };
    } catch (error) {
      reply = { kind: "replay", id, ok: false, error: error?.code ?? "replay" };
    } finally {
      restore(player, video, saved, playOn !== true);
      replaying = false;
    }
    post(reply);
  }

  // Hovering a subtitle pauses and resumes through the player like the replay,
  // which owns the player until it has restored the viewer's state.
  function pauseOrResume(type) {
    const player = netflixPlayer();
    const video = mainVideo();
    if (replaying || player === null || video === null) return;
    try {
      if (type === "pause") pause(player, video);
      else play(player, video).catch(() => {});
    } catch {
      // Netflix's player stays as it was.
    }
  }

  document.addEventListener(COMMAND_EVENT, event => {
    let command;
    try {
      command = typeof event.detail === "string" ? Reflect.apply(originalParse, JSON, [event.detail]) : null;
    } catch {
      return;
    }
    if (command?.type === "resend" && typeof command.movieId === "string") {
      for (const message of posted.get(command.movieId)?.values() ?? []) post(message);
    } else if (command?.type === "replay" && typeof command.id === "string"
        && [command.startMs, command.endMs, command.padMs].every(Number.isFinite) && command.startMs <= command.endMs) {
      void replay(command);
    } else if (command?.type === "pause" || command?.type === "resume") {
      pauseOrResume(command.type);
    }
  });
}());
