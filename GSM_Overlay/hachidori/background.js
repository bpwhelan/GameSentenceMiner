import "./reader-options.js";
import { createAnkiGateway } from "./anki.js";
import { detectAnkiSetup, verifyAnkiSetup } from "./anki-setup.js";
import { createAnkiWorkerService } from "./anki-worker.js";
import { lookupAnkiIndex } from "./anki-index.js";
import { ANKI_INDEX_ALARM, ANKI_INDEX_KEY, ankiIndexConfigurationChange, createAnkiDuplicateIndex } from "./anki-index-cache.js";
import { createBackupDownloads } from "./backup-downloads.js";
import { assertBackupSnapshot, backupRevisions } from "./backup-state.js";
import { SHARING_HOST_ALARM, SHARING_KEY, createSharingHost } from "./sharing-host.js";
import { NOT_REACHABLE, SHARING_LOCAL_STATE_KEY, createSharingClient } from "./sharing-client.js";
import {
  FORWARDED_REQUESTS, LINKED_ANKI_CAPABILITY, LINKED_ANKI_UNSUPPORTED,
  allowLinkedAnkiDiscoveryRequest, allowLinkedAnkiRequest, allowLinkedAnkiSetupRequest,
  browserName, forwardableRequest, mutatingForwardedRequest, parseLinkAddress,
} from "./sharing-protocol.js";
import { LOOKUP_STATS_KEY, LOOKUP_STATS_ROW_PREFIX, assertLookupStatsDescriptor, assertLookupStatsRows, emptyLookupStats, incrementLookupStats, lookupStatsKey, lookupStatsPrefix, normaliseLookupTerm } from "./lookup-stats.js";
import "./external-links.js";
import "./dictionary-group-state.js";
import {
  assertDictionaryUpdateSchedule,
  httpsUrl,
  installedRecommendedDictionary,
  MANAGED_DICTIONARY_CHANGED,
  managedDictionaryFingerprint,
  managedDictionaryMatches,
  managedDictionarySource,
  managedUpdateSchedule,
  nextDictionaryUpdateCheck,
  nextManagedUpdateCheck,
  normaliseUpdateSettings,
  recommendedDictionarySource,
  recommendedIndexUrlMatches,
} from "./managed-dictionary-source.js";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
  CUSTOM_DICTIONARY_TITLE,
  assertCustomDictionaryCommit,
  assertCustomSourceState,
  customDictionarySemanticRevision,
  normaliseCustomDictionaryDocument,
  parseCustomDictionary,
} from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import {
  boundResponseFailure, responseFits, responseLimitError, validResponseRequestId,
} from "./response-limits.js";
import { HOST_CAPABILITIES, OVERLAY_MODE } from "./overlay-mode.js";
import {
  FIRST_INSTALL_OPTIONS, FIRST_INSTALL_SELECTIONS, OVERLAY_MODE_OPTIONS, SETUP_STATE_KEY, STARTUP_PAGE,
  RECOMMENDED_SELECTIONS_KEY, OVERLAY_LOCAL_OPTION_KEYS,
  advanceSetupState, initialSetupState, normaliseSetupState, overlayAnkiOptions, recordSetupAnki, recordSetupDictionaries,
} from "./setup-state.js";
import { applyCustomJavaScript } from "./custom-javascript.js";

const {
  DEFAULT_OPTIONS, normaliseOptions, projectStoredOptions, validateOptionsPatch,
} = globalThis.HDReaderOptions;
const { normaliseExternalUrl } = globalThis.HDExternalLinks;
const { pruneGroupMemberships } = globalThis.HDDictionaryGroups;

