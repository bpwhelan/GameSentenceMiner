// SPDX-License-Identifier: GPL-3.0-or-later
import { selectedAudioPlan } from "./audio-repository.js";
import { ankiMediaFilename } from "./anki-resources.js";

const MIME_EXTENSIONS = { "audio/aac": "aac", "audio/flac": "flac", "audio/mp4": "m4a", "audio/mpeg": "mp3",
  "audio/ogg": "ogg", "audio/wav": "wav", "audio/webm": "webm", "audio/x-wav": "wav", "application/ogg": "ogg" };

async function base64(window, blob, signal) {
  signal.throwIfAborted();
  const reader = new window.FileReader();
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      reader.onerror = () => reject(reader.error);
      abort = () => { reader.abort(); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      reader.readAsDataURL(blob);
    });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.onload = reader.onerror = null;
  }
}

async function candidateFile(window, repository, candidate, signal) {
  const lease = await repository.acquire(candidate, signal);
  let audio, abort;
  try {
    signal.throwIfAborted();
    audio = new window.Audio();
    audio.preload = "auto";
    await new Promise((resolve, reject) => {
      audio.onloadeddata = resolve;
      audio.onerror = () => { lease.invalidate(); reject(new Error("The pronunciation could not be decoded.")); };
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      audio.src = lease.url;
      audio.load();
    });
    signal.throwIfAborted();
    const suffix = new URL(candidate.url).pathname.split(".").at(-1).toLowerCase();
    const mime = lease.blob.type.split(";")[0].toLowerCase();
    const fallbackExtension = /^[a-z0-9]+$/u.test(suffix) ? suffix : "bin";
    const extension = Object.hasOwn(MIME_EXTENSIONS, mime) ? MIME_EXTENSIONS[mime] : fallbackExtension;
    const bytes = await lease.blob.arrayBuffer();
    signal.throwIfAborted();
    const filename = await ankiMediaFilename(bytes, extension);
    const data = await base64(window, lease.blob, signal);
    signal.throwIfAborted();
    return { filename, data, candidate };
  } finally {
    if (audio) {
      signal.removeEventListener("abort", abort);
      audio.onloadeddata = audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    lease.release();
  }
}

async function speechFile(window, recording, signal) {
  signal.throwIfAborted();
  if (!(recording?.data instanceof Uint8Array) || recording.data.length === 0) {
    throw new Error("Browser text-to-speech produced no captured WAV data.");
  }
  const filename = await ankiMediaFilename(recording.data, "wav");
  if (recording.filename !== undefined && recording.filename !== filename) {
    throw new Error("The linked browser-speech filename does not match its WAV data.");
  }
  const data = await base64(window, new Blob([recording.data], { type: "audio/wav" }), signal);
  signal.throwIfAborted();
  return { filename, data, candidate: recording.candidate };
}

// Read-only discovery/decoding, separate from the playback owner. The returned
// exact bytes and digest stay paired through duplicate check and later upload.
export async function exportAnkiAudio(window, repository, {
  sources,
  term,
  selection,
  recordSpeech = true,
}, signal, { recordSpeechAudio } = {}) {
  const plan = selection ? await selectedAudioPlan(repository, sources, term, selection, signal) : { sources };
  let failure;
  for (const source of plan.sources) {
    if (source.type.startsWith("text-to-speech")) {
      try {
        if (typeof recordSpeechAudio !== "function") {
          throw new Error("Browser text-to-speech recording is unavailable.");
        }
        const recorded = await recordSpeechAudio(source, term, signal, { record: recordSpeech });
        if (recorded?.recordingRequired === true) return recorded;
        return { ...await speechFile(window, recorded, signal), sourceId: source.id };
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
      }
      continue;
    }
    try {
      const candidates = plan.candidate ? [plan.candidate] : await repository.candidates(source, term, signal);
      for (const [index, candidate] of candidates.entries()) {
        try {
          return { ...await candidateFile(window, repository, { ...candidate, index: candidate.index ?? index }, signal), sourceId: source.id };
        } catch (error) { signal.throwIfAborted(); failure = error; }
      }
    } catch (error) { signal.throwIfAborted(); failure = error; }
  }
  throw failure ?? new Error("No downloadable pronunciation is available for this result.");
}
