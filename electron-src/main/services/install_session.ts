/** Temporary launch adapter. Rust owns snapshots, progress, logs and retries. */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {InstallLogEntry, InstallSessionOrigin, InstallSessionSnapshot, InstallStageProgressUpdate} from '../../shared/install_session.js';
export type SessionCall = <T = any>(action: string, params?: unknown) => T;
type Lease = {sessionId: string; attempt: number};
type Claim = {target: string; ticket: string; lease: Lease};

export class InstallSessionManager {
    private readonly retries = new Map<string, () => Promise<void>>();
    private readonly attempt = new AsyncLocalStorage<Lease>();
    constructor(private readonly call: SessionCall) {}
    getActiveSnapshot(): InstallSessionSnapshot | null { return this.call('active'); }
    getLastFinishedSnapshot(): InstallSessionSnapshot | null { return this.call('last'); }
    getRendererSnapshot(): InstallSessionSnapshot | null { return this.call('renderer'); }
    private start(action: 'start' | 'ensure', origin: InstallSessionOrigin, retry?: () => Promise<void>): InstallSessionSnapshot {
        if (retry) this.retries.set(origin, retry);
        return this.call(action, {origin, retry: retry ? origin : undefined});
    }
    startSession(origin: InstallSessionOrigin, retry?: () => Promise<void>): InstallSessionSnapshot { return this.start('start', origin, retry); }
    ensureSession(origin: InstallSessionOrigin, retry?: () => Promise<void>): InstallSessionSnapshot { return this.start('ensure', origin, retry); }
    updateStage(update: InstallStageProgressUpdate): void { this.call('update', {update, lease: this.attempt.getStore()}); }
    appendLog(entry: Omit<InstallLogEntry, 'id' | 'createdAt'>): void { this.call('log', {entry, lease: this.attempt.getStore()}); }
    finishActive(status: 'completed' | 'failed', message?: string, error?: string | null): InstallSessionSnapshot | null {
        return this.call('finish', {status, message, error, lease: this.attempt.getStore()});
    }
    finishAttempt(lease: Lease, status: 'completed' | 'failed', message?: string, error?: string | null): InstallSessionSnapshot | null {
        return this.call('finish', {status, message, error, lease});
    }
    executeRetry(claim: Claim): {accepted: boolean} {
        const retry = this.retries.get(claim?.target);
        if (!retry || !this.call('acceptRetry', {ticket: claim.ticket})) return {accepted: false};
        // A backend launch can live until app exit. Acknowledge immediately;
        // native progress reports completion and the lease guards late failures.
        this.attempt.run(claim.lease, () => {
            void Promise.resolve().then(retry).catch(error => {
                this.finishActive('failed', 'Installation retry failed.', String(error));
            });
        });
        return {accepted: true};
    }
}
