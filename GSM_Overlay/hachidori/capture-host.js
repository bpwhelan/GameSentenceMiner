// SPDX-License-Identifier: GPL-3.0-or-later
import { createCaptureSession } from "./capture-session.js";
import { createCaptureFrameEncoder } from "./capture-frame-client.js";
import { recordCapturedSpeech } from "./capture-speech.js";
import { resolveSpeech } from "./speech.js";
import {
  MAX_TEXTHOOKER_FRAME_LENGTH,
  MAX_TEXTHOOKER_TEXT_LENGTH,
  parseTexthookerMessage,
} from "./texthooker-protocol.js";

const CAPTURE_TARGET = "hachidori-capture";
const preview = document.createElement("video");
preview.muted = true;
preview.playsInline = true;
document.body.append(preview);
let pageStatus = "";
let pageVideos = [];
const session = createCaptureSession();
let config;
let starting = false;
let captureVersion = 0;
let captureDocumentId = "";
let stream = null;
let frameTimer = null;
let frameCallbackId = null;
let frameBusy = false;
let frameEncoder = null;
let frameClockReady = Promise.resolve(null);
let resolveFrameClock = null;
let mediaClockOriginMs = null;
let frameClockOriginMs = null;
let videoReader = null;
let processedVideoTrack = null;
let audioReader = null;
let audioTrack = null;
let audioContext = null;
let audioNode = null;
let texthooker = null;
let selectedTabId = null;
let linkedDocumentId = "";
let requestCounter = 0;

const timestamp = () => performance.timeOrigin + performance.now();
const describe = error => error instanceof Error ? error.message || String(error) : String(error);

async function send(type, fields = {}) {
  const reply = await chrome.runtime.sendMessage({
    target: CAPTURE_TARGET,
    type,
    requestId: `capture-${++requestCounter}`,
    ...fields,
  });
  if (!reply?.ok) throw new Error(reply?.error || "The capture service did not reply.");
  return reply;
}

async function register() {
  const reply = await send("hd_capture_register", { linkedPage: session.status().linkedPage });
  captureDocumentId = reply.documentId;
  configure(reply.mediaCapture);
}

function captureStatus() {
  return { ...session.status(), starting, config, pageStatus, videos: pageVideos };
}

function configure(next) {
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  if (config) stopCapture("Capture settings changed. Start capture again to use them.");
  config = structuredClone(next);
  session.configure(config);
}

function captureDimensions(videoWidth, videoHeight) {
  const [maxWidth, maxHeight] = config.videoPreset === "compact" ? [480, 270] : [640, 360];
  const scale = Math.min(1, maxWidth / videoWidth, maxHeight / videoHeight);
  const width = Math.max(2, Math.floor(videoWidth * scale / 2) * 2);
  const height = Math.max(2, Math.floor(videoHeight * scale / 2) * 2);
  return { width, height };
}

function resetMediaClock() {
  mediaClockOriginMs = null;
  frameClockOriginMs = null;
  frameClockReady = new Promise(resolve => { resolveFrameClock = resolve; });
}

function establishMediaClock(metadata, now) {
  if (Number.isFinite(mediaClockOriginMs) || !Number.isFinite(metadata?.mediaTime)) return;
  let frameTime = now;
  if (Number.isFinite(metadata.presentationTime)) frameTime = metadata.presentationTime;
  if (Number.isFinite(metadata.captureTime)) frameTime = metadata.captureTime;
  mediaClockOriginMs = performance.timeOrigin + frameTime - metadata.mediaTime * 1000;
}

function establishTrackMediaClock(mediaTimeMs, observedAtMs = timestamp()) {
  if (Number.isFinite(frameClockOriginMs)) return;
  if (!Number.isFinite(mediaTimeMs)) throw new Error("The captured video did not provide media timestamps.");
  frameClockOriginMs = observedAtMs - mediaTimeMs;
  resolveFrameClock?.(frameClockOriginMs);
  resolveFrameClock = null;
}

