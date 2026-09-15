// SPDX-License-Identifier: GPL-3.0-or-later
import { createAudioPlayer } from "./audio-player.js";
import { createAudioRepository, selectedAudioPlan } from "./audio-repository.js";

const TEST_TERM = { expression: "聞く", reading: "きく" };
// Matches the reference Settings Test deadline; ordinary dictionary work never
// waits on this timer or the pronunciation's network/audio callbacks.
const TEST_TIMEOUT_MS = 15_000;
const FALLBACK_TIMEOUT_MS = 12_000;

export function createAudioService(window, repository = createAudioRepository({ window, fetch: window.fetch.bind(window), now: () => window.performance.now() })) {
  const player = createAudioPlayer({ window, repository });
  let active = null;
  let watchingVoices = false;

  function stop(reason = new DOMException("Playback stopped.", "AbortError")) {
    active?.controller.abort(reason);
    player.stop(reason);
  }
  window.addEventListener("pagehide", () => { stop(); player.dispose(); }, { once: true });

  function voices() {
    if (!watchingVoices) {
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        window.chrome.runtime.sendMessage({ target: "hachidori-audio-ui", type: "hd_audio_voices_changed", voices: voices() })
          .catch(() => {}); // The Settings page may already have closed.
      });
      watchingVoices = true;
    }
    return window.speechSynthesis.getVoices().map(({ voiceURI, name, lang, localService, default: isDefault }) =>
      ({ voiceURI, name, lang, localService, default: isDefault }));
  }

  async function candidateGroups(sources, term, signal) {
    const groups = [];
    for (const source of sources) {
      const group = { sourceId: source.id, sourceKey: JSON.stringify(source), type: source.type };
      try {
        group.candidates = await repository.candidates(source, term, signal);
      } catch (error) {
        signal.throwIfAborted();
        group.error = error.message;
      }
      groups.push(group);
    }
    signal.throwIfAborted();
    return { groups };
  }

  return async message => {
    if (message.type === "hd_audio_voices") return { voices: voices() };
    if (message.type === "hd_audio_stop") {
      if (active && active.owner === message.owner && active.requestId === message.playRequestId) stop();
      return { status: "cancelled" };
    }
    if (!["hd_audio_test", "hd_audio_play", "hd_audio_candidates"].includes(message.type)) throw new Error("Unknown audio request.");
    stop();
    const operation = { owner: message.owner, requestId: message.requestId, controller: new AbortController() };
    active = operation;
    const isTest = message.type === "hd_audio_test";
    let remaining = isTest ? TEST_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;
    let timer = null, armedAt;
    function resumeDeadline() {
      if (timer !== null) return;
      armedAt = window.performance.now();
      timer = window.setTimeout(() => {
        if (active === operation) stop(new Error(isTest ? "Audio Test timed out after 15 seconds." : "Pronunciation discovery timed out after 12 seconds."));
      }, remaining);
    }
    function pauseDeadline() {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (window.performance.now() - armedAt));
    }
    resumeDeadline();
    try {
      if (isTest) return await player.play(message.source, TEST_TERM);
      const { signal } = operation.controller;
      if (message.type === "hd_audio_candidates") return await candidateGroups(message.sources, message.term, signal);
      const plan = message.selection
        ? await selectedAudioPlan(repository, message.sources, message.term, message.selection, signal) : { sources: message.sources };
      signal.throwIfAborted();
      return await player.playSources(plan.sources, message.term, { candidate: plan.candidate,
        onResolving: resumeDeadline,
        onPlaying(value) {
          if (active !== operation) return;
          // This bounds discovery/fallback, not the duration of a playable file.
          pauseDeadline();
          window.chrome.runtime.sendMessage({ target: "hachidori-audio-events", type: "hd_audio_playing",
            owner: operation.owner, requestId: operation.requestId, ...value }).catch(() => {});
        },
      });
    } catch (error) {
      if (operation.controller.signal.aborted && error?.name === "AbortError") return { status: "cancelled" };
      throw error;
    }
    finally {
      window.clearTimeout(timer);
      if (active === operation) active = null;
    }
  };
}
