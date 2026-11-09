// Sharing in the service worker: the host, the linked client and its mirror, uploads, the relay's API,
// linked option writes, and linking and unlinking.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { describeErrorOrJson } from "./error-text.js";
import { SHARING_KEY, createSharingHost } from "./sharing-host.js";
import { createApiHost } from "./api-host.js";
import { NOT_REACHABLE, SHARING_LOCAL_STATE_KEY, createSharingClient } from "./sharing-client.js";
import {
  API_CAPABILITY, API_CLIENT_ORIGIN, FORWARDED_REQUESTS, LANGUAGE_PROFILES_CAPABILITY, LANGUAGE_PROFILES_OPT_IN,
  LINKED_ANKI_CAPABILITY, LINKED_ANKI_UNSUPPORTED, SHARING_CAPABILITIES, LINKED_IMPORT_CAPABILITY, LINKED_IMPORT_UNSUPPORTED,
  browserName, mutatingForwardedRequest, parseLinkAddress, sharingPort,
} from "./sharing-protocol.js";
import {
  CHANGING_LANGUAGES, PROFILES_NOT_SHARED, PROFILE_REQUEST_TYPES, RECORD_REPLY_TYPES, createLanguageTracker,
  hasLanguagePack, japaneseChanges, japaneseReply, japaneseView, missingLanguages, optInLanguages, packCodes,
  recordLanguages, snapshotLanguages, withoutProfile,
} from "./sharing-languages.js";
import { languageName, languageNames } from "./language-names.js";
import { createUploadHost, uploadImportDecision } from "./linked-import.js";
import { LOOKUP_STATS_KEY, LOOKUP_STATS_ROW_PREFIX, emptyLookupStats, unreachableLookupStatsKeys } from "./lookup-stats.js";
import {
  CUSTOM_DICTIONARY_SOURCE_KEY, customDictionaryDocumentFor, customDictionaryDocumentLanguages, personalDictionaryLanguage,
} from "./custom-dictionary.js";
import { applyToEveryProfile, singleProfileShape } from "./profile-state.js";
import { sameJsonValue } from "./json-value.js";
import { OVERLAY_MODE } from "./overlay-mode.js";
import { OVERLAY_LOCAL_OPTION_KEYS, withOverlayLookupDefault } from "./setup-state.js";
import {
  ANKI_TEMPLATE_CONFIG_KEYS, normaliseOptions, projectStoredOptions, validateOptionsPatch, WORD_STATUS_OVERRIDES_KEY,
  TARGET, WORKER_TARGET, DICTIONARY_STATE_KEY, OPTIONS_KEY, UPDATE_SETTINGS_KEY, engineSender, writeLocalState, relay,
  readDictionaryStorage, optionsRevision, optionsWriteConflict, optionsWriteResult, serialiseStorage, workerReply,
  checkedOptionsResult, failureReply, hasProfiles, hasDictionaryProfiles, optionProfiles, projectDictionaryState,
  JAPANESE_PROFILE_ID, LANGUAGE_SELECTION_KEY, updateLookupProfiles, languageDescriptor,
} from "./background-core.js";
import { getAnkiDuplicateIndex, WORKER_HANDLERS, dispatchSharedRequest } from "./background-requests.js";
import {
  waitForAnkiIdle, readAnkiOptions, readAnkiProfile, broadcastWordStatus, applyAnkiIndexRole, sendAnkiRequest,
} from "./background-anki.js";
import { reconcileAutomaticBackupsAfterSharingTransition } from "./background-backup.js";
import { reconcileUpdateAlarm } from "./background-updates.js";
import { alarms, sharingReady } from "./background.js";

// The user data a linked browser mirrors: the same six keys a backup carries,
// plus the lookup-count rows.
const SHARED_STATE_KEYS = [DICTIONARY_STATE_KEY, OPTIONS_KEY, CUSTOM_DICTIONARY_SOURCE_KEY, UPDATE_SETTINGS_KEY, LOOKUP_STATS_KEY,
  WORD_STATUS_OVERRIDES_KEY];
// What this install is called by the ones it shares with or links to.
const SHARING_NAME = OVERLAY_MODE ? "GameSentenceMiner overlay" : browserName(globalThis.navigator);
let sharingHost; // NOSONAR: a live binding the other worker modules read

function dictionaryCount(state) {
  return Array.isArray(state?.dictionaries) ? state.dictionaries.length : 0;
}