/*
 * Service worker for Hachidori.
 *
 * The worker holds no engine state: it only guarantees that the offscreen
 * document exists and relays requests to it. The engine lives in the offscreen
 * document because a service worker is torn down after 30 s idle, which would
 * throw away the loaded dictionaries.
 *
 * It owns the revisioned `dictionaryState` value and dictionary-backed option
 * writes in chrome.storage.local. An offscreen document is granted chrome.runtime
 * and nothing else -- no chrome.storage -- so every read and write the engine
 * needs arrives here as a message.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const OFFSCREEN_DOCUMENT = "offscreen.html";
const TARGET = "hoshidicts-offscreen";
const UPDATE_TARGET = "hachidori-updates";
const AUDIO_TARGET = "hachidori-audio";
const CAPTURE_TARGET = "hachidori-capture";
const CAPTURE_PAGE_TARGET = "hachidori-capture-page";
const CAPTURE_CONTENT_TARGET = "hachidori-capture-content";
const CAPTURE_DOCUMENT = "capture.html";
const SETUP_TARGET = "hachidori-setup";
const PAGE_ZOOM_TARGET = "hachidori-page-zoom";
const BACKUP_LIFECYCLE_PORT = "hachidori-backup-settings";

// Requests the worker answers itself. A second target is what keeps them out of
// the relay below: a message from the offscreen document carrying TARGET is
// indistinguishable from one sent by an extension page, so it would be stamped
// `relayed` and handed straight back to the offscreen document, where the
// engine's own request queue would then wait on itself.
const WORKER_TARGET = "hoshidicts-worker";
let ankiGateway, ankiMining, ankiDuplicateIndex;
let activeAnkiOperations = 0;
const ankiIdleWaiters = new Set();

function trackAnkiOperation(job) {
  activeAnkiOperations += 1;
  return Promise.resolve().then(job).finally(() => {
    activeAnkiOperations -= 1;
    if (activeAnkiOperations !== 0) return;
    for (const resolve of ankiIdleWaiters) resolve();
    ankiIdleWaiters.clear();
  });
}

function waitForAnkiIdle() {
  if (activeAnkiOperations === 0) return Promise.resolve();
  return new Promise(resolve => ankiIdleWaiters.add(resolve));
}
let backupDownloads;
// One first-run Anki detection at a time; duplicate startup pages share it.
let ankiSetupDetection = null;

function getBackupDownloads() {
  backupDownloads ??= createBackupDownloads(chrome, relay);
  return backupDownloads;
}

const DICTIONARY_STATE_KEY = "dictionaryState";
const LEGACY_DICTIONARIES_KEY = "dictionaries";
const OPTIONS_KEY = "options";
const UPDATE_SETTINGS_KEY = "dictionaryUpdates";
const UPDATE_ALARM = "hachidori-managed-dictionary-updates";
const DICTIONARY_STATE_SCHEMA_VERSION = 1;
const KANJI_SELECTION_KINDS = new Set(["term", "kanji"]);
const alarms = chrome.alarms ?? {
  async clear() { return false; },
  async get() { return undefined; },
  create() {},
};

// The user data a linked browser mirrors: the same five keys a backup carries,
// plus the lookup-count rows.
const SHARED_STATE_KEYS = [DICTIONARY_STATE_KEY, OPTIONS_KEY, CUSTOM_DICTIONARY_SOURCE_KEY, UPDATE_SETTINGS_KEY, LOOKUP_STATS_KEY];
// What this install is called by the ones it shares with or links to.
const SHARING_NAME = OVERLAY_MODE ? "GameSentenceMiner overlay" : browserName(globalThis.navigator);
let sharingHost;

function dictionaryCount(state) {
  return Array.isArray(state?.dictionaries) ? state.dictionaries.length : 0;
}

async function readSharedState() {
  const stored = await chrome.storage.local.get(SHARED_STATE_KEYS);
  return Object.fromEntries(SHARED_STATE_KEYS.map(key => [key, stored[key] ?? null]));
}

function getSharingHost() {
  sharingHost ??= createSharingHost({
    WebSocket: globalThis.WebSocket,
    alarms,
    dispatch: dispatchSharedRequest,
    readSnapshot: readSharedState,
    sharedKey: key => SHARED_STATE_KEYS.includes(key) || key.startsWith(LOOKUP_STATS_ROW_PREFIX),
    version: chrome.runtime.getManifest().version,
    name: SHARING_NAME,
  });
  return sharingHost;
}

// Client side: this install uses another Hachidori. `sharingLinked` is read
// synchronously by the interception points below after `sharingReady`.
let sharingClient;
let sharingLinked = false;
let sharingEpoch = 0;
let sharingReady = Promise.resolve();
let sharingTransitionTail = Promise.resolve();
const WORKER_FORWARDS = FORWARDED_REQUESTS[WORKER_TARGET];
const SHARING_OPTIONS_VERSION_KEY = "sharingOptionsVersion";
const OVERLAY_OPTIONS_STORAGE_KEYS = [OPTIONS_KEY, DICTIONARY_STATE_KEY, SHARING_LOCAL_STATE_KEY, SHARING_OPTIONS_VERSION_KEY];
const linkedAnkiConfigPrefix = `linked:${crypto.randomUUID()}:`;

function linkedAnkiConfigKey(configKey) {
  return `${linkedAnkiConfigPrefix}${String(configKey ?? "")}`;
}

function hostLinkedAnkiRequest(request) {
  if (typeof request?.configKey !== "string" || !request.configKey.startsWith(linkedAnkiConfigPrefix)) {
    throw new Error("Anki configuration changed. Refresh this result before adding a note.");
  }
  return { ...request, configKey: request.configKey.slice(linkedAnkiConfigPrefix.length) };
}

function engineSender(sender) {
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
}

function ankiSettingsSender(sender) {
  return sender?.id === chrome.runtime.id
    && sender.url?.split(/[?#]/u)[0] === chrome.runtime.getURL("settings.html");
}

// While linked, this install's own engine keeps reading and committing the
// state it had before linking, so its generations are never judged against
// the host's inventory that the mirror now holds under the live keys.
const sharingLocalStore = {
  async get(keys) {
    const record = (await chrome.storage.local.get(SHARING_LOCAL_STATE_KEY))[SHARING_LOCAL_STATE_KEY] ?? {};
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter(key => record[key] !== null && record[key] !== undefined).map(key => [key, record[key]]));
  },
  async set(values) {
    const record = (await chrome.storage.local.get(SHARING_LOCAL_STATE_KEY))[SHARING_LOCAL_STATE_KEY] ?? {};
    await chrome.storage.local.set({ [SHARING_LOCAL_STATE_KEY]: { ...record, ...values } });
  },
};

function stateStore(sender) {
  return sharingLinked && engineSender(sender) ? sharingLocalStore : chrome.storage.local;
}

function composeOverlayOptions(shared, local, revision) {
  const preferences = normaliseOptions(local);
  return { ...projectStoredOptions(shared),
    ...Object.fromEntries(OVERLAY_LOCAL_OPTION_KEYS.map(key => [key, preferences[key]])), revision };
}

// The offset keeps one increasing revision for existing readers and Settings,
// while retaining the host's actual CAS revision for forwarded writes.
function overlayHostOptionsValues(shared, stored, snapshot = false) {
  const previous = stored[SHARING_OPTIONS_VERSION_KEY];
  const hostRevision = optionsRevision(shared);
  if (previous && !snapshot && shared !== null && hostRevision < previous.hostRevision) return {};
  const revision = optionsRevision(stored[OPTIONS_KEY]);
  const offset = !previous || hostRevision < previous.hostRevision
    ? Math.max(previous?.offset ?? 0, revision + 1 - hostRevision) : previous.offset;
  return {
    [OPTIONS_KEY]: composeOverlayOptions(shared, stored[SHARING_LOCAL_STATE_KEY]?.options ?? stored[OPTIONS_KEY], hostRevision + offset),
    [SHARING_OPTIONS_VERSION_KEY]: { hostRevision, offset },
  };
}

// Mirror host batches together; overlay options additionally retain their
// local preferences and translate the host's revision for existing consumers.
async function applyMirror(changes, snapshot = false) {
  const values = {};
  const removals = [];
  if (OVERLAY_MODE && Object.hasOwn(changes, OPTIONS_KEY)) {
    Object.assign(values, overlayHostOptionsValues(changes[OPTIONS_KEY],
      await chrome.storage.local.get(OVERLAY_OPTIONS_STORAGE_KEYS), snapshot));
  }
  for (const [key, value] of Object.entries(changes)) {
    if (OVERLAY_MODE && key === OPTIONS_KEY) continue;
    if (value === null) removals.push(key);
    else values[key] = value;
  }
  if (Object.keys(values).length > 0) await chrome.storage.local.set(values);
  if (removals.length > 0) await chrome.storage.local.remove(removals);
}

function getSharingClient() {
  sharingClient ??= createSharingClient({
    WebSocket: globalThis.WebSocket,
    applyBatch: (changes, isCurrent, snapshot) => serialiseStorage(() => {
      // Unlink or a replacement connection may have retired this batch while
      // it waited behind the restoration's storage writes.
      if (sharingLinked && isCurrent()) return applyMirror(changes, snapshot);
    }),
    version: chrome.runtime.getManifest().version,
    name: SHARING_NAME,
  });
  return sharingClient;
}

function sharingStatus() {
  const client = getSharingClient().status();
  return { ...getSharingHost().status(), client: { ...client, display: client.address === null ? null : parseLinkAddress(client.address).display } };
}

function forwardToHost(message) {
  return getSharingClient().forward(message, {
    mutation: mutatingForwardedRequest(message),
  }).catch(error => failureReply(message, error));
}

function forwardWorkerRequest(message) {
  return OVERLAY_MODE && message.type === "hd_options_write" ? writeLinkedOverlayOptions(message) : forwardToHost(message);
}

async function readAnkiOptions() {
  const options = normaliseOptions((await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]);
  return OVERLAY_MODE ? overlayAnkiOptions(options) : options;
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

function getAnkiDuplicateIndex() {
  ankiDuplicateIndex ??= createAnkiDuplicateIndex({
    fetchRows: async source => {
      const reply = await relay({ target: "hachidori-anki-render", type: "hd_anki_index_refresh",
        requestId: `anki-index-${crypto.randomUUID()}`, source });
      if (!reply.ok) throw new Error(reply.error);
      return reply.rows;
    },
    lookupLive: (source, expression, invoke) => lookupAnkiIndex(invoke, source, expression),
    readOptions: readAnkiOptions,
    readState: async () => (await chrome.storage.local.get(ANKI_INDEX_KEY))[ANKI_INDEX_KEY],
    updateState: update => serialiseStorage(async () => {
      const stored = await chrome.storage.local.get([OPTIONS_KEY, ANKI_INDEX_KEY]);
      const state = stored[ANKI_INDEX_KEY];
      const next = await update({ options: normaliseOptions(stored[OPTIONS_KEY]), state });
      if (next !== undefined && !sameJsonValue(state, next)) {
        await writeLocalState({ [ANKI_INDEX_KEY]: next });
      }
      return next ?? state;
    }),
    alarms,
  });
  return ankiDuplicateIndex;
}
// A relayed request can arrive in the window between createDocument() resolving
// and offscreen.js running its module body, where nothing is listening yet.
const RELAY_ATTEMPTS = 5;
const RELAY_BACKOFF_MS = 40;
const NOT_LISTENING = /Receiving end does not exist|Could not establish connection/i;

let creating = null;
let latestAudioOperation = null;
let capturePage = null;
let captureRecovery = null;
let captureContentDocument = null;
let captureLink = null;

function describe(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function capturePageSender(sender) {
  return sender.id === chrome.runtime.id
    && sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT)
    && sender.tab === undefined;
}

function trustedCaptureControl(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  try {
    const url = new URL(sender.url);
    if (url.search) return false;
    url.hash = "";
    return ["settings.html", "toolbar.html", CAPTURE_DOCUMENT]
      .some(document => url.href === chrome.runtime.getURL(document));
  } catch {
    return false;
  }
}

async function relayCapture(message, stillCurrent = null) {
  if (!capturePage || captureRecovery) await recoverCaptureHost();
  if (stillCurrent && !stillCurrent()) return { ignored: true };
  return sendCapture(message);
}

async function sendCapture(message) {
  if (!capturePage?.documentId) throw new Error("The media capture host is unavailable.");
  const request = {
    ...message,
    target: CAPTURE_PAGE_TARGET,
    relayed: true,
    captureDocumentId: capturePage.documentId,
  };
  let reply;
  try {
    reply = await chrome.runtime.sendMessage(request);
  } catch (error) {
    capturePage = null;
    void unlinkCaptureContent();
    throw error;
  }
  if (!reply) {
    capturePage = null;
    void unlinkCaptureContent();
    throw new Error("The media capture host did not reply.");
  }
  if (!responseFits(reply)) throw new Error(responseLimitError(message.type));
  if (!reply.ok) throw new Error(reply.error || "The capture operation failed.");
  return reply;
}

async function recoverCaptureBinding(page) {
  if (captureContentDocument || captureLink?.captureSessionId || !page) return;
  assertCaptureTabId(page.tabId);
  if (!shortCaptureString(page.documentId)) throw new Error("The linked document identity is invalid.");
  const owner = capturePage;
  const identity = { tabId: page.tabId, documentId: page.documentId };
  const reply = await chrome.tabs.sendMessage(page.tabId, {
    target: CAPTURE_CONTENT_TARGET, type: "hd_capture_recover",
  }, { documentId: page.documentId }).catch(() => null);
  if (capturePage !== owner || captureContentDocument || captureLink?.captureSessionId) return;
  if (reply?.linked === true && reply.documentId === page.documentId) {
    captureContentDocument = identity;
  } else {
    await sendCapture({ type: "hd_capture_unlinked", ...identity,
      reason: "The reading document is no longer available. Link the page again." });
  }
}

async function recoverCaptureHost() {
  if (captureRecovery) return captureRecovery;
  if (capturePage) return;
  captureRecovery = (async () => {
    await ensureOffscreen();
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
    });
    if (capturePage || contexts.length !== 1) return;
    const context = contexts[0];
    capturePage = { documentId: context.documentId };
    const status = await sendCapture({ type: "hd_capture_status" });
    await recoverCaptureBinding(status.linkedPage);
  })();
  try { await captureRecovery; }
  finally { captureRecovery = null; }
}

function finiteCaptureTime(value) {
  return Number.isFinite(value) && Math.abs(value - Date.now()) <= 10 * 60 * 1000;
}

function shortCaptureString(value, limit = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function assertCaptureTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Choose a valid reading tab.");
}

async function captureTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => Number.isInteger(tab.id) && typeof tab.url === "string"
      && /^(https?|file):/u.test(tab.url))
    .map(tab => ({ id: tab.id, title: String(tab.title || "").slice(0, 200), url: tab.url.slice(0, 2048) }));
}

async function commandCaptureContent(tabId, type, fields = {}) {
  assertCaptureTabId(tabId);
  try {
    const reply = await chrome.tabs.sendMessage(tabId, {
      target: CAPTURE_CONTENT_TARGET,
      type,
      ...fields,
    }, { frameId: 0 });
    if (reply?.error) throw new Error(reply.error);
    return reply;
  } catch (error) {
    throw new Error(`The reading page is unavailable. Reload it and try again. ${describe(error)}`);
  }
}

function captureDocumentKey(tabId) {
  return `tab:${tabId}`;
}

async function unlinkCaptureContent() {
  const linked = captureContentDocument;
  if (!linked) return;
  try {
    await commandCaptureContent(linked.tabId, "hd_capture_unlink");
  } catch {
    // Navigation and tab closure already destroy the content-script state.
  }
  if (captureContentDocument?.tabId === linked.tabId
      && captureContentDocument.documentId === linked.documentId) {
    captureContentDocument = null;
  }
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
  });
  return contexts.length > 0;
}

async function createOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ["DOM_SCRAPING", "AUDIO_PLAYBACK", "DISPLAY_MEDIA"],
      justification:
        "Runs the dictionary engine and pronunciation audio, and owns explicitly started local display capture across control-page closure.",
    });
  } catch (error) {
    // Another extension context may have won the race; only a genuine absence
    // is a failure.
    if (!(await offscreenExists())) {
      throw error;
    }
  } finally {
    creating = null;
  }
}

// createDocument() rejects when called while another call is in flight, so every
// caller waits on the same promise.
async function ensureOffscreen() {
  if (typeof chrome.runtime.getContexts !== "function"
      || typeof chrome.offscreen?.createDocument !== "function") {
    // Some extension hosts keep this page alive themselves instead of exposing
    // Chrome's offscreen-document lifecycle API.
    return;
  }
  if (await offscreenExists()) {
    return;
  }
  if (creating === null) {
    creating = createOffscreen();
  }
  await creating;
}

async function relay(message, stillCurrent = null) {
  let failure = null;
  for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt += 1) {
    await ensureOffscreen();
    if (stillCurrent && !stillCurrent()) {
      return { type: `${message.type}_result`, requestId: message.requestId, ok: true, status: "cancelled" };
    }
    try {
      // `relayed` is what lets offscreen.js ignore the copy of this message that
      // chrome.runtime.sendMessage also delivers to it directly, so a request
      // from an extension page runs on the engine exactly once.
      const reply = await chrome.runtime.sendMessage({ ...message, relayed: true });
      if (reply !== undefined) {
        return reply;
      }
      failure = new Error("offscreen document sent no reply");
    } catch (error) {
      if (!NOT_LISTENING.test(describe(error))) {
        throw error;
      }
      failure = error;
    }
    await sleep(RELAY_BACKOFF_MS * (attempt + 1));
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

async function readUpdateSettings() {
  const stored = await chrome.storage.local.get(UPDATE_SETTINGS_KEY);
  return normaliseUpdateSettings(stored?.[UPDATE_SETTINGS_KEY]);
}

function hasCapability(dictionary, kind) {
  if (kind === "freq") return dictionary.frequencyCount > 0;
  if (kind === "kanji") return dictionary.kanjiCount > 0;
  if (dictionary.termCount > 0) return true;
  return dictionary.frequencyCount === 0 && dictionary.pitchCount === 0 && dictionary.kanjiCount === 0;
}

function normaliseDictionarySelections(value, dictionaries) {
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

  const selection = typeof options.kanjiClickDictionary === "string"
    ? { title: options.kanjiClickDictionary, kind: "" }
    : options.kanjiClickDictionary;
  if (selection?.title) {
    const selected = dictionaries.find((entry) => entry.title === selection.title);
    let kind = selection.kind;
    if (!KANJI_SELECTION_KINDS.has(kind)) {
      kind = selected && hasCapability(selected, "kanji") ? "kanji" : "term";
    }
    if (!selected || selected.enabled === false || !hasCapability(selected, kind)) {
      options.kanjiClickDictionary = "";
    } else if (!KANJI_SELECTION_KINDS.has(selection.kind)) {
      options.kanjiClickDictionary = { title: selection.title, kind };
    }
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
      { ...projectStoredOptions(currentOptions), revision }, state.dictionaries,
    );
    if (nextOptions.popupImageSource?.kind === "dictionary") {
      const title = committedSelectionTitle(nextOptions.popupImageSource.title, current, dictionaries);
      nextOptions.popupImageSource = title ? { kind: "dictionary", title } : null;
    }
    if (nextOptions.pitchAccentFuriganaDictionary) {
      nextOptions.pitchAccentFuriganaDictionary = committedSelectionTitle(
        nextOptions.pitchAccentFuriganaDictionary, current, dictionaries,
      );
    }
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
    console.warn("hoshidicts: could not remove legacy dictionary rows:", describe(error));
  }
}

// The engine or settings page reads state, changes it, and sends it back a
// message round trip later. A caller includes the revision it read so a stale
// write cannot discard a change made by another extension context.
async function lookupStatisticsStorage(message, record) {
  const term = normaliseLookupTerm(message.term, message.reading);
  const stored = await chrome.storage.local.get([LOOKUP_STATS_KEY, OPTIONS_KEY]);
  let descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
  assertLookupStatsDescriptor(descriptor);
  const storedOptions = stored[OPTIONS_KEY];
  if (storedOptions?.showLookupCounts === false) {
    return { descriptor, statistics: null };
  }
  const key = lookupStatsKey(descriptor, term);
  let row = descriptor.generation === null ? undefined : (await chrome.storage.local.get(key))[key];
  if (record) {
    row = incrementLookupStats(row, term, Date.now());
    descriptor = { generation: descriptor.generation ?? crypto.randomUUID(), revision: descriptor.revision + 1 };
    assertLookupStatsDescriptor(descriptor);
    await writeLocalState({ [LOOKUP_STATS_KEY]: descriptor, [lookupStatsKey(descriptor, term)]: row });
  } else if (row !== undefined) {
    assertLookupStatsRows(descriptor, [row]);
    if (lookupStatsKey(descriptor, row) !== key) throw new Error("The lookup statistics row does not match its key.");
  }
  return {
    descriptor,
    statistics: row ?? { ...term, lookupCount: 0 },
  };
}

function lookupStatistics(message, record) {
  return serialiseStorage(
    () => lookupStatisticsStorage(message, record),
  );
}

function assertBackupEngineSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT)) {
    throw new Error("Backup restore and cleanup must be requested by the dictionary engine.");
  }
}

const WORKER_HANDLERS = {
  hd_lookup_stats_record(message) { return lookupStatistics(message, true); },
  hd_lookup_stats_read(message) { return lookupStatistics(message, false); },
  async hd_lookup_stats_cleanup(_message, sender) {
    assertBackupEngineSender(sender);
    const stored = await chrome.storage.local.get(null);
    const descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
    assertLookupStatsDescriptor(descriptor);
    const prefix = lookupStatsPrefix(descriptor);
    const unused = Object.keys(stored).filter(key => key.startsWith(LOOKUP_STATS_ROW_PREFIX) && !key.startsWith(prefix));
    if (unused.length > 0) await chrome.storage.local.remove(unused);
    return {};
  },
  async hd_backup_download(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("settings.html")) {
      throw new Error("Backup downloads are available only from Hachidori Settings.");
    }
    return getBackupDownloads().download();
  },
  async hd_backup_base_read() {
    const stored = await chrome.storage.local.get([
      DICTIONARY_STATE_KEY, OPTIONS_KEY, CUSTOM_DICTIONARY_SOURCE_KEY, UPDATE_SETTINGS_KEY, LOOKUP_STATS_KEY,
    ]);
    return { snapshot: {
      state: stored[DICTIONARY_STATE_KEY] ?? null,
      options: stored[OPTIONS_KEY] ?? null,
      document: stored[CUSTOM_DICTIONARY_SOURCE_KEY] ?? null,
      updates: stored[UPDATE_SETTINGS_KEY] ?? null,
      lookupStats: stored[LOOKUP_STATS_KEY] ?? null,
    } };
  },

  async hd_backup_read() {
    const { snapshot } = await WORKER_HANDLERS.hd_backup_base_read();
    const stored = await chrome.storage.local.get(null);
    const descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
    assertLookupStatsDescriptor(descriptor);
    const prefix = lookupStatsPrefix(descriptor);
    const lookupStatsRows = Object.entries(stored).filter(([key]) => key.startsWith(prefix)).map(([key, row]) => {
      if (lookupStatsKey(descriptor, row) !== key) throw new Error("The lookup statistics row does not match its key.");
      return row;
    });
    assertLookupStatsRows(descriptor, lookupStatsRows);
    return { snapshot: {
      state: snapshot.state,
      options: { ...projectStoredOptions(snapshot.options), revision: optionsRevision(snapshot.options) },
      document: normaliseCustomDictionaryDocument(snapshot.document),
      updates: normaliseUpdateSettings(snapshot.updates),
      lookupStats: descriptor,
    }, lookupStatsRows };
  },

  async hd_backup_cas(message, sender) {
    assertBackupEngineSender(sender);
    const { snapshot: current } = await WORKER_HANDLERS.hd_backup_base_read();
    if (!sameJsonValue(message.base, current)) {
      return { ok: false, conflict: true, error: "Hachidori changed since this backup was prepared. Prepare it again before restoring." };
    }
    const snapshot = message.snapshot;
    await assertBackupSnapshot(snapshot);
    assertLookupStatsRows(snapshot.lookupStats, message.lookupStatsRows);
    if (snapshot.lookupStats.generation === null || snapshot.lookupStats.generation === current.lookupStats?.generation) {
      throw new Error("A backup restore requires a fresh lookup statistics namespace.");
    }
    const expected = Object.fromEntries(Object.entries(backupRevisions(current)).map(([key, revision]) => [key, revision + 1]));
    if (!sameJsonValue(backupRevisions(snapshot), expected)) throw new Error("Invalid backup restore revisions.");
    if (!sameJsonValue(snapshot.options, normaliseDictionarySelections(snapshot.options, snapshot.state.dictionaries))) {
      throw new Error("The backup reader settings refer to unavailable dictionaries.");
    }
    await writeLocalState({
      [DICTIONARY_STATE_KEY]: snapshot.state,
      [OPTIONS_KEY]: snapshot.options,
      [CUSTOM_DICTIONARY_SOURCE_KEY]: snapshot.document,
      [UPDATE_SETTINGS_KEY]: snapshot.updates,
      [LOOKUP_STATS_KEY]: snapshot.lookupStats,
      ...Object.fromEntries(message.lookupStatsRows.map(row => [lookupStatsKey(snapshot.lookupStats, row), row])),
    });
    return { snapshot };
  },

  async hd_anki_discover(message, sender) {
    if (!ankiSettingsSender(sender)) {
      throw new Error("Anki discovery is available only from Hachidori Settings");
    }
    if (typeof message.model !== "string" || typeof message.apiKey !== "string") {
      throw new TypeError("Anki discovery requires a note type and API key string");
    }
    ankiGateway ??= createAnkiGateway();
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    const url = message.url === undefined ? normaliseOptions(stored[OPTIONS_KEY]).anki.url : message.url;
    return ankiGateway.discover({ model: message.model, apiKey: message.apiKey, url });
  },
  async hd_anki_setup(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("settings.html")) {
      throw new Error("Anki setup discovery is available only from Hachidori Settings");
    }
    // Settings owns the draft and saves a proposal through its ordinary options
    // CAS. Discovery itself neither changes options nor records onboarding.
    return checkAnkiSetup(validateOptionsPatch({ anki: message.anki }).anki);
  },
  async hd_open_external(message, sender) {
    if (sender.id !== chrome.runtime.id) throw new Error("external link request came from another extension");
    const url = normaliseExternalUrl(message.url);
    if (!url) throw new TypeError("external link URL is invalid");
    const active = message.active === undefined ? true : message.active;
    if (typeof active !== "boolean") throw new TypeError("external link activation is invalid");
    await chrome.tabs.create({ url, active, ...(sender.tab ? { windowId: sender.tab.windowId } : {}) });
    return { opened: true };
  },

  async hd_state_read(message, sender) {
    const { state, legacyDictionaries } = await readDictionaryStorage(false, stateStore(sender));
    return { state, legacyDictionaries };
  },

  async hd_state_cas(message, sender) {
    const store = stateStore(sender);
    if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
      throw new Error("the dictionary state write request carried no valid base revision");
    }
    if (!Array.isArray(message?.dictionaries)) {
      throw new TypeError("the dictionary state write request carried no list");
    }
    if (message.groups !== undefined && !Array.isArray(message.groups)) {
      throw new TypeError("the dictionary state write request carried invalid groups");
    }

    const { state: current, legacyDictionaries, options: currentOptions } = await readDictionaryStorage(false, store);
    assertDictionaryState(current);
    const currentRevision = current?.revision ?? 0;
    if (message.baseRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        error: "the dictionary state changed while it was being written",
        state: current,
      };
    }

    try {
      assertOrdinaryCustomTransition(current?.dictionaries ?? [], message.dictionaries);
    } catch (error) {
      return {
        ok: false,
        protected: true,
        error: describe(error),
        state: current,
      };
    }
    const { state, values } = dictionaryCommit(
      current,
      currentOptions,
      message.dictionaries,
      message.groups,
    );
    await writeLocalState(values, store);
    await removeLegacyDictionaryRows(current, legacyDictionaries);
    return { state };
  },

  async hd_custom_read(message, sender) {
    const { state, customDocument } = await readDictionaryStorage(true, stateStore(sender));
    assertDictionaryState(state);
    return {
      document: normaliseCustomDictionaryDocument(customDocument),
      state,
    };
  },

  async hd_custom_cas(message, sender) {
    const store = stateStore(sender);
    const changesDictionaryState = assertCustomDictionaryCasRequest(message);

    const {
      state: current,
      legacyDictionaries,
      options: currentOptions,
      customDocument: storedDocument,
    } = await readDictionaryStorage(true, store);
    assertDictionaryState(current);
    const document = normaliseCustomDictionaryDocument(storedDocument);
    if (message.baseDocumentRevision !== document.revision) {
      return {
        ok: false,
        stale: true,
        error: "the custom dictionary source changed while it was being saved",
        document,
        state: current,
      };
    }
    const currentRevision = current?.revision ?? 0;
    if (message.baseRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        error: "the dictionary state changed while the custom dictionary was being saved",
        document,
        state: current,
      };
    }
    const parsed = parseCustomDictionary(message.text);
    const calculatedRevision = await customDictionarySemanticRevision(parsed.entries);
    if (calculatedRevision !== message.semanticRevision) {
      throw new Error("the custom dictionary semantic revision does not match its source");
    }
    assertCustomSourceState(
      changesDictionaryState ? message.dictionaries : current?.dictionaries ?? [],
      calculatedRevision,
      parsed.entries.length,
    );

    const documentChanged = document.text !== message.text
      || document.semanticRevision !== message.semanticRevision;
    const nextDocument = documentChanged
      ? {
          schemaVersion: CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
          revision: document.revision + 1,
          semanticRevision: message.semanticRevision,
          text: message.text,
        }
      : document;
    let state = current;
    const values = {};
    if (documentChanged) {
      values[CUSTOM_DICTIONARY_SOURCE_KEY] = nextDocument;
    }
    if (changesDictionaryState) {
      assertCustomDictionaryCommit(message.dictionaries);
      const nextGroups = pruneGroupMemberships(
        message.groups ?? current?.groups,
        message.dictionaries,
      );
      const dictionaryChanged = current === null
        || !sameJsonValue(current.dictionaries, message.dictionaries)
        || !sameJsonValue(current.groups, nextGroups);
      if (dictionaryChanged) {
        const commit = dictionaryCommit(
          current,
          currentOptions,
          message.dictionaries,
          nextGroups,
        );
        state = commit.state;
        Object.assign(values, commit.values);
      }
    }
    if (Object.keys(values).length > 0) {
      await writeLocalState(values, store);
      if (state !== current) {
        await removeLegacyDictionaryRows(current, legacyDictionaries);
      }
    }
    return { document: nextDocument, state };
  },

  async hd_options_write(message) {
    const patch = validateOptionsPatch(message.options);
    const { state, options: currentOptions } = await readDictionaryStorage();
    const result = optionsWriteResult(message, patch, state, currentOptions);
    if (result.ok !== false && result.options.revision !== optionsRevision(currentOptions)) {
      await writeLocalState({ [OPTIONS_KEY]: result.options });
    }
    return result;
  },

  async hd_setup_cas(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL(STARTUP_PAGE)) {
      throw new Error("Setup progress can be changed only from the Hachidori startup page.");
    }
    if (!Number.isInteger(message.baseRevision) || message.baseRevision < 0) {
      throw new Error("the setup write request carried no valid base revision");
    }
    if (message.continued !== undefined && typeof message.continued !== "boolean") {
      throw new Error("the setup write request carried an invalid continuation flag");
    }
    const stored = await chrome.storage.local.get(SETUP_STATE_KEY);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    if (current === null) throw new Error("Setup has not started on this installation.");
    if (message.baseRevision !== current.revision) {
      return { ok: false, conflict: true, error: "Setup changed in another tab.", state: current };
    }
    const state = advanceSetupState(current, message.stage, new Date().toISOString(), { continued: message.continued === true });
    await writeLocalState({ [SETUP_STATE_KEY]: state });
    return { state };
  },

  // The offscreen installer reports each dictionary outcome and each run's
  // duration; a committed catalogue entry also settles its first-install
  // selection exactly once.
  // The startup page asks once for Anki detection; the reply carries the
  // settled outcome, which is also the durable record every later page reads.
  async hd_setup_anki(message, sender) {
    if (!startupSender(sender)) throw new Error("Anki setup is available only from the Hachidori startup page.");
    const stored = await chrome.storage.local.get(SETUP_STATE_KEY);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    if (current === null) throw new Error("Setup has not started on this installation.");
    if (current.stage === "welcome") throw new Error("Start setup before checking Anki.");
    if (current.anki !== null) return { state: current };
    ankiSetupDetection ??= detectFirstRunAnki().finally(() => { ankiSetupDetection = null; });
    return ankiSetupDetection;
  },

  async hd_setup_record(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT)) {
      throw new Error("Setup outcomes are recorded only by the dictionary engine host.");
    }
    const outcomes = message.outcomes ?? {};
    if (!outcomes || typeof outcomes !== "object" || Array.isArray(outcomes)
        || !Object.keys(outcomes).every((sourceId) => recommendedDictionarySource(sourceId) !== null)) {
      throw new Error("the setup record names an unknown catalogue source");
    }
    const stored = await chrome.storage.local.get([SETUP_STATE_KEY, DICTIONARY_STATE_KEY, OPTIONS_KEY, RECOMMENDED_SELECTIONS_KEY]);
    const store = stateStore(sender);
    const library = store === chrome.storage.local ? stored : await store.get([DICTIONARY_STATE_KEY, OPTIONS_KEY]);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    const previousSelections = stored[RECOMMENDED_SELECTIONS_KEY] ?? current?.dictionaries.selectionsApplied ?? [];
    const selections = firstInstallSelections(previousSelections, outcomes, library[DICTIONARY_STATE_KEY], library[OPTIONS_KEY]);
    const state = recordSetupDictionaries(message.recordSetup === false ? null : current, {
      runId: message.runId, outcomes, runSeconds: message.runSeconds ?? null, selectionsApplied: selections.applied,
    });
    const values = state === null ? {} : { [SETUP_STATE_KEY]: state };
    if (selections.applied.length > 0) values[RECOMMENDED_SELECTIONS_KEY] = [...new Set([...previousSelections, ...selections.applied])];
    if (selections.options !== null) {
      if (store === chrome.storage.local) values[OPTIONS_KEY] = selections.options;
      else {
        const captured = (await chrome.storage.local.get(SHARING_LOCAL_STATE_KEY))[SHARING_LOCAL_STATE_KEY];
        values[SHARING_LOCAL_STATE_KEY] = { ...captured, options: selections.options };
      }
    }
    if (Object.keys(values).length > 0) await writeLocalState(values);
    return { state };
  },
};

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
  const options = state === null ? patched : normaliseDictionarySelections(patched, state.dictionaries);
  if (!sameJsonValue(options, { ...storedOptions, revision })) options.revision += 1;
  return checkedOptionsResult(message, { options });
}

function localOverlayOptionsValues(options, patch, stored) {
  const changed = options.revision - optionsRevision(stored[OPTIONS_KEY]);
  if (changed === 0) return {};
  const version = stored[SHARING_OPTIONS_VERSION_KEY];
  const values = { [OPTIONS_KEY]: options,
    [SHARING_OPTIONS_VERSION_KEY]: { ...version, offset: version.offset + changed } };
  const captured = stored[SHARING_LOCAL_STATE_KEY];
  if (captured) values[SHARING_LOCAL_STATE_KEY] = { ...captured,
    options: { ...captured.options, ...patch, revision: optionsRevision(captured.options) + 1 } };
  return values;
}

async function prepareOverlayOptionsWrite(message) {
  if (!sharingLinked) return { reply: workerReply(message, await WORKER_HANDLERS.hd_options_write(message)) };
  const patch = validateOptionsPatch(message.options);
  const stored = await chrome.storage.local.get(OVERLAY_OPTIONS_STORAGE_KEYS);
  const result = optionsWriteResult(message, patch, stored[DICTIONARY_STATE_KEY] ?? null, stored[OPTIONS_KEY]);
  if (result.ok === false) return { reply: workerReply(message, result) };
  const local = {}, shared = {};
  for (const [key, value] of Object.entries(patch)) {
    (OVERLAY_LOCAL_OPTION_KEYS.includes(key) ? local : shared)[key] = value;
  }
  if (Object.keys(shared).length === 0) {
    const values = localOverlayOptionsValues(result.options, local, stored);
    if (Object.keys(values).length > 0) await writeLocalState(values);
    return { reply: workerReply(message, result) };
  }
  return { local, shared, version: stored[SHARING_OPTIONS_VERSION_KEY], epoch: sharingEpoch };
}

async function finishOverlayOptionsWrite(message, prepared, reply) {
  const stored = await chrome.storage.local.get(OVERLAY_OPTIONS_STORAGE_KEYS);
  // Link/Unlink and local edits remain available during the network wait. A
  // reply for the former owner must not change the newly selected installation.
  if (!sharingLinked || prepared.epoch !== sharingEpoch) {
    return workerReply(message, optionsWriteConflict(message, stored[OPTIONS_KEY]));
  }
  if (!reply.options) return reply;
  const version = stored[SHARING_OPTIONS_VERSION_KEY];
  const values = overlayHostOptionsValues(reply.options, stored);
  const current = values[OPTIONS_KEY] ?? stored[OPTIONS_KEY];
  let result;
  if (reply.ok !== false && (version.offset !== prepared.version.offset || optionsRevision(reply.options) < version.hostRevision)) {
    result = workerReply(message, optionsWriteConflict(message, current));
  } else {
    let options = current;
    if (reply.ok !== false) {
      options = { ...current, ...prepared.local };
      if (Object.entries(prepared.local).some(([key, value]) => current[key] !== value)) options.revision += 1;
      Object.assign(values, localOverlayOptionsValues(options, prepared.local, { ...stored, ...values }));
    }
    result = checkedOptionsResult(message, { ...reply, options });
  }
  if (Object.keys(values).length > 0) await writeLocalState(values);
  return result;
}

async function writeLinkedOverlayOptions(message) {
  const prepared = await serialiseStorage(() => prepareOverlayOptionsWrite(message));
  if (prepared.reply) return prepared.reply;
  const reply = await forwardToHost({ ...message, options: prepared.shared, baseRevision: prepared.version.hostRevision });
  return serialiseStorage(() => finishOverlayOptionsWrite(message, prepared, reply));
}

// Ordinary absence is a connection that never answered; an answer that refused
// or failed keeps its specific reason.
function ankiSetupFailure(error) {
  const detail = describe(error);
  const unavailable = /Open Anki with the AnkiConnect add-on|timed out/iu.test(detail);
  return { status: unavailable ? "unavailable" : "needs-attention", detail, model: null, deck: null };
}

// One read-only conversation with Anki: an unconfigured profile is offered a
// proposal, and a mapping the user already saved is verified the way Settings
// verifies it, never replaced. Nothing here holds the storage queue.
async function checkAnkiSetup(anki) {
  ankiGateway ??= createAnkiGateway();
  const invoke = (action, params) => ankiGateway.invoke(action, params, anki.apiKey, undefined, anki.url);
  try {
    const proposal = anki.model === "" ? await detectAnkiSetup(invoke, anki) : await verifyAnkiSetup(invoke, anki);
    return { proposal, outcome: { status: proposal.status, detail: proposal.detail, model: proposal.model, deck: proposal.deck } };
  } catch (error) {
    // Nothing is claimed about a mapping that could not be checked: the
    // connection's own reason is the outcome, and the mapping is left untouched.
    return { proposal: null, outcome: ankiSetupFailure(error) };
  }
}

// The check runs outside the storage queue, so the mapping it judged can change
// while it runs. Such a check is stale: the write is abandoned and the mapping
// now stored is checked instead. Only a mapping that stops changing can be
// recorded, so a user still editing Anki settings gets that reason and the link.
const ANKI_SETUP_ATTEMPTS = 3;
const ANKI_SETUP_CHANGED = "Anki settings changed while setup checked them. Confirm the mapping in Settings.";

async function detectFirstRunAnki() {
  for (let attempt = 1; ; attempt += 1) {
    const stored = await chrome.storage.local.get([SETUP_STATE_KEY, OPTIONS_KEY]);
    const options = normaliseOptions(stored[OPTIONS_KEY]);
    const last = attempt >= ANKI_SETUP_ATTEMPTS;
    const { proposal, outcome } = await checkAnkiSetup(options.anki);
    const written = await serialiseStorage(async () => {
      const current = await chrome.storage.local.get([SETUP_STATE_KEY, OPTIONS_KEY]);
      const setup = normaliseSetupState(current[SETUP_STATE_KEY]);
      if (setup === null) throw new Error("Setup has not started on this installation.");
      if (setup.anki !== null) return { state: setup };
      const stale = !sameJsonValue(normaliseOptions(current[OPTIONS_KEY]).anki, options.anki);
      if (stale && !last) return null;
      const values = {};
      if (!stale && proposal?.status === "configured") {
        const revision = optionsRevision(current[OPTIONS_KEY]);
        const anki = { ...options.anki, model: proposal.model, deck: proposal.deck, fieldTemplates: proposal.fieldTemplates };
        values[OPTIONS_KEY] = { ...projectStoredOptions(current[OPTIONS_KEY]), ...validateOptionsPatch({ anki }), revision: revision + 1 };
      }
      const state = recordSetupAnki(setup, stale
        ? { status: "needs-attention", detail: ANKI_SETUP_CHANGED, model: null, deck: null }
        : outcome);
      values[SETUP_STATE_KEY] = state;
      await writeLocalState(values);
      return { state };
    });
    if (written !== null) return written;
  }
}

// Dictionary-dependent initial preferences follow the committed entry's exact
// title, whether setup installed it or found it installed. Each is consumed
// once; an option the user already changed is left alone.
function firstInstallSelections(previousSelections, outcomes, dictionaryState, storedOptions) {
  const dictionaries = dictionaryState?.dictionaries ?? [];
  const effective = normaliseOptions(storedOptions);
  const applied = [];
  const patch = {};
  for (const [sourceId, rule] of Object.entries(FIRST_INSTALL_SELECTIONS)) {
    if (!["installed", "already-installed"].includes(outcomes[sourceId]?.status)
        || previousSelections.includes(sourceId)) continue;
    // The same catalogue identity the installer uses, so a package carried in
    // or imported by hand, which is recognised by its exact update index, is
    // the entry the selection follows.
    const source = recommendedDictionarySource(sourceId);
    const committed = source === null ? null : installedRecommendedDictionary(source, dictionaries);
    if (committed === null) continue;
    applied.push(sourceId);
    if (effective[rule.option] === "") patch[rule.option] = rule.select(committed.title);
  }
  if (Object.keys(patch).length === 0) return { applied, options: null };
  const revision = optionsRevision(storedOptions);
  const options = normaliseDictionarySelections(
    { ...projectStoredOptions(storedOptions), ...validateOptionsPatch(patch), revision }, dictionaries,
  );
  return { applied, options: sameJsonValue(options, { ...storedOptions, revision }) ? null : { ...options, revision: revision + 1 } };
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

async function writeUpdateSettings(update) {
  return serialiseStorage(async () => {
    const current = await readUpdateSettings();
    const next = update(current);
    if (next === null) return { ok: false, error: "The update settings changed elsewhere. Review the current schedule before retrying.", settings: current };
    if (sameJsonValue(next, current)) return { settings: current };
    const settings = { ...next, revision: current.revision + 1 };
    await writeLocalState({ [UPDATE_SETTINGS_KEY]: settings });
    return { settings };
  });
}

async function updateDictionaryCheck(fingerprint, lastUpdateCheck) {
  return serialiseStorage(async () => {
    const { state } = await readDictionaryStorage();
    const index = state?.dictionaries?.findIndex(
      (dictionary) => dictionary?.id === fingerprint.id,
    ) ?? -1;
    if (index < 0 || !managedDictionaryMatches(state.dictionaries[index], fingerprint)) {
      return null;
    }
    const dictionaries = [...state.dictionaries];
    dictionaries[index] = { ...dictionaries[index], lastUpdateCheck };
    const reply = await WORKER_HANDLERS.hd_state_cas({
      baseRevision: state.revision,
      dictionaries,
    });
    if (reply.ok === false) {
      throw new Error(reply.error || "the dictionary update state could not be saved");
    }
    return reply.state.dictionaries.find((dictionary) => dictionary?.id === fingerprint.id) ?? null;
  });
}

async function managedCandidates(dictionaryIds) {
  const selected = dictionaryIds === null ? null : new Set(dictionaryIds);
  const { state } = await serialiseStorage(readDictionaryStorage);
  return (state?.dictionaries ?? []).flatMap((dictionary) => {
    if (selected !== null && !selected.has(dictionary?.id)) {
      return [];
    }
    const fingerprint = managedDictionaryFingerprint(dictionary);
    return fingerprint === null ? [] : [{
      id: dictionary.id,
      title: dictionary.displayName || dictionary.title,
      fingerprint,
    }];
  });
}

async function remoteUpdate(candidate) {
  const { source } = candidate.fingerprint;
  const response = await fetch(source.indexUrl, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`update index request failed with HTTP ${response.status}`);
  }
  if (source.kind === "recommended"
      && !recommendedIndexUrlMatches(recommendedDictionarySource(source.sourceId), response.url)) {
    throw new Error("update index downloaded from an unexpected final URL");
  }
  if (source.kind === "generic" && httpsUrl(response.url) === null) {
    throw new Error("update index redirected to a non-HTTPS URL");
  }
  const index = await response.json();
  if (typeof index?.revision !== "string" || index.revision === "") {
    throw new Error("update index did not declare a revision");
  }
  let archiveUrl = source.downloadUrl;
  if (source.kind === "generic"
      && typeof index.downloadUrl === "string"
      && index.downloadUrl !== "") {
    archiveUrl = httpsUrl(index.downloadUrl);
    if (archiveUrl === null) {
      throw new Error("update index returned a non-HTTPS download URL");
    }
  }
  return { revision: index.revision, archiveUrl };
}

let updateRequestCounter = 0;

async function installManagedCandidate(candidate, update, checkedAt) {
  updateRequestCounter += 1;
  const { fingerprint } = candidate;
  const reply = await relay({
    target: TARGET,
    type: "hd_import",
    requestId: `managed-update-${updateRequestCounter}`,
    managedFingerprint: fingerprint,
    sourceId: fingerprint.source.kind === "recommended" ? fingerprint.source.sourceId : null,
    archiveUrl: update.archiveUrl,
    expectedRevision: update.revision,
    checkedAt,
    fileName: candidate.title,
  });
  if (!reply?.ok || !reply.report?.success) {
    throw new Error(reply?.error || reply?.report?.error || "the dictionary update failed");
  }
}

function changedManagedOutcome(candidate) {
  return {
    id: candidate.id,
    status: "check-failed",
    error: MANAGED_DICTIONARY_CHANGED,
  };
}

async function recordManagedOutcome(candidate, lastUpdateCheck, outcome) {
  const recorded = await updateDictionaryCheck(candidate.fingerprint, lastUpdateCheck);
  return recorded === null ? changedManagedOutcome(candidate) : outcome;
}

async function checkManagedCandidate(candidate, checkedAt) {
  let update;
  try {
    update = await remoteUpdate(candidate);
  } catch (error) {
    const message = describe(error);
    return {
      update: null,
      available: null,
      outcome: await recordManagedOutcome(
        candidate,
        {
          checkedAt,
          status: "check-failed",
          remoteRevision: null,
          error: message,
        },
        { id: candidate.id, status: "check-failed", error: message },
      ),
    };
  }

  if (update.revision === candidate.fingerprint.revision) {
    const outcome = await recordManagedOutcome(
      candidate,
      {
        checkedAt,
        status: "up-to-date",
        remoteRevision: update.revision,
        error: null,
      },
      { id: candidate.id, status: "up-to-date" },
    );
    return { update: null, available: null, outcome };
  }

  const available = {
    checkedAt,
    status: "update-available",
    remoteRevision: update.revision,
    error: null,
  };
  const outcome = await recordManagedOutcome(
    candidate,
    available,
    { id: candidate.id, status: "update-available" },
  );
  return {
    update: outcome.status === "update-available" ? update : null,
    available,
    outcome,
  };
}

async function installCheckedCandidate(candidate, checked, checkedAt) {
  if (checked.update === null) {
    return checked.outcome;
  }
  try {
    await installManagedCandidate(candidate, checked.update, checkedAt);
    return { id: candidate.id, status: "updated" };
  } catch (error) {
    let message = describe(error);
    const failed = await updateDictionaryCheck(
      candidate.fingerprint,
      { ...checked.available, error: message },
    );
    if (failed === null) message = MANAGED_DICTIONARY_CHANGED;
    return {
      id: candidate.id,
      status: failed === null ? "check-failed" : "update-available",
      error: message,
    };
  }
}

async function readUpdatePlan() {
  const stored = await chrome.storage.local.get([DICTIONARY_STATE_KEY, UPDATE_SETTINGS_KEY]);
  return { dictionaries: stored[DICTIONARY_STATE_KEY]?.dictionaries ?? [],
    settings: normaliseUpdateSettings(stored[UPDATE_SETTINGS_KEY]) };
}

async function scheduledCandidateIsDue(candidate) {
  const { dictionaries, settings } = await serialiseStorage(readUpdatePlan);
  const current = dictionaries.find(dictionary => dictionary.id === candidate.id);
  if (!current || !managedDictionaryMatches(current, candidate.fingerprint)) return false;
  const now = Date.now();
  const due = nextDictionaryUpdateCheck(current, settings.schedule, now);
  return due !== null && due <= now;
}

async function runManagedUpdateCycle({ dictionaryIds = null, install = false, dueOnly = false } = {}) {
  const candidates = await managedCandidates(dictionaryIds);
  const outcomes = [];

  for (const candidate of candidates) {
    // A later package can be switched Off while an earlier fetch is in flight.
    if (dueOnly && !await scheduledCandidateIsDue(candidate)) continue;
    const checkedAt = new Date().toISOString();
    const checked = await checkManagedCandidate(candidate, checkedAt);
    outcomes.push(install
      ? await installCheckedCandidate(candidate, checked, checkedAt)
      : checked.outcome);
  }

  if (dueOnly && outcomes.length === 0) return { outcomes, settings: await readUpdateSettings() };
  const { settings } = await writeUpdateSettings((current) => ({
    ...current,
    lastCheckedAt: new Date().toISOString(),
  }));
  return { outcomes, settings };
}

let updateTail = Promise.resolve();
let updateCycleActive = false;

function queueManagedUpdate(options) {
  const execute = async () => {
    updateCycleActive = true;
    try { return await runManagedUpdateCycle(options); }
    finally {
      updateCycleActive = false;
      await refreshUpdateAlarm();
    }
  };
  const run = updateTail.then(execute, execute);
  updateTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let alarmTail = Promise.resolve();

function reconcileUpdateAlarm() {
  const run = alarmTail.then(async () => {
    await sharingReady;
    if (sharingLinked) {
      await alarms.clear(UPDATE_ALARM);
      return;
    }
    if (updateCycleActive) return;
    const { dictionaries, settings } = await serialiseStorage(readUpdatePlan);
    const now = Date.now();
    const when = nextManagedUpdateCheck(dictionaries, settings.schedule, now);
    const existing = await alarms.get(UPDATE_ALARM);
    if (updateCycleActive) return;
    if (when === null) {
      if (existing) await alarms.clear(UPDATE_ALARM);
      return;
    }
    if (existing && existing.periodInMinutes === undefined
        && (existing.scheduledTime === when || (when === now && existing.scheduledTime <= now))) {
      return;
    }
    await alarms.create(UPDATE_ALARM, { when });
  });
  alarmTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function refreshUpdateAlarm() {
  return reconcileUpdateAlarm().catch(error => {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describe(error));
  });
}

function updateTiming(dictionaries = []) {
  return dictionaries.map(dictionary => [managedDictionarySource(dictionary) !== null,
    dictionary.updateScheduleOverride ?? null, dictionary.lastUpdateCheck?.checkedAt ?? null]);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[DICTIONARY_STATE_KEY]) return;
  sharingHost?.setDictionaries(dictionaryCount(changes[DICTIONARY_STATE_KEY].newValue));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || updateCycleActive) return;
  const state = changes[DICTIONARY_STATE_KEY];
  // Update-settings writers reconcile explicitly after releasing the storage queue.
  if (state && !sameJsonValue(
    updateTiming(state.oldValue?.dictionaries), updateTiming(state.newValue?.dictionaries),
  )) void refreshUpdateAlarm();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[OPTIONS_KEY]) return;
  void reconcileAnkiIndex();
  void applyCustomJavaScript(chrome, normaliseOptions(changes[OPTIONS_KEY].newValue).customPopupJavascript);
});

async function applyAnkiIndexRole() {
  const index = getAnkiDuplicateIndex();
  if (sharingLinked) await index.suspend();
  else await index.resume();
}

async function reconcileAnkiIndex() {
  await sharingReady;
  // A link suspends the old role before publishing the new one. An options
  // event or alarm in that interval must not resume local Anki behind it.
  await sharingTransitionTail;
  await applyAnkiIndexRole();
}

const UPDATE_HANDLERS = {
  async hd_updates_schedule(message) {
    const schedule = managedUpdateSchedule(message?.schedule);
    if (schedule === null) {
      throw new Error("the dictionary update schedule is invalid");
    }
    const result = await writeUpdateSettings(current =>
      message.baseRevision === current.revision ? { ...current, schedule } : null);
    if (result.ok !== false) await reconcileUpdateAlarm();
    return result;
  },

  async hd_updates_check() {
    return queueManagedUpdate({ install: false });
  },

  async hd_updates_install(message) {
    if (!Array.isArray(message?.dictionaryIds)) {
      throw new TypeError("the dictionary update request carried no dictionary IDs");
    }
    return queueManagedUpdate({ dictionaryIds: message.dictionaryIds, install: true });
  },
};

function workerReply(message, result) {
  const { ok = true, error = null, ...payload } = result ?? {};
  return { type: `${message.type}_result`, requestId: message.requestId ?? null, ok, error, ...payload };
}

function checkedOptionsResult(message, result) {
  if (!responseFits(workerReply(message, result))) throw new Error(responseLimitError(message.type));
  return result;
}

function failureReply(message, error) {
  const description = describe(error);
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

const ANKI_METHODS = { hd_anki_status: "status", hd_anki_preflight: "preflight", hd_anki_submit: "submit",
  hd_anki_browse: "browse", hd_anki_screenshot: "screenshot", hd_anki_screenshot_discard: "discardScreenshot",
  hd_anki_maturity: "maturity" };

// Chrome rate-limits viewport captures, so a second mining action in the same
// second waits once rather than losing its screenshot.
const CAPTURE_VISIBLE_RETRY_MS = 600;

// Startup messages can include or omit sender.tab. Chrome's live extension contexts
// bind either shape to the same document before and after capture.
async function screenshotOwnedTab(sender, startup) {
  let tabId = sender.tab?.id;
  if (startup) {
    const [context] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentIds: [sender.documentId] });
    if (!context) throw new Error("The reading document changed before the screenshot.");
    tabId = context.tabId;
  }
  const tab = await chrome.tabs.get(tabId);
  if (tab?.active !== true) throw new Error("The reading tab is no longer the active tab.");
  // Tabs hides extension-page URLs; startup's exact live document was checked above.
  if (!startup && (sender.frameId ?? 0) === 0 && tab.url !== sender.url) {
    throw new Error("The reading tab moved to another page before the screenshot.");
  }
  if (!startup) {
    // Address the exact content-script document, so a same-URL reload cannot
    // answer on its predecessor's behalf.
    const document = await chrome.tabs.sendMessage(tabId, {
      target: CAPTURE_CONTENT_TARGET, type: "hd_capture_document",
    }, { documentId: sender.documentId }).catch(() => null);
    if (document?.present !== true) throw new Error("The reading document changed before the screenshot.");
  }
  return tab;
}

// captureVisibleTab takes the window's active tab. Both the active page and its
// document owner are checked around every attempt, including a rate-limit retry.
async function captureSenderViewport(sender) {
  const startup = startupSender(sender);
  if (typeof sender.tab?.id !== "number" && !startup) {
    throw new Error("Only a reading tab can be captured.");
  }
  if (!sender.documentId) throw new Error("The reading document identity is unavailable.");
  for (let attempt = 1; ; attempt += 1) {
    const tab = await screenshotOwnedTab(sender, startup);
    let captured;
    try {
      captured = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg" });
    } catch (error) {
      if (attempt >= 2 || !/per second|too many|MAX_CAPTURE/iu.test(describe(error))) throw error;
      await sleep(CAPTURE_VISIBLE_RETRY_MS);
      continue;
    }
    // Capturing stays bound to this window even if the active reading tab is
    // dragged to another one before the pixels return.
    const afterCapture = await screenshotOwnedTab(sender, startup);
    if (afterCapture.windowId !== tab.windowId) {
      throw new Error("The reading tab moved to another window during the screenshot.");
    }
    return captured;
  }
}

const CAPTURE_CONTROL_TYPES = new Set([
  "hd_capture_open",
  "hd_capture_tabs",
  "hd_capture_link",
  "hd_capture_unlink",
  "hd_capture_video_select",
  "hd_capture_track_area",
  "hd_capture_clear_area",
  "hd_capture_status",
  "hd_capture_start",
  "hd_capture_stop",
]);
const CAPTURE_CONTENT_TYPES = new Set([
  "hd_capture_content_identify",
  "hd_capture_text_begin",
  "hd_capture_text_close",
  "hd_capture_text_source_close",
  "hd_capture_page_status",
  "hd_capture_pin",
  "hd_capture_release",
  "hd_capture_export",
  "hd_capture_job_status",
  "hd_capture_cancel",
]);

let captureConfigRevision = 0;
let captureConfigTail = Promise.resolve();

chrome.storage.onChanged.addListener((changes, area) => {
  if (!HOST_CAPABILITIES.mediaCapture || area !== "local" || !changes[OPTIONS_KEY]) return;
  const previous = globalThis.HDReaderOptions.normaliseOptions(changes[OPTIONS_KEY].oldValue).mediaCapture;
  const mediaCapture = globalThis.HDReaderOptions.normaliseOptions(changes[OPTIONS_KEY].newValue).mediaCapture;
  if (sameJsonValue(previous, mediaCapture)) return;
  const revision = ++captureConfigRevision;
  const apply = () => relayCapture({ type: "hd_capture_configure", mediaCapture },
    () => revision === captureConfigRevision);
  captureConfigTail = captureConfigTail.then(apply, apply).catch(error => {
    console.error("hachidori: could not update media capture settings:", describe(error));
  });
});

function assertCurrentCaptureLink(link, status = null) {
  if (captureLink !== link || (status && (status.state !== "recording"
      || status.captureSessionId !== link.captureSessionId))) {
    throw new Error("The capture session changed before the reading page was linked.");
  }
}

async function linkCapturePage(message) {
  const link = { tabId: message.tabId, captureSessionId: null, document: null };
  captureLink = link;
  let captureDocumentId;
  try {
    const status = await relayCapture({ type: "hd_capture_status" });
    assertCurrentCaptureLink(link);
    if (status.state !== "recording" || !status.captureSessionId) {
      await unlinkCaptureContent();
      throw new Error("Start capture before linking a reading page.");
    }
    link.captureSessionId = status.captureSessionId;
    captureDocumentId = capturePage.documentId;
    if (status.linkedPage) {
      await relayCapture({ type: "hd_capture_unlinked", ...status.linkedPage,
        reason: "Linking a reading page." }, () => captureLink === link);
      assertCurrentCaptureLink(link);
    }
    await unlinkCaptureContent();
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    assertCurrentCaptureLink(link);
    const mediaCapture = globalThis.HDReaderOptions.projectContentOptions(stored[OPTIONS_KEY]).mediaCapture;
    const details = await commandCaptureContent(message.tabId, "hd_capture_link", {
      mediaCapture, captureSessionId: link.captureSessionId,
    });
    const document = link.document;
    if (!document?.documentId) {
      throw new Error("The linked page did not establish a document identity.");
    }
    const tab = await chrome.tabs.get(message.tabId);
    assertCurrentCaptureLink(link);
    const page = {
      tabId: message.tabId,
      documentId: document.documentId,
      title: String(tab.title || "").slice(0, 200),
      url: String(tab.url || "").slice(0, 2048),
      videos: Array.isArray(details?.videos) ? details.videos : [],
      message: details?.message || "",
    };
    await relayCapture({ type: "hd_capture_linked", requestId: message.requestId,
      captureSessionId: link.captureSessionId, page });
    return { page };
  } catch (error) {
    if (link.document) {
      await unlinkRetiredCapture({ captureDocumentId, captureSessionId: link.captureSessionId,
        linkedPage: link.document }, captureDocumentId, link);
    }
    throw error;
  } finally {
    if (captureLink === link) captureLink = null;
  }
}

function sameCapturePage(page, expected) {
  return page?.tabId === expected.tabId && page.documentId === expected.documentId;
}

function replacementCaptureLink(link) {
  if (captureLink && captureLink !== link && captureLink.tabId === link.tabId) return true;
  return captureContentDocument !== link.document && sameCapturePage(captureContentDocument, link.document);
}

async function unlinkRetiredCapture(message, documentId, retiringLink = null) {
  if (message.captureDocumentId !== documentId) return;
  const page = message.linkedPage;
  assertCaptureTabId(page?.tabId);
  if (!shortCaptureString(page.documentId) || !shortCaptureString(message.captureSessionId)) {
    throw new Error("The retired capture identity is invalid.");
  }
  // A source-ended event can wake a fresh worker before routing has recovered.
  // Check the live host without publishing a partly recovered capturePage.
  const status = await chrome.runtime.sendMessage({
    target: CAPTURE_PAGE_TARGET, type: "hd_capture_status", relayed: true, captureDocumentId: documentId,
  }).catch(() => null);
  if (retiringLink && replacementCaptureLink(retiringLink)) return;
  if (status?.captureSessionId && status.captureSessionId !== message.captureSessionId
      && sameCapturePage(status.linkedPage, page)) return;
  await chrome.tabs.sendMessage(page.tabId, {
    target: CAPTURE_CONTENT_TARGET, type: "hd_capture_unlink",
  }, { documentId: page.documentId }).catch(() => {});
  if (sameCapturePage(captureContentDocument, page)) captureContentDocument = null;
}

async function handleCaptureHostMessage(message, sender) {
  if (!capturePageSender(sender)) throw new Error("Only the offscreen document can register or stop the capture host.");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)] });
  const documentId = contexts.length === 1 ? contexts[0].documentId : null;
  if (!documentId) throw new Error("The capture host document is unavailable.");
  if (message.type === "hd_capture_host_stopped") {
    await unlinkRetiredCapture(message, documentId);
    return { stopped: true };
  }
  capturePage = { documentId };
  await recoverCaptureBinding(message.linkedPage);
  const stored = await chrome.storage.local.get(OPTIONS_KEY);
  return { documentId,
    mediaCapture: globalThis.HDReaderOptions.normaliseOptions(stored[OPTIONS_KEY]).mediaCapture };
}

// A newly created tab can be reopened before its TAB context is published.
let captureControlsTabId = null;
let captureControlsOpening = null;

function openCaptureControls() {
  captureControlsOpening ??= focusCaptureControls().finally(() => { captureControlsOpening = null; });
  return captureControlsOpening;
}

async function focusCaptureControls() {
  if (captureControlsTabId === null) {
    const [existing] = await chrome.runtime.getContexts({ contextTypes: ["TAB"],
      documentUrls: [chrome.runtime.getURL(CAPTURE_DOCUMENT)] });
    captureControlsTabId = existing?.tabId ?? null;
  }
  if (captureControlsTabId !== null) {
    try {
      const tab = await chrome.tabs.update(captureControlsTabId, { active: true });
      if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId: tab.id };
    } catch { /* A closed controls tab can be reopened. */ }
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(CAPTURE_DOCUMENT), active: true });
  captureControlsTabId = tab.id;
  return { tabId: tab.id };
}