function clearMediaClock() {
  resolveFrameClock?.(null);
  resolveFrameClock = null;
  mediaClockOriginMs = null;
  frameClockOriginMs = null;
}

async function captureFrame(dimensions, source, at, ownedStream) {
  if (!stream || stream !== ownedStream) return;
  const data = await frameEncoder.encode(source, dimensions);
  if (!data || stream !== ownedStream) return;
  session.addFrame({
    timestampMs: at,
    ...dimensions,
    data,
  });
}

function startTimestampedFrames(sharedStream, sourceTrack) {
  if (typeof MediaStreamTrackProcessor !== "function") return false;
  let ownedTrack;
  let reader;
  try {
    ownedTrack = sourceTrack.clone();
    reader = new MediaStreamTrackProcessor({ track: ownedTrack }).readable.getReader();
  } catch {
    ownedTrack?.stop();
    return false;
  }
  const ownedStream = sharedStream;
  let dimensions = null;
  let lastMediaTimestamp = -Infinity;
  videoReader = reader;
  processedVideoTrack = ownedTrack;
  void (async () => {
    while (stream === ownedStream && videoReader === reader) {
      const { done, value } = await reader.read();
      if (done || !value) return;
      try {
        const mediaTimeMs = value.timestamp / 1000;
        if (!Number.isFinite(mediaTimeMs) || mediaTimeMs < lastMediaTimestamp) {
          throw new Error("The captured video clock was interrupted. Start capture again.");
        }
        lastMediaTimestamp = mediaTimeMs;
        establishTrackMediaClock(mediaTimeMs);
        const frameTimestamp = frameClockOriginMs + mediaTimeMs;
        // The source track already has the preset's frame-rate ceiling. Its
        // irregular frame timestamps must survive intact (e.g. a 30 fps video
        // delivered at 8 fps alternates 100 ms and 133 ms frame spacings).
        if (!dimensions) {
          dimensions = captureDimensions(
            value.displayWidth || value.codedWidth,
            value.displayHeight || value.codedHeight,
          );
        }
        await captureFrame(dimensions, value, frameTimestamp, ownedStream);
        if (stream === ownedStream) session.videoDelivered(frameTimestamp);
      } finally {
        value.close();
      }
    }
  })().catch(error => {
    if (stream === ownedStream && videoReader === reader) {
      stopCapture(`Video capture stopped: ${describe(error)}`);
    }
  });
  return true;
}

function startFallbackFrames() {
  const video = preview;
  const dimensions = captureDimensions(video.videoWidth, video.videoHeight);
  const ownedStream = stream;
  const fps = config.videoPreset === "compact" ? 6 : 8;
  const intervalMs = 1000 / fps;
  let lastStartedAt = -Infinity;
  let lastTimestamp = -Infinity;
  const sample = (at, now) => {
    if (frameBusy || now - lastStartedAt < intervalMs * 0.9) return;
    lastStartedAt = now;
    const frameTimestamp = Math.max(at, lastTimestamp + 0.001);
    lastTimestamp = frameTimestamp;
    frameBusy = true;
    void captureFrame(dimensions, video, frameTimestamp, ownedStream)
      .then(() => { if (stream === ownedStream) session.videoDelivered(frameTimestamp); })
      .catch(error => {
        if (stream === ownedStream) stopCapture(`Video capture stopped: ${describe(error)}`);
      })
      .finally(() => { if (stream === ownedStream) frameBusy = false; });
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    const onFrame = (now, metadata) => {
      frameCallbackId = video.requestVideoFrameCallback(onFrame);
      establishMediaClock(metadata, now);
      let at = performance.timeOrigin + now;
      if (Number.isFinite(metadata.captureTime)) at = performance.timeOrigin + metadata.captureTime;
      if (Number.isFinite(mediaClockOriginMs) && Number.isFinite(metadata.mediaTime)) {
        at = mediaClockOriginMs + metadata.mediaTime * 1000;
      }
      sample(at, now);
    };
    frameCallbackId = video.requestVideoFrameCallback(onFrame);
  }
  frameTimer = setInterval(() => {
    sample(timestamp(), performance.now());
  }, Math.round(1000 / fps));
}

