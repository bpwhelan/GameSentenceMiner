/*
 * Bridges extension runtime messages to the Hoshidicts engine.
 *
 * Browsers with pthread and OPFS support use the dedicated worker on direct
 * OPFS. Hosts with pthread support but no OPFS access handles (Electron) use
 * the dedicated worker on IDBFS. Other browsers use the single-thread IDBFS
 * compatibility runtime on this document.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { extensionApi as chrome, expectedBackgroundUrl } from "./browser-api.js";
import { engineWorkerName, createEngineRecycler } from "./engine-recycler.js";
import { boundResponseFailure } from "./response-limits.js";
import { decodeBase64 } from "./base64.js";

const TARGET = "hoshidicts-offscreen";
const WORKER_TARGET = "hoshidicts-worker";
const AUDIO_TARGET = "hachidori-audio";
const ANKI_TARGET = "hachidori-anki-render";
const SETUP_TARGET = "hachidori-setup";
const UPLOAD_STORE_TARGET = "hachidori-upload-store";
let audioService, ankiService, audioRepository, setupInstaller;
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
const POLL_TYPES = new Set(["hd_status", "hd_memory"]);
const IMPORT_READ_TYPES = new Set([
  "hd_lookup",
  "hd_lookup_dictionary",
  "hd_kanji",
  "hd_styles",
  "hd_media",
  "hd_memory",
  "hd_backup_release",
  "hd_api_dictionary_read",
  "hd_api_dictionary_close",
]);
const STAGED_MUTATION_READ_TYPES = new Set([
  "hd_lookup",
  "hd_lookup_dictionary",
  "hd_kanji",
  "hd_styles",
  "hd_media",
  "hd_memory",
  "hd_api_dictionary_read",
  "hd_api_dictionary_close",
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
let workerScript = null;
let localEngine = null;
let nextRequestId = 0;
let engineError = null;
let activeMutationRequestId = null;
let activeStagedMutationRequestId = null;
let activeImportRequestId = null;
// The phase of the import this bridge is running, reported by hd_status while
// the engine's own status is not consulted.
let importPhase = null;
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
// Engine-side state one request leaves for a later one to consume: a prepared
// backup, an exported archive URL, a dictionary download. A worker restart
// would lose it, so the recycler waits until it is released.
const held = new Set();

// Low memory mode (docs/memory.md): the worker is replaced when idle after a
// dictionary change, or when the stored option no longer matches the worker.
const recycler = createEngineRecycler({
  isIdle: () => pending.size === 0 && held.size === 0,
  restart: (lowMemory, dictionaryEntryStorage) => {
    worker.terminate();
    startWorkerEngine(workerScript, lowMemory, dictionaryEntryStorage);
  },
});

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

function trackHeldState(message, response) {
  const ok = response?.ok === true;
  switch (message.type) {
    case "hd_backup_prepare":
    case "hd_backup_auto_prepare":
      // Preparing discards any earlier prepared backup first.
      for (const key of held) {
        if (key.startsWith("backup:")) held.delete(key);
      }
      if (ok) held.add(`backup:${response.token}`);
      break;
    case "hd_backup_restore":
    case "hd_backup_cancel":
      held.delete(`backup:${message.token}`);
      break;
    case "hd_backup_export":
      if (ok) held.add(`export:${response.blobUrl}`);
      break;
    case "hd_backup_release":
      held.delete(`export:${message.blobUrl}`);
      break;
    case "hd_api_dictionary_open":
      if (ok) held.add(`download:${response.token}`);
      break;
    case "hd_api_dictionary_close":
      held.delete(`download:${message.token}`);
      break;
    default:
      break;
  }
}

function finishRequest(id, response) {
  const request = pending.get(id);
  if (request === undefined) return;
  pending.delete(id);
  const mutated = id === activeMutationRequestId || id === activeStagedMutationRequestId || id === activeImportRequestId;
  if (id === activeMutationRequestId) activeMutationRequestId = null;
  if (id === activeStagedMutationRequestId) activeStagedMutationRequestId = null;
  if (id === activeImportRequestId) activeImportRequestId = null;
  if (request.message.type === "hd_import") importPhase = null;
  trackHeldState(request.message, response);
  // A successful native reorder allocates no dictionary/import high-water
  // mark. Keep an already pending import or mode-change recycle's idle window,
  // but do not schedule a fresh worker rebuild for ordering alone.
  const orderOnly = request.message.type === "hd_apply_state" && response?.ok === true
    && response.loadPath === "order-only";
  if (mutated && !orderOnly) recycler.noteMutationSettled();
  // A status or memory poll is not activity; only requests that touch the
  // dictionaries keep the idle window open.
  if (!POLL_TYPES.has(request.message.type)) recycler.noteIdle();
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
  const id = activeImportRequestId ?? activeMutationRequestId;
  const request = pending.get(id);
  if (request?.message.type !== "hd_import" || request.message.requestId !== progress?.requestId) {
    return false;
  }
  importPhase = { phase: progress.phase, fallback: progress.fallback ?? null };
  // An isolated import leaves the committed dictionaries loaded and answering.
  // An import inside the live engine unloads them first, so from here until the
  // import commits or rolls back, reads must fail busy rather than answer that
  // no dictionary is installed.
  if (progress.phase === "installing" && progress.fallback === "memory") {
    activeImportRequestId = null;
    activeMutationRequestId = id;
  }
  setupInstaller?.then((installer) => installer.progress(progress));
  return true;
}

// hd_status.updating: the import this bridge is running, with the package it
// replaces (a managed update's fingerprint or a reviewed replacement's target).
function updatingStatus() {
  const request = pending.get(activeImportRequestId) ?? pending.get(activeMutationRequestId);
  if (importPhase === null || request?.message.type !== "hd_import") return null;
  const { managedFingerprint, importDecision } = request.message;
  return { id: managedFingerprint?.id ?? importDecision?.target?.id ?? null, ...importPhase };
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

// "opfs": pthread worker on direct OPFS; "threaded-idbfs": pthread worker on
// IDBFS; "worker-local": single-thread IDBFS runtime in a dedicated worker;
// "local": the same runtime on this document, for hosts without Worker.
async function selectEngine() {
  if (typeof globalThis.Worker !== "function") {
    return "local";
  }
  if (!CAN_THREAD) {
    return "worker-local";
  }
  if (typeof navigator.storage?.getDirectory !== "function") {
    console.warn("hoshidicts: the origin private file system is unavailable, using threaded IDBFS");
    return "threaded-idbfs";
  }
  const result = await probeDirectOpfs();
  if (!result.ok) {
    console.warn(`hoshidicts: direct OPFS is unavailable, using threaded IDBFS: ${result.error}`);
    return "threaded-idbfs";
  }
  return "opfs";
}

// The name tells engine-worker-runtime.js which pthread pool and import
// threading to start with; see docs/memory.md.
function startWorkerEngine(script, lowMemory, dictionaryEntryStorage) {
  workerScript = script;
  worker = new Worker(new URL(script, import.meta.url), {
    type: "module",
    name: engineWorkerName(lowMemory, dictionaryEntryStorage),
  });
  recycler.setRunning(lowMemory, dictionaryEntryStorage);
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

// The stored option, read once so the first worker already starts in the
// right mode; the service worker pushes later changes.
async function readEngineConfig() {
  try {
    const reply = await chrome.runtime.sendMessage({ target: WORKER_TARGET, type: "hd_engine_config" });
    return { lowMemoryMode: reply?.ok === true && reply.lowMemoryMode === true,
      dictionaryEntryStorage: reply?.dictionaryEntryStorage ?? "auto" };
  } catch (error) {
    console.warn(`hoshidicts: could not read the engine configuration: ${describe(error)}`);
    return { lowMemoryMode: false, dictionaryEntryStorage: "auto" };
  }
}

// A pushed change can arrive while either startup read is still pending.
let pushedEngineConfig = null;
// Only the pthread workers have a Low memory mode or entry policy to switch to.
let recyclable = false;
const engineSelection = Promise.all([selectEngine(), readEngineConfig()]).then(([mode, storedConfig]) => {
  const { lowMemoryMode: lowMemory, dictionaryEntryStorage } = pushedEngineConfig ?? storedConfig;
  lastEngineStatus.storageBackend = mode === "opfs" ? "opfs" : "idbfs";
  lastEngineStatus.threaded = mode !== "local" && mode !== "worker-local";
  if (mode === "local") return startLocalEngine();
  if (mode === "worker-local") return startWorkerEngine("./engine-worker-local.js", false);
  recyclable = true;
  recycler.setDesired(lowMemory, dictionaryEntryStorage);
  return startWorkerEngine(mode === "opfs" ? "./engine-worker.js" : "./engine-worker-idbfs.js", lowMemory, dictionaryEntryStorage);
}).catch(failEngine);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== TARGET || message.type !== "hd_engine_config" || message.relayed !== true
      || sender.id !== chrome.runtime.id || sender.url !== expectedBackgroundUrl(chrome)
      || sender.tab !== undefined) return false;
  // The single-thread engines have no Low memory mode or entry policy to
  // switch to: in the document the recycler never learns of a running worker,
  // and the single-thread worker is never desired in another mode. Settings
  // hides the Low memory switch when threaded is false.
  pushedEngineConfig = { lowMemoryMode: message.lowMemoryMode === true,
    dictionaryEntryStorage: message.dictionaryEntryStorage ?? "auto" };
  if (recyclable) recycler.setDesired(pushedEngineConfig.lowMemoryMode, pushedEngineConfig.dictionaryEntryStorage);
  sendResponse({ type: "hd_engine_config_result", requestId: message.requestId ?? null, ok: true });
  return true;
});

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
      updating: updatingStatus(),
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
  if (message.type === "hd_import") {
    activeImportRequestId = id;
    importPhase = { phase: "downloading", fallback: null };
  } else if (MUTATION_TYPES.has(message.type)) activeMutationRequestId = id;
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

// The engine worker and its pthreads: the isolates that share the engine heap.
const ENGINE_SCRIPT = /\/(?:engine-worker[^/]*\.js|vendor\/hoshidicts[^/]*\.mjs)$/u;
const engineThread = (entry) => entry.attribution.length > 0
  && entry.attribution.every((item) => ENGINE_SCRIPT.test(URL.parse(item.url)?.pathname ?? ""));

// Settings → Advanced → Memory's extension total (docs/memory.md): this
// document and every worker it started, as the browser measures them.
// Answered here rather than inside the engine because the measurement waits
// for the browser (seconds, at worst) and must not hold the engine queue.
// Chrome counts a SharedArrayBuffer in every isolate that holds a view of it,
// so the engine heap arrives once per engine thread; it is counted once here.
// Only a cross-origin isolated document has the API; elsewhere bytes is null.
async function measureExtensionMemory(message) {
  const reply = (bytes, heapBytes = null) => ({
    type: "hd_memory_total_result", requestId: message.requestId ?? null, ok: true, bytes, heapBytes,
  });
  if (typeof performance.measureUserAgentSpecificMemory !== "function") return reply(null);
  // hd_memory first: it also brings the engine worker's view up to the grown heap.
  const memory = await new Promise((resolve) => dispatchEngine({ type: "hd_memory", requestId: null }, resolve));
  if (memory?.ok !== true || !Number.isFinite(memory.heapBytes)) return reply(null);
  const heap = memory.heapBytes;
  const { breakdown } = await performance.measureUserAgentSpecificMemory();
  // The local engine's heap is an ordinary buffer of this document, measured once.
  let bytes = worker === null ? 0 : heap;
  for (const entry of breakdown) {
    bytes += worker !== null && engineThread(entry) ? Math.max(0, entry.bytes - heap) : entry.bytes;
  }
  return reply(bytes, heap);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== TARGET || message.relayed !== true || message.type === "hd_engine_config") {
    return false;
  }
  if (message.type === "hd_memory_total") {
    measureExtensionMemory(message).then(sendResponse, (error) => sendResponse(failedResponse(message, describe(error))));
    return true;
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

// Dictionary uploads from another Hachidori (linked-import.js): the service
// worker validates each chunk and its owner; this document holds the bytes
// until commit hands them to the engine as an ordinary local import.
const uploads = new Map();
let uploadIdentity = null;

function uploadedArchive(token) {
  const parts = uploads.get(token);
  if (parts === undefined) throw new Error("The dictionary upload is no longer held on the host. Import it again.");
  return new Blob(parts);
}

async function answerUpload(message) {
  switch (message.type) {
    case "hd_upload_append": {
      const bytes = decodeBase64(message.data);
      if (bytes.byteLength !== message.byteLength) throw new Error("the dictionary upload chunk did not decode to its length");
      if (!uploads.has(message.token)) uploads.set(message.token, []);
      uploads.get(message.token).push(new Blob([bytes]));
      return {};
    }
    case "hd_upload_discard":
      uploads.delete(message.token);
      return {};
    // A restarted service worker no longer knows the uploads held here.
    case "hd_upload_reset":
      uploads.clear();
      return {};
    case "hd_upload_identity":
      uploadIdentity ??= import("./dictionary-import-archive.js");
      return { identity: await (await uploadIdentity).readDictionaryArchiveIdentity(uploadedArchive(message.token)) };
    case "hd_upload_import": {
      const blobUrl = URL.createObjectURL(uploadedArchive(message.token));
      try {
        return await new Promise((resolve) => dispatchEngine({
          target: TARGET, type: "hd_import", requestId: message.requestId ?? null,
          blobUrl, fileName: message.fileName, importDecision: message.importDecision,
        }, resolve));
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
    default:
      throw new Error(`unknown upload request type ${JSON.stringify(message.type)}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== UPLOAD_STORE_TARGET || message.relayed !== true) return false;
  answerUpload(message).then(
    (result) => sendResponse(message.type === "hd_upload_import" ? result
      : { type: `${message.type}_result`, requestId: message.requestId ?? null, ok: true, error: null, ...result }),
    (error) => sendResponse(failedResponse(message, describe(error))),
  );
  return true;
});