async function handleCaptureControl(message, sender) {
  if (["hd_capture_register", "hd_capture_host_stopped"].includes(message.type)) {
    return handleCaptureHostMessage(message, sender);
  }
  if (!CAPTURE_CONTROL_TYPES.has(message.type) || !trustedCaptureControl(sender)) {
    throw new Error("Unknown or untrusted capture control request.");
  }
  if (message.type === "hd_capture_open") return openCaptureControls();
  if (message.type === "hd_capture_tabs") return { tabs: await captureTabs() };
  if (["hd_capture_status", "hd_capture_start", "hd_capture_stop"].includes(message.type)) return relayCapture(message);
  assertCaptureTabId(message.tabId);
  if (message.type === "hd_capture_link") {
    return linkCapturePage(message);
  }
  if (message.type === "hd_capture_unlink") {
    const result = await commandCaptureContent(message.tabId, "hd_capture_unlink", {});
    if (captureContentDocument?.tabId === message.tabId) captureContentDocument = null;
    return result;
  }
  const command = {
    hd_capture_video_select: ["hd_capture_video_select", { videoId: message.videoId }],
    hd_capture_track_area: ["hd_capture_track_area", {}],
    hd_capture_clear_area: ["hd_capture_clear_area", {}],
  }[message.type];
  return commandCaptureContent(message.tabId, command[0], command[1]);
}

