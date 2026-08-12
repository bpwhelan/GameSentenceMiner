import {
    GSM_THEME_DEFINITIONS,
    GSM_THEME_GROUP_DEFINITIONS,
    type GsmThemeCategory,
    type GsmThemeId,
} from '../themes.js';

export const HOSHIDICTS_CHANNELS = {
    openSettings: 'hoshidicts.openSettings',
    getState: 'hoshidicts.getState',
    progress: 'hoshidicts.progress',
    yomitanImportProgress: 'hoshidicts.yomitanImportProgress',
    importDictionary: 'hoshidicts.import',
    importYomitanDictionaries: 'hoshidicts.importYomitanDictionaries',
    importYomitanSettings: 'hoshidicts.importYomitanSettings',
    exportBackup: 'hoshidicts.exportBackup',
    restoreBackup: 'hoshidicts.restoreBackup',
    installAllRecommended: 'hoshidicts.installAllRecommended',
    installRecommended: 'hoshidicts.installRecommended',
    checkUpdates: 'hoshidicts.checkUpdates',
    removeDictionary: 'hoshidicts.remove',
    setSchedule: 'hoshidicts.setSchedule',
    setDictionarySchedule: 'hoshidicts.setDictionarySchedule',
    setLookupMode: 'hoshidicts.setLookupMode',
    setReaderPreferences: 'hoshidicts.setReaderPreferences',
    setMiningProfile: 'hoshidicts.setMiningProfile',
    setAudioProfile: 'hoshidicts.setAudioProfile',
    createProfile: 'hoshidicts.createProfile',
    switchProfile: 'hoshidicts.switchProfile',
    renameProfile: 'hoshidicts.renameProfile',
    deleteProfile: 'hoshidicts.deleteProfile',
    testAudioSource: 'hoshidicts.testAudioSource',
    getMiningOptions: 'hoshidicts.getMiningOptions',
    setDictionaryEnabled: 'hoshidicts.setDictionaryEnabled',
    setDictionaryPresentation: 'hoshidicts.setDictionaryPresentation',
    bulkDictionaryAction: 'hoshidicts.bulkDictionaryAction',
    createTabGroup: 'hoshidicts.createTabGroup',
    setTabGroupMembership: 'hoshidicts.setTabGroupMembership',
    renameTabGroup: 'hoshidicts.renameTabGroup',
    deleteTabGroup: 'hoshidicts.deleteTabGroup',
    moveTabGroup: 'hoshidicts.moveTabGroup',
    renameDictionary: 'hoshidicts.renameDictionary',
    moveDictionary: 'hoshidicts.moveDictionary',
    moveDictionaryToPosition: 'hoshidicts.moveDictionaryToPosition',
    getCustomDictionary: 'hoshidicts.getCustomDictionary',
    saveCustomDictionary: 'hoshidicts.saveCustomDictionary',
    restartOverlay: 'hoshidicts.restartOverlay',
} as const;

export type HoshidictsSchedule =
    | 'off'
    | 'hourly'
    | 'daily'
    | 'weekly'
    | 'monthly';
export type HoshidictsLookupMode = 'shift' | 'hover';
export type HoshidictsDefinitionBlurRevealMode = 'timed' | 'hover';
export type HoshidictsFrequencyMode = 'occurrence-based' | 'rank-based';
export type HoshidictsSortFrequencyDictionaryOrder =
    | 'ascending'
    | 'descending';
export const HOSHIDICTS_ACTIVATION_KEYS = [
    'Ctrl',
    'Alt',
    'Shift',
    'Cmd',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O',
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'Space',
    'Return',
    'Escape',
    'Backspace',
    'Delete',
    'Tab',
    'Up',
    'Down',
    'Left',
    'Right',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Insert',
    'F1',
    'F2',
    'F3',
    'F4',
    'F5',
    'F6',
    'F7',
    'F8',
    'F9',
    'F10',
    'F11',
    'F12',
    'F13',
    'F14',
    'F15',
    'F16',
    'F17',
    'F18',
    'F19',
    'F20',
    'F21',
    'F22',
    'F23',
    'F24',
    '-',
    '=',
    '[',
    ']',
    '\\',
    ';',
    "'",
    ',',
    '.',
    '/',
    '`',
] as const;
export type HoshidictsActivationKey =
    (typeof HOSHIDICTS_ACTIVATION_KEYS)[number];
export const DEFAULT_HOSHIDICTS_ACTIVATION_KEY: HoshidictsActivationKey =
    'Shift';
const HOSHIDICTS_ACTIVATION_KEY_SET = new Set<string>(
    HOSHIDICTS_ACTIVATION_KEYS
);

export function isHoshidictsActivationKey(
    value: unknown
): value is HoshidictsActivationKey {
    return (
        typeof value === 'string' &&
        HOSHIDICTS_ACTIVATION_KEY_SET.has(value)
    );
}
export const DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 300;
export const DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED = false;
export const DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT = true;
export const DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY = false;
export const DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT = 3;
export const MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT = 1;
export const MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT = 6;
export const DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA = true;
export const DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE = false;
export const DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS = true;
export const DEFAULT_HOSHIDICTS_AVERAGE_FREQUENCY = false;
export const DEFAULT_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES = true;
export const DEFAULT_HOSHIDICTS_SCAN_LENGTH = 16;
export const MIN_HOSHIDICTS_SCAN_LENGTH = 1;
export const MAX_HOSHIDICTS_SCAN_LENGTH = 64;
export const DEFAULT_HOSHIDICTS_MAX_RESULTS = 32;
export const MIN_HOSHIDICTS_MAX_RESULTS = 1;
export const MAX_HOSHIDICTS_MAX_RESULTS = 256;
export const DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER: HoshidictsSortFrequencyDictionaryOrder =
    'descending';
