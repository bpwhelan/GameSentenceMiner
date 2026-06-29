import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProcessManager, ProcessState } from './process_manager.js';
import type { BrokerStartInfo } from './message_bus.js';

/** Stand-in for the broker that lets the test drive connect/disconnect events. */
class FakeBus extends EventEmitter {
    private connected = new Set<string>();
    readonly published: Array<{ dst: string; topic: string }> = [];

    isClientConnected(id: string): boolean {
        return this.connected.has(id);
    }

    publish(dst: string, topic: string): void {
        this.published.push({ dst, topic });
    }

    connect(id: string): void {
        this.connected.add(id);
        this.emit('client-connected', id);
    }

    disconnect(id: string): void {
        this.connected.delete(id);
        this.emit('client-disconnected', id);
    }
}

const connectInfo: BrokerStartInfo = { port: 12345, token: 'tok' };

let bus: FakeBus;
let pm: ProcessManager;
let stateFile: string;

beforeEach(() => {
    bus = new FakeBus();
    stateFile = path.join(os.tmpdir(), `gsm-pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    pm = new ProcessManager({
        bus,
        getConnectInfo: () => connectInfo,
        baseEnv: () => ({ PATH: process.env.PATH }),
        stateFile,
    });
});

afterEach(async () => {
    await pm.stopAll();
    pm.dispose();
    try {
        fs.unlinkSync(stateFile);
    } catch {
        // ignore
    }
});

function waitForState(id: string, target: ProcessState, timeoutMs = 5000): Promise<void> {
    if (pm.getState(id) === target) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pm.off('state-changed', onChange);
            reject(new Error(`Timed out waiting for "${id}" to reach "${target}" (was "${pm.getState(id)}")`));
        }, timeoutMs);
        const onChange = (changedId: string, state: ProcessState) => {
            if (changedId === id && state === target) {
                clearTimeout(timer);
                pm.off('state-changed', onChange);
                resolve();
            }
        };
        pm.on('state-changed', onChange);
    });
}

// A long-lived child that exits cleanly on SIGTERM.
const ALIVE_SCRIPT = 'setInterval(() => {}, 1000);';
// A child that exits immediately with a non-zero code.
const CRASH_SCRIPT = 'process.exit(3);';

describe('ProcessManager', () => {
    it('spawns and reports ready once the bus reports the client connected', async () => {
        pm.register({
            id: 'alive',
            buildCommand: () => ({ command: process.execPath, args: ['-e', ALIVE_SCRIPT] }),
        });

        pm.start('alive');
        await waitForState('alive', 'starting');
        expect(pm.isRunning('alive')).toBe(true);

        bus.connect('alive');
        await waitForState('alive', 'ready');
        expect(pm.getStatus().alive.state).toBe('ready');
        expect(typeof pm.getStatus().alive.pid).toBe('number');
    });

    it('persists the spawned pid to the state file', async () => {
        pm.register({
            id: 'alive',
            buildCommand: () => ({ command: process.execPath, args: ['-e', ALIVE_SCRIPT] }),
            matchTokens: ['gsm-marker'],
        });
        pm.start('alive');
        await waitForState('alive', 'starting');

        const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Array<{ pid: number }>;
        expect(persisted.length).toBe(1);
        expect(persisted[0].pid).toBe(pm.getPid('alive'));
    });

    it('gracefully stops by sending a bus command then exits', async () => {
        pm.register({
            id: 'alive',
            buildCommand: () => ({ command: process.execPath, args: ['-e', ALIVE_SCRIPT] }),
            gracefulStop: { topic: 'alive.stop', timeoutMs: 150 },
        });
        pm.start('alive');
        await waitForState('alive', 'starting');
        bus.connect('alive');
        await waitForState('alive', 'ready');

        await pm.stop('alive');
        expect(pm.getState('alive')).toBe('stopped');
        expect(bus.published.some((p) => p.dst === 'alive' && p.topic === 'alive.stop')).toBe(true);
        expect(pm.isRunning('alive')).toBe(false);
    });

    it('marks a process crashed and auto-restarts with backoff', async () => {
        let spawnCount = 0;
        pm.register({
            id: 'crasher',
            buildCommand: () => {
                spawnCount += 1;
                return { command: process.execPath, args: ['-e', CRASH_SCRIPT] };
            },
            autoRestart: { enabled: true, initialDelayMs: 50, maxRetries: 1 },
        });

        const crashed = new Promise<void>((resolve) => pm.once('crashed', () => resolve()));
        pm.start('crasher');
        await crashed;
        expect(pm.getState('crasher')).toBe('crashed');

        // Wait for the single retry to fire (initialDelayMs) and spawn again.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(spawnCount).toBe(2);
    });

    it('does not start a process when launches are blocked', () => {
        const blockedPm = new ProcessManager({
            bus,
            getConnectInfo: () => connectInfo,
            launchBlocked: () => true,
            stateFile,
        });
        blockedPm.register({
            id: 'blocked',
            buildCommand: () => ({ command: process.execPath, args: ['-e', ALIVE_SCRIPT] }),
        });
        blockedPm.start('blocked');
        expect(blockedPm.isRunning('blocked')).toBe(false);
        expect(blockedPm.getState('blocked')).toBe('stopped');
        blockedPm.dispose();
    });
});
