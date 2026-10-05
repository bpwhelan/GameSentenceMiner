/*
 * Engine worker for hosts with workers but no shared WebAssembly memory
 * (no cross-origin isolation): the single-thread Hoshidicts build on the
 * classic FS with IDBFS persistence. Running it here rather than in the
 * offscreen document keeps synchronous Blob reads (FileReaderSync, which only
 * workers have) and long native calls off the document. See
 * engine-worker-runtime.js.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import createHoshidicts from "./vendor/hoshidicts.mjs";
import { startEngineWorker } from "./engine-worker-runtime.js";

startEngineWorker({ createHoshidicts, storageBackend: "idbfs", threaded: false });
