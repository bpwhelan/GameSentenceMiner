/*
 * Dedicated owner of a pthread Hoshidicts WASM runtime.
 *
 * The runtime lives off the browser main thread so Hoshidicts can join pthreads
 * and WasmFS can synchronously proxy OPFS operations without deadlocking an
 * extension page. engine-worker.js starts it on WasmFS + direct OPFS and
 * engine-worker-idbfs.js on the classic FS + IDBFS; both call startEngineWorker.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LOW_MEMORY_WORKER_NAME } from "./engine-recycler.js";
import {
  configureEngineService,
  handleEngineMessage,
  startEngine,
} from "./engine-service.js";
import { boundResponseFailure } from "./response-limits.js";

let nextHostRequestId = 0;
let nextProgressId = 0;
const HOST_REQUEST_TIMEOUT_MS = 30_000;
const pendingHostRequests = new Map();
const pendingProgressAcks = new Map();

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function requestHost(message) {
  nextHostRequestId += 1;
  const id = nextHostRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingHostRequests.delete(id)) return;
      reject(new Error("the extension host did not answer the engine worker"));
    }, HOST_REQUEST_TIMEOUT_MS);
    pendingHostRequests.set(id, { resolve, reject, timer });
    globalThis.postMessage({ channel: "host-request", id, message });
  });
}

function reportEngineProgress(progress) {
  if (progress?.phase !== "installing") {
    globalThis.postMessage({ channel: "engine-progress", progress });
    return undefined;
  }
  nextProgressId += 1;
  const id = nextProgressId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingProgressAcks.delete(id)) return;
      reject(new Error("the extension host did not acknowledge the import lock"));
    }, HOST_REQUEST_TIMEOUT_MS);
    pendingProgressAcks.set(id, { resolve, reject, timer });
    globalThis.postMessage({ channel: "engine-progress", id, progress });
  });
}

// One importer thread (max_import_threads(true) == 1) plus the WasmFS OPFS
// proxy thread.
export const LOW_MEMORY_PTHREAD_POOL_SIZE = 2;

// Runs one import in import-worker.js: a second engine instance on the same
// OPFS root writes the new generation while this worker's engine keeps
// answering lookups. The worker is terminated once it has reported, which also
// returns the import's memory high-water mark to the browser.
function importInIsolatedWorker(request) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./import-worker.js", import.meta.url), {
      type: "module",
      name: "hoshidicts-import",
    });
    const settle = (finish) => (value) => {
      worker.terminate();
      finish(value);
    };
    worker.addEventListener("error", (event) => settle(reject)(
      new Error(describe(event.error || event.message) || "the import worker failed"),
    ));
    worker.addEventListener("messageerror", () => settle(reject)(
      new Error("the import worker sent an unreadable message"),
    ));
    worker.addEventListener("message", (event) => {
      if (event.data?.channel !== "import-result") return;
      if (event.data.error === undefined) settle(resolve)(event.data.report);
      else settle(reject)(new Error(event.data.error));
    });
    worker.postMessage({ channel: "import", ...request }, [
      request.archive.buffer,
      ...request.resources.map((resource) => resource.bytes.buffer),
    ]);
  });
}

export function startEngineWorker({ createHoshidicts, storageBackend }) {
  // offscreen.js picks the name; see engine-recycler.js.
  const lowMemory = globalThis.name === LOW_MEMORY_WORKER_NAME;
  // Read by the -sPTHREAD_POOL_SIZE expression in wasm/CMakeLists.txt.
  if (lowMemory) globalThis.HACHIDORI_PTHREAD_POOL_SIZE = LOW_MEMORY_PTHREAD_POOL_SIZE;
  configureEngineService(requestHost, {
    createHoshidicts,
    storageBackend,
    threaded: true,
    lowRam: lowMemory,
    reportProgress: reportEngineProgress,
    // Two IDBFS instances cannot share one store, so only direct OPFS can
    // import outside the engine.
    isolatedImport: storageBackend === "opfs" ? importInIsolatedWorker : null,
  });
  startEngine();
  // A dedicated worker receives only from its creator over its implicit
  // MessagePort. MessageEvent.origin is always empty, so there is no origin
  // value to validate; the channel checks in onHostMessage validate the
  // expected protocol.
  globalThis.onmessage = onHostMessage; // NOSONAR
}

function onHostMessage(event) {
  const data = event.data;
  if (data?.channel === "host-response") {
    const pending = pendingHostRequests.get(data.id);
    if (pending === undefined) return;
    pendingHostRequests.delete(data.id);
    clearTimeout(pending.timer);
    if (data.ok === true) pending.resolve(data.response);
    else pending.reject(new Error(data.error || "host request failed"));
    return;
  }
  if (data?.channel === "engine-progress-ack") {
    const pending = pendingProgressAcks.get(data.id);
    if (pending === undefined) return;
    pendingProgressAcks.delete(data.id);
    clearTimeout(pending.timer);
    if (data.ok === true) pending.resolve();
    else pending.reject(new Error(data.error || "the extension host refused the import lock"));
    return;
  }
  if (data?.channel !== "engine-request") return;

  Promise.resolve(handleEngineMessage(data.message)).then(
    (response) => globalThis.postMessage({ channel: "engine-response", id: data.id, response }),
    (error) => globalThis.postMessage({
      channel: "engine-response",
      id: data.id,
      response: boundResponseFailure({
        type: `${data.message?.type || "hd_unknown"}_result`,
        requestId: data.message?.requestId ?? null,
        ok: false,
        error: describe(error),
      }),
    }),
  );
}
