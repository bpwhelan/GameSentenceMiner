/*
 * Engine worker for the primary runtime: pthread Hoshidicts on WasmFS + direct
 * OPFS. See engine-worker-runtime.js.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import createHoshidicts from "./vendor/hoshidicts-threaded.mjs";
import { startEngineWorker } from "./engine-worker-runtime.js";

startEngineWorker({ createHoshidicts, storageBackend: "opfs" });
