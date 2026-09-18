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

export async function resolveSpeech(window, source, term, signal) {
  const speech = window.speechSynthesis;
  let voices = speech.getVoices();
  if (!voices.length) voices = await waitForSpeechVoices(speech, signal);
  signal.throwIfAborted();
  if (voices.length === 0) throw new Error("No speech voices are available in this browser.");
  const text = source.type === "text-to-speech-reading" ? term.reading || term.expression : term.expression;
  const utterance = new window.SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  const japanese = voices.filter(voice => /^ja(?:[-_]|$)/i.test(voice.lang));
  const voice = source.voice
    ? voices.find(value => value.voiceURI === source.voice || value.name === source.voice)
    : japanese.find(value => /^Google\b/i.test(value.name))
      || japanese.find(value => value.default) || japanese[0];
  if (source.voice && !voice) {
    throw new Error("The selected speech voice is no longer available. Choose another voice in Audio Settings.");
  }
  if (!voice) {
    throw new Error("No Japanese speech voice is available. Install a Japanese voice or add an audio provider in Audio Settings.");
  }
  utterance.voice = voice;
  return {
    speech,
    utterance,
    voice,
    candidate: { name: voice.name, text, voice: source.voice, index: 0 },
  };
}
