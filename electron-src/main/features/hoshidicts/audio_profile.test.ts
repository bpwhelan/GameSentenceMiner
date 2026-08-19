import { describe, expect, it } from 'vitest';

import {
    defaultHoshidictsAudioProfile,
    normalizeHoshidictsAudioProfile,
} from './audio_profile.js';

function profileWithSource(source: Record<string, unknown>): unknown {
    return { sources: [source] };
}

describe('Hoshidicts audio profile', () => {
    it('uses an empty generic default profile', () => {
        expect(defaultHoshidictsAudioProfile()).toEqual({
            version: 1,
            autoPlay: false,
            sources: [],
        });
    });

    it('normalizes ordered custom and TTS sources while dropping retired fields', () => {
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
            autoPlay: true,
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

    it('drops unsupported source types without losing generic sources', () => {
        expect(
            normalizeHoshidictsAudioProfile({
                sources: [
                    { id: 'unsupported', type: 'wiktionary' },
                    {
                        id: 'direct',
                        type: 'custom',
                        url: 'https://audio.test/{term}.mp3',
                    },
                ],
            }).sources
        ).toEqual([
            {
                id: 'direct',
                type: 'custom',
                url: 'https://audio.test/{term}.mp3',
                voice: '',
            },
        ]);
    });

    it.each<[string, unknown, string]>([
        [
            'duplicate source id',
            {
                sources: [
                    {
                        id: 'same',
                        type: 'custom',
                        url: 'https://one.test/{term}.mp3',
                    },
                    {
                        id: 'same',
                        type: 'custom-json',
                        url: 'https://two.test/{term}',
                    },
                ],
            },
            'must be unique',
        ],
        [
            'unsafe source id',
            profileWithSource({
                id: '../escape',
                type: 'custom',
                url: 'https://audio.test/{term}.mp3',
            }),
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
            'unclosed URL placeholder',
            profileWithSource({
                id: 'local-audio',
                type: 'custom-json',
                url: 'http://127.0.0.1:5050/?term={term}&reading={reading',
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
