import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function requestAgent(endpoint, topic, data, timeoutMs = 5000) {
    if (endpoint.version !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string') {
        return Promise.reject(new Error('Invalid GSM agent endpoint. Start GSM again to refresh it.'));
    }
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}`);
        const clientId = `agent-cli-${randomUUID()}`;
        const requestId = randomUUID();
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.terminate();
            if (error) reject(error);
            else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error(`GSM did not answer ${topic} within ${timeoutMs}ms.`)), timeoutMs);
        const send = (message) => socket.send(JSON.stringify({ v: 1, id: randomUUID(), src: clientId, dst: 'main', ...message }));
        socket.on('error', (error) => finish(error));
        socket.on('close', () => finish(new Error('GSM disconnected before acknowledging the command.')));
        socket.on('open', () => send({ kind: 'hello', topic: 'bus.hello', data: { token: endpoint.token, pid: process.pid } }));
        socket.on('message', (raw) => {
            try {
                const message = JSON.parse(raw.toString());
                if (message.kind === 'ack') {
                    send({ id: requestId, kind: 'request', topic, data });
                } else if (message.kind === 'error') {
                    finish(new Error(message.error ?? 'GSM rejected the command.'));
                } else if (message.kind === 'response' && message.corr === requestId) {
                    finish(message.ok ? null : new Error(message.error ?? 'GSM rejected the command.'), message.data);
                }
            } catch (error) { finish(error); }
        });
    });
}

export function readEndpoint(filename) {
    try {
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read the running GSM agent endpoint at ${filename}. Start GSM once with the new build first. (${error.message})`);
    }
}

export async function waitForRestart(filename, previous, requestId, timeoutMs, dependencies = {}) {
    const read = dependencies.read ?? readEndpoint;
    const request = dependencies.request ?? requestAgent;
    const pause = dependencies.sleep ?? sleep;
    const now = dependencies.now ?? Date.now;
    const deadline = now() + timeoutMs;
    let lastError = '';
    while (now() < deadline) {
        let endpoint;
        try { endpoint = read(filename); } catch (error) { lastError = error.message; }
        if (endpoint?.error && (endpoint.instanceId === previous.instanceId || endpoint.restartId === requestId)) {
            throw new Error(endpoint.error);
        }
        if (endpoint?.instanceId !== previous.instanceId && endpoint?.restartId === requestId) {
            try {
                const status = await request(endpoint, 'app.agent.status', undefined, Math.min(2000, Math.max(1, deadline - now())));
                if (status.instanceId === endpoint.instanceId && status.restartId === requestId && status.ready) return status;
                if (status.error) throw new Error(status.error);
                lastError = 'The replacement app is still starting its backend.';
            } catch (error) { lastError = error.message; }
        }
        await pause(Math.min(500, Math.max(0, deadline - now())));
    }
    throw new Error(`GSM did not become ready within ${timeoutMs / 1000} seconds. ${lastError}`.trim());
}

function buildApp() {
    return new Promise((resolve, reject) => {
        // npm's own executable avoids shell quoting entirely when invoked by npm run.
        const npmCli = process.env.npm_execpath;
        const child = npmCli
            ? spawn(process.execPath, [npmCli, 'run', 'build'], { cwd: repoRoot, stdio: 'inherit', windowsHide: true })
            : spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
                cwd: repoRoot, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32',
            });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed (${code}); GSM was not asked to restart.`)));
    });
}

export async function restartRunningApp(filename, options, dependencies = {}) {
    const read = dependencies.read ?? readEndpoint;
    const request = dependencies.request ?? requestAgent;
    const build = dependencies.build ?? buildApp;
    const wait = dependencies.wait ?? waitForRestart;
    const log = dependencies.log ?? console.log;
    const endpoint = read(filename);
    const status = await request(endpoint, 'app.agent.status');
    if (status.instanceId !== endpoint.instanceId) throw new Error('GSM changed instances. Run the command again.');
    if (status.blockedReason) throw new Error(status.blockedReason);
    if (options.build) {
        if (status.isPackaged || path.relative(path.resolve(status.appPath), path.resolve(repoRoot)) !== '') {
            throw new Error('--build requires GSM running from this source checkout.');
        }
        log('Building GSM before requesting a restart...');
        await build();
    }
    const accepted = await request(endpoint, 'app.agent.restart', {
        reason: options.reason, delaySeconds: options.delaySeconds,
    }, 15_000);
    log(`GSM warned you and will restart at ${new Date(accepted.restartAt).toLocaleTimeString()}: ${accepted.reason}`);
    const ready = await wait(filename, endpoint, accepted.requestId, options.timeoutSeconds * 1000);
    log(`GSM is ready with the new changes (PID ${ready.pid}).`);
    return ready;
}

export function parseOptions(args) {
    const { values } = parseArgs({ args, options: {
        reason: { type: 'string', default: 'New changes are ready to try.' },
        delay: { type: 'string', default: '30' },
        timeout: { type: 'string', default: '120' },
        'data-dir': { type: 'string' },
        build: { type: 'boolean', default: false },
        status: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
    } });
    const delaySeconds = Number(values.delay);
    const timeoutSeconds = Number(values.timeout);
    if (!Number.isInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 300) throw new Error('--delay must be a whole number from 5 to 300 seconds.');
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= delaySeconds || timeoutSeconds > 3600) throw new Error('--timeout must exceed --delay and be at most 3600 seconds.');
    if (!values.reason.trim() || values.reason.length > 300) throw new Error('--reason must contain 1 to 300 characters.');
    return { ...values, delaySeconds, timeoutSeconds, reason: values.reason.trim() };
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
        console.log(`Usage: npm run agent:restart -- [--build] [--reason "Changes ready to test"]
  --build          Build this checkout before warning and restarting (npm start mode).
  --delay N        Warning countdown, 5-300 seconds (default: 30).
  --timeout N      Wait for the replacement backend, in seconds (default: 120).
  --status         Print live app status without restarting.
  --data-dir PATH  Override the GSM data folder used for discovery.

GSM must have been started once with agent restart support. The command uses
GSM's normal cleanup, waits for a new app instance, and exits nonzero on failure.`);
        return;
    }
    let dataDir = options['data-dir'];
    if (!dataDir) {
        const { getBaseDir } = await import('../dist/main/data_dir.js').catch(() => {
            throw new Error('Build and start GSM once first (npm start), or specify --data-dir.');
        });
        dataDir = getBaseDir();
    }
    const filename = path.join(path.resolve(dataDir), 'electron', 'agent-control.json');
    if (options.status) {
        console.log(JSON.stringify(await requestAgent(readEndpoint(filename), 'app.agent.status'), null, 2));
    } else {
        await restartRunningApp(filename, options);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`GSM restart failed: ${error.message}`);
        process.exitCode = 1;
    });
}
