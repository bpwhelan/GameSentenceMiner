// What the service worker's modules share: message targets, storage keys and reader options, the
// offscreen relay, the storage queue with the dictionary-state and options rules it writes, and reply shapes.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { recordDebugFailure, setDebugLogLanguages } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import { ensureChromeOffscreen } from "./chrome-offscreen.js";
// The language packs' descriptors (docs/languages.md 9.1), read only once the
// records have profiles or a profile is being added.
import "./vendor/languages/registry.js";
import "./reader-options.js";
import { ANKI_INDEX_KEY, ankiIndexConfigurationChange } from "./anki-index-cache.js";
import { NOT_REACHABLE } from "./sharing-client.js";
import "./external-links.js";
import "./dictionary-group-state.js";
import "./word-status-overrides.js";
import { assertDictionaryUpdateSchedule } from "./managed-dictionary-source.js";
import {
  CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_SOURCE_KEY, CUSTOM_DICTIONARY_TITLE, personalDictionaryLanguage,
} from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import { boundResponseFailure, responseFits, responseLimitError } from "./response-limits.js";
import { STARTUP_PAGE } from "./setup-state.js";
import { SEARCH_FRAME, SEARCH_PAGE } from "./search-window.js";
import { mergeDictionaryView, profileLanguages } from "./profile-state.js";

const {
  ANKI_TEMPLATE_CONFIG_KEYS, DEFAULT_OPTIONS, ankiTemplateConfig, normaliseDictionarySelections, normaliseOptions, projectStoredOptions,
  validateOptionsPatch, JAPANESE_PROFILE_ID, hasProfiles, hasDictionaryProfiles, profiles: optionProfiles,
  applyOptionsPatch, applyPackSettingsPatch, projectDictionaryState, languageDescriptor, packSettingValue,
  LANGUAGE_SELECTION_KEY, normaliseLanguageSelection,
} = globalThis.HDReaderOptions;
const { normaliseExternalUrl } = globalThis.HDExternalLinks;
const { pruneGroupMemberships } = globalThis.HDDictionaryGroups;
const { WORD_STATUS_OVERRIDES_KEY, normaliseWordStatusOverrides, withWordStatusOverride } = globalThis.HDWordStatusOverrides;

const OFFSCREEN_DOCUMENT = "offscreen.html";
const TARGET = "hoshidicts-offscreen";
const UPDATE_TARGET = "hachidori-updates";
const AUDIO_TARGET = "hachidori-audio";
const SETUP_TARGET = "hachidori-setup";
const PAGE_ZOOM_TARGET = "hachidori-page-zoom";
// The search page's clipboard monitor (#639), as search-clipboard.js names it.
const CLIPBOARD_TARGET = "hachidori-clipboard";
const BACKUP_LIFECYCLE_PORT = "hachidori-backup-settings";

// Requests the worker answers itself. A second target is what keeps them out of
// the relay below: a message from the offscreen document carrying TARGET is
// indistinguishable from one sent by an extension page, so it would be stamped
// `relayed` and handed straight back to the offscreen document, where the
// engine's own request queue would then wait on itself.
const WORKER_TARGET = "hoshidicts-worker";

const DICTIONARY_STATE_KEY = "dictionaryState";
const LEGACY_DICTIONARIES_KEY = "dictionaries";
const OPTIONS_KEY = "options";
const UPDATE_SETTINGS_KEY = "dictionaryUpdates";

const DICTIONARY_STATE_SCHEMA_VERSION = 1;

function engineSender(sender) {
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
}