export function isHoshidictsSortFrequencyDictionaryOrder(
    value: unknown
): value is HoshidictsSortFrequencyDictionaryOrder {
    return value === 'ascending' || value === 'descending';
}
export const MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS = 5000;
export const DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX = 560;
export const DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX = 420;
export const DEFAULT_HOSHIDICTS_POPUP_COLUMNS = 1;
export const DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT = 85;
export const DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX = 16;
export const DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS = '';
export const MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH = 32 * 1024;
export const HOSHIDICTS_POPUP_TOOLBAR_POSITIONS = ['top', 'bottom'] as const;
export type HoshidictsPopupToolbarPosition =
    (typeof HOSHIDICTS_POPUP_TOOLBAR_POSITIONS)[number];
export const DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION: HoshidictsPopupToolbarPosition =
    'top';
const HOSHIDICTS_POPUP_TOOLBAR_POSITION_SET = new Set<string>(
    HOSHIDICTS_POPUP_TOOLBAR_POSITIONS
);
export function isHoshidictsPopupToolbarPosition(
    value: unknown
): value is HoshidictsPopupToolbarPosition {
    return (
        typeof value === 'string' &&
        HOSHIDICTS_POPUP_TOOLBAR_POSITION_SET.has(value)
    );
}
export const MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS = 8;
export const MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH = 64;
export const MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH = 2048;

export interface HoshidictsPopupCustomLink {
    label: string;
    url: string;
}

export interface HoshidictsPopupButtons {
    addToAnki: boolean;
    audio: boolean;
    customDefinition: boolean;
    viewInAnki: boolean;
    customLinks: HoshidictsPopupCustomLink[];
}

export function createDefaultHoshidictsPopupButtons(): HoshidictsPopupButtons {
    return {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: false,
        customLinks: [],
    };
}

function isHoshidictsRecord(
    value: unknown
): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHoshidictsPopupCustomLinkTemplate(
    value: unknown
): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    const template = value.trim();
    if (
        template.length === 0 ||
        template.length > MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(template) ||
        !/^https?:\/\//iu.test(template)
    ) {
        return false;
    }
    try {
        const parsed = new URL(
            template.replaceAll('%w', 'word').replaceAll('%s', 'sentence')
        );
        return (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            parsed.hostname.length > 0 &&
            parsed.username.length === 0 &&
            parsed.password.length === 0
        );
    } catch {
        return false;
    }
}

export function normalizeHoshidictsPopupButtons(
    value: unknown
): HoshidictsPopupButtons {
    if (!isHoshidictsRecord(value)) {
        throw new Error('Hoshidicts popup buttons must be an object.');
    }
    if (
        typeof value.addToAnki !== 'boolean' ||
        typeof value.audio !== 'boolean' ||
        typeof value.customDefinition !== 'boolean' ||
        typeof value.viewInAnki !== 'boolean'
    ) {
        throw new Error('Hoshidicts popup button visibility is invalid.');
    }
    if (
        !Array.isArray(value.customLinks) ||
        value.customLinks.length > MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS
    ) {
        throw new Error('Hoshidicts popup custom links are invalid.');
    }

    const customLinks = value.customLinks.map((rawLink) => {
        if (!isHoshidictsRecord(rawLink)) {
            throw new Error('Hoshidicts popup custom link is invalid.');
        }
        const label =
            typeof rawLink.label === 'string' ? rawLink.label.trim() : '';
        const url = typeof rawLink.url === 'string' ? rawLink.url.trim() : '';
        if (
            label.length === 0 ||
            label.length > MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH ||
            /[\u0000-\u001f\u007f]/u.test(label)
        ) {
            throw new Error('Hoshidicts popup custom link label is invalid.');
        }
        if (!isHoshidictsPopupCustomLinkTemplate(url)) {
            throw new Error('Hoshidicts popup custom link URL is invalid.');
        }
        return { label, url };
    });

    return {
        addToAnki: value.addToAnki,
        audio: value.audio,
        customDefinition: value.customDefinition,
        viewInAnki: value.viewInAnki,
        customLinks,
    };
}

export function isHoshidictsPopupButtons(
    value: unknown
): value is HoshidictsPopupButtons {
    try {
        normalizeHoshidictsPopupButtons(value);
        return true;
    } catch {
        return false;
    }
}
export const MIN_HOSHIDICTS_POPUP_WIDTH_PX = 280;
export const MAX_HOSHIDICTS_POPUP_WIDTH_PX = 1200;
export const MIN_HOSHIDICTS_POPUP_HEIGHT_PX = 200;
export const MAX_HOSHIDICTS_POPUP_HEIGHT_PX = 900;
export const MIN_HOSHIDICTS_POPUP_COLUMNS = 1;
export const MAX_HOSHIDICTS_POPUP_COLUMNS = 4;
export const MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT = 0;
export const MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT = 100;
export const MIN_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX = 0;
export const MAX_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX = 32;
export type HoshidictsTheme =
    | 'default'
    | 'girlypop'
    | Exclude<GsmThemeId, 'gsm-dark'>;

export interface HoshidictsThemeDefinition {
    id: HoshidictsTheme;
    category: GsmThemeCategory;
    labelKey?: string;
    label?: string;
}

const GSM_HOSHIDICTS_THEME_DEFINITIONS: readonly HoshidictsThemeDefinition[] =
    GSM_THEME_DEFINITIONS.filter((theme) => theme.id !== 'gsm-dark').map(
        (theme) => ({
            ...theme,
            id: theme.id as Exclude<GsmThemeId, 'gsm-dark'>,
        })
    );

export const HOSHIDICTS_THEME_DEFINITIONS: readonly HoshidictsThemeDefinition[] =
    [
        {
            id: 'default',
            category: 'dark',
            labelKey: 'settings.themeCatalog.names.gsmDark',
        },
        ...GSM_HOSHIDICTS_THEME_DEFINITIONS.filter(
            (theme) => theme.category === 'dark'
        ),
        {
            id: 'girlypop',
            category: 'light',
            labelKey: 'settings.themeCatalog.names.girlypop',
        },
        ...GSM_HOSHIDICTS_THEME_DEFINITIONS.filter(
            (theme) => theme.category === 'light'
        ),
        ...GSM_HOSHIDICTS_THEME_DEFINITIONS.filter(
            (theme) => theme.category === 'highContrast'
        ),
    ];