function authoritativeCaptureRecord(message, sender) {
  const record = message.record;
  if (!record || !["cue", "dom"].includes(record.sourceKind)
      || !shortCaptureString(record.sourceEpoch) || !shortCaptureString(record.occurrenceId)
      || typeof record.text !== "string" || record.text.length === 0 || record.text.length > 4096
      || !finiteCaptureTime(record.startMs)) throw new Error("The reading page sent an invalid text timing record.");
  return {
    sourceKind: record.sourceKind,
    sourceId: captureDocumentKey(sender.tab.id),
    sourceEpoch: `${sender.documentId}:${record.sourceEpoch}`,
    occurrenceId: record.occurrenceId,
    text: record.text,
    startMs: record.startMs,
    onsetKnown: record.onsetKnown !== false,
  };
}

function authoritativeCaptureIdentity(message, sender) {
  const identity = message.identity;
  if (!identity || !["cue", "dom"].includes(identity.sourceKind)
      || !shortCaptureString(identity.sourceEpoch) || !shortCaptureString(identity.occurrenceId)
      || !finiteCaptureTime(message.endMs)) throw new Error("The reading page sent an invalid text close record.");
  return {
    sourceKind: identity.sourceKind,
    sourceId: captureDocumentKey(sender.tab.id),
    sourceEpoch: `${sender.documentId}:${identity.sourceEpoch}`,
    occurrenceId: identity.occurrenceId,
  };
}

