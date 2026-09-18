// SPDX-License-Identifier: GPL-3.0-or-later
import { CAPTURE_SAMPLE_RATE, encodeMonoWav } from "./capture-buffer.js";
import { resolveSpeech } from "./speech.js";

const SPEECH_TAIL_MS = 200;
const MIN_AUDIBLE_PEAK = 1 / 4096;
const MAX_SPEECH_WAV_BYTES = 1024 * 1024;
export const EMBEDDED_SPEECH_CAPTURE_TARGET = "hachidori-embedded-speech-capture";

function wait(milliseconds, signal, setTimer, clearTimer) {
  signal.throwIfAborted();
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimer(done, milliseconds);
    function clean() {
      clearTimer(timer);
      signal.removeEventListener("abort", aborted);
    }
    function done() {
      clean();
      resolve();
    }
    function aborted() {
      clean();
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function mixInputBuffer(buffer) {
  const channels = Math.max(1, buffer.numberOfChannels);
  const samples = new Float32Array(buffer.length);
  for (let channel = 0; channel < channels; channel += 1) {
    const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] += input[index] / channels;
    }
  }
  return samples;
}

function joinSamples(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

function requireAudioTrack(stream) {
  if (stream.getAudioTracks().length === 0) {
    throw new TypeError("GameSentenceMiner did not provide the browser-speech audio track.");
  }
}

function decodeBase64(window, value) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, character => character.codePointAt(0));
}

function isWav(data) {
  return data.length >= 44
    && String.fromCodePoint(...data.subarray(0, 4)) === "RIFF"
    && String.fromCodePoint(...data.subarray(8, 12)) === "WAVE";
}

async function playWav(window, data, signal) {
  signal.throwIfAborted();
  const url = window.URL.createObjectURL(new window.Blob([data], { type: "audio/wav" }));
  const audio = new window.Audio();
  let abort;
  try {
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error("GameSentenceMiner system speech WAV could not be played."));
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      audio.src = url;
      Promise.resolve(audio.play()).catch(reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    audio.onended = audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    window.URL.revokeObjectURL(url);
  }
}

async function recordNativeSpeech(window, voice, candidate, signal) {
  const synthesize = window.gsmHachidoriSpeech?.synthesize;
  if (typeof synthesize !== "function") return null;
  const reply = await synthesize({
    text: candidate.text,
    voice: {
      voiceURI: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
      localService: voice.localService === true,
      default: voice.default === true,
    },
  });
  signal.throwIfAborted();
  if (reply?.unsupported === true) return null;
  if (!reply?.ok) {
    throw new Error(reply?.error || "GameSentenceMiner could not synthesize the selected system voice.");
  }
  if (typeof reply.data !== "string" || reply.data === "") {
    throw new Error("GameSentenceMiner system speech returned no WAV data.");
  }
  const data = decodeBase64(window, reply.data);
  if (data.length > MAX_SPEECH_WAV_BYTES) {
    throw new Error("GameSentenceMiner system speech exceeds the 1 MiB WAV limit.");
  }
  if (!isWav(data)) {
    throw new Error("GameSentenceMiner system speech did not return a WAV file.");
  }
  await playWav(window, data, signal);
  return { data, candidate };
}

export function trimEmbeddedSpeech(samples, sampleRate, {
  threshold = MIN_AUDIBLE_PEAK,
  preRollMs = 100,
  tailMs = SPEECH_TAIL_MS,
} = {}) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new Error("GameSentenceMiner did not capture browser text-to-speech audio.");
  }
  let peak = 0;
  let first = -1;
  let last = -1;
  for (let index = 0; index < samples.length; index += 1) {
    const amplitude = Math.abs(samples[index]);
    peak = Math.max(peak, amplitude);
    if (amplitude >= threshold) {
      first = first < 0 ? index : first;
      last = index;
    }
  }
  if (peak < threshold || first < 0 || last < first) {
    throw new Error("GameSentenceMiner did not capture audible browser text-to-speech.");
  }
  const start = Math.max(0, first - Math.round(preRollMs * sampleRate / 1000));
  const end = Math.min(samples.length, last + 1 + Math.round(tailMs * sampleRate / 1000));
  return samples.slice(start, end);
}

