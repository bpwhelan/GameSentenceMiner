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
const vlrAssetDirectory = path.resolve(
    currentDirectory,
    '../../assets/engine_hooks/vlr-zero-escape-vlr-steam',
);
const supportedHash = 'cbbc5dab18edc344d05c01d4d08819fbc0a68a78741956831752986009b69e16';

describe('engine-hook support package', () => {
    it('parses the declarative VLR text-layout memory description', () => {
        const manifest = {
            schema: 'gsm_engine_hook_manifest_v1',
            id: 'vlr-zero-escape-vlr-steam',
            name: "Zero Escape: Virtue's Last Reward",
            engine: 'vlr',
            decoder: 'vlr-v1',
            target: {
                platform: 'windows',
                architecture: 'ia32',
                moduleName: 'ze2.exe',
                executableNames: ['ze2.exe'],
                knownExecutableSha256: ['b5250963fee0b6a24cd0b34ff61917ffec31343e1aff48f9218c38d4f3599c2a'],
            },
            coordinateSpace: {
                provider: 'window-client-over-design-space',
                designWidth: 960,
                designHeight: 540,
            },
            payload: 'payload.js',
            signatures: {
                textBuilder: '80 ?? ?? 74 ?? 8D ?? ?? 46 80 ?? ?? 75 ?? 8B ?? ?? 03',
                lineLayout: '55 8B EC 6A FF',
                alternativeLineLayout: '55 8B EC 6A FF 68 ?? ?? ?? ??',
            },
            memory: {
                kind: 'vlr-text-layout-v1',
                textObject: {
                    entriesOffset: '0x17c',
                    countOffset: '0x184',
                    glyphHeightOffset: '0x1dc',
                    maximumXOffset: '0x270',
                    maximumYOffset: '0x274',
                    originXOffset: '0x7c',
                    originYOffset: '0x80',
                },
                entry: {
                    stride: 32,
                    typeOffset: '0x0',
                    xOffset: '0x8',
                    yOffset: '0xc',
                    widthOffset: '0x10',
                    codeOffset: '0x14',
                    visibleType: 1,
                },
                maximumEntries: 512,
            },
            capture: { acceptedModes: [0], requiredTerminator: 'K-or-P' },
            advance: { method: 'foreground-click', clientXRatio: 0.5, clientYRatio: 0.8 },
        };

        expect(parseEngineHookManifest(manifest).decoder).toBe('vlr-v1');
    });

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

    it('loads the standalone VLR package with post-layout snapshots', () => {
        const support = loadEngineHookSupport(vlrAssetDirectory);

        expect(support.manifest).toMatchObject({
            id: 'vlr-zero-escape-vlr-steam',
            decoder: 'vlr-v1',
            target: {
                moduleName: 'ze2.exe',
                architecture: 'ia32',
            },
            coordinateSpace: {
                provider: 'window-client-over-design-space',
                designWidth: 960,
                designHeight: 540,
            },
        });
        if (support.manifest.decoder !== 'vlr-v1') throw new Error('Expected VLR manifest.');
        expect(support.manifest.signatures).not.toHaveProperty('glyphGeometry');
        expect(support.manifest.signatures).not.toHaveProperty('alternativeGlyphGeometry');
        expect(support.manifest.memory.textObject).toMatchObject({
            originXOffset: '0x7c',
            originYOffset: '0x80',
        });
        expect(support.manifest.memory.entry).toMatchObject({
            stride: 32,
            typeOffset: '0x0',
            xOffset: '0x8',
            yOffset: '0xc',
            widthOffset: '0x10',
            codeOffset: '0x14',
            visibleType: 1,
        });
        expect(support.charset).toBeUndefined();
        expect(support.payloadSource).not.toMatch(/require\(['"]agent/u);
        expect(support.payloadSource).not.toContain('attachGlyphGeometry');
        expect(support.payloadSource).toContain('snapshotGlyphs(this._gsmObject)');
        expect(support.payloadSource).toContain('readLayoutOrigin');
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

    it('prefers an exact build and rejects unknown ambiguous architecture matches', () => {
        expect(
            resolveEngineHookSupport(catalogDirectory, {
                exeName: 'game.EXE',
                arch: 'x86',
                executableSha256: supportedHash,
            }).manifest.id,
        ).toBe('mages-steins-gate-steam');

        expect(
            resolveEngineHookSupport(catalogDirectory, {
                exeName: 'ze2.exe',
                arch: 'x86',
                executableSha256:
                    'b5250963fee0b6a24cd0b34ff61917ffec31343e1aff48f9218c38d4f3599c2a',
            }).manifest.id,
        ).toBe('vlr-zero-escape-vlr-steam');

        expect(() =>
            resolveEngineHookSupport(catalogDirectory, {
                exeName: '45520.exe',
                arch: 'x86',
                executableSha256: '0'.repeat(64),
            }),
        ).toThrow(/found 2 matching support packages/u);

        expect(() =>
            resolveEngineHookSupport(catalogDirectory, {
                exeName: '45520.exe',
                arch: 'x86',
            }),
        ).toThrow(/found 2 matching support packages/u);
    });

    it('rejects a manifest that attempts to configure a fixed coordinate space', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(assetDirectory, 'manifest.json'), 'utf8'),
        ) as Record<string, unknown>;
        manifest.coordinateSpace = { provider: 'fixed', width: 1920, height: 1080 };

        expect(() => parseEngineHookManifest(manifest)).toThrow(
            /coordinateSpace\.provider must be window-client-over-memory-scale or window-client-over-design-space/u,
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
