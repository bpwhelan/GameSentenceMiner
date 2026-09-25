// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createAudioRing,
  createCapturePinStore,
  createFrameRing,
  encodeMonoWav,
} from "./capture-buffer.js";
import { encodeCapturedAnimation } from "./capture-encoder-client.js";
import { MAX_ANIMATED_AVIF_BYTES } from "./avif-sequence.js";
import { createCaptureTimeline, resolveCaptureInterval } from "./capture-timeline.js";

const JOB_LIFETIME_MS = 2 * 60 * 1000;
export const MEDIA_DRAIN_MS = 250;

function safeAssetId(value = crypto.randomUUID()) {
  const id = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!id) throw new Error("Could not allocate a media asset identity.");
  return id;
}

function waitUntil(deadline, now, setTimer) {
  const remaining = Math.max(0, deadline - now());
  if (remaining === 0) return Promise.resolve();
  return new Promise(resolve => setTimer(resolve, remaining));
}

function assertJobOwner(job, owner) {
  if (owner && (owner.tabId !== job.owner?.tabId || owner.documentId !== job.owner?.documentId)) {
    throw new Error("This reading document does not own the media export job.");
  }
}

export function createCaptureSession({
  now = () => performance.timeOrigin + performance.now(),
  wallNow = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  encodeAnimation = encodeCapturedAnimation,
  randomId = () => crypto.randomUUID(),
} = {}) {
  let config = null;
  let captureSessionId = "";
  let state = "disabled";
  let statusError = "";
  let mediaSource = null;
  let capturedAudioAvailable = false;
  let linkedPage = null;
  let texthookerStatus = "Disabled";
  let texthookerActive = false;
  let texthookerSource = null;
  let videoDeliveredThroughMs = -Infinity;
  const timeline = createCaptureTimeline();
  let frameRing = null;
  let audioRing = null;
  let pins = createCapturePinStore({ now: wallNow });
  const jobs = new Map();
  let activeJobId = null;

  function status() {
    const frameSize = frameRing?.size() ?? { count: 0, bytes: 0 };
    const audioSize = audioRing?.size() ?? { blocks: 0, samples: 0 };
    return {
      state,
      error: statusError,
      captureSessionId,
      mediaSource,
      linkedPage,
      texthookerStatus,
      texthookerActive,
      history: {
        frameCount: frameSize.count,
        frameBytes: frameSize.bytes,
        audioBlocks: audioSize.blocks,
        audioSamples: audioSize.samples,
        frameOldestMs: frameRing?.oldestTimestamp() ?? null,
        frameNewestMs: frameRing?.newestTimestamp() ?? null,
        audioOldestMs: audioRing?.oldestTimestamp() ?? null,
        audioNewestMs: audioRing?.newestTimestamp() ?? null,
        oldestMs: oldestRequiredTimestamp(),
        newestMs: (() => {
          const newest = Math.max(frameRing?.newestTimestamp() ?? -Infinity, audioRing?.newestTimestamp() ?? -Infinity);
          return Number.isFinite(newest) ? newest : null;
        })(),
      },
      pinActive: pins.active() || activeJobId !== null,
    };
  }

  function oldestRequiredTimestamp() {
    if (!config) return null;
    const values = [];
    if (config.includeAnimation) values.push(frameRing?.oldestTimestamp());
    if (config.includeCapturedAudio && capturedAudioAvailable) values.push(audioRing?.oldestTimestamp());
    const available = values.filter(Number.isFinite);
    return available.length ? Math.max(...available) : null;
  }

  function configure(value) {
    cancelOwnedCapture("Capture settings changed.");
    config = structuredClone(value);
    frameRing = createFrameRing({ maxAgeMs: config.historySeconds * 1000 });
    audioRing = createAudioRing({ maxAgeMs: config.historySeconds * 1000 });
    pins = createCapturePinStore({ now: wallNow });
    timeline.reset();
    jobs.clear();
    activeJobId = null;
    texthookerActive = false;
    texthookerSource = null;
    videoDeliveredThroughMs = -Infinity;
    texthookerStatus = config.timingMode === "auto" && config.texthooker.enabled
      ? "Disconnected" : "Disabled";
    state = config.enabled ? "stopped" : "disabled";
    statusError = "";
  }

  function start({ sourceName = "Shared tab", displaySurface = "browser", audioAvailable = true } = {}) {
    if (!config?.enabled) throw new Error("Enable media capture in Settings first.");
    captureSessionId = randomId();
    capturedAudioAvailable = audioAvailable === true;
    mediaSource = {
      name: String(sourceName).slice(0, 200),
      displaySurface,
      audioAvailable: capturedAudioAvailable,
    };
    state = "recording";
    statusError = "";
    return status();
  }

  function stop(error = "") {
    cancelOwnedCapture(error || "Capture stopped.");
    state = config ? "stopped" : "disabled";
    statusError = error;
    captureSessionId = "";
    mediaSource = null;
    capturedAudioAvailable = false;
    linkedPage = null;
    texthookerActive = false;
    texthookerSource = null;
    videoDeliveredThroughMs = -Infinity;
    texthookerStatus = config?.timingMode === "auto" && config.texthooker.enabled
      ? "Disconnected" : "Disabled";
    frameRing?.clear();
    audioRing?.clear();
    timeline.reset();
    pins.clear();
    jobs.clear();
    activeJobId = null;
  }

  function requireRecording() {
    if (state !== "recording" || !captureSessionId) throw new Error("Start capture before looking up text.");
  }

  function addFrame(frame) {
    requireRecording();
    const added = frameRing.append(frame);
    videoDelivered(added.timestampMs);
    return added;
  }

  function videoDelivered(timestampMs) {
    requireRecording();
    videoDeliveredThroughMs = Math.max(videoDeliveredThroughMs, timestampMs);
    currentPin()?.checkDrain?.();
  }

  function addAudio(block) {
    requireRecording();
    const added = audioRing.append(block);
    currentPin()?.checkDrain?.();
    return added;
  }

  function assertAudioCapture() {
    if (state !== "recording" || !captureSessionId) {
      throw new Error("Start media capture with shared audio before attaching browser text-to-speech to Anki.");
    }
    if (!config.includeCapturedAudio || !capturedAudioAvailable) {
      throw new Error("The active media capture has no shared audio. Start capture again and enable audio in Chrome's share picker.");
    }
  }

  function selectAudio(startMs, endMs) {
    assertAudioCapture();
    const selected = audioRing.select(startMs, endMs);
    if (selected.partial) {
      throw new Error("The active media capture did not record all browser text-to-speech samples. Try adding the note again after shared audio resumes.");
    }
    return selected;
  }

  function setLinkedPage(page) {
    const previous = linkedPage;
    if (previous && (previous.tabId !== page?.tabId || previous.documentId !== page?.documentId)
        && activePin) releasePin(activePin.token);
    if (previous) {
      const sourceId = `tab:${previous.tabId}`;
      const endMs = now();
      for (const sourceKind of ["cue", "dom"]) {
        for (const record of timeline.closeSource(sourceKind, sourceId, undefined, endMs)) {
          adjustOpenPin(record);
        }
      }
    }
    linkedPage = page ? {
      tabId: page.tabId,
      documentId: page.documentId,
      title: String(page.title || "").slice(0, 200),
      url: String(page.url || "").slice(0, 2048),
    } : null;
  }

  function textBegin(record) {
    requireRecording();
    const begun = timeline.begin(record);
    if (record.sourceKind === "texthooker") {
      texthookerSource = { sourceId: record.sourceId, sourceEpoch: record.sourceEpoch };
    }
    return begun;
  }

  function textClose(identity, endMs = now()) {
    const closed = timeline.close(identity, endMs);
    if (closed) adjustOpenPin(closed);
    return closed;
  }

  function closeTextSource(sourceKind, sourceId, sourceEpoch, endMs = now()) {
    const closed = timeline.closeSource(sourceKind, sourceId, sourceEpoch, endMs);
    for (const record of closed) adjustOpenPin(record);
    return closed;
  }

  function setTexthooker(nextStatus, active = false) {
    texthookerStatus = nextStatus;
    texthookerActive = active;
    if (!active) texthookerSource = null;
  }

  function adjustOpenPin(closed) {
    const active = currentPin();
    if (!active || active.finalized || active.sourceKind !== closed.sourceKind
        || active.sourceId !== closed.sourceId || active.sourceEpoch !== closed.sourceEpoch
        || active.occurrenceId !== closed.occurrenceId) return;
    const offset = closed.sourceKind === "cue" ? 0 : config.estimatedOffsetMs;
    const closedEnd = closed.endMs + offset;
    if (closedEnd > active.startMs && closedEnd < active.endMs) {
      active.endMs = closedEnd;
      active.deadlineVersion += 1;
      active.finishDrain?.();
      void finalizeAtDeadline(active, active.deadlineVersion);
    }
  }

  function currentPin() {
    return activePin ?? (activeJobId ? jobs.get(activeJobId)?.pin ?? null : null);
  }

  let activePin = null;

  function cancelOwnedCapture(message) {
    const error = new Error(message);
    if (activePin && !activePin.finalized) {
      activePin.finishDrain?.();
      activePin.rejectReady(error);
    }
    activePin = null;
    for (const job of jobs.values()) {
      job.controller.abort();
      if (!job.pin.finalized) {
        job.pin.finishDrain?.();
        job.pin.rejectReady(error);
      }
    }
  }

  function mediaDelivered(pin) {
    return (!config.includeAnimation || videoDeliveredThroughMs >= pin.endMs)
      && (!config.includeCapturedAudio || !pin.audioAvailable
        || audioRing.covers(pin.startMs, pin.endMs));
  }

  function drainMedia(pin) {
    if (mediaDelivered(pin)) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimer(finish, MEDIA_DRAIN_MS);
      function finish() {
        clearTimer(timer);
        pin.finishDrain = null;
        pin.checkDrain = null;
        resolve();
      }
      pin.finishDrain = finish;
      pin.checkDrain = () => { if (mediaDelivered(pin)) finish(); };
    });
  }

  async function finalizeAtDeadline(pin, version) {
    await waitUntil(pin.endMs, now, setTimer);
    if (currentPin() !== pin || pin.deadlineVersion !== version || pin.finalized) return;
    try {
      // Delivery can trail its timestamp (JPEG encoding and worklet batches).
      // Wait for that delivery without moving the lookup's frozen interval.
      await drainMedia(pin);
      if (currentPin() !== pin || pin.deadlineVersion !== version || pin.finalized) return;
      pin.frames = config.includeAnimation ? frameRing.select(pin.startMs, pin.endMs) : [];
      pin.audio = config.includeCapturedAudio && pin.audioAvailable
        ? audioRing.select(pin.startMs, pin.endMs) : null;
      pin.mediaErrors = {};
      // A display-capture track can emit only changed frames. Once the bounded
      // drain ends, its last pixels remain valid until source mute/loss stops us.
      if (pin.audio?.partial) {
        pin.mediaErrors.audio = "Captured audio is missing samples in this clip. Look up the text again.";
      }
      if (config.includeCapturedAudio && !pin.audioAvailable) pin.partial = true;
      pin.partial ||= pin.audio?.partial === true;
      pin.finalized = true;
      pin.resolveReady(pin);
    } catch (error) {
      pin.rejectReady(error);
      pins.release(pin.token);
      activePin = null;
    }
  }

  function pinLookup({ lookupText, occurrenceId = "", occurrenceSourceKind = "", lookupTimeMs = now() }) {
    requireRecording();
    pruneJobs();
    if (activeJobId !== null) throw new Error("Another captured clip is still exporting. Finish or cancel it first.");
    if (!config.includeAnimation && config.includeCapturedAudio && !capturedAudioAvailable) {
      throw new Error("The shared source did not provide audio for media capture.");
    }
    const availableStartMs = oldestRequiredTimestamp();
    if (!Number.isFinite(availableStartMs)) throw new Error("Capture history is still warming up.");
    const interval = resolveCaptureInterval({
      records: timeline.snapshot(),
      lookupText,
      occurrenceId,
      occurrenceSourceKind,
      lookupTimeMs,
      availableStartMs,
      timingMode: config.timingMode,
      clipSeconds: config.clipSeconds,
      estimatedOffsetMs: config.estimatedOffsetMs,
      texthookerActive,
      texthookerSource: texthookerActive ? texthookerSource : null,
    });
    if (!interval) throw new Error("No retained capture interval is available for this lookup.");
    const assetId = safeAssetId(randomId());
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const created = pins.create({
      ...interval,
      captureSessionId,
      assetId,
      animationFilename: `hachidori-${assetId}.avif`,
      audioFilename: `hachidori-${assetId}.wav`,
      audioAvailable: capturedAudioAvailable,
      deadlineVersion: 1,
      finalized: false,
      frames: null,
      audio: null,
      mediaErrors: {},
      ready,
      resolveReady,
      rejectReady,
    });
    activePin = pins.get(created.token);
    void finalizeAtDeadline(activePin, activePin.deadlineVersion);
    return {
      token: created.token,
      captureSessionId,
      sourceKind: interval.sourceKind,
      sourceLabel: interval.sourceLabel,
      partial: interval.partial === true,
      animationFilename: created.animationFilename,
      audioFilename: created.audioFilename,
      readyAtMs: interval.endMs,
    };
  }

  function releasePin(token) {
    let released = pins.release(token);
    // Status may have expired the token before the reader dismisses its clip.
    // The session still owns those media copies until this reference is retired.
    if (activePin !== null && activePin.token === token) {
      activePin.finishDrain?.();
      activePin.rejectReady(new Error("The capture pin was released."));
      activePin = null;
      released = true;
    }
    return released;
  }

  function pruneJobs() {
    const cutoff = wallNow() - JOB_LIFETIME_MS;
    for (const [id, job] of jobs) {
      if (job.updatedAt >= cutoff) continue;
      job.controller.abort();
      if (!job.pin.finalized) {
        job.pin.finishDrain?.();
        job.pin.rejectReady(new Error("The media export job expired."));
      }
      jobs.delete(id);
      if (activeJobId === id) activeJobId = null;
    }
  }

  function beginExport(token, requirements, owner = linkedPage) {
    pruneJobs();
    if (activeJobId !== null) {
      const existing = jobs.get(activeJobId);
      if (existing?.token === token) {
        assertJobOwner(existing, owner);
        return { jobId: existing.id, state: existing.state,
          sourceLabel: existing.sourceLabel, partial: existing.partial };
      }
      throw new Error("Another captured clip is still exporting.");
    }
    const pin = pins.get(token);
    if (pin?.captureSessionId !== captureSessionId) throw new Error("The capture pin expired. Look up the text again.");
    const includeAnimation = requirements?.includeAnimation === true && config.includeAnimation;
    const includeAudio = requirements?.includeAudio === true && config.includeCapturedAudio && pin.audioAvailable;
    if (!includeAnimation && requirements?.includeAudio === true
        && config.includeCapturedAudio && !pin.audioAvailable) {
      throw new Error("The shared source did not provide audio for the mapped captured-audio field.");
    }
    if (!includeAnimation && !includeAudio) throw new Error("The selected Anki fields do not reference captured media.");
    const id = randomId();
    const controller = new AbortController();
    const job = { id, token, state: "finishing", error: "", progress: 0, total: 0, encoderHeapBytes: 0,
      sourceLabel: pin.sourceLabel, partial: pin.partial === true, assets: {}, updatedAt: wallNow(),
      controller, pin, owner: owner ? { tabId: owner.tabId, documentId: owner.documentId } : null,
      warnings: requirements?.includeAudio === true && !pin.audioAvailable
        ? ["The shared source did not provide audio; this note will use animation only."] : [] };
    jobs.set(id, job);
    activeJobId = id;
    pins.release(token);
    if (activePin === pin) activePin = null;
    void (async () => {
      try {
        await pin.ready;
        if (controller.signal.aborted) throw new Error("Media encoding was cancelled.");
        if (includeAudio && pin.mediaErrors.audio) throw new Error(pin.mediaErrors.audio);
        job.state = "encoding";
        job.updatedAt = wallNow();
        if (includeAnimation) {
          job.assets.animation = {
            filename: pin.animationFilename,
            data: await encodeAnimation(pin.frames, { endMs: pin.endMs, videoPreset: config.videoPreset }, {
              signal: controller.signal,
              onProgress(completed, total, heapBytes) {
                job.progress = completed;
                job.total = total;
                if (Number.isSafeInteger(heapBytes) && heapBytes > job.encoderHeapBytes) {
                  job.encoderHeapBytes = heapBytes;
                }
                job.updatedAt = wallNow();
              },
            }),
          };
          if (job.assets.animation.data.byteLength > MAX_ANIMATED_AVIF_BYTES) {
            throw new Error("Animated AVIF exceeds its 4 MiB output limit.");
          }
        }
        if (includeAudio) {
          job.assets.audio = {
            filename: pin.audioFilename,
            data: encodeMonoWav(pin.audio.samples, pin.audio.sampleRate),
          };
        }
        job.partial ||= pin.partial || pin.audio?.partial === true;
        job.state = "ready";
      } catch (error) {
        job.state = "error";
        job.error = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = wallNow();
    })();
    return { jobId: id, state: job.state, sourceLabel: job.sourceLabel, partial: job.partial };
  }

  function jobStatus(id, owner = null) {
    pruneJobs();
    const job = jobs.get(id);
    if (!job) throw new Error("The media export job expired.");
    assertJobOwner(job, owner);
    return {
      jobId: id,
      state: job.state,
      error: job.error,
      progress: job.progress,
      total: job.total,
      encoderHeapBytes: job.encoderHeapBytes,
      sourceLabel: job.sourceLabel,
      partial: job.partial,
      warnings: [...job.warnings],
      assets: Object.fromEntries(Object.entries(job.assets).map(([kind, asset]) =>
        [kind, { filename: asset.filename, byteLength: asset.data.byteLength }])),
    };
  }

  function jobAsset(id, kind) {
    const job = jobs.get(id);
    if (job?.state !== "ready" || !["animation", "audio"].includes(kind) || !job.assets[kind]) {
      throw new Error("The requested captured media asset is unavailable.");
    }
    const asset = job.assets[kind];
    return { filename: asset.filename, data: asset.data.slice() };
  }

  function completeExport(id) {
    const job = jobs.get(id);
    if (!job) return false;
    jobs.delete(id);
    if (activeJobId === id) activeJobId = null;
    return true;
  }

  function cancelExport(id, owner = null) {
    const job = jobs.get(id);
    if (!job) return false;
    assertJobOwner(job, owner);
    job.controller.abort();
    if (!job.pin.finalized) {
      job.pin.finishDrain?.();
      job.pin.rejectReady(new Error("The media export job was cancelled."));
    }
    jobs.delete(id);
    if (activeJobId === id) activeJobId = null;
    return true;
  }

  return {
    configure,
    start,
    stop,
    status,
    addFrame,
    videoDelivered,
    addAudio,
    assertAudioCapture,
    selectAudio,
    setLinkedPage,
    textBegin,
    textClose,
    closeTextSource,
    setTexthooker,
    pinLookup,
    releasePin,
    beginExport,
    jobStatus,
    jobAsset,
    completeExport,
    cancelExport,
  };
}
