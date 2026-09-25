import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const terminations = new WeakMap<ChildProcess, Promise<void>>();

export function hasProcessExited(proc: ChildProcess): boolean {
    return proc.exitCode !== null || proc.signalCode !== null;
}

export function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (hasProcessExited(proc)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const finish = (exited: boolean) => {
            clearTimeout(timer);
            proc.off('exit', onExit);
            proc.off('close', onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(hasProcessExited(proc)), timeoutMs);
        proc.once('exit', onExit);
        proc.once('close', onExit);
    });
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
        process.kill(-pid, signal);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            return false;
        }
        throw error;
    }
}

/**
 * Stop an owned process tree. POSIX callers MUST spawn with detached: true so
 * the child leads its own process group; never use this for arbitrary PIDs.
 * Keep the child referenced and its stdio attached as usual.
 *
 * A parent's exit does not prove its workers exited. Check the group even after
 * the parent exits, and share completion across stop requests and exit handlers.
 */
export function terminateProcessTree(proc: ChildProcess): Promise<void> {
    let termination = terminations.get(proc);
    if (!termination) {
        termination = terminateTree(proc).catch((error) => {
            terminations.delete(proc);
            throw error;
        });
        terminations.set(proc, termination);
    }
    return termination;
}

async function terminateTree(proc: ChildProcess): Promise<void> {
    const pid = proc.pid;
    if (!pid) {
        return; // Spawn failed before a process was created.
    }
    if (process.platform === 'win32') {
        if (hasProcessExited(proc)) {
            return;
        }
        try {
            // Killing the launcher first loses the Windows Python worker tree.
            await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                timeout: 5000,
            });
        } catch (error) {
            if (!hasProcessExited(proc)) {
                throw error;
            }
        }
    } else if (signalGroup(pid, 'SIGTERM')) {
        const deadline = Date.now() + 1500;
        while (signalGroup(pid, 0)) {
            if (Date.now() >= deadline) {
                signalGroup(pid, 'SIGKILL');
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    if (!(await waitForProcessExit(proc, 5000))) {
        throw new Error(`Managed process ${pid} did not exit after termination.`);
    }
}