async function readSharedState() {
  const stored = await chrome.storage.local.get(SHARED_STATE_KEYS);
  return Object.fromEntries(SHARED_STATE_KEYS.map(key => [key, stored[key] ?? null]));
}

// ---------------------------------------------------------------------------
// What each linked browser receives from a host whose records have profiles
// (docs/languages.md 17.3-17.6, decision 0009). A browser that opted in gets
// the records as stored; any other gets their Japanese view, and its requests
// are read as naming no profile. A single-profile host keeps today's frames,
// replies and broadcast; these hooks then return at once.
// ---------------------------------------------------------------------------

const SHARING_HOST_CAPABILITIES = [...SHARING_CAPABILITIES, API_CAPABILITY, LINKED_IMPORT_CAPABILITY];
// Whether the records have profiles, as the last read or storage event gave
// them; the projections below run only while they do.
let hostProfiles = false;
let languageTracker = null;

function trackedLanguages() {
  languageTracker ??= createLanguageTracker();
  return languageTracker;
}

// A connection that opted in and still receives the records as stored.
function optedIn(connection) {
  return connection.optIn === "accepted";
}

// The relay's API client keeps no mirror, so no projection change concerns it.
function reconnects(connection) {
  return connection.client.origin !== API_CLIENT_ORIGIN;
}

// Whether a followed connection closes after a storage change: records that
// gain profiles close every one; an opt-in that now lacks one of the host's
// packs is refused; a refused one whose packs now cover the held languages
// reconnects to opt in again.
function closesAfterChange(connection, leftSingleProfile, carried, held) {
  if (leftSingleProfile) return true;
  if (optedIn(connection) && missingLanguages(carried, connection.packs).length > 0) {
    connection.optIn = "refused";
    return true;
  }
  return connection.optIn === "refused" && held !== null && missingLanguages(held, connection.packs).length === 0;
}

// The opt-in, answered in one turn of the storage queue (17.3 item 2, 17.6):
// the snapshot read, the client's pack codes checked against every language
// it holds, the outcome recorded for this connection, whose change frames are
// held until the host has sent this reply.
async function answerLanguageOptIn(message, connection) {
  const packs = optInLanguages(message);
  if (packs === null) return failureReply(message, new Error("The language opt-in named no language packs."));
  return serialiseStorage(async () => {
    const snapshot = await readSharedState();
    if (connection.closing) return failureReply(message, new Error(CHANGING_LANGUAGES));
    hostProfiles = hasProfiles(snapshot[OPTIONS_KEY]);
    trackedLanguages().read(snapshot);
    const missing = missingLanguages(snapshotLanguages(snapshot), packs);
    connection.packs = packs;
    connection.optIn = missing.length === 0 ? "accepted" : "refused";
    connection.queue = [];
    return workerReply(message, { optIn: connection.optIn, snapshot: missing.length === 0 ? snapshot : japaneseView(snapshot),
      missingLanguages: missing, hostLanguages: packCodes() });
  });
}

// A request from a connection that has not opted in names no profile; one
// that opted in may add a language this host has a pack for.
function languageRequest(message, connection) {
  const type = message?.type;
  const profileRequest = message?.target === TARGET && PROFILE_REQUEST_TYPES.has(type);
  if (connection.closing && (RECORD_REPLY_TYPES.has(type) || profileRequest)) {
    return { response: failureReply(message, new Error(CHANGING_LANGUAGES)) };
  }
  if (!optedIn(connection)) {
    if (profileRequest) return { response: failureReply(message, new Error(PROFILES_NOT_SHARED)) };
    return { message: withoutProfile(message) };
  }
  if (profileRequest && type === "hd_profile_add" && !hasLanguagePack(message.language)) {
    return { response: failureReply(message,
      new Error(`The linked Hachidori does not have ${languageName(message.language)}. Update it and try again.`)) };
  }
  return { message };
}

// Whether a reply carries records with profiles, read with the names every
// worker context has.
function replyHasProfiles(response) {
  return hasProfiles(response?.options) || hasDictionaryProfiles(response?.state)
    || (response?.document !== null && typeof response?.document === "object" && Object.hasOwn(response.document, "languages"))
    || Array.isArray(response?.languages);
}

