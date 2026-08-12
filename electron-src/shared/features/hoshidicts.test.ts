import { describe, expect, it } from 'vitest';

import {
    assertHoshidictsReaderPreferences,
    cloneHoshidictsReaderPreferences,
    createDefaultHoshidictsPopupButtons,
    createDefaultHoshidictsReaderPreferences,
    DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    HOSHIDICTS_MINING_FIELD_MARKERS,
    hoshidictsDefinitionBlurEqual,
    hoshidictsPopupButtonsEqual,
    hoshidictsReaderPreferencesEqual,
    hoshidictsReaderPreferencesFromSnapshot,
    isHoshidictsPopupButtons,
    isHoshidictsPopupCustomLinkTemplate,
    isHoshidictsReaderPreferences,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH,
    normalizeHoshidictsPopupButtons,
    normalizeHoshidictsReaderPreferences,
    type HoshidictsDictionaryState,
    type HoshidictsManagerSnapshot,
    type HoshidictsReaderPreferencesRequest,
} from './hoshidicts.js';

const defaultPreferences = createDefaultHoshidictsReaderPreferences();
const preferenceFields = Object.keys(
    defaultPreferences
) as (keyof HoshidictsReaderPreferencesRequest)[];

/** A second, distinct value for every reader preference. */
const otherPreferences: Record<
    keyof HoshidictsReaderPreferencesRequest,
    unknown
> = {
    lookupMode: 'hover',
    scanLength: 24,
    maxResults: 48,
    sortFrequencyDictionary: 'Frequency',
    sortFrequencyDictionaryOrder: 'ascending',
    activationKey: 'F8',
    sourceHighlightEnabled: true,
    onlyScanJapaneseText: false,
    popupHideDelayMs: 900,
    showLookupCounts: false,
    averageFrequency: true,
    showFrequencyDictionaryNames: false,
    showCompactDefinitionSummary: true,
    compactDefinitionSummaryCount: 4,
    compactDefinitionSummaryDictionary: 'Jitendex',
    showPitchAccentFurigana: false,
    pitchAccentFuriganaDictionary: 'Kanjium Pitch Accents',
    showPitchAccentBadge: true,
    hidePopupGrammarTags: false,
    popupNestingMaxDepth: 4,
    definitionBlur: {
        enabled: true,
        lookupThreshold: 8,
        revealMode: 'hover',
        revealDelayMs: 7000,
    },
    popupWidthPx: 720,
    popupHeightPx: 520,
    popupColumns: 3,
    theme: 'girlypop',
    popupOpacityPercent: 70,
    popupBackdropBlurPx: 24,
    popupToolbarPosition: 'bottom',
    popupButtons: {
        ...createDefaultHoshidictsPopupButtons(),
        viewInAnki: true,
    },
    customPopupCss: ':scope { color: hotpink; }',
};

function dictionary(
    title: string,
    overrides: Partial<HoshidictsDictionaryState> = {}
): HoshidictsDictionaryState {
    return {
        id: title.toLowerCase(),
        title,
        displayName: null,
        enabled: true,
        favorite: false,
        revision: '1',
        isUpdatable: false,
        indexUrl: null,
        downloadUrl: null,
        language: 'ja',
        termCount: 0,
        frequencyCount: 0,
        pitchCount: 0,
        kanjiCount: 0,
        frequencyMode: null,
        installedAt: '2026-08-09T00:00:00.000Z',
        updateScheduleOverride: null,
        lastUpdateCheck: null,
        ...overrides,
    };
}

describe('Hoshidicts mining field markers', () => {
    it('exposes every supported marker to renderer controls', () => {
        expect(HOSHIDICTS_MINING_FIELD_MARKERS).toEqual([
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
            {
                id: 'sentence-furigana',
                value: '{sentence-furigana}',
            },
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
        ]);
    });

    it('installs Jitendex and JMdict as the default term dictionaries', () => {
        expect(DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.slice(0, 2)).toEqual([
            'jitendex',
            'jmdict',
        ]);
    });
});

