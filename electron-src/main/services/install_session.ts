import { randomUUID } from 'node:crypto';

import {
    clampInstallProgress,
    INSTALL_STAGE_DEFINITIONS,
    type InstallLogEntry,
    type InstallProgressKind,
    type InstallSessionOrigin,
    type InstallSessionSnapshot,
    type InstallStageId,
    type InstallStageProgressUpdate,
    type InstallStageState,
} from '../../shared/install_session.js';

interface InstallSessionRecord {
    snapshot: InstallSessionSnapshot;
    retryHandler: (() => Promise<void>) | null;
}

type SnapshotListener = (channel: 'install-session.snapshot' | 'install-session.finished', snapshot: InstallSessionSnapshot) => void;

function createInitialStages(): InstallStageState[] {
    return INSTALL_STAGE_DEFINITIONS.map((definition) => ({
        id: definition.id,
        label: definition.label,
        weight: definition.weight,
        status: 'pending',
        progressKind: 'indeterminate',
        progress: null,
        message: '',
        downloadedBytes: null,
        totalBytes: null,
        startedAt: null,
        finishedAt: null,
        error: null,
    }));
}

function cloneSnapshot(snapshot: InstallSessionSnapshot): InstallSessionSnapshot {
    return {
        ...snapshot,
        stages: snapshot.stages.map((stage) => ({ ...stage })),
        logs: snapshot.logs.map((log) => ({ ...log })),
    };
}

function getStageRatio(stage: InstallStageState): number {
    if (stage.status === 'completed' || stage.status === 'skipped') {
        return 1;
    }
    if (typeof stage.progress === 'number') {
        return Math.max(0, Math.min(1, stage.progress));
    }
    return 0;
}

function getCurrentStageId(stages: InstallStageState[]): InstallStageId | null {
    const runningStage = [...stages].reverse().find((stage) => stage.status === 'running');
    if (runningStage) {
        return runningStage.id;
    }
    const failedStage = [...stages].reverse().find((stage) => stage.status === 'failed');
    if (failedStage) {
        return failedStage.id;
    }
    return null;
}

function getCurrentMessage(stages: InstallStageState[], fallbackError: string | null): string {
    const runningStage = stages.find((stage) => stage.status === 'running');
    if (runningStage && runningStage.message) {
        return runningStage.message;
    }
    const failedStage = stages.find((stage) => stage.status === 'failed');
    if (failedStage) {
        return failedStage.error || failedStage.message || fallbackError || 'Installation failed.';
    }
    const completedStage = [...stages]
        .reverse()
        .find((stage) => stage.status === 'completed' || stage.status === 'skipped');
    if (completedStage?.message) {
        return completedStage.message;
    }
    return fallbackError || '';
}

function computeOverallProgress(stages: InstallStageState[]): number {
    const totalWeight = stages.reduce((sum, stage) => sum + stage.weight, 0);
    if (totalWeight <= 0) {
        return 0;
    }
    const completedWeight = stages.reduce((sum, stage) => {
        return sum + stage.weight * getStageRatio(stage);
    }, 0);
    return Math.max(0, Math.min(1, completedWeight / totalWeight));
}

function rebuildSnapshot(snapshot: InstallSessionSnapshot): InstallSessionSnapshot {
    return {
        ...snapshot,
        currentStageId: getCurrentStageId(snapshot.stages),
        currentMessage: getCurrentMessage(snapshot.stages, snapshot.error),
        overallProgress: computeOverallProgress(snapshot.stages),
    };
}

function resetStageForRetry(stage: InstallStageState): InstallStageState {
    if (stage.status === 'completed' || stage.status === 'skipped') {
        return { ...stage, error: null };
    }
    return {
        ...stage,
        status: 'pending',
        progressKind: 'indeterminate',
        progress: null,
        message: '',
        downloadedBytes: null,
        totalBytes: null,
        startedAt: null,
        finishedAt: null,
        error: null,
    };
}

export class InstallSessionManager {
    private activeSession: InstallSessionRecord | null = null;
    private lastFinishedSession: InstallSessionRecord | null = null;
    private listener: SnapshotListener | null = null;
    private logCounter = 0;
    private pendingSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingSnapshot: InstallSessionSnapshot | null = null;
    private lastSnapshotEmitAt = 0;