const HOST_LANGUAGE_HOOKS = {
  hello(snapshot) {
    if (!hasProfiles(snapshot[OPTIONS_KEY])) return null;
    hostProfiles = true;
    trackedLanguages().read(snapshot);
    return { snapshot: japaneseView(snapshot), capabilities: [...SHARING_HOST_CAPABILITIES, LANGUAGE_PROFILES_CAPABILITY] };
  },
  async request(message, connection) {
    if (message?.target === WORKER_TARGET && message.type === LANGUAGE_PROFILES_OPT_IN) {
      return { response: await answerLanguageOptIn(message, connection), optIn: true };
    }
    if (!hostProfiles && !connection.closing && connection.optIn === undefined) return { message };
    return languageRequest(message, connection);
  },
  // A connection that would receive a language it lacks gets the Japanese
  // view from that commit and reconnects (17.3 item 6).
  reply(response, message, connection) {
    if (!replyHasProfiles(response)) return response;
    if (optedIn(connection)) {
      const carried = new Set([...recordLanguages(OPTIONS_KEY, response.options),
        ...recordLanguages(DICTIONARY_STATE_KEY, response.state), ...recordLanguages(CUSTOM_DICTIONARY_SOURCE_KEY, response.document)]);
      if (missingLanguages(carried, connection.packs).length === 0) return response;
      connection.optIn = "refused";
      if (reconnects(connection)) connection.closing = true;
    }
    return japaneseReply(message?.type, response);
  },
  storageChanged(changes, connections) {
    const options = changes[OPTIONS_KEY];
    const leftSingleProfile = options !== undefined && !hasProfiles(options.oldValue) && hasProfiles(options.newValue);
    if (options !== undefined) hostProfiles = hasProfiles(options.newValue);
    // With nobody connected nothing is followed; the next hello reads afresh.
    if (connections.length === 0) {
      languageTracker = null;
      return null;
    }
    const followed = connections.some(connection => connection.closing || connection.queue !== null || connection.optIn !== undefined);
    if (!hostProfiles && !leftSingleProfile && !followed) return null;
    // Records that gain profiles are read afresh by the next hello.
    if (leftSingleProfile) languageTracker = null;
    const tracker = trackedLanguages();
    const { carried } = tracker.observe(changes);
    const held = tracker.known ? tracker.held() : null;
    for (const connection of connections) {
      if (connection.closing || !reconnects(connection)) continue;
      if (closesAfterChange(connection, leftSingleProfile, carried, held)) connection.closing = true;
    }
    return {
      frame: (connection, values) => (optedIn(connection) ? values : japaneseChanges(values, tracker.descriptor)),
    };
  },
};

function getSharingHost() {
  sharingHost ??= createSharingHost({
    WebSocket: globalThis.WebSocket,
    alarms,
    dispatch: dispatchSharedRequest,
    readSnapshot: readSharedState,
    sharedKey: key => SHARED_STATE_KEYS.includes(key) || key.startsWith(LOOKUP_STATS_ROW_PREFIX),
    version: chrome.runtime.getManifest().version,
    name: SHARING_NAME,
    capabilities: SHARING_HOST_CAPABILITIES,
    clientClosed: clientId => uploadHost?.dropWhere(owner => owner === remoteUploadOwner(clientId)),
    languages: HOST_LANGUAGE_HOOKS,
  });
  return sharingHost;
}

// Uploads come from this install's own pages or from a linked browser, and
// each belongs to the one that began it.
const UPLOAD_STORE_TARGET = "hachidori-upload-store";
const LOCAL_UPLOAD_OWNER = "local";
let uploadHost;

function remoteUploadOwner(clientId) {
  return `remote:${clientId}`;
}

async function relayUpload(type, fields) {
  const reply = await relay({ target: UPLOAD_STORE_TARGET, type, requestId: `upload-${crypto.randomUUID()}`, ...fields });
  if (!reply?.ok) throw new Error(reply?.error || "The dictionary upload could not be stored.");
  return reply;
}

