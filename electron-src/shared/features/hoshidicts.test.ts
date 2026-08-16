import { describe, expect, it } from 'vitest';

import {
    assertHoshidictsReaderPreferences,
    MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH,
    cloneHoshidictsReaderPreferences,
    createDefaultHoshidictsPopupButtons,
    createDefaultHoshidictsReaderPreferences,
    HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    HOSHIDICTS_MINING_FIELD_MARKERS,
    hoshidictsDefinitionBlurEqual,
    hoshidictsPopupButtonsEqual,
    hoshidictsReaderPreferencesEqual,
    hoshidictsReaderPreferencesFromSnapshot,
    isHoshidictsPopupButtons,
    isHoshidictsPopupCustomLinkTemplate,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH,
    normalizeHoshidictsPopupButtons,
    normalizeHoshidictsReaderPreferences,
    projectHoshidictsResultsToSelectedDictionary,
    resolveHoshidictsPopupImageSourceDictionaries,
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
    kanjiClickDictionary: 'JMdict',
    popupImageSource: { kind: 'dictionary', title: 'Jitendex' },
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
        mediaCount: 0,
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
        expect(HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.slice(0, 2)).toEqual([
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
            kanjiClickDictionary: null,
            popupImageSource: null,
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
            popupToolbarPosition: 'auto',
            popupButtons: createDefaultHoshidictsPopupButtons(),
            customPopupCss: '',
        });
    });

    it('canonicalizes an accepted request and drops unrelated keys', () => {
        const accepted = assertHoshidictsReaderPreferences({
            ...defaultPreferences,
            compactDefinitionSummaryDictionary: '  Jitendex  ',
            kanjiClickDictionary: '  JMdict  ',
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
            kanjiClickDictionary: 'JMdict',
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
        }
    );

    it.each(preferenceFields)('requires %s to be present', (field) => {
        const request: Record<string, unknown> = { ...defaultPreferences };
        delete request[field];

        expect(() => assertHoshidictsReaderPreferences(request)).toThrow(
            / (is|are) invalid\.$/u
        );
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

describe('Hoshidicts popup image source preference', () => {
    it('defaults to Automatic (null)', () => {
        expect(defaultPreferences.popupImageSource).toBeNull();
    });

    it('accepts and canonicalizes an individual dictionary source, trimming its title', () => {
        const accepted = assertHoshidictsReaderPreferences({
            ...defaultPreferences,
            popupImageSource: { kind: 'dictionary', title: '  Jitendex  ' },
        });
        expect(accepted.popupImageSource).toEqual({
            kind: 'dictionary',
            title: 'Jitendex',
        });
    });

    it('accepts a tab-group source by id and drops extra keys', () => {
        const accepted = assertHoshidictsReaderPreferences({
            ...defaultPreferences,
            popupImageSource: {
                kind: 'tabGroup',
                id: 'group-grammar',
                title: 'ignored',
            },
        });
        expect(accepted.popupImageSource).toEqual({
            kind: 'tabGroup',
            id: 'group-grammar',
        });
    });

    it.each([
        ['unknown kind', { kind: 'nope', title: 'x' }],
        ['dictionary without title', { kind: 'dictionary' }],
        ['dictionary with blank title', { kind: 'dictionary', title: '   ' }],
        ['dictionary with non-string title', { kind: 'dictionary', title: 42 }],
        ['tab group without id', { kind: 'tabGroup' }],
        ['tab group with blank id', { kind: 'tabGroup', id: '   ' }],
        ['a bare string', 'Jitendex'],
        ['an array', []],
    ])('rejects %s', (_label, value) => {
        expect(() =>
            assertHoshidictsReaderPreferences({
                ...defaultPreferences,
                popupImageSource: value,
            })
        ).toThrow('popup image source is invalid');
    });

    it('normalizes an unusable source back to Automatic', () => {
        expect(
            normalizeHoshidictsReaderPreferences({
                ...defaultPreferences,
                popupImageSource: { kind: 'tabGroup' },
            }).popupImageSource
        ).toBeNull();
    });

    it('compares two sources for equality by kind and identity', () => {
        expect(
            hoshidictsReaderPreferencesEqual(defaultPreferences, {
                ...defaultPreferences,
                popupImageSource: { kind: 'dictionary', title: 'A' },
            } as HoshidictsReaderPreferencesRequest)
        ).toBe(false);
        expect(
            hoshidictsReaderPreferencesEqual(
                {
                    ...defaultPreferences,
                    popupImageSource: { kind: 'dictionary', title: 'A' },
                } as HoshidictsReaderPreferencesRequest,
                {
                    ...defaultPreferences,
                    popupImageSource: { kind: 'dictionary', title: 'A' },
                } as HoshidictsReaderPreferencesRequest
            )
        ).toBe(true);
        expect(
            hoshidictsReaderPreferencesEqual(
                {
                    ...defaultPreferences,
                    popupImageSource: { kind: 'dictionary', title: 'A' },
                } as HoshidictsReaderPreferencesRequest,
                {
                    ...defaultPreferences,
                    popupImageSource: { kind: 'tabGroup', id: 'A' },
                } as HoshidictsReaderPreferencesRequest
            )
        ).toBe(false);
    });
});

describe('resolveHoshidictsPopupImageSourceDictionaries', () => {
    const tabGroups = [
        { id: 'g1', name: 'Group 1', dictionaries: ['Alpha', 'Beta', 'Gamma'] },
    ];

    it('returns null (all dictionaries permitted) for Automatic', () => {
        expect(
            resolveHoshidictsPopupImageSourceDictionaries(null, tabGroups)
        ).toBeNull();
    });

    it('returns the single title for an individual dictionary source', () => {
        expect(
            resolveHoshidictsPopupImageSourceDictionaries(
                { kind: 'dictionary', title: 'Beta' },
                tabGroups
            )
        ).toEqual(['Beta']);
    });

    it('returns the group members in their established order for a tab-group source', () => {
        expect(
            resolveHoshidictsPopupImageSourceDictionaries(
                { kind: 'tabGroup', id: 'g1' },
                tabGroups
            )
        ).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('resolves a missing or deleted tab group to an empty allowlist (no images)', () => {
        expect(
            resolveHoshidictsPopupImageSourceDictionaries(
                { kind: 'tabGroup', id: 'gone' },
                tabGroups
            )
        ).toEqual([]);
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

    it('carries per-dictionary term and kanji counts into the presentation context', () => {
        const snapshot = {
            dictionaries: [
                dictionary('ゴブリンじゃない人のJPDB漢字辞典', {
                    id: 'jpdb-kanji-terms',
                    termCount: 20409,
                    kanjiCount: 0,
                    mediaCount: 512,
                }),
                dictionary('KANJIDIC (English)', {
                    id: 'kanjidic',
                    termCount: 0,
                    kanjiCount: 13108,
                    mediaCount: 0,
                }),
            ],
            tabGroups: [],
            popupButtons: createDefaultHoshidictsPopupButtons(),
        } as unknown as HoshidictsManagerSnapshot;

        expect(
            hoshidictsReaderPreferencesFromSnapshot(snapshot)
                .dictionaryPresentation
        ).toEqual([
            {
                title: 'ゴブリンじゃない人のJPDB漢字辞典',
                favorite: false,
                termCount: 20409,
                kanjiCount: 0,
                mediaCount: 512,
            },
            {
                title: 'KANJIDIC (English)',
                favorite: false,
                termCount: 0,
                kanjiCount: 13108,
                mediaCount: 0,
            },
        ]);
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
        });
    });

    // Relocated from manager.test.ts: these bounds belong beside the validator
    // that owns them, so a change to a MIN_/MAX_ constant fails here first.
    it.each([
        ['lookupMode', 'automatic', 'lookup mode is invalid'],
        ['scanLength', 0, 'scan length is invalid'],
        ['scanLength', 65, 'scan length is invalid'],
        ['scanLength', 1.5, 'scan length is invalid'],
        ['maxResults', 0, 'maximum result count is invalid'],
        ['maxResults', 257, 'maximum result count is invalid'],
        [
            'sortFrequencyDictionary',
            '',
            'frequency sort dictionary is invalid',
        ],
        [
            'sortFrequencyDictionary',
            'x'.repeat(4097),
            'frequency sort dictionary is invalid',
        ],
        ['sortFrequencyDictionary', 42, 'frequency sort dictionary is invalid'],
        [
            'sortFrequencyDictionaryOrder',
            'random',
            'frequency sort order is invalid',
        ],
        ['popupHideDelayMs', -1, 'popup hide delay is invalid'],
        ['popupHideDelayMs', 5001, 'popup hide delay is invalid'],
        ['activationKey', 'MediaPlayPause', 'activation key is invalid'],
        [
            'sourceHighlightEnabled',
            'yes',
            'source highlight preference is invalid',
        ],
        [
            'onlyScanJapaneseText',
            'yes',
            'Japanese-only scan preference is invalid',
        ],
        ['popupToolbarPosition', 'side', 'toolbar position is invalid'],
        [
            'popupButtons',
            {
                addToAnki: true,
                audio: true,
                customDefinition: true,
                viewInAnki: false,
                customLinks: [{ label: 'Unsafe', url: 'file:///tmp/word' }],
            },
            'popup buttons are invalid',
        ],
        ['showLookupCounts', 'yes', 'lookup count preference is invalid'],
        ['averageFrequency', 'yes', 'average frequency preference is invalid'],
        [
            'showFrequencyDictionaryNames',
            'yes',
            'frequency dictionary name preference is invalid',
        ],
        [
            'showCompactDefinitionSummary',
            'yes',
            'compact definition summary preference is invalid',
        ],
        [
            'compactDefinitionSummaryCount',
            0,
            'compact definition summary count is invalid',
        ],
        [
            'compactDefinitionSummaryCount',
            7,
            'compact definition summary count is invalid',
        ],
        [
            'compactDefinitionSummaryCount',
            1.5,
            'compact definition summary count is invalid',
        ],
        [
            'compactDefinitionSummaryDictionary',
            '',
            'compact definition summary dictionary is invalid',
        ],
        [
            'compactDefinitionSummaryDictionary',
            '   ',
            'compact definition summary dictionary is invalid',
        ],
        [
            'compactDefinitionSummaryDictionary',
            'x'.repeat(4097),
            'compact definition summary dictionary is invalid',
        ],
        [
            'showPitchAccentFurigana',
            'yes',
            'pitch accent furigana preference is invalid',
        ],
        [
            'pitchAccentFuriganaDictionary',
            '',
            'pitch accent furigana dictionary is invalid',
        ],
        [
            'pitchAccentFuriganaDictionary',
            '   ',
            'pitch accent furigana dictionary is invalid',
        ],
        [
            'pitchAccentFuriganaDictionary',
            'x'.repeat(4097),
            'pitch accent furigana dictionary is invalid',
        ],
        [
            'showPitchAccentBadge',
            'yes',
            'pitch accent badge preference is invalid',
        ],
        [
            'hidePopupGrammarTags',
            'yes',
            'popup grammar tag preference is invalid',
        ],
        ['popupNestingMaxDepth', -1, 'popup nesting depth is invalid'],
        ['popupNestingMaxDepth', 1.5, 'popup nesting depth is invalid'],
        [
            'popupNestingMaxDepth',
            Number.MAX_SAFE_INTEGER + 1,
            'popup nesting depth is invalid',
        ],
        [
            'definitionBlur',
            {
                enabled: 'yes',
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
            'definition blur enabled state is invalid',
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 0,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
            'lookup threshold is invalid',
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 1_000_001,
                revealMode: 'timed',
                revealDelayMs: 5000,
            },
            'lookup threshold is invalid',
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'click',
                revealDelayMs: 5000,
            },
            'reveal mode is invalid',
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 999,
            },
            'reveal delay is invalid',
        ],
        [
            'definitionBlur',
            {
                enabled: true,
                lookupThreshold: 5,
                revealMode: 'timed',
                revealDelayMs: 3_600_001,
            },
            'reveal delay is invalid',
        ],
        ['popupWidthPx', 279, 'popup width is invalid'],
        ['popupWidthPx', 1201, 'popup width is invalid'],
        ['popupHeightPx', 199, 'popup height is invalid'],
        ['popupHeightPx', 901, 'popup height is invalid'],
        ['popupColumns', 0, 'popup column count is invalid'],
        ['popupColumns', 5, 'popup column count is invalid'],
        ['theme', 'neon', 'theme is invalid'],
        ['popupOpacityPercent', -1, 'popup opacity is invalid'],
        ['popupOpacityPercent', 101, 'popup opacity is invalid'],
        ['popupOpacityPercent', 70.5, 'popup opacity is invalid'],
        ['customPopupCss', 42, 'custom popup CSS is invalid'],
        [
            'customPopupCss',
            'x'.repeat(MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH + 1),
            'custom popup CSS is invalid',
        ],
        ['popupImageSource', 'Jitendex', 'popup image source is invalid'],
        [
            'popupImageSource',
            { kind: 'dictionary' },
            'popup image source is invalid',
        ],
        [
            'popupImageSource',
            { kind: 'tabGroup', id: '  ' },
            'popup image source is invalid',
        ],
    ])(
        'rejects %s = %j with "%s"',
        (field, value, message) => {
            expect(() =>
                assertHoshidictsReaderPreferences({
                    ...defaultPreferences,
                    [field as string]: value,
                })
            ).toThrow(message as string);
        }
    );

});

describe('projectHoshidictsResultsToSelectedDictionary', () => {
    const glossary = (dictionary: string, text: string) => ({
        dictionary,
        glossary: text,
        definitionTags: '',
        termTags: '',
    });
    const result = (
        expression: string,
        glossaries: ReturnType<typeof glossary>[]
    ) => ({
        matched: expression,
        deinflected: expression,
        trace: [],
        term: {
            expression,
            reading: expression,
            rules: '',
            score: 0,
            glossaries,
            frequencies: [],
            pitches: [],
        },
    });

    it('keeps only glossaries from the selected dictionary and drops empty results', () => {
        const results = [
            result('一', [
                glossary('ゴブリンじゃない人のJPDB漢字辞典', 'one; single'),
                glossary('JMdict', 'ignored'),
            ]),
            result('二', [glossary('JMdict', 'two')]),
        ];

        expect(
            projectHoshidictsResultsToSelectedDictionary(
                results,
                'ゴブリンじゃない人のJPDB漢字辞典'
            )
        ).toEqual([
            result('一', [
                glossary('ゴブリンじゃない人のJPDB漢字辞典', 'one; single'),
            ]),
        ]);
    });

    it('does not mutate the source results or their glossary arrays', () => {
        const original = result('一', [
            glossary('ゴブリンじゃない人のJPDB漢字辞典', 'one'),
            glossary('JMdict', 'ignored'),
        ]);
        const results = [original];
        const originalGlossaries = original.term.glossaries;

        projectHoshidictsResultsToSelectedDictionary(
            results,
            'ゴブリンじゃない人のJPDB漢字辞典'
        );

        expect(results).toHaveLength(1);
        expect(original.term.glossaries).toBe(originalGlossaries);
        expect(original.term.glossaries).toHaveLength(2);
    });

    it('returns an empty array when no glossary matches the selection', () => {
        const results = [result('一', [glossary('JMdict', 'one')])];

        expect(
            projectHoshidictsResultsToSelectedDictionary(results, 'Missing')
        ).toEqual([]);
    });
});
