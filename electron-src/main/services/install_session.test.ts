import { describe, expect, it, vi } from 'vitest';
import log from 'electron-log/main.js';

vi.mock('electron-log/main.js', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { InstallSessionManager } from './install_session.js';

describe('InstallSessionManager', () => {
    it.each(['completed', 'failed'] as const)('restores a %s result to a renderer that missed the finish event', (status) => {
        const manager = new InstallSessionManager();
        expect(manager.getRendererSnapshot()).toBeNull();
        const original = manager.startSession('backend_update');
        manager.finishActive(status);

        expect(manager.getActiveSnapshot()).toBeNull();
        expect(manager.getRendererSnapshot()).toMatchObject({ id: original.id, origin: 'backend_update', status });
        const snapshot = manager.getRendererSnapshot()!;
        snapshot.currentMessage = 'Renderer mutation';
        expect(manager.getRendererSnapshot()?.currentMessage).not.toBe('Renderer mutation');

        const next = manager.startSession('repair');
        expect(manager.getRendererSnapshot()).toMatchObject({ id: next.id, origin: 'repair', status: 'running' });
        manager.finishActive('completed');
    });

    it('persists stages, failures, retries, and completion without a renderer listener', () => {
        const manager = new InstallSessionManager();
        const session = manager.startSession('backend_update');
        manager.updateStage({ stageId: 'lock_sync', status: 'running', message: 'Resolving dependencies', progress: 0.1 });
        const loggedCalls = vi.mocked(log.info).mock.calls.length;
        manager.updateStage({ stageId: 'lock_sync', status: 'running', message: 'Resolving dependencies', progress: 0.11 });
        expect(log.info).toHaveBeenCalledTimes(loggedCalls);
        manager.appendLog({ message: 'Package download diagnostics', source: 'setup', stream: 'stderr' });
        manager.updateStage({ stageId: 'lock_sync', status: 'failed', error: 'Network timeout' });
        manager.finishActive('failed', 'Dependency installation failed');
        manager.startSession('backend_update');
        manager.finishActive('completed', 'Backend ready');

        const output = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.error).mock.calls]
            .map((args) => JSON.stringify(args)).join('\n');
        expect(output).toContain(session.id);
        expect(output).toContain('backend_update');
        expect(output).toContain('lock_sync');
        expect(output).toContain('Package download diagnostics');
        expect(output).toContain('Network timeout');
        expect(output).toMatch(/retry/i);
        expect(output).toContain('Backend ready');
        expect(log.error).toHaveBeenCalled();
    });

    it('computes weighted overall progress from stage updates', () => {
        const manager = new InstallSessionManager();

        manager.startSession('startup');
        const afterPrepare = manager.updateStage({
            stageId: 'prepare',
            status: 'completed',
            message: 'Preparation complete.',
        });
        const afterPython = manager.updateStage({
            stageId: 'python',
            status: 'running',
            progressKind: 'estimated',
            progress: 0.5,
            message: 'Installing Python runtime...',
        });

        expect(afterPrepare?.overallProgress).toBeCloseTo(0.02, 5);
        expect(afterPython?.currentStageId).toBe('python');
        expect(afterPython?.currentMessage).toBe('Installing Python runtime...');
        expect(afterPython?.overallProgress).toBeCloseTo(0.095, 5);
    });

    it('reuses failed sessions for the same origin and preserves completed stages', () => {
        const manager = new InstallSessionManager();
        const firstSession = manager.startSession('repair');

        manager.updateStage({
            stageId: 'prepare',
            status: 'completed',
            message: 'Prepared.',
        });
        manager.updateStage({
            stageId: 'uv',
            status: 'skipped',
            message: 'uv already installed.',
        });
        manager.updateStage({
            stageId: 'python',
            status: 'failed',
            message: 'Python install failed.',
            error: 'boom',
        });
        manager.finishActive('failed', 'Python install failed.', 'boom');

        const retriedSession = manager.startSession('repair');
        const prepareStage = retriedSession.stages.find((stage) => stage.id === 'prepare');
        const uvStage = retriedSession.stages.find((stage) => stage.id === 'uv');
        const pythonStage = retriedSession.stages.find((stage) => stage.id === 'python');

        expect(retriedSession.id).toBe(firstSession.id);
        expect(retriedSession.status).toBe('running');
        expect(retriedSession.error).toBeNull();
        expect(prepareStage?.status).toBe('completed');
        expect(uvStage?.status).toBe('skipped');
        expect(pythonStage?.status).toBe('pending');
        expect(pythonStage?.error).toBeNull();
    });

    it('emits snapshots and can retry the last failed session through its handler', async () => {
        const manager = new InstallSessionManager();
        const listener = vi.fn();
        const retryHandler = vi.fn().mockResolvedValue(undefined);
        manager.setSnapshotListener(listener);

        manager.startSession('reset_dependencies', retryHandler);
        manager.updateStage({
            stageId: 'lock_sync',
            status: 'failed',
            message: 'Dependency sync failed.',
            error: 'network timeout',
        });
        manager.finishActive('failed', 'Dependency sync failed.', 'network timeout');

        await expect(manager.retryLastFailedSession()).resolves.toBe(true);
        expect(retryHandler).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(
            'install-session.finished',
            expect.objectContaining({
                status: 'failed',
                error: 'network timeout',
            })
        );
    });
});
