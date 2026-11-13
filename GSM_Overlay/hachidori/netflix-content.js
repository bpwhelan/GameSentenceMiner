// SPDX-License-Identifier: GPL-3.0-or-later

// Netflix and YouTube mining, the reader's side: the video-site layer both
// sites share. netflix.js registers this classic script after
// netflix-subtitles.js and netflix-audio.js in the content scripts' world on
// https://www.netflix.com/* (top frame, document_start) while Settings →
// Advanced → Experimental features → Netflix mining is on, and youtube.js
// registers it before youtube-content.js on https://www.youtube.com/* while
// YouTube mining is on. A site's reader keeps the subtitle timelines the page
// script (netflix-page.js, on either site) posts, pins the cue of a hovered
// subtitle line, records that line for Anki from what the viewer heard
// (netflix-audio.js) or while the page plays or replays it, and pauses the
// video while a subtitle line or Hachidori's popup is hovered.
(function () {
  "use strict";

  // content.js announces its popup on `window`; nested popups open inside it.
  const POPUP_SHOWN_EVENT = "hachidori-popup-shown";
  const POPUP_HIDDEN_EVENT = "hachidori-popup-hidden";
  const WATCH_PATH = /^\/watch\/(\d+)/u;
  // The page gives up on a replay after its two bounded seeks (10 s each) and
  // REPLAY_SLACK_MS in netflix-page.js; the reader waits a little longer for
  // that answer.
  const REPLAY_SLACK_MS = 35_000;
  // How long the line audio has to deliver what was played until now.
  const DRAIN_MS = 500;
  const SHOW_TEXT = 4;
  // A track's BCP 47 language as a page names it (`ja`, `zh-Hans`).
  const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z\d]{1,8})*$/u;

  // What a video site's reader needs to know of its page: the events its page
  // script talks on, its video IDs, subtitle formats and statuses, where its
  // video and subtitles are, its recorder page and the worker requests that
  // record a line (docs/architecture.md, Netflix mining). youtube-content.js
  // describes YouTube the same way.
  const NETFLIX = Object.freeze({
    name: "Netflix",
    // The mining request's field.
    field: "netflix",
    pageEvent: "hachidori-netflix-page",
    commandEvent: "hachidori-netflix-command",
    movieId: /^\d+$/u,
    statuses: new Set(["image", "none", "failed"]),
    formats: new Set(["webvtt", "ttml"]),
    // Netflix reaches /watch/<id> by navigating inside one document.
    watched: location => WATCH_PATH.exec(location.pathname)?.[1] ?? null,
    // The title and episode the player shows, for a note's miscInfo.
    title: '[data-uia="video-title"], .video-title',
    video: document => document.querySelector(".watch-video video") ?? document.querySelector("video"),
    // The subtitle layer, and a subtitle box in it.
    subtitle: ".player-timedtext",
    line: ".player-timedtext-text-container",
    recorderPage: "netflix-recorder.html",
    requests: { start: "hd_netflix_capture_start", finish: "hd_netflix_capture_finish",
      cancel: "hd_netflix_capture_cancel", lineAudio: "hd_netflix_line_audio" },
    // The viewer can drag the subtitles, and every lookup on the watch page is
    // of the player's text, so any lookup pauses the video.
    drag: true,
    pauseOnLookup: true,
    // A picture of the line, its screenshot or its GIF, is of the video alone:
    // what Netflix draws over the video is hidden while it is taken, and it is
    // cropped to the picture. These are Netflix's own class names for its
    // subtitles, controls, skip and next-episode buttons and paused-title
    // overlay; Netflix may change them.
    overVideo: [".player-timedtext", ".watch-video--bottom-controls-container", ".watch-video--back-container",
      ".watch-video--flag-container", ".watch-video--skip-content", ".SeamlessControls--container",
      ".evidence-overlay"].join(", "),
    cropToVideo: true,
  });

  function createVideoSite(window, site, subtitles = window.HDNetflixSubtitles, lineAudioApi = window.HDNetflixAudio) {
    const { document, location } = window;
    // movieId → { tracks: Map(trackId → { id, closedCaptions, cues, language }), status, chosen }
    const movies = new Map();
    // Movies this page has moved away from: their late posts are not wanted.
    const retired = new Set();
    const resent = new Set();
    const replays = new Map();
    let watched = null;
    // The video the page says its player plays, for a site whose address does
    // not say (YouTube, whose miniplayer plays on other pages).
    let reported = null;
    let videoInfo = "";
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
    // Set once the line audio keeps a line as exact zeros: the video's sound
    // does not reach Web Audio, as on Netflix in Edge on Windows, where tab
    // capture still records it. The page's lines are recorded with tab capture
    // from then on.
    let copySilent = false;
    const range = document.createRange();
    let dragStyle = null;
    let subtitleOffset = { x: 0, y: 0 };
    let subtitleDrag = null;
    let subtitleClick = false;
    // What the site draws over its video, hidden while pictures of it are taken.
    let overVideoStyle = null;
    let overVideoHidden = 0;
    // The reading language whose subtitle tracks the page posts (docs/languages.md 8.5).
    let subtitleLanguage = "ja";

    const command = message => {
      document.dispatchEvent(new window.CustomEvent(site.commandEvent, { detail: JSON.stringify(message) }));
    };
    const watchedMovie = () => (site.reportsVideo ? reported : site.watched(location));
    // The movie whose sound plays now: none while an ad plays (YouTube).
    const playingMovie = () => (site.adShowing?.(document) === true ? null : watchedMovie());

    // A new /watch/<id>, or on YouTube another video, drops the previous
    // movie's timeline and any resume this reader still owed it.
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
      if (!movies.has(movieId)) {
        // YouTube's page posts the caption files of every player on it, its
        // previews' too: as the page does, the reader keeps the watched
        // video's timeline and the latest other one.
        if (site.reportsVideo) for (const id of movies.keys()) if (id !== watched) movies.delete(id);
        movies.set(movieId, { tracks: new Map(), status: null, chosen: null });
      }
      return movies.get(movieId);
    }

    // Why a replay failed, as a reason the note can name: the player is
    // missing, a reason the site's page gives (YouTube: an ad is playing), or
    // the replay did not finish.
    const replayFailure = error => (error === "player" || site.replayErrors?.has(error) ? error : "replay");

    function settleReplay(message) {
      const pending = typeof message.id === "string" ? replays.get(message.id) : undefined;
      if (pending === undefined) return;
      replays.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.ok === true && Array.isArray(message.anchors)) {
        pending.resolve(message.anchors.filter(pair => Array.isArray(pair) && pair.length === 2
          && pair.every(Number.isFinite)));
      } else {
        pending.reject(Object.assign(new Error(`${site.name}'s player could not replay the line (${message.error}).`),
          { code: replayFailure(message.error) }));
      }
      // The page restores the viewer's state as it answers; its seek back
      // reports itself afterwards. Playing on seeks nowhere.
      restoring = !pending.playOn;
    }

    function reportVideo(message) {
      reported = typeof message.movieId === "string" && site.movieId.test(message.movieId) ? message.movieId : null;
      videoInfo = reported === null ? "" : [message.title, message.author]
        .filter(value => typeof value === "string" && value.trim()).map(value => value.trim()).join(" - ");
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
      // A page that says which video its player plays (YouTube).
      if (site.reportsVideo && message.kind === "video") {
        reportVideo(message);
      }
      sync();
      if (message.kind === "replay") {
        settleReplay(message);
        return;
      }
      if (typeof message.movieId !== "string" || !site.movieId.test(message.movieId) || retired.has(message.movieId)) return;
      if (message.kind === "status" && site.statuses.has(message.subtitles)) {
        movie(message.movieId).status ??= message.subtitles;
        return;
      }
      if (message.kind !== "subtitle" || typeof message.trackId !== "string" || message.trackId === ""
          || typeof message.closedCaptions !== "boolean" || !site.formats.has(message.format)
          || typeof message.text !== "string") return;
      let cues;
      try {
        cues = subtitles.parseSubtitles(message.format, message.text, { DOMParser: window.DOMParser });
      } catch {
        movie(message.movieId).status ??= "failed";
        return;
      }
      movie(message.movieId).tracks.set(message.trackId, { id: message.trackId, closedCaptions: message.closedCaptions,
        cues: cues.map(cue => ({ ...cue, key: subtitles.normaliseCueText(cue.text) })),
        // The track's language, where the page names it (YouTube).
        ...(site.trackLanguage && typeof message.language === "string" && LANGUAGE_TAG.test(message.language)
          ? { language: message.language } : {}) });
    }

    function visibleText(element) {
      const walker = document.createTreeWalker(element, SHOW_TEXT);
      let text = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest("rt, rp")) text += node.nodeValue;
      }
      return text;
    }

    const mainVideo = () => site.video(document);
    // The line audio keeps the player's sound only, not a preview's on another page.
    const watchVideo = () => (watchedMovie() === null ? null : mainVideo());

    function mediaTimeMs() {
      const video = mainVideo();
      return video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : null;
    }

    // What the reader saw when the popup opened: the subtitle line under the
    // pointer and the video's time. Null for anything but the site's
    // subtitles, and for an ad's own captions (YouTube). Where only a lookup of
    // a subtitle pauses the video (YouTube), this is that lookup: content.js
    // observes the root lookup as it shows its popup.
    function observe(element) {
      const subtitle = element?.closest?.(site.subtitle);
      if (!subtitle || site.adShowing?.(document) === true) return null;
      if (!site.pauseOnLookup && !hovering) pauseIfPlaying();
      const container = element.closest(site.line) ?? subtitle;
      let miscInfo = videoInfo;
      if (site.title) {
        const title = document.querySelector(site.title);
        const parts = [];
        if (title) {
          const walker = document.createTreeWalker(title, SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const part = node.textContent.trim();
            if (part) parts.push(part);
          }
        }
        miscInfo = parts.join(" - ");
      }
      return { movieId: sync(), mediaTimeMs: mediaTimeMs(), lineText: visibleText(container),
        hoveredText: visibleText(element), ...(miscInfo ? { miscInfo } : {}) };
    }

    // The language of the track whose line `element` is, where the page names
    // it (YouTube): the reader keeps one track per video, the one on screen.
    function captionLanguage(element) {
      if (!site.trackLanguage || !element?.closest?.(site.subtitle)) return null;
      const tracks = [...(movies.get(sync())?.tracks.values() ?? [])];
      return tracks.at(-1)?.language ?? null;
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

    // The mining request's fields for the site (`netflix`, `youtube`).
    // `sentence` is the root lookup's candidate, whose sentence becomes the
    // whole cue; nested lookups keep their own sentence and inherit only the cue.
    function miningFields(observation, sentence = null) {
      if (!observation) return {};
      const metadata = observation.miscInfo ? { miscInfo: observation.miscInfo } : {};
      const resolved = resolve(observation);
      if (!resolved.cue) return { [site.field]: { unavailable: resolved.reason }, ...metadata };
      const { movieId, startMs, endMs, text } = resolved.cue;
      // A candidate of a language pack joins the cue's lines with its joiner.
      const whole = sentence ? subtitles.cueSentence(text, sentence.sentence, sentence.matchOffset, sentence.lineJoiner) : null;
      return { [site.field]: { cue: { movieId, startMs, endMs } }, ...whole, ...metadata };
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
          rejectReplay(Object.assign(new Error(`${site.name}'s player did not finish replaying the line.`), { code: "replay" }));
        }, cue.endMs - cue.startMs + 2 * padMs + REPLAY_SLACK_MS);
        replays.set(id, { resolve: resolveReplay, reject: rejectReplay, timer, playOn });
        command({ type: "replay", id, startMs: cue.startMs, endMs: cue.endMs, padMs, keepPaused: hoverPause,
          ...(playOn ? { playOn: true } : {}) });
      });
    }

    // The hidden extension frame that records the tab (netflix-capture.js).
    function recorderFrame() {
      const frame = document.createElement("iframe");
      frame.src = window.chrome.runtime.getURL(site.recorderPage);
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.setProperty("display", "none", "important");
      // Outside the site's own app root, so its rendering cannot remove it.
      document.documentElement.append(frame);
      return frame;
    }

    // Where the video's picture is in the viewport, as fractions of it, with
    // the viewport's aspect ratio, so a picture of a page with more than its
    // player keeps only the video (YouTube), and one of a player whose shape
    // is not the video's loses the bars beside it (Netflix). A video shows its
    // picture whole and centred in its box unless the page has it fill or
    // cover the box, and one with no picture yet has only its box.
    function videoCrop() {
      const video = mainVideo();
      const box = video?.getBoundingClientRect();
      const { innerWidth: width, innerHeight: height } = window;
      if (!box || width <= 0 || height <= 0) return null;
      let picture = box;
      if (video.videoWidth > 0 && video.videoHeight > 0 && window.getComputedStyle(video).objectFit === "contain") {
        const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
        const shownWidth = video.videoWidth * scale;
        const shownHeight = video.videoHeight * scale;
        const pictureLeft = box.left + (box.width - shownWidth) / 2;
        const pictureTop = box.top + (box.height - shownHeight) / 2;
        picture = { left: pictureLeft, top: pictureTop, right: pictureLeft + shownWidth, bottom: pictureTop + shownHeight };
      }
      const left = Math.max(0, picture.left / width);
      const top = Math.max(0, picture.top / height);
      const right = Math.min(1, picture.right / width);
      const bottom = Math.min(1, picture.bottom / height);
      return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top, aspect: width / height } : null;
    }

    // While a picture of the video is taken, a screenshot or a GIF's replay,
    // what the site draws over the video (`overVideo`) is hidden, at once
    // rather than by its own fade, so it has gone before the capture. Counted
    // like the reader's own concealment, so one picture cannot show it again
    // while another is being taken.
    async function hideOverVideo(during) {
      if (!site.overVideo) return during();
      if (overVideoHidden === 0) {
        overVideoStyle = document.createElement("style");
        overVideoStyle.textContent = `${site.overVideo} { opacity: 0 !important; transition: none !important; }`;
        document.documentElement.append(overVideoStyle);
      }
      overVideoHidden += 1;
      try {
        return await during();
      } finally {
        overVideoHidden -= 1;
        if (overVideoHidden === 0) {
          overVideoStyle.remove();
          overVideoStyle = null;
        }
      }
    }

    // A screenshot for a note from the site's subtitles: `capture` asks the
    // worker for it, cropped to where the video's picture is, while what the
    // site draws over the video is hidden.
    function screenshot(capture) {
      return hideOverVideo(() => capture(videoCrop()));
    }

    // Records the cue's line with tab capture: a recorder frame opens the tab's
    // stream, the page replays the line, then the frame cuts the clip (with
    // audio unset, no sentence audio; with gif set, a looping GIF of the line)
    // and the worker holds its files for the note. Resolves with { audio, gif }
    // for the fields, or with why there is none.
    async function recordTab(cue, { send, templateId, audio, gif }) {
      const frame = recorderFrame();
      try {
        const crop = site.cropToVideo && gif ? videoCrop() : null;
        const started = await send(site.requests.start, { cue, audio, gif, ...(crop ? { crop } : {}) });
        if (typeof started.unavailable === "string") return { unavailable: started.unavailable };
        if (typeof started.sessionId !== "string" || !Number.isFinite(started.padMs)) {
          throw new TypeError("the recording did not start.");
        }
        let anchors;
        try {
          anchors = await replay(cue, started.padMs);
        } catch (error) {
          await send(site.requests.cancel, { sessionId: started.sessionId }).catch(() => {});
          return { unavailable: replayFailure(error.code) };
        }
        return await send(site.requests.finish, { sessionId: started.sessionId, anchors, templateId });
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
    // or why there is none. Its MP3 encoder (sentence-audio.js) loads with the
    // first line the page adds.
    async function holdLine(clip, { send, templateId, encoding }) {
      if (clip === null) return { unavailable: "unheard" };
      const { sentenceAudioBase64 } = await import(window.chrome.runtime.getURL("sentence-audio.js"));
      const data = await sentenceAudioBase64(clip.samples, clip.sampleRate, encoding);
      const held = await send(site.requests.lineAudio, { data, templateId });
      return typeof held.unavailable === "string" ? { unavailable: held.unavailable }
        : { token: held.token, filename: held.filename };
    }

    // A tab recording of the cue's line with Hachidori's overlays concealed;
    // a GIF's replay also hides what the site draws over its video.
    function captureTab(cue, { conceal, ...recording }) {
      const concealed = () => conceal(() => recordTab(cue, recording));
      return recording.gif ? hideOverVideo(concealed) : concealed();
    }

    // Records the cue's line for the fields that map it: `audio` for
    // {sentence-audio}, `gif` for {gif}. Sentence audio comes from what the
    // viewer heard, played on or replayed if need be, while the line audio
    // keeps the video's sound; tab capture records a GIF, and the audio too
    // otherwise or once the line audio has kept a line as exact zeros.
    // `conceal` hides Hachidori's overlays around tab capture only.
    // Resolves with { audio, gif } for the fields, or with why there is none.
    async function record(cue, { send, templateId, audio = true, gif = false, encoding, conceal = during => during() }) {
      recordings += 1;
      try {
        if (!audio || copySilent || lineAudio?.ready() !== true) {
          return await captureTab(cue, { send, templateId, audio, gif, conceal });
        }
        let clip = await heardLine(cue);
        const result = {};
        if (gif) {
          try {
            const recorded = await captureTab(cue, { send, templateId, audio: false, gif, conceal });
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
          if (clip !== null && lineAudioApi.isSilent(clip.samples)) {
            copySilent = true;
            const recorded = await captureTab(cue, { send, templateId, audio: true, gif: false, conceal });
            result.audio = typeof recorded.unavailable === "string" ? { unavailable: recorded.unavailable } : recorded.audio;
          } else {
            result.audio = await holdLine(clip, { send, templateId, encoding });
          }
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
    function subtitleAt(x, y) {
      for (const box of document.querySelectorAll(`${site.subtitle} ${site.line}`)) {
        let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
        const walker = document.createTreeWalker(box, SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            left = Math.min(left, rect.left);
            right = Math.max(right, rect.right);
            top = Math.min(top, rect.top);
            bottom = Math.max(bottom, rect.bottom);
          }
        }
        if (x >= left && x <= right && y >= top && y <= bottom) return { left, right, top, bottom };
      }
      return null;
    }

    // A stylesheet moves the native layer, including new lines/layers Netflix
    // creates, without overwriting its own inline positioning or transforms.
    // Offsets belong to this page session; switching the feature off restores
    // Netflix's layout and switching it back on keeps the chosen position.
    // YouTube drags its own captions, so only a site with `drag` gets this.
    function setSubtitleDragging(enabled) {
      if (enabled === true) {
        if (dragStyle || !site.drag) return;
        dragStyle = document.createElement("style");
        dragStyle.textContent = `${site.subtitle} { translate: ${subtitleOffset.x}px ${subtitleOffset.y}px !important; }
          ${site.subtitle} ${site.line} { cursor: grab !important; user-select: none !important; pointer-events: auto !important; }`;
        document.documentElement.append(dragStyle);
      } else {
        dragStyle?.remove();
        dragStyle = null;
        subtitleDrag = null;
        subtitleClick = false;
      }
    }

    function startSubtitleDrag(event) {
      if (event.button === 0) subtitleClick = false;
      if (!dragStyle || event.button !== 0 || sync() === null
          || !event.target.closest?.(site.subtitle)) return;
      const rect = subtitleAt(event.clientX, event.clientY);
      if (!rect) return;
      subtitleDrag = { ...rect, ...subtitleOffset, clientX: event.clientX, clientY: event.clientY };
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function moveSubtitleDrag(event) {
      if ((event.buttons & 1) === 0) { subtitleDrag = null; return false; }
      const drag = subtitleDrag;
      const dx = Math.max(-drag.left, Math.min(event.clientX - drag.clientX, window.innerWidth - drag.right));
      const dy = Math.max(-drag.top, Math.min(event.clientY - drag.clientY, window.innerHeight - drag.bottom));
      subtitleOffset = { x: drag.x + dx, y: drag.y + dy };
      dragStyle.sheet.cssRules[0].style.setProperty("translate", `${subtitleOffset.x}px ${subtitleOffset.y}px`, "important");
      subtitleClick = true;
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }

    function endSubtitleDrag(event) {
      if (!subtitleDrag || event.button !== 0) return;
      subtitleDrag = null;
      pointerMoved(event);
      event.preventDefault();
      event.stopImmediatePropagation();
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
      if (subtitleDrag && moveSubtitleDrag(event)) return;
      if (!hoverPause || sync() === null) return;
      const over = subtitleAt(event.clientX, event.clientY) !== null;
      if (over === hovering) return;
      hovering = over;
      if (!over) {
        release();
        return;
      }
      pauseIfPlaying();
    }

    // A keyboard/selection lookup can open without the pointer ever entering
    // the native subtitle bounds. It needs the same pause as a subtitle hover.
    // An ad's captions are not the video's (YouTube), so nothing pauses an ad.
    function pauseIfPlaying() {
      if (!hoverPause || sync() === null || held || recordings > 0 || site.adShowing?.(document) === true) return;
      const video = mainVideo();
      if (video === null || video.paused) return;
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

    // content.js turns hover pause on and off with the site's mining switch.
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
        lineAudio ??= lineAudioApi.createLineAudio(window, { video: watchVideo, movie: playingMovie });
        lineAudio.start();
      } else {
        lineAudio?.stop();
      }
    }

    document.addEventListener(site.pageEvent, event => {
      if (typeof event.detail === "string") accept(event.detail);
    });
    // Window capture runs before the reader's selection gestures and Netflix's
    // player controls. Only a press on the actual subtitle text starts a drag.
    if (site.drag) window.addEventListener("mousedown", startSubtitleDrag, true);
    window.addEventListener("mousemove", pointerMoved, true);
    if (site.drag) {
      window.addEventListener("mouseup", endSubtitleDrag, true);
      window.addEventListener("blur", () => { subtitleDrag = null; subtitleClick = false; });
      window.addEventListener("click", event => {
        if (!subtitleClick || event.button !== 0) return;
        subtitleClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }
    for (const type of ["play", "seeking", "seeked"]) document.addEventListener(type, videoChanged, true);
    window.addEventListener(POPUP_SHOWN_EVENT, () => {
      if (popupOpen) return;
      popupOpen = true;
      // If the viewer played on while still hovering, opening its popup does
      // not undo that choice. A lookup with no subtitle hover pauses afresh:
      // on Netflix any lookup, elsewhere one of a subtitle line (observe).
      if (!hovering && site.pauseOnLookup) pauseIfPlaying();
    });
    window.addEventListener(POPUP_HIDDEN_EVENT, () => {
      popupOpen = false;
      release();
    });

    // The reader reads another language: the tracks of this one are dropped and
    // the page posts that language's.
    function setSubtitleLanguage(code) {
      if (typeof code !== "string" || code === subtitleLanguage) return;
      subtitleLanguage = code;
      movies.clear();
      resent.clear();
      command({ type: "language", language: code });
    }

    // A page that says which video its player plays is asked once now, in
    // case it said so before this reader listened.
    if (site.reportsVideo) command({ type: "state" });

    return { observe, resolve, miningFields, record, screenshot, setHoverPause, setLineAudio, setSubtitleDragging,
      setSubtitleLanguage, captionLanguage };
  }

  const createNetflix = (window, subtitles, lineAudioApi) => createVideoSite(window, NETFLIX, subtitles, lineAudioApi);
  globalThis.HDVideoSite = { createVideoSite };
  // Netflix's reader, on Netflix: youtube.js loads this file for YouTube's,
  // which youtube-content.js creates.
  if (globalThis.location?.hostname === "www.netflix.com") globalThis.HDNetflix = { ...createNetflix(globalThis), createNetflix };
}());