function ankiSettingsSender(sender) {
  return sender?.id === chrome.runtime.id
    && sender.url?.split(/[?#]/u)[0] === chrome.runtime.getURL("settings.html");
}

// Called within the background storage queue. Options and index invalidation
// share one write so a delayed storage event cannot publish an obsolete pull.
// The index compares every profile's first Template, so it reads the records.
async function writeLocalState(values, store = chrome.storage.local) {
  if (store === chrome.storage.local && Object.hasOwn(values, OPTIONS_KEY)) {
    const stored = await chrome.storage.local.get([OPTIONS_KEY, ANKI_INDEX_KEY]);
    const index = await ankiIndexConfigurationChange(stored[OPTIONS_KEY], values[OPTIONS_KEY], stored[ANKI_INDEX_KEY]);
    if (index !== undefined) values = { ...values, [ANKI_INDEX_KEY]: index };
  }
  await store.set(values);
}

// A relayed request can arrive in the window between createDocument() resolving
// and offscreen.js running its module body, where nothing is listening yet.
const RELAY_ATTEMPTS = 5;
const RELAY_BACKOFF_MS = 40;
const NOT_LISTENING = /Receiving end does not exist|Could not establish connection/i;

// True after the offscreen document answered a relayed request; cleared when a
// relay gets no reply, so the next attempt verifies the document again.
let offscreenAnswered = false;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// createDocument() rejects when called while another call is in flight, so every
// caller waits on the same promise.
async function ensureOffscreen() {
  // Some extension hosts keep this page alive themselves instead of exposing
  // Chrome's offscreen-document lifecycle API.
  await ensureChromeOffscreen(OFFSCREEN_DOCUMENT);
}

// A lookup once the records have profiles, or an engine request that names a
// profile or a language, is resolved to its profile's language before it is
// relayed (docs/languages.md 5.2, 9.3). Other requests go as they are.
function resolvesProfile(message) {
  return message?.target === TARGET && (resolvesLookupProfile(message) || resolvesRequestLanguage(message));
}

function resolvesLookupProfile(message) {
  return PROFILE_LOOKUP_TYPES.has(message.type) && (lookupProfiles !== null || message.profileId !== undefined);
}

function resolvesRequestLanguage(message) {
  return PROFILE_LANGUAGE_TYPES.has(message.type) && (message.profileId !== undefined || Object.hasOwn(message, "language"));
}

async function withProfileFields(message) {
  const looked = resolvesLookupProfile(message) ? await resolveLookupProfile(message) : message;
  return resolvesRequestLanguage(looked) ? resolveRequestLanguage(looked) : looked;
}

// A request of a profile carries its fields before it reaches the engine
// (docs/languages.md 9.3).
async function relay(message, stillCurrent = null) {
  return relayToOffscreen(resolvesProfile(message) ? await withProfileFields(message) : message, stillCurrent);
}

async function relayToOffscreen(message, stillCurrent) {
  let failure = null;
  for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt += 1) {
    // ensureOffscreen() costs a getContexts() round trip to the browser process
    // on every request (about 0.2 ms of a 2.3 ms lookup). Once the document has
    // answered, send to it directly; a missing reply falls back to the checked
    // path immediately, without consuming an attempt or backing off.
    const optimistic = offscreenAnswered;
    if (!optimistic) {
      await ensureOffscreen();
    }
    if (stillCurrent && !stillCurrent()) {
      return { type: `${message.type}_result`, requestId: message.requestId, ok: true, status: "cancelled" };
    }
    try {
      // `relayed` is what lets offscreen.js ignore the copy of this message that
      // chrome.runtime.sendMessage also delivers to it directly, so a request
      // from an extension page runs on the engine exactly once.
      const reply = await chrome.runtime.sendMessage({ ...message, relayed: true });
      if (reply !== undefined) {
        offscreenAnswered = true;
        return reply;
      }
      failure = new Error("offscreen document sent no reply");
    } catch (error) {
      if (!NOT_LISTENING.test(describeErrorOrJson(error))) {
        throw error;
      }
      failure = error;
    }
    offscreenAnswered = false;
    if (optimistic) {
      attempt -= 1;
      continue;
    }
    await sleep(RELAY_BACKOFF_MS * (attempt + 1)); // NOSONAR: each retry backs off before the next
  }
  throw failure ?? new Error("offscreen document unreachable");
}

async function readDictionaryStorage(includeCustomDocument = false, store = chrome.storage.local) {
  const keys = [
    DICTIONARY_STATE_KEY,
    LEGACY_DICTIONARIES_KEY,
    OPTIONS_KEY,
  ];
  if (includeCustomDocument) keys.push(CUSTOM_DICTIONARY_SOURCE_KEY);
  const stored = await store.get(keys);
  const state = stored?.[DICTIONARY_STATE_KEY] ?? null;
  return {
    state,
    legacyDictionaries:
      state === null && Array.isArray(stored?.[LEGACY_DICTIONARIES_KEY])
        ? stored[LEGACY_DICTIONARIES_KEY]
        : null,
    options: stored?.[OPTIONS_KEY],
    customDocument: includeCustomDocument
      ? stored?.[CUSTOM_DICTIONARY_SOURCE_KEY] ?? null
      : undefined,
  };
}

function assertDictionaryState(state) {
  if (state !== null && state?.schemaVersion !== DICTIONARY_STATE_SCHEMA_VERSION && !hasDictionaryProfiles(state)) {
    throw new Error(`unsupported dictionary state schema ${String(state?.schemaVersion)}`);
  }
}

function customPackageEngineState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const engineState = { ...value };
  delete engineState.displayName;
  delete engineState.favorite;
  return engineState;
}

