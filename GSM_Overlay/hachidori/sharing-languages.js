/*
 * What a sharing host whose records have profiles sends each linked browser
 * (docs/languages.md 17.3-17.6, decision 0009): a browser that opted in gets
 * the records as stored; every other browser, older ones included, gets their
 * Japanese view in its hello, change frames and replies, and its requests are
 * read as requests that name no profile. The service worker's sharing code
 * applies these rules through the host's language hooks (sharing-host.js).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./reader-options.js";
import { heldLanguages, plainObject } from "./profile-state.js";
import { japaneseLookupRow, japaneseRecord, withoutLanguages } from "./japanese-view.js";
import { LOOKUP_STATS_KEY, LOOKUP_STATS_ROW_PREFIX } from "./lookup-stats.js";

const JAPANESE = "ja";
export const LANGUAGE_CODE = /^[a-z]{2,3}$/u;

export const PROFILE_REQUEST_TYPES = new Set(["hd_profile_add", "hd_profile_remove"]);
// Requests whose replies carry options, dictionary state or a personal
// document (17.3 item 4).
export const RECORD_REPLY_TYPES = new Set([
  "hd_options_write", "hd_state_read", "hd_state_cas", "hd_custom_read", "hd_custom_cas",
  "hd_custom_save", "hd_custom_append", "hd_apply_state", "hd_remove",
]);
export const CHANGING_LANGUAGES = "The linked Hachidori is changing its languages. Try again.";
export const PROFILES_NOT_SHARED = "Update Hachidori in this browser to change the linked Hachidori's languages.";

// The shared records' storage keys and the slots of heldLanguages.
const HELD_SLOTS = {
  options: "options", dictionaryState: "state", customDictionarySource: "document",
  [LOOKUP_STATS_KEY]: "lookupStats", wordStatusOverrides: "wordStatusOverrides",
};


// This build's pack codes; Japanese is built in.
export function packCodes() {
  const codes = Array.isArray(globalThis.HDLanguages?.codes) ? globalThis.HDLanguages.codes : [];
  return [...new Set([JAPANESE, ...codes.filter(code => typeof code === "string" && LANGUAGE_CODE.test(code))])];
}

export function hasLanguagePack(code) {
  return code === JAPANESE || (globalThis.HDLanguages?.get?.(code) ?? null) !== null;
}

// The pack codes an opt-in names, or null when it names none that can be read.
export function optInLanguages(message) {
  const codes = message?.languages;
  if (!Array.isArray(codes) || codes.some(code => typeof code !== "string" || !LANGUAGE_CODE.test(code))) return null;
  return new Set([JAPANESE, ...codes]);
}

// The languages one stored record holds (section 2), by its storage key.
// Japanese, which every build has, is left out.
export function recordLanguages(key, value) {
  const slot = HELD_SLOTS[key];
  if (slot === undefined || value === null || value === undefined) return new Set();
  const held = slot === "options"
    ? new Set(globalThis.HDReaderOptions.profiles(value).map(profile => profile.language))
    : heldLanguages({ [slot]: value });
  held.delete(JAPANESE);
  return held;
}

// Every language the shared records hold.
export function snapshotLanguages(snapshot) {
  const held = new Set();
  for (const key of Object.keys(HELD_SLOTS)) for (const code of recordLanguages(key, snapshot[key])) held.add(code);
  return held;
}

export function missingLanguages(held, packs) {
  return [...held].filter(code => code !== JAPANESE && !packs.has(code)).sort((a, b) => a.localeCompare(b));
}

/**
 * A change frame's changes, `{ key: value or null }`, as a browser that has not
 * opted in receives them: each record's Japanese view, and only the lookup
 * rows of Japanese's generation (removals of any row pass, as they remove
 * nothing such a browser holds). Null when nothing is left.
 */
export function japaneseChanges(changes, descriptor) {
  const result = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key.startsWith(LOOKUP_STATS_ROW_PREFIX)) {
      if (value === null || japaneseLookupRow(key, descriptor)) result[key] = value;
    } else {
      result[key] = japaneseRecord(key, value);
    }
  }
  return Object.keys(result).length === 0 ? null : result;
}

export { japaneseView } from "./japanese-view.js";

// A reply as a browser that has not opted in receives it (17.3 item 4).
export function japaneseReply(type, response) {
  if (!RECORD_REPLY_TYPES.has(type) || plainObject(response) === null) return response;
  const next = { ...response };
  if (Object.hasOwn(next, "options")) next.options = japaneseRecord("options", next.options);
  if (Object.hasOwn(next, "state")) next.state = japaneseRecord("dictionaryState", next.state);
  if (Object.hasOwn(next, "document")) next.document = withoutLanguages(next.document);
  // Today's hd_state_read reply has no language codes.
  if (type === "hd_state_read") delete next.languages;
  return next;
}

// A request from a browser that has not opted in names no profile (17.4).
export function withoutProfile(message) {
  if (plainObject(message) === null || !Object.hasOwn(message, "profileId")) return message;
  const { profileId, ...rest } = message;
  return rest;
}

/**
 * The languages a host follows to decide, at each commit, which connections
 * must reconnect (17.3 item 6): the languages each shared record holds and the
 * count descriptor, kept from the storage events in commit order after a
 * first read of the shared records.
 */
export function createLanguageTracker() {
  let known = false;
  let descriptor = null;
  const held = new Map();

  function record(key, value) {
    if (key === LOOKUP_STATS_KEY) descriptor = value ?? null;
    if (Object.hasOwn(HELD_SLOTS, key)) held.set(key, recordLanguages(key, value));
  }

  return {
    get known() { return known; },
    get descriptor() { return descriptor; },
    // A read of the shared records, before any event that follows it.
    read(snapshot) {
      if (known) return;
      known = true;
      for (const [key, value] of Object.entries(snapshot)) record(key, value);
    },
    // One storage event's changes, `{ key: { oldValue, newValue } }`: the
    // languages the changed records hold.
    observe(changes) {
      const carried = new Set();
      for (const [key, change] of Object.entries(changes)) {
        for (const code of recordLanguages(key, change.newValue)) carried.add(code);
        if (known) record(key, change.newValue ?? null);
      }
      return { carried };
    },
    held() {
      const all = new Set();
      for (const codes of held.values()) for (const code of codes) all.add(code);
      return all;
    },
  };
}
