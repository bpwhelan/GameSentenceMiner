// SPDX-License-Identifier: GPL-3.0-or-later

export const LOCAL_AUDIO_SOURCE_URL = "http://127.0.0.1:5050/?term={term}&reading={reading}";

export function findLocalAudioSource(sources) {
  return sources.find(source => source.type === "custom-json" && source.url === LOCAL_AUDIO_SOURCE_URL) ?? null;
}

export function createLocalAudioSource(id, url = LOCAL_AUDIO_SOURCE_URL) {
  return { id, type: "custom-json", enabled: true, url, voice: "" };
}
