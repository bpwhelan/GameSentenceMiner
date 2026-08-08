import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
    parseYomitanDictionaryBackup,
    parseYomitanDictionaryBackupStream,
    parseYomitanSettingsBackup,
    prepareYomitanDictionaryBackup,
    prepareYomitanSettingsBackup,
} from './yomitan_backup.js';
import type { HoshidictsManagerSnapshot } from '../../../shared/features/hoshidicts.js';
import {
    createDefaultHoshidictsAudioProfile,
    DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
} from '../../../shared/features/hoshidicts.js';

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function currentState(): HoshidictsManagerSnapshot {
    return {
        revision: 1,
        dictionaries: [],
        customDictionaryActive: false,
        recommendedDictionaries: [],
        miningProfile: {
            version: 1,
            enabled: true,
            deck: 'Old',
            model: 'Old',
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
            tags: [],
            duplicatePolicy: 'prevent',
        },
        audioProfile: createDefaultHoshidictsAudioProfile(),
        lookupMode: 'shift',
        activationKey: 'Shift',
        sourceHighlightEnabled: false,
        popupHideDelayMs: 0,
        showLookupCounts: true,
        popupNestingMaxDepth: 1,
        definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
        schedule: 'off',
        lastCheck: null,
        nextCheck: null,
        lastError: null,
        busy: false,
        progress: { phase: 'idle' },
    };
}

