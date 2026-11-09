/*
 * Records with profiles, for the service worker, the engine service, backups
 * and sharing (docs/languages.md, sections 2, 4, 5.2 and 17.1): the conversion
 * between the single-profile shape and records with profiles, the merge of one
 * profile's schema-1 dictionary view or of the engine's package list into a
 * schema-2 state, the Japanese view older code reads, and the held languages.
 * Content scripts never need these, so they stay out of reader-options.js.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./reader-options.js";
import { CUSTOM_DICTIONARY_ID, personalDictionaryLanguage } from "./custom-dictionary.js";

const {
  JAPANESE_PROFILE_ID, GLOBAL_OPTION_KEYS, hasProfiles, hasDictionaryProfiles, profiles, projectStoredOptions,
  projectDictionaryState, packageWithEnabled,
} = globalThis.HDReaderOptions;

export const DICTIONARY_STATE_PROFILES_SCHEMA = 2;

export function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function revisionOf(record) {
  const revision = plainObject(record)?.revision;
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

// A package row as schema 2 stores it: everything but `enabled`.
export function packageRow(row) {
  const { enabled, ...rest } = row;
  return rest;
}

// A personal package is known by its fixed id (docs/languages.md 15).
export function isPersonalPackage(row) {
  return personalDictionaryLanguage(row) !== null;
}

// Profile id → language. Version 1 allows one profile per language.
export function profileLanguages(storedOptions) {
  return new Map(profiles(storedOptions).map(profile => [profile.id, profile.language]));
}

/**
 * The options record with profiles that a single-profile record becomes when
 * a second profile is added (section 4.5): its profile keys move into the
 * profile `ja`, `anki` is split, every value is kept. The revision is kept;
 * the writer moves it.
 */
export function optionsWithProfiles(storedOptions) {
  if (hasProfiles(storedOptions)) return storedOptions;
  const flat = projectStoredOptions(storedOptions);
  const top = Object.fromEntries(GLOBAL_OPTION_KEYS.filter(key => Object.hasOwn(flat, key)).map(key => [key, flat[key]]));
  if (flat.anki !== undefined) top.anki = { url: flat.anki.url, apiKey: flat.anki.apiKey };
  return { revision: revisionOf(storedOptions), ...top, profiles: profiles(storedOptions) };
}

// The single-profile record a record with only the Japanese profile returns to.
export function optionsWithoutProfiles(record) {
  if (!hasProfiles(record)) return record;
  return { ...projectStoredOptions(record), revision: revisionOf(record) };
}

/**
 * A flat patch laid over every profile of a record with profiles: global
 * keys at the top level, profile keys in each profile. The overlay keeps its
 * local keys this way, one value per overlay over whichever profile a lookup
 * uses (section 17.5). The revision is kept.
 */
export function applyToEveryProfile(record, patch) {
  const { applyOptionsPatch } = globalThis.HDReaderOptions;
  let next = applyOptionsPatch(record, Object.fromEntries(Object.entries(patch)
    .filter(([key]) => GLOBAL_OPTION_KEYS.includes(key))));
  for (const profile of profiles(next)) next = applyOptionsPatch(next, patch, profile.id);
  return next;
}

// Selections that name dictionaries of the profile they belong to (section 14).
const DICTIONARY_SELECTION_KEYS = ["frequencyDictionary", "kanjiClickDictionary", "compactDefinitionSummaryDictionary",
  "pitchAccentFuriganaDictionary", "definitionBlurFrequencyDictionary", "popupImageSource"];

/**
 * A new profile's settings (section 6.3): a copy of another profile's, with
 * the language-bound ones replaced. Dictionary selections are unset; the
 * Templates keep their note types and field mappings under new ids and with
 * an empty deck; audio is one browser speech source in the pack's language;
 * there are no custom buttons.
 */
export function newProfileSettings(source, descriptor, newId = () => crypto.randomUUID()) {
  // A JSON copy keeps exactly what storage keeps of the settings, and runs in
  // every context that reads this module, the worker's sandboxes included.
  const settings = JSON.parse(JSON.stringify(source ?? {})); // NOSONAR: a JSON copy is the stored form
  for (const key of DICTIONARY_SELECTION_KEYS) delete settings[key];
  const { normaliseAnki } = globalThis.HDReaderOptions;
  settings.anki = { templates: normaliseAnki({ templates: settings.anki?.templates }).templates
    .map(template => ({ ...template, id: newId(), deck: "" })) };
  settings.audioSources = [{ id: "default-tts",
    type: descriptor?.capabilities?.readings === "none" ? "text-to-speech" : "text-to-speech-reading",
    enabled: true, url: "", voice: "" }];
  settings.customButtons = [];
  settings.customLinks = [];
  return settings;
}

// The pack's own settings at their defaults (section 7.5).
export function packSettingDefaults(descriptor) {
  return Object.fromEntries((Array.isArray(descriptor?.settings) ? descriptor.settings : [])
    .filter(setting => typeof setting?.id === "string").map(setting => [setting.id, setting.default]));
}

