// The worker's own modules are imported first. Chrome hands an installed service
// worker its scripts one at a time; asking for these before the library modules
// lets them compile while the rest are still arriving. Imported last, they made the
// worker start about 2 ms later (Chrome 152).
import {
  DEFAULT_OPTIONS, normaliseOptions, validateOptionsPatch, OFFSCREEN_DOCUMENT, TARGET, UPDATE_TARGET, AUDIO_TARGET,
  SETUP_TARGET, PAGE_ZOOM_TARGET, BACKUP_LIFECYCLE_PORT, WORKER_TARGET, DICTIONARY_STATE_KEY, OPTIONS_KEY,
  ankiSettingsSender, writeLocalState, ensureOffscreen, relay, readDictionaryStorage, optionsRevision, startupSender,
  serialiseStorage, workerReply, failureReply,
} from "./background-core.js";
import {
  WORKER_HANDLERS, handleRecommendedInstall, handleWorkerRequest, SHARING_TARGET,
} from "./background-requests.js";
import { broadcastWordStatus, indexRevision, reconcileAnkiIndex, handleAnkiRequest } from "./background-anki.js";
import {
  automaticBackupNextAt, automaticBackupWaitingForState, getBackupDownloads, scheduleAutomaticBackup,
  queueAutomaticBackup, relayEngineRequest, validBackupPreparationToken, cancelOwnedBackupPreparation, handleAlarm,
} from "./background-backup.js";
import {
  updateCycleActive, reconcileUpdateAlarm, refreshUpdateAlarm, updateTiming, handleUpdatesRequest,
} from "./background-updates.js";
import {
  SHARED_STATE_KEYS, sharingHost, dictionaryCount, LOCAL_UPLOAD_OWNER, answerUploadRequest, sharingLinked,
  forwardToHost, forwardWorkerRequest, serialiseSharingTransition, SHARING_HANDLERS, initialiseSharing,
} from "./background-sharing.js";
import {
  NETFLIX_TARGET, NETFLIX_RECORDER_PORT, NETFLIX_WATCH_URL, adoptNetflixRecorder, handleNetflixRequest,
} from "./background-netflix.js";
import { extensionApi as chrome } from "./browser-api.js";
import { captureWorkerDebugLog } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import "./reader-options.js";
import { ANKI_INDEX_KEY } from "./anki-index-cache.js";
import { AUTOMATIC_BACKUP_ALARM, AUTOMATIC_BACKUPS_KEY, nextAutomaticBackupTime } from "./backup-automatic.js";
import { SHARING_KEY } from "./sharing-host.js";
import { LINKED_IMPORT_CAPABILITY, LINKED_IMPORT_TARGET, allowLinkedImportRequest } from "./sharing-protocol.js";
import { LOOKUP_STATS_ROW_PREFIX } from "./lookup-stats.js";
import "./external-links.js";
import "./dictionary-group-state.js";
import "./word-status-overrides.js";
import { sameJsonValue } from "./json-value.js";
import { OVERLAY_MODE } from "./overlay-mode.js";
import {
  FIRST_INSTALL_OPTIONS, OVERLAY_MODE_OPTIONS, SETUP_STATE_KEY, STARTUP_PAGE, initialSetupState, overlayAnkiOptions,
  withOverlayLookupDefault,
} from "./setup-state.js";
import { applyCustomJavaScript } from "./custom-javascript.js";
import { applyGoogleDocsFlag } from "./google-docs.js";
import { applyNetflixFlag } from "./netflix.js";

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

// Settings → Advanced → Get debug info reads this worker's recent warnings,
// errors and failed replies (debug-log.js).
captureWorkerDebugLog(globalThis, chrome.storage.session);