function startFrames(sharedStream, sourceTrack) {
  frameEncoder = createCaptureFrameEncoder();
  if (!startTimestampedFrames(sharedStream, sourceTrack)) startFallbackFrames();
}

function audioTimestampOrigin(mediaTimeMs, videoOriginMs, observedAtMs = timestamp()) {
  // Chrome 150 exposes the same monotonic clock for both raw tracks. Chrome
  // 152 makes AudioData timestamps page-relative; video retains the raw clock.
  // Choose between those observed clock domains, never the preview's unrelated
  // playback mediaTime, and keep that origin for the entire audio stream.
  const pageOriginMs = performance.timeOrigin;
  return Math.abs(pageOriginMs + mediaTimeMs - observedAtMs)
    < Math.abs(videoOriginMs + mediaTimeMs - observedAtMs) ? pageOriginMs : videoOriginMs;
}

function createAudioSampleClock(originMs, observedNow = timestamp) {
  let offsetMs = 0;
  let nextMs = null;
  let sampleRate = null;
  let previousBlockMs = null;
  return value => {
    const rawMs = originMs + value.timestamp / 1000;
    const observedMs = rawMs + offsetMs;
    const blockMs = value.numberOfFrames * 1000 / value.sampleRate;
    if (nextMs === null) {
      sampleRate = value.sampleRate;
      previousBlockMs = blockMs;
      nextMs = observedMs + blockMs;
      return observedMs;
    }
    // AudioData timestamps are privacy-rounded (100 us on observed Chrome
    // 152). Count delivered samples instead of making holes at rounded block
    // boundaries. Forward jumps remain real gaps. A reset or sample-rate
    // change starts a new local epoch after a gap so later blocks can recover.
    let startMs = nextMs;
    if (value.sampleRate !== sampleRate || Math.abs(observedMs - nextMs) >= blockMs / 2) {
      if (value.sampleRate === sampleRate && observedMs > nextMs) {
        startMs = observedMs;
      } else {
        const minimum = nextMs + Math.max(previousBlockMs, blockMs);
        startMs = Math.max(minimum, observedNow() - blockMs);
        offsetMs = startMs - rawMs;
      }
    }
    sampleRate = value.sampleRate;
    previousBlockMs = blockMs;
    nextMs = startMs + blockMs;
    return startMs;
  };
}

function createMonoAudioMixer() {
  let mono = new Float32Array(0);
  let plane = new Float32Array(0);
  return value => {
    if (mono.length !== value.numberOfFrames) {
      mono = new Float32Array(value.numberOfFrames);
      plane = new Float32Array(value.numberOfFrames);
    } else {
      mono.fill(0);
    }
    for (let channel = 0; channel < value.numberOfChannels; channel += 1) {
      value.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
      for (let frame = 0; frame < mono.length; frame += 1) mono[frame] += plane[frame];
    }
    if (value.numberOfChannels > 1) {
      for (let frame = 0; frame < mono.length; frame += 1) mono[frame] /= value.numberOfChannels;
    }
    return mono;
  };
}

function startTimestampedAudio(sharedStream, sourceTrack) {
  let ownedTrack;
  let reader;
  try {
    ownedTrack = sourceTrack.clone();
    reader = new MediaStreamTrackProcessor({ track: ownedTrack }).readable.getReader();
  } catch {
    ownedTrack?.stop();
    return false;
  }
  const ownedStream = sharedStream;
  audioReader = reader;
  audioTrack = ownedTrack;
  void (async () => {
    const videoOriginMs = await frameClockReady;
    if (!Number.isFinite(videoOriginMs) || stream !== ownedStream || audioReader !== reader) return;
    let sampleClock = null;
    const mix = createMonoAudioMixer();
    while (stream === ownedStream && audioReader === reader) {
      const { done, value } = await reader.read();
      if (done || !value) return;
      try {
        sampleClock ??= createAudioSampleClock(audioTimestampOrigin(value.timestamp / 1000, videoOriginMs));
        const startMs = sampleClock(value);
        session.addAudio({
          startMs,
          sampleRate: value.sampleRate,
          samples: mix(value),
        });
      } finally {
        value.close();
      }
    }
  })().catch(error => {
    if (stream === ownedStream && audioReader === reader) {
      stopCapture(`Audio capture stopped: ${describe(error)}`);
    }
  });
  return true;
}

