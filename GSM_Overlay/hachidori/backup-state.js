// Complete persisted-state contract shared by the engine and storage owner.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";
import "./dictionary-group-state.js";
import "./word-status-overrides.js";
import {
  EMPTY_CUSTOM_DICTIONARY_SEMANTIC_REVISION, assertCustomSourceState,
  customDictionaryDocumentFor, customDictionaryDocumentLanguages, customDictionaryMetadataMatches,
  customDictionarySemanticRevision, emptyCustomDictionaryDocument, normaliseCustomDictionaryDocument,
  languageEntryCount, parseCustomDictionary, personalDictionaryIdentity, personalDictionaryLanguage,
} from "./custom-dictionary.js";
import { assertDictionaryUpdateSchedule, assertRecommendedDictionary, normaliseUpdateSettings, recommendedDictionarySource } from "./managed-dictionary-source.js";
import { sameJsonValue } from "./json-value.js";
import {
  assertLookupStatsDescriptor, assertLookupStatsRows, emptyLookupStats, lookupStatsLanguageView,
} from "./lookup-stats.js";
import { withOverlayLookupDefault } from "./setup-state.js";
import {
  DICTIONARY_STATE_PROFILES_SCHEMA, dictionaryStateWithoutProfiles, heldLanguages, optionsWithProfiles, optionsWithoutProfiles,
  packageRow, plainObject, singleProfileRow, singleProfileShape,
} from "./profile-state.js";
import { japaneseView } from "./japanese-view.js";
import { languageName, languageNames } from "./language-names.js";
import { LANGUAGE_CODE, hasLanguagePack } from "./sharing-languages.js";

export function backupRevisions(snapshot) {
  return Object.fromEntries(["state", "options", "document", "updates", "lookupStats", "wordStatusOverrides"].map(key => {
    const revision = snapshot[key]?.revision;
    return [key, Number.isSafeInteger(revision) && revision >= 0 ? revision : 0];
  }));
}

// An overlay restores an archive that never chose a lookup mode on hover, and
// an automatic snapshot from before word status overrides restores none. The
// engine builds the snapshot once, so the storage CAS and its exact readback
// commit and verify the same values. A version 4 backup's `plan`
// (prepareBackupProfiles) restores every language this build has a pack for.
export function restoredBackupSnapshot(current, archived, dictionaries, { overlay = false, plan = null } = {}) {
  if (plan !== null) return restoredProfileRecords(current, archived, dictionaries, plan, { overlay });
  const options = overlay ? withOverlayLookupDefault(archived.options) : archived.options;
  const restored = { ...archived, options: globalThis.HDReaderOptions.projectStoredOptions(options),
    wordStatusOverrides: globalThis.HDWordStatusOverrides.normaliseWordStatusOverrides(archived.wordStatusOverrides) };
  return Object.fromEntries(Object.entries(backupRevisions(current)).map(([key, revision]) => [key, {
    ...restored[key],
    ...(key === "state" ? { dictionaries } : {}),
    ...(key === "lookupStats" ? { generation: crypto.randomUUID() } : {}),
    revision: revision + 1,
  }]));
}

function assertDictionaryList(dictionaries) {
  const ids = new Set(), titles = new Set();
  for (const entry of dictionaries) {
    assertDictionaryUpdateSchedule(entry);
    if (typeof entry?.id !== "string" || entry.id === "" || ids.has(entry.id)
        || typeof entry.title !== "string" || entry.title === "" || titles.has(entry.title)
        || typeof entry.revision !== "string"
        || typeof entry.enabled !== "boolean" || typeof entry.favorite !== "boolean"
        || (entry.displayName !== null && typeof entry.displayName !== "string")
        || ["termCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"].some(key =>
          !Number.isSafeInteger(entry[key]) || entry[key] < 0)) {
      throw new Error("The backup contains invalid or duplicate dictionary packages.");
    }
    const recommended = recommendedDictionarySource(entry.sourceId);
    if (recommended) {
      assertRecommendedDictionary(recommended, entry);
      if (entry.downloadUrl !== recommended.downloadUrl) {
        throw new Error("The backup dictionary does not match its recommended source.");
      }
    }
    ids.add(entry.id);
    titles.add(entry.title);
  }
}

