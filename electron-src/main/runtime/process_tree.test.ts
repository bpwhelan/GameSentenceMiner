import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

import { terminateProcessTree, waitForProcessExit } from './process_tree.js';

function child() {
    return Object.assign(new EventEmitter(), {
        pid: 12564,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        killed: false,
        kill: vi.fn(),
    }) as unknown as ChildProcess;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('owned process tree termination', () => {
    it('escalates the entire POSIX group even when its parent exits on SIGTERM', async () => {
        vi.useFakeTimers();
        const proc = child();
        const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
            if (signal === 'SIGTERM') {
                proc.signalCode = signal;
                proc.emit('exit', null, signal);
            }
            return true; // A worker remains alive after the parent exits.
        });
        vi.stubGlobal('process', { platform: 'linux', kill });
        const stopped = vi.fn();
        const stopping = terminateProcessTree(proc);
        expect(terminateProcessTree(proc)).toBe(stopping);
        void stopping.then(stopped);
        await vi.advanceTimersByTimeAsync(1499);
        expect(stopped).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await stopping;
        expect(kill).toHaveBeenCalledWith(-12564, 'SIGTERM');
        expect(kill).toHaveBeenCalledWith(-12564, 'SIGKILL');
        expect(proc.kill).not.toHaveBeenCalled();
    });

    it('cleans surviving workers when the parent already exited gracefully', async () => {
        vi.useFakeTimers();
        const proc = child();
        proc.exitCode = 0;
        const kill = vi.fn(() => true);
        vi.stubGlobal('process', { platform: 'linux', kill });
        const stopping = terminateProcessTree(proc);
        await vi.advanceTimersByTimeAsync(1500);
        await stopping;
        expect(kill).toHaveBeenCalledWith(-12564, 'SIGKILL');
    });

    it('accepts an already reaped group but reports signal permission failures', async () => {
        const proc = child();
        proc.exitCode = 0;
        const kill = vi.fn(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
        vi.stubGlobal('process', { platform: 'linux', kill });
        await terminateProcessTree(proc);

        kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
        await expect(terminateProcessTree(child())).rejects.toThrow('denied');
    });

    it('kills the Windows tree before its launcher and waits for exit', async () => {
        const proc = child();
        vi.stubGlobal('process', { platform: 'win32' });
        execFile.mockImplementation((_command, _args, _options, callback) => {
            proc.exitCode = 0;
            proc.emit('exit', 0);
            callback(null, '', '');
        });
        await terminateProcessTree(proc);
        expect(execFile).toHaveBeenCalledWith('taskkill', ['/PID', '12564', '/T', '/F'],
            { windowsHide: true, timeout: 5000 }, expect.any(Function));
        expect(proc.kill).not.toHaveBeenCalled();
    });

    it('does not treat a sent signal as proof of exit, and removes exit listeners on timeout', async () => {
        vi.useFakeTimers();
        const proc = child();
        proc.killed = true;
        const exited = waitForProcessExit(proc, 100);
        await vi.advanceTimersByTimeAsync(100);
        expect(await exited).toBe(false);
        expect(proc.listenerCount('exit')).toBe(0);
        expect(proc.listenerCount('close')).toBe(0);
    });
});
