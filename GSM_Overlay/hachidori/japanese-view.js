/*
 * The Japanese view (docs/languages.md 17.1): the Japanese-only picture of an
 * installation whose records have profiles, built from the Japanese data
 * whether or not a Japanese profile exists. Backups carry it as their version
 * 3 snapshot, linked browsers that have not opted in to profiles receive it,
 * and the Relay dictionary download reads it. Records without profiles are
 * their own view, value for value.
 *
 *   options                the Japanese profile flattened with the global
 *                          keys, or the global keys alone (which read over
 *                          Japanese defaults) when there is no Japanese profile;
 *   dictionaryState        schema 1: the Japanese personal package first and
 *                          enabled, the Japanese profile's list, every other
 *                          package disabled except other languages' personal
 *                          packages (profile-state.js japaneseDictionaryView);
 *   customDictionarySource the Japanese document, without `languages`;
 *   lookupStats            the descriptor without `languages`;
 *   wordStatusOverrides    the Japanese marks, without `languages`;
 *   lookup rows            those of the top-level generation.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./reader-options.js";
import { japaneseDictionaryView } from "./profile-state.js";
import { lookupStatsPrefix } from "./lookup-stats.js";

function revisionOf(record) {
  const revision = record?.revision;
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

// A record's own part, without the other languages' entries.
export function withoutLanguages(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, "languages")) return record;
  const { languages, ...japanese } = record;
  return japanese;
}

function japaneseOptions(options) {
  const { hasProfiles, projectStoredOptions } = globalThis.HDReaderOptions;
  return hasProfiles(options) ? { ...projectStoredOptions(options), revision: revisionOf(options) } : options;
}

// Each shared record's view, by storage key; dictionaryUpdates is global.
const VIEWS = {
  options: japaneseOptions,
  dictionaryState: japaneseDictionaryView,
  customDictionarySource: withoutLanguages,
  lookupStats: withoutLanguages,
  wordStatusOverrides: withoutLanguages,
};

// The view of one stored record; null and absent records stay so.
export function japaneseRecord(key, value) {
  return value === null || value === undefined || !Object.hasOwn(VIEWS, key) ? value : VIEWS[key](value);
}

/**
 * The Japanese view of the shared records, keyed by storage key as
 * readSharedState gives them, in the same order. Records without profiles
 * come back as they are.
 */
export function japaneseView(records) {
  return Object.fromEntries(Object.entries(records).map(([key, value]) => [key, japaneseRecord(key, value)]));
}

// Whether a stored lookup row belongs to the view: the rows of the
// descriptor's top-level generation, which is Japanese's (section 4.3).
export function japaneseLookupRow(key, descriptor) {
  return descriptor?.generation !== null && descriptor?.generation !== undefined
    && key.startsWith(lookupStatsPrefix(descriptor));
}
