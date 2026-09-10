import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { app, ipcMain } from 'electron';
import { getBaseDir } from '../data_dir.js';
import {
    callAgentUiRpc,
    configureAgentHookCallbacks,
    getAgentHookRuntimeStatus,
    listAgentHooks,
    sendAgentUiRpc,
    setAgentCopyToClipboard,
    setAgentFlushDelayMs,
    showAgentScriptUi,
    startAgentHookSession,
    stopAgentHookSession,
} from './agent.js';
import {
    AGENT_HOST_OPTIONS_ARG,
    AGENT_HOST_PROTOCOL_VERSION,
    type AgentHostMessage,
    type AgentHostMetadata,
    type AgentHostRequest,
    type AgentHostResponse,
    type DetachedAgentStartOptions,
} from './agent_host_protocol.js';
import { setRuntimeTextHookMaxBufferSize } from './text_hook_sanitize.js';

const METADATA_FILE = path.join(getBaseDir(), 'texthook', 'agent-host.json');
const clients = new Set<net.Socket>();
let startResult: Awaited<ReturnType<typeof startAgentHookSession>> | undefined;
let started = false;
let shuttingDown = false;

function getArgValue(name: string): string | null {
    const prefix = `${name}=`;
    const argument = process.argv.find((value) => value.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function readOptions(): DetachedAgentStartOptions {
    const encoded = getArgValue(AGENT_HOST_OPTIONS_ARG);
    if (!encoded) throw new Error('Detached Agent host options are missing.');
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as DetachedAgentStartOptions;
}

function writeMessage(target: net.Socket, message: AgentHostMessage): void {
    if (!target.destroyed) target.write(`${JSON.stringify(message)}\n`);
}

function broadcast(channel: string, payload: unknown): void {
    for (const client of clients) {
        writeMessage(client, { kind: 'event', channel, payload });
    }
}

function detachedStatus(): unknown {
    const status = getAgentHookRuntimeStatus();
    return status?.running ? { ...status, agentDetached: true } : { running: false };
}

function state(): unknown {
    return {
        status: detachedStatus(),
        hooks: listAgentHooks(),
        startResult,
    };
}

async function handleRequest(request: AgentHostRequest): Promise<unknown> {
    switch (request.command) {
        case 'state':
            return state();
        case 'stop':
            stopAgentHookSession();
            setTimeout(shutdown, 250);
            return { success: true };
        case 'setFlushDelay':
            return setAgentFlushDelayMs(Number(request.args?.[0]));
        case 'setCopyToClipboard':
            return setAgentCopyToClipboard(Boolean(request.args?.[0]));
        case 'setMaxBufferSize':
            return { maxBufferSize: setRuntimeTextHookMaxBufferSize(request.args?.[0]) };
        case 'showUi':
            return showAgentScriptUi();
        case 'rpcCall':
            return callAgentUiRpc(String(request.args?.[0] ?? ''), (request.args?.[1] as unknown[]) ?? []);
        case 'rpcSend':
            return sendAgentUiRpc(String(request.args?.[0] ?? ''), (request.args?.[1] as unknown[]) ?? []);
        default:
            throw new Error(`Unknown detached Agent command: ${request.command}`);
    }
}

function authenticateAndListen(client: net.Socket, token: string): void {
    let authenticated = false;
    let buffer = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) {
                try {
                    const message = JSON.parse(line) as any;
                    if (!authenticated) {
                        if (message.kind !== 'hello' || message.token !== token) {
                            client.destroy();
                            return;
                        }
                        authenticated = true;
                        clients.add(client);
                    } else if (message.kind === 'request') {
                        const request = message as AgentHostRequest;
                        void handleRequest(request)
                            .then((result) => {
                                const response: AgentHostResponse = {
                                    kind: 'response',
                                    id: request.id,
                                    success: true,
                                    result,
                                };
                                writeMessage(client, response);
                            })
                            .catch((error) => {
                                const response: AgentHostResponse = {
                                    kind: 'response',
                                    id: request.id,
                                    success: false,
                                    error: (error as Error).message,
                                };
                                writeMessage(client, response);
                            });
                    }
                } catch {
                    client.destroy();
                    return;
                }
            }
            newlineIndex = buffer.indexOf('\n');
        }
    });
    client.on('close', () => clients.delete(client));
    client.on('error', () => client.destroy());
}

function writeMetadata(server: net.Server, token: string): void {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Detached Agent host has no TCP address.');
    const metadata: AgentHostMetadata = {
        version: AGENT_HOST_PROTOCOL_VERSION,
        hostPid: process.pid,
        port: address.port,
        token,
        startedAt: Date.now(),
    };
    fs.mkdirSync(path.dirname(METADATA_FILE), { recursive: true });
    const temporaryPath = `${METADATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, METADATA_FILE);
}

function removeOwnMetadata(): void {
    try {
        const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')) as Partial<AgentHostMetadata>;
        if (metadata.hostPid === process.pid) fs.rmSync(METADATA_FILE, { force: true });
    } catch {
        // Metadata may already have been replaced or removed.
    }
}

let server: net.Server | null = null;

function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    removeOwnMetadata();
    for (const client of clients) client.destroy();
    clients.clear();
    server?.close(() => app.exit(0));
    setTimeout(() => app.exit(0), 500);
}

export async function runDetachedAgentHost(): Promise<void> {
    const token = process.env.GSM_AGENT_HOST_TOKEN || getArgValue('--gsm-agent-host-token');
    if (!token) throw new Error('Detached Agent host token is missing.');
    const options = readOptions();

    await app.whenReady();
    app.on('window-all-closed', () => undefined);
    ipcMain.handle('texthook.agentUiRpcCall', (_event, func: string, args: unknown[] | undefined) =>
        callAgentUiRpc(String(func ?? ''), Array.isArray(args) ? args : []),
    );
    ipcMain.handle('texthook.agentUiRpcSend', (_event, func: string, args: unknown[] | undefined) =>
        sendAgentUiRpc(String(func ?? ''), Array.isArray(args) ? args : []),
    );
    configureAgentHookCallbacks({
        onEvent: (channel, payload) => {
            const nextPayload = channel === 'texthook.status' && (payload as any)?.running
                ? { ...(payload as object), agentDetached: true }
                : payload;
            broadcast(channel, nextPayload);
            if (started && channel === 'texthook.status' && !(payload as any)?.running) {
                setTimeout(shutdown, 250);
            }
        },
        onText: (payload) => broadcast('agent.text', payload),
    });

    server = net.createServer((client) => authenticateAndListen(client, token));
    await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(0, '127.0.0.1', () => resolve());
    });
    writeMetadata(server, token);

    startResult = await startAgentHookSession(options);
    started = startResult.success;
    if (!startResult.success) {
        setTimeout(shutdown, 10_000);
    }
}

process.once('SIGTERM', () => {
    stopAgentHookSession();
    shutdown();
});
process.once('SIGINT', () => {
    stopAgentHookSession();
    shutdown();
});
process.once('exit', removeOwnMetadata);
