import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

import { GSMStdoutManager } from './pythonIPC.js';

function createProcess() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const write = vi.fn();
    const stdin = {
        writable: true,
        write,
    };

    return {
        process: { stdout, stderr, stdin },
        write,
    };
}

describe('GSMStdoutManager', () => {
    it('sends a reload settings command to the Python backend', () => {
        const { process, write } = createProcess();
        const manager = new GSMStdoutManager(process as never);

        manager.sendReloadSettings();

        expect(write).toHaveBeenCalledWith(
            'GSMCMD:{"function":"reload_settings"}\n'
        );
    });
});
