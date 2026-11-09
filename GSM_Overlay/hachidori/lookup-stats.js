// Canonical persistent lookup rows, shared by the storage owner and backup validator.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./lookup-stats-identity.js";
export const { normaliseLookupTerm, lookupStatsPrefix, lookupStatsKey } = globalThis.HDLookupStats;
export const LOOKUP_STATS_KEY = "lookupStats";
export const LOOKUP_STATS_ROW_PREFIX = "lookupStats:";

export function emptyLookupStats() {
  return { generation: null, revision: 0 };
}

export function assertLookupStatsDescriptor(descriptor) {
  if (!descriptor || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0
      || (descriptor.generation !== null && (typeof descriptor.generation !== "string" || descriptor.generation === ""))
      || (descriptor.languages !== undefined && !validLanguageGenerations(descriptor.languages))) {
    throw new Error("Invalid lookup statistics descriptor.");
  }
}

// Lookup counts are counted per language (docs/languages.md 4.3). Rows keep
// their key `lookupStats:<generation>:<[term, reading]>`, because the
// generation names the language: the top-level generation is Japanese's, and
// `languages` maps every other counted language to its own.
function validLanguageGenerations(languages) {
  return languages !== null && typeof languages === "object" && !Array.isArray(languages)
    && Object.entries(languages).every(([code, generation]) => /^[a-z]{2,3}$/u.test(code) && code !== "ja"
      && typeof generation === "string" && generation !== "");
}

function lookupStatsGeneration(descriptor, language = "ja") {
  return language === "ja" ? descriptor.generation : descriptor.languages?.[language] ?? null;
}

// The descriptor-shaped view whose generation keys one language's rows.
export function lookupStatsLanguageView(descriptor, language = "ja") {
  return language === "ja" ? descriptor : { generation: lookupStatsGeneration(descriptor, language), revision: descriptor.revision };
}

// One revision up, with `language`'s generation set: Japanese's at the top
// level, another language's entry under `languages`. The rest is kept.
export function withLookupStatsGeneration(descriptor, language, generation) {
  const next = language === "ja"
    ? { ...descriptor, generation, revision: descriptor.revision + 1 }
    : { ...descriptor, revision: descriptor.revision + 1, languages: { ...descriptor.languages, [language]: generation } };
  assertLookupStatsDescriptor(next);
  return next;
}

// One revision up, without `language`'s generation: another language's entry
// is dropped, Japanese's top-level generation is replaced by a fresh one.
export function withoutLookupStatsLanguage(descriptor, language) {
  if (language === "ja") return withLookupStatsGeneration(descriptor, "ja", crypto.randomUUID());
  const languages = { ...descriptor.languages };
  delete languages[language];
  const next = { generation: descriptor.generation, revision: descriptor.revision + 1,
    ...(Object.keys(languages).length > 0 ? { languages } : {}) };
  assertLookupStatsDescriptor(next);
  return next;
}

// The stored keys of rows outside every live generation: the top-level one
// and each `languages` entry's. hd_lookup_stats_cleanup and the unlink cleanup
// share it, so an erased or dropped language's rows never stay reachable.
export function unreachableLookupStatsKeys(storedKeys, descriptor) {
  const live = [lookupStatsPrefix(descriptor),
    ...Object.values(descriptor.languages ?? {}).map(generation => lookupStatsPrefix({ generation }))];
  return storedKeys.filter(key => key.startsWith(LOOKUP_STATS_ROW_PREFIX) && !live.some(prefix => key.startsWith(prefix)));
}

// A reset publishes a new, empty generation one revision above the current
// descriptor. Readers reject older revisions, so the revision never restarts;
// every row of the replaced generation becomes unreachable at this commit.
export function resetLookupStats(descriptor = emptyLookupStats()) {
  assertLookupStatsDescriptor(descriptor);
  const next = { generation: crypto.randomUUID(), revision: descriptor.revision + 1 };
  assertLookupStatsDescriptor(next);
  return next;
}

function assertLookupStatsRow(row) {
  if (!row || typeof row.term !== "string" || row.term.trim() === "" || typeof row.reading !== "string"
      || !Number.isSafeInteger(row.lookupCount) || row.lookupCount < 0
      || !Number.isFinite(row.firstLookedUpAt) || !Number.isFinite(row.lastLookedUpAt)
      || row.firstLookedUpAt > row.lastLookedUpAt) {
    throw new Error("Invalid lookup statistics row.");
  }
  const canonical = normaliseLookupTerm(row.term, row.reading);
  if (row.term !== canonical.term || row.reading !== canonical.reading) {
    throw new Error("The lookup statistics row is not canonical.");
  }
}

export function assertLookupStatsRows(descriptor, rows) {
  assertLookupStatsDescriptor(descriptor);
  if (!Array.isArray(rows) || (descriptor.generation === null && rows.length !== 0)) {
    throw new Error("Invalid lookup statistics collection.");
  }
  const keys = new Set();
  for (const row of rows) {
    assertLookupStatsRow(row);
    const key = lookupStatsKey(descriptor, row);
    if (keys.has(key)) throw new Error("Duplicate lookup statistics rows.");
    keys.add(key);
  }
}

export function incrementLookupStats(previous, term, now) {
  if (previous !== undefined) {
    assertLookupStatsRow(previous);
    if (previous.term !== term.term || previous.reading !== term.reading) {
      throw new Error("The lookup statistics row does not match its key.");
    }
  }
  const row = { ...term, lookupCount: (previous?.lookupCount ?? 0) + 1,
    firstLookedUpAt: Math.min(previous?.firstLookedUpAt ?? now, now),
    lastLookedUpAt: Math.max(previous?.lastLookedUpAt ?? now, now) };
  // Safe integers are the persisted JSON representation, not a product cap.
  assertLookupStatsRow(row);
  return row;
}
