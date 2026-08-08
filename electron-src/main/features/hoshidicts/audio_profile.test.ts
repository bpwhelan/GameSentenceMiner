import { describe, expect, it } from 'vitest';

import {
    defaultHoshidictsAudioProfile,
    normalizeHoshidictsAudioProfile,
} from './audio_profile.js';

function profileWithSource(source: Record<string, unknown>): unknown {
    return { sources: [source] };
}

describe('Hoshidicts audio profile', () => {
    it('uses the Japanese Yomitan-style defaults', () => {
        expect(defaultHoshidictsAudioProfile()).toEqual({
            version: 1,
            enabled: true,
            autoPlay: false,
            volume: 100,
            sources: [
                { id: 'jpod101', type: 'jpod101', url: '', voice: '' },
                {
                    id: 'language-pod-101',
                    type: 'language-pod-101',
                    url: '',
                    voice: '',
                },
                { id: 'jisho', type: 'jisho', url: '', voice: '' },
            ],
        });
    });

    it('normalizes ordered custom and TTS sources without losing placeholders', () => {
        expect(
            normalizeHoshidictsAudioProfile({
                enabled: false,
                autoPlay: true,
                volume: 35,
                sources: [
                    {
                        id: 'local-json',
                        type: 'custom-json',
                        url: ' http://127.0.0.1:8080/audio?term={term}&reading={reading} ',
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
            enabled: false,
            autoPlay: true,
            volume: 35,
            sources: [
                {
                    id: 'local-json',
                    type: 'custom-json',
                    url: 'http://127.0.0.1:8080/audio?term={term}&reading={reading}',
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

    it.each<[string, unknown, string]>([
        ['out-of-range volume', { volume: 101 }, 'volume is invalid'],
        ['non-boolean enabled flag', { enabled: 'yes' }, 'enabled setting is invalid'],
        [
            'unsupported source type',
            profileWithSource({ id: 'unknown', type: 'wiktionary' }),
            'source type is invalid',
        ],
        [
            'duplicate source id',
            {
                sources: [
                    { id: 'same', type: 'jisho' },
                    { id: 'same', type: 'jpod101' },
                ],
            },
            'must be unique',
        ],
        [
            'unsafe source id',
            profileWithSource({ id: '../escape', type: 'jisho' }),
            'source id is invalid',
        ],
        [
            'non-HTTP custom URL',
            profileWithSource({
                id: 'custom',
                type: 'custom',
                url: 'file:///tmp/audio.mp3',
            }),
            'custom audio source URL is invalid',
        ],
        [
            'authority template',
            profileWithSource({
                id: 'authority-template',
                type: 'custom',
                url: 'http://{term}/audio.mp3',
            }),
            'custom audio source URL is invalid',
        ],
        [
            'TTS URL',
            profileWithSource({
                id: 'tts',
                type: 'text-to-speech',
                url: 'https://example.invalid/audio',
            }),
            'cannot specify a URL',
        ],
    ])('rejects %s', (_name, input, message) => {
        expect(() => normalizeHoshidictsAudioProfile(input)).toThrow(message);
    });
});