// Electron hosts can grant a normal extension page as its own display-media
// source. That exposes the exact selected Web Speech voice as bytes while local
// echo keeps the pronunciation audible.
export async function recordEmbeddedSpeech(window, source, term, signal, {
  record = true,
  setTimer = window.setTimeout?.bind(window) ?? setTimeout,
  clearTimer = window.clearTimeout?.bind(window) ?? clearTimeout,
  tailMs = SPEECH_TAIL_MS,
} = {}) {
  const { speech, utterance, voice, candidate } = await resolveSpeech(window, source, term, signal);
  if (!record) return { recordingRequired: true };
  signal.throwIfAborted();

  const nativeRecording = await recordNativeSpeech(window, voice, candidate, signal);
  if (nativeRecording !== null) return nativeRecording;

  const getDisplayMedia = window.navigator?.mediaDevices?.getDisplayMedia?.bind(window.navigator.mediaDevices);
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (typeof getDisplayMedia !== "function" || typeof AudioContext !== "function") {
    throw new TypeError("GameSentenceMiner browser-speech capture is unavailable.");
  }

  let stream = null;
  let context = null;
  let input = null;
  let processor = null;
  let keepalive = null;
  let abort = null;
  const chunks = [];
  try {
    stream = await getDisplayMedia({ audio: true, video: true });
    signal.throwIfAborted();
    requireAudioTrack(stream);

    context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    input = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 2, 1);
    keepalive = context.createGain();
    keepalive.gain.value = 0;
    processor.onaudioprocess = event => {
      chunks.push(mixInputBuffer(event.inputBuffer));
      for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel += 1) {
        event.outputBuffer.getChannelData(channel).fill(0);
      }
    };
    input.connect(processor);
    // ScriptProcessor callbacks stop when their output is not part of a live
    // graph. Keep it scheduled through silence so captured frame audio cannot
    // be echoed into the same frame and fed back into the recording.
    processor.connect(keepalive);
    keepalive.connect(context.destination);
    await context.resume();
    signal.throwIfAborted();

    await new Promise((resolve, reject) => {
      let started = false;
      utterance.onstart = () => { started = true; };
      utterance.onend = () => {
        if (!started) {
          reject(new Error("Browser text-to-speech ended before frame audio capture started."));
          return;
        }
        resolve();
      };
      utterance.onerror = event => {
        const detail = event.error ? ` (${event.error})` : "";
        reject(new Error(`Text-to-speech could not be recorded${detail}.`));
      };
      abort = () => {
        utterance.onstart = utterance.onend = utterance.onerror = null;
        speech.cancel();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      speech.cancel();
      speech.speak(utterance);
    });
    await wait(tailMs, signal, setTimer, clearTimer);
    const samples = trimEmbeddedSpeech(joinSamples(chunks), context.sampleRate, { tailMs });
    return { data: encodeMonoWav(samples, context.sampleRate), candidate };
  } finally {
    signal.removeEventListener("abort", abort);
    utterance.onstart = utterance.onend = utterance.onerror = null;
    if (processor) {
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch { /* already disconnected */ }
    }
    if (keepalive) {
      try { keepalive.disconnect(); } catch { /* already disconnected */ }
    }
    if (input) {
      try { input.disconnect(); } catch { /* already disconnected */ }
    }
    for (const track of stream?.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    await context?.close?.().catch(() => {});
  }
}

export async function requestEmbeddedSpeech(window, source, term, signal, {
  record = true,
} = {}) {
  signal.throwIfAborted();
  const captureId = window.crypto.randomUUID();
  const pending = Promise.resolve(window.chrome.runtime.sendMessage({
    target: EMBEDDED_SPEECH_CAPTURE_TARGET,
    type: "hd_embedded_speech_capture",
    requestId: captureId,
    captureId,
    source,
    term,
    record,
  }));
  let abort;
  try {
    const reply = await Promise.race([
      pending,
      new Promise((resolve, reject) => {
        abort = () => {
          void Promise.resolve(window.chrome.runtime.sendMessage({
            target: EMBEDDED_SPEECH_CAPTURE_TARGET,
            type: "hd_embedded_speech_capture_cancel",
            requestId: captureId,
            captureId,
          })).catch(() => {});
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    if (!reply?.ok) {
      throw new Error(reply?.error || "GameSentenceMiner browser-speech capture host is unavailable.");
    }
    if (reply.recordingRequired === true) return { recordingRequired: true };
    if (typeof reply.data !== "string" || reply.data === "") {
      throw new Error("GameSentenceMiner browser-speech capture returned no audio.");
    }
    return {
      data: decodeBase64(window, reply.data),
      candidate: reply.candidate,
    };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
