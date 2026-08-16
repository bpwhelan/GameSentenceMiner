import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { listEngineHookDecoderIds } from './decoders/index.js';
import type { EngineHookMagesManifest, MagesResources } from './decoders/mages.js';
import {
    executableContainsVersionMarkers,
    loadEngineHookCatalog,
    loadEngineHookSupport,
    parseEngineHookManifest,
    resolveEngineHookSupport,
    type EngineHookSupport,
} from './support.js';
import { decodeMagesLayout, type MagesPositionedCode } from './mages_decoder.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetDirectory = path.resolve(
    currentDirectory,
    '../../assets/engine_hooks/mages-steins-gate-steam',
);
const bgiDirectory = path.resolve(currentDirectory, '../../assets/engine_hooks/bgi-ethornell');
const catalogDirectory = path.dirname(assetDirectory);
const vlrAssetDirectory = path.resolve(
    currentDirectory,
    '../../assets/engine_hooks/vlr-zero-escape-vlr-steam',
);
const BGI_MARKER = 'Ethornell - BURIKO General Interpreter';
const FIXTURE_HASH = 'a'.repeat(64);

function magesManifest(support: EngineHookSupport): EngineHookMagesManifest {
    if (support.manifest.decoder !== 'mages-v1') throw new Error('Expected a MAGES support package.');
    return support.manifest as EngineHookMagesManifest;
}

function magesResources(support: EngineHookSupport): MagesResources {
    return support.resources as MagesResources;
}

function executableContaining(marker: string): Buffer {
    return Buffer.concat([Buffer.alloc(64, 0), Buffer.from(marker, 'utf16le'), Buffer.alloc(64, 0)]);
}

const temporaryCatalogs: string[] = [];

/**
 * Writes a throwaway catalog so ambiguity assertions describe the fixture rather
 * than however many packages the shipped catalog happens to contain.
 */
function fixtureCatalog(
    packages: { id: string; knownExecutableSha256?: string[] }[],
): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-engine-hooks-'));
    temporaryCatalogs.push(directory);
    for (const entry of packages) {
        const packageDirectory = path.join(directory, entry.id);
        fs.mkdirSync(packageDirectory);
        fs.writeFileSync(path.join(packageDirectory, 'payload.js'), '// gsm_engine_hook_message_v1\n');
        fs.writeFileSync(
            path.join(packageDirectory, 'manifest.json'),
            JSON.stringify({
                schema: 'gsm_engine_hook_manifest_v1',
                id: entry.id,
                name: entry.id,
                engine: 'fixture',
                decoder: 'bgi-v1',
                target: {
                    platform: 'windows',
                    architecture: 'ia32',
                    executableNames: [`${entry.id}.exe`],
                    ...(entry.knownExecutableSha256
                        ? { knownExecutableSha256: entry.knownExecutableSha256 }
                        : {}),
                },
                coordinateSpace: { provider: 'payload-client-pixels' },
                payload: 'payload.js',
                signatures: {
                    glyphDraw: '90',
                    textCapture: '90',
                    copyDispatcher: '90',
                    surfaceLock: '90',
                },
                advance: { method: 'foreground-key', virtualKey: 13, scanCode: 28 },
            }),
        );
    }
    return directory;
}