async function handleCaptureContent(message, sender) {
  if (!CAPTURE_CONTENT_TYPES.has(message.type) || sender.id !== chrome.runtime.id
      || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0
      || typeof sender.documentId !== "string" || sender.documentId === "") {
    throw new Error("Unknown or untrusted reading-page capture request.");
  }
  if (message.type === "hd_capture_content_identify") {
    const link = captureLink;
    if (link?.tabId !== sender.tab.id || link.captureSessionId !== message.captureSessionId) {
      throw new Error("This reading page is not being linked to the capture session.");
    }
    const status = await relayCapture({ type: "hd_capture_status" });
    assertCurrentCaptureLink(link, status);
    link.document = { tabId: sender.tab.id, documentId: sender.documentId };
    captureContentDocument = link.document;
    return { documentId: sender.documentId, tabId: sender.tab.id };
  }
  if (!capturePage || captureRecovery) await recoverCaptureHost();
  // Admitted exports outlive reader relinking. The offscreen job retains the
  // original document and checks these authoritative sender fields itself.
  if (["hd_capture_job_status", "hd_capture_cancel"].includes(message.type)) {
    return relayCaptureContent(message, sender);
  }
  const document = captureContentDocument;
  if (document?.tabId !== sender.tab.id || document.documentId !== sender.documentId) {
    throw new Error("This reading document is not linked to the capture session.");
  }
  return relayCaptureContent(message, sender);
}

