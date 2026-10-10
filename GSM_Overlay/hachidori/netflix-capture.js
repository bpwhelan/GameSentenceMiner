// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeBase64 } from "./base64.js";
import { GIF_MAX_FPS, GIF_MAX_WIDTH, encodeLoopingGif, selectGifFrames } from "./netflix-gif.js";
import "./netflix-audio.js";

// Experimental Netflix mining's recorder. netflix-recorder.html runs this in a
// hidden extension frame inside the Netflix tab while the page replays one
// subtitle line: it records the tab's audio from a chrome.tabCapture stream,
// then cuts the line out of it by the media times the page reported and
// encodes a mono WAV for Anki. When a field is mapped to {gif}, it also records
// the stream's video track and encodes a looping GIF of the line. Only the WAV
// and the GIF leave the frame. The page's own line audio (netflix-audio.js)
// records sentence audio without it where it can; this frame then records
// only the GIF.
//
// The frame, not the offscreen document, opens the stream: a tab stream ID is
// usable only in the process of the context that asked for it, and the
// offscreen document is cross-origin isolated for the threaded engine, so it
// runs in another process than the service worker. Chrome mutes a tab while it
// is captured, so the replay can be silent.
const { PAD_MS, clockDomain, encodeMonoWav, isSilent, monoSamples } = globalThis.HDNetflixAudio;

// The audio kept before and after the cue.
export const SENTENCE_PAD_MS = PAD_MS;
// How long the last captured audio has to arrive after the page's replay ends.
const DRAIN_TIMEOUT_MS = 500;
// The video track is sampled no faster than the GIF's own rate while recording.
const VIDEO_SAMPLE_SPACING_MS = 1000 / GIF_MAX_FPS;

// Wall-clock minus media time while the line played at 1×: the median of the
// page's (wall ms, media ms) pairs, so a stale pair from the seek cannot move it.
export function mediaClockOffset(anchors) {
  const offsets = (Array.isArray(anchors) ? anchors : [])
    .filter(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite))
    .map(([wall, media]) => wall - media)
    .sort((left, right) => left - right);
  if (offsets.length === 0) return null;
  const middle = Math.floor(offsets.length / 2);
  return offsets.length % 2 === 1 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
}

// Places captured AudioData blocks on the wall clock, as the removed media
// recorder's sample clock did. A block's timestamp is in the page's time
// (performance.timeOrigin) on current Chrome and in a raw monotonic clock on
// older builds; the first block decides which. Timestamps are rounded for
// privacy, so contiguous blocks are placed by counting samples, and only a
// real jump moves the count.
export function createAudioFrameClock({ timeOrigin, now }) {
  let originMs = null;
  let domainMs = null;
  let next = 0;
  return {
    get originMs() { return originMs; },
    get endFrame() { return next; },
    place({ timestampUs, frames, sampleRate }) {
      const rawMs = timestampUs / 1000;
      if (originMs === null) {
        domainMs = clockDomain(timeOrigin, rawMs, now(), frames * 1000 / sampleRate);
        originMs = domainMs + rawMs;
        next = frames;
        return 0;
      }
      const byTimestamp = Math.round((domainMs + rawMs - originMs) * sampleRate / 1000);
      const start = Math.abs(byTimestamp - next) > frames / 2 ? byTimestamp : next;
      next = start + frames;
      return start;
    },
  };
}

// The recorded samples between two wall-clock times. Chunks carry the frame
// of their first sample; frame 0 is at `originMs`. Missing frames stay
// silent, and the range is clamped to what was recorded.
export function clipSamples(chunks, { originMs, sampleRate, startMs, endMs }) {
  if (![originMs, sampleRate, startMs, endMs].every(Number.isFinite) || sampleRate <= 0 || endMs <= startMs
      || chunks.length === 0) return null;
  let recordedStart = Infinity;
  let recordedEnd = -Infinity;
  for (const chunk of chunks) {
    recordedStart = Math.min(recordedStart, chunk.startFrame);
    recordedEnd = Math.max(recordedEnd, chunk.startFrame + chunk.samples.length);
  }
  const from = Math.max(recordedStart, Math.round((startMs - originMs) * sampleRate / 1000));
  const to = Math.min(recordedEnd, Math.round((endMs - originMs) * sampleRate / 1000));
  if (to <= from) return null;
  const output = new Float32Array(to - from);
  for (const chunk of chunks) {
    const begin = Math.max(from, chunk.startFrame);
    const end = Math.min(to, chunk.startFrame + chunk.samples.length);
    if (end > begin) output.set(chunk.samples.subarray(begin - chunk.startFrame, end - chunk.startFrame), begin - from);
  }
  return output;
}

