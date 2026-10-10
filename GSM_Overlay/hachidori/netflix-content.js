// SPDX-License-Identifier: GPL-3.0-or-later

// Experimental Netflix mining, the reader's side. netflix.js registers this
// classic script after netflix-subtitles.js and netflix-audio.js in the content
// scripts' world on https://www.netflix.com/* (top frame, document_start)
// while Settings → Advanced → Experimental features → Netflix mining is on. It
// keeps the subtitle timelines netflix-page.js posts from the page, pins the
// cue of a hovered `.player-timedtext` line, records that line for Anki from
// what the viewer heard (netflix-audio.js) or while the page plays or replays
// it, and pauses the video while a subtitle line or Hachidori's popup is hovered.
(function () {
  "use strict";

  const PAGE_EVENT = "hachidori-netflix-page";
  const COMMAND_EVENT = "hachidori-netflix-command";
  // content.js announces its popup on `window`; nested popups open inside it.
  const POPUP_SHOWN_EVENT = "hachidori-popup-shown";
  const POPUP_HIDDEN_EVENT = "hachidori-popup-hidden";
  const WATCH_PATH = /^\/watch\/(\d+)/u;
  const MOVIE_ID = /^\d+$/u;
  const STATUSES = new Set(["image", "none", "failed"]);
  const FORMATS = new Set(["webvtt", "ttml"]);
  // The page gives up on a replay after its two bounded seeks (10 s each) and
  // REPLAY_SLACK_MS in netflix-page.js; the reader waits a little longer for
  // that answer.
  const REPLAY_SLACK_MS = 35_000;
  // How long the line audio has to deliver what was played until now.
  const DRAIN_MS = 500;
  const SHOW_TEXT = 4;

  function createNetflix(window, subtitles = window.HDNetflixSubtitles, lineAudioApi = window.HDNetflixAudio) {
    const { document, location } = window;
    // movieId → { tracks: Map(trackId → { id, closedCaptions, cues }), status, chosen }
    const movies = new Map();
    // Movies this page has moved away from: their late posts are not wanted.
    const retired = new Set();
    const resent = new Set();
    const replays = new Map();
    let watched = null;
    // Hover pause, which content.js turns on with the switch. `held` while
    // the pause this reader asked for, or kept through a recording, is in
    // force; `restoring` from a replay's answer until the page's seek back has
    // landed; `recordings` while a line is recorded.
    let hoverPause = false;
    let hovering = false;
    let popupOpen = false;
    let held = false;
    let restoring = false;
    let recordings = 0;
    // What the viewer hears, kept while content.js has the switch on.
    let lineAudio = null;
    const range = document.createRange();

    const command = message => {
      document.dispatchEvent(new window.CustomEvent(COMMAND_EVENT, { detail: JSON.stringify(message) }));
    };
    const watchedMovie = () => WATCH_PATH.exec(location.pathname)?.[1] ?? null;

    // A new /watch/<id> drops the previous movie's timeline and any resume
    // this reader still owed it.
    function sync() {
      const movieId = watchedMovie();
      if (movieId === watched) return movieId;
      if (watched !== null) {
        retired.add(watched);
        movies.delete(watched);
      }
      if (movieId !== null) retired.delete(movieId);
      resent.clear();
      held = false;
      watched = movieId;
      return movieId;
    }

    function movie(movieId) {
      if (!movies.has(movieId)) movies.set(movieId, { tracks: new Map(), status: null, chosen: null });
      return movies.get(movieId);
    }

    function settleReplay(message) {
      const pending = typeof message.id === "string" ? replays.get(message.id) : undefined;
      if (pending === undefined) return;
      replays.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.ok === true && Array.isArray(message.anchors)) {
        pending.resolve(message.anchors.filter(pair => Array.isArray(pair) && pair.length === 2
          && pair.every(Number.isFinite)));
      } else {
        pending.reject(Object.assign(new Error(`Netflix's player could not replay the line (${message.error}).`),
          { code: message.error === "player" ? "player" : "replay" }));
      }
      // The page restores the viewer's state as it answers; its seek back
      // reports itself afterwards. Playing on seeks nowhere.
      restoring = !pending.playOn;
    }

    // Everything the page posts is checked before it is used: any script on
    // the page can dispatch these events.
    function accept(detail) {
      let message;
      try {
        message = JSON.parse(detail);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      sync();
      if (message.kind === "replay") {
        settleReplay(message);
        return;
      }
      if (typeof message.movieId !== "string" || !MOVIE_ID.test(message.movieId) || retired.has(message.movieId)) return;
      if (message.kind === "status" && STATUSES.has(message.subtitles)) {
        movie(message.movieId).status ??= message.subtitles;
        return;
      }
      if (message.kind !== "subtitle" || typeof message.trackId !== "string" || message.trackId === ""
          || typeof message.closedCaptions !== "boolean" || !FORMATS.has(message.format)
          || typeof message.text !== "string") return;
      let cues;
      try {
        cues = subtitles.parseSubtitles(message.format, message.text, { DOMParser: window.DOMParser });
      } catch {
        movie(message.movieId).status ??= "failed";
        return;
      }
      movie(message.movieId).tracks.set(message.trackId, { id: message.trackId, closedCaptions: message.closedCaptions,
        cues: cues.map(cue => ({ ...cue, key: subtitles.normaliseCueText(cue.text) })) });
    }

    function visibleText(element) {
      const walker = document.createTreeWalker(element, SHOW_TEXT);
      let text = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest("rt, rp")) text += node.nodeValue;
      }
      return text;
    }

    const mainVideo = () => document.querySelector(".watch-video video") ?? document.querySelector("video");
    // The line audio keeps the player's sound only, not a preview's on another page.
    const watchVideo = () => (watchedMovie() === null ? null : mainVideo());

    function mediaTimeMs() {
      const video = mainVideo();
      return video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : null;
    }

    // What the reader saw when the popup opened: the subtitle line under the
    // pointer and the video's time. Null for anything but Netflix's subtitles.
    function observe(element) {
      const subtitle = element?.closest?.(".player-timedtext");
      if (!subtitle) return null;
      const container = element.closest(".player-timedtext-text-container") ?? subtitle;
      return { movieId: sync(), mediaTimeMs: mediaTimeMs(), lineText: visibleText(container),
        hoveredText: visibleText(element) };
    }

    function askAgain(movieId) {
      if (resent.has(movieId)) return;
      resent.add(movieId);
      command({ type: "resend", movieId });
    }

    // One text's matches across the tracks: the cue when exactly one track has
    // exactly one, and whether a track had several.
    function matchText(entry, tracks, observation, text) {
      const found = tracks.map(track => ({ track, cues: subtitles.matchingCues(track.cues, observation.mediaTimeMs, text) }));
      const unique = found.find(candidate => candidate.cues.length === 1);
      if (unique === undefined) return { ambiguous: found.some(candidate => candidate.cues.length > 1) };
      if (entry.chosen === null && entry.tracks.size > 1 && found.filter(candidate => candidate.cues.length > 0).length === 1) {
        entry.chosen = unique.track;
      }
      const [cue] = unique.cues;
      return { cue: { movieId: observation.movieId, trackId: unique.track.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text } };
    }

    // The cue an observation belongs to, or the reason there is none. With
    // Japanese and Japanese [CC] tracks, the first line that matches in only
    // one of them chooses that track for the episode.
    function resolve(observation) {
      sync();
      const movieId = observation?.movieId;
      const entry = typeof movieId === "string" ? movies.get(movieId) : undefined;
      if (entry === undefined || entry.tracks.size === 0) {
        if (typeof movieId === "string" && !entry?.status) askAgain(movieId);
        return { reason: entry?.status ?? "no-timeline" };
      }
      const tracks = entry.chosen ? [entry.chosen]
        : [...entry.tracks.values()].sort((left, right) => left.closedCaptions - right.closedCaptions);
      let ambiguous = false;
      for (const text of new Set([observation.lineText, observation.hoveredText])) {
        const match = matchText(entry, tracks, observation, text);
        if (match.cue) return { cue: match.cue };
        ambiguous ||= match.ambiguous;
      }
      return { reason: ambiguous ? "ambiguous" : "no-match" };
    }

    // The mining request's Netflix fields. `sentence` is the root lookup's
    // candidate, whose sentence becomes the whole cue; nested lookups keep
    // their own sentence and inherit only the cue.
    function miningFields(observation, sentence = null) {
      if (!observation) return {};
      const resolved = resolve(observation);
      if (!resolved.cue) return { netflix: { unavailable: resolved.reason } };
      const { movieId, startMs, endMs, text } = resolved.cue;
      const whole = sentence ? subtitles.cueSentence(text, sentence.sentence, sentence.matchOffset) : null;
      return { netflix: { cue: { movieId, startMs, endMs } }, ...whole };
    }

    // Has the page play the cue's line at 1×: from just before it, or with
    // `playOn` on from where the video stands, then restore the viewer's state.
    // Resolves with its (wall ms, media ms) pairs.
    function replay(cue, padMs, playOn = false) {
      const id = window.crypto.randomUUID();
      // With hover pause the page leaves a playing video paused at the end,
      // and this reader resumes it once the line is recorded and the pointer
      // has left: Chrome mutes a captured tab until its recorder stops, and a
      // line played on stops at its end.
      const video = mainVideo();
      if (hoverPause && video !== null && !video.paused) held = true;
      return new Promise((resolveReplay, rejectReplay) => {
        const timer = window.setTimeout(() => {
          replays.delete(id);
          rejectReplay(Object.assign(new Error("Netflix's player did not finish replaying the line."), { code: "replay" }));
        }, cue.endMs - cue.startMs + 2 * padMs + REPLAY_SLACK_MS);
        replays.set(id, { resolve: resolveReplay, reject: rejectReplay, timer, playOn });
        command({ type: "replay", id, startMs: cue.startMs, endMs: cue.endMs, padMs, keepPaused: hoverPause,
          ...(playOn ? { playOn: true } : {}) });
      });
    }

    // The hidden extension frame that records the tab (netflix-capture.js).
    function recorderFrame() {
      const frame = document.createElement("iframe");
      frame.src = window.chrome.runtime.getURL("netflix-recorder.html");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.setProperty("display", "none", "important");
      // Outside Netflix's own app root, so its rendering cannot remove it.
      document.documentElement.append(frame);
      return frame;
    }

    // Records the cue's line with tab capture: a recorder frame opens the tab's
    // stream, the page replays the line, then the frame cuts the clip (with
    // audio unset, no WAV; with gif set, a looping GIF of the line) and the
    // worker holds its files for the note. Resolves with { audio, gif } for
    // the fields, or with why there is none.
    async function recordTab(cue, { send, templateId, audio, gif }) {
      const frame = recorderFrame();
      try {
        const started = await send("hd_netflix_capture_start", { cue, audio, gif });
        if (typeof started.unavailable === "string") return { unavailable: started.unavailable };
        if (typeof started.sessionId !== "string" || !Number.isFinite(started.padMs)) {
          throw new TypeError("the recording did not start.");
        }
        let anchors;
        try {
          anchors = await replay(cue, started.padMs);
        } catch (error) {
          await send("hd_netflix_capture_cancel", { sessionId: started.sessionId }).catch(() => {});
          return { unavailable: error.code === "player" ? "player" : "replay" };
        }
        return await send("hd_netflix_capture_finish", { sessionId: started.sessionId, anchors, templateId });
      } finally {
        frame.remove();
      }
    }

    // The cue's line with its pads, within the video.
    function lineSpan(cue) {
      const duration = mainVideo()?.duration;
      const end = cue.endMs + lineAudioApi.PAD_MS;
      return { from: Math.max(0, cue.startMs - lineAudioApi.PAD_MS),
        to: Number.isFinite(duration) ? Math.min(end, duration * 1000) : end };
    }

    // The line as the viewer heard it at 1×, once the line audio has what has
    // played until now, or null.
    async function heardLine(cue) {
      const { from, to } = lineSpan(cue);
      await lineAudio.settled(DRAIN_MS);
      return lineAudio.clip(cue.movieId, from, to);
    }

    // Plays what the viewer has not heard of the line, so the line audio keeps
    // it: on from where the video stands when the start was heard (hover pause
    // stops a line partway), otherwise the whole line again. Both are audible.
    async function playLine(cue) {
      const { from, to } = lineSpan(cue);
      const position = mediaTimeMs();
      const playOn = position !== null && position >= from && position < to
        && lineAudio.covers(cue.movieId, from, position);
      await replay(cue, lineAudioApi.PAD_MS, playOn);
      return heardLine(cue);
    }

    // A clip of the line for its {sentence-audio} field: held by the worker,
    // or why there is none.
    async function holdLine(clip, { send, templateId }) {
      if (clip === null) return { unavailable: "unheard" };
      if (lineAudioApi.isSilent(clip.samples)) return { unavailable: "silent" };
      const held = await send("hd_netflix_line_audio", { data: lineAudioApi.wavBase64(clip), templateId });
      return typeof held.unavailable === "string" ? { unavailable: held.unavailable }
        : { token: held.token, filename: held.filename };
    }

    // Records the cue's line for the fields that map it: `audio` for
    // {sentence-audio}, `gif` for {gif}. Sentence audio comes from what the
    // viewer heard, played on or replayed if need be, while the line audio
    // keeps the video's sound; tab capture records a GIF, and the audio too
    // otherwise. `conceal` hides Hachidori's overlays around tab capture only.
    // Resolves with { audio, gif } for the fields, or with why there is none.
    async function record(cue, { send, templateId, audio = true, gif = false, conceal = during => during() }) {
      recordings += 1;
      try {
        if (!audio || lineAudio?.ready() !== true) return await conceal(() => recordTab(cue, { send, templateId, audio, gif }));
        let clip = await heardLine(cue);
        const result = {};
        if (gif) {
          try {
            const recorded = await conceal(() => recordTab(cue, { send, templateId, audio: false, gif }));
            result.gif = typeof recorded.unavailable === "string" ? { unavailable: recorded.unavailable } : recorded.gif;
          } catch (error) {
            // The GIF and the sentence audio are recorded apart, so a failed
            // GIF costs only the GIF.
            result.gif = { unavailable: error.message };
          }
          // The GIF's replay played the line, and the line audio kept it.
          clip ??= await heardLine(cue);
        }
        try {
          clip ??= await playLine(cue);
          result.audio = await holdLine(clip, { send, templateId });
        } catch (error) {
          result.audio = { unavailable: error.code ?? error.message };
        }
        return result;
      } finally {
        recordings -= 1;
        // A leave during the recording takes effect now the line has played.
        release();
      }
    }

    // Netflix's subtitle layer covers the player and may not receive pointer
    // events, so a hovered line is found by geometry: within the bounds of a
    // subtitle box's text, which also span the gap between its lines. A layer
    // with no line showing has no text, so no bounds.
    function overSubtitle(x, y) {
      for (const box of document.querySelectorAll(".player-timedtext .player-timedtext-text-container")) {
        const rects = [];
        const walker = document.createTreeWalker(box, SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          range.selectNodeContents(node);
          rects.push(...range.getClientRects());
        }
        if (x >= Math.min(...rects.map(rect => rect.left)) && x <= Math.max(...rects.map(rect => rect.right))
            && y >= Math.min(...rects.map(rect => rect.top)) && y <= Math.max(...rects.map(rect => rect.bottom))) {
          return true;
        }
      }
      return false;
    }

    // Leaving the line and the popup resumes what this reader paused, unless a
    // line is being recorded.
    function release() {
      sync();
      if (!held || hovering || popupOpen || recordings > 0) return;
      held = false;
      command({ type: "resume" });
    }

    // Entering a line while the video plays pauses it, once: whatever the
    // viewer does while the pointer stays on the line is the viewer's.
    function pointerMoved(event) {
      if (!hoverPause || sync() === null) return;
      const over = overSubtitle(event.clientX, event.clientY);
      if (over === hovering) return;
      hovering = over;
      if (!over) {
        release();
        return;
      }
      const video = mainVideo();
      if (held || recordings > 0 || video === null || video.paused) return;
      held = true;
      command({ type: "pause" });
    }

    // Anything else that plays or seeks the video takes the pause over, and
    // nothing is resumed; a pause can only follow a play. A replay's own play
    // and seeks are not the viewer's, and nor is the page's seek back.
    function videoChanged(event) {
      if (event.target !== mainVideo()) return;
      if (event.type === "seeked") restoring = false;
      else if (replays.size === 0 && !(restoring && event.type === "seeking")) held = false;
    }

    // content.js turns hover pause on and off with the Netflix mining switch.
    // Turned off, it forgets a pause in force rather than resuming it.
    function setHoverPause(enabled) {
      hoverPause = enabled === true;
      if (hoverPause) return;
      held = false;
      hovering = false;
    }

    // content.js turns the line audio on and off with the switch too. Off, it
    // stops keeping the video's sound and frees what it kept.
    function setLineAudio(enabled) {
      if (enabled === true) {
        lineAudio ??= lineAudioApi.createLineAudio(window, { video: watchVideo, movie: watchedMovie });
        lineAudio.start();
      } else {
        lineAudio?.stop();
      }
    }

    document.addEventListener(PAGE_EVENT, event => {
      if (typeof event.detail === "string") accept(event.detail);
    });
    document.addEventListener("mousemove", pointerMoved, { capture: true, passive: true });
    for (const type of ["play", "seeking", "seeked"]) document.addEventListener(type, videoChanged, true);
    window.addEventListener(POPUP_SHOWN_EVENT, () => { popupOpen = true; });
    window.addEventListener(POPUP_HIDDEN_EVENT, () => {
      popupOpen = false;
      release();
    });

    return { observe, resolve, miningFields, record, setHoverPause, setLineAudio };
  }

  globalThis.HDNetflix = { ...createNetflix(globalThis), createNetflix };
}());
