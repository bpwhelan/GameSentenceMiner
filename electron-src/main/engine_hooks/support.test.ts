import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    loadEngineHookSupport,
    parseEngineHookManifest,
    resolveEngineHookSupport,
} from './support.js';
import { decodeMagesLayout, type MagesPositionedCode } from './mages_decoder.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetDirectory = path.resolve(
    currentDirectory,
    '../../assets/engine_hooks/mages-steins-gate-steam',
);
const catalogDirectory = path.dirname(assetDirectory);
const supportedHash = 'cbbc5dab18edc344d05c01d4d08819fbc0a68a78741956831752986009b69e16';

describe('engine-hook support package', () => {
    it('loads and validates the checked-in STEINS;GATE package', () => {
        const support = loadEngineHookSupport(assetDirectory);

        expect(support.manifest.id).toBe('mages-steins-gate-steam');
        expect(support.manifest.decoder).toBe('mages-v1');
        expect(support.manifest.target.architecture).toBe('ia32');
        expect(support.manifest.coordinateSpace).toEqual({
            provider: 'window-client-over-memory-scale',
            scaleXRva: '0x121dc28',
            scaleYRva: '0x121dc2c',
        });
        expect(support.manifest.advance).toEqual({
            method: 'foreground-click',
            clientXRatio: 0.5,
            clientYRatio: 0.8,
        });
        expect(support.manifest.capture.acceptedModes).toEqual([0]);
        expect(support.manifest.resources.charsetOverrides).toBe('charset_overrides.json');
        expect(support.charset.length).toBeGreaterThan(2000);
        expect(support.compoundCharacters.get('\ue01f')).toBe('キタ');
        expect(support.payloadSource).toContain('gsm_engine_hook_message_v1');
    });

    it('uses the STEINS;GATE script character variants without changing legitimate kanji', () => {
        const support = loadEngineHookSupport(assetDirectory);
        const positionedCodes = [0x0301, 0x0729, 0x0a9e, 0x0aa9, 0x0afe, 0x051b].map(
            (code, engineIndex): MagesPositionedCode => ({
                engineIndex,
                code,
                x: engineIndex * 20,
                y: 0,
                width: 20,
                height: 30,
            }),
        );

        expect(
            decodeMagesLayout(
                positionedCodes,
                support.charset,
                support.compoundCharacters,
            ).text,
        ).toBe('日曰褄棲凪風');
    });

    it('resolves a support package by executable, architecture, and build hash', () => {
        expect(
            resolveEngineHookSupport(catalogDirectory, {
                exeName: 'game.EXE',
                arch: 'x86',
                executableSha256: supportedHash,
            }).manifest.id,
        ).toBe('mages-steins-gate-steam');

        expect(() =>
            resolveEngineHookSupport(catalogDirectory, {
                exeName: 'Game.exe',
                arch: 'x86',
                executableSha256: '0'.repeat(64),
            }),
        ).toThrow(/hash is not supported/u);

        expect(() =>
            resolveEngineHookSupport(catalogDirectory, {
                exeName: 'Game.exe',
                arch: 'x86',
            }),
        ).toThrow(/could not be verified/u);
    });

    it('rejects a manifest that attempts to configure a fixed coordinate space', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(assetDirectory, 'manifest.json'), 'utf8'),
        ) as Record<string, unknown>;
        manifest.coordinateSpace = { provider: 'fixed', width: 1920, height: 1080 };

        expect(() => parseEngineHookManifest(manifest)).toThrow(
            /coordinateSpace\.provider must be window-client-over-memory-scale/u,
        );
    });

    it('requires both live engine-scale addresses', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(assetDirectory, 'manifest.json'), 'utf8'),
        ) as { coordinateSpace: Record<string, unknown> };
        delete manifest.coordinateSpace.scaleYRva;

        expect(() => parseEngineHookManifest(manifest)).toThrow(
            /coordinateSpace\.scaleYRva must be a non-empty string/u,
        );
    });
});
