/** Compatibility registry. Process ownership, readiness, restart policy,
 * graceful deadlines and process-tree cleanup all live in gsm-runtime. */
import { EventEmitter } from 'node:events';
import { runtimeCall, runtimeSync, runtimeEvents } from './native_runtime.js';
export type ProcessState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed';

export type ProcessPriority = 'low' | 'below_normal' | 'normal' | 'above_normal' | 'high';

export interface ProcessSpec {
    /** Stable id; also the bus client id this process connects with. */
    id: string;
    /** Build the executable + args at spawn time (so config changes are picked up). */
    buildCommand: () => { command: string; args: string[] };
    /** Extra env merged over the base spawn env. */
    env?: () => NodeJS.ProcessEnv;
    cwd?: string;
    windowsHide?: boolean | (() => boolean);
    /** Label used to give the Windows process a recognizable name in Task Manager. */
    namedExecutableLabel?: string;
    /** Optional process priority applied after spawn (Windows). */
    priority?: () => ProcessPriority;
    /** How readiness is determined. Default 'hello' (waits for bus connect). */
    readyOn?: 'hello' | 'spawn';
    /** Graceful stop: a bus command (with optional payload) sent before escalating to signals. */
    gracefulStop?: { topic: string; data?: unknown; timeoutMs: number };
    /** Auto-restart policy on unexpected exit. */
    autoRestart?: {
        enabled: boolean;
        initialDelayMs?: number;
        maxDelayMs?: number;
        maxRetries?: number;
    };
}

export interface ProcessManagerOptions {
    baseEnv?: () => NodeJS.ProcessEnv;
    launchBlocked?: () => boolean;
    resolveExecutable?: (command: string, label: string | undefined) => string;
}

export interface ProcessStopOptions {
    /** Override the spec's graceful-stop payload for this stop/restart request. */
    gracefulStopData?: unknown;
}


export class ProcessManager extends EventEmitter {
    private specs = new Map<string, ProcessSpec>();
    private unsubscribe: () => void;
    constructor(private options: ProcessManagerOptions) {
        super();
        this.unsubscribe = runtimeEvents((event, data) => {
            if (!this.specs.has(data?.id)) return;
            if (event === 'process.state') { this.emit('state-changed', data.id, data.state); if (data.state === 'ready') this.emit('ready', data.id); }
            else if (event === 'process.log') this.emit('log', data.id, { stream: data.stream, message: data.message });
            else if (event === 'process.crashed') this.emit('crashed', data.id, data.code, null);
            else if (event === 'process.exit') this.emit('exit', data.id, data.code);
        });
    }
    dispose(): void { this.unsubscribe(); }
    register(spec: ProcessSpec): void { if (this.specs.has(spec.id)) throw Error(`Process "${spec.id}" already registered`); this.specs.set(spec.id, spec); }
    getStatus(id: string): { state: ProcessState; pid: number | null } { return runtimeSync('process.state', { id }); }
    getState(id: string): ProcessState { return this.getStatus(id).state; }
    getPid(id: string): number | undefined { return this.getStatus(id).pid ?? undefined; }
    isRunning(id: string): boolean { const status = this.getStatus(id); return status.pid != null || status.state === 'starting'; }
    async start(id: string): Promise<void> {
        if (this.options.launchBlocked?.() || this.isRunning(id)) return;
        const spec = this.specs.get(id); if (!spec) throw Error(`Process "${id}" is not registered`);
        const command = spec.buildCommand();
        await runtimeCall('process.start', {
            id, command: this.options.resolveExecutable?.(command.command, spec.namedExecutableLabel) ?? command.command, args: command.args,
            env: { ...(this.options.baseEnv?.() ?? process.env), ...(spec.env?.() ?? {}) }, cwd: spec.cwd,
            windowsHide: typeof spec.windowsHide === 'function' ? spec.windowsHide() : spec.windowsHide,
            priority: spec.priority?.(), readyOn: spec.readyOn, gracefulStop: spec.gracefulStop, autoRestart: spec.autoRestart,
        });
    }
    async setPriority(id: string, priority: ProcessPriority): Promise<void> {
        const state = runtimeSync('process.state', { id });
        await runtimeCall('process.priority', { id, runId: state.runId, priority });
    }
    async stop(id: string, options?: ProcessStopOptions): Promise<void> { await runtimeCall('process.stop', { id, ...options }); }
    async restart(id: string, options?: ProcessStopOptions): Promise<void> { await this.stop(id, options); await this.start(id); }
    async stopAll(): Promise<void> { await Promise.all([...this.specs.keys()].map(id => this.stop(id))); }
    async cleanupStale(): Promise<void> { /* Native ownership replaces persisted PID scans. */ }
}