function assertOrdinaryCustomTransition(currentDictionaries, nextDictionaries) {
  const currentIndex = currentDictionaries.findIndex(
    (dictionary) => dictionary?.id === CUSTOM_DICTIONARY_ID,
  );
  const nextIndexes = nextDictionaries.flatMap((dictionary, index) =>
    dictionary?.id === CUSTOM_DICTIONARY_ID ? [index] : []);
  if (currentIndex < 0 && nextIndexes.length === 0) return;
  if (currentIndex < 0 || nextIndexes.length !== 1) {
    throw new Error("the managed custom dictionary can only be changed by its source editor");
  }
  const current = currentDictionaries[currentIndex];
  const next = nextDictionaries[nextIndexes[0]];
  if (currentIndex !== 0
      || current?.title !== CUSTOM_DICTIONARY_TITLE
      || current?.enabled !== true
      || nextIndexes[0] !== 0
      || next?.title !== CUSTOM_DICTIONARY_TITLE
      || next?.enabled !== true
      || !sameJsonValue(customPackageEngineState(current), customPackageEngineState(next))) {
    throw new Error("the managed custom dictionary must stay enabled and first");
  }
}

function assertCustomDictionaryCasRequest(message) {
  if (!Number.isInteger(message?.baseDocumentRevision)
      || message.baseDocumentRevision < 0) {
    throw new Error("the custom dictionary write carried no valid document revision");
  }
  if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
    throw new Error("the custom dictionary write carried no valid dictionary revision");
  }
  if (typeof message?.text !== "string"
      || typeof message?.semanticRevision !== "string") {
    throw new TypeError("the custom dictionary write carried no source document");
  }
  const changesDictionaryState = message.dictionaries !== undefined;
  if (changesDictionaryState && !Array.isArray(message.dictionaries)) {
    throw new TypeError("the custom dictionary write carried an invalid dictionary list");
  }
  if (message.groups !== undefined && !Array.isArray(message.groups)) {
    throw new TypeError("the custom dictionary write carried invalid groups");
  }
  return changesDictionaryState;
}

function committedSelectionTitle(title, current, dictionaries) {
  const selected = current?.dictionaries.find((entry) => entry.title === title);
  return selected ? dictionaries.find((entry) => entry.id === selected.id)?.title ?? "" : title;
}

function migrateCommittedDictionarySelections(value, current, dictionaries) {
  const options = { ...value };
  const migrate = (title) => typeof title === "string" && title !== ""
    ? committedSelectionTitle(title, current, dictionaries)
    : title;
  for (const key of [
    "frequencyDictionary",
    "definitionBlurFrequencyDictionary",
    "compactDefinitionSummaryDictionary",
    "pitchAccentFuriganaDictionary",
  ]) {
    if (Object.hasOwn(options, key)) options[key] = migrate(options[key]);
  }
  if (Object.hasOwn(options, "kanjiClickDictionary")
      && typeof options.kanjiClickDictionary === "string") {
    options.kanjiClickDictionary = migrate(options.kanjiClickDictionary);
  } else if (options.kanjiClickDictionary?.title) {
    const title = migrate(options.kanjiClickDictionary.title);
    options.kanjiClickDictionary = title === ""
      ? ""
      : { ...options.kanjiClickDictionary, title };
  }
  if (Object.hasOwn(options, "popupImageSource")
      && options.popupImageSource?.kind === "dictionary") {
    const title = migrate(options.popupImageSource.title);
    options.popupImageSource = title ? { kind: "dictionary", title } : null;
  }
  return options;
}

