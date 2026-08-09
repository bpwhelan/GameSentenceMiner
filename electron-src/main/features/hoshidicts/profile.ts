import type {
    HoshidictsDuplicateBehavior,
    HoshidictsDuplicateScope,
    HoshidictsFieldOverwriteMode,
    HoshidictsFieldOverwriteModes,
    HoshidictsMiningFieldName,
    HoshidictsMiningFieldTemplates,
    HoshidictsMiningProfile,
} from '../../../shared/features/hoshidicts.js';
import {
    createDefaultHoshidictsFieldOverwriteModes,
    HOSHIDICTS_DUPLICATE_BEHAVIORS,
    HOSHIDICTS_DUPLICATE_SCOPES,
    HOSHIDICTS_FIELD_OVERWRITE_MODES,
} from '../../../shared/features/hoshidicts.js';

export const HOSHIDICTS_MINING_PROFILE_FILE_NAME = 'mining-profile.json';
const MINING_PROFILE_VERSION = 3;
const LEGACY_MINING_PROFILE_VERSIONS = [1, 2] as const;

const MINING_FIELD_NAMES: readonly HoshidictsMiningFieldName[] = [
    'expression',
    'reading',
    'definition',
    'sentence',
    'frequency',
    'pitch',
    'audio',
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

function normalizeFieldTemplates(
    value: unknown,
    sourceVersion: number
): HoshidictsMiningFieldTemplates | null {
    if (sourceVersion !== MINING_PROFILE_VERSION || value == null) {
        return null;
    }
    if (!isRecord(value)) {
        throw new Error('Hoshidicts mining field templates are invalid.');
    }
    const result: HoshidictsMiningFieldTemplates = {};
    for (const [fieldName, rawTemplate] of Object.entries(value)) {
        if (
            fieldName.length === 0 ||
            fieldName.length > 255 ||
            fieldName.includes('\0')
        ) {
            throw new Error('Hoshidicts mining field template name is invalid.');
        }
        if (!isRecord(rawTemplate) || typeof rawTemplate.value !== 'string') {
            throw new Error(
                `Hoshidicts ${fieldName} field template is invalid.`
            );
        }
        if (rawTemplate.value.includes('\0')) {
            throw new Error(
                `Hoshidicts ${fieldName} field template value is invalid.`
            );
        }
        const overwriteMode = rawTemplate.overwriteMode ?? 'coalesce';
        if (
            !HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
                overwriteMode as HoshidictsFieldOverwriteMode
            )
        ) {
            throw new Error(
                `Hoshidicts ${fieldName} field template overwrite mode is invalid.`
            );
        }
        result[fieldName] = {
            value: rawTemplate.value,
            overwriteMode: overwriteMode as HoshidictsFieldOverwriteMode,
        };
    }
    return result;
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
            audio: '',
        },
        disabledFields: [],
        tags: ['hoshidicts'],
        checkForDuplicates: true,
        duplicateScope: 'collection',
        duplicateScopeCheckAllModels: false,
        duplicateBehavior: 'prevent',
        fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes(),
        fieldTemplates: null,
    };
}

export function normalizeHoshidictsMiningProfile(
    value: unknown
): HoshidictsMiningProfile {
    if (!isRecord(value)) {
        throw new Error('Hoshidicts mining profile must be an object.');
    }
    const sourceVersion = value.version ?? 1;
    if (
        sourceVersion !== MINING_PROFILE_VERSION &&
        !LEGACY_MINING_PROFILE_VERSIONS.includes(
            sourceVersion as (typeof LEGACY_MINING_PROFILE_VERSIONS)[number]
        )
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
    if (
        value.checkForDuplicates !== undefined &&
        typeof value.checkForDuplicates !== 'boolean'
    ) {
        throw new Error('Hoshidicts duplicate check setting is invalid.');
    }
    if (
        value.duplicateScope !== undefined &&
        !HOSHIDICTS_DUPLICATE_SCOPES.includes(
            value.duplicateScope as HoshidictsDuplicateScope
        )
    ) {
        throw new Error('Hoshidicts duplicate scope is invalid.');
    }
    if (
        value.duplicateScopeCheckAllModels !== undefined &&
        typeof value.duplicateScopeCheckAllModels !== 'boolean'
    ) {
        throw new Error('Hoshidicts duplicate note type setting is invalid.');
    }
    if (
        value.duplicateBehavior !== undefined &&
        !HOSHIDICTS_DUPLICATE_BEHAVIORS.includes(
            value.duplicateBehavior as HoshidictsDuplicateBehavior
        )
    ) {
        throw new Error('Hoshidicts duplicate behavior is invalid.');
    }
    const rawOverwriteModes = value.fieldOverwriteModes ?? {};
    if (!isRecord(rawOverwriteModes)) {
        throw new Error('Hoshidicts field overwrite modes are invalid.');
    }
    const fieldOverwriteModes = createDefaultHoshidictsFieldOverwriteModes();
    for (const field of MINING_FIELD_NAMES) {
        const mode = rawOverwriteModes[field];
        if (mode === undefined) {
            continue;
        }
        if (
            !HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
                mode as HoshidictsFieldOverwriteMode
            )
        ) {
            throw new Error(`Hoshidicts ${field} overwrite mode is invalid.`);
        }
        fieldOverwriteModes[field] = mode as HoshidictsFieldOverwriteMode;
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
            audio: normalizeProfileString(
                rawFields.audio,
                'Hoshidicts audio field'
            ),
        },
        disabledFields,
        tags,
        checkForDuplicates: value.checkForDuplicates !== false,
        duplicateScope:
            (value.duplicateScope as HoshidictsDuplicateScope | undefined) ??
            'collection',
        duplicateScopeCheckAllModels:
            value.duplicateScopeCheckAllModels === true,
        duplicateBehavior:
            (value.duplicateBehavior as
                | HoshidictsDuplicateBehavior
                | undefined) ??
            (value.duplicatePolicy === 'allow' ? 'new' : 'prevent'),
        fieldOverwriteModes: fieldOverwriteModes as HoshidictsFieldOverwriteModes,
        fieldTemplates: normalizeFieldTemplates(
            value.fieldTemplates,
            sourceVersion as number
        ),
    };
}
