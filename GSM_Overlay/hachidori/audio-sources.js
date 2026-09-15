// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-native source rules adapted from GSM PR #549's hoshidicts_audio.py
// and hoshidicts_audio_profile.py. Configuration remains global reader options.

function httpUrl(value) {
  if (typeof value !== "string" || /[\u0000-\u001f]/u.test(value)) {
    throw new Error("Audio URLs must be absolute HTTP(S) URLs.");
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port === "0") {
    throw new Error("Audio URLs must use HTTP(S) without a username or password.");
  }
  if (/[{}]/u.test(url.host)) throw new Error("Audio URL placeholders cannot appear in the host.");
  return url.href;
}

function encodeValue(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, char => `%${char.codePointAt(0).toString(16).toUpperCase()}`);
}

export function audioSourceUrl(template, { expression, reading }) {
  httpUrl(template);
  const encodedTerm = encodeValue(expression);
  const values = { term: encodedTerm, expression: encodedTerm, reading: encodeValue(reading), language: "ja" };
  return httpUrl(template.replace(/\{([^{}]*)\}/gu, (match, key) => Object.hasOwn(values, key) ? values[key] : match));
}

export function parseAudioSourceList(value) {
  if (value?.type !== "audioSourceList" || !Array.isArray(value.audioSources)
      || Object.keys(value).some(key => !["type", "audioSources"].includes(key))) {
    throw new Error("The audio provider returned an invalid Yomitan audioSourceList.");
  }
  return value.audioSources.map(candidate => {
    if (!candidate || typeof candidate.url !== "string" || (candidate.name !== undefined && typeof candidate.name !== "string")
        || Object.keys(candidate).some(key => !["url", "name"].includes(key))) {
      throw new Error("The audio provider returned an invalid pronunciation candidate.");
    }
    return { url: httpUrl(candidate.url), name: candidate.name ?? "" };
  });
}