function getUploadHost() {
  if (uploadHost) return uploadHost;
  // Bytes left by an earlier worker belong to sessions this one never saw.
  const reset = relayUpload("hd_upload_reset", {}).catch(() => {});
  uploadHost = createUploadHost({
    store: {
      append: async (token, data, byteLength) => {
        await reset;
        return relayUpload("hd_upload_append", { token, data, byteLength });
      },
      discard: token => relayUpload("hd_upload_discard", { token }),
    },
    // Never hold the storage queue here: the engine commit calls back into it.
    importUpload: async (token, { fileName, replace, profileId }) => {
      const { identity } = await relayUpload("hd_upload_identity", { token });
      const dictionaries = (await readDictionaryStorage()).state?.dictionaries ?? [];
      return relay({
        target: UPLOAD_STORE_TARGET, type: "hd_upload_import", token, fileName,
        importDecision: uploadImportDecision(identity, dictionaries, replace),
        // The profile the upload names joins the package (docs/languages.md 17.3 item 5).
        ...(profileId === undefined ? {} : { profileId }),
        requestId: `uploaded-import-${crypto.randomUUID()}`,
      });
    },
  });
  return uploadHost;
}

async function answerUploadRequest(message, owner) {
  const host = getUploadHost();
  switch (message.type) {
    case "hd_import_begin": return workerReply(message, host.begin(message, owner));
    case "hd_import_chunk": return workerReply(message, await host.chunk(message, owner));
    case "hd_import_abort": return workerReply(message, host.abort(message, owner));
    default: {
      const reply = await host.commit(message, owner);
      return { ...reply, type: "hd_import_commit_result", requestId: message.requestId };
    }
  }
}

// The relay's API asks like a linked browser; its lookups and renders go
// through the same engine and offscreen senders as Anki mining. Profile index
// 0 is the Japanese profile, which every older GameSentenceMiner uses; later
// indexes list the other profiles in order (docs/languages.md 12).
let apiHost;
async function apiProfile(profileIndex) {
  const stored = (await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY];
  if (!hasProfiles(stored)) return profileIndex === 0 ? { profileId: undefined } : null;
  const others = optionProfiles(stored).filter(profile => profile.id !== JAPANESE_PROFILE_ID);
  if (profileIndex === 0) {
    return optionProfiles(stored).some(profile => profile.id === JAPANESE_PROFILE_ID)
      ? { profileId: JAPANESE_PROFILE_ID } : { profileId: undefined };
  }
  const profile = others[profileIndex - 1];
  return profile === undefined ? null : { profileId: profile.id };
}

async function apiDictionaries(profileId) {
  const { state } = await readDictionaryStorage();
  if (!hasDictionaryProfiles(state)) return state?.dictionaries ?? [];
  // The Relay downloads from the Japanese view (docs/languages.md 17.2),
  // which has no other language's personal package, so neither does the list.
  return (projectDictionaryState(state, profileId ?? JAPANESE_PROFILE_ID)?.dictionaries ?? [])
    .filter(row => [null, JAPANESE_PROFILE_ID].includes(personalDictionaryLanguage(row)));
}

function getApiHost() {
  apiHost ??= createApiHost({
    version: chrome.runtime.getManifest().version,
    engine: fields => sendAnkiRequest(TARGET, fields),
    render: fields => sendAnkiRequest("hachidori-anki-render", fields),
    readDictionaries: apiDictionaries,
    readAudioSources: async profileId => (await readAnkiOptions(profileId)).audioSources.filter(source => source.enabled),
    readAnkiTemplates: async profileId => (await readAnkiOptions(profileId)).anki.templates,
    resolveProfile: apiProfile,
    readProfile: readAnkiProfile,
    readSmallerAnkiCards: async () => (await readAnkiOptions()).smallerAnkiCards,
    readCompactGlossaries: async () => (await readAnkiOptions()).glossaryLayoutMode === "compact-popup-anki",
  });
  return apiHost;
}

// Client side: this install uses another Hachidori. `sharingLinked` is read
// synchronously by the interception points below after `sharingReady`.
let sharingClient;
let sharingLinked = false; // NOSONAR: a live binding the other worker modules read
let sharingEpoch = 0;

// Do not create an offscreen document just to suspend it. A new document reads
// the restored role with hd_engine_config before loading any dictionary code.
function notifyEngineLink() {
  void Promise.resolve(chrome.runtime.sendMessage({ target: TARGET, type: "hd_engine_link",
    relayed: true, linked: sharingLinked })).catch(() => {});
}

let sharingTransitionTail = Promise.resolve(); // NOSONAR: a live binding the other worker modules read
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

// Work admitted before linking finishes against this install's saved state
// before the engine is suspended, so its generations are never judged against
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