// The overlay host (Electron 43) exposes chrome.alarms, and create()/get()
// even record the alarm, but onAlarm never dispatches to the worker; a host
// without the API at all behaves the same. Keep the one-shot contract on
// worker-lifetime timers there: a worker restart re-runs the module-load
// reconciliation, which re-arms whatever is still due.
const alarms = chrome.alarms && !OVERLAY_MODE ? chrome.alarms : createTimerAlarms();

function createTimerAlarms() {
  const MAX_TIMER_MS = 2 ** 31 - 1;
  const pending = new Map();
  function arm(name, when) {
    pending.get(name).timer = setTimeout(() => {
      if (Date.now() < when) {
        arm(name, when);
        return;
      }
      pending.delete(name);
      handleAlarm({ name, scheduledTime: when });
    }, Math.min(Math.max(when - Date.now(), 0), MAX_TIMER_MS));
  }
  return {
    async create(name, { when, delayInMinutes }) {
      clearTimeout(pending.get(name)?.timer);
      const scheduledTime = when ?? Date.now() + delayInMinutes * 60_000;
      pending.set(name, { when: scheduledTime });
      arm(name, scheduledTime);
    },
    async get(name) {
      const entry = pending.get(name);
      return entry ? { name, scheduledTime: entry.when } : undefined;
    },
    async clear(name) {
      const entry = pending.get(name);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(name);
      return true;
    },
  };
}

let sharingReady = Promise.resolve(); // NOSONAR: a live binding the other worker modules read

let latestAudioOperation = null;

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
  void applyGoogleDocsFlag(chrome, normaliseOptions(changes[OPTIONS_KEY].newValue).experimental.googleDocs);
  void applyNetflixFlag(chrome, normaliseOptions(changes[OPTIONS_KEY].newValue).experimental.netflixMining);
  const { lowMemoryMode, dictionaryEntryStorage, dictionaryIndexStorage, useLessRamByDefault } = normaliseOptions(changes[OPTIONS_KEY].newValue);
  const previous = normaliseOptions(changes[OPTIONS_KEY].oldValue);
  if (lowMemoryMode === previous.lowMemoryMode && dictionaryEntryStorage === previous.dictionaryEntryStorage
      && dictionaryIndexStorage === previous.dictionaryIndexStorage && useLessRamByDefault === previous.useLessRamByDefault) return;
  // Sent to the offscreen document only if it exists: a document created later
  // reads the option itself. A busy engine picks the change up when idle.
  Promise.resolve(chrome.runtime.sendMessage({ target: TARGET, type: "hd_engine_config", relayed: true,
    lowMemoryMode, dictionaryEntryStorage, dictionaryIndexStorage, useLessRamByDefault }))
    .catch(() => {});
});

// A local index change broadcasts to this install's own tabs and, while
// hosting, to every linked browser. A linked install leaves its own suspended
// index alone and relays the host's revision through the client callback.
// A source change keeps the row revision but answers from other rows (none
// until its first pull), so it is announced without one.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ANKI_INDEX_KEY]) return;
  const { oldValue, newValue } = changes[ANKI_INDEX_KEY];
  let revision;
  if (indexRevision(newValue, "configurationRevision") !== indexRevision(oldValue, "configurationRevision")) {
    revision = null;
  } else if (indexRevision(newValue, "rowRevision") !== indexRevision(oldValue, "rowRevision")) {
    revision = indexRevision(newValue, "rowRevision");
  } else {
    return;
  }
  if (!sharingLinked) broadcastWordStatus(revision);
  sharingHost?.wordStatusChanged(revision);
});