afterAll(() => {
    for (const directory of temporaryCatalogs) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

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
        expect(magesManifest(support).capture.acceptedModes).toEqual([0]);
        expect(magesManifest(support).resources.charsetOverrides).toBe('charset_overrides.json');
        expect(magesResources(support).charset.length).toBeGreaterThan(2000);
        expect(magesResources(support).compoundCharacters.get('\ue01f')).toBe('キタ');
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
        expect(support.resources).toBeUndefined();
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
                magesResources(support).charset,
                magesResources(support).compoundCharacters,
            ).text,
        ).toBe('日曰褄棲凪風');
    });

    it('prefers an exact build and rejects unknown ambiguous architecture matches', () => {
        const directory = fixtureCatalog([
            { id: 'fixture-exact', knownExecutableSha256: [FIXTURE_HASH] },
            { id: 'fixture-open-a' },
            { id: 'fixture-open-b' },
        ]);

        expect(
            resolveEngineHookSupport(directory, {
                exeName: 'anything.exe',
                arch: 'x86',
                executableSha256: FIXTURE_HASH.toUpperCase(),
            }).manifest.id,
        ).toBe('fixture-exact');

        expect(() =>
            resolveEngineHookSupport(directory, {
                exeName: '45520.exe',
                arch: 'x86',
                executableSha256: '0'.repeat(64),
            }),
        ).toThrow(/found 2 matching support packages/u);

        expect(() =>
            resolveEngineHookSupport(directory, {
                exeName: '45520.exe',
                arch: 'x86',
            }),
        ).toThrow(/found 2 matching support packages/u);

        expect(() =>
            resolveEngineHookSupport(directory, { exeName: '45520.exe', arch: 'x64' }),
        ).toThrow(/no matching support packages were found/u);
    });

    it('loads the checked-in BGI package, which carries no charset resources', () => {
        const support = loadEngineHookSupport(bgiDirectory);

        expect(support.manifest.decoder).toBe('bgi-v1');
        expect(support.manifest.coordinateSpace).toEqual({ provider: 'payload-client-pixels' });
        expect(support.manifest.target.versionMarkers).toEqual([BGI_MARKER]);
        expect(support.manifest.target.executableNames).toBeUndefined();
        expect(support.resources).toBeUndefined();
        expect(support.payloadSource).toContain('gsm_engine_hook_message_v1');
    });

    it('resolves an engine whose games each rename the executable, by version marker', () => {
        expect(
            resolveEngineHookSupport(catalogDirectory, {
                exeName: '放課後シンデレラ２.exe',
                arch: 'x86',
                executableContents: executableContaining(BGI_MARKER),
            }).manifest.id,
        ).toBe('bgi-ethornell');

        // An executable without the marker must not fall through to the engine-wide
        // package just because it is the one package with no build hash to
        // disqualify it. It is excluded, leaving the remaining packages to be
        // resolved on their own terms.
        expect(() =>
            resolveEngineHookSupport(catalogDirectory, {
                exeName: 'jeweha.exe',
                arch: 'x86',
                executableContents: executableContaining('Some Other Engine'),
            }),
        ).toThrow(/No unambiguous engine-hook support/u);
    });

    it('matches version markers as UTF-16, the encoding a version resource stores', () => {
        expect(executableContainsVersionMarkers(executableContaining(BGI_MARKER), [BGI_MARKER])).toBe(
            true,
        );
        expect(
            executableContainsVersionMarkers(Buffer.from(BGI_MARKER, 'utf8'), [BGI_MARKER]),
        ).toBe(false);
    });

    it('requires a BGI manifest to declare every signature the payload resolves', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(bgiDirectory, 'manifest.json'), 'utf8'),
        ) as { signatures: Record<string, unknown> };
        delete manifest.signatures.surfaceLock;

        expect(() => parseEngineHookManifest(manifest)).toThrow(
            /signatures\.surfaceLock must be a non-empty string/u,
        );
    });

    it('rejects a manifest that matches on neither a name nor a version marker', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(bgiDirectory, 'manifest.json'), 'utf8'),
        ) as { target: Record<string, unknown> };
        delete manifest.target.versionMarkers;

        expect(() => parseEngineHookManifest(manifest)).toThrow(
            /target must declare executableNames or versionMarkers/u,
        );
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

    it('rejects a manifest whose decoder is not registered', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(bgiDirectory, 'manifest.json'), 'utf8'),
        ) as Record<string, unknown>;
        manifest.decoder = 'not-an-engine-v1';

        expect(() => parseEngineHookManifest(manifest)).toThrow(/Unsupported engine-hook decoder/u);
    });
});

describe('shipped engine-hook catalog', () => {
    const catalog = loadEngineHookCatalog(catalogDirectory);

    it('ships at least one package', () => {
        expect(catalog.length).toBeGreaterThan(0);
    });

    it.each(catalog.map((support) => [support.manifest.id, support] as const))(
        '%s is loadable, decodable, and describes itself to the renderer',
        (_id, support) => {
            expect(listEngineHookDecoderIds()).toContain(support.manifest.decoder);
            expect(support.payloadSource).toContain('gsm_engine_hook_message_v1');
            expect(support.manifest.display?.details.en).toBeTruthy();
        },
    );

    it('gives every package a unique id', () => {
        const ids = catalog.map((support) => support.manifest.id);

        expect(new Set(ids).size).toBe(ids.length);
    });
});