async function startWorkletAudio(sharedStream, sourceTrack) {
  const ownedContext = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
  audioContext = ownedContext;
  await ownedContext.audioWorklet.addModule("capture-audio-worklet.js");
  if (stream !== sharedStream || audioContext !== ownedContext) return;
  const source = ownedContext.createMediaStreamSource(new MediaStream([sourceTrack]));
  const ownedNode = new AudioWorkletNode(ownedContext, "hachidori-capture-audio");
  audioNode = ownedNode;
  const silence = ownedContext.createGain();
  silence.gain.value = 0;
  let originMs = null;
  ownedNode.port.addEventListener("message", event => {
    if (stream !== sharedStream || audioContext !== ownedContext) return;
    if (event.data.discontinuity) return;
    if (!Number.isFinite(originMs)) return;
    const samples = new Float32Array(event.data.samples);
    session.addAudio({
      startMs: originMs + event.data.startFrame * 1000 / ownedContext.sampleRate,
      sampleRate: ownedContext.sampleRate,
      samples,
    });
  });
  ownedNode.port.start();
  source.connect(ownedNode).connect(silence).connect(ownedContext.destination);
  await ownedContext.resume();
  if (stream !== sharedStream || audioContext !== ownedContext) return;
  originMs = timestamp() - ownedContext.currentTime * 1000;
}

async function startAudio(sharedStream) {
  const sourceTrack = sharedStream.getAudioTracks()[0];
  if (!sourceTrack) return;
  if (!globalThis.__hachidoriForceAudioWorklet
      && config.includeAnimation && videoReader
      && typeof MediaStreamTrackProcessor === "function"
      && startTimestampedAudio(sharedStream, sourceTrack)) {
    return;
  }
  await startWorkletAudio(sharedStream, sourceTrack);
}

function stopTexthooker() {
  texthooker?.stop();
  texthooker = null;
}

function createTexthooker() {
  let socket = null;
  let retryTimer = null;
  let stopped = false;
  let attempt = 0;
  let sequence = 0;
  let connectionEpoch = "";
  let sourceEpoch = "";
  let currentSession = "";
  const open = new Map();

  function closeOpen(at = timestamp()) {
    for (const record of open.values()) session.textClose(record, at);
    open.clear();
  }

  function schedule() {
    if (stopped) return;
    session.setTexthooker("Disconnected", false);
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    connectionEpoch = crypto.randomUUID();
    sourceEpoch = connectionEpoch;
    currentSession = "";
    sequence = 0;
    session.setTexthooker("Connecting", false);
    try {
      socket = new WebSocket(config.texthooker.url);
    } catch {
      schedule();
      return;
    }
    const owned = socket;
    owned.addEventListener("open", () => {
      if (socket !== owned) return;
      attempt = 0;
      session.setTexthooker("Connected — waiting for live text", false);
      });
    owned.addEventListener("message", event => {
      if (socket !== owned) return;
      if (typeof event.data !== "string" || event.data.length > MAX_TEXTHOOKER_FRAME_LENGTH) return;
      const parsed = parseTexthookerMessage(config.texthooker.format, event.data);
      if (!parsed || (parsed.type === "line" && parsed.text.length > MAX_TEXTHOOKER_TEXT_LENGTH)) return;
      const at = timestamp();
      if (parsed.type === "reset") {
        closeOpen(at);
        sourceEpoch = `${connectionEpoch}:reset:${++sequence}`;
        session.setTexthooker("Connected — waiting for live text", false);
            return;
      }
      if (parsed.sessionId && parsed.sessionId !== currentSession) {
        closeOpen(at);
        currentSession = parsed.sessionId;
        sourceEpoch = `${connectionEpoch}:${currentSession}`;
      }
      const occurrenceId = parsed.id || `${connectionEpoch}:${++sequence}`;
      if (!open.has(occurrenceId)) closeOpen(at);
      const record = {
        sourceKind: "texthooker",
        sourceId: "loopback-websocket",
        sourceEpoch,
        occurrenceId,
        text: parsed.text,
        startMs: at,
      };
      session.textBegin(record);
      open.set(occurrenceId, record);
      session.setTexthooker("Active", true);
      });
    owned.addEventListener("close", () => {
      if (socket !== owned) return;
      socket = null;
      closeOpen();
      schedule();
      });
    owned.addEventListener("error", () => owned.close());
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      closeOpen();
      const active = socket;
      socket = null;
      active?.close(1000, "Capture stopped");
      session.setTexthooker("Disconnected", false);
    },
  };
}

