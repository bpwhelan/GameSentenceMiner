import { getConfiguredSinglePort } from '../../gsm_config.js';
import type { HoshidictsAudioSourceTestMedia } from '../../../shared/features/hoshidicts.js';

const TEST_TERM = '聞く';
const TEST_READING = 'きく';
const TEST_REQUEST_TIMEOUT_MS = 12_000;
interface AudioCandidate {
    index: number;
    name: string;
    candidateId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function providerError(
    response: Response,
    fallback: string
): Promise<string> {
    try {
        const payload: unknown = await response.json();
        if (isRecord(payload) && typeof payload.error === 'string') {
            return payload.error;
        }
    } catch {
        // Use the HTTP status fallback below.
    }
    return `${fallback} (HTTP ${response.status}).`;
}

async function post(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal
): Promise<Response> {
    return await fetch(
        `http://127.0.0.1:${getConfiguredSinglePort()}${path}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        }
    );
}

export async function fetchHoshidictsAudioSourceTest(
    sourceId: string
): Promise<HoshidictsAudioSourceTestMedia> {
    const request = { term: TEST_TERM, reading: TEST_READING, sourceId };
    const discovery = await post(
        '/api/hoshidicts/audio/candidates',
        request,
        AbortSignal.timeout(TEST_REQUEST_TIMEOUT_MS)
    );
    if (!discovery.ok) {
        throw new Error(await providerError(discovery, 'Audio discovery failed'));
    }

    let payload: unknown = null;
    try {
        payload = await discovery.json();
    } catch {
        // Report the same response-shape error as malformed JSON.
    }
    // GSM's own Python built this list, including the candidate id digests.
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
        throw new Error('GSM returned an invalid audio candidate response.');
    }
    const candidates = payload.candidates as AudioCandidate[];
    if (candidates.length === 0) {
        throw new Error(`No pronunciation audio was found for ${TEST_TERM}（${TEST_READING}）.`);
    }

    let lastProviderError = '';
    for (const candidate of candidates) {
        const signal = AbortSignal.timeout(TEST_REQUEST_TIMEOUT_MS);
        let media: Response;
        try {
            media = await post(
                '/api/hoshidicts/audio/media',
                {
                    ...request,
                    candidateIndex: candidate.index,
                    candidateId: candidate.candidateId,
                },
                signal
            );
        } catch (error) {
            lastProviderError = errorMessage(error);
            continue;
        }
        if (!media.ok) {
            lastProviderError = await providerError(
                media,
                'Audio download failed'
            );
            continue;
        }
        const contentType = (media.headers.get('content-type') ?? '')
            .split(';', 1)[0]
            .trim()
            .toLowerCase() || 'application/octet-stream';
        let bytes: Uint8Array;
        try {
            bytes = new Uint8Array(await media.arrayBuffer());
        } catch (error) {
            lastProviderError = errorMessage(error);
            continue;
        }
        return {
            bytes,
            contentType,
            candidateName: candidate.name.trim() || 'Default',
        };
    }

    throw new Error(
        lastProviderError ||
            `The source did not return playable audio for ${TEST_TERM}（${TEST_READING}）.`
    );
}