// The wall-clock time just after the last sample recorded so far, or null.
function recordedUntil(current) {
  if (current.clock.originMs === null || current.sampleRate === null) return null;
  return current.clock.originMs + current.clock.endFrame * 1000 / current.sampleRate;
}

// Places every block the stream delivers until it ends, and tells a waiting
// finish when the recording has reached the time it waits for.
function readStream(current) {
  return current.reader.read().then(({ done, value }) => {
    if (done) return undefined;
    try {
      current.sampleRate ??= value.sampleRate;
      if (value.sampleRate === current.sampleRate) {
        const startFrame = current.clock.place({ timestampUs: value.timestamp, frames: value.numberOfFrames,
          sampleRate: value.sampleRate });
        current.chunks.push({ startFrame, samples: monoSamples(value) });
        if (current.waiter !== null && recordedUntil(current) >= current.waiter.untilMs) current.waiter.resolve();
      }
    } finally {
      value.close();
    }
    return readStream(current);
  });
}

// Places a VideoFrame's timestamp on the same wall clock the audio uses: a
// timestamp is in the page's time (performance.timeOrigin) on current Chrome
// and in a raw monotonic clock on older builds; the first frame decides which,
// as the audio clock does.
function createVideoFrameClock({ timeOrigin, now }) {
  let domainMs = null;
  return {
    wallMs(timestampUs) {
      const rawMs = timestampUs / 1000;
      domainMs ??= clockDomain(timeOrigin, rawMs, now());
      return domainMs + rawMs;
    },
  };
}

// Draws a VideoFrame into a reusable canvas at most GIF_MAX_WIDTH wide and reads
// its RGBA back, so the VideoFrame can be closed at once rather than kept in
// memory. Returns null before the frame's size is known.
function rasterise(current, frame, window) {
  const width = frame.displayWidth || frame.codedWidth;
  const height = frame.displayHeight || frame.codedHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, GIF_MAX_WIDTH / width);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  if (current.canvas === null || current.gifWidth !== outWidth || current.gifHeight !== outHeight) {
    current.canvas = new window.OffscreenCanvas(outWidth, outHeight);
    current.context = current.canvas.getContext("2d", { willReadFrequently: true });
    current.gifWidth = outWidth;
    current.gifHeight = outHeight;
  }
  current.context.drawImage(frame, 0, 0, outWidth, outHeight);
  return current.context.getImageData(0, 0, outWidth, outHeight).data;
}

// Keeps the video track's frames while the line plays, thinned at capture time
// to VIDEO_SAMPLE_SPACING_MS by their own timestamps (the replay runs at 1×, so
// timestamp spacing is media-time spacing). Each kept frame is rasterised to
// RGBA at once, its VideoFrame closed, and placed on the wall clock as it arrives.
function readVideo(current, window) {
  return current.videoReader.read().then(({ done, value }) => {
    if (done) return undefined;
    try {
      const timestampMs = value.timestamp / 1000;
      if (current.lastVideoMs === null || timestampMs - current.lastVideoMs >= VIDEO_SAMPLE_SPACING_MS - 1) {
        const data = rasterise(current, value, window);
        if (data !== null) {
          current.lastVideoMs = timestampMs;
          // Place the frame on the wall clock as it arrives, so the clock's
          // page/raw-domain decision uses the arrival time, as audio's does.
          current.frames.push({ wallMs: current.videoClock.wallMs(value.timestamp), data });
        }
      }
    } finally {
      value.close();
    }
    return readVideo(current, window);
  });
}

// The looping GIF of the line, from the frames kept while it played, in the
// cue's own window. A GIF the encoder cannot make is simply absent: the note
// falls back to the screenshot, like any other capture failure.
function encodeGif(current, { startMs, endMs, offset }) {
  if (!current.gif || current.frames.length === 0 || current.gifWidth === 0) return undefined;
  const placed = current.frames.map(frame => ({ data: frame.data, mediaMs: frame.wallMs - offset }));
  const entries = selectGifFrames(placed, { startMs, endMs });
  if (entries.length === 0) return undefined;
  try {
    return encodeBase64(encodeLoopingGif(entries.map(entry => ({ data: entry.frame.data, delayMs: entry.delayMs })),
      current.gifWidth, current.gifHeight));
  } catch {
    return undefined;
  }
}