function assertGroups(groups, dictionaries) {
  const { normaliseDictionaryGroups, groupNameKey } = globalThis.HDDictionaryGroups;
  if (!Array.isArray(groups) || !sameJsonValue(groups, normaliseDictionaryGroups(groups, dictionaries))) {
    throw new Error("The backup contains invalid dictionary groups.");
  }
  const ids = new Set(), names = new Set(["all"]);
  for (const group of groups) {
    const key = groupNameKey(group.name);
    if (ids.has(group.id) || names.has(key)) throw new Error("The backup contains duplicate dictionary groups.");
    ids.add(group.id);
    names.add(key);
  }
}

function projectBackupReaderSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const { revision, ...options } = settings;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  const { DEFAULT_OPTIONS, RETIRED_OPTION_KEYS } = globalThis.HDReaderOptions;
  const allowed = new Set([...Object.keys(DEFAULT_OPTIONS), ...RETIRED_OPTION_KEYS]);
  if (Object.keys(options).some(key => !allowed.has(key))) return null;
  // Each release writes its own complete flag set. Like the stored record, an
  // archived one keeps its known flags, starts newer flags off and drops
  // retired ones; a non-boolean flag remains invalid.
  const { experimental } = options;
  if (experimental && typeof experimental === "object" && !Array.isArray(experimental)
      && Object.values(experimental).every(value => typeof value === "boolean")) {
    // Project the promoted mining choice before dropping retired flags.
    const { smallerAnkiCards } = globalThis.HDReaderOptions.projectStoredOptions({ experimental });
    if (!Object.hasOwn(options, "smallerAnkiCards") && smallerAnkiCards !== undefined) {
      options.smallerAnkiCards = smallerAnkiCards;
    }
    options.experimental = globalThis.HDReaderOptions.normaliseExperimental(experimental);
  }
  let projected;
  try {
    projected = globalThis.HDReaderOptions.validateOptionsPatch(options);
  } catch {
    return null;
  }
  // A legacy backup may have only `customLinks`, and its singleton Anki
  // object has no `templates`. If the richer fields are present, however, they
  // must already be canonical instead of relying on migration to resolve two
  // conflicting representations.
  if (Object.hasOwn(options, "customButtons") && Object.hasOwn(options, "customLinks")
      && !sameJsonValue(options.customLinks, projected.customLinks)) return null;
  if (options.anki && Object.hasOwn(options.anki, "templates")
      && !sameJsonValue(options.anki, projected.anki)) return null;
  return { ...projected, revision };
}

function validBackupUpdateSettings(settings) {
  return Number.isSafeInteger(settings?.revision) && settings.revision >= 0
    && sameJsonValue(settings, normaliseUpdateSettings(settings));
}

// A backup from any version restores its dictionaries. Its settings are read
// one by one like a stored record: a setting this version does not know or
// cannot read is skipped, and one the backup lacks keeps its default (#577).
// Selectors are pruned against the restored library before the storage CAS.
export async function prepareBackupSnapshot(archived) {
  await assertBackupSnapshot(archived, { allowInvalidSettings: true });
  const { normaliseDictionarySelections, projectStoredOptions } = globalThis.HDReaderOptions;
  const projected = projectStoredOptions(archived.options);
  const options = normaliseDictionarySelections(projected, archived.state.dictionaries, archived.state.groups);
  // A legacy clicked-kanji title migrates to `{ title, kind }`; only a
  // selection that becomes Automatic was reset.
  const reset = ["frequencyDictionary", "kanjiClickDictionary"].some(key => projected[key] && !options[key]);
  return {
    snapshot: { ...archived, options: { ...options, revision: backupRevisions(archived).options },
      updates: normaliseUpdateSettings(archived.updates) },
    warning: reset ? "Unavailable dictionary selections were reset." : null,
  };
}

