/*
 * Bridges Chrome runtime messages to the Hoshidicts engine.
 *
 * Browsers with pthread and OPFS support use the dedicated worker. Other
 * browsers use the single-thread IDBFS compatibility runtime.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { boundResponseFailure } from "./response-limits.js";

const TARGET = "hoshidicts-offscreen";
const AUDIO_TARGET = "hachidori-audio";
const ANKI_TARGET = "hachidori-anki-render";
const SETUP_TARGET = "hachidori-setup";
let audioService, ankiService, audioRepository, setupInstaller;
let captureService;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "hachidori-capture-page" || message.relayed !== true
      || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("background.js")
      || sender.tab !== undefined) return false;
  captureService ??= import("./capture-host.js");
  captureService.then(module => module.handleCaptureMessage(message)).then(
    result => sendResponse({ type: `${message.type}_result`, requestId: message.requestId, ok: true, ...result }),
    error => sendResponse(failedResponse(message, describe(error))),
  );
  return true;
});

function getAudioRepository() {
  audioRepository ??= import("./audio-repository.js").then(module => module.createAudioRepository({
    window: globalThis, fetch: globalThis.fetch.bind(globalThis), now: () => performance.now(),
  }));
  return audioRepository;
}
const MAX_PENDING_REQUESTS = 128;
const PROBE_TIMEOUT_MS = 10_000;
const MUTATION_TYPES = new Set([
  "hd_apply_state",
  "hd_reload",
  "hd_remove",
  "hd_custom_save",
  "hd_backup_export",
  "hd_backup_prepare",
  "hd_backup_auto_prepare",
  "hd_backup_auto_cleanup",
  "hd_backup_restore",
  "hd_backup_cancel",
]);
const STAGED_MUTATION_TYPES = new Set(["hd_custom_append"]);
const IMPORT_READ_TYPES = new Set([
  "hd_lookup",
  "hd_lookup_dictionary",
  "hd_kanji",
  "hd_styles",
  "hd_media",
  "hd_backup_release",
]);
const STAGED_MUTATION_READ_TYPES = new Set([
  "hd_lookup",
  "hd_lookup_dictionary",
  "hd_kanji",
  "hd_styles",
  "hd_media",
]);

function supportsSharedWasmMemory() {
  if (globalThis.crossOriginIsolated !== true
      || typeof globalThis.SharedArrayBuffer !== "function"
      || typeof globalThis.WebAssembly?.Memory !== "function") {
    return false;
  }
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBuffer;
  } catch {
    return false;
  }
}

const CAN_THREAD = supportsSharedWasmMemory();

let worker = null;
let localEngine = null;
let nextRequestId = 0;
let engineError = null;
let activeMutationRequestId = null;
let activeStagedMutationRequestId = null;
let activeImportRequestId = null;
let lastEngineStatus = {
  ok: true,
  error: null,
  ready: false,
  loading: true,
  dictionaryCount: 0,
  failedDictionaries: [],
  generation: 0,
};
const pending = new Map();

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function failedResponse(message, error, errorCode = null) {
  return boundResponseFailure({
    type: `${message?.type || "hd_unknown"}_result`,
    requestId: message?.requestId ?? null,
    ok: false,
    error,
    ...(errorCode === null ? {} : { errorCode }),
  });
}

function finishRequest(id, response) {
  const request = pending.get(id);
  if (request === undefined) return;
  pending.delete(id);
  if (id === activeMutationRequestId) activeMutationRequestId = null;
  if (id === activeStagedMutationRequestId) activeStagedMutationRequestId = null;
  if (id === activeImportRequestId) activeImportRequestId = null;
  if (response?.type === "hd_status_result") {
    lastEngineStatus = {
      ...lastEngineStatus,
      ok: response.ok === true,
      error: response.error ?? null,
      ready: response.ready === true,
      loading: response.loading === true,
      dictionaryCount: Number(response.dictionaryCount) || 0,
      failedDictionaries: Array.isArray(response.failedDictionaries) ? response.failedDictionaries : [],
      generation: Number(response.generation) || 0,
    };
  }
  request.sendResponse(response);
}

function adoptEngineProgress(progress) {
  const id = activeImportRequestId;
  const request = pending.get(id);
  if (request === undefined || request.message.requestId !== progress?.requestId) {
    return false;
  }
  if (progress.phase === "installing") {
    activeImportRequestId = null;
    activeMutationRequestId = id;
  }
  setupInstaller?.then((installer) => installer.progress(progress));
  return true;
}

function failEngine(error) {
  if (engineError !== null) return;
  engineError = describe(error) || "the Hoshidicts engine stopped";
  console.error(`hoshidicts: engine failed: ${engineError}`);
  for (const [id, request] of pending) {
    finishRequest(id, failedResponse(request.message, engineError, "engine-start-failed"));
  }
}

function probeDirectOpfs() {
  return new Promise((resolve) => {
    let probe = null;
    let timer = null;
    let settled = false;
    const finish = (ok, error = "") => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      probe?.terminate();
      resolve({ ok, error });
    };
    try {
      probe = new Worker(new URL("./opfs-capability-worker.js", import.meta.url), {
        type: "module",
        name: "hoshidicts-opfs-capability",
      });
      probe.addEventListener("error", (event) => finish(false, describe(event.error || event.message)));
      probe.addEventListener("messageerror", () => finish(false, "the OPFS capability worker sent an unreadable message"));
      probe.addEventListener("message", (event) => {
        if (event.data?.channel !== "opfs-capability-result") return;
        finish(event.data.ok === true, describe(event.data.error || ""));
      });
      timer = setTimeout(() => finish(false, "the OPFS capability probe timed out"), PROBE_TIMEOUT_MS);
      probe.postMessage({ channel: "opfs-capability-probe" });
    } catch (error) {
      finish(false, describe(error));
    }
  });
}

async function shouldUseThreadedEngine() {
  if (!CAN_THREAD || typeof globalThis.Worker !== "function"
      || typeof navigator.storage?.getDirectory !== "function") {
    return false;
  }
  const result = await probeDirectOpfs();
  if (!result.ok) {
    console.warn(`hoshidicts: direct OPFS is unavailable, using IDBFS: ${result.error}`);
  }
  return result.ok;
}

function startWorkerEngine() {
  worker = new Worker(new URL("./engine-worker.js", import.meta.url), {
    type: "module",
    name: "hoshidicts-engine",
  });
  worker.addEventListener("error", (event) => failEngine(event.error || event.message));
  worker.addEventListener("messageerror", () => failEngine("the engine worker sent an unreadable message"));
  worker.onmessage = (event) => {
    const data = event.data;
    if (data?.channel === "host-request") {
      Promise.resolve(chrome.runtime.sendMessage(data.message)).then(
        (response) => worker.postMessage({ channel: "host-response", id: data.id, ok: true, response }),
        (error) => worker.postMessage({ channel: "host-response", id: data.id, ok: false, error: describe(error) }),
      );
      return;
    }
    if (data?.channel === "engine-progress") {
      const adopted = adoptEngineProgress(data.progress);
      if (data.id !== undefined) {
        worker.postMessage({
          channel: "engine-progress-ack",
          id: data.id,
          ok: adopted,
          error: adopted ? null : "the import request is no longer active",
        });
      }
      return;
    }
    if (data?.channel !== "engine-response") return;
    finishRequest(data.id, data.response);
  };
}

function reportEngineProgress(progress) {
  const adopted = adoptEngineProgress(progress);
  if (!adopted && progress?.phase === "installing") {
    throw new Error("the import request is no longer active");
  }
}

function startLocalEngine() {
  return Promise.all([
    import("./engine-service.js"),
    import("./vendor/hoshidicts.mjs"),
  ]).then(([service, module]) => {
    service.configureEngineService(
      (message) => chrome.runtime.sendMessage(message),
      {
        createHoshidicts: module.default,
        storageBackend: "idbfs",
        lowRam: true,
        reportProgress: reportEngineProgress,
      },
    );
    service.startEngine();
    localEngine = service;
  });
}

const engineSelection = shouldUseThreadedEngine().then((threaded) => {
  lastEngineStatus.storageBackend = threaded ? "opfs" : "idbfs";
  lastEngineStatus.threaded = threaded;
  return threaded ? startWorkerEngine() : startLocalEngine();
}).catch(failEngine);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (![AUDIO_TARGET, ANKI_TARGET].includes(message?.target) || message.relayed !== true) return false;
  let service;
  if (message.target === AUDIO_TARGET) {
    audioService ??= Promise.all([import("./audio-offscreen.js"), getAudioRepository()])
      .then(([module, repository]) => module.createAudioService(globalThis, repository));
    service = audioService;
  } else {
    ankiService ??= import("./anki-offscreen.js").then(module => module.createAnkiOffscreenService(globalThis, getAudioRepository));
    service = ankiService;
  }
  service.then(handle => handle(message)).then(
    result => sendResponse({ type: `${message.type}_result`, requestId: message.requestId, ok: true, ...result }),
    error => sendResponse(failedResponse(message, describe(error))),
  );
  return true;
});

// Admission and the mutation lock are shared by relayed runtime requests and the
// first-run installer, so both see one engine queue.
function dispatchEngine(message, sendResponse) {
  if (engineError !== null) {
    sendResponse(failedResponse(message, engineError, "engine-start-failed"));
    return;
  }
  if (message.type === "hd_status"
      && (activeMutationRequestId !== null
        || activeStagedMutationRequestId !== null
        || activeImportRequestId !== null
        || pending.size >= MAX_PENDING_REQUESTS)) {
    sendResponse({
      type: "hd_status_result",
      requestId: message.requestId ?? null,
      ...lastEngineStatus,
      loading: activeMutationRequestId !== null
        || activeStagedMutationRequestId !== null
        || activeImportRequestId !== null
        || lastEngineStatus.loading,
    });
    return;
  }
  const activeMutation = pending.get(activeMutationRequestId)?.message;
  const cancelsBackup = message.type === "hd_backup_cancel" && typeof message.token === "string" && message.token !== "";
  if (activeMutationRequestId !== null && message.type !== "hd_backup_release" && !cancelsBackup) {
    sendResponse(failedResponse(message, "the dictionary engine is busy mutating", "engine-mutating"));
    return;
  }
  if (activeStagedMutationRequestId !== null
      && !STAGED_MUTATION_READ_TYPES.has(message.type)
      && message.type !== "hd_status") {
    sendResponse(failedResponse(message, "the dictionary engine is busy mutating", "engine-mutating"));
    return;
  }
  if (activeImportRequestId !== null && !IMPORT_READ_TYPES.has(message.type)) {
    sendResponse(failedResponse(message, "the dictionary engine is busy mutating", "engine-mutating"));
    return;
  }
  // One serialized download release and one token-scoped backup cancellation
  // must fit even if ordinary requests occupy all 128 slots. The cancellation
  // remains queued behind the active mutation and takes over its lock.
  const cleanupSlots = message.type === "hd_backup_release"
    ? 1 + Number(activeMutation?.type === "hd_backup_cancel") : 2 * Number(cancelsBackup);
  const limit = MAX_PENDING_REQUESTS + cleanupSlots;
  if (pending.size >= limit) {
    sendResponse(failedResponse(message, "the dictionary engine request queue is full"));
    return;
  }

  // Reserve before engine selection or module loading can retain the payload.
  const id = ++nextRequestId;
  pending.set(id, { message, sendResponse });
  if (message.type === "hd_import") activeImportRequestId = id;
  else if (MUTATION_TYPES.has(message.type)) activeMutationRequestId = id;
  else if (STAGED_MUTATION_TYPES.has(message.type)) activeStagedMutationRequestId = id;
  engineSelection.then(() => {
    if (!pending.has(id)) return undefined;
    if (worker === null) {
      return localEngine.handleEngineMessage(message).then((response) => finishRequest(id, response));
    }
    worker.postMessage({ channel: "engine-request", id, message });
    return undefined;
  }).catch((error) => finishRequest(id, failedResponse(message, describe(error), "engine-start-failed")));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET || message.relayed !== true) {
    return false;
  }
  dispatchEngine(message, sendResponse);
  return true;
});

// Startup and Settings ask this document, not the engine, to install recommended
// dictionaries: the run must outlive the page and any service-worker restart.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== SETUP_TARGET || message.relayed !== true) return false;
  setupInstaller ??= import("./setup-installer.js").then((module) => module.createSetupInstaller({
    dispatch: (request) => new Promise((resolve) => dispatchEngine(request, resolve)),
    ask: (request) => chrome.runtime.sendMessage(request),
    notify: (request) => chrome.runtime.sendMessage(request),
    broadcast: (event) => Promise.resolve(chrome.runtime.sendMessage(event)).catch(() => {}),
  }));
  setupInstaller.then((installer) => {
    if (message.type !== "hd_setup_install") throw new Error(`unknown setup request type ${JSON.stringify(message.type)}`);
    return installer.attach(message.sourceIds, { recordSetup: message.recordSetup === true });
  }).then(
    (result) => sendResponse({ type: `${message.type}_result`, requestId: message.requestId ?? null, ok: true, error: null, ...result }),
    (error) => sendResponse(failedResponse(message, describe(error))),
  );
  return true;
});