export const HOSHIDICTS_THEME_GROUPS = GSM_THEME_GROUP_DEFINITIONS.map(
    (group) => ({
        ...group,
        themes: HOSHIDICTS_THEME_DEFINITIONS.filter(
            (theme) => theme.category === group.id
        ),
    })
);

export const HOSHIDICTS_THEMES: readonly HoshidictsTheme[] =
    HOSHIDICTS_THEME_DEFINITIONS.map((theme) => theme.id);
export const DEFAULT_HOSHIDICTS_THEME: HoshidictsTheme = 'default';
const HOSHIDICTS_THEME_SET = new Set<string>(HOSHIDICTS_THEMES);

export function isHoshidictsTheme(value: unknown): value is HoshidictsTheme {
    return typeof value === 'string' && HOSHIDICTS_THEME_SET.has(value);
}
export const MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1;
export const MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1_000_000;
export const MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS = 1000;
export const MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS = 3_600_000;
export const DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH = 10;
export const HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS = [
    'jitendex',
    'jmdict',
    'jmnedict',
    'bccwj',
    'jpdbv2-kana',
    'jiten',
    'kanjium-pitch',
    'kanjidic',
] as const;
export type HoshidictsRecommendedDictionaryId =
    (typeof HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS)[number];
export const MAX_HOSHIDICTS_CUSTOM_DICTIONARY_BYTES = 16 * 1024 * 1024;
export const MAX_HOSHIDICTS_CUSTOM_TERM_BYTES = 4 * 1024;
export const MAX_HOSHIDICTS_CUSTOM_READING_BYTES = 4 * 1024;
// The native bridge retains up to 64 glossaries across 16 results. Their custom
// definitions consume at most half of its 256 KiB response; the rest is reserved
// for terms, readings, and JSON metadata.
export const MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES = 2 * 1024;

export interface HoshidictsCustomDictionaryEntry {
    term: string;
    reading: string;
    definition: string;
}

export interface HoshidictsCustomDictionaryParseResult {
    entries: HoshidictsCustomDictionaryEntry[];
    ignoredLines: number[];
    ignoredLineCount: number;
}

const UTF8_ENCODER = new TextEncoder();
const MAX_REPORTED_HOSHIDICTS_CUSTOM_IGNORED_LINES = 20;

function isJsonStringWithinUtf8Limit(value: string, maxBytes: number): boolean {
    // Count the representation placed in the native JSON response so quotes,
    // backslashes, and control characters cannot expand past the byte budget.
    return UTF8_ENCODER.encode(JSON.stringify(value)).length <= maxBytes + 2;
}

function decodeCustomDefinition(value: string): string {
    return value.replace(/\\\\|\\n/gu, (escape) =>
        escape === '\\n' ? '\n' : '\\'
    );
}

export function isHoshidictsCustomEntryWithinLimits(
    entry: HoshidictsCustomDictionaryEntry
): boolean {
    return (
        isJsonStringWithinUtf8Limit(
            entry.term,
            MAX_HOSHIDICTS_CUSTOM_TERM_BYTES
        ) &&
        isJsonStringWithinUtf8Limit(
            entry.reading,
            MAX_HOSHIDICTS_CUSTOM_READING_BYTES
        ) &&
        isJsonStringWithinUtf8Limit(
            entry.definition,
            MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES
        )
    );
}

export function parseHoshidictsCustomDictionary(
    text: string
): HoshidictsCustomDictionaryParseResult {
    const entries: HoshidictsCustomDictionaryEntry[] = [];
    const ignoredLines: number[] = [];
    let ignoredLineCount = 0;
    const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);

    const ignoreLine = (lineNumber: number): void => {
        ignoredLineCount += 1;
        if (
            ignoredLines.length <
            MAX_REPORTED_HOSHIDICTS_CUSTOM_IGNORED_LINES
        ) {
            ignoredLines.push(lineNumber);
        }
    };

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index].replace(/\r$/u, '');
        const trimmedLine = rawLine.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        const firstComma = rawLine.indexOf(',');
        const secondComma =
            firstComma < 0 ? -1 : rawLine.indexOf(',', firstComma + 1);
        if (secondComma < 0) {
            ignoreLine(index + 1);
            continue;
        }

        const entry = {
            term: rawLine.slice(0, firstComma).trim(),
            reading: rawLine.slice(firstComma + 1, secondComma).trim(),
            definition: decodeCustomDefinition(
                rawLine.slice(secondComma + 1).trim()
            ),
        };
        if (
            !entry.term ||
            !entry.reading ||
            !entry.definition ||
            !isHoshidictsCustomEntryWithinLimits(entry)
        ) {
            ignoreLine(index + 1);
            continue;
        }
        entries.push(entry);
    }

    return { entries, ignoredLines, ignoredLineCount };
}
export type HoshidictsMoveDirection = -1 | 1;
export const HOSHIDICTS_AUDIO_SOURCE_TYPES = [
    'jpod101',
    'language-pod-101',
    'jisho',
    'custom',
    'custom-json',
    'text-to-speech',
    'text-to-speech-reading',
] as const;
export const MAX_HOSHIDICTS_AUDIO_SOURCES = 32;
export type HoshidictsAudioSourceType =
    (typeof HOSHIDICTS_AUDIO_SOURCE_TYPES)[number];
export type HoshidictsProgressPhase =
    | 'idle'
    | 'importing'
    | 'checking'
    | 'downloading'
    | 'reloading'
    | 'removing'
    | 'saving';

export interface HoshidictsMiningFields {
    expression: string;
    reading: string;
    definition: string;
    sentence: string;
    frequency: string;
    pitch: string;
    audio: string;
}

export type HoshidictsMiningFieldName = keyof HoshidictsMiningFields;