export async function assertBackupSnapshot(snapshot, { allowInvalidSettings = false } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || ["state", "document"].some(key =>
        !Number.isSafeInteger(snapshot[key]?.revision) || snapshot[key].revision < 0)
      || snapshot.state?.schemaVersion !== 1 || !Array.isArray(snapshot.state.dictionaries)) {
    throw new Error("The backup contains invalid dictionary state.");
  }
  assertDictionaryList(snapshot.state.dictionaries);
  assertLookupStatsDescriptor(snapshot.lookupStats);
  assertGroups(snapshot.state.groups, snapshot.state.dictionaries);
  const document = normaliseCustomDictionaryDocument(snapshot.document);
  const entries = parseCustomDictionary(document.text).entries;
  const semanticRevision = await customDictionarySemanticRevision(entries);
  if (document.semanticRevision !== semanticRevision) throw new Error("The backup custom source has invalid semantics.");
  assertCustomSourceState(snapshot.state.dictionaries, semanticRevision, entries.length);
  if (!allowInvalidSettings && projectBackupReaderSettings(snapshot.options) === null) {
    throw new Error("The backup contains invalid reader settings.");
  }
  if (!allowInvalidSettings && !validBackupUpdateSettings(snapshot.updates)) {
    throw new Error("The backup contains invalid update settings.");
  }
  // Absent from automatic snapshots taken before overrides existed.
  if (snapshot.wordStatusOverrides !== undefined && !sameJsonValue(snapshot.wordStatusOverrides,
    globalThis.HDWordStatusOverrides.normaliseWordStatusOverrides(snapshot.wordStatusOverrides))) {
    throw new Error("The backup contains invalid word status overrides.");
  }
}

// ---------------------------------------------------------------------------
// Version 4: backups of records with profiles (docs/languages.md 17.2, 17.6,
// decision 0012). The snapshot stays a version 3 snapshot of the Japanese view
// (17.1), which older builds restore; `profiles` carries the complete options
// and dictionary state and, per other language, its personal document, marks
// and lookup rows. Other languages' personal packages are not archived: a
// restore rebuilds them from their documents.
// ---------------------------------------------------------------------------

const JAPANESE = "ja";
const INVALID_PROFILES = "The backup contains invalid language profiles.";


function invalidProfiles() {
  return new Error(INVALID_PROFILES);
}

