import semver from 'semver';
import type { EngineDownloadProgress, EngineStatus, EngineUpdateState } from '../../shared/texthook_updates.js';

interface UpdateResult {
    success: boolean;
    deferred?: boolean;
    error?: string;
}

interface Dependencies<Package> {
    localStatus(): EngineStatus;
    remoteStatus(): Promise<EngineStatus>;
    prepare(progress: (value: EngineDownloadProgress) => void, verifying: () => void): Promise<Package>;
    activate(prepared: Package): Promise<void>;
    discard(prepared: Package): Promise<void>;
    version(prepared: Package): string;
    isBusy(): boolean;
    automaticEnabled(): boolean;
    setAutomatic(enabled: boolean): void;
    onState(state: EngineUpdateState): void;
}

/** Owns background checks and the idle boundary; never interrupts a running hook. */
export class TextHookUpdateManager<Package> {
    private phase: EngineUpdateState['phase'] = 'idle';
    private remoteVersion: string | null = null;
    private error: string | null = null;
    private progress: EngineDownloadProgress | null = null;
    private pending: Package | null = null;
    private pendingAutomatic = false;
    private operation: Promise<UpdateResult> | null = null;
    private checking: Promise<EngineUpdateState> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private disposed = false;

    constructor(private readonly deps: Dependencies<Package>) {}

    getState(): EngineUpdateState {
        const local = this.deps.localStatus();
        return {
            ...local,
            remoteVersion: this.remoteVersion,
            updateAvailable: local.installed && !!local.version && !!this.remoteVersion
                && !!semver.valid(local.version) && !!semver.valid(this.remoteVersion)
                && semver.gt(this.remoteVersion, local.version),
            automatic: this.deps.automaticEnabled(),
            phase: this.phase,
            pendingVersion: this.pending ? this.deps.version(this.pending) : null,
            error: this.error,
            progress: this.progress,
        };
    }

    private emit(): void {
        if (!this.disposed) this.deps.onState(this.getState());
    }

    isInstalling(): boolean { return this.phase === 'installing'; }
    isPreparing(): boolean { return this.phase === 'downloading' || this.phase === 'verifying'; }

    start(): void {
        if (this.timer || this.disposed) return;
        void this.check();
        this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
        this.timer.unref?.();
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    setAutomatic(enabled: boolean): void {
        this.deps.setAutomatic(enabled);
        this.emit();
        if (enabled) void this.check();
        else this.notifyIdle();
    }

    check(): Promise<EngineUpdateState> {
        if (this.operation || this.pending || this.disposed) return Promise.resolve(this.getState());
        if (this.checking) return this.checking;
        this.checking = this.checkInternal().finally(() => { this.checking = null; });
        return this.checking;
    }

    private async checkInternal(): Promise<EngineUpdateState> {
        this.phase = 'checking';
        this.error = null;
        this.emit();
        try {
            const status = await this.deps.remoteStatus();
            this.remoteVersion = status.remoteVersion;
            // A manual request may have begun while the network check was pending.
            if (this.operation || this.pending || this.disposed) return this.getState();
            this.phase = status.remoteVersion ? 'idle' : 'error';
            this.error = status.remoteVersion ? null : 'Could not check for engine updates.';
            this.emit();
            if (status.installed && status.updateAvailable && this.getState().updateAvailable && this.deps.automaticEnabled()) {
                void this.download(true);
            }
        } catch (error) {
            if (!this.operation && !this.pending) this.fail(error);
        }
        return this.getState();
    }

    download(automatic = false): Promise<UpdateResult> {
        if (this.disposed) return Promise.resolve({ success: false, error: 'GSM is shutting down.' });
        if (this.operation) return this.operation;
        this.operation = (this.pending ? this.applyPending() : this.prepare(automatic))
            .finally(() => { this.operation = null; });
        return this.operation;
    }

    private async prepare(automatic: boolean): Promise<UpdateResult> {
        this.phase = 'downloading';
        this.error = null;
        this.progress = null;
        this.pendingAutomatic = automatic;
        this.emit();
        try {
            this.pending = await this.deps.prepare((progress) => {
                this.phase = 'downloading';
                this.progress = progress;
                this.emit();
            }, () => {
                this.phase = 'verifying';
                this.progress = null;
                this.emit();
            });
            this.remoteVersion = this.deps.version(this.pending);
            return await this.applyPending();
        } catch (error) {
            return this.fail(error);
        }
    }

    notifyIdle(): void {
        if (this.pending && !this.operation && !this.disposed) void this.download(this.pendingAutomatic);
    }

    private async applyPending(): Promise<UpdateResult> {
        const prepared = this.pending;
        if (!prepared) return { success: true };
        if (this.disposed || (this.pendingAutomatic && !this.deps.automaticEnabled())) {
            this.pending = null;
            await this.deps.discard(prepared);
            this.phase = 'idle';
            this.emit();
            return { success: true };
        }
        if (this.deps.isBusy()) {
            this.phase = 'waiting';
            this.progress = null;
            this.emit();
            return { success: true, deferred: true };
        }
        // Set synchronously before awaiting verification so new attachments can
        // reserve against this final, short activation phase.
        this.phase = 'installing';
        this.progress = null;
        this.emit();
        try {
            await this.deps.activate(prepared);
            this.pending = null;
            this.phase = 'idle';
            this.error = null;
            this.emit();
            return { success: true };
        } catch (error) {
            this.pending = null;
            await this.deps.discard(prepared);
            return this.fail(error);
        }
    }

    private fail(error: unknown): UpdateResult {
        this.error = error instanceof Error ? error.message : String(error);
        this.phase = 'error';
        this.progress = null;
        this.emit();
        return { success: false, error: this.error };
    }

    async waitForOperation(): Promise<void> {
        await this.checking;
        await this.operation;
    }
}
