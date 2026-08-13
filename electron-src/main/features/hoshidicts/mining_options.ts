import { getConfiguredSinglePort } from '../../gsm_config.js';
import type {
    HoshidictsMiningFields,
    HoshidictsMiningOptions,
} from '../../../shared/features/hoshidicts.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringList(value: unknown): string[] {
    return Array.isArray(value) ? (value as string[]) : [];
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
    if (!isRecord(value)) {
        return emptyOptions('The GSM backend returned invalid Anki options.');
    }
    // _empty_mining_options builds the full shape and hoshidicts_mining.py
    // mutates it in place, so every key arrives with the right type. Only the
    // four arrays the renderer maps over are coerced, so a null from a future
    // backend bug renders as empty instead of throwing mid-render.
    const options = { ...emptyOptions(), ...value } as HoshidictsMiningOptions;
    return {
        ...options,
        decks: asStringList(options.decks),
        noteTypes: asStringList(options.noteTypes),
        fields: asStringList(options.fields),
        warnings: asStringList(options.warnings),
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
