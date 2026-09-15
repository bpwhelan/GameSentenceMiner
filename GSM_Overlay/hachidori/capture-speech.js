// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeMonoWav } from "./capture-buffer.js";
import { MEDIA_DRAIN_MS } from "./capture-session.js";
import { resolveSpeech } from "./speech.js";

const SPEECH_PREROLL_MS = 100;
const SPEECH_TAIL_MS = 200;
const MIN_AUDIBLE_PEAK = 1 / 4096;

function waitUntil(deadline, signal, now, setTimer, clearTimer) {
  signal.throwIfAborted();
  const remaining = Math.max(0, deadline - now());
  if (remaining === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimer(done, remaining);
    function clean() { clearTimer(timer); signal.removeEventListener("abort", aborted); }
    function done() { clean(); resolve(); }
    function aborted() { clean(); reject(signal.reason); }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function recordCapturedSpeech(window, session, source, term, signal, {
  now = () => performance.timeOrigin + performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  preRollMs = SPEECH_PREROLL_MS,
  tailMs = SPEECH_TAIL_MS,
  drainMs = MEDIA_DRAIN_MS,
} = {}) {
  session.assertAudioCapture();
  const { speech, utterance, candidate } = await resolveSpeech(window, source, term, signal);
  signal.throwIfAborted();
  let startMs = null;
  let endMs = null;
  let abort;
  try {
    await new Promise((resolve, reject) => {
      utterance.onstart = () => { startMs ??= now() - preRollMs; };
      utterance.onend = () => {
        if (!Number.isFinite(startMs)) {
          reject(new Error("Browser text-to-speech ended before audio capture started."));
          return;
        }
        endMs = now() + tailMs;
        resolve();
      };
      utterance.onerror = event => {
        const detail = event.error ? ` (${event.error})` : "";
        reject(new Error(`Text-to-speech could not be recorded${detail}.`));
      };
      abort = () => {
        // Cancel synchronously before another operation can own the global
        // speech queue; the detached callbacks cannot affect newer speech.
        utterance.onend = utterance.onerror = utterance.onstart = null;
        speech.cancel();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      // A pronunciation already queued by the popup must not become part of
      // this note's recording.
      speech.cancel();
      speech.speak(utterance);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    utterance.onend = utterance.onerror = utterance.onstart = null;
  }
  await waitUntil(endMs + drainMs, signal, now, setTimer, clearTimer);
  const selected = session.selectAudio(startMs, endMs);
  let peak = 0;
  for (const sample of selected.samples) peak = Math.max(peak, Math.abs(sample));
  if (peak < MIN_AUDIBLE_PEAK) {
    throw new Error("The active capture did not hear browser text-to-speech. Share system audio or choose a downloadable audio source.");
  }
  return {
    data: encodeMonoWav(selected.samples, selected.sampleRate),
    candidate,
  };
}
