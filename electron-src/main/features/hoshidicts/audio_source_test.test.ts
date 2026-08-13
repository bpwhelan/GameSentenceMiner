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

    it('continues to the next candidate after a media transport failure', async () => {
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
            fetchHoshidictsAudioSourceTest('jisho')
        ).rejects.toThrow('invalid audio candidate response');
    });

    it('rejects empty and non-audio media after exhausting the candidates', async () => {
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
                new Response('<html>not audio</html>', {
                    headers: { 'content-type': 'text/html' },
                })
            );
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchHoshidictsAudioSourceTest('jisho')
        ).rejects.toThrow('playable audio');
    });

    it('reports when discovery returns no candidates', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse({ candidates: [] }))
        );

        await expect(
            fetchHoshidictsAudioSourceTest('jisho')
        ).rejects.toThrow('聞く（きく）');
    });
});
