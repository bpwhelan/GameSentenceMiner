import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES } from '../../../shared/features/hoshidicts.js';
import {
    customDictionarySourceRevision,
    parseCustomDictionary,
    serializeCustomDictionaryEntry,
    writeCustomDictionaryArchive,
} from './custom_dictionary.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-custom-dict-'));
    tempDirs.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('custom Hoshidicts source format', () => {
    it('parses BOM, CRLF, duplicates, first-two-comma definitions, and literal line breaks', () => {
        const parsed = parseCustomDictionary(
            [
                '\uFEFF# custom definitions',
                '螺旋丸, らせんがん, Rotating, chakra sphere attack',
                'malformed',
                ', reading, missing term',
                '千鳥, ちどり, Lightning\\nchakra thrust attack',
                '螺旋丸, らせんがん, Duplicate definition',
                '',
            ].join('\r\n')
        );

        expect(parsed.entries).toEqual([
            {
                term: '螺旋丸',
                reading: 'らせんがん',
                definition: 'Rotating, chakra sphere attack',
            },
            {
                term: '千鳥',
                reading: 'ちどり',
                definition: 'Lightning\nchakra thrust attack',
            },
            {
                term: '螺旋丸',
                reading: 'らせんがん',
                definition: 'Duplicate definition',
            },
        ]);
        expect(parsed.ignoredLines).toEqual([3, 4]);
    });

    it('uses semantic revisions for parsed entries and raw revisions for editor conflicts', () => {
        const lf = parseCustomDictionary('語, ご, Definition\n');
        const formatted = parseCustomDictionary(
            '# comment\r\n\r\n 語 , ご , Definition \r\n'
        );

        expect(formatted.semanticRevision).toBe(lf.semanticRevision);
        expect(
            customDictionarySourceRevision('語, ご, Definition\n', true)
        ).not.toBe(
            customDictionarySourceRevision(
                '# comment\r\n\r\n 語 , ご , Definition \r\n',
                true
            )
        );
        expect(customDictionarySourceRevision('', true)).not.toBe(
            customDictionarySourceRevision('', false)
        );
    });

    it('serializes note entries without breaking the line-based format', () => {
        expect(
            serializeCustomDictionaryEntry({
                term: ' 千鳥 ',
                reading: ' ちどり ',
                definition: 'First line\nSecond, line',
            })
        ).toBe('千鳥, ちどり, First line\\nSecond, line');
        expect(() =>
            serializeCustomDictionaryEntry({
                term: 'bad,term',
                reading: 'reading',
                definition: 'definition',
            })
        ).toThrow('cannot contain commas');
        expect(() =>
            serializeCustomDictionaryEntry({
                term: 'term',
                reading: 'reading',
                definition: 'bad\0definition',
            })
        ).toThrow('cannot contain null characters');
        expect(() =>
            serializeCustomDictionaryEntry({
                term: '#hidden',
                reading: 'hidden',
                definition: 'This must not become a comment.',
            })
        ).toThrow('cannot begin with #');
    });

    it('round-trips literal backslash-n text while retaining legacy newline escapes', () => {
        const definition = String.raw`Keep \n literal` + '\nThen make a new line';
        const serialized = serializeCustomDictionaryEntry({
            term: '改行',
            reading: 'かいぎょう',
            definition,
        });

        expect(serialized).toBe(
            String.raw`改行, かいぎょう, Keep \\n literal\nThen make a new line`
        );
        expect(parseCustomDictionary(`${serialized}\n`).entries).toEqual([
            { term: '改行', reading: 'かいぎょう', definition },
        ]);
        expect(
            parseCustomDictionary(String.raw`旧式, きゅうしき, First\nSecond`).entries
        ).toEqual([
            {
                term: '旧式',
                reading: 'きゅうしき',
                definition: 'First\nSecond',
            },
        ]);
    });

    it('skips fields that cannot be returned safely by the native lookup bridge', () => {
        const oversizedDefinition = '界'.repeat(
            Math.floor(MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES / 3) + 1
        );
        const parsed = parseCustomDictionary(
            `過大, かだい, ${oversizedDefinition}\n有効, ゆうこう, Valid\n`
        );

        expect(parsed.entries).toEqual([
            { term: '有効', reading: 'ゆうこう', definition: 'Valid' },
        ]);
        expect(parsed.ignoredLines).toEqual([1]);
        expect(() =>
            serializeCustomDictionaryEntry({
                term: '過大',
                reading: 'かだい',
                definition: oversizedDefinition,
            })
        ).toThrow('UTF-8 size limit');
    });

    it('reserves enough of the native response budget for all retained glossaries', () => {
        const definition = 'D'.repeat(MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES);
        const results = Array.from({ length: 16 }, (_, index) => ({
            matched: `語${index}`,
            deinflected: `語${index}`,
            trace: [],
            term: {
                expression: `語${index}`,
                reading: 'r'.repeat(4 * 1024),
                rules: '',
                score: 0,
                glossaries: Array.from({ length: 4 }, () => ({
                    dictionary: 'GSM Custom Dictionary',
                    glossary: definition,
                    definitionTags: '',
                    termTags: '',
                })),
                frequencies: [],
                pitches: [],
            },
            preprocessorSteps: 0,
        }));
        const payload = JSON.stringify({
            type: 'hoshidicts_lookup_result',
            requestId: 'r'.repeat(128),
            success: true,
            results,
            dictionaryCount: 256,
            featureDisabled: false,
            error: null,
        });

        expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(256 * 1024);
        expect(() =>
            serializeCustomDictionaryEntry({
                term: 'escape-heavy',
                reading: 'escape-heavy',
                definition: '\\'.repeat(MAX_HOSHIDICTS_CUSTOM_DEFINITION_BYTES),
            })
        ).toThrow('UTF-8 size limit');
    });

    it('counts malformed lines without retaining an unbounded warning list', () => {
        const parsed = parseCustomDictionary(
            Array.from({ length: 10_000 }, (_, index) => `bad line ${index}`).join(
                '\n'
            )
        );

        expect(parsed.entries).toEqual([]);
        expect(parsed.ignoredLineCount).toBe(10_000);
        expect(parsed.ignoredLines).toEqual(
            Array.from({ length: 20 }, (_, index) => index + 1)
        );
    });
});

