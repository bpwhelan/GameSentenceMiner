import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WineLaunchContext } from './linux_wine.js';

const state = vi.hoisted(() => ({
    readyAt: 0,
    spawn: vi.fn(),
    addRemoteDevice: vi.fn(),
    removeRemoteDevice: vi.fn(),
}));

vi.mock('frida', () => ({
    default: {
        getDeviceManager: () => ({
            addRemoteDevice: state.addRemoteDevice,
            removeRemoteDevice: state.removeRemoteDevice,
        }),
    },
}));
vi.mock('../data_dir.js', () => ({ getSharedBaseDir: () => 'unused-test-data' }));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
vi.mock('node:net', async () => {
    const { EventEmitter } = await import('node:events');
    return {
        createServer: () => Object.assign(new EventEmitter(), {
            listen: (_port: number, _host: string, ready: () => void) => ready(),
            address: () => ({ port: 37777 }),
            close: (closed: () => void) => closed(),
        }),
        createConnection: () => {
            const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
            queueMicrotask(() => {
                if (Date.now() >= state.readyAt) socket.emit('connect');
                else socket.emit('error', new Error('ECONNREFUSED 127.0.0.1:37777'));
            });
            return socket;
        },
    };
});

import { startWineFridaConnection } from './wine_frida.js';

let testRoot: string;
let serverPath: string;
let serverProcess: ReturnType<typeof makeServerProcess>;

function makeServerProcess() {
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        exitCode: null as number | null,
        kill: vi.fn(() => { child.killed = true; return true; }),
    });
    return child;
}

function launchContext(launcherKind: WineLaunchContext['launcherKind']): WineLaunchContext {
    return {
        linuxPid: 33896,
        winePrefix: '/home/deck/Games/umu/umu-default/pfx',
        launcherPath: launcherKind === 'umu' ? '/opt/lutris/umu-run' : '/opt/wine/bin/wine',
        launcherKind,
        env: { WINEPREFIX: '/home/deck/Games/umu/umu-default/pfx', PROTON_VERB: 'waitforexitandrun' },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-frida-startup-'));
    serverPath = path.join(testRoot, 'frida-server.exe');
    fs.writeFileSync(serverPath, 'test server');
    vi.stubEnv('GSM_FRIDA_SERVER_X64_PATH', serverPath);
    serverProcess = makeServerProcess();
    state.spawn.mockReturnValue(serverProcess);
    state.readyAt = Date.now();
    state.addRemoteDevice.mockResolvedValue({
        enumerateProcesses: async () => [{ pid: 42, name: 'game.exe' }],
    });
    state.removeRemoteDevice.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('Wine Frida startup', () => {
    it('allows UMU runtime preparation to outlast the plain Wine startup timeout', async () => {
        state.readyAt = Date.now() + 20_000;
        const launch = launchContext('umu');
        const onLog = vi.fn();
        const pending = startWineFridaConnection(launch, 'game.exe', 'x64', onLog);
        const result = pending.then((connection) => ({ connection }), (error) => ({ error }));

        await vi.advanceTimersByTimeAsync(20_000);
        const outcome = await result;

        expect(outcome).toMatchObject({ connection: { windowsPid: 42 } });
        expect(state.spawn).toHaveBeenCalledWith(launch.launcherPath, [serverPath, '--listen', '127.0.0.1:37777'],
            expect.objectContaining({ env: { ...launch.env, PROTON_VERB: 'run' } }));
        expect(launch.env.PROTON_VERB).toBe('waitforexitandrun');
        expect(onLog).toHaveBeenCalledWith(expect.stringContaining('runtime'));
        expect(serverProcess.kill).not.toHaveBeenCalled();
        if ('connection' in outcome) {
            await outcome.connection.close();
            await outcome.connection.close();
        }
        expect(serverProcess.kill).toHaveBeenCalledTimes(1);
        expect(state.removeRemoteDevice).toHaveBeenCalledTimes(1);
    });

    it('keeps ordinary Wine failures on the shorter timeout', async () => {
        state.readyAt = Infinity;
        const result = startWineFridaConnection(launchContext('wine'), 'game.exe', 'x64').catch((error) => error);

        await vi.advanceTimersByTimeAsync(12_000);

        expect(await result).toBeInstanceOf(Error);
        expect((await result).message).toContain('Frida server did not open 37777');
        expect(serverProcess.kill).toHaveBeenCalledTimes(1);
        expect(state.addRemoteDevice).not.toHaveBeenCalled();
    });

    it('bounds UMU startup and gives runtime troubleshooting guidance on timeout', async () => {
        state.readyAt = Infinity;
        const result = startWineFridaConnection(launchContext('umu'), 'game.exe', 'x64').catch((error) => error);

        await vi.advanceTimersByTimeAsync(120_000);

        expect((await result).message).toContain('Lutris/UMU');
        expect((await result).message).toContain('runtime');
        expect(serverProcess.kill).toHaveBeenCalledTimes(1);
        expect(state.addRemoteDevice).not.toHaveBeenCalled();
    });

    it('reports a launcher failure promptly instead of waiting through the UMU startup allowance', async () => {
        state.readyAt = Infinity;
        const result = startWineFridaConnection(launchContext('umu'), 'game.exe', 'x64').catch((error) => error);
        await vi.advanceTimersByTimeAsync(1);
        serverProcess.exitCode = 1;
        serverProcess.emit('exit', 1, null);

        await vi.advanceTimersByTimeAsync(250);

        expect((await result).message).toContain('code=1');
        expect(state.addRemoteDevice).not.toHaveBeenCalled();
    });
});
