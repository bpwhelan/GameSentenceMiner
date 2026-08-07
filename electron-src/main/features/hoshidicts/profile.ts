import type {
    HoshidictsMiningFieldName,
    HoshidictsMiningProfile,
} from '../../../shared/features/hoshidicts.js';

export const HOSHIDICTS_MINING_PROFILE_FILE_NAME = 'mining-profile.json';
const MINING_PROFILE_VERSION = 1;

const MINING_FIELD_NAMES: readonly HoshidictsMiningFieldName[] = [
    'expression',
    'reading',
    'definition',
    'sentence',
    'frequency',
    'pitch',
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProfileString(
    value: unknown,
    label: string,
    fallback = ''
): string {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (
        typeof value !== 'string' ||
        value.length > 255 ||
        value.includes('\0')
    ) {
        throw new Error(`${label} is invalid.`);
    }
    return value.trim();
}

export function defaultHoshidictsMiningProfile(): HoshidictsMiningProfile {
    return {
        version: MINING_PROFILE_VERSION,
        enabled: true,
        deck: 'Default',
        model: '',
        fields: {
            expression: '',
            reading: '',
            definition: '',
            sentence: '',
            frequency: '',
            pitch: '',
        },
        disabledFields: [],
        tags: ['hoshidicts'],
        duplicatePolicy: 'prevent',
    };
}

export function normalizeHoshidictsMiningProfile(
    value: unknown
): HoshidictsMiningProfile {
    if (!isRecord(value)) {
        throw new Error('Hoshidicts mining profile must be an object.');
    }
    if (
        value.version !== undefined &&
        value.version !== MINING_PROFILE_VERSION
    ) {
        throw new Error('Hoshidicts mining profile version is unsupported.');
    }
    const rawFields = value.fields ?? {};
    if (!isRecord(rawFields)) {
        throw new Error('Hoshidicts mining fields must be an object.');
    }
    const rawTags = value.tags ?? ['hoshidicts'];
    if (!Array.isArray(rawTags) || rawTags.length > 32) {
        throw new Error('Hoshidicts mining tags are invalid.');
    }
    const tags: string[] = [];
    const seenTags = new Set<string>();
    for (const rawTag of rawTags) {
        const tag = normalizeProfileString(rawTag, 'Hoshidicts mining tag');
        const key = tag.toLocaleLowerCase();
        if (tag && !seenTags.has(key)) {
            seenTags.add(key);
            tags.push(tag);
        }
    }
    if (
        value.duplicatePolicy !== undefined &&
        value.duplicatePolicy !== 'prevent' &&
        value.duplicatePolicy !== 'allow'
    ) {
        throw new Error('Hoshidicts duplicate policy is invalid.');
    }
    const rawDisabledFields = value.disabledFields ?? [];
    if (!Array.isArray(rawDisabledFields)) {
        throw new Error('Hoshidicts disabled mining fields are invalid.');
    }
    const disabledFields: HoshidictsMiningFieldName[] = [];
    for (const rawField of rawDisabledFields) {
        if (
            typeof rawField !== 'string' ||
            !MINING_FIELD_NAMES.includes(
                rawField as HoshidictsMiningFieldName
            )
        ) {
            throw new Error('Hoshidicts disabled mining field is invalid.');
        }
        const field = rawField as HoshidictsMiningFieldName;
        if (!disabledFields.includes(field)) {
            disabledFields.push(field);
        }
    }

    return {
        version: MINING_PROFILE_VERSION,
        enabled: value.enabled !== false,
        deck:
            normalizeProfileString(
                value.deck,
                'Hoshidicts mining deck',
                'Default'
            ) || 'Default',
        model: normalizeProfileString(
            value.model,
            'Hoshidicts mining note type'
        ),
        fields: {
            expression: normalizeProfileString(
                rawFields.expression,
                'Hoshidicts expression field'
            ),
            reading: normalizeProfileString(
                rawFields.reading,
                'Hoshidicts reading field'
            ),
            definition: normalizeProfileString(
                rawFields.definition,
                'Hoshidicts definition field'
            ),
            sentence: normalizeProfileString(
                rawFields.sentence,
                'Hoshidicts sentence field'
            ),
            frequency: normalizeProfileString(
                rawFields.frequency,
                'Hoshidicts frequency field'
            ),
            pitch: normalizeProfileString(
                rawFields.pitch,
                'Hoshidicts pitch field'
            ),
        },
        disabledFields,
        tags,
        duplicatePolicy:
            value.duplicatePolicy === 'allow' ? 'allow' : 'prevent',
    };
}