// Only this extension's own recorder page, framed in a Netflix tab, may
// connect, and only while Netflix mining is on: the page is web-accessible to
// Netflix, so a frame the page made itself is refused with the switch off.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== NETFLIX_RECORDER_PORT) return;
  const { sender } = port;
  const tabId = sender?.tab?.id;
  if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("netflix-recorder.html")
      || typeof tabId !== "number" || !sender.frameId || !NETFLIX_WATCH_URL.test(sender.tab.url ?? "")) {
    port.disconnect();
    return;
  }
  let open = true;
  port.onDisconnect.addListener(() => { open = false; });
  chrome.storage.local.get(OPTIONS_KEY).then(stored => {
    if (!open) return;
    if (normaliseOptions(stored[OPTIONS_KEY]).experimental.netflixMining === true) adoptNetflixRecorder(tabId, port);
    else port.disconnect();
  }, () => port.disconnect());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== NETFLIX_TARGET) return false;
  handleNetflixRequest(message, sender).then(result => sendResponse(workerReply(message, result)),
    error => sendResponse(failureReply(message, error)));
  return true;
});

// Anki owns its own mutation queue. Discovery, DOM rendering and network I/O
// must never hold the dictionary storage queue while the engine calls into it.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "hachidori-anki") return false;
  handleAnkiRequest(message, sender).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

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
        error => console.warn("hachidori: could not discard an abandoned backup preparation:", describeErrorOrJson(error)),
      );
    }
  });
  port.onDisconnect.addListener(() => {
    const abandoned = [...owned];
    owned.clear();
    for (const token of abandoned) {
      void cancelOwnedBackupPreparation(token).catch(
        error => console.warn("hachidori: could not discard an abandoned backup preparation:", describeErrorOrJson(error)),
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
  handleWorkerRequest(message, sender).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

// Update cycles relay imports back through the engine, which calls into the
// storage handlers above while committing. Keep this listener outside
// serialiseStorage() so the engine can complete that callback.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== UPDATE_TARGET) {
    return false;
  }
  handleUpdatesRequest(message).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

// Settings, or an app driving this install, uploads a dictionary archive. A
// linked install sends it to the host; otherwise this one imports it.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== LINKED_IMPORT_TARGET) return false;
  sharingReady.then(() => (sharingLinked
    ? forwardToHost(allowLinkedImportRequest(message), LINKED_IMPORT_CAPABILITY)
    : answerUploadRequest(allowLinkedImportRequest(message), LOCAL_UPLOAD_OWNER)))
    .then(sendResponse, error => sendResponse(failureReply(message, error)));
  return true;
});

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
  if (area !== "local") return;
  const relevant = Object.keys(changes).some(key =>
    SHARED_STATE_KEYS.includes(key) || key.startsWith(LOOKUP_STATS_ROW_PREFIX) || key === SHARING_KEY);
  if (relevant && (automaticBackupWaitingForState
      || automaticBackupNextAt !== null && Date.now() >= automaticBackupNextAt)) {
    void queueAutomaticBackup();
  }
});

if (alarms === chrome.alarms) chrome.alarms.onAlarm.addListener(handleAlarm);

chrome.downloads?.onChanged?.addListener(delta => {
  if (!delta.state || delta.state.current === "in_progress") return;
  getBackupDownloads().changed(delta.id).catch(error => {
    console.warn("hoshidicts: could not release a finished backup download:", describeErrorOrJson(error));
  });
});

