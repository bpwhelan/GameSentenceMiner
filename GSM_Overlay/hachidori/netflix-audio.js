// SPDX-License-Identifier: GPL-3.0-or-later

// Experimental Netflix mining's line audio. netflix.js registers this classic
// script before netflix-content.js on https://www.netflix.com/* (top frame,
// document_start) while Settings → Advanced → Experimental features → Netflix
// mining is on. The recorder frame's netflix-capture.js imports it for the WAV
// encoder, the silence test and the capture clock.
//
// createLineAudio keeps the last 30 seconds of the watch page's <video> sound,
// as played at 1×, so that a line the viewer has just heard can be cut out by
// its cue's media time without replaying it or capturing the tab. The video's
// sound goes through a Web Audio graph in the page: on to the speakers as
// before, and as a mono copy to a MediaStreamTrackProcessor. Chrome gives Web
// Audio the element's decoded sound, protected (EME) playback included, where
// captureStream() refuses it. An element cannot leave the graph it has joined,
// so once routed the video plays through this one until the page reloads. The
// audio stays in one Float32Array in the page's memory and nowhere else.
(function () {
  "use strict";

  // The audio kept before and after a cue.
  const PAD_MS = 250;
  // How much 1× playback is kept.
  const WINDOW_MS = 30_000;
  // A played stretch's media clock is the median of its first blocks' estimates.
  const CLOCK_BLOCKS = 64;
  // Missing stretches this short still count as heard: the clock fit and the
  // edges of a played stretch are about this precise.
  const GAP_MS = 60;
  // The processor's queue in 10 ms blocks, so that a busy page drops nothing
  // (in Chrome 152 a queue of 10 lost 502 ms of a 600 ms stall; 100 lost none).
  const QUEUE_BLOCKS = 100;
  const HAVE_FUTURE_DATA = 3;
  const MEDIA_EVENTS = ["loadedmetadata", "canplay", "play", "playing", "pause", "waiting", "seeking", "seeked",
    "ratechange", "ended"];
  const GESTURES = ["pointerdown", "keydown"];

  // AudioData and VideoFrame timestamps are on the page's clock
  // (performance.timeOrigin) on current Chrome and on a raw monotonic clock on
  // older builds. The first one, against when it arrived, decides which: this
  // is what to add to a raw timestamp to get wall-clock milliseconds.
  function clockDomain(timeOrigin, rawMs, arrivalMs, durationMs = 0) {
    return Math.abs(timeOrigin + rawMs - arrivalMs) < 1000 ? timeOrigin : arrivalMs - rawMs - durationMs;
  }

  // One AudioData block as mono samples, revived from the removed recorder's mixer.
  function monoSamples(value) {
    const mono = new Float32Array(value.numberOfFrames);
    const plane = new Float32Array(value.numberOfFrames);
    for (let channel = 0; channel < value.numberOfChannels; channel += 1) {
      value.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      for (let frame = 0; frame < mono.length; frame += 1) mono[frame] += plane[frame];
    }
    if (value.numberOfChannels > 1) for (let frame = 0; frame < mono.length; frame += 1) mono[frame] /= value.numberOfChannels;
    return mono;
  }

  // Protected playback can deliver a stream of exact zeros. Quiet audio is not silence.
  const isSilent = samples => samples.every(sample => sample === 0);

  function setAscii(view, offset, value) {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.codePointAt(index));
  }

  // 16-bit mono PCM WAV, revived from the removed media recorder's capture-buffer.js.
  function encodeMonoWav(samples, sampleRate) {
    if (!(samples instanceof Float32Array)) throw new Error("WAV input must be mono Float32 samples.");
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("The WAV sample rate is invalid.");
    const byteLength = 44 + samples.length * 2;
    const output = new ArrayBuffer(byteLength);
    const view = new DataView(output);
    setAscii(view, 0, "RIFF");
    view.setUint32(4, byteLength - 8, true);
    setAscii(view, 8, "WAVE");
    setAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    setAscii(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Uint8Array(output);
  }

  // A clip as a base64 WAV: extension messages are JSON, so that is how a line
  // reaches the worker, from the page as from the recorder frame.
  function wavBase64({ samples, sampleRate }) {
    const bytes = encodeMonoWav(samples, sampleRate);
    if (typeof bytes.toBase64 === "function") return bytes.toBase64();
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x2000) {
      binary += String.fromCodePoint(...bytes.subarray(index, index + 0x2000));
    }
    return globalThis.btoa(binary);
  }

  function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // `video()` is the watch page's <video> and `movie()` its movie ID, or null
  // off a watch page.
  function createLineAudio(window, {
    video: currentVideo,
    movie: currentMovie,
    now = () => window.performance.timeOrigin + window.performance.now(),
  }) {
    let wanted = false;
    let context = null;
    // The elements this graph plays, and those another graph already had.
    const sources = new WeakMap();
    const refused = new WeakSet();
    let joined = false;
    // The element being kept, and its copy: { source, sink, track, reader }.
    let routed = null;
    let branch = null;
    let ring = null;
    let capacity = 0;
    let sampleRate = 0;
    // Frames written since the ring was made; frame f is at ring[f % capacity].
    let written = 0;
    let domainMs = null;
    // The wall-clock time the copy has delivered up to, kept or not.
    let deliveredWall = -Infinity;
    // Played stretches, oldest first: { movieId, openWall, closeWall, start,
    // frames, estimates, base, startMedia, endMedia }, where `base` is the
    // media time of frame `start` and the stretch was heard from `startMedia`
    // to `endMedia`.
    let segments = [];
    const waiters = new Set();
    let listening = false;

    const playingAt1x = element => element !== null && !element.paused && !element.seeking && !element.ended
      && element.playbackRate === 1 && element.readyState >= HAVE_FUTURE_DATA;

    // Chrome lets a page start audio after a click or key press there, or once
    // the viewer often plays media with sound on the site. A graph that is not
    // running would silence the video it plays, so nothing joins it until it
    // runs, and one that stops is started again, with the switch off too.
    function gesture() {
      context?.resume().catch(() => {});
    }
    function listenForGestures(on) {
      if (on === listening) return;
      listening = on;
      for (const type of GESTURES) {
        if (on) window.addEventListener(type, gesture, { capture: true, passive: true });
        else window.removeEventListener(type, gesture, { capture: true });
      }
    }
    function keepRunning() {
      const running = context === null || context.state === "running" || context.state === "closed";
      listenForGestures(!running);
      if (!running) gesture();
    }

    function settle(waiter) {
      window.clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve();
    }

    function closeOpen(type) {
      const last = segments.at(-1);
      if (last?.closeWall !== Infinity) return;
      if (last.start === null) {
        segments.pop();
        return;
      }
      last.closeWall = now();
      // A paused, stalled or ended video stands where its sound stopped. What
      // arrives after that until the event is handled is silence, and must not
      // count as heard. A seek reports its target, so it keeps the last time seen.
      if (["pause", "waiting", "ended"].includes(type) && routed !== null) {
        last.endMedia = Math.max(last.endMedia, routed.currentTime * 1000);
      }
    }

    function openSegment(wall, startMedia = -Infinity) {
      const segment = { movieId: currentMovie(), openWall: wall, closeWall: Infinity, start: null, frames: 0,
        estimates: [], base: null, startMedia, endMedia: -Infinity };
      segments.push(segment);
      return segment;
    }

    // Opens or closes the played stretch to match the video. A stretch that
    // opens as the video starts playing was heard from where it stood.
    function update(type = "") {
      if (branch !== null && routed === currentVideo() && playingAt1x(routed)) {
        if (segments.at(-1)?.closeWall !== Infinity) openSegment(now(), routed.currentTime * 1000);
      } else {
        closeOpen(type);
      }
    }

    function closeBranch() {
      if (branch === null) return;
      const { source, sink, track, reader } = branch;
      branch = null;
      closeOpen();
      reader.cancel().catch(() => {});
      track.stop();
      try {
        source.disconnect(sink);
      } catch {
        // Already disconnected.
      }
    }

    // Reads the copy until it is closed: a loop, not a promise chain, because
    // it runs for as long as the video does.
    async function pump(current) {
      for (;;) {
        let next;
        try {
          next = await current.reader.read();
        } catch {
          return;
        }
        if (next.done) return;
        try {
          if (branch === current) place(next.value);
        } finally {
          next.value.close();
        }
      }
    }

    function attach(type = "") {
      const element = currentVideo();
      if (!wanted || element === null || refused.has(element)) return;
      if (context === null) {
        try {
          context = new window.AudioContext();
        } catch {
          return;
        }
        context.addEventListener("statechange", () => {
          keepRunning();
          attach();
        });
      }
      if (context.state !== "running") {
        keepRunning();
        return;
      }
      let source = sources.get(element);
      if (source === undefined) {
        try {
          source = context.createMediaElementSource(element);
        } catch {
          // Another graph has the element: its lines are recorded with tab capture.
          refused.add(element);
          return;
        }
        source.connect(context.destination);
        sources.set(element, source);
        joined = true;
      }
      if (routed !== element || branch === null) {
        closeBranch();
        routed = element;
        const sink = new window.MediaStreamAudioDestinationNode(context, { channelCount: 1 });
        source.connect(sink);
        const [track] = sink.stream.getAudioTracks();
        const reader = new window.MediaStreamTrackProcessor({ track, maxBufferSize: QUEUE_BLOCKS }).readable.getReader();
        branch = { source, sink, track, reader };
        void pump(branch);
      }
      update(type);
    }

    function onMedia(event) {
      if (wanted && event.target === currentVideo()) attach(event.type);
    }
    for (const type of MEDIA_EVENTS) window.document.addEventListener(type, onMedia, true);

    // The stretch a block rendered from `wall` to `end` belongs to, if it can
    // still grow: the newest one open by the block's end, if the block began
    // before it closed. The block a stretch opens during holds its first sound.
    // Only the newest stretch holding audio can grow, so the ring stays in order.
    function segmentAt(wall, end) {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment.openWall < end) return wall < segment.closeWall ? segment : null;
        if (segment.start !== null) return null;
      }
      return null;
    }

    function write(value, frames) {
      const mixed = value.numberOfChannels === 1 ? null : monoSamples(value);
      let index = written % capacity;
      for (let offset = 0; offset < frames;) {
        const count = Math.min(frames - offset, capacity - index);
        const target = ring.subarray(index, index + count);
        if (mixed === null) value.copyTo(target, { planeIndex: 0, frameOffset: offset, frameCount: count, format: "f32-planar" });
        else target.set(mixed.subarray(offset, offset + count));
        offset += count;
        index = 0;
      }
      written += frames;
    }

    // The media time of a stretch's first frame, as this block says it: the
    // video's time now, less what has played since the block was rendered and
    // the frames before it. Only while it plays at 1× and the stretch is open.
    // The element's media clock follows the samples Web Audio takes from it, so
    // counting frames from there cannot drift. A new /watch/ address while it
    // plays (the next episode) starts a new stretch.
    function fitClock(segment, wall, arrival, rate) {
      if (segment.closeWall !== Infinity || !playingAt1x(routed)) return segment;
      const mediaNow = routed.currentTime * 1000;
      let current = segment;
      if (segment.start !== null && segment.movieId !== currentMovie()) {
        segment.closeWall = wall;
        current = openSegment(wall);
      }
      if (current.estimates.length < CLOCK_BLOCKS) {
        current.estimates.push(mediaNow - (arrival - wall) - current.frames * 1000 / rate);
        current.base = median(current.estimates);
      }
      // Nothing after the time the video has reached was heard yet.
      current.endMedia = Math.max(current.endMedia, mediaNow);
      return current;
    }

    function place(value) {
      const frames = value.numberOfFrames;
      const rate = value.sampleRate;
      const arrival = now();
      const rawMs = value.timestamp / 1000;
      domainMs ??= clockDomain(window.performance.timeOrigin, rawMs, arrival, frames * 1000 / rate);
      const wall = domainMs + rawMs;
      deliveredWall = Math.max(deliveredWall, wall + frames * 1000 / rate);
      try {
        keep(value, frames, rate, wall, arrival);
      } finally {
        // Deleting the entry being visited does not disturb a Set's iteration.
        for (const waiter of waiters) if (deliveredWall >= waiter.untilWall) settle(waiter);
      }
    }

    function keep(value, frames, rate, wall, arrival) {
      if (rate !== sampleRate) {
        // The first block, or another output device: a ring at this rate.
        segments = segments.filter(segment => segment.start === null);
        sampleRate = rate;
        capacity = Math.ceil(WINDOW_MS * rate / 1000);
        ring = new Float32Array(capacity);
        written = 0;
      }
      let segment = segmentAt(wall, wall + frames * 1000 / rate);
      if (segment === null) return;
      segment = fitClock(segment, wall, arrival, rate);
      segment.start ??= written;
      write(value, frames);
      segment.frames += frames;
      while (segments.length > 1 && segments[0].start + segments[0].frames <= written - capacity) segments.shift();
    }

    // Where each kept stretch of `movieId` lands in a clip of `length` frames
    // from media time `from`: ring frame `zero + i` is the clip's frame i, for
    // i from `first` to `last`. A stretch holds what was heard from the media
    // time the video stood at when it opened to the time it was seen to reach.
    function pieces(movieId, from, length) {
      const parts = [];
      for (const segment of segments) {
        if (segment.movieId !== movieId || segment.base === null || segment.frames === 0) continue;
        const frame = media => segment.start + Math.round((media - segment.base) * sampleRate / 1000);
        const heard = Math.min(segment.frames, Math.ceil((segment.endMedia - segment.base) * sampleRate / 1000));
        const zero = frame(from);
        const first = Math.max(0, Math.max(segment.start, written - capacity, frame(segment.startMedia)) - zero);
        const last = Math.min(length, segment.start + heard - zero);
        if (last > first) parts.push({ zero, first, last });
      }
      return parts;
    }

    // The pieces of media time `from`–`to`, if they leave no gap longer than GAP_MS.
    function span(movieId, from, to) {
      if (ring === null || typeof movieId !== "string" || to <= from) return null;
      const length = Math.round((to - from) * sampleRate / 1000);
      const parts = pieces(movieId, from, length);
      const gap = GAP_MS * sampleRate / 1000;
      let reached = 0;
      for (const { first, last } of [...parts].sort((left, right) => left.first - right.first)) {
        if (first - reached > gap) return null;
        reached = Math.max(reached, last);
      }
      return length - reached <= gap ? { length, parts } : null;
    }

    return {
      // The switch: keep the video's sound, or stop and free what was kept.
      // The video keeps playing through the graph once it has joined it.
      start() {
        wanted = true;
        attach();
      },
      stop() {
        wanted = false;
        closeBranch();
        segments = [];
        routed = null;
        ring = null;
        capacity = 0;
        sampleRate = 0;
        written = 0;
        for (const waiter of waiters) settle(waiter);
        if (!joined && context !== null) {
          const unused = context;
          context = null;
          listenForGestures(false);
          unused.close().catch(() => {});
        }
      },
      // Whether the watch page's video is being kept now.
      ready: () => wanted && branch !== null && routed === currentVideo() && context?.state === "running",
      // Whether `movieId`'s media time `from`–`to` was heard at 1× and is still
      // kept. A span no longer than a gap needs nothing.
      covers: (movieId, from, to) => to - from <= GAP_MS || span(movieId, from, to) !== null,
      // The samples of `movieId`'s media time `from`–`to`, a later hearing over
      // an earlier one, or null when they were not all heard.
      clip(movieId, from, to) {
        const found = span(movieId, from, to);
        if (found === null) return null;
        const samples = new Float32Array(found.length);
        for (const { zero, first, last } of found.parts) {
          let index = (zero + first) % capacity;
          for (let at = first; at < last;) {
            const count = Math.min(last - at, capacity - index);
            samples.set(ring.subarray(index, index + count), at);
            at += count;
            index = 0;
          }
        }
        return { samples, sampleRate };
      },
      // Resolves once the copy has delivered everything rendered until now
      // (it arrives a little later), or after `timeoutMs`.
      settled(timeoutMs) {
        const untilWall = now();
        if (!wanted || deliveredWall >= untilWall) return Promise.resolve();
        return new Promise(resolve => {
          const waiter = { untilWall, resolve, timer: null };
          waiter.timer = window.setTimeout(() => settle(waiter), timeoutMs);
          waiters.add(waiter);
        });
      },
    };
  }

  globalThis.HDNetflixAudio = { PAD_MS, clockDomain, createLineAudio, encodeMonoWav, isSilent, monoSamples, wavBase64 };
}());
