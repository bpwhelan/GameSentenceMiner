// SPDX-License-Identifier: GPL-3.0-or-later
import { createAudioCache } from "./audio-cache.js";
import { audioSourceUrl, parseAudioSourceList } from "./audio-sources.js";

export async function selectedAudioPlan(repository, sources, term, selection, signal) {
  const source = sources.find(source => source.id === selection.sourceId && JSON.stringify(source) === selection.sourceKey);
  if (!source || selection.expression !== term.expression || selection.reading !== term.reading) {
    throw new Error("This pronunciation selection is no longer current. Choose it again.");
  }
  const candidates = await repository.candidates(source, term, signal);
  const candidate = candidates[selection.index];
  if (!candidate || (candidate.url ?? null) !== selection.url || candidate.name !== selection.name) {
    throw new Error("The provider's pronunciation choices changed. Choose again.");
  }
  return { sources: [source], candidate: { ...candidate, index: selection.index } };
}

export function createAudioRepository({ window, fetch, now = () => performance.now() }) {
  // GSM PR #549's retention budgets, not input or playback size limits.
  const candidates = createAudioCache({ maxEntries: 256, maxBytes: 2 * 1024 * 1024, ttlMs: 5 * 60_000, now });
  const media = createAudioCache({ maxEntries: 64, maxBytes: 64 * 1024 * 1024, ttlMs: 30 * 60_000, now,
    onEvict(entry) { entry.retained = false; releaseUnused(entry); } });
  const encoder = new TextEncoder();

  function releaseUnused(entry) {
    if (!entry.retained && entry.users === 0) window.URL.revokeObjectURL(entry.url);
  }

  async function response(url, signal) {
    const result = await fetch(url, { credentials: "omit", signal });
    if (!result.ok) throw new Error(`Audio provider returned HTTP ${result.status}.`);
    return result;
  }

  return {
    async candidates(source, term, signal) {
      signal.throwIfAborted();
      const key = JSON.stringify([source, term.expression, term.reading]);
      const cached = candidates.get(key);
      if (cached) return cached;
      let found = [];
      if (source.type.startsWith("text-to-speech")) found = [{ name: source.voice || "Automatic Japanese" }];
      else if (source.url) {
        const url = audioSourceUrl(source.url, term);
        if (source.type === "custom") found = [{ url, name: "" }];
        else found = parseAudioSourceList(await (await response(url, signal)).json());
      }
      signal.throwIfAborted();
      candidates.set(key, found, encoder.encode(key).byteLength + encoder.encode(JSON.stringify(found)).byteLength);
      return found;
    },
    async acquire(candidate, signal) {
      signal.throwIfAborted();
      let entry = media.get(candidate.url);
      if (entry) entry.users += 1;
      else {
        const blob = await (await response(candidate.url, signal)).blob();
        signal.throwIfAborted();
        entry = { blob, url: window.URL.createObjectURL(blob), users: 1, retained: false };
        entry.retained = media.set(candidate.url, entry, blob.size + encoder.encode(candidate.url).byteLength);
      }
      return {
        url: entry.url,
        blob: entry.blob,
        release() { entry.users -= 1; releaseUnused(entry); },
        invalidate() { if (media.get(candidate.url) === entry) media.delete(candidate.url); },
      };
    },
    clear() { candidates.clear(); media.clear(); },
  };
}