function validateCaptureSource(requested) {
  const videoTrack = requested.getVideoTracks()[0];
  if (!videoTrack) {
    requested.getTracks().forEach(track => track.stop());
    throw new Error("The selected source did not provide video.");
  }
  if (!config.includeAnimation && config.includeCapturedAudio
      && requested.getAudioTracks().length === 0) {
    requested.getTracks().forEach(track => track.stop());
    throw new Error("The selected source did not provide audio for media capture.");
  }
  return videoTrack;
}

function watchCaptureSource(requested) {
  for (const track of requested.getTracks()) {
    track.addEventListener("ended", () => {
      if (stream === requested) stopCapture(`The shared ${track.kind} source ended.`);
    });
    track.addEventListener("mute", () => {
      if (stream === requested) {
        stopCapture(`The shared ${track.kind} source became unavailable. Start capture again when it is available.`);
      }
    });
  }
}

async function startCapture() {
  if (starting || stream) throw new Error("A capture source is already being selected or recorded.");
  if (!config?.enabled) throw new Error("Enable media capture in Settings first.");
  const version = ++captureVersion;
  const frameRate = config.videoPreset === "compact" ? 6 : 8;
  starting = true;
  try {
    const requested = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: frameRate, max: frameRate },
      },
      audio: config.includeCapturedAudio ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } : false,
      monitorTypeSurfaces: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
    });
    if (version !== captureVersion) {
      requested.getTracks().forEach(track => track.stop());
      return;
    }
    const videoTrack = validateCaptureSource(requested);
    const settings = videoTrack.getSettings();
    stream = requested;
    resetMediaClock();
    session.start({
      sourceName: videoTrack.label || "Shared media",
      displaySurface: settings.displaySurface || "browser",
      audioAvailable: requested.getAudioTracks().length > 0,
    });
    watchCaptureSource(requested);
    preview.srcObject = requested;
    preview.hidden = false;
    await preview.play();
    if (stream !== requested) return;
    if (config.includeAnimation) startFrames(requested, videoTrack);
    if (config.includeCapturedAudio) await startAudio(requested);
    if (stream !== requested) return;
    if (config.timingMode === "auto" && config.texthooker.enabled) texthooker = createTexthooker();
  } catch (error) {
    if (version === captureVersion) stopCapture(describe(error));
  } finally {
    if (version === captureVersion) starting = false;
  }
}

function stopCapture(error = "") {
  const retired = session.status();
  captureVersion += 1;
  starting = false;
  if (frameCallbackId !== null) {
    preview.cancelVideoFrameCallback(frameCallbackId);
    frameCallbackId = null;
  }
  clearInterval(frameTimer);
  frameTimer = null;
  frameBusy = false;
  frameEncoder?.close();
  frameEncoder = null;
  const frames = videoReader;
  videoReader = null;
  void frames?.cancel().catch(() => {});
  processedVideoTrack?.stop();
  processedVideoTrack = null;
  stopTexthooker();
  const reader = audioReader;
  audioReader = null;
  void reader?.cancel().catch(() => {});
  audioTrack?.stop();
  audioTrack = null;
  audioNode?.disconnect();
  audioNode = null;
  void audioContext?.close();
  audioContext = null;
  clearMediaClock();
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  preview.srcObject = null;
  preview.hidden = true;
  if (retired.linkedPage) {
    void send("hd_capture_host_stopped", { captureDocumentId,
      captureSessionId: retired.captureSessionId, linkedPage: retired.linkedPage }).catch(() => {});
  }
  selectedTabId = null;
  linkedDocumentId = "";
  pageVideos = [];
  pageStatus = "";
  session.stop(error);
}