function dictionaryCommit(current, currentOptions, dictionaries, groups) {
  for (const dictionary of dictionaries) assertDictionaryUpdateSchedule(dictionary);
  const currentRevision = current?.revision ?? 0;
  const state = {
    schemaVersion: DICTIONARY_STATE_SCHEMA_VERSION,
    revision: currentRevision + 1,
    dictionaries,
    groups: pruneGroupMemberships(groups ?? current?.groups, dictionaries),
  };
  const values = { [DICTIONARY_STATE_KEY]: state };
  if (currentOptions !== undefined) {
    const revision = optionsRevision(currentOptions);
    const nextOptions = normaliseDictionarySelections(
      migrateCommittedDictionarySelections(
        { ...projectStoredOptions(currentOptions), revision },
        current,
        state.dictionaries,
      ),
      state.dictionaries,
      state.groups,
    );
    if (!sameJsonValue(nextOptions, { ...currentOptions, revision })) {
      values[OPTIONS_KEY] = { ...nextOptions, revision: revision + 1 };
    }
  }
  return { state, values };
}

function optionsRevision(options) {
  return Number.isInteger(options?.revision) && options.revision >= 0 ? options.revision : 0;
}

// ---------------------------------------------------------------------------
// Records with profiles (docs/languages.md, sections 4 and 5). A record
// without `profiles` takes today's paths unchanged; these run only once the
// records have profiles.
// ---------------------------------------------------------------------------

const DICTIONARY_STATE_PROFILES_SCHEMA_VERSION = 2;
const LANGUAGE_CODE = /^[a-z]{2,3}$/u;
const GLOBAL_OPTIONS = new Set(globalThis.HDReaderOptions.GLOBAL_OPTION_KEYS);
const NO_JAPANESE_PROFILE = globalThis.HDReaderOptions.PROFILE_MESSAGES.noJapaneseProfile;
const PROFILE_REMOVED = globalThis.HDReaderOptions.PROFILE_MESSAGES.profileRemoved;

function profileError(text, code) {
  const error = new Error(text);
  error.code = code;
  return error;
}

// The profile a request is for (section 5.2): the one it names, or, from code
// that predates profiles, the Japanese one. A request naming a profile that
// does not exist is refused, and so is one naming none when there is no
// Japanese profile.
function requestProfileId(message, storedOptions) {
  const named = message?.profileId;
  if (named !== undefined && (typeof named !== "string" || named === "")) {
    throw new TypeError("the request named an invalid profile");
  }
  const id = named ?? JAPANESE_PROFILE_ID;
  if (optionProfiles(storedOptions).some(profile => profile.id === id)) return id;
  throw named === undefined ? profileError(NO_JAPANESE_PROFILE, "no-japanese-profile")
    : profileError(PROFILE_REMOVED, "profile-missing");
}

function withPrunedProfileSelections(record, profileId, view) {
  if (view === null) return record;
  return { ...record, profiles: record.profiles.map(profile => profile.id !== profileId ? profile
    : { ...profile, settings: normaliseDictionarySelections(profile.settings, view.dictionaries, view.groups ?? []) }) };
}

