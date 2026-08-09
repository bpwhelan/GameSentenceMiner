import { describe, expect, it } from 'vitest';

import {
    createDefaultHoshidictsPopupButtons,
    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    HOSHIDICTS_MINING_FIELD_MARKERS,
    isHoshidictsPopupButtons,
    isHoshidictsPopupCustomLinkTemplate,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS,
    MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH,
    normalizeHoshidictsPopupButtons,
} from './hoshidicts.js';

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
            {
                id: 'sentence-furigana',
                value: '{sentence-furigana}',
            },
            {
                id: 'sentence-furigana-plain',
                value: '{sentence-furigana-plain}',
            },
            { id: 'frequency', value: '{frequency}' },
            { id: 'pitch', value: '{pitch}' },
            { id: 'pitch-position', value: '{pitch-position}' },
            { id: 'audio', value: '{audio}' },
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

    it('accepts only credential-free absolute HTTP templates', () => {
        expect(
            isHoshidictsPopupCustomLinkTemplate(
                'https://example.com/?word=%w&sentence=%s'
            )
        ).toBe(true);
        expect(isHoshidictsPopupCustomLinkTemplate('http://localhost/%w')).toBe(
            true
        );
        expect(isHoshidictsPopupCustomLinkTemplate('/search/%w')).toBe(false);
        expect(isHoshidictsPopupCustomLinkTemplate('javascript:alert(1)')).toBe(
            false
        );
        expect(
            isHoshidictsPopupCustomLinkTemplate(
                'https://user:secret@example.com/%w'
            )
        ).toBe(false);
        expect(
            isHoshidictsPopupCustomLinkTemplate(
                `https://example.com/${'x'.repeat(
                    MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH
                )}`
            )
        ).toBe(false);
    });

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
});