function assertCaptureLookup(lookup) {
  if (!lookup || typeof lookup.lookupText !== "string" || lookup.lookupText.length === 0
      || lookup.lookupText.length > 4096 || !finiteCaptureTime(lookup.lookupTimeMs)
      || (lookup.occurrenceId !== "" && !shortCaptureString(lookup.occurrenceId))
      || !["", "dom", "cue"].includes(lookup.occurrenceSourceKind ?? "")) {
    throw new Error("The reading page sent an invalid lookup capture request.");
  }
}

function assertCaptureExport(message) {
  if (!shortCaptureString(message.token)
      || !message.requirements || typeof message.requirements !== "object"
      || typeof message.requirements.includeAnimation !== "boolean"
      || typeof message.requirements.includeAudio !== "boolean"
      || (!message.requirements.includeAnimation && !message.requirements.includeAudio)) {
    throw new Error("The capture export request is invalid.");
  }
}

async function relayCaptureContent(message, sender) {
  const authority = { tabId: sender.tab.id, documentId: sender.documentId };
  if (message.type === "hd_capture_text_begin") {
    return relayCapture({ ...message, ...authority, record: authoritativeCaptureRecord(message, sender) });
  }
  if (message.type === "hd_capture_text_close") {
    return relayCapture({ ...message, ...authority, identity: authoritativeCaptureIdentity(message, sender) });
  }
  if (message.type === "hd_capture_text_source_close") {
    if (!["cue", "dom"].includes(message.sourceKind) || !shortCaptureString(message.sourceEpoch)
        || !finiteCaptureTime(message.endMs)) throw new Error("The reading page sent an invalid source close.");
    return relayCapture({
      ...message,
      ...authority,
      sourceId: captureDocumentKey(sender.tab.id),
      sourceEpoch: `${sender.documentId}:${message.sourceEpoch}`,
    });
  }
  if (message.type === "hd_capture_pin") {
    const lookup = message.lookup;
    assertCaptureLookup(lookup);
    return relayCapture({ ...message, ...authority,
      lookup: { ...lookup, occurrenceId: lookup.occurrenceId || "",
        occurrenceSourceKind: lookup.occurrenceSourceKind || "" } });
  }
  if (message.type === "hd_capture_release") {
    if (!shortCaptureString(message.token)) throw new Error("The capture release token is invalid.");
    return relayCapture({ ...message, ...authority });
  }
  if (message.type === "hd_capture_export") {
    assertCaptureExport(message);
    return relayCapture({
      ...message,
      ...authority,
      requirements: {
        includeAnimation: message.requirements.includeAnimation,
        includeAudio: message.requirements.includeAudio,
      },
    });
  }
  if (message.type === "hd_capture_job_status" || message.type === "hd_capture_cancel") {
    if (!shortCaptureString(message.jobId)) throw new Error("The capture export job is invalid.");
    return relayCapture({ ...message, ...authority });
  }
  if (message.type === "hd_capture_page_status") {
    return relayCapture({ ...message, ...authority });
  }
  throw new Error("Unknown reading-page capture request.");
}

function clearNavigatedCaptureDocument(tabId, reason) {
  const document = captureContentDocument;
  if (document?.tabId !== tabId) return;
  captureContentDocument = null;
  void relayCapture({
    type: "hd_capture_unlinked",
    requestId: `capture-navigation-${crypto.randomUUID()}`,
    tabId,
    documentId: document.documentId,
    reason,
  }).catch(() => {});
}

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    if (tabId === captureControlsTabId) captureControlsTabId = null;
    clearNavigatedCaptureDocument(tabId, "The reading page navigated. Link it again.");
  }
});
chrome.tabs?.onRemoved?.addListener(tabId => {
  if (tabId === captureControlsTabId) captureControlsTabId = null;
  clearNavigatedCaptureDocument(tabId, "The linked reading tab was closed.");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== CAPTURE_TARGET || message.relayed === true) return false;
  let operation;
  if (!HOST_CAPABILITIES.mediaCapture) {
    operation = Promise.reject(new Error("Media capture is unavailable in this overlay."));
  } else if (["hd_capture_register", "hd_capture_host_stopped"].includes(message.type)
      || CAPTURE_CONTROL_TYPES.has(message.type)) {
    operation = handleCaptureControl(message, sender);
  } else {
    operation = handleCaptureContent(message, sender);
  }
  Promise.resolve(operation).then(
    result => sendResponse(workerReply(message, result)),
    error => sendResponse(failureReply(message, error)),
  );
  return true;
});

// Anki owns its own mutation queue. Discovery, DOM rendering and network I/O
// must never hold the dictionary storage queue while the engine calls into it.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "hachidori-anki") return false;
  handleAnkiRequest(message, sender).then(sendResponse);
  return true;
});

async function handleAnkiRequest(message, sender) {
  await sharingReady;
  // Linking waits for operations admitted under the old role. Requests which
  // arrive during that transition wait too, so none can read one browser's
  // configuration and finish after routing has moved to another.
  await sharingTransitionTail;
  return trackAnkiOperation(async () => {
    if (sharingLinked) {
      // The reading browser alone can capture or discard its viewport bytes.
      if (["hd_anki_screenshot", "hd_anki_screenshot_discard"].includes(message.type)) {
        return answerAnkiRequest(message, sender);
      }
      // Mature-word evidence has always belonged to the host, including hosts
      // from before linked mining advertised a capability.
      if (message.type === "hd_anki_maturity") return forwardToHost(message);
      if (message.type === "hd_anki_submit") return submitToLinkedAnki(message);
      if (["hd_anki_status", "hd_anki_preflight", "hd_anki_browse"].includes(message.type)) {
        try {
          const reply = await getSharingClient().forward(message, { capability: LINKED_ANKI_CAPABILITY });
          if (message.type === "hd_anki_preflight" && reply?.ok !== false && reply?.clientSpeech) {
            await getAnkiMining().preflightClientSpeech({
              ...message.request,
              clientSpeech: reply.clientSpeech,
            });
          }
          return reply;
        } catch (error) {
          if (message.type === "hd_anki_status" && describe(error) === LINKED_ANKI_UNSUPPORTED) {
            return workerReply(message, { available: false, configKey: "", error: LINKED_ANKI_UNSUPPORTED });
          }
          return failureReply(message, error);
        }
      }
    }
    return answerAnkiRequest(message, sender);
  });
}

function getAnkiMining() {
  if (!ankiMining) {
    const send = async (target, fields) => {
      const reply = await relay({ ...fields, target, requestId: `anki-${crypto.randomUUID()}` });
      if (!reply?.ok) throw new Error(reply?.error || "Anki preparation did not complete.");
      return reply;
    };
    ankiGateway ??= createAnkiGateway();
    ankiMining = createAnkiWorkerService({ gateway: ankiGateway,
      readOptions: readAnkiOptions,
      duplicateIndex: getAnkiDuplicateIndex(),
      readDictionaries: async () => (await readDictionaryStorage()).state?.dictionaries ?? [],
      engine: fields => send(TARGET, fields), offscreen: fields => send("hachidori-anki-render", fields),
      capture: fields => relayCapture({ ...fields, requestId: `anki-capture-${crypto.randomUUID()}` }),
    });
  }
  return ankiMining;
}

async function submitToLinkedAnki(message) {
  const local = getAnkiMining();
  let clientMedia;
  try {
    clientMedia = await local.clientMedia(message.request);
  } catch (error) {
    return failureReply(message, error);
  }
  let sent = false;
  let reply;
  try {
    reply = await getSharingClient().forward({ ...message, clientMedia }, {
      capability: LINKED_ANKI_CAPABILITY,
      mutation: true,
      onSent: () => { sent = true; },
    });
  } catch (error) {
    if (!sent) return failureReply(message, error);
    return workerReply(message, {
      state: "uncertain",
      error: `The write could not be confirmed. Check Anki before trying again. ${describe(error)}`,
    });
  }
  const states = ["added", "updated", "duplicate", "invalid", "uncertain"];
  if (!reply || reply.type !== `${message.type}_result` || reply.requestId !== message.requestId
      || typeof reply.ok !== "boolean" || (reply.ok === true && !states.includes(reply.state))) {
    return workerReply(message, {
      state: "uncertain",
      error: "The write could not be confirmed. Check Anki before trying again. The linked Hachidori returned an unexpected response.",
    });
  }
  const settlement = reply.ok === false ? "invalid"
    : ["added", "updated", "duplicate", "invalid"].includes(reply.state) ? reply.state : null;
  if (settlement !== null) {
    try {
      await local.settleClientMedia(message.request, settlement);
    } catch (error) {
      if (["added", "updated"].includes(settlement)) {
        reply = { ...reply, warnings: [...(Array.isArray(reply.warnings) ? reply.warnings : []),
          `Captured media cleanup: ${describe(error)}`] };
      } else {
        console.warn("hachidori: could not discard rejected linked media:", describe(error));
      }
    }
  }
  return reply;
}

function answerAnkiRequest(message, sender, linkedClient = false) {
  return Promise.resolve().then(async () => {
    if (sender.id !== chrome.runtime.id || !Object.hasOwn(ANKI_METHODS, message.type)) throw new Error("Unknown Anki request.");
    const service = getAnkiMining();
    // Only the screenshot needs to know which page asked, and it is given the
    // capture rather than the sender, so nothing else can capture a tab.
    if (message.type === "hd_anki_screenshot") return service.screenshot(() => captureSenderViewport(sender));
    if (linkedClient && message.type === "hd_anki_status") {
      const status = await service.status();
      return { ...status, configKey: linkedAnkiConfigKey(status.configKey) };
    }
    if (linkedClient && message.type === "hd_anki_preflight") {
      return service.preflightClient(hostLinkedAnkiRequest(message.request));
    }
    if (linkedClient && message.type === "hd_anki_submit") {
      return service.submitClient(hostLinkedAnkiRequest(message.request), message.clientMedia);
    }
    if (linkedClient && message.type === "hd_anki_browse") {
      return service.browse(hostLinkedAnkiRequest(message.request));
    }
    return service[ANKI_METHODS[message.type]](message.type === "hd_anki_browse"
      ? message.request ?? message.expression : message.request);
  }).then(result => workerReply(message, result), error => failureReply(message, error));
}

const backupPreparations = new Map();
let backupCancelTail = Promise.resolve();