// hd_options_write on a record with profiles: global keys to the top level,
// profile keys and pack settings to the profile the request names, which is
// then pruned against its own packages and groups.
function profileOptionsWriteResult(message, patch, state, storedOptions) {
  const revision = optionsRevision(storedOptions);
  if (message.baseRevision !== revision) return optionsWriteConflict(message, applyOptionsPatch(storedOptions, {}));
  const globalOnly = Object.keys(patch).every(key => GLOBAL_OPTIONS.has(key)) && message.packSettings === undefined;
  const profileId = globalOnly ? null : requestProfileId(message, storedOptions);
  let options = applyOptionsPatch(storedOptions, patch, profileId ?? JAPANESE_PROFILE_ID);
  if (message.packSettings !== undefined) options = applyPackSettingsPatch(options, message.packSettings, profileId);
  if (profileId !== null && state !== null) {
    options = withPrunedProfileSelections(options, profileId, projectDictionaryState(state, profileId));
  }
  if (!sameJsonValue(options, { ...storedOptions, revision })) options.revision += 1;
  return checkedOptionsResult(message, { options });
}

// A personal package is pinned first and enabled in every profile of its
// language and appears in no other profile (section 15).
function assertPersonalPlacement(state, languages) {
  for (const row of state.dictionaries) {
    const language = personalDictionaryLanguage(row);
    if (language === null) continue;
    for (const [id, profile] of Object.entries(state.profiles)) {
      const index = profile.dictionaries.findIndex(entry => entry.id === row.id);
      if (languages.get(id) === language) {
        if (index !== 0 || profile.dictionaries[0].enabled !== true) {
          throw new Error("the managed custom dictionary must stay enabled and first");
        }
      } else if (index >= 0) {
        throw new Error("a personal dictionary belongs only to the profiles of its language");
      }
    }
  }
}

// An ordinary write of a schema-2 state may move nothing but the personal
// packages' presentation (assertOrdinaryCustomTransition, per language).
function assertOrdinaryPersonalTransition(current, next, languages) {
  const personalRows = rows => new Map(rows.filter(row => personalDictionaryLanguage(row) !== null).map(row => [row.id, row]));
  const before = personalRows(current?.dictionaries ?? []);
  const after = personalRows(next.dictionaries);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (!before.has(id) || !after.has(id)) {
      throw new Error("the managed custom dictionary can only be changed by its source editor");
    }
    if (!sameJsonValue(customPackageEngineState(before.get(id)), customPackageEngineState(after.get(id)))) {
      throw new Error("the managed custom dictionary must stay enabled and first");
    }
  }
  assertPersonalPlacement(next, languages);
}

// The shape of a whole schema-2 state an engine commit carries.
function assertProfileDictionaryState(next, storedOptions) {
  if (!Array.isArray(next?.dictionaries)) throw new TypeError("the dictionary state write carried no package list");
  const ids = new Set();
  for (const row of next.dictionaries) {
    if (typeof row?.id !== "string" || row.id === "" || ids.has(row.id)) {
      throw new TypeError("the dictionary state write carried an invalid package list");
    }
    ids.add(row.id);
  }
  const profiles = next.profiles;
  const expected = optionProfiles(storedOptions).map(profile => profile.id).sort((a, b) => a.localeCompare(b));
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)
      || !sameJsonValue(Object.keys(profiles).sort((a, b) => a.localeCompare(b)), expected)) {
    throw new TypeError("the dictionary state write does not match the installation's profiles");
  }
  for (const profile of Object.values(profiles)) {
    if (!Array.isArray(profile?.dictionaries) || !Array.isArray(profile.groups)) {
      throw new TypeError("the dictionary state write carried an invalid profile list");
    }
    const listed = new Set();
    for (const entry of profile.dictionaries) {
      if (!ids.has(entry?.id) || typeof entry.enabled !== "boolean" || listed.has(entry.id)) {
        throw new TypeError("the dictionary state write carried an invalid profile list");
      }
      listed.add(entry.id);
    }
  }
}

