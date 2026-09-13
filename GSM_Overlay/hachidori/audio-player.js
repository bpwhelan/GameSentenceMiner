// SPDX-License-Identifier: GPL-3.0-or-later
import { createAudioRepository } from "./audio-repository.js";
import { resolveSpeech } from "./speech.js";

// One pronunciation owner; playback leases and native speech callbacks belong
// to that operation. The shared offscreen repository owns warm media, not WASM.
export function createAudioPlayer({ window, fetch, repository = createAudioRepository({ window, fetch }) }) {
  let current = null;

  function stop(reason = new DOMException("Playback stopped.", "AbortError")) {
    current?.abort(reason);
    current = null;
  }

  async function playUrl(candidate, signal, onPlaying) {
    const lease = await repository.acquire(candidate, signal);
    let audio;
    let abort;
    try {
      signal.throwIfAborted();
      audio = new window.Audio(lease.url);
      const ended = new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onplaying = () => { if (!signal.aborted) onPlaying?.(candidate); };
        audio.onerror = () => {
          lease.invalidate();
          reject(new Error("The pronunciation could not be decoded or played."));
        };
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      await Promise.all([Promise.resolve().then(() => audio.play()), ended]);
    } finally {
      if (audio) {
        signal.removeEventListener("abort", abort);
        audio.onended = audio.onerror = audio.onplaying = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      lease.release();
    }
  }

  async function playSpeech(source, term, signal, onPlaying) {
    const { speech, utterance, candidate } = await resolveSpeech(window, source, term, signal);
    signal.throwIfAborted();
    let abort;
    try {
      await new Promise((resolve, reject) => {
        utterance.onend = resolve;
        utterance.onstart = () => { if (!signal.aborted) onPlaying?.(candidate); };
        utterance.onerror = event => {
          const detail = event.error ? ` (${event.error})` : "";
          reject(new Error(`Text-to-speech could not be played${detail}.`));
        };
        abort = () => {
          // Cancel synchronously, before a newer operation can speak. A late
          // finally calling global speech.cancel() would stop that new voice.
          utterance.onend = utterance.onerror = utterance.onstart = null;
          speech.cancel();
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        speech.speak(utterance);
      });
      return candidate;
    } finally {
      signal.removeEventListener("abort", abort);
      utterance.onend = utterance.onerror = utterance.onstart = null;
    }
  }

  async function firstPlayable(found, signal, onPlaying, onResolving) {
    let failure;
    for (const [index, entry] of found.entries()) {
      try {
        onResolving?.();
        const candidate = { ...entry, index: entry.index ?? index };
        await playUrl(candidate, signal, onPlaying);
        return candidate;
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
      }
    }
    throw failure;
  }

  async function playSources(sources, term, { onPlaying, onResolving, candidate: selectedCandidate } = {}) {
    stop();
    const controller = new AbortController();
    current = controller;
    const { signal } = controller;
    try {
      let failure;
      for (const source of sources) {
        try {
          onResolving?.();
          const playing = candidate => onPlaying?.({ sourceId: source.id, candidate });
          const candidate = await playSource(source, term, signal, playing, onResolving, selectedCandidate);
          signal.throwIfAborted();
          if (candidate) return { status: "success", sourceId: source.id, candidate };
        } catch (error) {
          signal.throwIfAborted();
          failure = error;
        }
      }
      if (failure) throw failure;
      return { status: "no-result" };
    } catch (error) {
      if (signal.aborted && signal.reason?.name === "AbortError") return { status: "cancelled" };
      throw signal.aborted ? signal.reason : error;
    } finally {
      if (current === controller) current = null;
    }
  }

  async function playSource(source, term, signal, onPlaying, onResolving, selectedCandidate) {
    if (source.type.startsWith("text-to-speech")) return playSpeech(source, term, signal, onPlaying);
    const found = selectedCandidate ? [selectedCandidate] : await repository.candidates(source, term, signal);
    signal.throwIfAborted();
    return found.length ? firstPlayable(found, signal, onPlaying, onResolving) : null;
  }

  return {
    stop, playSources,
    play: (source, term) => playSources([source], term),
    dispose() { stop(); repository.clear(); },
  };
}