    public setSnapshotListener(listener: SnapshotListener | null): void {
        this.listener = listener;
    }

    public getActiveSnapshot(): InstallSessionSnapshot | null {
        return this.activeSession ? cloneSnapshot(this.activeSession.snapshot) : null;
    }

    public getLastFinishedSnapshot(): InstallSessionSnapshot | null {
        return this.lastFinishedSession ? cloneSnapshot(this.lastFinishedSession.snapshot) : null;
    }

    public startSession(origin: InstallSessionOrigin, retryHandler?: () => Promise<void>): InstallSessionSnapshot {
        const now = Date.now();
        const shouldReuseFailedSession =
            this.lastFinishedSession?.snapshot.origin === origin &&
            this.lastFinishedSession.snapshot.status === 'failed';

        if (shouldReuseFailedSession && this.lastFinishedSession) {
            const reusedSnapshot: InstallSessionSnapshot = {
                ...cloneSnapshot(this.lastFinishedSession.snapshot),
                status: 'running',
                finishedAt: null,
                error: null,
                stages: this.lastFinishedSession.snapshot.stages.map((stage) => resetStageForRetry(stage)),
                logs: this.lastFinishedSession.snapshot.logs.slice(-200),
            };
            this.activeSession = {
                snapshot: rebuildSnapshot(reusedSnapshot),
                retryHandler: retryHandler ?? this.lastFinishedSession.retryHandler,
            };
            this.lastFinishedSession = null;
            this.scheduleSnapshotEmit();
            return cloneSnapshot(this.activeSession.snapshot);
        }

        const snapshot = rebuildSnapshot({
            id: randomUUID(),
            origin,
            status: 'running',
            startedAt: now,
            finishedAt: null,
            currentStageId: null,
            overallProgress: 0,
            currentMessage: '',
            error: null,
            stages: createInitialStages(),
            logs: [],
        });

        this.activeSession = {
            snapshot,
            retryHandler: retryHandler ?? null,
        };
        this.scheduleSnapshotEmit();
        return cloneSnapshot(snapshot);
    }

    public ensureSession(origin: InstallSessionOrigin, retryHandler?: () => Promise<void>): InstallSessionSnapshot {
        if (this.activeSession?.snapshot.origin === origin) {
            if (retryHandler) {
                this.activeSession.retryHandler = retryHandler;
            }
            return cloneSnapshot(this.activeSession.snapshot);
        }
        return this.startSession(origin, retryHandler);
    }

    public setRetryHandler(retryHandler: (() => Promise<void>) | null): void {
        if (this.activeSession) {
            this.activeSession.retryHandler = retryHandler;
            return;
        }
        if (this.lastFinishedSession?.snapshot.status === 'failed') {
            this.lastFinishedSession.retryHandler = retryHandler;
        }
    }

    public updateStage(update: InstallStageProgressUpdate): InstallSessionSnapshot | null {
        if (!this.activeSession) {
            return null;
        }

        const snapshot = cloneSnapshot(this.activeSession.snapshot);
        const stageIndex = snapshot.stages.findIndex((stage) => stage.id === update.stageId);
        if (stageIndex < 0) {
            return null;
        }

        const currentStage = snapshot.stages[stageIndex];
        const nextStatus = update.status ?? currentStage.status;
        const progressKind: InstallProgressKind = update.progressKind ?? currentStage.progressKind;
        const nextProgress = clampInstallProgress(update.progress ?? currentStage.progress);
        const now = Date.now();

        const nextStage: InstallStageState = {
            ...currentStage,
            status: nextStatus,
            progressKind,
            progress: nextProgress,
            message: update.message ?? currentStage.message,
            downloadedBytes:
                typeof update.downloadedBytes === 'number' || update.downloadedBytes === null
                    ? update.downloadedBytes
                    : currentStage.downloadedBytes,
            totalBytes:
                typeof update.totalBytes === 'number' || update.totalBytes === null
                    ? update.totalBytes
                    : currentStage.totalBytes,
            error: update.error ?? (nextStatus === 'failed' ? currentStage.error : null),
            startedAt: currentStage.startedAt ?? (nextStatus === 'running' ? now : currentStage.startedAt),
            finishedAt:
                nextStatus === 'completed' || nextStatus === 'skipped' || nextStatus === 'failed'
                    ? now
                    : null,
        };

        if ((nextStatus === 'completed' || nextStatus === 'skipped') && nextStage.progress === null) {
            nextStage.progress = 1;
        }

        snapshot.stages[stageIndex] = nextStage;
        snapshot.error = nextStatus === 'failed' ? nextStage.error || nextStage.message || 'Installation failed.' : snapshot.error;
        this.activeSession.snapshot = rebuildSnapshot(snapshot);
        this.scheduleSnapshotEmit();
        return cloneSnapshot(this.activeSession.snapshot);
    }