// A commit of a whole schema-2 state (section 5.2): each profile's groups are
// pruned against its own packages, and each profile's dictionary selections
// migrated and pruned against its own packages and groups.
function profileDictionaryCommit(current, currentOptions, next) {
  for (const dictionary of next.dictionaries) assertDictionaryUpdateSchedule(dictionary);
  const state = { schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA_VERSION, revision: (current?.revision ?? 0) + 1,
    dictionaries: next.dictionaries, profiles: {} };
  for (const [id, profile] of Object.entries(next.profiles)) {
    const members = projectDictionaryState({ ...state, profiles: { [id]: { dictionaries: profile.dictionaries, groups: [] } } }, id);
    state.profiles[id] = { dictionaries: profile.dictionaries, groups: pruneGroupMemberships(profile.groups, members.dictionaries) };
  }
  const values = { [DICTIONARY_STATE_KEY]: state };
  if (hasProfiles(currentOptions)) {
    const revision = optionsRevision(currentOptions);
    const record = applyOptionsPatch(currentOptions, {});
    const nextOptions = { ...record, profiles: record.profiles.map(profile => {
      const before = projectDictionaryState(current, profile.id);
      const after = projectDictionaryState(state, profile.id) ?? { dictionaries: [], groups: [] };
      return { ...profile, settings: normaliseDictionarySelections(
        migrateCommittedDictionarySelections(profile.settings, before, after.dictionaries), after.dictionaries, after.groups,
      ) };
    }) };
    if (!sameJsonValue(nextOptions, { ...currentOptions, revision })) values[OPTIONS_KEY] = { ...nextOptions, revision: revision + 1 };
  }
  return { state, values };
}

// A schema-1 view of one profile merged into the whole state: Settings names
// the profile it edits; a view that names none comes from code that predates
// profiles, lists every package and means the Japanese profile.
function profileViewCommit(message, current, currentOptions) {
  const legacy = message.profileId === undefined;
  const profileId = requestProfileId(message, currentOptions);
  const next = mergeDictionaryView(current, profileId,
    { dictionaries: message.dictionaries, groups: message.groups ?? projectDictionaryState(current, profileId)?.groups ?? [] },
    { legacy });
  assertOrdinaryPersonalTransition(current, next, profileLanguages(currentOptions));
  return profileDictionaryCommit(current, currentOptions, next);
}

// Section 9.3: once the records have profiles, the worker resolves the four
// lookups addressed to the engine. Each profile maps to its language, its
// enabled package ids in order and its pack settings' engine effects; the map
// is null while the records have none, so a Japanese-only request reaches the
// engine unchanged. initialiseSharing builds it at worker start and the
// storage listener in background.js keeps it current.
const PROFILE_LOOKUP_TYPES = new Set(["hd_lookup", "hd_lookup_dictionary", "hd_segment", "hd_kanji"]);
// Personal-dictionary saves are for the language of the profile they name.
const PROFILE_LANGUAGE_TYPES = new Set(["hd_custom_save", "hd_custom_append"]);
let lookupProfiles = null;

// The worker names the language, replacing any a forwarded request carried.
async function resolveRequestLanguage(message) {
  const { language, ...rest } = message;
  if (message.profileId === undefined) return rest;
  const stored = (await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY];
  return { ...rest, language: profileLanguages(stored).get(requestProfileId(message, stored)) };
}

// The ids of a pack's optional preprocessors, transforms and variant passes
// that the profile's boolean pack settings turn on (section 7.5).
function languageOptionsFor(language, packSettings) {
  const descriptor = languageDescriptor(language);
  return (Array.isArray(descriptor?.settings) ? descriptor.settings : []).flatMap(setting => {
    const effect = setting?.effect;
    const id = effect?.preprocessor ?? effect?.variantPass ?? null;
    if (setting.type !== "boolean" || packSettingValue(descriptor, packSettings, setting.id) !== true) return [];
    if (typeof id === "string") return [id];
    return Array.isArray(effect?.transforms) ? effect.transforms.filter(item => typeof item === "string") : [];
  });
}

function setLookupProfiles(storedOptions, storedState) {
  if (!hasProfiles(storedOptions)) {
    lookupProfiles = null;
    return;
  }
  lookupProfiles = new Map(optionProfiles(storedOptions).map(profile => {
    const view = projectDictionaryState(storedState ?? null, profile.id);
    return [profile.id, { language: profile.language,
      dictionaries: (view?.dictionaries ?? []).filter(row => row.enabled !== false).map(row => row.id),
      languageOptions: languageOptionsFor(profile.language, profile.packSettings) }];
  }));
}