export function createNetflixRecorder(window, {
  now = () => window.performance.timeOrigin + window.performance.now(),
} = {}) {
  let session = null;

  function stop(current) {
    window.clearTimeout(current.timer);
    current.reader?.cancel().catch(() => {});
    current.videoReader?.cancel().catch(() => {});
    for (const track of current.stream?.getTracks() ?? []) track.stop();
    current.waiter?.resolve();
    if (session === current) session = null;
  }

  // Opens this tab's stream and starts placing its samples. Chrome hands a
  // stream ID only to an extension the user invoked on the tab, and the ID is
  // used here, in the context that asked for it.
  async function start({ targetTabId, limitMs, audio = true, gif = false }) {
    if (!Number.isSafeInteger(targetTabId) || !Number.isFinite(limitMs) || limitMs <= 0) {
      throw new Error("The Netflix recording request is invalid.");
    }
    if (session !== null) stop(session);
    // The audio track is opened either way: it mutes the tab for the replay
    // and tells finish when the capture has caught up. Only a {sentence-audio}
    // field needs its WAV, and video is captured only for a {gif} field.
    const current = { stream: null, reader: null, chunks: [], sampleRate: null, timer: null, waiter: null,
      clock: createAudioFrameClock({ timeOrigin: window.performance.timeOrigin, now }), audio,
      gif, videoReader: null, frames: [], lastVideoMs: null, canvas: null, context: null, gifWidth: 0, gifHeight: 0,
      videoClock: createVideoFrameClock({ timeOrigin: window.performance.timeOrigin, now }) };
    session = current;
    try {
      let streamId;
      try {
        streamId = await window.chrome.tabCapture.getMediaStreamId({ targetTabId });
      } catch (error) {
        if (/not been invoked|activeTab/iu.test(error?.message ?? "")) {
          stop(current);
          return { unavailable: "grant" };
        }
        throw error;
      }
      current.stream = await window.navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
        video: gif ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } : false,
      });
      const [track] = current.stream.getAudioTracks();
      current.reader = new window.MediaStreamTrackProcessor({ track }).readable.getReader();
      readStream(current).catch(() => {});
      const [videoTrack] = gif ? current.stream.getVideoTracks() : [];
      if (videoTrack) {
        current.videoReader = new window.MediaStreamTrackProcessor({ track: videoTrack }).readable.getReader();
        readVideo(current, window).catch(() => {});
      }
      // A recording nobody finishes still ends, which gives the tab its sound back.
      current.timer = window.setTimeout(() => stop(current), limitMs);
    } catch (error) {
      stop(current);
      throw error;
    }
    return { padMs: SENTENCE_PAD_MS };
  }

  // Audio reaches the frame a little after the page plays it: wait until the
  // recording covers `untilMs`, for at most DRAIN_TIMEOUT_MS.
  function drain(current, untilMs) {
    if ((recordedUntil(current) ?? -Infinity) >= untilMs) return Promise.resolve();
    return new Promise(resolve => {
      const timer = window.setTimeout(() => current.waiter?.resolve(), DRAIN_TIMEOUT_MS);
      current.waiter = { untilMs, resolve: () => {
        window.clearTimeout(timer);
        current.waiter = null;
        resolve();
      } };
    });
  }

  async function finish({ startMs, endMs, anchors }) {
    const current = session;
    if (current?.reader == null) throw new Error("The recording of this line was replaced or stopped.");
    const offset = mediaClockOffset(anchors);
    try {
      if (offset !== null) await drain(current, endMs + SENTENCE_PAD_MS + offset);
    } finally {
      stop(current);
    }
    if (offset === null) throw new Error("Netflix did not play the line, so nothing was recorded.");
    const gif = encodeGif(current, { startMs, endMs, offset });
    if (!current.audio) return gif ? { gif } : {};
    const samples = clipSamples(current.chunks, { originMs: current.clock.originMs, sampleRate: current.sampleRate,
      startMs: startMs - SENTENCE_PAD_MS + offset, endMs: endMs + SENTENCE_PAD_MS + offset });
    if (samples === null) throw new Error("No audio was recorded while the line played.");
    if (isSilent(samples)) return { silent: true, ...(gif ? { gif } : {}) };
    return { silent: false, data: encodeBase64(encodeMonoWav(samples, current.sampleRate)), ...(gif ? { gif } : {}) };
  }

  return { start, finish, stop: () => { if (session !== null) stop(session); } };
}

// netflix-recorder.html's side of its port to the service worker: one
// recording per frame, answered message by message.
export function connectNetflixRecorder(window) {
  const recorder = createNetflixRecorder(window);
  const port = window.chrome.runtime.connect({ name: "hachidori-netflix-recorder" });
  const answer = (task, reply) => task.then(
    result => port.postMessage({ type: reply, ...result }),
    error => port.postMessage({ type: "error", error: error?.message || String(error) }),
  );
  port.onMessage.addListener(message => {
    if (message?.type === "record") answer(recorder.start(message), "started");
    else if (message?.type === "finish") answer(recorder.finish(message), "clip");
  });
  port.onDisconnect.addListener(() => recorder.stop());
  return port;
}
