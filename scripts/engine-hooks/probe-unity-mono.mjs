#!/usr/bin/env node

// Discovery probe for the Unity/Mono + TextMeshPro engine hook.
//
// Resolves classes through the Mono runtime rather than byte signatures, hooks the
// game's dialogue entry point, and dumps whatever the --dump option asks for.
//
// Usage: node scripts/engine-hooks/probe-unity-mono.mjs --pid=<pid> [--dump=canvas|layout|classes] [--timeout=20000]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import frida from 'frida';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function option(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
    return match?.slice(prefix.length) ?? fallback;
}

const pid = Number.parseInt(option('pid') ?? '', 10);
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Pass --pid=<number>.');
const dump = option('dump', 'canvas');
const timeoutMs = Number.parseInt(option('timeout') ?? '20000', 10);

const source = fs.readFileSync(path.join(scriptDirectory, 'probe-unity-mono.agent.js'), 'utf8');
const session = await frida.attach(pid);
const script = await session.createScript(`globalThis.__PROBE_DUMP__ = ${JSON.stringify(dump)};\n${source}`, {
    name: 'probe-unity-mono',
    runtime: 'qjs',
});
script.message.connect((message) => {
    if (message.type === 'error') {
        process.stderr.write(`${message.stack || message.description}\n`);
        return;
    }
    process.stdout.write(`${JSON.stringify(message.payload, null, 2)}\n`);
});
await script.load();

await new Promise((resolve) => setTimeout(resolve, timeoutMs));
try {
    if (!script.isDestroyed) await script.unload();
} catch {}
try {
    if (!session.isDetached()) await session.detach();
} catch {}