// Japanese is built into the engine; another language needs its pack.
// A language's personal package id (section 15), also for a language this
// build has no pack for: the first 32 hexadecimal digits of SHA-256 of
// "hachidori-custom-dictionary:" and its code.
async function personalPackageId(code) {
  const known = personalDictionaryIdentity(code);
  if (known !== null) return known.id;
  const bytes = new TextEncoder().encode(`hachidori-custom-dictionary:${code}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function languageDocument(part) {
  return part?.document === undefined ? emptyCustomDictionaryDocument()
    : normaliseCustomDictionaryDocument({ ...part.document, schemaVersion: 1 });
}

const holdsWords = entry => ["known", "ignored"].some(status => Array.isArray(entry?.[status]) && entry[status].length > 0);

// Whether a language's backed-up part holds it (section 2): a document with
// text, a count entry or a marked word.
function holdsLanguage(part) {
  return (typeof part?.document?.text === "string" && part.document.text !== "")
    || Array.isArray(part?.lookupStatsRows) || holdsWords(part?.wordStatusOverrides);
}

/**
 * The backup payload of records with profiles: the Japanese view as the
 * version 3 snapshot, its lookup rows, and `profiles`. `records` are the six
 * stored records under the snapshot's names; `rowsOf(view)` gives the stored
 * lookup rows of one descriptor-shaped generation.
 */
export function profileBackupPayload(records, rowsOf) {
  const { applyOptionsPatch } = globalThis.HDReaderOptions;
  const { normaliseWordStatusOverrides, wordStatusOverridesFor } = globalThis.HDWordStatusOverrides;
  const descriptor = records.lookupStats ?? emptyLookupStats();
  assertLookupStatsDescriptor(descriptor);
  const view = japaneseView({
    dictionaryState: records.state, options: records.options, customDictionarySource: records.document,
    dictionaryUpdates: records.updates, lookupStats: descriptor, wordStatusOverrides: records.wordStatusOverrides,
  });
  const languages = {};
  const part = code => {
    languages[code] ??= {};
    return languages[code];
  };
  for (const code of customDictionaryDocumentLanguages(records.document)) {
    const { revision, semanticRevision, text } = customDictionaryDocumentFor(records.document, code);
    part(code).document = { revision, semanticRevision, text };
  }
  for (const code of Object.keys(plainObject(records.wordStatusOverrides?.languages) ?? {})) {
    const { known, ignored } = wordStatusOverridesFor(records.wordStatusOverrides, code);
    part(code).wordStatusOverrides = { known, ignored };
  }
  for (const code of Object.keys(descriptor.languages ?? {})) {
    part(code).lookupStatsRows = rowsOf(lookupStatsLanguageView(descriptor, code));
  }
  return {
    snapshot: {
      state: view.dictionaryState,
      options: view.options,
      document: normaliseCustomDictionaryDocument(view.customDictionarySource),
      updates: normaliseUpdateSettings(view.dictionaryUpdates),
      lookupStats: view.lookupStats,
      wordStatusOverrides: normaliseWordStatusOverrides(view.wordStatusOverrides),
    },
    lookupStatsRows: rowsOf(view.lookupStats),
    profiles: { options: applyOptionsPatch(records.options, {}), dictionaryState: records.state, languages },
  };
}

// The languages a version 4 backup holds (section 2).
function backupHeldLanguages(snapshot, profiles) {
  const held = new Set(globalThis.HDReaderOptions.profiles(profiles.options).map(profile => profile.language));
  if (typeof snapshot.document?.text === "string" && snapshot.document.text !== "") held.add(JAPANESE);
  if (holdsWords(snapshot.wordStatusOverrides)) held.add(JAPANESE);
  for (const [code, part] of Object.entries(profiles.languages ?? {})) {
    if (holdsLanguage(part)) held.add(code);
  }
  return held;
}

function assertProfileOptions(options, allowInvalidSettings) {
  const { applyOptionsPatch, profiles } = globalThis.HDReaderOptions;
  if (!plainObject(options) || !Array.isArray(options.profiles)) throw invalidProfiles();
  const list = profiles(options);
  // Every stored profile reads back; one that does not is not a setting. In
  // version 1 a profile's id is its language code (decision 0002).
  if (list.length !== options.profiles.length || list.length === 0
      || list.some(profile => profile.id !== profile.language)) throw invalidProfiles();
  if (!allowInvalidSettings && !sameJsonValue(options, applyOptionsPatch(options, {}))) {
    throw new Error("The backup contains invalid reader settings.");
  }
  return list;
}

function assertProfileState(state, list) {
  const { hasDictionaryProfiles, packageWithEnabled, projectDictionaryState } = globalThis.HDReaderOptions;
  if (!hasDictionaryProfiles(state) || !Number.isSafeInteger(state.revision) || state.revision < 0
      || !Array.isArray(state.dictionaries) || state.dictionaries.some(row => plainObject(row) === null)) {
    throw new Error("The backup contains invalid dictionary state.");
  }
  assertDictionaryList(state.dictionaries.map(row => packageWithEnabled(row, true)));
  const byCode = (a, b) => a.localeCompare(b);
  if (!sameJsonValue(Object.keys(state.profiles).sort(byCode), list.map(profile => profile.id).sort(byCode))) throw invalidProfiles();
  const installed = new Set(state.dictionaries.map(row => row.id));
  const groupIds = new Set();
  for (const profile of list) {
    const entry = plainObject(state.profiles[profile.id]);
    if (entry === null || !Array.isArray(entry.dictionaries)) throw invalidProfiles();
    const listed = new Set();
    for (const item of entry.dictionaries) {
      if (plainObject(item) === null || !installed.has(item.id) || listed.has(item.id) || typeof item.enabled !== "boolean") {
        throw invalidProfiles();
      }
      listed.add(item.id);
    }
    assertGroups(entry.groups, projectDictionaryState(state, profile.id).dictionaries);
    // Group ids stay unique across profiles (section 4.2).
    for (const group of entry.groups) {
      if (groupIds.has(group.id)) throw new Error("The backup contains duplicate dictionary groups.");
      groupIds.add(group.id);
    }
  }
}

function assertLanguageParts(languages) {
  if (plainObject(languages) === null) throw invalidProfiles();
  for (const [code, part] of Object.entries(languages)) assertLanguagePart(code, part);
}

// One language's records in a backup: its document, marks and count rows.
function assertLanguagePart(code, part) {
  if (!LANGUAGE_CODE.test(code) || code === JAPANESE || plainObject(part) === null) throw invalidProfiles();
  if (part.document !== undefined) {
    try {
      languageDocument(part);
    } catch {
      throw invalidProfiles();
    }
  }
  if (part.wordStatusOverrides !== undefined) {
    const { known, ignored } = globalThis.HDWordStatusOverrides.normaliseWordStatusOverrides(part.wordStatusOverrides);
    if (!sameJsonValue(part.wordStatusOverrides, { known, ignored })) {
      throw new Error("The backup contains invalid word status overrides.");
    }
  }
  if (part.lookupStatsRows !== undefined) assertLookupStatsRows({ generation: code, revision: 0 }, part.lookupStatsRows);
}

// The view lists every package as the complete state holds it, except other
// languages' personal packages, which it leaves out. Returns those, by id,
// with their language, including languages this build has no pack for. Both
// sides are compared without targetLanguage: builds of the multi-language
// branch before 7f36f9cf, the first test build among them, kept it in the
// view's rows, and a restore takes only ids and enabled from the view.
async function viewOmissions(snapshot, state, held) {
  const { packageWithEnabled } = globalThis.HDReaderOptions;
  const rows = new Map(state.dictionaries.map(row => [row.id, row]));
  for (const row of snapshot.state.dictionaries) {
    const source = rows.get(row.id);
    if (source === undefined
      || !sameJsonValue(singleProfileRow(row), singleProfileRow(packageWithEnabled(source, row.enabled)))) throw invalidProfiles();
  }
  const listed = new Set(snapshot.state.dictionaries.map(row => row.id));
  const personal = new Map();
  for (const code of held) {
    if (code !== JAPANESE) personal.set(await personalPackageId(code), code); // NOSONAR: a digest per held language
  }
  const omitted = new Map();
  for (const row of state.dictionaries) {
    if (listed.has(row.id)) continue;
    const language = personal.get(row.id) ?? personalDictionaryLanguage(row);
    if (language === null || language === JAPANESE) throw invalidProfiles();
    omitted.set(row.id, language);
  }
  return omitted;
}

// Every language this build has a pack for keeps the managed-package rules
// (AGENTS.md "Managed custom dictionary") in every profile of its language:
// its package exists exactly when its document has entries, matches that
// document, and is first and enabled in its language's profiles and absent
// from the others.
async function assertPersonalPackages(snapshot, state, list, languages, omitted) {
  const codes = new Set([JAPANESE, ...Object.keys(languages), ...list.map(profile => profile.language), ...omitted.values()]);
  for (const code of codes) {
    const identity = personalDictionaryIdentity(code);
    if (identity === null) continue;
    const document = code === JAPANESE ? normaliseCustomDictionaryDocument(snapshot.document) : languageDocument(languages[code]);
    const entries = parseCustomDictionary(document.text, identity).entries;
    const semanticRevision = await customDictionarySemanticRevision(entries, identity); // NOSONAR: one digest per language
    if (document.semanticRevision !== semanticRevision) throw new Error("The backup custom source has invalid semantics.");
    const row = state.dictionaries.find(entry => entry.id === identity.id);
    if (!personalRowMatches(row, entries.length, semanticRevision, identity)) {
      throw new Error("The backup custom dictionary package does not match its source.");
    }
    if (list.some(profile => personalPackageMisplaced(state.profiles[profile.id].dictionaries, identity, profile.language === code, row))) {
      throw new Error("The managed custom dictionary must stay enabled and first.");
    }
  }
}

// A personal package exists exactly when its source has entries, and then
// matches the source.
function personalRowMatches(row, entryCount, semanticRevision, identity) {
  if (entryCount === 0) return row === undefined;
  return row !== undefined && customDictionaryMetadataMatches(row, semanticRevision, entryCount, identity);
}

// In its language's profiles a personal package is first and enabled; in
// other profiles it is absent.
function personalPackageMisplaced(items, identity, ownLanguage, row) {
  const index = items.findIndex(item => item.id === identity.id);
  if (!ownLanguage) return index >= 0;
  return row !== undefined && (index !== 0 || items[0].enabled !== true);
}

/**
 * The version 4 rules for `profiles` (section 17.2), beside a snapshot that
 * assertBackupSnapshot has accepted. With `allowInvalidSettings`, settings
 * are read one by one later, as a version 3 snapshot's are.
 */
export async function assertBackupProfiles(snapshot, profiles, { allowInvalidSettings = false } = {}) {
  if (plainObject(profiles) === null) throw invalidProfiles();
  const list = assertProfileOptions(profiles.options, allowInvalidSettings);
  assertProfileState(profiles.dictionaryState, list);
  const languages = profiles.languages ?? {};
  assertLanguageParts(languages);
  const state = profiles.dictionaryState;
  const omitted = await viewOmissions(snapshot, state, backupHeldLanguages(snapshot, { ...profiles, languages }));
  await assertPersonalPackages(snapshot, state, list, languages, omitted);
}

/**
 * What a version 4 restore restores (sections 17.2 and 17.6), for a backup
 * whose snapshot prepareBackupSnapshot has read: every language this build
 * has a pack for, with its profile, personal package, document, counts and
 * marks. A language without a pack is left out; its other packages stay in
 * the library, in no profile. When no profile of the backup remains, the
 * Japanese profile is built from the backup's Japanese view, as an older build
 * does. `personal` lists the other languages' personal packages to rebuild.
 */
export async function prepareBackupProfiles(snapshot, profiles) {
  await assertBackupProfiles(snapshot, profiles, { allowInvalidSettings: true });
  const { applyOptionsPatch, normaliseDictionarySelections, profiles: profileList, projectDictionaryState } = globalThis.HDReaderOptions;
  const parts = profiles.languages ?? {};
  const missing = [...backupHeldLanguages(snapshot, { ...profiles, languages: parts })].filter(code => !hasLanguagePack(code))
    .sort((a, b) => a.localeCompare(b));
  const leftOut = new Set(await Promise.all(missing.map(personalPackageId)));
  const record = applyOptionsPatch(profiles.options, {});
  const list = profileList(record);
  const kept = list.filter(profile => !missing.includes(profile.language));
  const rows = profiles.dictionaryState.dictionaries.filter(row => !leftOut.has(row.id));
  const ids = new Set(rows.map(row => row.id));
  const fallback = kept.length === 0;
  const lists = fallback
    ? { [JAPANESE]: { dictionaries: snapshot.state.dictionaries.map(({ id, enabled }) => ({ id, enabled })), groups: snapshot.state.groups } }
    : Object.fromEntries(kept.map(profile => [profile.id, profiles.dictionaryState.profiles[profile.id]]));
  const dictionaryState = {
    schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA, revision: profiles.dictionaryState.revision, dictionaries: rows,
    profiles: Object.fromEntries(Object.entries(lists).map(([id, entry]) => [id, {
      dictionaries: entry.dictionaries.filter(item => ids.has(item.id)), groups: entry.groups,
    }])),
  };
  const options = fallback ? optionsWithProfiles(snapshot.options) : { ...record, profiles: kept };
  const languages = Object.fromEntries(Object.entries(parts).filter(([code]) => !missing.includes(code)));
  const personal = rows.flatMap(row => {
    const language = personalDictionaryLanguage(row);
    if (language === null || language === JAPANESE) return [];
    return [{ language, identity: personalDictionaryIdentity(language), row, document: languageDocument(languages[language]) }];
  });
  // A selection naming a dictionary its profile no longer has is reset.
  const reset = options.profiles.some(profile => {
    const view = projectDictionaryState(dictionaryState, profile.id);
    const pruned = normaliseDictionarySelections(profile.settings, view.dictionaries, view.groups);
    return ["frequencyDictionary", "kanjiClickDictionary"].some(key => profile.settings[key] && !pruned[key]);
  });
  return {
    options, dictionaryState, languages, missing, fallback, personal,
    leftOutProfiles: list.filter(profile => missing.includes(profile.language)).map(profile => profile.language),
    warning: reset ? "Unavailable dictionary selections were reset." : null,
  };
}

// The packages a restore loads: every package of the plan once, enabled when a
// restored profile enables it, at the path `fresh` (id → row) gives it.
export function backupEngineDictionaries(plan, fresh = new Map()) {
  const { allPackages, packageWithEnabled } = globalThis.HDReaderOptions;
  return allPackages(plan.dictionaryState).map(row => {
    const replacement = fresh.get(row.id);
    return replacement === undefined ? row : packageWithEnabled(packageRow(replacement), row.enabled);
  });
}

// Personal entries of every language a backup restores.
export function personalEntryCount(snapshot, profiles) {
  let count = languageEntryCount(normaliseCustomDictionaryDocument(snapshot.document).text);
  for (const [code, part] of Object.entries(profiles?.languages ?? {})) {
    if (personalDictionaryIdentity(code) !== null && typeof part?.document?.text === "string") {
      count += languageEntryCount(part.document.text, code);
    }
  }
  return count;
}

/**
 * The preview's language lines (sections 17.2 and 17.6): the languages a
 * version 4 backup restores, the ones it leaves out, the Japanese profile built
 * in place of left-out ones, and every language of this installation whose
 * data the restore removes. `current` holds the six stored records under the
 * snapshot's names; `plan` is null for a version 1-3 backup.
 */
export function restorePreviewNotes(current, plan) {
  const notes = [];
  const after = new Set([JAPANESE]);
  if (plan !== null) {
    const restored = [...new Set(plan.options.profiles.map(profile => profile.language))];
    for (const code of restored) after.add(code);
    for (const [code, part] of Object.entries(plan.languages)) {
      if (holdsLanguage(part)) after.add(code);
    }
    notes.push(`Restores ${languageNames(restored)}.`);
    for (const code of plan.missing) notes.push(`${languageName(code)} needs a newer Hachidori and is not restored.`);
    if (plan.fallback) {
      notes.push(`The Japanese settings and dictionaries are restored in place of ${languageNames(plan.leftOutProfiles)}.`);
    }
  }
  const removed = [...heldLanguages(current)].filter(code => !after.has(code)).sort((a, b) => a.localeCompare(b));
  if (removed.length === 1) {
    notes.push(`Restoring removes ${languageNames(removed)} and its settings, personal dictionary, lookup counts and marked words.`);
  } else if (removed.length > 1) {
    notes.push(`Restoring removes ${languageNames(removed)} and their settings, personal dictionaries, lookup counts and marked words.`);
  }
  return notes;
}

// The restored records of a version 4 plan: every revision one above the
// current one, every language's personal document too (a language that keeps
// a profile while the backup has no document for it gets an emptied one, so
// open Settings pages adopt it), a fresh count generation for Japanese and for
// every other language with counts, and today's shapes when the result is
// the single-profile shape (section 4.5).
function restoredProfileRecords(current, archived, dictionaries, plan, { overlay }) {
  const { normaliseDictionarySelections, projectDictionaryState } = globalThis.HDReaderOptions;
  const { normaliseWordStatusOverrides } = globalThis.HDWordStatusOverrides;
  const { pruneGroupMemberships } = globalThis.HDDictionaryGroups;
  const revisions = backupRevisions(current);
  const fresh = new Map(dictionaries.map(row => [row.id, packageRow(row)]));
  const packages = plan.dictionaryState.dictionaries.filter(row => fresh.has(row.id)).map(row => fresh.get(row.id));
  const installed = new Set(packages.map(row => row.id));
  const profiles = Object.fromEntries(Object.entries(plan.dictionaryState.profiles).map(([id, entry]) => {
    const items = entry.dictionaries.filter(item => installed.has(item.id));
    return [id, { dictionaries: items, groups: pruneGroupMemberships(entry.groups, items) }];
  }));
  const state = { schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA, revision: revisions.state + 1, dictionaries: packages, profiles };
  const record = overlay ? withOverlayLookupDefault(plan.options) : plan.options;
  const options = { ...record, revision: revisions.options + 1, profiles: record.profiles.map(profile => {
    const view = projectDictionaryState(state, profile.id);
    return { ...profile, settings: normaliseDictionarySelections(profile.settings, view.dictionaries, view.groups) };
  }) };
  const profileLanguages = new Set(options.profiles.map(profile => profile.language));
  const currentDocuments = new Set(customDictionaryDocumentLanguages(current.document));
  const documents = {};
  for (const code of new Set([...Object.keys(plan.languages), ...currentDocuments])) {
    const archivedDocument = plan.languages[code]?.document;
    if (archivedDocument === undefined && !(profileLanguages.has(code) && currentDocuments.has(code))) continue;
    documents[code] = {
      revision: customDictionaryDocumentFor(current.document, code).revision + 1,
      semanticRevision: archivedDocument?.semanticRevision ?? EMPTY_CUSTOM_DICTIONARY_SEMANTIC_REVISION,
      text: archivedDocument?.text ?? "",
    };
  }
  const top = { ...normaliseCustomDictionaryDocument(archived.document), revision: revisions.document + 1 };
  const document = Object.keys(documents).length === 0 ? top : { ...top, languages: documents };
  const counted = Object.keys(plan.languages).filter(code => Array.isArray(plan.languages[code].lookupStatsRows));
  const generation = crypto.randomUUID();
  const lookupStats = counted.length === 0 ? { generation, revision: revisions.lookupStats + 1 }
    : { generation, revision: revisions.lookupStats + 1,
      languages: Object.fromEntries(counted.map(code => [code, crypto.randomUUID()])) };
  const japaneseMarks = normaliseWordStatusOverrides(archived.wordStatusOverrides);
  const marks = { revision: revisions.wordStatusOverrides + 1, known: japaneseMarks.known, ignored: japaneseMarks.ignored };
  const marked = Object.entries(plan.languages).filter(([, part]) => holdsWords(part.wordStatusOverrides))
    .map(([code, part]) => [code, { known: part.wordStatusOverrides.known, ignored: part.wordStatusOverrides.ignored }]);
  const wordStatusOverrides = marked.length === 0 ? marks : { ...marks, languages: Object.fromEntries(marked) };
  const updates = { ...archived.updates, revision: revisions.updates + 1 };
  const records = { state, options, document, updates, lookupStats, wordStatusOverrides };
  if (!singleProfileShape(records)) return records;
  const flatState = dictionaryStateWithoutProfiles(state);
  return {
    state: flatState,
    options: normaliseDictionarySelections(optionsWithoutProfiles(options), flatState.dictionaries, flatState.groups),
    document: top, updates, lookupStats: { generation, revision: lookupStats.revision }, wordStatusOverrides: marks,
  };
}

// The rows a version 4 restore writes under each other language's new
// generation, by language.
export function restoredLanguageRows(plan, records) {
  return Object.fromEntries(Object.keys(records.lookupStats.languages ?? {})
    .map(code => [code, plan.languages[code]?.lookupStatsRows ?? []]));
}

/**
 * hd_backup_cas for restored records with profiles (section 17.2): split as a
 * backup is, they must form a valid backup; every revision is one above the
 * current one, every language's personal document included, and a language
 * that keeps a profile keeps a document; every count generation is new.
 */
export async function assertRestoredProfileRecords(current, records, lookupStatsRows, languageRows = {}) {
  const { normaliseDictionarySelections, profiles, projectDictionaryState } = globalThis.HDReaderOptions;
  const descriptor = records.lookupStats;
  assertLookupStatsDescriptor(descriptor);
  if (Object.keys(languageRows ?? {}).some(code => typeof descriptor.languages?.[code] !== "string")) {
    throw new Error("Invalid lookup statistics collection.");
  }
  const byGeneration = new Map([[descriptor.generation, lookupStatsRows]]);
  for (const [code, generation] of Object.entries(descriptor.languages ?? {})) byGeneration.set(generation, languageRows?.[code] ?? []);
  const payload = profileBackupPayload(records, view => {
    const rows = byGeneration.get(view.generation) ?? [];
    assertLookupStatsRows(view, rows);
    return rows;
  });
  await assertBackupSnapshot(payload.snapshot);
  await assertBackupProfiles(payload.snapshot, payload.profiles);
  const expected = Object.fromEntries(Object.entries(backupRevisions(current)).map(([key, revision]) => [key, revision + 1]));
  if (!sameJsonValue(backupRevisions(records), expected)) throw new Error("Invalid backup restore revisions.");
  const list = profiles(records.options);
  if (!sameJsonValue(records.options, globalThis.HDReaderOptions.applyOptionsPatch(records.options, {}))) {
    throw new Error("The backup contains invalid reader settings.");
  }
  const languages = new Set(list.map(profile => profile.language));
  const restoredDocuments = new Set(customDictionaryDocumentLanguages(records.document));
  if ([...restoredDocuments].some(code => customDictionaryDocumentFor(records.document, code).revision
      !== customDictionaryDocumentFor(current.document, code).revision + 1)
      || customDictionaryDocumentLanguages(current.document).some(code => languages.has(code) && !restoredDocuments.has(code))) {
    throw new Error("Invalid backup restore revisions.");
  }
  const generations = [descriptor.generation, ...Object.values(descriptor.languages ?? {})];
  const currentGenerations = new Set([current.lookupStats?.generation, ...Object.values(current.lookupStats?.languages ?? {})]);
  if (generations.some(generation => generation === null || currentGenerations.has(generation))
      || new Set(generations).size !== generations.length) {
    throw new Error("A backup restore requires a fresh lookup statistics namespace.");
  }
  for (const profile of list) {
    const view = projectDictionaryState(records.state, profile.id);
    if (!sameJsonValue(profile.settings, normaliseDictionarySelections(profile.settings, view.dictionaries, view.groups))) {
      throw new Error("The backup reader settings refer to unavailable dictionaries.");
    }
  }
}
