import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../gsm_config.js', () => ({
    getConfiguredSinglePort: () => 8123,
}));

import { fetchHoshidictsAudioSourceTest } from './audio_source_test.js';

const FIRST_CANDIDATE_ID = 'a'.repeat(64);
const SECOND_CANDIDATE_ID = 'b'.repeat(64);

function jsonResponse(value: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(value), {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...init?.headers,
        },
    });
}

describe('Hoshidicts audio source test proxy', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses kiku and tries candidates in order until playable audio is returned', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    candidates: [
                        {
                            index: 0,
                            name: 'first recording',
                            candidateId: FIRST_CANDIDATE_ID,
                        },
                        {
                            index: 1,
                            name: 'working recording',
                            candidateId: SECOND_CANDIDATE_ID,
                        },
                    ],
                })
            )
            .mockResolvedValueOnce(
                jsonResponse(
                    { error: 'The first recording is unavailable.' },
                    { status: 404 }
                )
            )
            .mockResolvedValueOnce(
                new Response(Uint8Array.from([1, 2, 3, 4]), {
                    headers: { 'content-type': 'audio/mpeg' },
                })
            );
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchHoshidictsAudioSourceTest('custom-source')
        ).resolves.toEqual({
            bytes: Uint8Array.from([1, 2, 3, 4]),
            contentType: 'audio/mpeg',
            candidateName: 'working recording',
        });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        const [candidateUrl, candidateOptions] = fetchMock.mock.calls[0];
        expect(candidateUrl).toBe(
            'http://127.0.0.1:8123/api/hoshidicts/audio/candidates'
        );
        expect(candidateOptions).toMatchObject({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(JSON.parse(String(candidateOptions?.body))).toEqual({
            term: '聞く',
            reading: 'きく',
            sourceId: 'custom-source',
        });

        const mediaRequests = fetchMock.mock.calls.slice(1).map(([, options]) =>
            JSON.parse(String(options?.body))
        );
        expect(mediaRequests).toEqual([
            {
                term: '聞く',
                reading: 'きく',
                sourceId: 'custom-source',
                candidateIndex: 0,
                candidateId: FIRST_CANDIDATE_ID,
            },
            {
                term: '聞く',
                reading: 'きく',
                sourceId: 'custom-source',
                candidateIndex: 1,
                candidateId: SECOND_CANDIDATE_ID,
            },
        ]);
    });

    it('continues to the next candidate after a timed-out media request', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    candidates: [
                        {
                            index: 0,
                            name: 'offline recording',
                            candidateId: FIRST_CANDIDATE_ID,
                        },
                        {
                            index: 1,
                            name: 'working recording',
                            candidateId: SECOND_CANDIDATE_ID,
                        },
                    ],
                })
            )
            .mockRejectedValueOnce(new Error('connection reset'))
            .mockResolvedValueOnce(
                new Response(Uint8Array.from([5, 6, 7]), {
                    headers: { 'content-type': 'audio/ogg' },
                })
            );
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('AbortSignal', {
            timeout: () => ({ aborted: true }),
        });

        await expect(
            fetchHoshidictsAudioSourceTest('custom-source')
        ).resolves.toEqual({
            bytes: Uint8Array.from([5, 6, 7]),
            contentType: 'audio/ogg',
            candidateName: 'working recording',
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('rejects a response without a candidate list', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse({ candidates: 'recording' }))
        );

        await expect(
            fetchHoshidictsAudioSourceTest('custom-source')
        ).rejects.toThrow('invalid audio candidate response');
    });

    it('returns provider bytes without MIME, declared-size, or empty-body validation', async () => {
        const bytes = new Uint8Array();
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                jsonResponse({
                    candidates: [
                        {
                            index: 0,
                            name: '',
                            candidateId: FIRST_CANDIDATE_ID,
                        },
                    ],
                })
            )
            .mockResolvedValueOnce(
                new Response(bytes, {
                    headers: {
                        'content-type': 'text/html',
                        'content-length': String(16 * 1024 * 1024 + 1),
                    },
                })
            );
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchHoshidictsAudioSourceTest('custom-source')
        ).resolves.toEqual({
            bytes,
            contentType: 'text/html',
            candidateName: '',
        });
    });

    it('tries every returned candidate without a source-test attempt cap', async () => {
        const candidates = Array.from({ length: 33 }, (_value, index) => ({
            index,
            name: `Recording ${index}`,
            candidateId: index.toString(16).padStart(64, '0'),
        }));
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({ candidates }));
        for (let index = 0; index < 32; index += 1) {
            fetchMock.mockResolvedValueOnce(
                jsonResponse({ error: 'unavailable' }, { status: 404 })
            );
        }
        fetchMock.mockResolvedValueOnce(
            new Response(Uint8Array.from([33]), {
                headers: { 'content-type': 'audio/mpeg' },
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchHoshidictsAudioSourceTest('custom-source')
        ).resolves.toEqual({
            bytes: Uint8Array.from([33]),
            contentType: 'audio/mpeg',
            candidateName: 'Recording 32',
        });
        expect(fetchMock).toHaveBeenCalledTimes(34);
    });

    it('reports when discovery returns no candidates', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse({ candidates: [] }))
        );

        await expect(
            fetchHoshidictsAudioSourceTest('custom-source')
        ).rejects.toThrow('聞く（きく）');
    });
});