// The overlay's local keys stay one value per overlay, laid over every
// profile of a shared record with profiles (docs/languages.md 17.5).
function composeOverlayOptions(shared, local, revision) {
  const preferences = normaliseOptions(withOverlayLookupDefault(local));
  const localValues = Object.fromEntries(OVERLAY_LOCAL_OPTION_KEYS.map(key => [key, preferences[key]]));
  if (hasProfiles(shared)) return { ...applyToEveryProfile(shared, localValues), revision };
  return { ...projectStoredOptions(shared), ...localValues, revision };
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

// This build's pack codes, which the client offers a host with profiles; null
// where no language registry is loaded, so such a client never opts in.
function clientPackCodes() {
  const codes = globalThis.HDLanguages?.codes;
  return Array.isArray(codes) ? [...new Set([JAPANESE_PROFILE_ID, ...codes])] : null;
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
    onWordStatus: revision => broadcastWordStatus(revision),
    languages: clientPackCodes,
  });
  return sharingClient;
}

function sharingStatus() {
  const client = getSharingClient().status();
  return { ...getSharingHost().status(),
    client: { ...client, display: client.address === null ? null : parseLinkAddress(client.address).display } };
}

function forwardToHost(message, capability = null) {
  return getSharingClient().forward(message, {
    capability,
    unsupported: capability === LINKED_IMPORT_CAPABILITY ? LINKED_IMPORT_UNSUPPORTED : LINKED_ANKI_UNSUPPORTED,
    mutation: mutatingForwardedRequest(message),
  }).catch(error => failureReply(message, error));
}

// A linked browser adds and removes languages on its host, once the host has
// accepted its opt-in (docs/languages.md 16.3, 17.3 item 5, 17.6); an add
// names a language both have a pack for.
async function forwardProfileRequest(message) {
  const status = getSharingClient().status();
  if (!status.connected) throw new Error(NOT_REACHABLE);
  const host = status.host?.name || "the linked Hachidori";
  const profiles = status.languageProfiles;
  const language = message.type === "hd_profile_add" && typeof message.language === "string" ? message.language : null;
  if (profiles?.optIn !== "accepted") {
    if (language !== null && profiles?.optIn === "refused") {
      throw new Error(`Update Hachidori in this browser to use ${languageNames(profiles.missingLanguages)} from ${host}.`);
    }
    if (language !== null && profiles === undefined) {
      throw new Error(`Add ${languageName(language)} on ${host} first, in Settings → Advanced → Languages, which Multiple languages in Advanced → Experimental features turns on. If it has no Multiple languages switch, update it there.`);
    }
    throw new Error("Add and remove languages on the linked Hachidori.");
  }
  if (language !== null) {
    if (!profiles.hostLanguages.includes(language)) {
      throw new Error(`The linked Hachidori does not have ${languageName(language)}. Update it and try again.`);
    }
    if (languageDescriptor(language) === null) throw new Error(`This Hachidori has no pack for ${language}.`);
  }
  return forwardToHost(message);
}

function linkedOptionsCapability(message) {
  if (message?.type !== "hd_options_write") return null;
  const patch = message.options;
  return patch && typeof patch === "object"
    && (Object.hasOwn(patch, "anki") || Object.hasOwn(patch, "customButtons"))
    ? LINKED_ANKI_CAPABILITY
    : null;
}

const LINKED_SETTINGS_UPDATE_REQUIRED =
  "Update the linked Hachidori before editing Templates or Custom Buttons.";

function assignMatchingLegacyLinks(incoming, currentLinks, available, assigned) {
  for (const [incomingIndex, button] of incoming.entries()) {
    const match = currentLinks.findIndex((candidate, currentIndex) => available.has(currentIndex)
      && candidate.label === button.label && candidate.url === button.url);
    if (match < 0) continue;
    assigned[incomingIndex] = match;
    available.delete(match);
  }
}

function assignPositionedLegacyLinks(incoming, available, assigned) {
  for (let index = 0; index < incoming.length; index += 1) {
    if (assigned[index] >= 0 || !available.has(index)) continue;
    assigned[index] = index;
    available.delete(index);
  }
}