export const HOSHIDICTS_MINING_FIELD_MARKERS = [
    { id: 'expression', value: '{expression}' },
    { id: 'reading', value: '{reading}' },
    { id: 'furigana', value: '{furigana}' },
    { id: 'furigana-plain', value: '{furigana-plain}' },
    { id: 'definition', value: '{definition}' },
    { id: 'main-definition', value: '{main-definition}' },
    { id: 'glossary', value: '{glossary}' },
    { id: 'dictionary', value: '{dictionary}' },
    { id: 'sentence', value: '{sentence}' },
    { id: 'popup-selection-text', value: '{popup-selection-text}' },
    { id: 'sentence-furigana', value: '{sentence-furigana}' },
    {
        id: 'sentence-furigana-plain',
        value: '{sentence-furigana-plain}',
    },
    { id: 'frequency', value: '{frequency}' },
    { id: 'frequencies', value: '{frequencies}' },
    {
        id: 'frequency-harmonic-rank',
        value: '{frequency-harmonic-rank}',
    },
    { id: 'pitch', value: '{pitch}' },
    { id: 'pitch-position', value: '{pitch-position}' },
    {
        id: 'pitch-accent-positions',
        value: '{pitch-accent-positions}',
    },
    {
        id: 'pitch-accent-categories',
        value: '{pitch-accent-categories}',
    },
    { id: 'audio', value: '{audio}' },
    { id: 'document-title', value: '{document-title}' },
] as const;

export type HoshidictsMiningFieldMarker =
    (typeof HOSHIDICTS_MINING_FIELD_MARKERS)[number]['id'];

export const HOSHIDICTS_DUPLICATE_SCOPES = [
    'collection',
    'deck',
    'deck-root',
] as const;
export type HoshidictsDuplicateScope =
    (typeof HOSHIDICTS_DUPLICATE_SCOPES)[number];
export const HOSHIDICTS_DUPLICATE_BEHAVIORS = [
    'prevent',
    'overwrite',
    'new',
] as const;
export type HoshidictsDuplicateBehavior =
    (typeof HOSHIDICTS_DUPLICATE_BEHAVIORS)[number];
export const HOSHIDICTS_FIELD_OVERWRITE_MODES = [
    'coalesce',
    'coalesce-new',
    'skip',
    'append',
    'prepend',
    'overwrite',
] as const;
export type HoshidictsFieldOverwriteMode =
    (typeof HOSHIDICTS_FIELD_OVERWRITE_MODES)[number];

export interface HoshidictsMiningFieldTemplate {
    value: string;
    overwriteMode: HoshidictsFieldOverwriteMode;
}

export type HoshidictsMiningFieldTemplates = Record<
    string,
    HoshidictsMiningFieldTemplate
>;

export type HoshidictsFieldOverwriteModes = Record<
    HoshidictsMiningFieldName,
    HoshidictsFieldOverwriteMode
>;

export function createDefaultHoshidictsFieldOverwriteModes(): HoshidictsFieldOverwriteModes {
    return {
        expression: 'coalesce',
        reading: 'coalesce',
        definition: 'coalesce',
        sentence: 'coalesce',
        frequency: 'coalesce',
        pitch: 'coalesce',
        audio: 'coalesce',
    };
}

export interface HoshidictsDefinitionBlurPreferences {
    enabled: boolean;
    lookupThreshold: number;
    revealMode: HoshidictsDefinitionBlurRevealMode;
    revealDelayMs: number;
}

export const DEFAULT_HOSHIDICTS_DEFINITION_BLUR = {
    enabled: false,
    lookupThreshold: 5,
    revealMode: 'timed',
    revealDelayMs: 5000,
} as const satisfies HoshidictsDefinitionBlurPreferences;

/**
 * Every reader preference is required. Hoshidicts is unreleased, so there is no
 * legacy data to migrate and no reason for a partial internal shape; only
 * imported Yomitan settings arrive incomplete, and they are normalized first.
 */
export interface HoshidictsReaderPreferencesRequest {
    lookupMode: HoshidictsLookupMode;
    scanLength: number;
    maxResults: number;
    sortFrequencyDictionary: string | null;
    sortFrequencyDictionaryOrder: HoshidictsSortFrequencyDictionaryOrder;
    activationKey: HoshidictsActivationKey;
    sourceHighlightEnabled: boolean;
    onlyScanJapaneseText: boolean;
    popupHideDelayMs: number;
    showLookupCounts: boolean;
    averageFrequency: boolean;
    showFrequencyDictionaryNames: boolean;
    showCompactDefinitionSummary: boolean;
    compactDefinitionSummaryCount: number;
    compactDefinitionSummaryDictionary: string | null;
    showPitchAccentFurigana: boolean;
    pitchAccentFuriganaDictionary: string | null;
    showPitchAccentBadge: boolean;
    hidePopupGrammarTags: boolean;
    popupNestingMaxDepth: number;
    definitionBlur: HoshidictsDefinitionBlurPreferences;
    popupWidthPx: number;
    popupHeightPx: number;
    popupColumns: number;
    theme: HoshidictsTheme;
    popupOpacityPercent: number;
    popupBackdropBlurPx: number;
    popupToolbarPosition: HoshidictsPopupToolbarPosition;
    popupButtons: HoshidictsPopupButtons;
    customPopupCss: string;
}

export interface HoshidictsDictionaryPresentation {
    title: string;
    favorite: boolean;
    displayName?: string;
    frequencyMode?: HoshidictsFrequencyMode;
}

export const MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH = 128;

export interface HoshidictsDictionaryTabGroup {
    id: string;
    name: string;
    dictionaryIds: string[];
}

export interface HoshidictsReaderTabGroup {
    id: string;
    name: string;
    dictionaries: string[];
}

/**
 * The reader preferences plus the read-only dictionary context the overlay needs
 * to render them. The context fields are derived from a manager snapshot rather
 * than stored, so they are absent from a plain preferences object.
 */
export interface HoshidictsReaderPreferences
    extends HoshidictsReaderPreferencesRequest {
    dictionaryPresentation?: HoshidictsDictionaryPresentation[];
    // Ordered enabled frequency dictionaries are used to register Yomitan's
    // dynamic single-frequency-* mining markers, including dictionaries which
    // do not contribute a value to the current lookup result.
    frequencyDictionaries?: string[];
    dictionaryTabGroups?: HoshidictsReaderTabGroup[];
}

