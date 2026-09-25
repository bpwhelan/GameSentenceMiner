import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrokerStartInfo, MessageBroker } from '../runtime/message_bus.js';

export const AGENT_RESTART_ARG = '--gsm-agent-restarted=';

interface AgentControlDependencies {
    broker: Pick<MessageBroker, 'handle'>;
    connection: BrokerStartInfo;
    userDataPath: string;
    appPath: string;
    isPackaged: boolean;
    restartId: string | null;
    isReady: () => boolean;
    getBlockedReason: () => string | null;
    notify: (reason: string, seconds: number, restartNow: () => void) => Promise<void>;
    restart: (requestId: string) => Promise<void>;
}

export function agentRelaunchArgs(args: string[], requestId: string): string[] {
    return [...args.filter((arg) => !arg.startsWith(AGENT_RESTART_ARG)), `${AGENT_RESTART_ARG}${requestId}`];
}

/** Agent commands share the existing authenticated, loopback-only message bus. */
export function startAgentControl(deps: AgentControlDependencies) {
    const filename = path.join(deps.userDataPath, 'agent-control.json');
    const descriptor = {
        version: 1,
        instanceId: randomUUID(),
        pid: process.pid,
        appPath: deps.appPath,
        isPackaged: deps.isPackaged,
        restartId: deps.restartId,
        ...deps.connection,
    };
    let error: string | null = null;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<{ requestId: string; restartAt: number; reason: string }> | null = null;

    function save(): void {
        fs.mkdirSync(deps.userDataPath, { recursive: true });
        const temporary = `${filename}.${descriptor.instanceId}.tmp`;
        try {
            // Restrict the per-launch bus credential to this user on POSIX. On
            // Windows the file inherits the user's private app-data directory ACL.
            fs.writeFileSync(temporary, JSON.stringify({ ...descriptor, error }), { mode: 0o600 });
            fs.renameSync(temporary, filename);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }

    function fail(reason: unknown): void {
        error = reason instanceof Error ? reason.message : String(reason);
        if (timer) clearTimeout(timer);
        timer = undefined;
        pending = null;
        try { save(); } catch (writeError) {
            console.error('Could not record agent restart failure:', writeError);
        }
        console.error('Agent restart failed:', error);
    }

    function getStatus() {
        return {
            instanceId: descriptor.instanceId,
            pid: descriptor.pid,
            appPath: deps.appPath,
            isPackaged: deps.isPackaged,
            restartId: deps.restartId,
            ready: !disposed && !pending && !error && deps.isReady(),
            restarting: pending !== null,
            blockedReason: disposed ? 'GSM is shutting down.' : deps.getBlockedReason(),
            error,
        };
    }

    async function schedule(data: unknown) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Restart options must be an object.');
        }
        const options = data as { reason?: unknown; delaySeconds?: unknown };
        const delaySeconds = options.delaySeconds ?? 30;
        if (typeof delaySeconds !== 'number' || !Number.isInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 300) {
            throw new Error('The warning delay must be a whole number from 5 to 300 seconds.');
        }
        if (options.reason !== undefined && (typeof options.reason !== 'string' || !options.reason.trim() || options.reason.length > 300)) {
            throw new Error('The restart reason must contain 1 to 300 characters.');
        }
        const blocked = deps.getBlockedReason();
        if (disposed || blocked) throw new Error(blocked ?? 'GSM is shutting down.');
        const reason = typeof options.reason === 'string' ? options.reason.trim() : 'New changes are ready to try.';
        const requestId = randomUUID();
        error = null;
        save();
        let restartEarlyRequested = false;
        let restartStarted = false;
        const startRestart = () => {
            if (disposed || restartStarted) return;
            restartStarted = true;
            if (timer) clearTimeout(timer);
            timer = undefined;
            const blockedNow = deps.getBlockedReason();
            if (blockedNow) {
                fail(new Error(blockedNow));
                return;
            }
            void Promise.resolve().then(() => deps.restart(requestId)).catch(fail);
        };
        await deps.notify(reason, delaySeconds, () => {
            restartEarlyRequested = true;
            if (timer) startRestart();
        });
        if (disposed) throw new Error('GSM shut down while displaying the restart warning.');
        const restartAt = Date.now() + delaySeconds * 1000;
        if (restartEarlyRequested) startRestart();
        else timer = setTimeout(startRestart, delaySeconds * 1000);
        return { requestId, restartAt, reason };
    }

    function requestRestart(data: unknown = {}) {
        // Reserve before waiting for the OS to display the warning, so concurrent
        // agents share one warning, countdown, and relaunch.
        if (!pending) {
            pending = schedule(data).catch((reason) => {
                pending = null;
                throw reason;
            });
        }
        return pending;
    }

    save();
    const unregister = [
        deps.broker.handle('app.agent.status', getStatus),
        deps.broker.handle('app.agent.restart', (message) => requestRestart(message.data ?? {})),
    ];

    function dispose(): void {
        if (disposed) return;
        disposed = true;
        if (timer) clearTimeout(timer);
        for (const remove of unregister) remove();
        try {
            const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
            // A replacement may already have published its own endpoint. Keep
            // failures available to the CLI even after the old app exits.
            if (!error && current.instanceId === descriptor.instanceId) fs.rmSync(filename);
        } catch (cleanupError: any) {
            if (cleanupError?.code !== 'ENOENT') console.warn('Could not remove agent endpoint:', cleanupError);
        }
    }

    return { requestRestart, getStatus, fail, dispose };
}
