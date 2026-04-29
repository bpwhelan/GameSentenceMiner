import { describe, expect, it, vi } from 'vitest';

import { InstallSessionManager } from './install_session.js';

describe('InstallSessionManager', () => {
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
