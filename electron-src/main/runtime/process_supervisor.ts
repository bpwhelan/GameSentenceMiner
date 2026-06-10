/**
 * App-wide ProcessManager singleton, wired with GSM's real platform helpers.
 *
 * Kept separate from process_manager.ts (which stays dependency-free) so the
 * impure imports (util.ts, which pulls the app graph) live here. Created lazily
 * on first use — callers must have run startBus() during app init first.
 */

import * as path from 'node:path';

import { BASE_DIR, getSanitizedPythonEnv, getWindowsNamedPythonExecutable } from '../util.js';
import { getBroker, getBusConnectInfo } from './bus_client.js';
import { ProcessManager } from './process_manager.js';

let manager: ProcessManager | null = null;
let launchBlocked: () => boolean = () => false;

/** main.ts injects the update guard so blocked launches are suppressed. */
export function setLaunchBlockedCheck(fn: () => boolean): void {
    launchBlocked = fn;
}

export function getProcessManager(): ProcessManager {
    if (!manager) {
        manager = new ProcessManager({
            bus: getBroker(),
            getConnectInfo: () => getBusConnectInfo(),
            baseEnv: () => getSanitizedPythonEnv(),
            launchBlocked: () => launchBlocked(),
            stateFile: path.join(BASE_DIR, 'electron', 'managed_processes.json'),
            resolveExecutable: (command, label) =>
                label ? getWindowsNamedPythonExecutable(command, label) : command,
        });
    }
    return manager;
}