function linked(message) {
  return selectedTabId === message.tabId && linkedDocumentId === message.documentId;
}

function captureJobOwner(message) {
  if (message.tabId === undefined && message.documentId === undefined) return null;
  return { tabId: message.tabId, documentId: message.documentId };
}

function beginCaptureExport(message) {
  if (!linked(message)) throw new Error("This export is not from the linked reading page.");
  return session.beginExport(message.token, message.requirements, captureJobOwner(message));
}

function linkCaptureReader(message) {
  const status = session.status();
  if (status.state !== "recording" || message.captureSessionId !== status.captureSessionId) {
    throw new Error("The capture session changed before the reading page was linked.");
  }
  selectedTabId = message.page.tabId;
  linkedDocumentId = message.page.documentId;
  session.setLinkedPage(message.page);
  pageStatus = message.page.message || "Reading page linked.";
  pageVideos = message.page.videos;
  return session.status();
}

function bytesToBase64(data) {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCodePoint(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function recordSpeechAudio(source, term, signal, { record = true } = {}) {
  session.assertAudioCapture();
  if (!record) {
    await resolveSpeech(globalThis, source, term, signal);
    return { recordingRequired: true };
  }
  return recordCapturedSpeech(globalThis, session, source, term, signal, { now: timestamp });
}

export async function handleCaptureMessage(message) {
  if (message.captureDocumentId !== captureDocumentId) throw new Error("The capture host identity changed.");
  switch (message.type) {
    case "hd_capture_configure": configure(message.mediaCapture); return captureStatus();
    case "hd_capture_status": return captureStatus();
    case "hd_capture_start": await startCapture(); return captureStatus();
    case "hd_capture_stop": stopCapture(); return captureStatus();
    case "hd_capture_linked": return linkCaptureReader(message);
    case "hd_capture_unlinked":
      if (!linked(message)) return { ignored: true };
      selectedTabId = null;
      linkedDocumentId = "";
      session.setLinkedPage(null);
      pageStatus = message.reason || "The reading page navigated. Link it again.";
      pageVideos = [];
      return session.status();
    case "hd_capture_text_begin":
      if (!linked(message)) return { ignored: true };
      return session.textBegin(message.record);
    case "hd_capture_text_close":
      if (!linked(message)) return { ignored: true };
      return session.textClose(message.identity, message.endMs);
    case "hd_capture_text_source_close":
      if (!linked(message)) return { ignored: true };
      return session.closeTextSource(message.sourceKind, message.sourceId, message.sourceEpoch, message.endMs);
    case "hd_capture_page_status":
      if (!linked(message)) return { ignored: true };
      pageStatus = String(message.message || "").slice(0, 500);
      return { displayed: true };
    case "hd_capture_pin":
      if (!linked(message)) throw new Error("This lookup is not from the linked reading page.");
      return session.pinLookup(message.lookup);
    case "hd_capture_release": return { released: session.releasePin(message.token) };
    case "hd_capture_export": return beginCaptureExport(message);
    case "hd_capture_job_status": return session.jobStatus(message.jobId, captureJobOwner(message));
    case "hd_capture_asset": {
      const asset = session.jobAsset(message.jobId, message.kind);
      return { filename: asset.filename, data: bytesToBase64(asset.data) };
    }
    case "hd_capture_complete": return { completed: session.completeExport(message.jobId) };
    case "hd_capture_cancel": return { cancelled: session.cancelExport(message.jobId, captureJobOwner(message)) };
    default: throw new Error("Unknown capture page request.");
  }
}

await register();
