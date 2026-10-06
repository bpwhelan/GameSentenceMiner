import {
    gameBackgroundTargetKey, normalizeGameBackgroundOptions,
    type GameBackgroundOptions, type GameBackgroundReason, type GameBackgroundState,
    type GameBackgroundTarget, type GameBackgroundTelemetry,
} from '../../shared/game_background.js';

export interface BackgroundController {
    configure(options: GameBackgroundOptions): void;
    stop(): Promise<void>;
}
export interface BackgroundTargetResult {
    sceneId: string;
    target?: GameBackgroundTarget;
    reason?: GameBackgroundReason;
}
interface Dependencies {
    resolve(): Promise<BackgroundTargetResult>;
    load(path: string): GameBackgroundOptions;
    save(path: string, options: GameBackgroundOptions): void;
    launch(target: GameBackgroundTarget, options: GameBackgroundOptions,
        onStatus: (status: GameBackgroundTelemetry) => void, onExit: (error?: string) => void): BackgroundController;
}

/** One serialized owner follows the current OBS capture, with an executable-path allowlist. */
export class GameBackgroundService {
    private state: GameBackgroundState = { sceneId: '', phase: 'waiting', options: normalizeGameBackgroundOptions(null) };
    private controller?: BackgroundController;
    private controllerKey = '';
    private failedKey = '';
    private closed = false;
    private queue: Promise<unknown> = Promise.resolve();
    private applied = '';
    private generation = 0;
    private pendingRefresh?: Promise<GameBackgroundState>;

    constructor(private readonly deps: Dependencies) {}

    snapshot(): GameBackgroundState { return structuredClone(this.state); }
    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const result = this.queue.then(work);
        this.queue = result.catch(() => undefined);
        return result;
    }
    private async stop(): Promise<void> {
        ++this.generation;
        const controller = this.controller;
        this.controller = undefined;
        this.controllerKey = '';
        this.applied = '';
        if (controller) await controller.stop();
    }
    private async reconcile(resolved: BackgroundTargetResult): Promise<void> {
        const { target, sceneId, reason } = resolved;
        const options = target ? this.deps.load(target.path) : normalizeGameBackgroundOptions(null);
        const key = target ? gameBackgroundTargetKey(target) : '';
        if (key !== this.controllerKey || !options.enabled || target?.specialK || this.closed) await this.stop();
        const previous = this.state;
        this.state = { sceneId, target, options, phase: target ? 'disabled' : 'waiting', reason };
        if (this.closed || !target) return;
        if (target.specialK) { this.state.phase = 'blocked'; this.state.reason = 'specialK'; return; }
        if (!options.enabled) return;
        if (this.failedKey === key) {
            this.state.phase = 'error'; this.state.error = previous.error;
            return;
        }
        const serialized = JSON.stringify(options);
        if (this.controller) {
            this.state.phase = previous.phase;
            this.state.telemetry = previous.telemetry;
            this.state.error = previous.error;
            if (serialized !== this.applied) {
                this.controller.configure(options);
                this.applied = serialized;
                this.state.phase = 'attaching';
            }
            return;
        }
        this.state.phase = 'attaching';
        this.controllerKey = key;
        this.applied = serialized;
        const generation = ++this.generation;
        try {
            this.controller = this.deps.launch(target, options, telemetry => {
                if (this.controllerKey !== key || this.closed || generation !== this.generation) return;
                this.state.telemetry = telemetry;
                const desired = (this.state.options.keepRendering ? 1 : 0) | (this.state.options.blockGamepad ? 2 : 0);
                this.state.phase = telemetry.effective === desired ? 'active' : 'attaching';
            }, error => {
                if (this.controllerKey !== key || this.closed || generation !== this.generation) return;
                this.controller = undefined;
                this.controllerKey = '';
                this.failedKey = key;
                this.state.phase = 'error';
                this.state.error = error || 'Game background helper stopped unexpectedly';
            });
        } catch (error) {
            this.controllerKey = '';
            this.failedKey = key;
            this.state.phase = 'error';
            this.state.error = String(error);
        }
    }
    refresh(): Promise<GameBackgroundState> {
        if (this.pendingRefresh) return this.pendingRefresh;
        const refresh = this.serialize(async () => {
            if (!this.closed) {
                try { await this.reconcile(await this.deps.resolve()); }
                catch (error) {
                    await this.stop();
                    this.state = { ...this.state, phase: 'error', error: String(error) };
                }
            }
            return this.snapshot();
        });
        this.pendingRefresh = refresh;
        void refresh.finally(() => { if (this.pendingRefresh === refresh) this.pendingRefresh = undefined; }).catch(() => undefined);
        return refresh;
    }
    save(sceneId: string, expected: GameBackgroundTarget, options: unknown): Promise<GameBackgroundState> {
        return this.serialize(async () => {
            if (this.closed) throw new Error('Game background service is shutting down');
            const resolved = await this.deps.resolve();
            if (!resolved.target || resolved.sceneId !== sceneId || gameBackgroundTargetKey(resolved.target) !== gameBackgroundTargetKey(expected))
                throw new Error('The captured game changed; refresh and try again');
            this.deps.save(resolved.target.path, normalizeGameBackgroundOptions(options));
            this.failedKey = '';
            await this.reconcile(resolved);
            return this.snapshot();
        });
    }
    shutdown(): Promise<void> {
        this.closed = true;
        return this.serialize(async () => { await this.stop(); this.state.phase = 'disabled'; });
    }
}
