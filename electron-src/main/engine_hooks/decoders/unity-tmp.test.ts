import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadEngineHookSupport, parseEngineHookManifest } from '../support.js';
import type { EngineHookUnityTmpManifest } from './unity-tmp.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const aokanaDirectory = path.resolve(
    currentDirectory,
    '../../../assets/engine_hooks/aokana-steam',
);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schema: 'gsm_engine_hook_manifest_v1',
        id: 'fixture-unity',
        name: 'Fixture',
        engine: 'Unity + TextMeshPro',
        decoder: 'unity-tmp-v1',
        target: {
            platform: 'windows',
            architecture: 'ia32',
            executableNames: ['Fixture.exe'],
        },
        coordinateSpace: { provider: 'payload-client-pixels' },
        payload: 'payload.js',
        mono: {
            dialogue: {
                assembly: 'Assembly-CSharp',
                namespace: '',
                class: 'UIAdv',
                method: 'ShowText',
                parameterCount: 3,
                textComponentField: 'advtext',
                updateOnlyArgumentIndex: 3,
            },
            layout: {
                assembly: 'Unity.TextMeshPro',
                namespace: 'TMPro',
                class: 'TextMeshProUGUI',
                method: 'GenerateTextMesh',
                parameterCount: 0,
            },
        },
        capture: { acceptedModes: [0], maximumGlyphs: 600 },
        advance: { method: 'foreground-key', virtualKey: 13, scanCode: 28 },
        display: { details: { en: 'Fixture' } },
        ...overrides,
    };
}

function withMono(change: (mono: Record<string, any>) => void): Record<string, unknown> {
    const value = manifest();
    change(value.mono as Record<string, any>);
    return value;
}

describe('Unity TextMeshPro manifest', () => {
    it('accepts a manifest that names every managed member the payload resolves', () => {
        const parsed = parseEngineHookManifest(manifest()) as EngineHookUnityTmpManifest;

        expect(parsed.decoder).toBe('unity-tmp-v1');
        expect(parsed.mono.dialogue.class).toBe('UIAdv');
        expect(parsed.mono.dialogue.namespace).toBe('');
        expect(parsed.mono.layout.method).toBe('GenerateTextMesh');
        expect(parsed.capture).toEqual({ acceptedModes: [0], maximumGlyphs: 600 });
    });

    it('needs no module name, because Unity renames the Mono runtime by version', () => {
        // `mono.dll` through Unity 2019, `mono-2.0-bdwgc.dll` since 2020. A package
        // covering both cannot name one, so the payload finds the runtime by the
        // embedding API it exports.
        const parsed = parseEngineHookManifest(manifest()) as EngineHookUnityTmpManifest;

        expect(parsed.target.moduleName).toBeUndefined();
    });

    it('rejects a coordinate space the payload does not produce', () => {
        expect(() =>
            parseEngineHookManifest(
                manifest({
                    coordinateSpace: {
                        provider: 'window-client-over-design-space',
                        designWidth: 1920,
                        designHeight: 1080,
                    },
                }),
            ),
        ).toThrow(/must be payload-client-pixels/u);
    });

    it('rejects an update-only flag that is not one of the declared parameters', () => {
        expect(() =>
            parseEngineHookManifest(
                withMono((mono) => {
                    mono.dialogue.updateOnlyArgumentIndex = 4;
                }),
            ),
        ).toThrow(/must address a declared parameter/u);

        // Slot zero is the managed `this` pointer, never a flag.
        expect(() =>
            parseEngineHookManifest(
                withMono((mono) => {
                    mono.dialogue.updateOnlyArgumentIndex = 0;
                }),
            ),
        ).toThrow(/must address a declared parameter/u);
    });

    it('requires the field that names the text component', () => {
        expect(() =>
            parseEngineHookManifest(
                withMono((mono) => {
                    delete mono.dialogue.textComponentField;
                }),
            ),
        ).toThrow(/mono.dialogue.textComponentField/u);
    });

    it('requires the layout member so cells are read only once they are final', () => {
        expect(() =>
            parseEngineHookManifest(
                withMono((mono) => {
                    delete mono.layout;
                }),
            ),
        ).toThrow(/mono.layout must be an object/u);
    });

    it('bounds the glyph budget the payload is allowed to send', () => {
        expect(() =>
            parseEngineHookManifest(manifest({ capture: { acceptedModes: [0], maximumGlyphs: 5000 } })),
        ).toThrow(/capture.maximumGlyphs/u);
    });

    it('loads the checked-in Aokana package, which covers all three shipped builds', () => {
        const support = loadEngineHookSupport(aokanaDirectory);
        const parsed = support.manifest as EngineHookUnityTmpManifest;

        expect(parsed.id).toBe('aokana-steam');
        expect(parsed.decoder).toBe('unity-tmp-v1');
        expect(parsed.target.executableNames).toEqual([
            'Aokana.exe',
            'AokanaEXTRA1.exe',
            'AokanaEXTRA2.exe',
        ]);
        expect(parsed.target.knownExecutableSha256).toEqual([
            '9c6a938189d4e18dfdbd1891204e35d7b3ed1f8325f24386d354b5838721eb91',
            '30ac46318f2f92885fa5387abaec04b563f229a094acd21eb0caea7052b83c46',
            '1ca61a5859818360326a0f7988bc9f65e3e0e2925cdee91b4ec7ba7ceb71ac77',
        ]);
        expect(parsed.mono.dialogue.textComponentField).toBe('advtext');
        expect(support.resources).toBeUndefined();
        expect(support.payloadSource).toContain('gsm_engine_hook_message_v1');
    });
});
