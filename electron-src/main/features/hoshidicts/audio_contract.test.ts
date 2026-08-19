import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createDefaultHoshidictsAudioProfile,
    HOSHIDICTS_AUDIO_SOURCE_TYPES,
} from '../../../shared/features/hoshidicts.js';
import { normalizeHoshidictsAudioProfile } from './audio_profile.js';

const GENERIC_SOURCE_TYPES = [
    'custom',
    'custom-json',
    'text-to-speech',
    'text-to-speech-reading',
] as const;

const AUDIO_PRODUCTION_FILES = [
    'electron-src/main/features/hoshidicts/audio_profile.ts',
    'electron-src/main/features/hoshidicts/audio_source_test.ts',
    'electron-src/renderer/src/features/hoshidicts/HoshidictsAudioPanel.tsx',
    'GSM_Overlay/features/hoshidicts/audio.js',
    'GSM_Overlay/features/hoshidicts/constants.js',
    'GSM_Overlay/features/hoshidicts/desktop_bridge.js',
    'GSM_Overlay/features/hoshidicts/reader.js',
    'GameSentenceMiner/hoshidicts_audio_profile.py',
    'GameSentenceMiner/hoshidicts_audio.py',
    'GameSentenceMiner/hoshidicts_mining.py',
] as const;

const RETIRED_PROFILE_REFERENCE_CHECKS = [
    {
        path: 'electron-src/main/features/hoshidicts/audio_profile.ts',
        pattern: /\b(?:enabled|volume)\b/u,
    },
    {
        path: 'electron-src/renderer/src/features/hoshidicts/HoshidictsAudioPanel.tsx',
        pattern:
            /hoshidicts-audio-(?:enabled|volume)|audioDraft\.(?:enabled|volume)|(?:audio|utterance)\.volume/u,
    },
    {
        path: 'GSM_Overlay/features/hoshidicts/desktop_bridge.js',
        pattern: /source\.(?:enabled|volume)|BOUNDS\.audioVolume/u,
    },
    {
        path: 'GSM_Overlay/features/hoshidicts/audio.js',
        pattern:
            /preferences\.(?:enabled|volume)|profile\.(?:enabled|volume)|(?:audio|utterance)\.volume|\b(?:enabled|volume):\s*(?:true|100)/u,
    },
    {
        path: 'GSM_Overlay/features/hoshidicts/constants.js',
        pattern: /audioVolume/u,
    },
    {
        path: 'GSM_Overlay/features/hoshidicts/reader.js',
        pattern: /normalized\.(?:enabled|volume)/u,
    },
    {
        path: 'GameSentenceMiner/hoshidicts_audio_profile.py',
        pattern: /["'](?:enabled|volume)["']/u,
    },
    {
        path: 'GameSentenceMiner/hoshidicts_audio.py',
        pattern: /(?:normalized_)?profile\["enabled"\]/u,
    },
    {
        path: 'GameSentenceMiner/hoshidicts_mining.py',
        pattern:
            /load_hoshidicts_audio_profile_or_default\(\)[\s\S]{0,300}profile\["enabled"\]/u,
    },
] as const;

const AUDIO_LOCALE_FILES = ['en.json', 'ja.json', 'ukr.json'] as const;
const RETIRED_PROVIDER_PATTERN =
    /jpod101|language-pod-101|japanese\s*pod\s*101|language\s*pod\s*101|jisho/iu;

describe('generic Hoshidicts pronunciation audio contract', () => {
    it('uses only generic URL/JSON and local TTS source types', () => {
        expect(HOSHIDICTS_AUDIO_SOURCE_TYPES).toEqual(GENERIC_SOURCE_TYPES);
        expect(createDefaultHoshidictsAudioProfile()).toEqual({
            version: 1,
            autoPlay: false,
            sources: [],
        });
    });

    it('ignores retired enable and volume keys in saved profiles', () => {
        expect(
            normalizeHoshidictsAudioProfile({
                version: 1,
                enabled: false,
                volume: 7,
                autoPlay: true,
                sources: [
                    {
                        id: 'fast-audio',
                        type: 'custom-json',
                        url: ' http://127.0.0.1:5050/?term={term}&reading={reading} ',
                    },
                    {
                        id: 'reading-tts',
                        type: 'text-to-speech-reading',
                        voice: ' Japanese Voice ',
                    },
                ],
            })
        ).toEqual({
            version: 1,
            autoPlay: true,
            sources: [
                {
                    id: 'fast-audio',
                    type: 'custom-json',
                    url: 'http://127.0.0.1:5050/?term={term}&reading={reading}',
                    voice: '',
                },
                {
                    id: 'reading-tts',
                    type: 'text-to-speech-reading',
                    url: '',
                    voice: 'Japanese Voice',
                },
            ],
        });
    });

    it('drops retired named-provider sources while preserving generic sources', () => {
        expect(
            normalizeHoshidictsAudioProfile({
                sources: [
                    { id: 'legacy-jpod', type: 'jpod101' },
                    { id: 'legacy-language-pod', type: 'language-pod-101' },
                    { id: 'legacy-jisho', type: 'jisho' },
                    {
                        id: 'fast-audio',
                        type: 'custom-json',
                        url: 'http://127.0.0.1:5050/',
                    },
                ],
            }).sources
        ).toEqual([
            {
                id: 'fast-audio',
                type: 'custom-json',
                url: 'http://127.0.0.1:5050/',
                voice: '',
            },
        ]);
    });

    it('contains no named-provider branches or audio labels in production', () => {
        const productionOffenders = AUDIO_PRODUCTION_FILES.filter((path) =>
            RETIRED_PROVIDER_PATTERN.test(
                readFileSync(resolve(process.cwd(), path), 'utf8')
            )
        );
        expect(productionOffenders).toEqual([]);

        const localeOffenders: string[] = [];
        for (const fileName of AUDIO_LOCALE_FILES) {
            const raw = readFileSync(
                resolve(
                    process.cwd(),
                    'electron-src/renderer/src/i18n',
                    fileName
                ),
                'utf8'
            ).replace(/^\uFEFF/u, '');
            const locale = JSON.parse(raw) as {
                settings: { hoshidicts: { audio: unknown } };
            };
            if (
                RETIRED_PROVIDER_PATTERN.test(
                    JSON.stringify(locale.settings.hoshidicts.audio)
                )
            ) {
                localeOffenders.push(fileName);
            }
        }
        expect(localeOffenders).toEqual([]);
    });

    it('contains no retired enable or volume profile references', () => {
        const productionOffenders = RETIRED_PROFILE_REFERENCE_CHECKS.filter(
            ({ path, pattern }) =>
                pattern.test(readFileSync(resolve(process.cwd(), path), 'utf8'))
        ).map(({ path }) => path);
        expect(productionOffenders).toEqual([]);

        const localeOffenders: string[] = [];
        for (const fileName of AUDIO_LOCALE_FILES) {
            const raw = readFileSync(
                resolve(
                    process.cwd(),
                    'electron-src/renderer/src/i18n',
                    fileName
                ),
                'utf8'
            ).replace(/^\uFEFF/u, '');
            const locale = JSON.parse(raw) as {
                settings: {
                    hoshidicts: { audio: Record<string, unknown> };
                };
            };
            const retiredKeys = ['enabled', 'enabledHint', 'volume'].filter(
                (key) => key in locale.settings.hoshidicts.audio
            );
            if (retiredKeys.length > 0) {
                localeOffenders.push(`${fileName}: ${retiredKeys.join(', ')}`);
            }
        }
        expect(localeOffenders).toEqual([]);
    });
});
