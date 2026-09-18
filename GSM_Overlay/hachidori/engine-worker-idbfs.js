/*
 * Engine worker for hosts with shared memory and workers but no OPFS access
 * handles (Electron refuses them to chrome-extension:// origins): pthread
 * Hoshidicts on the classic FS with IDBFS persistence, so imports still use the
 * bounded worker group instead of one thread. See engine-worker-runtime.js.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import createHoshidicts from "./vendor/hoshidicts-threaded-idbfs.mjs";
import { startEngineWorker } from "./engine-worker-runtime.js";

startEngineWorker({ createHoshidicts, storageBackend: "idbfs" });
