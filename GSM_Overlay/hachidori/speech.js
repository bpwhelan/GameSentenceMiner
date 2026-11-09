// SPDX-License-Identifier: GPL-3.0-or-later

// Chrome may return an empty list until its first voiceschanged event. Keep
// this wait inside the caller's existing deadline and cancellation.
function waitForSpeechVoices(speech, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    function clean() {
      speech.removeEventListener("voiceschanged", changed);
      signal.removeEventListener("abort", aborted);
    }
    function changed() { clean(); resolve(speech.getVoices()); }
    function aborted() { clean(); reject(signal.reason); }
    speech.addEventListener("voiceschanged", changed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    // The voice service can finish loading between the initial query and the
    // listener registration; checking again avoids missing that transition.
    if (speech.getVoices().length) changed();
  });
}

// A BCP 47 tag's primary language subtag, lower-cased.
export function primaryLanguage(tag) {
  return String(tag ?? "").split(/[-_]/u)[0].toLowerCase();
}

// `language` is the profile's pronunciation language (audio-sources.js
// pronunciationLanguage): its pack's `host.ttsLanguage` speaks and chooses the
// automatic voice (docs/languages.md 13). Without one, Japanese as today.
export async function resolveSpeech(window, source, term, signal, language = null) {
  const speech = window.speechSynthesis;
  let voices = speech.getVoices();
  if (!voices.length) voices = await waitForSpeechVoices(speech, signal);
  signal.throwIfAborted();
  if (voices.length === 0) throw new Error("No speech voices are available in this browser.");
  const text = source.type === "text-to-speech-reading" ? term.reading || term.expression : term.expression;
  const utterance = new window.SpeechSynthesisUtterance(text);
  const tag = language?.speech ?? "ja-JP";
  utterance.lang = tag;
  const primary = primaryLanguage(tag);
  const matching = voices.filter(voice => primaryLanguage(voice.lang) === primary);
  const voice = source.voice
    ? voices.find(value => value.voiceURI === source.voice || value.name === source.voice)
    : matching.find(value => /^Google\b/i.test(value.name))
      || matching.find(value => value.default) || matching[0];
  if (source.voice && !voice) {
    throw new Error("The selected speech voice is no longer available. Choose another voice in Audio Settings.");
  }
  if (!voice) {
    throw new Error(language === null || language.code === "ja"
      ? "No Japanese speech voice is available. Install a Japanese voice or add an audio provider in Audio Settings."
      : `No ${language.name} speech voice is available. Install a voice for ${language.name} or add an audio provider in Audio Settings.`);
  }
  utterance.voice = voice;
  return {
    speech,
    utterance,
    candidate: { name: voice.name, text, voice: source.voice, index: 0 },
  };
}
