// What the service worker's modules share: message targets, storage keys and reader options, the
// offscreen relay, the storage queue with the dictionary-state and options rules it writes, and reply shapes.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { recordDebugFailure } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import { ensureChromeOffscreen } from "./chrome-offscreen.js";
import "./reader-options.js";
import { ANKI_INDEX_KEY, ankiIndexConfigurationChange } from "./anki-index-cache.js";
import { NOT_REACHABLE } from "./sharing-client.js";
import "./external-links.js";
import "./dictionary-group-state.js";
import "./word-status-overrides.js";
import { assertDictionaryUpdateSchedule } from "./managed-dictionary-source.js";
import { CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_SOURCE_KEY, CUSTOM_DICTIONARY_TITLE } from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import { boundResponseFailure, responseFits, responseLimitError } from "./response-limits.js";
import { STARTUP_PAGE } from "./setup-state.js";

const {
  ANKI_TEMPLATE_CONFIG_KEYS, DEFAULT_OPTIONS, ankiTemplateConfig, hasCapability, normaliseOptions, projectStoredOptions,
  validateOptionsPatch,
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
const KANJI_SELECTION_KINDS = new Set(["term", "kanji"]);

function engineSender(sender) {
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
}

function ankiSettingsSender(sender) {
  return sender?.id === chrome.runtime.id
    && sender.url?.split(/[?#]/u)[0] === chrome.runtime.getURL("settings.html");
}

// Called within the background storage queue. Options and index invalidation
// share one write so a delayed storage event cannot publish an obsolete pull.
async function writeLocalState(values, store = chrome.storage.local) {
  if (store === chrome.storage.local && Object.hasOwn(values, OPTIONS_KEY)) {
    const stored = await chrome.storage.local.get([OPTIONS_KEY, ANKI_INDEX_KEY]);
    const index = await ankiIndexConfigurationChange(
      normaliseOptions(stored[OPTIONS_KEY]), normaliseOptions(values[OPTIONS_KEY]), stored[ANKI_INDEX_KEY],
    );
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

async function relay(message, stillCurrent = null) {
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

// The stored clicked-kanji selection after a dictionary or group change: a
// group keeps its stable ID through renames and membership edits and resets
// only when the group is removed, like a removed or disabled dictionary does.
function normaliseKanjiClickSelection(value, dictionaries, groups) {
  const selection = typeof value === "string" ? { title: value, kind: "" } : value;
  if (selection?.kind === "tabGroup") {
    return groups.some((group) => group.id === selection.id) ? value : "";
  }
  if (!selection?.title) return value;
  const selected = dictionaries.find((entry) => entry.title === selection.title);
  let kind = selection.kind;
  if (!KANJI_SELECTION_KINDS.has(kind)) {
    kind = selected && hasCapability(selected, "kanji") ? "kanji" : "term";
  }
  if (!selected || selected.enabled === false || !hasCapability(selected, kind)) return "";
  return KANJI_SELECTION_KINDS.has(selection.kind) ? value : { title: selection.title, kind };
}

function normaliseDictionarySelections(value, dictionaries, groups = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const options = { ...value };
  const selectedFrequency = dictionaries.find((entry) =>
    entry.title === options.frequencyDictionary);
  if (
    options.frequencyDictionary
    && (!selectedFrequency || selectedFrequency.enabled === false || !hasCapability(selectedFrequency, "freq"))
  ) {
    options.frequencyDictionary = "";
  }
  if (Object.hasOwn(options, "kanjiClickDictionary")) {
    options.kanjiClickDictionary = normaliseKanjiClickSelection(options.kanjiClickDictionary, dictionaries, groups);
  }
  return options;
}

function assertDictionaryState(state) {
  if (state !== null && state?.schemaVersion !== DICTIONARY_STATE_SCHEMA_VERSION) {
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

async function removeLegacyDictionaryRows(current, legacyDictionaries) {
  if (current !== null || legacyDictionaries === null) return;
  try {
    await chrome.storage.local.remove(LEGACY_DICTIONARIES_KEY);
  } catch (error) {
    console.warn("hoshidicts: could not remove legacy dictionary rows:", describeErrorOrJson(error));
  }
}

function startupSender(sender) {
  return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/u)[0] === chrome.runtime.getURL(STARTUP_PAGE);
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
  UPDATE_SETTINGS_KEY, engineSender, ankiSettingsSender, writeLocalState, sleep, ensureOffscreen, relay,
  readDictionaryStorage, normaliseDictionarySelections, assertDictionaryState, assertOrdinaryCustomTransition,
  assertCustomDictionaryCasRequest, dictionaryCommit, optionsRevision, removeLegacyDictionaryRows, startupSender,
  optionsWriteConflict, optionsWriteResult, serialiseStorage, workerReply, checkedOptionsResult, failureReply,
};