export type HoshidictsNumericReaderPreference = {
    [K in keyof HoshidictsReaderPreferencesRequest]: HoshidictsReaderPreferencesRequest[K] extends number
        ? K
        : never;
}[keyof HoshidictsReaderPreferencesRequest];

type ReaderPreferenceKey = keyof HoshidictsReaderPreferencesRequest;
type ReaderPreferenceValue = HoshidictsReaderPreferencesRequest[ReaderPreferenceKey];

/**
 * One entry per reader preference. Defaults, tolerant normalization, strict
 * validation and equality are all derived from this table so a new preference
 * only has to be described once.
 */
interface HoshidictsReaderPreferenceSpec {
    key: ReaderPreferenceKey;
    createDefault: () => ReaderPreferenceValue;
    /** Returns null when the value is acceptable, otherwise the error message. */
    validate: (value: unknown) => string | null;
    /** Copies and canonicalizes an already-valid value. */
    canonicalize: (value: ReaderPreferenceValue) => ReaderPreferenceValue;
    equals: (left: ReaderPreferenceValue, right: ReaderPreferenceValue) => boolean;
}

const identity = (value: ReaderPreferenceValue): ReaderPreferenceValue => value;
const strictEquals = (
    left: ReaderPreferenceValue,
    right: ReaderPreferenceValue
): boolean => left === right;

function booleanPreference(
    key: ReaderPreferenceKey,
    message: string,
    defaultValue: boolean
): HoshidictsReaderPreferenceSpec {
    return {
        key,
        createDefault: () => defaultValue,
        validate: (value) => (typeof value === 'boolean' ? null : message),
        canonicalize: identity,
        equals: strictEquals,
    };
}

function integerPreference(
    key: ReaderPreferenceKey,
    message: string,
    defaultValue: number,
    minimum: number,
    maximum: number
): HoshidictsReaderPreferenceSpec {
    return {
        key,
        createDefault: () => defaultValue,
        validate: (value) =>
            Number.isInteger(value) &&
            (value as number) >= minimum &&
            (value as number) <= maximum
                ? null
                : message,
        canonicalize: identity,
        equals: strictEquals,
    };
}

function choicePreference<T extends ReaderPreferenceValue>(
    key: ReaderPreferenceKey,
    message: string,
    defaultValue: T,
    isValid: (value: unknown) => boolean
): HoshidictsReaderPreferenceSpec {
    return {
        key,
        createDefault: () => defaultValue,
        validate: (value) => (isValid(value) ? null : message),
        canonicalize: identity,
        equals: strictEquals,
    };
}

/**
 * A dictionary title, or null when the feature is turned off. `trim` mirrors the
 * per-field behaviour the manager already had: some titles are stored verbatim,
 * others trimmed.
 */
function dictionaryTitlePreference(
    key: ReaderPreferenceKey,
    message: string,
    options: { trim: boolean }
): HoshidictsReaderPreferenceSpec {
    return {
        key,
        createDefault: () => null,
        validate: (value) => {
            if (value === null) {
                return null;
            }
            if (typeof value !== 'string' || value.length > 4096) {
                return message;
            }
            const meaningful = options.trim ? value.trim() : value;
            return meaningful.length > 0 ? null : message;
        },
        canonicalize: (value) =>
            options.trim && typeof value === 'string' ? value.trim() : value,
        equals: strictEquals,
    };
}

