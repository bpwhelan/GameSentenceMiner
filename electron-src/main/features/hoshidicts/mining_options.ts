import { getConfiguredSinglePort } from '../../gsm_config.js';
import type {
    HoshidictsFieldOverwriteMode,
    HoshidictsMiningFieldTemplates,
    HoshidictsMiningFields,
    HoshidictsMiningOptions,
} from '../../../shared/features/hoshidicts.js';
import { HOSHIDICTS_FIELD_OVERWRITE_MODES } from '../../../shared/features/hoshidicts.js';

const EMPTY_FIELDS: HoshidictsMiningFields = {
    expression: '',
    reading: '',
    definition: '',
    sentence: '',
    frequency: '',
    pitch: '',
    audio: '',
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return Array.from(
        new Set(
            value.filter(
                (entry): entry is string =>
                    typeof entry === 'string' && entry.length > 0
            )
        )
    );
}

function stringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) {
        return {};
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string') {
            result[key] = entry;
        }
    }
    return result;
}

function fieldTemplateMap(value: unknown): HoshidictsMiningFieldTemplates {
    if (!isRecord(value)) {
        return {};
    }
    const result: HoshidictsMiningFieldTemplates = {};
    for (const [fieldName, rawTemplate] of Object.entries(value)) {
        if (!isRecord(rawTemplate) || typeof rawTemplate.value !== 'string') {
            continue;
        }
        const overwriteMode = rawTemplate.overwriteMode ?? 'coalesce';
        if (
            !HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
                overwriteMode as HoshidictsFieldOverwriteMode
            )
        ) {
            continue;
        }
        result[fieldName] = {
            value: rawTemplate.value,
            overwriteMode: overwriteMode as HoshidictsFieldOverwriteMode,
        };
    }
    return result;
}

function emptyOptions(error: string | null = null): HoshidictsMiningOptions {
    return {
        connected: false,
        gsmAnkiEnabled: false,
        decks: [],
        noteTypes: [],
        selectedNoteType: '',
        fields: [],
        suggestedFields: { ...EMPTY_FIELDS },
        resolvedFields: { ...EMPTY_FIELDS },
        suggestedFieldTemplates: {},
        resolvedFieldTemplates: {},
        warnings: [],
        error,
    };
}

export function normalizeHoshidictsMiningOptions(
    value: unknown
): HoshidictsMiningOptions {
    if (!value || typeof value !== 'object') {
        return emptyOptions('The GSM backend returned invalid Anki options.');
    }
    const candidate = value as Partial<HoshidictsMiningOptions>;
    const suggested =
        candidate.suggestedFields &&
        typeof candidate.suggestedFields === 'object'
            ? candidate.suggestedFields
            : EMPTY_FIELDS;
    const resolved =
        candidate.resolvedFields &&
        typeof candidate.resolvedFields === 'object'
            ? candidate.resolvedFields
            : EMPTY_FIELDS;
    return {
        connected: candidate.connected === true,
        gsmAnkiEnabled: candidate.gsmAnkiEnabled === true,
        decks: stringList(candidate.decks),
        noteTypes: stringList(candidate.noteTypes),
        selectedNoteType: stringValue(candidate.selectedNoteType),
        fields: stringList(candidate.fields),
        suggestedFields: {
            expression: stringValue(suggested.expression),
            reading: stringValue(suggested.reading),
            definition: stringValue(suggested.definition),
            sentence: stringValue(suggested.sentence),
            frequency: stringValue(suggested.frequency),
            pitch: stringValue(suggested.pitch),
            audio: stringValue(suggested.audio),
        },
        resolvedFields: {
            expression: stringValue(resolved.expression),
            reading: stringValue(resolved.reading),
            definition: stringValue(resolved.definition),
            sentence: stringValue(resolved.sentence),
            frequency: stringValue(resolved.frequency),
            pitch: stringValue(resolved.pitch),
            audio: stringValue(resolved.audio),
        },
        suggestedFieldTemplates: stringMap(
            candidate.suggestedFieldTemplates
        ),
        resolvedFieldTemplates: fieldTemplateMap(
            candidate.resolvedFieldTemplates
        ),
        warnings: stringList(candidate.warnings),
        error:
            typeof candidate.error === 'string' && candidate.error.length > 0
                ? candidate.error
                : null,
    };
}

export async function fetchHoshidictsMiningOptions(
    model?: string
): Promise<HoshidictsMiningOptions> {
    const url = new URL(
        `http://127.0.0.1:${getConfiguredSinglePort()}/api/hoshidicts/mining/options`
    );
    if (model !== undefined) {
        url.searchParams.set('model', model);
    }
    try {
        const response = await fetch(url.toString(), {
            signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
            throw new Error(`GSM backend returned HTTP ${response.status}.`);
        }
        return normalizeHoshidictsMiningOptions(await response.json());
    } catch (error) {
        return emptyOptions(
            `Could not check AnkiConnect: ${errorMessage(error)}`
        );
    }
}