async function relayEngineRequest(message) {
  await sharingReady;
  if (sharingLinked && forwardableRequest(message)) return forwardToHost(message);
  if (message.type === "hd_backup_cancel") {
    const preparation = backupPreparations.get(message.token);
    if (preparation) preparation.cancelled = true;
    // Retire startup/retries now, then let an already-dispatched prepare finish
    // before cancellation reaches the engine. Otherwise Chrome 128 can deliver
    // pagehide while prepare is awaiting a storage reply: the early cancel sees
    // no prepared token, then prepare publishes fresh roots with nobody left to
    // discard them. Admit only one cleanup request at a time.
    const cancel = async () => {
      if (preparation) await preparation.settled;
      return relay(message);
    };
    const cancelled = backupCancelTail.then(cancel, cancel);
    backupCancelTail = cancelled.catch(() => {});
    return cancelled;
  }
  if (message.type !== "hd_backup_prepare") return relay(message);
  let settlePreparation;
  const preparation = {
    cancelled: false,
    settled: new Promise(resolve => { settlePreparation = resolve; }),
  };
  backupPreparations.set(message.token, preparation);
  try {
    return await relay(message, () => !preparation.cancelled);
  } finally {
    settlePreparation();
    if (backupPreparations.get(message.token) === preparation) backupPreparations.delete(message.token);
  }
}

function validBackupPreparationToken(token) {
  return typeof token === "string" && token.length > 0 && token.length <= 128;
}

async function cancelOwnedBackupPreparation(token) {
  const reply = await relayEngineRequest({
    target: TARGET,
    type: "hd_backup_cancel",
    token,
    requestId: `backup-lifecycle-${crypto.randomUUID()}`,
  });
  if (!reply?.ok) throw new Error(reply?.error || "The abandoned backup preparation could not be discarded.");
  return reply;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BACKUP_LIFECYCLE_PORT) return;
  if (!ankiSettingsSender(port.sender)) {
    port.disconnect();
    return;
  }
  const owned = new Set();
  port.onMessage.addListener((message) => {
    if (!validBackupPreparationToken(message?.token)) return;
    if (message.type === "track" && typeof message.active === "boolean") {
      if (message.active) owned.add(message.token);
      else owned.delete(message.token);
      return;
    }
    if (message.type === "cancel" && owned.has(message.token)) {
      void cancelOwnedBackupPreparation(message.token).then(
        () => owned.delete(message.token),
        error => console.warn("hachidori: could not discard an abandoned backup preparation:", describe(error)),
      );
    }
  });
  port.onDisconnect.addListener(() => {
    const abandoned = [...owned];
    owned.clear();
    for (const token of abandoned) {
      void cancelOwnedBackupPreparation(token).catch(
        error => console.warn("hachidori: could not discard an abandoned backup preparation:", describe(error)),
      );
    }
  });
});

// The reader's popup cancels browser zoom, which only extension APIs report.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== PAGE_ZOOM_TARGET) return false;
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || message.type !== "hd_page_zoom" || !Number.isInteger(tabId)) {
    sendResponse(failureReply(message, new Error("Unknown page zoom request.")));
    return false;
  }
  chrome.tabs.getZoom(tabId).then((zoomFactor) => sendResponse(workerReply(message, { zoomFactor })),
    (error) => sendResponse(failureReply(message, error)));
  return true;
});

// Startup and Settings attach to one recommended-install run. The welcome gate
// belongs to startup; opening Settings never requires an onboarding record.
async function handleRecommendedInstall(message, sender, shared = false) {
  const startup = startupSender(sender);
  const settings = sender?.id === chrome.runtime.id
    && sender.url?.split(/[?#]/u)[0] === chrome.runtime.getURL("settings.html");
  if (!shared && !startup && !settings) throw new Error("Recommended installation is available only from Hachidori startup or Settings.");
  if (message.type !== "hd_setup_install") throw new Error("Unknown recommended installation request.");
  if (startup) {
    const stored = await chrome.storage.local.get(SETUP_STATE_KEY);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    if (current === null) throw new Error("Setup has not started on this installation.");
    if (current.stage === "welcome") throw new Error("Start setup before downloading dictionaries.");
  }
  // Never hold the storage queue here: each engine commit calls back into it.
  await sharingReady;
  return sharingLinked ? forwardToHost(message) : relay({ ...message, recordSetup: startup });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== SETUP_TARGET || message.relayed === true) return false;
  handleRecommendedInstall(message, sender).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.target !== TARGET && message.target !== AUDIO_TARGET) || message.relayed === true) {
    return false;
  }
  let stillCurrent = null;
  let operation = null;
  if (message.target === AUDIO_TARGET) {
    try {
      if (!["hd_audio_test", "hd_audio_play", "hd_audio_candidates", "hd_audio_stop", "hd_audio_voices"].includes(message.type)) throw new Error("Unknown audio request.");
      validateAudioRequest(message);
      // Chrome supplies the document ID, so an old Settings tab cannot stop a
      // pronunciation subsequently started by a different document.
      message = { ...message, owner: sender.documentId };
      if (["hd_audio_test", "hd_audio_play", "hd_audio_candidates"].includes(message.type)) {
        operation = { ...message, tabId: sender.tab?.id, startup: startupSender(sender) };
        latestAudioOperation = operation;
        stillCurrent = () => latestAudioOperation === operation;
      } else if (message.type === "hd_audio_stop"
          && latestAudioOperation?.owner === message.owner && latestAudioOperation?.requestId === message.playRequestId) {
        // Retire it before awaiting offscreen startup. Otherwise its relay
        // retry could start playback after this Stop has already completed.
        latestAudioOperation = null;
      }
    } catch (error) {
      sendResponse(failureReply(message, error));
      return false;
    }
  }
  const response = message.target === AUDIO_TARGET
    ? prepareAudioRequest(message).then(prepared => relay(prepared, stillCurrent)) : relayEngineRequest(message);
  response.then(sendResponse, error => {
    sendResponse(failureReply(message, error));
  }).finally(() => { if (operation && latestAudioOperation === operation) latestAudioOperation = null; });
  return true;
});

function validateAudioRequest(message) {
  if (message.type === "hd_audio_test") {
    globalThis.HDReaderOptions.validateOptionsPatch({ audioSources: [message.source] });
    return;
  }
  if (message.type !== "hd_audio_play" && message.type !== "hd_audio_candidates") return;
  if (typeof message.term?.expression !== "string" || !message.term.expression
      || typeof message.term.reading !== "string") throw new Error("A pronunciation needs an expression and reading.");
  const choice = message.selection;
  if (choice !== undefined && (!choice || !Number.isInteger(choice.index) || choice.index < 0
      || !["sourceId", "sourceKey", "expression", "reading", "name"].every(key => typeof choice[key] === "string")
      || (choice.url !== null && typeof choice.url !== "string"))) throw new Error("Invalid pronunciation selection.");
}

async function prepareAudioRequest(message) {
  if (message.type !== "hd_audio_play" && message.type !== "hd_audio_candidates") return message;
  const stored = await chrome.storage.local.get(OPTIONS_KEY);
  const options = globalThis.HDReaderOptions.normaliseOptions(stored[OPTIONS_KEY]);
  return { ...message, sources: options.audioSources.filter(source => source.enabled) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "hachidori-audio-events") return false;
  const operation = latestAudioOperation;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT)
      || !operation || (!operation.startup && operation.tabId === undefined) || operation.owner !== message.owner
      || operation.requestId !== message.requestId || message.type !== "hd_audio_playing") return false;
  const progress = { ...message, target: "hachidori-audio-content" };
  // The packaged startup reader lives in an extension page, outside the
  // content-script audience of tabs.sendMessage. Its controller accepts only
  // its active random request ID; the worker already checked the document owner.
  const delivery = operation.startup ? chrome.runtime.sendMessage(progress)
    : chrome.tabs.sendMessage(operation.tabId, progress, { documentId: operation.owner });
  delivery.then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});

// Never relay(): a WORKER_TARGET request must be answered here, or the engine's
// storage reads would re-enter the offscreen document.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== WORKER_TARGET) {
    return false;
  }
  handleWorkerRequest(message, sender).then(sendResponse);
  return true;
});

async function handleWorkerRequest(message, sender) {
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.prototype.hasOwnProperty.call(WORKER_HANDLERS, type)) {
    return failureReply(message, new Error(`unknown worker request type ${JSON.stringify(type)}`));
  }
  if (type === "hd_backup_download" && !HOST_CAPABILITIES.backupExport) {
    return failureReply(message, new Error("Backup export is unavailable in this overlay."));
  }
  if (type === "hd_open_external" && !HOST_CAPABILITIES.customLinks) {
    return failureReply(message, new Error("Custom toolbar links are unavailable in this overlay."));
  }
  await sharingReady;
  if (["hd_anki_discover", "hd_anki_setup", "hd_setup_anki"].includes(type)) await sharingTransitionTail;
  if (sharingLinked && ["hd_anki_discover", "hd_anki_setup"].includes(type)) {
    try {
      if (!ankiSettingsSender(sender)) {
        throw new Error(`${type === "hd_anki_setup" ? "Anki setup discovery" : "Anki discovery"} is available only from Hachidori Settings`);
      }
      const allowed = type === "hd_anki_setup"
        ? allowLinkedAnkiSetupRequest(message) : allowLinkedAnkiDiscoveryRequest(message);
      return await getSharingClient().forward(allowed, { capability: LINKED_ANKI_CAPABILITY });
    } catch (error) {
      return failureReply(message, error);
    }
  }
  // The host owns the lookup-count rows a linked engine would otherwise prune.
  if (sharingLinked && type === "hd_lookup_stats_cleanup") return workerReply(message, {});
  if (type === "hd_options_write") {
    let error = null;
    if (!validResponseRequestId(message.requestId ?? null)) {
      error = "the options write request carried an invalid request ID";
    } else if (!responseFits(message)) {
      error = responseLimitError(type);
    }
    if (error !== null) {
      return failureReply(message, error);
    }
  }
  const invoke = () => WORKER_HANDLERS[type](message, sender);
  if (sharingLinked && !engineSender(sender) && WORKER_FORWARDS.has(type)) {
    return forwardWorkerRequest(message).catch(error => failureReply(message, error));
  }
  // Navigation and read-only Anki discovery must not hold up storage commits.
  const run = () => [
    "hd_open_external", "hd_anki_discover", "hd_anki_setup", "hd_setup_anki", "hd_backup_download",
    "hd_lookup_stats_record", "hd_lookup_stats_read",
  ].includes(type) ? invoke() : serialiseStorage(invoke);
  const operation = ["hd_anki_discover", "hd_anki_setup", "hd_setup_anki"].includes(type)
    ? trackAnkiOperation(run) : run();
  return operation.then(
    async (result) => {
      if (type === "hd_backup_cas" && result.ok !== false) {
        try { await reconcileUpdateAlarm(); }
        catch (error) { result.warning = `Restored successfully; update alarm could not be refreshed: ${describe(error)}`; }
      }
      return workerReply(message, result);
    },
    (error) => failureReply(message, error),
  );
}

// Update cycles relay imports back through the engine, which calls into the
// storage handlers above while committing. Keep this listener outside
// serialiseStorage() so the engine can complete that callback.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== UPDATE_TARGET) {
    return false;
  }
  handleUpdatesRequest(message).then(sendResponse);
  return true;
});

async function handleUpdatesRequest(message) {
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.hasOwn(UPDATE_HANDLERS, type)) {
    return failureReply(message, new Error(`unknown update request type ${JSON.stringify(type)}`));
  }
  await sharingReady;
  if (sharingLinked) return forwardToHost(message);
  return Promise.resolve().then(() => UPDATE_HANDLERS[type](message)).then(
    (result) => {
      const { ok = true, error = null, ...payload } = result ?? {};
      return { type: `${type}_result`, requestId: message.requestId ?? null, ok, error, ...payload };
    },
    (error) => failureReply(message, error),
  );
}

// A browser linked through the sharing bridge sends ordinary runtime messages;
// each one is answered by the handler for its target, as if a page sent it.
const SHARING_TARGET = "hachidori-sharing";

async function dispatchSharedRequest(message, clientId) {
  const sender = { id: chrome.runtime.id, url: `hachidori-sharing://client/${clientId}` };
  const ordinary = () => {
    if (!forwardableRequest(message)) {
      throw new Error(`unsupported shared request ${JSON.stringify(message.target)} ${JSON.stringify(message.type)}`);
    }
  };
  try {
    switch (message.target) {
      case TARGET:
        ordinary();
        return await relayEngineRequest(message);
      case WORKER_TARGET:
        if (message.type === "hd_anki_discover") {
          const allowed = allowLinkedAnkiDiscoveryRequest(message);
          ankiGateway ??= createAnkiGateway();
          const options = await readAnkiOptions();
          return workerReply(allowed, await trackAnkiOperation(
            () => ankiGateway.discover({ ...options.anki, model: allowed.model }),
          ));
        }
        if (message.type === "hd_anki_setup") {
          const allowed = allowLinkedAnkiSetupRequest(message);
          const options = await readAnkiOptions();
          return workerReply(allowed, await trackAnkiOperation(() => checkAnkiSetup(options.anki)));
        }
        ordinary();
        return await handleWorkerRequest(message, sender);
      case UPDATE_TARGET:
        ordinary();
        return await handleUpdatesRequest(message);
      case SETUP_TARGET:
        ordinary();
        return await handleRecommendedInstall(message, sender, true);
      case "hachidori-anki": return await trackAnkiOperation(
        () => answerAnkiRequest(allowLinkedAnkiRequest(message), sender, true),
      );
      default: throw new Error(`unsupported shared request target ${JSON.stringify(message.target)}`);
    }
  } catch (error) {
    return failureReply(message, error);
  }
}

async function writeSharingConfig(patch) {
  await serialiseStorage(async () => {
    const stored = await chrome.storage.local.get(SHARING_KEY);
    await writeLocalState({ [SHARING_KEY]: { ...stored[SHARING_KEY], ...patch } });
  });
}

