#!/usr/bin/env node

// Injects a shipped support package, decodes one line through the same decoder
// registry the app uses, and writes every glyph and line rectangle to a JSON file.
//
// run-support.mjs prints only the first and last glyph, which is enough to see that
// a package works but not enough to draw its boxes over a screenshot. This writes
// the whole set so the packaged artifact — not a probe — can be confirmed visually.
//
// Usage:
//   node scripts/engine-hooks/dump-support-boxes.mjs --support=<id> --pid=<pid> --out=<file> [--advance]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import frida, { ScriptRuntime } from 'frida';

import { getEngineHookDecoder } from '../../dist/main/engine_hooks/decoders/index.js';
import { parseEngineHookManifest } from '../../dist/main/engine_hooks/support.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const catalogDirectory = path.join(repositoryRoot, 'electron-src', 'assets', 'engine_hooks');

function option(name) {
    const prefix = `--${name}=`;
    return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const supportId = option('support');
const pid = Number.parseInt(option('pid') ?? '', 10);
const outputPath = option('out');
if (!supportId || !/^[a-z0-9][a-z0-9-]*$/u.test(supportId)) throw new Error('Pass --support=<package-id>.');
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Pass --pid=<number>.');
if (!outputPath) throw new Error('Pass --out=<file>.');

const supportDirectory = path.join(catalogDirectory, supportId);
const manifest = parseEngineHookManifest(
    JSON.parse(fs.readFileSync(path.join(supportDirectory, 'manifest.json'), 'utf8')),
);
const payload = fs.readFileSync(path.join(supportDirectory, manifest.payload), 'utf8');
const decoder = getEngineHookDecoder(manifest.decoder);
const support = {
    directory: supportDirectory,
    manifest,
    payloadSource: payload,
    resources: decoder.loadResources?.(supportDirectory, manifest),
};

const timeoutMs = Number.parseInt(option('timeout') ?? '15000', 10);
const session = await frida.attach(pid);
const script = await session.createScript(
    `globalThis.__GSM_ENGINE_HOOK_CONFIG__ = ${JSON.stringify(manifest)};\n${payload}`,
    { name: `${manifest.id}-boxes`, runtime: ScriptRuntime.QJS },
);

let finish;
const completed = new Promise((resolve, reject) => {
    finish = { resolve, reject };
});
const timer = setTimeout(() => finish.reject(new Error(`No text layout arrived within ${timeoutMs} ms.`)), timeoutMs);

script.message.connect((message) => {
    if (message.type === 'error') {
        finish.reject(new Error(message.stack || message.description));
        return;
    }
    const body = message.payload;
    if (body?.type === 'ready' && process.argv.includes('--advance')) {
        void script.exports.advance().catch((error) => finish.reject(error));
        return;
    }
    if (body?.type === 'diagnostic') {
        process.stderr.write(`${body.level}: ${body.message}\n`);
        return;
    }
    if (body?.type !== 'text-layout') return;
    const decoded = decoder.decodeLayout(body, support);
    if (!decoded) return;
    fs.writeFileSync(
        outputPath,
        JSON.stringify({
            supportId: manifest.id,
            text: decoded.text,
            coordinateMeasurement: body.coordinateSpace,
            glyphs: decoded.glyphs,
            lines: decoded.lines.map((line) => line.bounds),
        }),
    );
    process.stdout.write(`${JSON.stringify({ text: decoded.text, glyphs: decoded.glyphs.length })}\n`);
    finish.resolve();
});

try {
    await script.load();
    await completed;
} finally {
    clearTimeout(timer);
    try {
        if (!script.isDestroyed) await script.unload();
    } catch {}
    try {
        if (!session.isDetached()) await session.detach();
    } catch {}
}
