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
import { selectBgiLayout } from '../../dist/main/engine_hooks/bgi_decoder.js';
import { decodeVlrLayout } from '../../dist/main/engine_hooks/vlr_decoder.js';
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
    if (!executableName) {
        throw new Error('This package matches on its version resource; pass --pid=<number>.');
    }
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

async function bestEffortCleanup(operation, timeoutMs = 1500) {
    let timer;
    const operationPromise = Promise.resolve()
        .then(operation)
        .catch(() => undefined);
    await Promise.race([
        operationPromise,
        new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        }),
    ]);
    if (timer) clearTimeout(timer);
}

async function main() {
    const supportId = option('support') ?? 'mages-steins-gate-steam';
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(supportId)) {
        throw new Error('Support ids may contain lower-case letters, digits, and hyphens only.');
    }
    const supportDirectory = path.join(supportCatalogDirectory, supportId);
    const manifest = JSON.parse(fs.readFileSync(path.join(supportDirectory, 'manifest.json'), 'utf8'));
    const payload = fs.readFileSync(path.join(supportDirectory, manifest.payload), 'utf8');
    let charset;
    let compounds;
    if (manifest.decoder === 'mages-v1') {
        charset = fs.readFileSync(path.join(supportDirectory, manifest.resources.charset), 'utf8');
        compounds = parseMagesCompoundMap(
            fs.readFileSync(
                path.join(supportDirectory, manifest.resources.compoundCharacters),
                'utf8',
            ),
        );
    } else if (manifest.decoder !== 'vlr-v1' && manifest.decoder !== 'bgi-v1') {
        throw new Error(`The validation runner does not yet implement decoder ${manifest.decoder}.`);
    }
    const pid = await resolvePid(manifest.target.executableNames?.[0] ?? null);
    const timeoutMs = Number.parseInt(option('timeout') ?? '15000', 10);
    const wanted = Number.parseInt(option('lines') ?? '1', 10);
    const shouldAdvance = process.argv.includes('--advance');
    let seen = 0;

    const targetSession = await frida.attach(pid);
    const injectedSource = `globalThis.__GSM_ENGINE_HOOK_CONFIG__ = ${JSON.stringify(manifest)};\n${payload}`;
    const script = await targetSession.createScript(injectedSource, {
        name: `${manifest.id}-validation`,
        runtime: ScriptRuntime.QJS,
    });

    process.stdout.write(
        `${JSON.stringify({
            type: 'package',
            supportId: manifest.id,
            name: manifest.name,
            decoder: manifest.decoder,
            target: manifest.target,
        })}\n`,
    );

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
            const decoded =
                manifest.decoder === 'mages-v1'
                    ? decodeMagesLayout(payloadMessage.positionedCodes, charset, compounds)
                    : manifest.decoder === 'bgi-v1'
                      ? selectBgiLayout(payloadMessage.candidates ?? [], payloadMessage.positionedCodes)
                      : decodeVlrLayout(
                          payloadMessage.positionedCodes.map((positionedCode) => ({
                              ...positionedCode,
                              type: 1,
                          })),
                      );
            if (!decoded) {
                process.stderr.write(`unpaired: ${JSON.stringify(payloadMessage.candidates ?? [])}
`);
                return;
            }
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
            seen += 1;
            if (seen >= wanted) finish.resolve();
        } catch (error) {
            finish.reject(error);
        }
    });

    try {
        await script.load();
        await completed;
    } finally {
        clearTimeout(timer);
        await bestEffortCleanup(async () => {
            if (!script.isDestroyed) await script.unload();
        });
        await bestEffortCleanup(async () => {
            if (!targetSession.isDetached()) await targetSession.detach();
        });
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
