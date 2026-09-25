/*
 * Isolated dictionary importer: a second pthread Hoshidicts instance on the
 * same direct-OPFS root, started by engine-worker-runtime.js for one hd_import.
 *
 * hdw_import is one synchronous native call, so wherever it runs, that
 * instance answers nothing until it returns. Running it here leaves the engine
 * worker free to serve lookups from the committed generations; the engine only
 * swaps the finished generation in afterwards. Nothing in this worker reads or
 * writes an existing dictionary: the importer stages under the fresh
 * generation root it is given, and WasmFS releases each file it maps.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import createHoshidicts from "./vendor/hoshidicts-threaded.mjs";
import { importDictionaryArchive } from "./engine-service.js";
import { LOW_MEMORY_PTHREAD_POOL_SIZE } from "./engine-worker-runtime.js";

globalThis.onmessage = async (event) => { // NOSONAR: only the engine worker holds this worker's port
  const request = event.data;
  if (request?.channel !== "import") return;
  try {
    // Read by the -sPTHREAD_POOL_SIZE expression in wasm/CMakeLists.txt before
    // the module starts: Low memory mode imports on one thread here too.
    if (request.lowRam) globalThis.HACHIDORI_PTHREAD_POOL_SIZE = LOW_MEMORY_PTHREAD_POOL_SIZE;
    const module = await createHoshidicts();
    if (module.ccall("hdw_init_storage", "number", ["number"], [1]) !== 1) {
      throw new Error(module.ccall("hdw_last_error", "string", [], []) || "hdw_init_storage failed");
    }
    const report = await importDictionaryArchive(
      module,
      request.archive,
      request.generationRoot,
      request.lowRam,
      request.fileName,
      request.expectedArchiveBytes,
      request.resources,
    );
    globalThis.postMessage({ channel: "import-result", report });
  } catch (error) {
    globalThis.postMessage({
      channel: "import-result",
      error: (error instanceof Error ? error.message : String(error)) || "the import worker failed",
    });
  }
};