// An empty address means this computer, on the port set under Advanced.
function linkTarget(text) {
  const trimmed = String(text ?? "").trim();
  return parseLinkAddress(trimmed === "" ? `127.0.0.1:${getSharingHost().status().port}` : trimmed);
}

// Own the whole user action, including its probe, independently of storage.
// Network waits must leave the storage queue free for engine callbacks and
// local edits, and a failed action must not block the next Settings tab.
function serialiseSharingTransition(job) {
  const run = sharingTransitionTail.then(() => sharingReady).then(job);
  sharingTransitionTail = run.catch(() => {});
  return run;
}

const SHARING_HANDLERS = {
  hd_sharing_status() {
    return { sharing: sharingStatus() };
  },
  async hd_sharing_client_probe(message) {
    const { address, display } = linkTarget(message.address);
    const hello = await getSharingClient().probe(address);
    return { address, display, host: { version: hello.version, name: hello.name, dictionaryCount: hello.dictionaryCount } };
  },
  // A linked install has nothing of its own to share, and the relay holds one
  // host, so this install stops hosting before it looks for the other one;
  // linking to its own address then finds nothing. The install's own shared
  // values are kept aside for unlinking, then the host's snapshot takes their
  // place under the live keys.
  async hd_sharing_client_link(message) {
    const { address } = linkTarget(message.address);
    const config = (await serialiseStorage(() => chrome.storage.local.get(SHARING_KEY)))[SHARING_KEY];
    if (config?.client?.address === address) return { sharing: sharingStatus() };
    const host = getSharingHost();
    const hosting = host.status();
    let suspendedIndex = false;
    if (hosting.enabled) host.disable();
    try {
      const hello = await getSharingClient().probe(address);
      await waitForAnkiIdle();
      await getAnkiDuplicateIndex().suspend();
      suspendedIndex = true;
      await serialiseStorage(async () => {
        const stored = await chrome.storage.local.get([...SHARED_STATE_KEYS, SHARING_KEY]);
        if (!sameJsonValue(stored[SHARING_KEY], config)) {
          throw new Error("Sharing changed while linking. Try again.");
        }
        const values = {
          [SHARING_KEY]: { ...config, host: { ...config?.host, enabled: false }, client: { address } },
        };
        // Switching hosts keeps the original local state too. Only an install
        // that is currently unlinked may capture the live keys as local data.
        if (!config?.client?.address) {
          values[SHARING_LOCAL_STATE_KEY] = Object.fromEntries(SHARED_STATE_KEYS.map(key => [key, stored[key] ?? null]));
        }
        if (OVERLAY_MODE) values[SHARING_OPTIONS_VERSION_KEY] = null;
        await chrome.storage.local.set(values);
        // Publish routing at the confirmed commit, before another storage job
        // can let the local engine see (or clean up against) the host inventory.
        sharingLinked = true;
        sharingEpoch += 1;
        getSharingClient().link(address);
        await applyMirror(hello.snapshot, true);
      });
    } catch (error) {
      if (suspendedIndex && !sharingLinked) await getAnkiDuplicateIndex().resume();
      if (hosting.enabled && !sharingLinked) host.enable({ port: hosting.port, network: hosting.network.enabled });
      throw error;
    }
    await reconcileUpdateAlarm();
    await applyAnkiIndexRole();
    return { sharing: sharingStatus() };
  },
  // Restored values outrank the mirror in every reader's revision comparison,
  // and the host's lookup-count rows leave with it.
  async hd_sharing_client_unlink() {
    // Finish any request admitted under the linked route before restoring the
    // local route. In particular, do not let media exported for one host be
    // sent to local Anki or abandoned merely because Unlink won a race.
    await waitForAnkiIdle();
    await serialiseStorage(async () => {
      const stored = await chrome.storage.local.get(null);
      // client:null is the durable completion marker. A repeated Unlink must
      // not restore an old snapshot even if its final cleanup failed.
      if (!stored[SHARING_KEY]?.client?.address) return;
      const captured = stored[SHARING_LOCAL_STATE_KEY];
      if (captured) {
        const values = {};
        const removals = [];
        for (const key of SHARED_STATE_KEYS) {
          const local = captured[key];
          if (local === null || local === undefined) {
            if (stored[key] !== undefined) removals.push(key);
            continue;
          }
          values[key] = { ...local, revision: Math.max(optionsRevision(local), optionsRevision(stored[key])) + 1 };
        }
        const prefix = lookupStatsPrefix(values[LOOKUP_STATS_KEY] ?? emptyLookupStats());
        removals.push(...Object.keys(stored).filter(key => key.startsWith(LOOKUP_STATS_ROW_PREFIX) && !key.startsWith(prefix)));
        await writeLocalState(values);
        if (removals.length > 0) await chrome.storage.local.remove(removals);
      }
      // An absent snapshot never authorizes deleting live user data. Keep
      // both the snapshot and linked routing until restoration has succeeded.
      await chrome.storage.local.set({ [SHARING_KEY]: { ...stored[SHARING_KEY], client: null } });
      sharingLinked = false;
      sharingEpoch += 1;
      getSharingClient().unlink();
      await chrome.storage.local.remove(OVERLAY_MODE ? [SHARING_LOCAL_STATE_KEY, SHARING_OPTIONS_VERSION_KEY] : SHARING_LOCAL_STATE_KEY).catch(error => {
        console.warn("hachidori: could not clean up the restored sharing snapshot:", describe(error));
      });
    });
    await reconcileUpdateAlarm();
    await applyAnkiIndexRole();
    return { sharing: sharingStatus() };
  },
  async hd_sharing_host_enable(message) {
    const host = getSharingHost();
    host.enable({ port: message.port, network: message.network === true });
    await writeSharingConfig({ host: { enabled: true, port: host.status().port, network: message.network === true } });
    return { sharing: sharingStatus() };
  },
  async hd_sharing_host_disable() {
    getSharingHost().disable();
    await writeSharingConfig({ host: null });
    return { sharing: sharingStatus() };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== SHARING_TARGET) return false;
  const type = typeof message.type === "string" ? message.type : "";
  Promise.resolve().then(() => {
    if (!Object.hasOwn(SHARING_HANDLERS, type)) throw new Error(`unknown sharing request type ${JSON.stringify(type)}`);
    const invoke = () => SHARING_HANDLERS[type](message, sender);
    return ["hd_sharing_status", "hd_sharing_client_probe"].includes(type)
      ? sharingReady.then(invoke) : serialiseSharingTransition(invoke);
  }).then(result => sendResponse(workerReply(message, result)), error => sendResponse(failureReply(message, error)));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  sharingHost?.storageChanged(changes, area);
});

// A browser install shares by default; the overlay copy is a client, so it
// does not. Turning sharing off stores `host: null`; linking stores it off.
async function initialiseSharing() {
  const stored = await chrome.storage.local.get([SHARING_KEY, DICTIONARY_STATE_KEY]);
  const host = stored[SHARING_KEY]?.host;
  if (host?.enabled === true || (host === undefined && !OVERLAY_MODE)) {
    getSharingHost().enable({ port: host?.port, network: host?.network === true, dictionaries: dictionaryCount(stored[DICTIONARY_STATE_KEY]) });
  }
  const address = stored[SHARING_KEY]?.client?.address;
  if (typeof address === "string" && address !== "") {
    sharingLinked = true;
    if (OVERLAY_MODE) await serialiseStorage(async () => {
      const current = await chrome.storage.local.get(OVERLAY_OPTIONS_STORAGE_KEYS);
      if (!current[SHARING_OPTIONS_VERSION_KEY]) await applyMirror({ options: current[OPTIONS_KEY] ?? null }, true);
    });
    getSharingClient().link(address);
  }
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === ANKI_INDEX_ALARM) {
    void reconcileAnkiIndex();
    return;
  }
  if (alarm.name === SHARING_HOST_ALARM) {
    getSharingHost().reconnect();
    return;
  }
  if (alarm.name !== UPDATE_ALARM) {
    return;
  }
  void sharingReady.then(() => (sharingLinked ? undefined : queueManagedUpdate({ install: true, dueOnly: true }))).catch((error) => {
    console.error("hoshidicts: scheduled dictionary updates failed:", describe(error));
  });
});

chrome.downloads?.onChanged?.addListener(delta => {
  if (!delta.state || delta.state.current === "in_progress") return;
  getBackupDownloads().changed(delta.id).catch(error => {
    console.warn("hoshidicts: could not release a finished backup download:", describe(error));
  });
});

function warmUp() {
  void reconcileAnkiIndex();
  ensureOffscreen().catch((error) => {
    console.error("hoshidicts: could not create the offscreen document:", describe(error));
  });
  reconcileUpdateAlarm().catch((error) => {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describe(error));
  });
}

// A fresh installation seeds its setup state and initial preferences once, then
// opens one startup tab. Only values that are still absent are written, so a
// profile that already carries settings keeps them. Chrome reports "install"
// again on every launch for an unpacked extension loaded from the command line,
// so the absence of a setup record, not the reason alone, identifies a new
// installation.
async function beginFirstRunSetup() {
  const created = await serialiseStorage(async () => {
    const stored = await chrome.storage.local.get([SETUP_STATE_KEY, OPTIONS_KEY]);
    const values = {};
    if (stored[SETUP_STATE_KEY] === undefined) {
      values[SETUP_STATE_KEY] = initialSetupState(new Date().toISOString());
    }
    if (stored[OPTIONS_KEY] === undefined) {
      values[OPTIONS_KEY] = { ...validateOptionsPatch(FIRST_INSTALL_OPTIONS), revision: 1 };
    }
    if (Object.keys(values).length > 0) await writeLocalState(values);
    return Object.hasOwn(values, SETUP_STATE_KEY);
  });
  if (created) await chrome.tabs.create({ url: chrome.runtime.getURL(STARTUP_PAGE) });
}

// An overlay host has no tab to show setup in, so its first launch only seeds
// the initial preferences. It runs on worker start because a host may never
// report onInstalled.
async function seedOverlayModeOptions() {
  await serialiseStorage(async () => {
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    if (stored[OPTIONS_KEY] !== undefined) return;
    const options = validateOptionsPatch({ ...FIRST_INSTALL_OPTIONS, ...OVERLAY_MODE_OPTIONS,
      anki: { ...DEFAULT_OPTIONS.anki, ...OVERLAY_MODE_OPTIONS.anki } });
    await writeLocalState({ [OPTIONS_KEY]: { ...options, revision: 1 } });
  });
}

// Load the dictionaries before the first hover asks for them. Extension updates,
// browser starts and service-worker restarts never reach the first-run path, so
// they cannot reopen setup or reset preferences.
chrome.runtime.onInstalled.addListener((details) => {
  warmUp();
  if (details.reason !== "install" || OVERLAY_MODE) return;
  beginFirstRunSetup().catch((error) => {
    console.error("hoshidicts: could not start first-run setup:", describe(error));
  });
});
chrome.runtime.onStartup.addListener(warmUp);

// Yomitan's native browser shortcuts for the features Hachidori has. The toggle
// makes the toolbar switch's revisioned write inside the storage queue.
async function toggleLookupsFromCommand() {
  await sharingReady;
  const toggle = async () => {
    const { options } = await readDictionaryStorage();
    return { target: WORKER_TARGET, type: "hd_options_write", requestId: null,
      baseRevision: optionsRevision(options), options: { hoverEnabled: !normaliseOptions(options).hoverEnabled } };
  };
  if (sharingLinked) return forwardWorkerRequest(await toggle());
  return serialiseStorage(async () => WORKER_HANDLERS.hd_options_write(await toggle()));
}

// Popup-action shortcuts run their in-page keybind action in the active tab.
// Every frame's reader receives the command; one without an open popup, or
// without a selection for the scans, does nothing.
const READER_CONTENT_TARGET = "hachidori-reader";
const READER_COMMANDS = new Set(["close", "addNote", "viewNotes", "playAudio", "nextEntry", "previousEntry",
  "firstEntry", "lastEntry", "nextEntryDifferentDictionary", "previousEntryDifferentDictionary", "historyBackward",
  "scanSelectedText", "scanTextAtSelection"]);

chrome.commands?.onCommand?.addListener((command, tab) => {
  if (command === "openSettingsPage") {
    chrome.runtime.openOptionsPage().catch((error) => {
      console.error("hachidori: could not open settings:", describe(error));
    });
  } else if (command === "toggleTextScanning") {
    toggleLookupsFromCommand().catch((error) => {
      console.error("hachidori: could not toggle lookups:", describe(error));
    });
  } else if (READER_COMMANDS.has(command) && tab?.id !== undefined) {
    // Pages Chrome keeps content scripts out of, such as chrome://, have no reader.
    chrome.tabs.sendMessage(tab.id, { target: READER_CONTENT_TARGET, type: "hd_reader_command", action: command })
      .catch(() => {});
  }
});

// Alarms may be cleared across browser restarts. Module evaluation is the one
// startup path every MV3 worker takes, including starts not caused by either
// lifecycle event above.
async function initialiseUpdateAlarm() {
  try {
    await reconcileUpdateAlarm();
  } catch (error) {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describe(error));
  }
}

sharingReady = initialiseSharing().catch((error) => {
  console.error("hachidori: could not restore sharing:", describe(error));
});
void initialiseUpdateAlarm(); // NOSONAR -- top-level await prevents this MV3 worker from activating.
void chrome.storage.local.get(OPTIONS_KEY).then(stored =>
  applyCustomJavaScript(chrome, normaliseOptions(stored[OPTIONS_KEY]).customPopupJavascript));

if (OVERLAY_MODE) {
  seedOverlayModeOptions().catch((error) => {
    console.error("hoshidicts: could not seed overlay mode options:", describe(error));
  });
}
void reconcileAnkiIndex(); // NOSONAR -- initialize without delaying worker activation.