function mergeLegacyCustomLinks(currentButtons, links) {
  const incoming = validateOptionsPatch({ customLinks: links }).customButtons;
  const currentLinks = currentButtons.filter(button => button.type === "link");
  const assigned = new Array(incoming.length).fill(-1);
  const available = new Set(currentLinks.map((_, index) => index));
  // Preserve identity through legacy reordering before treating a changed row
  // as an edit of the link that occupied the same legacy position.
  assignMatchingLegacyLinks(incoming, currentLinks, available, assigned);
  assignPositionedLegacyLinks(incoming, available, assigned);
  const usedIds = new Set(currentButtons.filter(button => button.type !== "link").map(button => button.id));
  for (const currentIndex of assigned) {
    if (currentIndex >= 0) usedIds.add(currentLinks[currentIndex].id);
  }
  let generated = 1;
  const nextLinks = incoming.map((button, index) => {
    if (assigned[index] >= 0) return { ...button, id: currentLinks[assigned[index]].id };
    let id = `legacy-link-${generated++}`;
    while (usedIds.has(id)) id = `legacy-link-${generated++}`;
    usedIds.add(id);
    return { ...button, id };
  });
  let linkIndex = 0;
  const merged = [];
  for (const button of currentButtons) {
    if (button.type === "link") {
      if (linkIndex < nextLinks.length) merged.push(nextLinks[linkIndex++]);
    } else {
      merged.push(button);
    }
  }
  merged.push(...nextLinks.slice(linkIndex));
  return merged;
}

function mergeLegacyAnki(current, legacy) {
  const first = {
    id: current.templates[0].id,
    name: current.templates[0].name,
    ...Object.fromEntries(ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, legacy[key]])),
  };
  return {
    url: legacy.url,
    apiKey: legacy.apiKey,
    templates: [first, ...current.templates.slice(1)],
    ...Object.fromEntries(ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, first[key]])),
  };
}

async function compatibleLinkedWorkerMessage(message, sender) {
  const capabilities = sender.linkedCapabilities;
  if (message.type !== "hd_options_write" || !Array.isArray(capabilities)
      || capabilities.includes(LINKED_ANKI_CAPABILITY)) return message;
  const patch = message.options;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return message;
  const richAnki = patch.anki && typeof patch.anki === "object"
    && Object.hasOwn(patch.anki, "templates");
  if (Object.hasOwn(patch, "customButtons") || richAnki) {
    throw new Error(LINKED_SETTINGS_UPDATE_REQUIRED);
  }
  if (!Object.hasOwn(patch, "customLinks") && !Object.hasOwn(patch, "anki")) return message;
  const stored = normaliseOptions((await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]);
  const compatible = { ...patch };
  if (Object.hasOwn(patch, "customLinks")) {
    compatible.customButtons = mergeLegacyCustomLinks(stored.customButtons, patch.customLinks);
    delete compatible.customLinks;
  }
  if (Object.hasOwn(patch, "anki")) {
    const legacy = validateOptionsPatch({ anki: patch.anki }).anki;
    compatible.anki = mergeLegacyAnki(stored.anki, legacy);
  }
  return { ...message, options: compatible };
}

function forwardWorkerRequest(message) {
  return OVERLAY_MODE && message.type === "hd_options_write"
    ? writeLinkedOverlayOptions(message)
    : forwardToHost(message, linkedOptionsCapability(message));
}

function localOverlayOptionsValues(options, patch, stored) {
  const changed = options.revision - optionsRevision(stored[OPTIONS_KEY]);
  if (changed === 0) return {};
  const version = stored[SHARING_OPTIONS_VERSION_KEY];
  const values = { [OPTIONS_KEY]: options,
    [SHARING_OPTIONS_VERSION_KEY]: { ...version, offset: version.offset + changed } };
  const captured = stored[SHARING_LOCAL_STATE_KEY];
  if (captured) values[SHARING_LOCAL_STATE_KEY] = { ...captured,
    options: hasProfiles(captured.options)
      ? { ...applyToEveryProfile(captured.options, patch), revision: optionsRevision(captured.options) + 1 }
      : { ...captured.options, ...patch, revision: optionsRevision(captured.options) + 1 } };
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
    let options = result.options;
    if (hasProfiles(stored[OPTIONS_KEY])) {
      options = applyToEveryProfile(stored[OPTIONS_KEY], local);
      if (!sameJsonValue(options, stored[OPTIONS_KEY])) options.revision += 1;
    }
    const values = localOverlayOptionsValues(options, local, stored);
    if (Object.keys(values).length > 0) await writeLocalState(values);
    // The reply carries the record just stored, as finishOverlayOptionsWrite's.
    return { reply: workerReply(message, { ...result, options }) };
  }
  return { local, shared, version: stored[SHARING_OPTIONS_VERSION_KEY], epoch: sharingEpoch };
}

