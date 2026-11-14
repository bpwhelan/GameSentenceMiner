/** UI-facing process lifetime. Rust owns the child and every restart in it. */
import { EventEmitter } from 'node:events';
import { backendCall, backendEvents, backendSync } from './native_runtime.js';
export class NativePythonProcess extends EventEmitter {
    pid?: number;
    killed = false;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    beforeInitialization = true;
    failureMessage?: string;
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    private runId = '';
    private unsubscribe: () => void;
    constructor(spec: Record<string, unknown>) {
        super();
        this.unsubscribe = backendEvents((event, data) => {
            if (data?.id !== 'backend' || data.runId !== this.runId) return;
            if (event === 'log') (data.stream === 'stdout' ? this.stdout : this.stderr).emit('data', Buffer.from(data.message));
            else if (event === 'spawned') { this.pid = data.pid; this.emit('spawn'); }
            else if (event === 'error') this.emit('error', Error(data.error));
            else if (event === 'crashed') this.emit('crash', data);
            else if (event === 'exit') {
                this.beforeInitialization = data.beforeInitialization;
                this.failureMessage = data.error || undefined;
                this.exitCode = data.code ?? 1;
                this.killed = data.intentional;
                this.unsubscribe();
                this.emit('exit', this.exitCode, null);
                this.emit('close', this.exitCode, null);
            }
        });
        try {
            const {restart, ...preparation} = spec;
            const state = backendSync(restart ? 'restart' : 'start', preparation);
            this.runId = state.runId; this.pid = state.pid;
        } catch (error) { this.unsubscribe(); throw error; }
    }
    async stop(force = false): Promise<void> {
        if (this.exitCode !== null) return;
        this.killed = true;
        await backendCall('stop', { runId: this.runId, force });
    }
}
