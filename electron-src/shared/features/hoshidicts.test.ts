import { describe, expect, it } from 'vitest';

import {
    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
    HOSHIDICTS_MINING_FIELD_MARKERS,
} from './hoshidicts.js';

describe('Hoshidicts mining field markers', () => {
    it('exposes every supported marker to renderer controls', () => {
        expect(HOSHIDICTS_MINING_FIELD_MARKERS).toEqual([
            { id: 'expression', value: '{expression}' },
            { id: 'reading', value: '{reading}' },
            { id: 'furigana', value: '{furigana}' },
            { id: 'definition', value: '{definition}' },
            { id: 'main-definition', value: '{main-definition}' },
            { id: 'glossary', value: '{glossary}' },
            { id: 'dictionary', value: '{dictionary}' },
            { id: 'sentence', value: '{sentence}' },
            {
                id: 'sentence-furigana',
                value: '{sentence-furigana}',
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