describe('custom Hoshidicts archive compiler', () => {
    it('writes a format-3 Yomitan archive with chunked term banks', async () => {
        const root = makeTempDir();
        const archivePath = path.join(root, 'custom.zip');
        const extractedPath = path.join(root, 'extracted');
        const entries = Array.from({ length: 1_001 }, (_, index) => ({
            term: `語${index}`,
            reading: `ご${index}`,
            definition: `Definition ${index}`,
        }));

        await writeCustomDictionaryArchive(
            archivePath,
            'GSM Custom Dictionary',
            'semantic-revision',
            entries
        );
        await extract(archivePath, { dir: extractedPath });

        expect(
            JSON.parse(fs.readFileSync(path.join(extractedPath, 'index.json'), 'utf8'))
        ).toMatchObject({
            title: 'GSM Custom Dictionary',
            revision: 'semantic-revision',
            format: 3,
            sequenced: true,
            sourceLanguage: 'ja',
        });
        const firstBank = JSON.parse(
            fs.readFileSync(path.join(extractedPath, 'term_bank_1.json'), 'utf8')
        );
        const secondBank = JSON.parse(
            fs.readFileSync(path.join(extractedPath, 'term_bank_2.json'), 'utf8')
        );
        expect(firstBank).toHaveLength(1_000);
        expect(secondBank).toEqual([
            ['語1000', 'ご1000', '', '', 0, ['Definition 1000'], 1001, ''],
        ]);
    }, 20_000);
});
