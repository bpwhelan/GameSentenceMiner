import { describe, expect, it, vi } from 'vitest';
import { agentRelaunchArgs } from './agent_control.js';
import { parseOptions, restartRunningApp, waitForRestart } from '../../../scripts/restart-gsm.mjs';

describe('agent restart command', () => {
    it('retains normal launch arguments without accumulating restart markers', () => {
        expect(agentRelaunchArgs(['.', '--ocr', '--scene', 'Game', '--gsm-agent-restarted=old'], 'new'))
            .toEqual(['.', '--ocr', '--scene', 'Game', '--gsm-agent-restarted=new']);
    });

    it('defaults to a 30-second warning and rejects invalid command options', () => {
        expect(parseOptions([])).toMatchObject({ delaySeconds: 30, timeoutSeconds: 120, build: false });
        for (const args of [['--delay', '0'], ['--delay', '5.5'], ['--timeout', '5'], ['--reason', ' '], ['--typo']]) {
            expect(() => parseOptions(args)).toThrow();
        }
    });

    it('never accepts readiness from the previous app or an unrelated new instance', async () => {
        let now = 0;
        const request = vi.fn(async () => ({ ready: true }));
        const dependencies = {
            read: vi.fn()
                .mockReturnValueOnce({ instanceId: 'old', restartId: 'request' })
                .mockReturnValue({ instanceId: 'unrelated', restartId: 'other-request' }),
            request,
            now: () => now,
            sleep: async (ms: number) => { now += ms; },
        };
        await expect(waitForRestart('endpoint', { instanceId: 'old' }, 'request', 1000, dependencies))
            .rejects.toThrow(/did not become ready/);
        expect(request).not.toHaveBeenCalled();
    });

    it('waits through disconnects and startup until the matching replacement is ready', async () => {
        let now = 0;
        const newInstance = { instanceId: 'new', restartId: 'request' };
        const request = vi.fn()
            .mockRejectedValueOnce(new Error('Still starting'))
            .mockResolvedValueOnce({ ...newInstance, ready: false })
            .mockResolvedValue({ ...newInstance, ready: true });
        const result = await waitForRestart('endpoint', { instanceId: 'old' }, 'request', 5000, {
            read: () => newInstance, request, now: () => now,
            sleep: async (ms: number) => { now += ms; },
        });
        expect(result).toMatchObject({ instanceId: 'new', ready: true });
        expect(request).toHaveBeenCalledTimes(3);
    });

    it.each([
        { instanceId: 'old', error: 'Cleanup failed' },
        { instanceId: 'new', restartId: 'request', error: 'Startup failed' },
    ])('reports a recorded cleanup or startup failure immediately (%s)', async (endpoint) => {
        await expect(waitForRestart('endpoint', { instanceId: 'old' }, 'request', 5000, {
            read: () => endpoint,
        })).rejects.toThrow(endpoint.error);
    });

    function workflow() {
        const options = parseOptions(['--build', '--reason', 'Fix ready']);
        const endpoint = { instanceId: 'old' };
        const status = { ...endpoint, appPath: process.cwd(), isPackaged: false };
        const dependencies = {
            read: () => endpoint,
            request: vi.fn().mockResolvedValueOnce(status).mockResolvedValue({ requestId: 'request', restartAt: Date.now(), reason: options.reason }),
            build: vi.fn(async () => {}),
            wait: vi.fn(async () => ({ pid: 123, ready: true })),
            log: vi.fn(),
        };
        return { options, dependencies };
    }

    it('builds successfully before issuing the warning and waits for readiness', async () => {
        const { options, dependencies } = workflow();
        await restartRunningApp('endpoint', options, dependencies);
        expect(dependencies.build.mock.invocationCallOrder[0]).toBeLessThan(dependencies.request.mock.invocationCallOrder[1]);
        expect(dependencies.request).toHaveBeenLastCalledWith({ instanceId: 'old' }, 'app.agent.restart', {
            reason: 'Fix ready', delaySeconds: 30,
        }, 15_000);
        expect(dependencies.wait).toHaveBeenCalledOnce();
    });

    it('does not request a restart when the build fails', async () => {
        const { options, dependencies } = workflow();
        dependencies.build.mockRejectedValue(new Error('Build failed'));
        await expect(restartRunningApp('endpoint', options, dependencies)).rejects.toThrow('Build failed');
        expect(dependencies.request).toHaveBeenCalledTimes(1);
        expect(dependencies.wait).not.toHaveBeenCalled();
    });

    it.each([
        { appPath: process.cwd(), isPackaged: true },
        { appPath: '/another/checkout', isPackaged: false },
        { appPath: process.cwd(), blockedReason: 'An update is running.' },
    ])('does not build or restart the wrong or busy app (%s)', async (status) => {
        const { options, dependencies } = workflow();
        dependencies.request.mockReset().mockResolvedValue({ instanceId: 'old', ...status });
        await expect(restartRunningApp('endpoint', options, dependencies)).rejects.toThrow();
        expect(dependencies.build).not.toHaveBeenCalled();
        expect(dependencies.request).toHaveBeenCalledTimes(1);
    });
});