// The overlay's own keys written into the record: into every profile once
// the record has profiles, else into the record; a change moves the revision on.
function withLocalOverlayKeys(current, local) {
  if (hasProfiles(current)) {
    const options = applyToEveryProfile(current, local);
    if (!sameJsonValue(options, current)) options.revision += 1;
    return options;
  }
  const options = { ...current, ...local };
  if (Object.entries(local).some(([key, value]) => current[key] !== value)) options.revision += 1;
  return options;
}

// The browser's own language choice comes back with its records; an unlink
// whose restored records are in the single-profile shape removes the key
// (docs/languages.md 4.4).
function restoreLanguageSelection(captured, stored, values, removals) {
  if (captured[LANGUAGE_SELECTION_KEY] !== undefined && captured[LANGUAGE_SELECTION_KEY] !== null) {
    values[LANGUAGE_SELECTION_KEY] = unlinkedLocalValue(LANGUAGE_SELECTION_KEY, captured[LANGUAGE_SELECTION_KEY],
      stored[LANGUAGE_SELECTION_KEY]);
  } else if (stored[LANGUAGE_SELECTION_KEY] !== undefined && singleProfileShape({ options: captured[OPTIONS_KEY],
    state: captured[DICTIONARY_STATE_KEY], document: captured[CUSTOM_DICTIONARY_SOURCE_KEY],
    lookupStats: captured[LOOKUP_STATS_KEY], wordStatusOverrides: captured[WORD_STATUS_OVERRIDES_KEY] })) {
    removals.push(LANGUAGE_SELECTION_KEY);
  }
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
      options = withLocalOverlayKeys(current, prepared.local);
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
  const forwarded = { ...message, options: prepared.shared, baseRevision: prepared.version.hostRevision };
  const reply = await forwardToHost(forwarded, linkedOptionsCapability(forwarded));
  return serialiseStorage(() => finishOverlayOptionsWrite(message, prepared, reply));
}

async function writeSharingConfig(patch) {
  await serialiseStorage(async () => {
    const stored = await chrome.storage.local.get(SHARING_KEY);
    await writeLocalState({ [SHARING_KEY]: { ...stored[SHARING_KEY], ...patch } });
  });
}

// An empty address means this computer, on the port Settings is showing under
// Advanced, or else the stored one. The other browser may share through a relay
// on a port this install has never used itself (#648).
function linkTarget(text, port = null) {
  const trimmed = String(text ?? "").trim();
  const localPort = sharingPort(port) ?? getSharingHost().status().port;
  return parseLinkAddress(trimmed === "" ? `127.0.0.1:${localPort}` : trimmed);
}

// Own the whole user action, including its probe, independently of storage.
// Network waits must leave the storage queue free for engine callbacks and
// local edits, and a failed action must not block the next Settings tab.
function serialiseSharingTransition(job) {
  const run = sharingTransitionTail.then(() => sharingReady).then(job);
  sharingTransitionTail = run.catch(() => {});
  return run;
}

// Unlink restores each kept local value above the mirror's revision. A linked
// overlay composed a mode-less local options record on hover; it stays there.
function unlinkedLocalValue(key, local, mirrored) {
  const value = OVERLAY_MODE && key === OPTIONS_KEY ? withOverlayLookupDefault(local) : local;
  const restored = { ...value, revision: Math.max(optionsRevision(local), optionsRevision(mirrored)) + 1 };
  // Every language's personal document is adopted like the top-level one
  // (docs/languages.md 4.3), so it too comes back above the mirror's revision.
  if (key === CUSTOM_DICTIONARY_SOURCE_KEY && restored.languages) {
    restored.languages = Object.fromEntries(customDictionaryDocumentLanguages(local).map(code => {
      const mirroredDocument = customDictionaryDocumentLanguages(mirrored).includes(code)
        ? customDictionaryDocumentFor(mirrored, code) : null;
      return [code, { ...local.languages[code],
        revision: Math.max(local.languages[code].revision ?? 0, mirroredDocument?.revision ?? 0) + 1 }];
    }));
  }
  return restored;
}