// The records the map was built from; a storage event brings one of them.
let lookupRecords = { [OPTIONS_KEY]: undefined, [DICTIONARY_STATE_KEY]: undefined };

function updateLookupProfiles(changes) {
  lookupRecords = { ...lookupRecords, ...changes };
  setLookupProfiles(lookupRecords[OPTIONS_KEY], lookupRecords[DICTIONARY_STATE_KEY]);
  // The worker's debug log redacts the profiles' languages too (docs/languages.md 8.5).
  setDebugLogLanguages(lookupProfiles === null ? [] : [...lookupProfiles.values()].map(profile => profile.language));
}

// The worker sets these keys on every lookup, replacing any a forwarded
// request carried. A request that names no profile means the Japanese data:
// without a Japanese profile it selects no dictionaries and finds nothing. A
// profile the map has not seen yet (a storage event still on its way) is
// looked for once in storage before the request is refused.
async function resolveLookupProfile(message) {
  const { profileId, language, dictionaries, languageOptions, ...rest } = message;
  if (profileId !== undefined && !lookupProfiles?.has(profileId)) {
    const stored = await chrome.storage.local.get([OPTIONS_KEY, DICTIONARY_STATE_KEY]);
    updateLookupProfiles({ [OPTIONS_KEY]: stored[OPTIONS_KEY], [DICTIONARY_STATE_KEY]: stored[DICTIONARY_STATE_KEY] });
  }
  if (lookupProfiles === null) {
    // The single-profile shape: its only profile is Japanese.
    if (profileId !== JAPANESE_PROFILE_ID) throw profileError(PROFILE_REMOVED, "profile-missing");
    return rest;
  }
  if (profileId !== undefined) {
    const profile = lookupProfiles.get(profileId);
    if (!profile) throw profileError(PROFILE_REMOVED, "profile-missing");
    return { ...rest, profileId, language: profile.language, dictionaries: profile.dictionaries,
      languageOptions: profile.languageOptions };
  }
  const japanese = lookupProfiles.get(JAPANESE_PROFILE_ID);
  return japanese ? { ...rest, language: japanese.language, dictionaries: japanese.dictionaries, languageOptions: japanese.languageOptions }
    : { ...rest, language: JAPANESE_PROFILE_ID, dictionaries: [], languageOptions: [] };
}


async function removeLegacyDictionaryRows(current, legacyDictionaries) {
  if (current !== null || legacyDictionaries === null) return;
  try {
    await chrome.storage.local.remove(LEGACY_DICTIONARIES_KEY);
  } catch (error) {
    console.warn("hoshidicts: could not remove legacy dictionary rows:", describeErrorOrJson(error));
  }
}

function extensionPageSender(sender, page) {
  return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/u)[0] === chrome.runtime.getURL(page);
}

function startupSender(sender) {
  return extensionPageSender(sender, STARTUP_PAGE);
}

// The extension pages that load the reader themselves: first-run setup's
// practice and the search page (#610). Their messages may come without
// sender.tab and tabs hide their URLs, so the worker finds their documents
// through runtime.getContexts and answers them with runtime messages. The
// search page's reader is in search-frame.html (#644), whose requests
// search.html sends, except in Firefox before 154: there the frame is not
// sandboxed and sends its own.
function readerPageSender(sender) {
  return startupSender(sender) || extensionPageSender(sender, SEARCH_PAGE) || extensionPageSender(sender, SEARCH_FRAME);
}

// Only the search page's clipboard monitor may have the clipboard read (#639).
function searchPageSender(sender) {
  return extensionPageSender(sender, SEARCH_PAGE);
}

function optionsWriteConflict(message, options) {
  return checkedOptionsResult(message, { ok: false, conflict: true,
    error: "Settings changed in another page. Review your changes before saving again.", options });
}

