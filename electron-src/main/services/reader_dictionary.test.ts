import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { once: vi.fn() }, BrowserWindow: vi.fn(), session: {}, shell: {} }));
vi.mock('../util.js', () => ({ getOverlayResourcesPath: () => '', getResourcesDir: () => '', isDev: true }));
vi.mock('../overlay_data_dir.js', () => ({ getOverlayDataPath: () => '' }));
import { dictionaryText, normalizeDictionaryResult } from './reader_dictionary';

describe('desktop dictionary results', () => {
    it('renders structured Yomitan definitions as text, with no executable markup', () => {
        expect(normalizeDictionaryResult({ originalTextLength: 2, dictionaryEntries: [{ headwords: [{ term: '言葉', reading: 'ことば' }], definitions: [{ dictionary: 'Example', entries: [{ type: 'structured-content', content: [{ tag: 'div', content: 'word' }, { tag: 'script', src: 'javascript:bad' }] }] }] }] }, 'yomitan')).toEqual({ reader: 'yomitan', matchedLength: 2, entries: [{ term: '言葉', reading: 'ことば', dictionary: 'Example', definitions: ['word'] }] });
    });
    it('reads Hachidori term groups and serialized glossaries', () => {
        expect(normalizeDictionaryResult({ results: [{ matched: '言葉', term: { expression: '言葉', reading: 'ことば', glossaries: [{ dictionary: 'Example', glossary: '["word", "language"]' }] } }] }, 'hachidori').entries).toEqual([{ term: '言葉', reading: 'ことば', dictionary: 'Example', definitions: ['word', 'language'] }]);
    });
    it('handles malformed results and bounded recursive content', () => {
        expect(normalizeDictionaryResult({ results: [null] }, 'hachidori').entries).toEqual([]);
        const circular: any = {}; circular.content = circular;
        expect(dictionaryText(circular)).toBe('');
    });
});