/**
 * The schema-2 state a schema-1 state becomes (section 4.5): the dictionary
 * array becomes the package list in the same order plus `profiles.ja` with
 * the same order, `enabled` flags and groups.
 */
export function dictionaryStateWithProfiles(state) {
  if (hasDictionaryProfiles(state)) return state;
  const rows = Array.isArray(state?.dictionaries) ? state.dictionaries.filter(row => plainObject(row) !== null) : [];
  return {
    schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA,
    revision: Number.isInteger(state?.revision) && state.revision >= 0 ? state.revision : 0,
    dictionaries: rows.map(packageRow),
    profiles: {
      [JAPANESE_PROFILE_ID]: {
        dictionaries: rows.map(row => ({ id: row.id, enabled: row.enabled !== false })),
        groups: Array.isArray(state?.groups) ? state.groups : [],
      },
    },
  };
}

/**
 * The Japanese view of a schema-2 state (section 17.1), valid for code that
 * predates profiles: the Japanese personal package first and enabled when it
 * exists, the Japanese profile's list in its order with its flags, every other
 * package disabled except other languages' personal packages, the Japanese
 * groups. A schema-1 state is its own Japanese view.
 */
export function japaneseDictionaryView(state) {
  if (!hasDictionaryProfiles(state)) return state;
  const rows = (Array.isArray(state.dictionaries) ? state.dictionaries : []).filter(row => plainObject(row) !== null);
  const japanese = projectDictionaryState(state, JAPANESE_PROFILE_ID);
  const dictionaries = [];
  const personal = rows.find(row => row.id === CUSTOM_DICTIONARY_ID);
  if (personal !== undefined) dictionaries.push(packageWithEnabled(personal, true));
  for (const row of japanese?.dictionaries ?? []) {
    if (row.id !== CUSTOM_DICTIONARY_ID) dictionaries.push(row);
  }
  const listed = new Set(dictionaries.map(row => row.id));
  for (const row of rows) {
    if (!listed.has(row.id) && !isPersonalPackage(row)) dictionaries.push(packageWithEnabled(row, false));
  }
  return { schemaVersion: 1, revision: state.revision, dictionaries: dictionaries.map(singleProfileRow), groups: japanese?.groups ?? [] };
}

// The Japanese view is today's shape, so its rows leave out what only the
// rows of records with profiles carry: `targetLanguage` (section 4.2).
export function singleProfileRow(row) {
  if (!Object.hasOwn(row, "targetLanguage")) return row;
  const result = { ...row };
  delete result.targetLanguage;
  return result;
}

// The schema-1 state a schema-2 state with only Japanese held returns to.
export function dictionaryStateWithoutProfiles(state) {
  return japaneseDictionaryView(state);
}

/**
 * One profile's schema-1 view merged into the whole state (section 5.2): that
 * profile's list and groups, and the package-wide fields of the packages the
 * view lists; other profiles are left alone. A package the view no longer
 * lists leaves the profile and stays in the library. With `legacy`, the view
 * comes from code that predates profiles and lists every package: the
 * profile keeps its own packages in the view's order with the view's flags
 * and gains another only if the view enables it. The revision is the state's.
 */
// `targetLanguage` comes from the package's index (section 4.2): a view
// written by code that does not carry it, such as an older linked browser's
// Japanese view, keeps the stored one.
function withStoredTargetLanguage(row, stored) {
  if (Object.hasOwn(row, "targetLanguage") || stored?.targetLanguage === undefined) return row;
  return { ...row, targetLanguage: stored.targetLanguage };
}

export function mergeDictionaryView(state, profileId, view, { legacy = false } = {}) {
  const rows = (Array.isArray(view?.dictionaries) ? view.dictionaries : []).filter(row => plainObject(row) !== null);
  const current = plainObject(state.profiles?.[profileId]) ?? { dictionaries: [], groups: [] };
  const own = new Set((current.dictionaries ?? []).map(entry => entry?.id));
  const packages = new Map(state.dictionaries.map(row => [row.id, row]));
  if (rows.some(row => !packages.has(row.id))) {
    throw new Error("the dictionary state write lists a dictionary that is not installed");
  }
  const listed = legacy ? rows.filter(row => own.has(row.id) || row.enabled !== false) : rows;
  for (const row of rows) packages.set(row.id, withStoredTargetLanguage(packageRow(row), packages.get(row.id)));
  return {
    schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA,
    revision: state.revision,
    dictionaries: state.dictionaries.map(row => packages.get(row.id)),
    profiles: {
      ...state.profiles,
      [profileId]: {
        dictionaries: listed.map(row => ({ id: row.id, enabled: row.enabled !== false })),
        groups: Array.isArray(view?.groups) ? view.groups : current.groups ?? [],
      },
    },
  };
}