function warmUp() {
  void reconcileAnkiIndex();
  void queueAutomaticBackup(true);
  ensureOffscreen().catch((error) => {
    console.error("hoshidicts: could not create the offscreen document:", describeErrorOrJson(error));
  });
  reconcileUpdateAlarm().catch((error) => {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describeErrorOrJson(error));
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
// report onInstalled. An unlinked profile that never chose a lookup mode, such
// as one from before overlay mode, then gets the overlay's hover default in an
// ordinary revisioned write that open Settings pages and readers adopt. A
// linked overlay composes the same default instead (composeOverlayOptions).
async function seedOverlayModeOptions() {
  await serialiseStorage(async () => {
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    if (stored[OPTIONS_KEY] !== undefined) return;
    const options = validateOptionsPatch({
      ...FIRST_INSTALL_OPTIONS,
      ...OVERLAY_MODE_OPTIONS,
      anki: overlayAnkiOptions(DEFAULT_OPTIONS).anki,
    });
    await writeLocalState({ [OPTIONS_KEY]: { ...options, revision: 1 } });
  });
  await sharingReady;
  await serialiseStorage(async () => {
    const { options } = await readDictionaryStorage();
    if (sharingLinked || withOverlayLookupDefault(options) === options) return;
    await WORKER_HANDLERS.hd_options_write({ target: WORKER_TARGET, type: "hd_options_write", requestId: null,
      baseRevision: optionsRevision(options), options: { lookupMode: OVERLAY_MODE_OPTIONS.lookupMode } });
  });
}

// Load the dictionaries before the first hover asks for them. Extension updates,
// browser starts and service-worker restarts never reach the first-run path, so
// they cannot reopen setup or reset preferences.
chrome.runtime.onInstalled.addListener((details) => {
  warmUp();
  if (details.reason !== "install" || OVERLAY_MODE) return;
  beginFirstRunSetup().catch((error) => {
    console.error("hoshidicts: could not start first-run setup:", describeErrorOrJson(error));
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
// without a selection for the scans, does nothing. Each frame shows or hides
// its own word highlights.
const READER_CONTENT_TARGET = "hachidori-reader";
const READER_COMMANDS = new Set(["close", "addNote", "viewNotes", "playAudio", "nextEntry", "previousEntry",
  "firstEntry", "lastEntry", "nextEntryDifferentDictionary", "previousEntryDifferentDictionary", "historyBackward",
  "scanSelectedText", "scanTextAtSelection", "toggleWordHighlights", "markWordKnown", "ignoreWord"]);

chrome.commands?.onCommand?.addListener((command, tab) => {
  if (command === "openSettingsPage") {
    chrome.runtime.openOptionsPage().catch((error) => {
      console.error("hachidori: could not open settings:", describeErrorOrJson(error));
    });
  } else if (command === "toggleTextScanning") {
    toggleLookupsFromCommand().catch((error) => {
      console.error("hachidori: could not toggle lookups:", describeErrorOrJson(error));
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
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describeErrorOrJson(error));
  }
}

async function initialiseAutomaticBackupAlarm() {
  try {
    await sharingReady;
    if (sharingLinked) {
      await alarms.clear(AUTOMATIC_BACKUP_ALARM);
      return;
    }
    const stored = (await chrome.storage.local.get(AUTOMATIC_BACKUPS_KEY))[AUTOMATIC_BACKUPS_KEY];
    if (stored === undefined) {
      await queueAutomaticBackup(true);
      return;
    }
    const nextAt = nextAutomaticBackupTime(stored);
    if (Date.now() >= nextAt) await queueAutomaticBackup(true);
    else await scheduleAutomaticBackup(nextAt);
  } catch (error) {
    console.warn("hachidori: could not reconcile the automatic backup alarm:", describeErrorOrJson(error));
  }
}

sharingReady = initialiseSharing().catch((error) => {
  console.error("hachidori: could not restore sharing:", describeErrorOrJson(error));
});
void initialiseUpdateAlarm(); // NOSONAR -- top-level await prevents this MV3 worker from activating.
void initialiseAutomaticBackupAlarm(); // NOSONAR -- top-level await prevents this MV3 worker from activating.
void chrome.storage.local.get(OPTIONS_KEY).then(stored => {
  const options = normaliseOptions(stored[OPTIONS_KEY]);
  void applyCustomJavaScript(chrome, options.customPopupJavascript);
  void applyGoogleDocsFlag(chrome, options.experimental.googleDocs);
  void applyNetflixFlag(chrome, options.experimental.netflixMining);
});

if (OVERLAY_MODE) {
  seedOverlayModeOptions().catch((error) => {
    console.error("hoshidicts: could not seed overlay mode options:", describeErrorOrJson(error));
  });
}
void reconcileAnkiIndex(); // NOSONAR -- initialize without delaying worker activation.

export { alarms, sharingReady };