const HOSHIDICTS_READER_PREFERENCE_SPECS: readonly HoshidictsReaderPreferenceSpec[] =
    [
        choicePreference(
            'lookupMode',
            'Hoshidicts lookup mode is invalid.',
            'shift',
            (value) => value === 'shift' || value === 'hover'
        ),
        integerPreference(
            'scanLength',
            'Hoshidicts scan length is invalid.',
            DEFAULT_HOSHIDICTS_SCAN_LENGTH,
            MIN_HOSHIDICTS_SCAN_LENGTH,
            MAX_HOSHIDICTS_SCAN_LENGTH
        ),
        integerPreference(
            'maxResults',
            'Hoshidicts maximum result count is invalid.',
            DEFAULT_HOSHIDICTS_MAX_RESULTS,
            MIN_HOSHIDICTS_MAX_RESULTS,
            MAX_HOSHIDICTS_MAX_RESULTS
        ),
        dictionaryTitlePreference(
            'sortFrequencyDictionary',
            'Hoshidicts frequency sort dictionary is invalid.',
            { trim: false }
        ),
        choicePreference(
            'sortFrequencyDictionaryOrder',
            'Hoshidicts frequency sort order is invalid.',
            DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
            isHoshidictsSortFrequencyDictionaryOrder
        ),
        integerPreference(
            'popupHideDelayMs',
            'Hoshidicts popup hide delay is invalid.',
            DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
            0,
            MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS
        ),
        choicePreference(
            'activationKey',
            'Hoshidicts activation key is invalid.',
            DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
            isHoshidictsActivationKey
        ),
        booleanPreference(
            'sourceHighlightEnabled',
            'Hoshidicts source highlight preference is invalid.',
            DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED
        ),
        booleanPreference(
            'onlyScanJapaneseText',
            'Hoshidicts Japanese-only scan preference is invalid.',
            DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT
        ),
        choicePreference(
            'popupToolbarPosition',
            'Hoshidicts popup toolbar position is invalid.',
            DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
            isHoshidictsPopupToolbarPosition
        ),
        {
            key: 'popupButtons',
            createDefault: createDefaultHoshidictsPopupButtons,
            validate: (value) =>
                isHoshidictsPopupButtons(value)
                    ? null
                    : 'Hoshidicts popup buttons are invalid.',
            canonicalize: (value) =>
                normalizeHoshidictsPopupButtons(value),
            equals: (left, right) =>
                hoshidictsPopupButtonsEqual(
                    left as HoshidictsPopupButtons,
                    right as HoshidictsPopupButtons
                ),
        },
        booleanPreference(
            'showLookupCounts',
            'Hoshidicts lookup count preference is invalid.',
            true
        ),
        booleanPreference(
            'averageFrequency',
            'Hoshidicts average frequency preference is invalid.',
            DEFAULT_HOSHIDICTS_AVERAGE_FREQUENCY
        ),
        booleanPreference(
            'showFrequencyDictionaryNames',
            'Hoshidicts frequency dictionary name preference is invalid.',
            DEFAULT_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES
        ),
        booleanPreference(
            'showCompactDefinitionSummary',
            'Hoshidicts compact definition summary preference is invalid.',
            DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY
        ),
        integerPreference(
            'compactDefinitionSummaryCount',
            'Hoshidicts compact definition summary count is invalid.',
            DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
            MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
            MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT
        ),
        dictionaryTitlePreference(
            'compactDefinitionSummaryDictionary',
            'Hoshidicts compact definition summary dictionary is invalid.',
            { trim: true }
        ),
        booleanPreference(
            'showPitchAccentFurigana',
            'Hoshidicts pitch accent furigana preference is invalid.',
            DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA
        ),
        dictionaryTitlePreference(
            'pitchAccentFuriganaDictionary',
            'Hoshidicts pitch accent furigana dictionary is invalid.',
            { trim: true }
        ),
        booleanPreference(
            'showPitchAccentBadge',
            'Hoshidicts pitch accent badge preference is invalid.',
            DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE
        ),
        booleanPreference(
            'hidePopupGrammarTags',
            'Hoshidicts popup grammar tag preference is invalid.',
            DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS
        ),
        {
            key: 'popupNestingMaxDepth',
            createDefault: () => DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
            validate: (value) =>
                Number.isSafeInteger(value) && (value as number) >= 0
                    ? null
                    : 'Hoshidicts popup nesting depth is invalid.',
            canonicalize: identity,
            equals: strictEquals,
        },
        {
            key: 'definitionBlur',
            createDefault: () => ({ ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR }),
            validate: validateDefinitionBlur,
            canonicalize: (value) => ({
                ...(value as HoshidictsDefinitionBlurPreferences),
            }),
            equals: (left, right) =>
                hoshidictsDefinitionBlurEqual(
                    left as HoshidictsDefinitionBlurPreferences,
                    right as HoshidictsDefinitionBlurPreferences
                ),
        },
        integerPreference(
            'popupWidthPx',
            'Hoshidicts popup width is invalid.',
            DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
            MIN_HOSHIDICTS_POPUP_WIDTH_PX,
            MAX_HOSHIDICTS_POPUP_WIDTH_PX
        ),
        integerPreference(
            'popupHeightPx',
            'Hoshidicts popup height is invalid.',
            DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
            MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
            MAX_HOSHIDICTS_POPUP_HEIGHT_PX
        ),
        integerPreference(
            'popupColumns',
            'Hoshidicts popup column count is invalid.',
            DEFAULT_HOSHIDICTS_POPUP_COLUMNS,
            MIN_HOSHIDICTS_POPUP_COLUMNS,
            MAX_HOSHIDICTS_POPUP_COLUMNS
        ),
        choicePreference(
            'theme',
            'Hoshidicts theme is invalid.',
            DEFAULT_HOSHIDICTS_THEME,
            isHoshidictsTheme
        ),
        integerPreference(
            'popupOpacityPercent',
            'Hoshidicts popup opacity is invalid.',
            DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
            MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
            MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT
        ),
        integerPreference(
            'popupBackdropBlurPx',
            'Hoshidicts popup backdrop blur is invalid.',
            DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
            MIN_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
            MAX_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX
        ),
        {
            key: 'customPopupCss',
            createDefault: () => DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
            validate: (value) =>
                typeof value === 'string' &&
                value.length <= MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH
                    ? null
                    : 'Hoshidicts custom popup CSS is invalid.',
            canonicalize: identity,
            equals: strictEquals,
        },
    ];

function validateDefinitionBlur(value: unknown): string | null {
    if (!isHoshidictsRecord(value)) {
        return 'Hoshidicts definition blur enabled state is invalid.';
    }
    if (typeof value.enabled !== 'boolean') {
        return 'Hoshidicts definition blur enabled state is invalid.';
    }
    if (
        !Number.isInteger(value.lookupThreshold) ||
        (value.lookupThreshold as number) <
            MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD ||
        (value.lookupThreshold as number) >
            MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD
    ) {
        return 'Hoshidicts definition blur lookup threshold is invalid.';
    }
    if (value.revealMode !== 'timed' && value.revealMode !== 'hover') {
        return 'Hoshidicts definition blur reveal mode is invalid.';
    }
    if (
        !Number.isInteger(value.revealDelayMs) ||
        (value.revealDelayMs as number) <
            MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS ||
        (value.revealDelayMs as number) >
            MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS
    ) {
        return 'Hoshidicts definition blur reveal delay is invalid.';
    }
    return null;
}

export function hoshidictsDefinitionBlurEqual(
    left: HoshidictsDefinitionBlurPreferences,
    right: HoshidictsDefinitionBlurPreferences
): boolean {
    return (
        left.enabled === right.enabled &&
        left.lookupThreshold === right.lookupThreshold &&
        left.revealMode === right.revealMode &&
        left.revealDelayMs === right.revealDelayMs
    );
}

export function hoshidictsPopupButtonsEqual(
    left: HoshidictsPopupButtons,
    right: HoshidictsPopupButtons
): boolean {
    return (
        left.addToAnki === right.addToAnki &&
        left.audio === right.audio &&
        left.customDefinition === right.customDefinition &&
        left.viewInAnki === right.viewInAnki &&
        left.customLinks.length === right.customLinks.length &&
        left.customLinks.every(
            (link, index) =>
                link.label === right.customLinks[index]?.label &&
                link.url === right.customLinks[index]?.url
        )
    );
}

export function createDefaultHoshidictsReaderPreferences(): HoshidictsReaderPreferencesRequest {
    const preferences: Record<string, unknown> = {};
    for (const spec of HOSHIDICTS_READER_PREFERENCE_SPECS) {
        preferences[spec.key] = spec.createDefault();
    }
    return preferences as unknown as HoshidictsReaderPreferencesRequest;
}