describe('Hoshidicts popup buttons', () => {
    it('keeps the existing three actions enabled by default', () => {
        expect(createDefaultHoshidictsPopupButtons()).toEqual({
            addToAnki: true,
            audio: true,
            customDefinition: true,
            viewInAnki: false,
            customLinks: [],
        });
    });

    it('normalizes labels and URL templates using word and sentence placeholders', () => {
        expect(
            normalizeHoshidictsPopupButtons({
                addToAnki: false,
                audio: true,
                customDefinition: false,
                viewInAnki: true,
                customLinks: [
                    {
                        label: '  Jisho  ',
                        url: '  https://jisho.org/search/%w?sentence=%s  ',
                    },
                ],
            })
        ).toEqual({
            addToAnki: false,
            audio: true,
            customDefinition: false,
            viewInAnki: true,
            customLinks: [
                {
                    label: 'Jisho',
                    url: 'https://jisho.org/search/%w?sentence=%s',
                },
            ],
        });
    });

    it.each([
        ['https://example.com/?word=%w&sentence=%s', true],
        ['http://localhost/%w', true],
        ['/search/%w', false],
        ['javascript:alert(1)', false],
        ['https://user:secret@example.com/%w', false],
        [
            `https://example.com/${'x'.repeat(
                MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH
            )}`,
            false,
        ],
    ])(
        'accepts only credential-free absolute HTTP templates (%s)',
        (template, accepted) => {
            expect(isHoshidictsPopupCustomLinkTemplate(template)).toBe(accepted);
        }
    );

    it('rejects malformed profiles and more than eight custom links', () => {
        const customLinks = Array.from(
            { length: MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS + 1 },
            (_, index) => ({
                label: `Link ${index}`,
                url: 'https://example.com/%w',
            })
        );
        const profile = {
            ...createDefaultHoshidictsPopupButtons(),
            customLinks,
        };
        expect(isHoshidictsPopupButtons(profile)).toBe(false);
        expect(() => normalizeHoshidictsPopupButtons(profile)).toThrow(
            'custom links are invalid'
        );
        expect(() =>
            normalizeHoshidictsPopupButtons({
                ...createDefaultHoshidictsPopupButtons(),
                customLinks: [
                    {
                        label: 'x'.repeat(
                            MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH + 1
                        ),
                        url: 'https://example.com/%w',
                    },
                ],
            })
        ).toThrow('label is invalid');
    });

    it.each([
        ['addToAnki', { addToAnki: false }, false],
        ['audio', { audio: false }, false],
        ['customDefinition', { customDefinition: false }, false],
        ['viewInAnki', { viewInAnki: true }, false],
        [
            'customLinks',
            { customLinks: [{ label: 'Jisho', url: 'https://jisho.org/%w' }] },
            false,
        ],
        ['nothing', {}, true],
    ])('compares popup button %s', (_field, overrides, equal) => {
        expect(
            hoshidictsPopupButtonsEqual(createDefaultHoshidictsPopupButtons(), {
                ...createDefaultHoshidictsPopupButtons(),
                ...overrides,
            })
        ).toBe(equal);
    });
});