/**
 * The engine's next package list (every package once, `enabled` meaning
 * "enabled in any profile", as allPackages gives it) merged into a schema-2
 * state (section 5.2): the package list takes the engine's rows and order;
 * each profile keeps its own order and flags for the packages that remain; a
 * new package joins `profileId`, last, with the engine row's flag; a personal
 * package is first and enabled in every profile of its language and in no
 * other. Groups lose removed packages. The revision is the state's.
 */
// `joins` names installed packages that join `profileId` when its list lacks
// them: an import requested for that profile replaced them (design 14).
export function mergeEngineDictionaries(state, packages, { profileId = JAPANESE_PROFILE_ID, joins = [] } = {}) {
  const previous = new Set(state.dictionaries.map(row => row.id));
  const present = new Set(packages.map(row => row.id));
  assertJoinedProfile(state, packages, previous, profileId);
  const context = { packages, previous, present, joins, profileId };
  const result = {};
  for (const [id, profile] of Object.entries(state.profiles)) {
    const list = mergedProfileList(profile, id, context);
    result[id] = { dictionaries: list, groups: prunedGroups(profile, new Set(list.map(entry => entry.id))) };
  }
  return {
    schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA,
    revision: state.revision,
    dictionaries: packages.map(packageRow),
    profiles: result,
  };
}

// A new package needs the profile it joins.
function assertJoinedProfile(state, packages, previous, profileId) {
  if (plainObject(state.profiles[profileId]) || !packages.some(row => !previous.has(row.id) && !isPersonalPackage(row))) return;
  const { PROFILE_MESSAGES } = globalThis.HDReaderOptions;
  const error = new Error(profileId === JAPANESE_PROFILE_ID ? PROFILE_MESSAGES.noJapaneseProfile : PROFILE_MESSAGES.profileRemoved);
  error.code = profileId === JAPANESE_PROFILE_ID ? "no-japanese-profile" : "profile-missing";
  error.errorCode = error.code;
  throw error;
}

// One profile's list after the merge: its remaining entries in their order,
// new packages (and `joins`) last in `profileId`, and the personal package of
// its language first. In version 1 a profile's id is its language (decision 0002).
function mergedProfileList(profile, id, { packages, previous, present, joins, profileId }) {
  const list = (Array.isArray(profile?.dictionaries) ? profile.dictionaries : []).filter(entry => present.has(entry?.id));
  if (id === profileId) {
    for (const row of packages) {
      if ((previous.has(row.id) && !joins.includes(row.id)) || isPersonalPackage(row)) continue;
      if (!list.some(entry => entry.id === row.id)) list.push({ id: row.id, enabled: row.enabled !== false });
    }
  }
  const personal = packages.filter(row => personalDictionaryLanguage(row) === id);
  const personalIds = new Set(packages.filter(isPersonalPackage).map(row => row.id));
  return [...personal.map(row => ({ id: row.id, enabled: true })), ...list.filter(entry => !personalIds.has(entry.id))];
}

// Group members outside the profile's own list are pruned, as the worker's
// commit prunes them.
function prunedGroups(profile, ids) {
  return (Array.isArray(profile?.groups) ? profile.groups : []).map(group => ({
    ...group, dictionaryIds: (Array.isArray(group?.dictionaryIds) ? group.dictionaryIds : [])
      .filter((member, index, members) => ids.has(member) && members.indexOf(member) === index),
  }));
}

/**
 * Held languages (section 2): those for which the records have a profile, a
 * personal package, a personal document with text, a lookup-count entry, or a
 * marks entry with a word. Japanese's top-level count generation alone does
 * not make it held: a reset and a restore always create one.
 */
export function heldLanguages({ options, state, document, lookupStats, wordStatusOverrides }) {
  const held = new Set(profiles(options).map(profile => profile.language));
  for (const row of Array.isArray(state?.dictionaries) ? state.dictionaries : []) {
    const language = personalDictionaryLanguage(row);
    if (language !== null) held.add(language);
  }
  if (typeof document?.text === "string" && document.text !== "") held.add(JAPANESE_PROFILE_ID);
  for (const [code, entry] of Object.entries(plainObject(document?.languages) ?? {})) {
    if (typeof entry?.text === "string" && entry.text !== "") held.add(code);
  }
  for (const code of Object.keys(plainObject(lookupStats?.languages) ?? {})) held.add(code);
  const words = entry => ["known", "ignored"].some(status => Array.isArray(entry?.[status]) && entry[status].length > 0);
  if (words(wordStatusOverrides)) held.add(JAPANESE_PROFILE_ID);
  for (const [code, entry] of Object.entries(plainObject(wordStatusOverrides?.languages) ?? {})) {
    if (words(entry)) held.add(code);
  }
  return held;
}

/**
 * Whether the records are in, or may return to, the single-profile shape
 * (section 4.5): their only profile is Japanese and no other language is held.
 */
export function singleProfileShape(records) {
  const list = profiles(records.options);
  if (list.length !== 1 || list[0].id !== JAPANESE_PROFILE_ID || list[0].language !== JAPANESE_PROFILE_ID) return false;
  return [...heldLanguages(records)].every(language => language === JAPANESE_PROFILE_ID);
}
