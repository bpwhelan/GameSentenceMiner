import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startAgentControl } from './agent_control.js';
import { MessageBroker } from '../runtime/message_bus.js';
import { requestAgent } from '../../../scripts/restart-gsm.mjs';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-agent-control-'));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const broker = new MessageBroker();
    const connection = await broker.start();
    cleanups.push(() => broker.stop());
    const deps = {
        broker,
        connection,
        userDataPath: directory,
        appPath: process.cwd(),
        isPackaged: false,
        restartId: null as string | null,
        isReady: vi.fn(() => false),
        getBlockedReason: vi.fn(() => null as string | null),
        notify: vi.fn(async (_reason: string, _seconds: number) => {}),
        restart: vi.fn(async (_id: string) => {}),
    };
    const control = startAgentControl(deps);
    cleanups.push(() => control.dispose());
    const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'agent-control.json'), 'utf8'));
    return { control, deps, descriptor, directory };
}

describe('agent restart control', () => {
    it('exposes live readiness through the authenticated local bus', async () => {
        const { deps, descriptor } = await setup();
        expect(await requestAgent(descriptor, 'app.agent.status')).toMatchObject({
            instanceId: descriptor.instanceId, ready: false, appPath: process.cwd(),
        });
        deps.isReady.mockReturnValue(true);
        expect(await requestAgent(descriptor, 'app.agent.status')).toMatchObject({ ready: true });
        await expect(requestAgent({ ...descriptor, token: 'wrong' }, 'app.agent.status'))
            .rejects.toThrow(/token/i);
        expect(deps.restart).not.toHaveBeenCalled();
    });

    it('acknowledges one request and gives the warning its full countdown before restarting', async () => {
        const { control, deps } = await setup();
        vi.useFakeTimers();
        const first = await control.requestRestart({ reason: 'New OCR changes', delaySeconds: 5 });
        const duplicate = await control.requestRestart({ reason: 'Another agent', delaySeconds: 10 });
        expect(duplicate).toEqual(first);
        expect(deps.notify).toHaveBeenCalledOnce();
        expect(deps.notify).toHaveBeenCalledWith('New OCR changes', 5, expect.any(Function));
        await vi.advanceTimersByTimeAsync(4999);
        expect(deps.restart).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(deps.restart).toHaveBeenCalledExactlyOnceWith(first.requestId);
    });

    it('does not start the countdown until the warning has been displayed', async () => {
        const { control, deps } = await setup();
        vi.useFakeTimers();
        let shown!: () => void;
        deps.notify.mockImplementation(() => new Promise<void>((resolve) => { shown = resolve; }));
        const first = control.requestRestart({ reason: 'Ready to test' });
        const second = control.requestRestart({ reason: 'Duplicate' });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(deps.notify).toHaveBeenCalledOnce();
        expect(deps.restart).not.toHaveBeenCalled();
        shown();
        expect(await second).toEqual(await first);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(deps.restart).toHaveBeenCalledOnce();
    });

    it.each([0, -1, 4, 301, 5.5, '5', NaN])('rejects an invalid warning duration: %s', async (delaySeconds) => {
        const { control, deps } = await setup();
        await expect(control.requestRestart({ delaySeconds })).rejects.toThrow(/5.*300/);
        expect(deps.notify).not.toHaveBeenCalled();
        expect(deps.restart).not.toHaveBeenCalled();
    });

    it('refuses restart during an update and checks again when the countdown finishes', async () => {
        const { control, deps } = await setup();
        deps.getBlockedReason.mockReturnValue('An update is in progress.');
        await expect(control.requestRestart({})).rejects.toThrow(/update/);
        expect(deps.notify).not.toHaveBeenCalled();
        deps.getBlockedReason.mockReturnValue(null);
        vi.useFakeTimers();
        await control.requestRestart({});
        deps.getBlockedReason.mockReturnValue('An update is in progress.');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(deps.restart).not.toHaveBeenCalled();
        expect(control.getStatus()).toMatchObject({ error: 'An update is in progress.' });
    });

    it('does not restart if the warning fails, and allows a later retry', async () => {
        const { control, deps } = await setup();
        deps.notify.mockRejectedValueOnce(new Error('Notifications unavailable'));
        await expect(control.requestRestart({})).rejects.toThrow(/Notifications unavailable/);
        vi.useFakeTimers();
        await control.requestRestart({});
        await vi.advanceTimersByTimeAsync(30_000);
        expect(deps.restart).toHaveBeenCalledOnce();
    });

    it('cancels a pending restart on ordinary shutdown and removes only its own discovery file', async () => {
        const { control, deps, directory, descriptor } = await setup();
        vi.useFakeTimers();
        await control.requestRestart({});
        const filename = path.join(directory, 'agent-control.json');
        fs.writeFileSync(filename, JSON.stringify({ ...descriptor, instanceId: 'replacement' }));
        control.dispose();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(deps.restart).not.toHaveBeenCalled();
        expect(JSON.parse(fs.readFileSync(filename, 'utf8')).instanceId).toBe('replacement');
    });

    it('preserves cleanup errors for the waiting agent after shutdown', async () => {
        const { control, directory } = await setup();
        control.fail(new Error('A worker did not exit'));
        control.dispose();
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'agent-control.json'), 'utf8')))
            .toMatchObject({ error: 'A worker did not exit' });
    });
});