const SHARING_HANDLERS = {
  hd_sharing_status() {
    return { sharing: sharingStatus() };
  },
  async hd_sharing_client_probe(message) {
    const { address, display } = linkTarget(message.address, message.port);
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
    let hello;
    if (hosting.enabled) host.disable();
    try {
      // A host with profiles answers the probe's opt-in; the link stores
      // that reply's snapshot (docs/languages.md 17.3 item 2).
      hello = await getSharingClient().probe(address, { optIn: true });
      await waitForAnkiIdle();
      await getAnkiDuplicateIndex().suspend();
      suspendedIndex = true;
      await serialiseStorage(async () => {
        const stored = await chrome.storage.local.get([...SHARED_STATE_KEYS, SHARING_KEY, LANGUAGE_SELECTION_KEY]);
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
          if (stored[LANGUAGE_SELECTION_KEY] !== undefined) {
            values[SHARING_LOCAL_STATE_KEY][LANGUAGE_SELECTION_KEY] = stored[LANGUAGE_SELECTION_KEY];
          }
        }
        if (OVERLAY_MODE) values[SHARING_OPTIONS_VERSION_KEY] = null;
        await chrome.storage.local.set(values);
        // Publish routing at the confirmed commit, before another storage job
        // can let the local engine see (or clean up against) the host inventory.
        sharingLinked = true;
        sharingEpoch += 1;
        notifyEngineLink();
        getSharingClient().link(address);
        await applyMirror(hello.snapshot, true);
      });
    } catch (error) {
      if (suspendedIndex && !sharingLinked) await getAnkiDuplicateIndex().resume();
      if (hosting.enabled && !sharingLinked) host.enable({ port: hosting.port, network: hosting.network.enabled });
      throw error;
    }
    await reconcileUpdateAlarm();
    await reconcileAutomaticBackupsAfterSharingTransition();
    await applyAnkiIndexRole();
    // What the probe's opt-in found, for the page that linked; a host without
    // the capability gives today's reply.
    return { sharing: sharingStatus(), ...(hello.languageProfiles === undefined ? {} : { languageProfiles: hello.languageProfiles }) };
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
          values[key] = unlinkedLocalValue(key, local, stored[key]);
        }
        removals.push(...unreachableLookupStatsKeys(Object.keys(stored), values[LOOKUP_STATS_KEY] ?? emptyLookupStats()));
        restoreLanguageSelection(captured, stored, values, removals);
        await writeLocalState(values);
        if (removals.length > 0) await chrome.storage.local.remove(removals);
      }
      // An absent snapshot never authorizes deleting live user data. Keep
      // both the snapshot and linked routing until restoration has succeeded.
      await chrome.storage.local.set({ [SHARING_KEY]: { ...stored[SHARING_KEY], client: null } });
      sharingLinked = false;
      sharingEpoch += 1;
      notifyEngineLink();
      getSharingClient().unlink();
      await chrome.storage.local.remove(OVERLAY_MODE ? [SHARING_LOCAL_STATE_KEY, SHARING_OPTIONS_VERSION_KEY] : SHARING_LOCAL_STATE_KEY).catch(error => {
        console.warn("hachidori: could not clean up the restored sharing snapshot:", describeErrorOrJson(error));
      });
    });
    await reconcileUpdateAlarm();
    await reconcileAutomaticBackupsAfterSharingTransition();
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

// A browser install shares by default; the overlay copy is a client, so it
// does not. Turning sharing off stores `host: null`; linking stores it off.
async function initialiseSharing() {
  const stored = await chrome.storage.local.get([SHARING_KEY, DICTIONARY_STATE_KEY, OPTIONS_KEY]);
  updateLookupProfiles({ [OPTIONS_KEY]: stored[OPTIONS_KEY], [DICTIONARY_STATE_KEY]: stored[DICTIONARY_STATE_KEY] });
  hostProfiles = hasProfiles(stored[OPTIONS_KEY]);
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

export {
  SHARED_STATE_KEYS, sharingHost, dictionaryCount, getSharingHost, LOCAL_UPLOAD_OWNER, remoteUploadOwner,
  answerUploadRequest, getApiHost, sharingLinked, sharingTransitionTail, WORKER_FORWARDS, linkedAnkiConfigKey,
  hostLinkedAnkiRequest, stateStore, getSharingClient, forwardToHost, forwardProfileRequest, compatibleLinkedWorkerMessage,
  forwardWorkerRequest, serialiseSharingTransition, SHARING_HANDLERS, initialiseSharing,
};