describe('Hoshidicts reader preference helpers', () => {
    it('creates one default value per preference', () => {
        expect(defaultPreferences).toEqual({
            lookupMode: 'shift',
            scanLength: 16,
            maxResults: 32,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
            activationKey: 'Shift',
            sourceHighlightEnabled: false,
            onlyScanJapaneseText: true,
            popupHideDelayMs: 300,
            showLookupCounts: true,
            averageFrequency: false,
            showFrequencyDictionaryNames: true,
            showCompactDefinitionSummary: false,
            compactDefinitionSummaryCount: 3,
            compactDefinitionSummaryDictionary: null,
            showPitchAccentFurigana: true,
            pitchAccentFuriganaDictionary: null,
            showPitchAccentBadge: false,
            hidePopupGrammarTags: true,
            popupNestingMaxDepth: 10,
            definitionBlur: {
                enabled: false,
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
            popupWidthPx: 560,
            popupHeightPx: 420,
            popupColumns: 1,
            theme: 'default',
            popupOpacityPercent: 85,
            popupBackdropBlurPx: 16,
            popupToolbarPosition: 'top',
            popupButtons: createDefaultHoshidictsPopupButtons(),
            customPopupCss: '',
        });
        expect(isHoshidictsReaderPreferences(defaultPreferences)).toBe(true);
    });

    it('canonicalizes an accepted request and drops unrelated keys', () => {
        const accepted = assertHoshidictsReaderPreferences({
            ...defaultPreferences,
            compactDefinitionSummaryDictionary: '  Jitendex  ',
            pitchAccentFuriganaDictionary: '  Pitch  ',
            popupButtons: {
                ...createDefaultHoshidictsPopupButtons(),
                customLinks: [
                    { label: '  Jisho  ', url: '  https://jisho.org/%w  ' },
                ],
            },
            unrelated: 'ignored',
        });

        expect(accepted).toEqual({
            ...defaultPreferences,
            compactDefinitionSummaryDictionary: 'Jitendex',
            pitchAccentFuriganaDictionary: 'Pitch',
            popupButtons: {
                ...createDefaultHoshidictsPopupButtons(),
                customLinks: [
                    { label: 'Jisho', url: 'https://jisho.org/%w' },
                ],
            },
        });
        expect(Object.keys(accepted)).not.toContain('unrelated');
    });

    it.each([null, 'preferences', 42, []])(
        'rejects %j as a preferences object',
        (value) => {
            expect(() => assertHoshidictsReaderPreferences(value)).toThrow(
                'Hoshidicts reader preferences are invalid.'
            );
            expect(isHoshidictsReaderPreferences(value)).toBe(false);
        }
    );

    it.each(preferenceFields)('requires %s to be present', (field) => {
        const request: Record<string, unknown> = { ...defaultPreferences };
        delete request[field];

        expect(() => assertHoshidictsReaderPreferences(request)).toThrow(
            / (is|are) invalid\.$/u
        );
        expect(isHoshidictsReaderPreferences(request)).toBe(false);
    });

    it.each(preferenceFields)(
        'replaces an unusable persisted %s with its default',
        (field) => {
            const normalized = normalizeHoshidictsReaderPreferences({
                ...defaultPreferences,
                [field]: Symbol('unusable'),
            });

            expect(normalized).toEqual(defaultPreferences);
        }
    );

    it('normalizes a completely unusable value to the defaults', () => {
        expect(normalizeHoshidictsReaderPreferences(null)).toEqual(
            defaultPreferences
        );
        expect(normalizeHoshidictsReaderPreferences('nope')).toEqual(
            defaultPreferences
        );
    });

    it('clones nested preference objects instead of sharing them', () => {
        const original = createDefaultHoshidictsReaderPreferences();
        const copy = cloneHoshidictsReaderPreferences(original);

        copy.definitionBlur.enabled = true;
        copy.popupButtons.customLinks.push({
            label: 'Jisho',
            url: 'https://jisho.org/%w',
        });

        expect(original.definitionBlur.enabled).toBe(false);
        expect(original.popupButtons.customLinks).toEqual([]);
    });

    // Guards against a preference being left out of the comparison, which would
    // silently stop the settings window asking for an overlay restart.
    it.each(preferenceFields)('compares %s for equality', (field) => {
        expect(
            hoshidictsReaderPreferencesEqual(defaultPreferences, {
                ...defaultPreferences,
                [field]: otherPreferences[field],
            } as HoshidictsReaderPreferencesRequest)
        ).toBe(false);
    });

    it('treats identical preferences as equal and a missing overlay state as unequal', () => {
        expect(
            hoshidictsReaderPreferencesEqual(
                defaultPreferences,
                createDefaultHoshidictsReaderPreferences()
            )
        ).toBe(true);
        expect(
            hoshidictsReaderPreferencesEqual(defaultPreferences, null)
        ).toBe(false);
    });

    it.each([
        ['enabled', { enabled: true }, false],
        ['lookupThreshold', { lookupThreshold: 8 }, false],
        ['revealMode', { revealMode: 'hover' as const }, false],
        ['revealDelayMs', { revealDelayMs: 7000 }, false],
        ['nothing', {}, true],
    ])('compares definition blur %s', (_field, overrides, equal) => {
        expect(
            hoshidictsDefinitionBlurEqual(defaultPreferences.definitionBlur, {
                ...defaultPreferences.definitionBlur,
                ...overrides,
            })
        ).toBe(equal);
    });
});

describe('Hoshidicts reader preferences from a snapshot', () => {
    it('preserves snapshot order while excluding disabled and non-frequency dictionaries', () => {
        const snapshot = {
            dictionaries: [
                dictionary('Foo', { frequencyCount: 1 }),
                dictionary('Term dictionary'),
                dictionary('Disabled frequency', {
                    enabled: false,
                    frequencyCount: 4,
                }),
                dictionary('Foo!', { frequencyCount: 2 }),
            ],
            popupButtons: createDefaultHoshidictsPopupButtons(),
        } as unknown as HoshidictsManagerSnapshot;

        expect(
            hoshidictsReaderPreferencesFromSnapshot(snapshot)
                .frequencyDictionaries
        ).toEqual(['Foo', 'Foo!']);
    });

    it('projects dictionary presentation and tab groups by title', () => {
        const snapshot = {
            dictionaries: [
                dictionary('Alpha', {
                    id: 'alpha',
                    favorite: true,
                    displayName: 'Friendly Alpha',
                    frequencyMode: 'rank-based',
                }),
                dictionary('Beta', { id: 'beta' }),
            ],
            tabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaryIds: ['alpha', 'beta', 'missing'],
                },
            ],
            popupButtons: createDefaultHoshidictsPopupButtons(),
        } as unknown as HoshidictsManagerSnapshot;

        expect(hoshidictsReaderPreferencesFromSnapshot(snapshot)).toMatchObject({
            dictionaryPresentation: [
                {
                    title: 'Alpha',
                    favorite: true,
                    displayName: 'Friendly Alpha',
                    frequencyMode: 'rank-based',
                },
                { title: 'Beta', favorite: false },
            ],
            dictionaryTabGroups: [
                {
                    id: 'group-grammar',
                    name: 'Grammar',
                    dictionaries: ['Alpha', 'Beta'],
                },
            ],
        });
    });

    it('projects compact definition, pitch, and metadata preferences into the overlay', () => {
        const snapshot = {
            dictionaries: [],
            tabGroups: [],
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryCount: 4,
            compactDefinitionSummaryDictionary: 'Jitendex.org',
            showPitchAccentFurigana: false,
            pitchAccentFuriganaDictionary: 'Kanjium Pitch Accents',
            showPitchAccentBadge: true,
            hidePopupGrammarTags: true,
            popupBackdropBlurPx: 24,
            popupButtons: createDefaultHoshidictsPopupButtons(),
        } as unknown as HoshidictsManagerSnapshot;

        expect(hoshidictsReaderPreferencesFromSnapshot(snapshot)).toMatchObject({
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryCount: 4,
            compactDefinitionSummaryDictionary: 'Jitendex.org',
            showPitchAccentFurigana: false,
            pitchAccentFuriganaDictionary: 'Kanjium Pitch Accents',
            showPitchAccentBadge: true,
            hidePopupGrammarTags: true,
            popupBackdropBlurPx: 24,
        });
        expect(
            hoshidictsReaderPreferencesFromSnapshot({
                ...snapshot,
                popupBackdropBlurPx: undefined,
            } as unknown as HoshidictsManagerSnapshot).popupBackdropBlurPx
        ).toBe(DEFAULT_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX);
    });
});