function optionsWriteResult(message, patch, state, storedOptions) {
  if (!Number.isInteger(message.baseRevision) || message.baseRevision < 0) {
    throw new Error("the options write request carried no valid base revision");
  }
  assertDictionaryState(state);
  if (hasProfiles(storedOptions)) return profileOptionsWriteResult(message, patch, state, storedOptions);
  // The single-profile shape: its only profile is Japanese, whose pack
  // declares no settings of its own.
  if (message.profileId !== undefined) requestProfileId(message, storedOptions);
  if (message.packSettings !== undefined) applyPackSettingsPatch(storedOptions, message.packSettings, JAPANESE_PROFILE_ID);
  const revision = optionsRevision(storedOptions);
  const current = { ...projectStoredOptions(storedOptions), revision };
  if (message.baseRevision !== revision) return optionsWriteConflict(message, current);
  const patched = { ...current, ...patch };
  const options = state === null ? patched : normaliseDictionarySelections(patched, state.dictionaries, state.groups);
  if (!sameJsonValue(options, { ...storedOptions, revision })) options.revision += 1;
  return checkedOptionsResult(message, { options });
}

// One read-then-write at a time, so the check above cannot be overtaken by
// another worker-mediated write between its get and its set.
let storageTail = Promise.resolve();

function serialiseStorage(job) {
  const run = storageTail.then(job, job);
  storageTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function workerReply(message, result) {
  const { ok = true, error = null, ...payload } = result ?? {};
  return { type: `${message.type}_result`, requestId: message.requestId ?? null, ok, error, ...payload };
}

function checkedOptionsResult(message, result) {
  if (!responseFits(workerReply(message, result))) throw new Error(responseLimitError(message.type));
  return result;
}

function failureReply(message, error) {
  const description = describeErrorOrJson(error);
  recordDebugFailure(globalThis, message?.type ?? "hd_unknown", description);
  let errorCode = typeof error?.code === "string" ? error.code : null;
  if (errorCode === null && description === NOT_REACHABLE) {
    errorCode = "sharing-disconnected";
  }
  return boundResponseFailure({
    type: `${message?.type ?? "hd_unknown"}_result`,
    requestId: message?.requestId ?? null,
    ok: false,
    error: description,
    generation: 0,
    ...(errorCode === null ? {} : { errorCode }),
    ...(error?.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
  });
}

export {
  ANKI_TEMPLATE_CONFIG_KEYS, DEFAULT_OPTIONS, ankiTemplateConfig, normaliseOptions, projectStoredOptions,
  validateOptionsPatch, normaliseExternalUrl, pruneGroupMemberships, WORD_STATUS_OVERRIDES_KEY,
  normaliseWordStatusOverrides, withWordStatusOverride, OFFSCREEN_DOCUMENT, TARGET, UPDATE_TARGET, AUDIO_TARGET,
  SETUP_TARGET, PAGE_ZOOM_TARGET, BACKUP_LIFECYCLE_PORT, WORKER_TARGET, DICTIONARY_STATE_KEY, OPTIONS_KEY,
  CLIPBOARD_TARGET, searchPageSender,
  UPDATE_SETTINGS_KEY, engineSender, ankiSettingsSender, writeLocalState, sleep, ensureOffscreen, relay,
  readDictionaryStorage, normaliseDictionarySelections, assertDictionaryState, assertOrdinaryCustomTransition,
  assertCustomDictionaryCasRequest, dictionaryCommit, optionsRevision, removeLegacyDictionaryRows, startupSender,
  readerPageSender, optionsWriteConflict, optionsWriteResult, serialiseStorage, workerReply, checkedOptionsResult, failureReply,
  JAPANESE_PROFILE_ID, DICTIONARY_STATE_PROFILES_SCHEMA_VERSION, LANGUAGE_CODE, NO_JAPANESE_PROFILE, PROFILE_REMOVED, hasProfiles, hasDictionaryProfiles,
  optionProfiles, applyOptionsPatch, projectDictionaryState, profileError, requestProfileId, profileLanguages,
  assertPersonalPlacement, assertOrdinaryPersonalTransition, assertProfileDictionaryState, profileDictionaryCommit,
  profileViewCommit, updateLookupProfiles, languageDescriptor, LANGUAGE_SELECTION_KEY, normaliseLanguageSelection,
};
