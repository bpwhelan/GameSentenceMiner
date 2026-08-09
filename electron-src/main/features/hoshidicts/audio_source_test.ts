import { getConfiguredSinglePort } from '../../gsm_config.js';
import type { HoshidictsAudioSourceTestMedia } from '../../../shared/features/hoshidicts.js';

const TEST_TERM = '聞く';
const TEST_READING = 'きく';
const MAX_CANDIDATES = 32;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const CANDIDATE_ID_PATTERN = /^[a-f0-9]{64}$/u;

interface AudioCandidate {
    index: number;
    name: string;
    candidateId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function candidatesFrom(value: unknown): AudioCandidate[] | null {
    if (
        !isRecord(value) ||
        !Array.isArray(value.candidates) ||
        value.candidates.length > MAX_CANDIDATES
    ) {
        return null;
    }
    const candidates = value.candidates.filter(
        (candidate): candidate is AudioCandidate =>
            isRecord(candidate) &&
            Number.isInteger(candidate.index) &&
            (candidate.index as number) >= 0 &&
            typeof candidate.name === 'string' &&
            typeof candidate.candidateId === 'string' &&
            CANDIDATE_ID_PATTERN.test(candidate.candidateId)
    );
    return candidates.length === value.candidates.length ? candidates : null;
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
    const signal = AbortSignal.timeout(8_000);
    const request = { term: TEST_TERM, reading: TEST_READING, sourceId };
    const discovery = await post(
        '/api/hoshidicts/audio/candidates',
        request,
        signal
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
    const candidates = candidatesFrom(payload);
    if (!candidates) {
        throw new Error('GSM returned an invalid audio candidate response.');
    }
    if (candidates.length === 0) {
        throw new Error(`No pronunciation audio was found for ${TEST_TERM}（${TEST_READING}）.`);
    }

    let lastProviderError = '';
    for (const candidate of candidates) {
        const media = await post(
            '/api/hoshidicts/audio/media',
            {
                ...request,
                candidateIndex: candidate.index,
                candidateId: candidate.candidateId,
            },
            signal
        );
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
            .toLowerCase();
        const declaredSize = Number(media.headers.get('content-length'));
        if (
            !contentType.startsWith('audio/') ||
            (Number.isFinite(declaredSize) && declaredSize > MAX_AUDIO_BYTES)
        ) {
            continue;
        }
        const bytes = new Uint8Array(await media.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
            continue;
        }
        return {
            bytes,
            contentType,
            candidateName: candidate.name,
        };
    }

    throw new Error(
        lastProviderError ||
            `The source did not return playable audio for ${TEST_TERM}（${TEST_READING}）.`
    );
}
