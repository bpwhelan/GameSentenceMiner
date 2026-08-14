#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import frida, { ScriptRuntime } from 'frida';

import {
    decodeMagesLayout,
    parseMagesCompoundMap,
} from '../../dist/main/engine_hooks/mages_decoder.js';
import { deriveEngineLogicalCoordinateSpace } from '../../dist/main/engine_hooks/protocol.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const supportCatalogDirectory = path.join(
    repositoryRoot,
    'electron-src',
    'assets',
    'engine_hooks',
);

function option(name) {
    const prefix = `--${name}=`;
    const match = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
    return match?.slice(prefix.length) ?? null;
}

async function resolvePid(executableName) {
    const explicitPid = Number.parseInt(option('pid') ?? '', 10);
    if (Number.isInteger(explicitPid) && explicitPid > 0) return explicitPid;
    const device = await frida.getLocalDevice();
    const processes = await device.enumerateProcesses();
    const matches = processes.filter(
        (candidate) => candidate.name.toLowerCase() === executableName.toLowerCase(),
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected one running ${executableName} process, found ${matches.length}. ` +
                'Pass --pid=<number> to choose explicitly.',
        );
    }
    return matches[0].pid;
}

async function main() {
    const supportId = option('support') ?? 'mages-steins-gate-steam';
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(supportId)) {
        throw new Error('Support ids may contain lower-case letters, digits, and hyphens only.');
    }
    const supportDirectory = path.join(supportCatalogDirectory, supportId);
    const manifest = JSON.parse(fs.readFileSync(path.join(supportDirectory, 'manifest.json'), 'utf8'));
    if (manifest.decoder !== 'mages-v1') {
        throw new Error(`The validation runner does not yet implement decoder ${manifest.decoder}.`);
    }
    const payload = fs.readFileSync(path.join(supportDirectory, manifest.payload), 'utf8');
    const charset = fs.readFileSync(path.join(supportDirectory, manifest.resources.charset), 'utf8');
    const compounds = parseMagesCompoundMap(
        fs.readFileSync(path.join(supportDirectory, manifest.resources.compoundCharacters), 'utf8'),
    );
    const pid = await resolvePid(manifest.target.executableNames[0]);
    const timeoutMs = Number.parseInt(option('timeout') ?? '15000', 10);
    const shouldAdvance = process.argv.includes('--advance');

    const targetSession = await frida.attach(pid);
    const injectedSource = `globalThis.__GSM_ENGINE_HOOK_CONFIG__ = ${JSON.stringify(manifest)};\n${payload}`;
    const script = await targetSession.createScript(injectedSource, {
        name: `${manifest.id}-validation`,
        runtime: ScriptRuntime.QJS,
    });

    let finish;
    const completed = new Promise((resolve, reject) => {
        finish = { resolve, reject };
    });
    const timer = setTimeout(
        () => finish.reject(new Error(`No text layout arrived within ${timeoutMs} ms.`)),
        timeoutMs,
    );

    script.message.connect((message) => {
        if (message.type === 'error') {
            finish.reject(new Error(message.stack || message.description));
            return;
        }
        const payloadMessage = message.payload;
        if (payloadMessage?.type === 'ready') {
            process.stdout.write(`${JSON.stringify(payloadMessage)}\n`);
            if (shouldAdvance) {
                void script.exports.advance().then(
                    (result) => process.stdout.write(`${JSON.stringify({ type: 'advance', ...result })}\n`),
                    (error) => finish.reject(error),
                );
            }
            return;
        }
        if (payloadMessage?.type === 'diagnostic') {
            process.stderr.write(`${payloadMessage.level}: ${payloadMessage.message}\n`);
            return;
        }
        if (payloadMessage?.type !== 'text-layout') return;
        try {
            const decoded = decodeMagesLayout(payloadMessage.positionedCodes, charset, compounds);
            const coordinateSpace = deriveEngineLogicalCoordinateSpace(payloadMessage.coordinateSpace);
            if (!coordinateSpace) {
                throw new Error(
                    `Invalid coordinate measurement: ${JSON.stringify(payloadMessage.coordinateSpace)}`,
                );
            }
            process.stdout.write(
                `${JSON.stringify(
                    {
                        integrationId: payloadMessage.integrationId,
                        sequence: payloadMessage.sequence,
                        callerOffset: payloadMessage.callerOffset,
                        mode: payloadMessage.mode,
                        style: payloadMessage.style,
                        coordinateMeasurement: payloadMessage.coordinateSpace,
                        coordinateSpace,
                        text: decoded.text,
                        lines: decoded.lines,
                        glyphCount: decoded.glyphs.length,
                        firstGlyph: decoded.glyphs[0] ?? null,
                        lastGlyph: decoded.glyphs.at(-1) ?? null,
                    },
                    null,
                    2,
                )}\n`,
            );
            finish.resolve();
        } catch (error) {
            finish.reject(error);
        }
    });

    try {
        await script.load();
        await completed;
    } finally {
        clearTimeout(timer);
        try {
            if (!script.isDestroyed) await script.unload();
        } finally {
            if (!targetSession.isDetached()) await targetSession.detach();
        }
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
