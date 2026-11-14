/** Shared application client for native managed processes. Configuration and
 * logging remain here; the Rust runtime owns process lifetimes and the bus. */

import { getSanitizedPythonEnv, getWindowsNamedPythonExecutable } from '../util.js';
import { ProcessManager } from './process_manager.js';
import { recordProcessOutput } from '../services/logging.js';

let manager: ProcessManager | null = null;
let launchBlocked: () => boolean = () => false;

/** main.ts injects the update guard so blocked launches are suppressed. */
export function setLaunchBlockedCheck(fn: () => boolean): void {
    launchBlocked = fn;
}

/** Await every existing managed child without creating a manager during shutdown. */
export async function stopManagedProcesses(): Promise<void> {
    await manager?.stopAll();
}

export function getProcessManager(): ProcessManager {
    if (!manager) {
        manager = new ProcessManager({
            baseEnv: () => getSanitizedPythonEnv(),
            launchBlocked: () => launchBlocked(),
            resolveExecutable: (command, label) =>
                label ? getWindowsNamedPythonExecutable(command, label) : command,
        });
        manager.on('log', (id: string, output: { stream: string; message: string }) => {
            recordProcessOutput(id, output.stream, output.message);
        });
        manager.on('state-changed', (id: string, state: string) => {
            recordProcessOutput(id, 'lifecycle', state);
        });
    }
    return manager;
}