/**
 * Rejects anything that is not a complete, in-range set of reader preferences.
 * The thrown message names the offending field so the settings window can show
 * it directly.
 */
export function assertHoshidictsReaderPreferences(
    value: unknown
): HoshidictsReaderPreferencesRequest {
    if (!isHoshidictsRecord(value)) {
        throw new Error('Hoshidicts reader preferences are invalid.');
    }
    const preferences: Record<string, unknown> = {};
    for (const spec of HOSHIDICTS_READER_PREFERENCE_SPECS) {
        const candidate = value[spec.key];
        const failure = spec.validate(candidate);
        if (failure !== null) {
            throw new Error(failure);
        }
        preferences[spec.key] = spec.canonicalize(
            candidate as ReaderPreferenceValue
        );
    }
    return preferences as unknown as HoshidictsReaderPreferencesRequest;
}

/** Replaces unusable fields with their defaults instead of throwing. */
export function normalizeHoshidictsReaderPreferences(
    value: unknown
): HoshidictsReaderPreferencesRequest {
    const source = isHoshidictsRecord(value) ? value : {};
    const preferences: Record<string, unknown> = {};
    for (const spec of HOSHIDICTS_READER_PREFERENCE_SPECS) {
        const candidate = source[spec.key];
        preferences[spec.key] =
            spec.validate(candidate) === null
                ? spec.canonicalize(candidate as ReaderPreferenceValue)
                : spec.createDefault();
    }
    return preferences as unknown as HoshidictsReaderPreferencesRequest;
}

export function cloneHoshidictsReaderPreferences<
    T extends HoshidictsReaderPreferences,
>(preferences: T): T {
    return structuredClone(preferences);
}

/** Compares the stored preferences only; derived dictionary context is ignored. */
export function hoshidictsReaderPreferencesEqual(
    left: HoshidictsReaderPreferencesRequest,
    right: HoshidictsReaderPreferencesRequest | null
): boolean {
    if (right === null) {
        return false;
    }
    return HOSHIDICTS_READER_PREFERENCE_SPECS.every((spec) =>
        spec.equals(left[spec.key], right[spec.key])
    );
}

export interface HoshidictsAudioSource {
    id: string;
    type: HoshidictsAudioSourceType;
    url: string;
    voice: string;
}

export interface HoshidictsAudioProfile {
    version: 1;
    enabled: boolean;
    autoPlay: boolean;
    volume: number;
    sources: HoshidictsAudioSource[];
}

export interface HoshidictsAudioSourceTestRequest {
    profile: HoshidictsAudioProfile;
    sourceId: string;
}

export interface HoshidictsAudioSourceTestMedia {
    bytes: Uint8Array;
    contentType: string;
    candidateName: string;
}

export function createDefaultHoshidictsAudioProfile(): HoshidictsAudioProfile {
    return {
        version: 1,
        enabled: true,
        autoPlay: false,
        volume: 100,
        sources: [
            { id: 'jpod101', type: 'jpod101', url: '', voice: '' },
            {
                id: 'language-pod-101',
                type: 'language-pod-101',
                url: '',
                voice: '',
            },
            { id: 'jisho', type: 'jisho', url: '', voice: '' },
        ],
    };
}

export function isHoshidictsAudioSourceType(
    value: unknown
): value is HoshidictsAudioSourceType {
    return (
        typeof value === 'string' &&
        (HOSHIDICTS_AUDIO_SOURCE_TYPES as readonly string[]).includes(value)
    );
}

export interface HoshidictsMiningProfile {
    version: 3;
    enabled: boolean;
    deck: string;
    model: string;
    fields: HoshidictsMiningFields;
    disabledFields: HoshidictsMiningFieldName[];
    tags: string[];
    checkForDuplicates: boolean;
    duplicateScope: HoshidictsDuplicateScope;
    duplicateScopeCheckAllModels: boolean;
    duplicateBehavior: HoshidictsDuplicateBehavior;
    fieldOverwriteModes: HoshidictsFieldOverwriteModes;
    fieldTemplates: HoshidictsMiningFieldTemplates | null;
}

export interface HoshidictsMiningOptions {
    connected: boolean;
    gsmAnkiEnabled: boolean;
    decks: string[];
    noteTypes: string[];
    selectedNoteType: string;
    fields: string[];
    suggestedFields: HoshidictsMiningFields;
    resolvedFields: HoshidictsMiningFields;
    suggestedFieldTemplates: Record<string, string>;
    resolvedFieldTemplates: HoshidictsMiningFieldTemplates;
    warnings: string[];
    error: string | null;
}

export interface HoshidictsDictionaryState {
    id: string;
    title: string;
    displayName: string | null;
    enabled: boolean;
    favorite: boolean;
    revision: string;
    isUpdatable: boolean;
    indexUrl: string | null;
    downloadUrl: string | null;
    language: string | null;
    termCount: number;
    frequencyCount: number;
    pitchCount: number;
    kanjiCount: number;
    frequencyMode: HoshidictsFrequencyMode | null;
    installedAt: string;
    updateScheduleOverride: HoshidictsSchedule | null;
    lastUpdateCheck: string | null;
}

export interface HoshidictsRecommendedDictionaryState {
    id: HoshidictsRecommendedDictionaryId;
    installed: boolean;
}

export interface HoshidictsProgress {
    phase: HoshidictsProgressPhase;
    scope?: 'dictionary' | 'preferences' | 'mining' | 'audio' | 'custom';
    title?: string;
    completed?: number;
    total?: number;
}

export type HoshidictsYomitanImportProgress =
    | {
          phase: 'reading';
          completedBytes: number;
          totalBytes: number;
          estimatedSecondsRemaining: number | null;
      }
    | {
          phase: 'preparing' | 'importing';
          current: number;
          total: number;
          title: string;
      };

export interface HoshidictsYomitanDictionaryPreference {
    title: string;
    enabled: boolean;
}