    public appendLog(entry: Omit<InstallLogEntry, 'id' | 'createdAt'>): void {
        if (!this.activeSession) {
            return;
        }

        const snapshot = cloneSnapshot(this.activeSession.snapshot);
        snapshot.logs.push({
            ...entry,
            id: `install-log-${this.logCounter++}`,
            createdAt: Date.now(),
        });
        snapshot.logs = snapshot.logs.slice(-250);
        this.activeSession.snapshot = snapshot;
        this.scheduleSnapshotEmit();
    }

    public finishActive(status: 'completed' | 'failed', message?: string, error?: string | null): InstallSessionSnapshot | null {
        if (!this.activeSession) {
            return null;
        }

        if (this.pendingSnapshotTimer) {
            clearTimeout(this.pendingSnapshotTimer);
            this.pendingSnapshotTimer = null;
        }
        this.pendingSnapshot = null;

        const snapshot = cloneSnapshot(this.activeSession.snapshot);
        snapshot.status = status;
        snapshot.finishedAt = Date.now();
        snapshot.error = status === 'failed' ? error || snapshot.error || message || 'Installation failed.' : null;
        if (message && snapshot.currentStageId) {
            const stage = snapshot.stages.find((entry) => entry.id === snapshot.currentStageId);
            if (stage && !stage.message) {
                stage.message = message;
            }
        }
        this.activeSession.snapshot = rebuildSnapshot(snapshot);
        const finished = cloneSnapshot(this.activeSession.snapshot);
        this.lastFinishedSession = {
            snapshot: finished,
            retryHandler: this.activeSession.retryHandler,
        };
        this.activeSession = null;
        this.emit('install-session.finished', finished);
        return finished;
    }

    public async retryLastFailedSession(): Promise<boolean> {
        const retryTarget = this.activeSession?.snapshot.status === 'failed'
            ? this.activeSession
            : this.lastFinishedSession?.snapshot.status === 'failed'
              ? this.lastFinishedSession
              : null;

        if (!retryTarget?.retryHandler) {
            return false;
        }

        await retryTarget.retryHandler();
        return true;
    }

    private emit(channel: 'install-session.snapshot' | 'install-session.finished', explicitSnapshot?: InstallSessionSnapshot): void {
        if (!this.listener) {
            return;
        }
        const snapshot = explicitSnapshot
            ? cloneSnapshot(explicitSnapshot)
            : this.activeSession
              ? cloneSnapshot(this.activeSession.snapshot)
              : null;
        if (!snapshot) {
            return;
        }
        this.listener(channel, snapshot);
    }

    private scheduleSnapshotEmit(): void {
        const activeSnapshot = this.activeSession ? cloneSnapshot(this.activeSession.snapshot) : null;
        if (!activeSnapshot) {
            return;
        }

        this.pendingSnapshot = activeSnapshot;
        const now = Date.now();
        const minIntervalMs = 120;
        const delayMs = Math.max(0, minIntervalMs - (now - this.lastSnapshotEmitAt));

        if (this.pendingSnapshotTimer) {
            return;
        }

        this.pendingSnapshotTimer = setTimeout(() => {
            this.pendingSnapshotTimer = null;
            const snapshot = this.pendingSnapshot;
            this.pendingSnapshot = null;
            if (!snapshot) {
                return;
            }
            this.lastSnapshotEmitAt = Date.now();
            this.emit('install-session.snapshot', snapshot);
        }, delayMs);
    }
}