describe('parseYomitanSettingsBackup', () => {
    it('imports active-profile dictionary, legacy Anki, audio, and reader settings', () => {
        const parsed = parseYomitanSettingsBackup(
            {
                version: 0,
                options: {
                    profileCurrent: 0,
                    profiles: [
                        {
                            name: 'Mining',
                            options: {
                                dictionaries: [
                                    { name: 'JMdict', enabled: true },
                                    { name: 'Frequency', enabled: false },
                                ],
                                anki: {
                                    enable: true,
                                    checkForDuplicates: false,
                                    tags: ['yomitan'],
                                    terms: {
                                        deck: 'Japanese',
                                        model: 'Mining',
                                        fields: {
                                            Word: '{expression}',
                                            Reading: '{furigana-plain}',
                                            Definition: '{jpmn-primary-definition}',
                                            Sentence:
                                                '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}',
                                            Audio: '{audio}',
                                        },
                                    },
                                },
                                audio: {
                                    enabled: true,
                                    autoPlay: true,
                                    volume: 80,
                                    sources: [
                                        { type: 'jisho', url: '', voice: '' },
                                        {
                                            type: 'custom-json',
                                            url: 'http://localhost:8765/audio',
                                            voice: '',
                                        },
                                        { type: 'wiktionary', url: '', voice: '' },
                                    ],
                                },
                                scanning: {
                                    popupNestingMaxDepth: 3,
                                    hidePopupOnCursorExit: true,
                                    hidePopupOnCursorExitDelay: 250,
                                    inputs: [
                                        {
                                            include: '',
                                            types: { mouse: true },
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                },
            },
            currentState(),
        );

        expect(parsed.profileName).toBe('Mining');
        expect(parsed.dictionaries).toEqual([
            { title: 'JMdict', enabled: true },
            { title: 'Frequency', enabled: false },
        ]);
        expect(parsed.miningProfile).toMatchObject({
            enabled: true,
            deck: 'Japanese',
            model: 'Mining',
            duplicatePolicy: 'allow',
            fields: {
                expression: 'Word',
                reading: 'Reading',
                definition: 'Definition',
                sentence: 'Sentence',
                audio: 'Audio',
            },
        });
        expect(parsed.audioProfile).toMatchObject({
            enabled: true,
            autoPlay: true,
            volume: 80,
            sources: [
                { type: 'jisho' },
                { type: 'custom-json', url: 'http://localhost:8765/audio' },
            ],
        });
        expect(parsed.readerPreferences).toMatchObject({
            lookupMode: 'hover',
            popupHideDelayMs: 250,
            popupNestingMaxDepth: 3,
        });
        expect(parsed.warnings).toContain('Skipped unsupported Yomitan audio source: wiktionary.');
    });

    it('supports modern card formats and object field values', () => {
        const parsed = parseYomitanSettingsBackup(
            {
                version: 0,
                options: {
                    profileCurrent: 0,
                    profiles: [
                        {
                            options: {
                                anki: {
                                    enable: true,
                                    duplicateBehavior: 'prevent',
                                    tags: ['one', 'two'],
                                    cardFormats: [
                                        {
                                            type: 'kanji',
                                            deck: 'Ignored',
                                            model: 'Ignored',
                                            fields: {},
                                        },
                                        {
                                            type: 'term',
                                            deck: 'Deck',
                                            model: 'Note',
                                            fields: {
                                                Expression: {
                                                    value: '{expression}',
                                                    overwriteMode: 'coalesce',
                                                },
                                                Frequency: {
                                                    value: '{single-frequency-number}',
                                                },
                                                Pitch: {
                                                    value: '{pitch-accent-graphs}',
                                                },
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                },
            },
            currentState(),
        );

        expect(parsed.miningProfile).toMatchObject({
            deck: 'Deck',
            model: 'Note',
            duplicatePolicy: 'prevent',
            fields: {
                expression: 'Expression',
                frequency: 'Frequency',
                pitch: 'Pitch',
            },
        });
    });
});

describe('parseYomitanDictionaryBackup', () => {
    it('reconstructs Yomitan banks and media from Dexie rows', () => {
        const parsed = parseYomitanDictionaryBackup({
            formatName: 'dexie',
            formatVersion: 1,
            data: {
                databaseName: 'dict',
                databaseVersion: 60,
                tables: [],
                data: [
                    {
                        tableName: 'dictionaries',
                        inbound: false,
                        rows: [
                            [
                                1,
                                {
                                    title: 'Test Dictionary',
                                    revision: '1',
                                    sequenced: true,
                                    sourceLanguage: 'ja',
                                    styles: '.entry { color: red; }',
                                },
                            ],
                        ],
                    },
                    {
                        tableName: 'terms',
                        inbound: true,
                        rows: [
                            {
                                id: 1,
                                dictionary: 'Test Dictionary',
                                expression: '日本語',
                                reading: 'にほんご',
                                definitionTags: '',
                                rules: '',
                                score: 1,
                                glossary: ['Japanese'],
                                sequence: 1,
                                termTags: '',
                            },
                        ],
                    },
                    {
                        tableName: 'termMeta',
                        inbound: true,
                        rows: [
                            {
                                id: 2,
                                dictionary: 'Test Dictionary',
                                expression: '日本語',
                                mode: 'freq',
                                data: 10,
                            },
                        ],
                    },
                    {
                        tableName: 'media',
                        inbound: true,
                        rows: [
                            {
                                $: {
                                    id: 3,
                                    dictionary: 'Test Dictionary',
                                    path: 'image.png',
                                    content: 'aGVsbG8=',
                                },
                                $types: { content: 'arraybuffer' },
                            },
                        ],
                    },
                ],
            },
        });

        expect(parsed).toHaveLength(1);
        expect(parsed[0].index).toMatchObject({
            title: 'Test Dictionary',
            revision: '1',
            format: 3,
            sourceLanguage: 'ja',
        });
        expect(parsed[0].banks.term).toEqual([
            ['日本語', 'にほんご', '', '', 1, ['Japanese'], 1, ''],
        ]);
        expect(parsed[0].banks.termMeta).toEqual([['日本語', 'freq', 10]]);
        expect(parsed[0].styles).toBe('.entry { color: red; }');
        expect(parsed[0].media.get('image.png')?.toString('utf8')).toBe('hello');
    });

    it('writes reconstructed dictionaries as temporary ZIP archives', async () => {
        const inputRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gsm-yomitan-test-')
        );
        tempDirs.push(inputRoot);
        const inputPath = path.join(inputRoot, 'dictionaries.json');
        fs.writeFileSync(
            inputPath,
            JSON.stringify({
                formatName: 'dexie',
                formatVersion: 1,
                data: {
                    databaseName: 'dict',
                    databaseVersion: 60,
                    tables: [],
                    data: [
                        {
                            tableName: 'dictionaries',
                            inbound: true,
                            rows: [
                                {
                                    title: 'Test',
                                    revision: '1',
                                    sourceLanguage: 'ja',
                                },
                            ],
                        },
                        {
                            tableName: 'terms',
                            inbound: true,
                            rows: [
                                {
                                    dictionary: 'Test',
                                    expression: '猫',
                                    reading: 'ねこ',
                                    glossary: ['cat'],
                                },
                            ],
                        },
                    ],
                },
            })
        );

        const prepared = await prepareYomitanDictionaryBackup(inputPath);
        const archivePath = prepared.dictionaries[0].archivePath;
        const temporaryRoot = path.dirname(archivePath);
        expect(fs.readFileSync(archivePath).subarray(0, 2).toString()).toBe(
            'PK'
        );
        await prepared.cleanup();
        expect(fs.existsSync(temporaryRoot)).toBe(false);
    });

    it('parses dictionary backups incrementally across input chunks', async () => {
        const text = JSON.stringify({
            formatName: 'dexie',
            formatVersion: 1,
            data: {
                databaseName: 'dict',
                data: [
                    {
                        tableName: 'dictionaries',
                        inbound: true,
                        rows: [{ title: 'Streamed', revision: '1' }],
                    },
                    {
                        tableName: 'terms',
                        inbound: true,
                        rows: [
                            {
                                dictionary: 'Streamed',
                                expression: '猫',
                                reading: 'ねこ',
                                glossary: ['cat'],
                            },
                        ],
                    },
                ],
            },
        });
        const chunks = text.match(/.{1,7}/gu) ?? [];

        const parsed = await parseYomitanDictionaryBackupStream(
            () => Readable.from(chunks)
        );

        expect(parsed[0].banks.term).toEqual([
            ['猫', 'ねこ', '', '', 0, ['cat'], -1, ''],
        ]);
    });

    it('prepares settings separately from dictionary backups', async () => {
        const inputRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gsm-yomitan-settings-test-')
        );
        tempDirs.push(inputRoot);
        const inputPath = path.join(inputRoot, 'settings.json');
        fs.writeFileSync(
            inputPath,
            JSON.stringify({
                version: 0,
                options: {
                    profileCurrent: 0,
                    profiles: [
                        {
                            name: 'Imported',
                            options: { dictionaries: [] },
                        },
                    ],
                },
            })
        );

        const prepared = await prepareYomitanSettingsBackup(
            inputPath,
            currentState()
        );
        expect(prepared.dictionaries).toEqual([]);
        expect(prepared.settings?.profileName).toBe('Imported');
        await prepared.cleanup();
    });
});