export type HoshidictsYomitanSettingsGroup =
    | 'dictionaries'
    | 'reader'
    | 'anki'
    | 'audio';

export interface HoshidictsYomitanImportReport {
    imported: number;
    replaced: number;
    failed: number;
    settings: HoshidictsYomitanSettingsGroup[];
    warnings: string[];
}

export interface HoshidictsCustomDictionaryDocument {
    text: string;
    revision: string;
    exists: boolean;
    filePath: string;
}

export const MAX_HOSHIDICTS_PROFILE_NAME_LENGTH = 128;

export interface HoshidictsProfileSummary {
    id: string;
    name: string;
}

export interface HoshidictsManagerSnapshot
    extends HoshidictsReaderPreferencesRequest {
    revision: number;
    activeProfileId: string;
    profiles: HoshidictsProfileSummary[];
    dictionaries: HoshidictsDictionaryState[];
    tabGroups: HoshidictsDictionaryTabGroup[];
    customDictionaryActive: boolean;
    recommendedDictionaries: HoshidictsRecommendedDictionaryState[];
    miningProfile: HoshidictsMiningProfile;
    audioProfile: HoshidictsAudioProfile;
    schedule: HoshidictsSchedule;
    lastCheck: string | null;
    nextCheck: string | null;
    lastError: string | null;
    busy: boolean;
    progress: HoshidictsProgress;
}

export function hoshidictsReaderPreferencesFromSnapshot(
    snapshot: HoshidictsManagerSnapshot
): HoshidictsReaderPreferences {
    const titlesById = new Map(
        (snapshot.dictionaries ?? []).map(({ id, title }) => [id, title])
    );
    return {
        ...normalizeHoshidictsReaderPreferences(snapshot),
        dictionaryPresentation: (snapshot.dictionaries ?? []).map(
            ({ title, displayName, favorite, frequencyMode }) => {
                const entry: HoshidictsDictionaryPresentation = {
                    title,
                    favorite,
                };
                if (displayName) {
                    entry.displayName = displayName;
                }
                if (frequencyMode) {
                    entry.frequencyMode = frequencyMode;
                }
                return entry;
            }
        ),
        frequencyDictionaries: (snapshot.dictionaries ?? [])
            .filter(({ enabled, frequencyCount }) =>
                enabled && frequencyCount > 0
            )
            .map(({ title }) => title),
        dictionaryTabGroups: (snapshot.tabGroups ?? []).map(
            ({ id, name, dictionaryIds }) => ({
                id,
                name,
                dictionaries: dictionaryIds.flatMap((dictionaryId) => {
                    const title = titlesById.get(dictionaryId);
                    return title ? [title] : [];
                }),
            })
        ),
    };
}

export interface HoshidictsDesktopSnapshot extends HoshidictsManagerSnapshot {
    effectiveEnabled: boolean;
    overlay: {
        running: boolean;
        restartRequired: boolean;
    };
}

export interface HoshidictsActionResult {
    success: boolean;
    canceled?: boolean;
    error?: string | null;
    outcome?: {
        code:
            | 'preferencesSaved'
            | 'miningProfileSaved'
            | 'audioProfileSaved'
            | 'profileCreated'
            | 'profileSwitched'
            | 'profileRenamed'
            | 'profileDeleted'
            | 'dictionaryImported'
            | 'yomitanDictionariesImported'
            | 'yomitanSettingsImported'
            | 'backupExported'
            | 'backupRestored'
            | 'recommendedInstalled'
            | 'updatesChecked'
            | 'dictionaryRemoved'
            | 'dictionaryChanged'
            | 'customDictionarySaved'
            | 'overlayRestarted';
        count?: number;
        title?: string;
    };
    document?: HoshidictsCustomDictionaryDocument;
    yomitanReport?: HoshidictsYomitanImportReport;
    state: HoshidictsDesktopSnapshot;
}

export interface HoshidictsAudioSourceTestResult {
    success: boolean;
    error?: string | null;
    audio?: HoshidictsAudioSourceTestMedia;
    state: HoshidictsDesktopSnapshot;
}

export interface HoshidictsDictionaryEnabledRequest {
    id: string;
    enabled: boolean;
}

export interface HoshidictsCreateProfileRequest {
    name: string;
}

export interface HoshidictsProfileIdRequest {
    id: string;
}

export interface HoshidictsRenameProfileRequest extends HoshidictsProfileIdRequest {
    name: string;
}

export interface HoshidictsDictionaryPresentationRequest {
    id: string;
    favorite: boolean;
}

export type HoshidictsBulkDictionaryAction =
    | 'enable'
    | 'disable'
    | 'favorite'
    | 'unfavorite'
    | 'update';

export interface HoshidictsBulkDictionaryActionRequest {
    action: HoshidictsBulkDictionaryAction;
    ids: string[];
}

export interface HoshidictsCreateTabGroupRequest {
    name: string;
    dictionaryId?: string;
}

export interface HoshidictsSetTabGroupMembershipRequest {
    groupId: string;
    dictionaryId: string;
    member: boolean;
}

export interface HoshidictsRenameTabGroupRequest {
    groupId: string;
    name: string;
}

export interface HoshidictsDeleteTabGroupRequest {
    groupId: string;
}

export interface HoshidictsMoveTabGroupRequest {
    groupId: string;
    direction: HoshidictsMoveDirection;
}

export interface HoshidictsDictionaryScheduleRequest {
    id: string;
    schedule: HoshidictsSchedule | null;
}

export interface HoshidictsRenameDictionaryRequest {
    id: string;
    displayName: string | null;
}

export interface HoshidictsMoveDictionaryRequest {
    id: string;
    direction: HoshidictsMoveDirection;
}

export interface HoshidictsMoveDictionaryToPositionRequest {
    id: string;
    position: number;
}

export interface HoshidictsInstallRecommendedRequest {
    id: HoshidictsRecommendedDictionaryId;
}

export interface HoshidictsSaveCustomDictionaryRequest {
    text: string;
    expectedRevision: string;
}

export type HoshidictsCustomEntryRequest = HoshidictsCustomDictionaryEntry;
