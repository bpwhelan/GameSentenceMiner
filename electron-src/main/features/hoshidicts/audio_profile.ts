import {
    createDefaultHoshidictsAudioProfile,
    isHoshidictsAudioSourceType,
    MAX_HOSHIDICTS_AUDIO_SOURCES,
    type HoshidictsAudioProfile,
    type HoshidictsAudioSource,
    type HoshidictsAudioSourceType,
} from '../../../shared/features/hoshidicts.js';

export const HOSHIDICTS_AUDIO_PROFILE_FILE_NAME = 'audio-profile.json';
const AUDIO_PROFILE_VERSION = 1;
const MAX_SOURCE_ID_LENGTH = 128;
const MAX_SOURCE_URL_LENGTH = 4096;
const MAX_VOICE_ID_LENGTH = 255;
const SAFE_SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

const URL_SOURCE_TYPES: ReadonlySet<HoshidictsAudioSourceType> = new Set([
    'custom',
    'custom-json',
]);

const TTS_SOURCE_TYPES: ReadonlySet<HoshidictsAudioSourceType> = new Set([
    'text-to-speech',
    'text-to-speech-reading',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBoolean(
    value: unknown,
    fallback: boolean,
    label: string
): boolean {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${label} is invalid.`);
    }
    return value;
}

function normalizeString(value: unknown, maximumLength: number, label: string): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (
        typeof value !== 'string' ||
        value.length > maximumLength ||
        value.includes('\0')
    ) {
        throw new Error(`${label} is invalid.`);
    }
    return value.trim();
}

function normalizeSourceId(value: unknown): string {
    const id = normalizeString(
        value,
        MAX_SOURCE_ID_LENGTH,
        'Hoshidicts audio source id'
    );
    if (!id || !SAFE_SOURCE_ID_PATTERN.test(id)) {
        throw new Error('Hoshidicts audio source id is invalid.');
    }
    return id;
}

function normalizeCustomSourceUrl(value: unknown): string {
    const url = normalizeString(
        value,
        MAX_SOURCE_URL_LENGTH,
        'Hoshidicts audio source URL'
    );
    if (!url) {
        return '';
    }
    const withoutPlaceholders = url.replace(/\{[^{}]*\}/gu, '');
    if (withoutPlaceholders.includes('{') || withoutPlaceholders.includes('}')) {
        throw new Error('Hoshidicts custom audio source URL is invalid.');
    }
    try {
        const parsed = new URL(url);
        if (
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username.length > 0 ||
            parsed.password.length > 0 ||
            parsed.hostname.length === 0
        ) {
            throw new Error('invalid');
        }
    } catch {
        throw new Error('Hoshidicts custom audio source URL is invalid.');
    }
    return url;
}

function normalizeAudioSource(value: unknown): HoshidictsAudioSource | null {
    if (!isRecord(value)) {
        throw new Error('Hoshidicts audio source must be an object.');
    }
    if (!isHoshidictsAudioSourceType(value.type)) {
        return null;
    }
    const type = value.type;
    const id = normalizeSourceId(value.id);
    const rawUrl = normalizeString(
        value.url,
        MAX_SOURCE_URL_LENGTH,
        'Hoshidicts audio source URL'
    );
    const rawVoice = normalizeString(
        value.voice,
        MAX_VOICE_ID_LENGTH,
        'Hoshidicts audio voice'
    );

    if (URL_SOURCE_TYPES.has(type)) {
        if (rawVoice) {
            throw new Error('Hoshidicts custom audio sources cannot specify a voice.');
        }
        return { id, type, url: normalizeCustomSourceUrl(rawUrl), voice: '' };
    }
    if (TTS_SOURCE_TYPES.has(type)) {
        if (rawUrl) {
            throw new Error('Hoshidicts text-to-speech sources cannot specify a URL.');
        }
        return { id, type, url: '', voice: rawVoice };
    }
    throw new Error('Hoshidicts audio source type is invalid.');
}

export function defaultHoshidictsAudioProfile(): HoshidictsAudioProfile {
    return createDefaultHoshidictsAudioProfile();
}

export function normalizeHoshidictsAudioProfile(
    value: unknown
): HoshidictsAudioProfile {
    if (!isRecord(value)) {
        throw new Error('Hoshidicts audio profile must be an object.');
    }
    if (
        value.version !== undefined &&
        value.version !== AUDIO_PROFILE_VERSION
    ) {
        throw new Error('Hoshidicts audio profile version is unsupported.');
    }
    const rawSources = value.sources ?? defaultHoshidictsAudioProfile().sources;
    if (
        !Array.isArray(rawSources) ||
        rawSources.length > MAX_HOSHIDICTS_AUDIO_SOURCES
    ) {
        throw new Error('Hoshidicts audio sources are invalid.');
    }
    const sourceIds = new Set<string>();
    const sources: HoshidictsAudioSource[] = [];
    for (const source of rawSources) {
        const normalized = normalizeAudioSource(source);
        if (normalized === null) {
            continue;
        }
        if (sourceIds.has(normalized.id)) {
            throw new Error('Hoshidicts audio source ids must be unique.');
        }
        sourceIds.add(normalized.id);
        sources.push(normalized);
    }

    return {
        version: AUDIO_PROFILE_VERSION,
        autoPlay: normalizeBoolean(
            value.autoPlay,
            false,
            'Hoshidicts audio autoplay setting'
        ),
        sources,
    };
}
