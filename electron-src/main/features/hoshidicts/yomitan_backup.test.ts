import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { getHeapStatistics } from 'node:v8';
import extract from 'extract-zip';
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
    createDefaultHoshidictsFieldOverwriteModes,
    createDefaultHoshidictsPopupButtons,
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
        activeProfileId: 'default',
        profiles: [{ id: 'default', name: 'Default' }],
        dictionaries: [],
        tabGroups: [],
        customDictionaryActive: false,
        recommendedDictionaries: [],
        miningProfile: {
            version: 3,
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
            checkForDuplicates: true,
            duplicateScope: 'collection',
            duplicateScopeCheckAllModels: false,
            duplicateBehavior: 'prevent',
            fieldOverwriteModes:
                createDefaultHoshidictsFieldOverwriteModes(),
            fieldTemplates: null,
        },
        audioProfile: createDefaultHoshidictsAudioProfile(),
        lookupMode: 'shift',
        scanLength: 16,
        maxResults: 32,
        sortFrequencyDictionary: null,
        sortFrequencyDictionaryOrder: 'descending',
        activationKey: 'Shift',
        sourceHighlightEnabled: false,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 0,
        showLookupCounts: true,
        showCompactDefinitionSummary: true,
        compactDefinitionSummaryDictionary: 'Jitendex.org',
        showPitchAccentFurigana: false,
        pitchAccentFuriganaDictionary: 'Kanjium Pitch Accents',
        showPitchAccentBadge: true,
        hidePopupGrammarTags: false,
        popupNestingMaxDepth: 1,
        definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
        popupWidthPx: 680,
        popupHeightPx: 480,
        popupColumns: 3,
        theme: 'autumn',
        popupOpacityPercent: 70,
        popupToolbarPosition: 'top',
        popupButtons: {
            ...createDefaultHoshidictsPopupButtons(),
            customLinks: [
                {
                    label: 'Jisho',
                    url: 'https://jisho.org/search/%w',
                },
            ],
        },
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
                                general: {
                                    maxResults: 64,
                                    sortFrequencyDictionary: null,
                                    sortFrequencyDictionaryOrder: 'ascending',
                                },
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
                                    length: 24,
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
            version: 3,
            enabled: true,
            deck: 'Japanese',
            model: 'Mining',
            checkForDuplicates: false,
            duplicateScope: 'collection',
            duplicateScopeCheckAllModels: false,
            duplicateBehavior: 'new',
            fieldTemplates: {
                Word: {
                    value: '{expression}',
                    overwriteMode: 'coalesce',
                },
                Reading: {
                    value: '{furigana-plain}',
                    overwriteMode: 'coalesce',
                },
                Definition: {
                    value: '{jpmn-primary-definition}',
                    overwriteMode: 'coalesce',
                },
                Sentence: {
                    value: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}',
                    overwriteMode: 'coalesce',
                },
                Audio: {
                    value: '{audio}',
                    overwriteMode: 'coalesce',
                },
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
            scanLength: 24,
            maxResults: 64,
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'ascending',
            popupHideDelayMs: 250,
            showCompactDefinitionSummary: true,
            compactDefinitionSummaryDictionary: 'Jitendex.org',
            showPitchAccentFurigana: false,
            pitchAccentFuriganaDictionary: 'Kanjium Pitch Accents',
            showPitchAccentBadge: true,
            hidePopupGrammarTags: false,
            popupNestingMaxDepth: 3,
            popupWidthPx: 680,
            popupHeightPx: 480,
            popupColumns: 3,
            theme: 'autumn',
            popupOpacityPercent: 70,
            popupButtons: {
                customLinks: [
                    {
                        label: 'Jisho',
                        url: 'https://jisho.org/search/%w',
                    },
                ],
            },
        });
        expect(parsed.warnings).toContain('Skipped unsupported Yomitan audio source: wiktionary.');
    });

    it('imports an installed Yomitan frequency sort dictionary', () => {
        const state = currentState();
        state.dictionaries = [
            {
                id: 'frequency',
                title: 'Frequency',
                displayName: null,
                enabled: true,
                favorite: false,
                revision: 'one',
                isUpdatable: false,
                indexUrl: null,
                downloadUrl: null,
                language: 'ja',
                termCount: 0,
                frequencyCount: 10,
                pitchCount: 0,
                kanjiCount: 0,
                frequencyMode: 'rank-based',
                installedAt: '2026-08-08T00:00:00.000Z',
                updateScheduleOverride: null,
                lastUpdateCheck: null,
            },
        ];

        const parsed = parseYomitanSettingsBackup(
            {
                version: 0,
                options: {
                    profileCurrent: 0,
                    profiles: [
                        {
                            options: {
                                general: {
                                    maxResults: 48,
                                    sortFrequencyDictionary: 'Frequency',
                                    sortFrequencyDictionaryOrder: 'ascending',
                                },
                            },
                        },
                    ],
                },
            },
            state
        );

        expect(parsed.readerPreferences).toMatchObject({
            maxResults: 48,
            sortFrequencyDictionary: 'Frequency',
            sortFrequencyDictionaryOrder: 'ascending',
        });
        expect(parsed.groups).toContain('reader');
        expect(parsed.warnings).toEqual([]);

        state.dictionaries[0].enabled = false;
        const disabled = parseYomitanSettingsBackup(
            {
                version: 0,
                options: {
                    profileCurrent: 0,
                    profiles: [
                        {
                            options: {
                                general: {
                                    sortFrequencyDictionary: 'Frequency',
                                    sortFrequencyDictionaryOrder: 'ascending',
                                },
                            },
                        },
                    ],
                },
            },
            state
        );
        expect(disabled.readerPreferences?.sortFrequencyDictionary).toBeNull();
        expect(disabled.warnings).toContain(
            'Skipped unavailable Yomitan frequency sort dictionary: Frequency.'
        );

        const reenabled = parseYomitanSettingsBackup(
            {
                version: 0,
                options: {
                    profileCurrent: 0,
                    profiles: [
                        {
                            options: {
                                dictionaries: [
                                    { name: 'Frequency', enabled: true },
                                ],
                                general: {
                                    sortFrequencyDictionary: 'Frequency',
                                    sortFrequencyDictionaryOrder: 'ascending',
                                },
                            },
                        },
                    ],
                },
            },
            state
        );
        expect(reenabled.readerPreferences).toMatchObject({
            sortFrequencyDictionary: 'Frequency',
            sortFrequencyDictionaryOrder: 'ascending',
        });
        expect(reenabled.warnings).toEqual([]);
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
                                                ExpressionCopy: {
                                                    value: '{expression}',
                                                    overwriteMode: 'append',
                                                },
                                                Frequency: {
                                                    value: '{single-frequency-number}',
                                                },
                                                Pitch: {
                                                    value: '{pitch-accent-graphs}',
                                                },
                                                Literal: {
                                                    value: 'x',
                                                    overwriteMode: 'skip',
                                                },
                                                Unused: {
                                                    value: '',
                                                    overwriteMode: 'coalesce-new',
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
            version: 3,
            deck: 'Deck',
            model: 'Note',
            checkForDuplicates: true,
            duplicateScope: 'collection',
            duplicateScopeCheckAllModels: false,
            duplicateBehavior: 'prevent',
            fieldTemplates: {
                Expression: {
                    value: '{expression}',
                    overwriteMode: 'coalesce',
                },
                ExpressionCopy: {
                    value: '{expression}',
                    overwriteMode: 'append',
                },
                Frequency: {
                    value: '{single-frequency-number}',
                    overwriteMode: 'coalesce',
                },
                Pitch: {
                    value: '{pitch-accent-graphs}',
                    overwriteMode: 'coalesce',
                },
                Literal: { value: 'x', overwriteMode: 'skip' },
                Unused: { value: '', overwriteMode: 'coalesce-new' },
            },
        });
    });

    it('imports Yomitan duplicate scopes, note-type checks, and every overwrite mode', () => {
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
                                    checkForDuplicates: true,
                                    duplicateScope: 'deck-root',
                                    duplicateScopeCheckAllModels: true,
                                    duplicateBehavior: 'overwrite',
                                    cardFormats: [
                                        {
                                            type: 'term',
                                            deck: 'Japanese::Mining',
                                            model: 'Mining',
                                            fields: {
                                                Expression: {
                                                    value: '{expression}',
                                                    overwriteMode: 'overwrite',
                                                },
                                                Reading: {
                                                    value: '{reading}',
                                                    overwriteMode: 'skip',
                                                },
                                                Definition: {
                                                    value: '{glossary}',
                                                    overwriteMode: 'append',
                                                },
                                                Sentence: {
                                                    value: '{sentence}',
                                                    overwriteMode: 'prepend',
                                                },
                                                Frequency: {
                                                    value: '{frequency-harmonic-rank}',
                                                    overwriteMode: 'coalesce-new',
                                                },
                                                Pitch: {
                                                    value: '{pitch-accent-graphs}',
                                                    overwriteMode: 'coalesce',
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
            version: 3,
            checkForDuplicates: true,
            duplicateScope: 'deck-root',
            duplicateScopeCheckAllModels: true,
            duplicateBehavior: 'overwrite',
            fieldTemplates: {
                Expression: {
                    value: '{expression}',
                    overwriteMode: 'overwrite',
                },
                Reading: {
                    value: '{reading}',
                    overwriteMode: 'skip',
                },
                Definition: {
                    value: '{glossary}',
                    overwriteMode: 'append',
                },
                Sentence: {
                    value: '{sentence}',
                    overwriteMode: 'prepend',
                },
                Frequency: {
                    value: '{frequency-harmonic-rank}',
                    overwriteMode: 'coalesce-new',
                },
                Pitch: {
                    value: '{pitch-accent-graphs}',
                    overwriteMode: 'coalesce',
                },
            },
        });
        expect(parsed.warnings).toEqual([]);
    });

    it('imports local-audio-yomichan from the active Yomitan profile', () => {
        const parsed = parseYomitanSettingsBackup(
            {
                version: 0,
                options: {
                    profileCurrent: 0,
                    profiles: [
                        {
                            name: 'Japanese',
                            options: {
                                audio: {
                                    enabled: true,
                                    autoPlay: false,
                                    volume: 100,
                                    enableDefaultAudioSources: false,
                                    sources: [
                                        {
                                            type: 'custom-json',
                                            url: 'http://127.0.0.1:5050/?term={term}&reading={reading}',
                                            voice: '',
                                        },
                                        {
                                            type: 'custom-json',
                                            url: 'http://127.0.0.1:5050/?expression={expression}&reading={reading}',
                                            voice: '',
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

        expect(parsed.groups).toEqual(['audio']);
        expect(parsed.audioProfile).toEqual({
            version: 1,
            enabled: true,
            autoPlay: false,
            volume: 100,
            sources: [
                {
                    id: 'custom-json-1',
                    type: 'custom-json',
                    url: 'http://127.0.0.1:5050/?term={term}&reading={reading}',
                    voice: '',
                },
                {
                    id: 'custom-json-2',
                    type: 'custom-json',
                    url: 'http://127.0.0.1:5050/?expression={term}&reading={reading}',
                    voice: '',
                },
            ],
        });
        expect(parsed.warnings).toEqual([]);
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
                            tableName: 'terms',
                            inbound: true,
                            rows: Array.from({ length: 1_001 }, (_, index) => ({
                                dictionary: 'Test',
                                expression: `猫-${index}`,
                                reading: 'ねこ',
                                glossary: ['cat'],
                            })),
                        },
                        {
                            tableName: 'media',
                            inbound: true,
                            rows: [
                                {
                                    dictionary: 'Test',
                                    path: 'images/cat.txt',
                                    content:
                                        Buffer.from('hello').toString('base64'),
                                },
                            ],
                        },
                        {
                            tableName: 'dictionaries',
                            inbound: true,
                            rows: [
                                {
                                    title: 'Test',
                                    revision: '1',
                                    sourceLanguage: 'ja',
                                    styles: '.entry { color: red; }',
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
        try {
            expect(fs.readFileSync(archivePath).subarray(0, 2).toString()).toBe(
                'PK'
            );
            const extractedPath = path.join(inputRoot, 'extracted');
            await extract(archivePath, { dir: extractedPath });
            const firstBank = JSON.parse(
                fs.readFileSync(
                    path.join(extractedPath, 'term_bank_1.json'),
                    'utf8'
                )
            ) as unknown[][];
            const secondBank = JSON.parse(
                fs.readFileSync(
                    path.join(extractedPath, 'term_bank_2.json'),
                    'utf8'
                )
            ) as unknown[][];
            expect(firstBank).toHaveLength(1_000);
            expect(firstBank[0][0]).toBe('猫-0');
            expect(firstBank[999][0]).toBe('猫-999');
            expect(secondBank).toHaveLength(1);
            expect(secondBank[0][0]).toBe('猫-1000');
            expect(
                fs.readFileSync(path.join(extractedPath, 'styles.css'), 'utf8')
            ).toBe('.entry { color: red; }');
            expect(
                fs.readFileSync(
                    path.join(extractedPath, 'images', 'cat.txt'),
                    'utf8'
                )
            ).toBe('hello');
        } finally {
            await prepared.cleanup();
        }
        expect(fs.existsSync(temporaryRoot)).toBe(false);
    });

    it('keeps interleaved dictionaries isolated across the spool handle limit', async () => {
        const inputRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gsm-yomitan-spool-limit-test-')
        );
        tempDirs.push(inputRoot);
        const inputPath = path.join(inputRoot, 'dictionaries.json');
        const titles = Array.from(
            { length: 17 },
            (_, index) => `Dictionary ${index + 1}`
        );
        fs.writeFileSync(
            inputPath,
            JSON.stringify({
                formatName: 'dexie',
                formatVersion: 1,
                data: {
                    databaseName: 'dict',
                    data: [
                        {
                            tableName: 'terms',
                            inbound: true,
                            rows: [0, 1].flatMap((pass) =>
                                titles
                                    .map((title, index) => ({
                                        dictionary: title,
                                        expression: `${index + 1}-${pass + 1}`,
                                        reading: '',
                                        glossary: [`definition ${pass + 1}`],
                                    }))
                                    .reverse()
                            ),
                        },
                        {
                            tableName: 'dictionaries',
                            inbound: true,
                            rows: titles.map((title) => ({
                                title,
                                revision: '1',
                            })),
                        },
                    ],
                },
            })
        );

        const prepared = await prepareYomitanDictionaryBackup(inputPath);
        try {
            expect(prepared.dictionaries).toHaveLength(17);
            for (const dictionaryIndex of [0, 16]) {
                const extractedPath = path.join(
                    inputRoot,
                    `extracted-${dictionaryIndex}`
                );
                await extract(prepared.dictionaries[dictionaryIndex].archivePath, {
                    dir: extractedPath,
                });
                const bank = JSON.parse(
                    fs.readFileSync(
                        path.join(extractedPath, 'term_bank_1.json'),
                        'utf8'
                    )
                ) as unknown[][];
                expect(bank.map((entry) => entry[0])).toEqual([
                    `${dictionaryIndex + 1}-1`,
                    `${dictionaryIndex + 1}-2`,
                ]);
            }
        } finally {
            await prepared.cleanup();
        }
    });

    it('splits bank files before they exceed the bounded byte size', async () => {
        const inputRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gsm-yomitan-bank-bytes-test-')
        );
        tempDirs.push(inputRoot);
        const inputPath = path.join(inputRoot, 'dictionaries.json');
        const glossary = 'x'.repeat(17 * 1024 * 1024);
        fs.writeFileSync(
            inputPath,
            JSON.stringify({
                formatName: 'dexie',
                formatVersion: 1,
                data: {
                    databaseName: 'dict',
                    data: [
                        {
                            tableName: 'dictionaries',
                            inbound: true,
                            rows: [{ title: 'Large rows', revision: '1' }],
                        },
                        {
                            tableName: 'terms',
                            inbound: true,
                            rows: [0, 1].map((index) => ({
                                dictionary: 'Large rows',
                                expression: `entry-${index}`,
                                reading: '',
                                glossary: [`${glossary}-${index}`],
                            })),
                        },
                    ],
                },
            })
        );

        const prepared = await prepareYomitanDictionaryBackup(inputPath);
        try {
            const extractedPath = path.join(inputRoot, 'extracted-bytes');
            await extract(prepared.dictionaries[0].archivePath, {
                dir: extractedPath,
            });
            const first = fs.statSync(
                path.join(extractedPath, 'term_bank_1.json')
            ).size;
            const second = fs.statSync(
                path.join(extractedPath, 'term_bank_2.json')
            ).size;
            expect(first).toBeGreaterThan(16 * 1024 * 1024);
            expect(second).toBeGreaterThan(16 * 1024 * 1024);
            expect(first).toBeLessThanOrEqual(32 * 1024 * 1024);
            expect(second).toBeLessThanOrEqual(32 * 1024 * 1024);
            expect(
                fs.existsSync(path.join(extractedPath, 'term_bank_3.json'))
            ).toBe(false);
        } finally {
            await prepared.cleanup();
        }
    });

    it('reports each dictionary while preparing temporary ZIP archives', async () => {
        const inputRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gsm-yomitan-progress-test-')
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
                                { title: 'Alpha', revision: '1' },
                                { title: 'Beta', revision: '1' },
                            ],
                        },
                        {
                            tableName: 'terms',
                            inbound: true,
                            rows: [
                                {
                                    dictionary: 'Alpha',
                                    expression: '猫',
                                    reading: 'ねこ',
                                    glossary: ['cat'],
                                },
                                {
                                    dictionary: 'Beta',
                                    expression: '犬',
                                    reading: 'いぬ',
                                    glossary: ['dog'],
                                },
                            ],
                        },
                    ],
                },
            })
        );
        const progress: Array<{
            current: number;
            total: number;
            title: string;
        }> = [];
        const readingProgress: Array<{
            completedBytes: number;
            totalBytes: number;
            estimatedSecondsRemaining: number | null;
        }> = [];
        const consumed: Array<{
            current: number;
            total: number;
            title: string;
            archivePath: string;
        }> = [];

        const prepared = await prepareYomitanDictionaryBackup(
            inputPath,
            (update) => progress.push(update),
            async (dictionary) => {
                expect(fs.existsSync(dictionary.archivePath)).toBe(true);
                consumed.push(dictionary);
            },
            (update) => readingProgress.push(update)
        );

        try {
            const fileSize = fs.statSync(inputPath).size;
            expect(readingProgress[0]).toEqual({
                completedBytes: 0,
                totalBytes: fileSize,
                estimatedSecondsRemaining: null,
            });
            expect(readingProgress.at(-1)).toEqual({
                completedBytes: fileSize,
                totalBytes: fileSize,
                estimatedSecondsRemaining: null,
            });
            expect(
                readingProgress.every(
                    (update, index) =>
                        index === 0 ||
                        update.completedBytes >=
                            readingProgress[index - 1].completedBytes
                )
            ).toBe(true);
            expect(progress).toEqual([
                { current: 1, total: 2, title: 'Alpha' },
                { current: 2, total: 2, title: 'Beta' },
            ]);
            expect(
                consumed.map(({ current, total, title }) => ({
                    current,
                    total,
                    title,
                }))
            ).toEqual([
                { current: 1, total: 2, title: 'Alpha' },
                { current: 2, total: 2, title: 'Beta' },
            ]);
            expect(prepared.dictionaries).toEqual([]);
            expect(
                consumed.every(
                    (dictionary) => !fs.existsSync(dictionary.archivePath)
                )
            ).toBe(true);
        } finally {
            await prepared.cleanup();
        }
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

    it('matches whole-document parsing when every UTF-8 byte is its own chunk', async () => {
        const title = 'Escaped 😺 "dictionary" \\ root';
        const backup = {
            formatName: 'dexie',
            formatVersion: 1,
            data: {
                databaseName: 'dict',
                data: [
                    {
                        tableName: 'dictionaries',
                        inbound: false,
                        rows: [
                            [
                                1,
                                {
                                    title,
                                    revision: '1',
                                    styles: '.entry::after { content: "😺"; }',
                                },
                            ],
                        ],
                    },
                    {
                        tableName: 'terms',
                        inbound: false,
                        rows: [
                            [
                                2,
                                {
                                    dictionary: title,
                                    expression: '猫😺',
                                    reading: 'ねこ',
                                    definitionTags: '',
                                    rules: '',
                                    score: 1_250,
                                    glossary: [
                                        'line\nbreak, quote ", slash \\, emoji 😺',
                                    ],
                                    sequence: 7,
                                    termTags: '',
                                },
                            ],
                        ],
                    },
                ],
            },
        };
        const text = JSON.stringify(backup)
            .replaceAll('"tableName"', '"table\\u004eame"')
            .replaceAll('😺', '\\ud83d\\ude3a')
            .replaceAll('猫', '\\u732b')
            .replace('1250', '1.25e3');
        const bytes = Buffer.from(text, 'utf8');
        const createSource = (): Readable =>
            Readable.from(
                (function* (): Generator<Buffer> {
                    for (let index = 0; index < bytes.length; index += 1) {
                        yield bytes.subarray(index, index + 1);
                    }
                })()
            );

        const parsed = await parseYomitanDictionaryBackupStream(createSource);

        expect(parsed).toEqual(
            parseYomitanDictionaryBackup(JSON.parse(text) as unknown)
        );
    });

    it('opens the source once and preserves rows before dictionary summaries', async () => {
        const text = JSON.stringify({
            formatName: 'dexie',
            formatVersion: 1,
            data: {
                databaseName: 'dict',
                data: [
                    {
                        tableName: 'terms',
                        inbound: true,
                        rows: [
                            {
                                dictionary: 'One pass',
                                expression: '猫',
                                reading: 'ねこ',
                                glossary: ['cat'],
                            },
                        ],
                    },
                    {
                        tableName: 'dictionaries',
                        inbound: true,
                        rows: [{ title: 'One pass', revision: '1' }],
                    },
                ],
            },
        });
        let sourceOpens = 0;

        const parsed = await parseYomitanDictionaryBackupStream(() => {
            sourceOpens += 1;
            return Readable.from([text]);
        });

        expect(sourceOpens).toBe(1);
        expect(parsed[0].index).toMatchObject({
            title: 'One pass',
            revision: '1',
        });
        expect(parsed[0].banks.term).toEqual([
            ['猫', 'ねこ', '', '', 0, ['cat'], -1, ''],
        ]);
    });

    it('preserves interleaved dictionary order across buffered writes', async () => {
        const inputRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gsm-yomitan-buffer-order-test-')
        );
        tempDirs.push(inputRoot);
        const inputPath = path.join(inputRoot, 'dictionaries.json');
        const rowCount = 20;
        const padding = 'x'.repeat(20 * 1024);
        const titles = ['Alpha', 'Beta'];
        const rows = Array.from({ length: rowCount }, (_, index) =>
            titles.map((title) => ({
                dictionary: title,
                expression: `${title.toLowerCase()}-${index}`,
                reading: '',
                glossary: [
                    `${title.toLowerCase()} definition ${index}: ${padding}`,
                ],
            }))
        ).flat();
        fs.writeFileSync(
            inputPath,
            JSON.stringify({
                formatName: 'dexie',
                formatVersion: 1,
                data: {
                    databaseName: 'dict',
                    data: [
                        {
                            tableName: 'terms',
                            inbound: true,
                            rows,
                        },
                        {
                            tableName: 'dictionaries',
                            inbound: true,
                            rows: titles.map((title) => ({
                                title,
                                revision: '1',
                            })),
                        },
                    ],
                },
            })
        );

        const prepared = await prepareYomitanDictionaryBackup(inputPath);
        try {
            expect(prepared.dictionaries.map(({ title }) => title)).toEqual(
                titles
            );
            for (const dictionary of prepared.dictionaries) {
                const extractedPath = path.join(
                    inputRoot,
                    `extracted-${dictionary.title}`
                );
                await extract(dictionary.archivePath, { dir: extractedPath });
                const bankPath = path.join(
                    extractedPath,
                    'term_bank_1.json'
                );
                const bank = JSON.parse(
                    fs.readFileSync(bankPath, 'utf8')
                ) as unknown[][];
                const prefix = dictionary.title.toLowerCase();
                expect(fs.statSync(bankPath).size).toBeGreaterThan(256 * 1024);
                expect(bank.map((entry) => entry[0])).toEqual(
                    Array.from(
                        { length: rowCount },
                        (_, index) => `${prefix}-${index}`
                    )
                );
                expect((bank[0][5] as string[])[0]).toBe(
                    `${prefix} definition 0: ${padding}`
                );
                expect((bank.at(-1)?.[5] as string[])[0]).toBe(
                    `${prefix} definition ${rowCount - 1}: ${padding}`
                );
            }
        } finally {
            await prepared.cleanup();
        }
    });

    it('cleans generated files when the prepared dictionary consumer fails', async () => {
        const inputRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'gsm-yomitan-consumer-error-test-')
        );
        tempDirs.push(inputRoot);
        const inputPath = path.join(inputRoot, 'dictionaries.json');
        const generatedOutput = path.join(inputRoot, 'generated-output');
        fs.mkdirSync(generatedOutput);
        fs.writeFileSync(
            inputPath,
            JSON.stringify({
                formatName: 'dexie',
                formatVersion: 1,
                data: {
                    databaseName: 'dict',
                    data: [
                        {
                            tableName: 'dictionaries',
                            inbound: true,
                            rows: [{ title: 'Cleanup', revision: '1' }],
                        },
                        {
                            tableName: 'terms',
                            inbound: true,
                            rows: [
                                {
                                    dictionary: 'Cleanup',
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
        const previousTmpdir = process.env.TMPDIR;
        let archivePath = '';
        let temporaryRoot = '';
        process.env.TMPDIR = generatedOutput;

        try {
            await expect(
                prepareYomitanDictionaryBackup(
                    inputPath,
                    undefined,
                    async (dictionary) => {
                        archivePath = dictionary.archivePath;
                        temporaryRoot = path.dirname(archivePath);
                        expect(fs.existsSync(archivePath)).toBe(true);
                        throw new Error('consumer failed');
                    }
                )
            ).rejects.toThrow('consumer failed');
            expect(archivePath).not.toBe('');
            expect(fs.existsSync(archivePath)).toBe(false);
            expect(fs.existsSync(temporaryRoot)).toBe(false);
            expect(fs.readdirSync(generatedOutput)).toEqual([]);
        } finally {
            if (previousTmpdir === undefined) {
                delete process.env.TMPDIR;
            } else {
                process.env.TMPDIR = previousTmpdir;
            }
        }
    });

    it('rejects source read errors instead of emitting an unhandled process error', async () => {
        await expect(
            parseYomitanDictionaryBackupStream(
                () =>
                    new Readable({
                        read() {
                            this.destroy(new Error('backup read failed'));
                        },
                    })
            )
        ).rejects.toThrow('backup read failed');
    });

    it('rejects a single oversized JSON value before V8 can retain it', async () => {
        const createSource = (): Readable =>
            Readable.from(
                (function* (): Generator<string> {
                    yield (
                        '{"formatName":"dexie","formatVersion":1,"data":{' +
                        '"databaseName":"dict","data":[' +
                        '{"tableName":"dictionaries","inbound":true,"rows":[' +
                        '{"title":"Large","revision":"1"}]},' +
                        '{"tableName":"terms","inbound":true,"rows":[' +
                        '{"dictionary":"Large","expression":"entry",' +
                        '"reading":"","glossary":["'
                    );
                    const chunk = 'x'.repeat(8 * 1024);
                    for (let index = 0; index <= 4_096; index += 1) {
                        yield chunk;
                    }
                    yield '"]}]}]}}';
                })()
            );

        await expect(
            parseYomitanDictionaryBackupStream(createSource)
        ).rejects.toThrow('exceeds the supported 32 MiB limit');
    });

    it(
        'imports a Yomitan backup larger than its V8 heap without retaining all rows',
        async () => {
            const isLowHeapChild =
                process.env.GSM_YOMITAN_LOW_HEAP_CHILD === '1';
            if (!isLowHeapChild) {
                const root = fs.mkdtempSync(
                    path.join(os.tmpdir(), 'gsm-yomitan-low-heap-test-')
                );
                tempDirs.push(root);
                const result = spawnSync(
                    process.execPath,
                    [
                        path.resolve('node_modules/vitest/vitest.mjs'),
                        'run',
                        '--config',
                        path.resolve('vitest.config.ts'),
                        'electron-src/main/features/hoshidicts/yomitan_backup.test.ts',
                        '--testNamePattern',
                        'imports a Yomitan backup larger than its V8 heap without retaining all rows',
                        '--pool=forks',
                        '--maxWorkers=1',
                        '--no-file-parallelism',
                        '--execArgv=--max-old-space-size=96',
                        '--testTimeout=180000',
                        '--reporter=dot',
                    ],
                    {
                        cwd: process.cwd(),
                        env: {
                            ...process.env,
                            GSM_YOMITAN_LOW_HEAP_CHILD: '1',
                            GSM_YOMITAN_LOW_HEAP_ROOT: root,
                        },
                        encoding: 'utf8',
                        timeout: 210_000,
                        maxBuffer: 4 * 1024 * 1024,
                    }
                );
                expect(
                    result.status,
                    [
                        `signal: ${result.signal ?? 'none'}`,
                        result.error?.message ?? '',
                        result.stdout,
                        result.stderr,
                    ].join('\n')
                ).toBe(0);
                return;
            }

            const childRoot = process.env.GSM_YOMITAN_LOW_HEAP_ROOT;
            if (!childRoot) {
                throw new Error('Missing low-heap test directory.');
            }
            fs.mkdirSync(childRoot, { recursive: true });
            const inputPath = path.join(childRoot, 'large-dictionaries.json');
            const output = fs.createWriteStream(inputPath);
            let inputBytes = 0;
            const write = async (value: string): Promise<void> => {
                inputBytes += Buffer.byteLength(value);
                if (!output.write(value)) {
                    await once(output, 'drain');
                }
            };
            await write(
                '{"formatName":"dexie","formatVersion":1,"data":{' +
                    '"databaseName":"dict","data":[' +
                    '{"tableName":"dictionaries","inbound":true,"rows":[' +
                    '{"title":"Large","revision":"1"}]},' +
                    '{"tableName":"terms","inbound":true,"rows":['
            );
            const glossaryPadding = 'x'.repeat(8 * 1024);
            const heapLimit = getHeapStatistics().heap_size_limit;
            expect(heapLimit).toBeLessThan(256 * 1024 * 1024);
            const targetInputBytes = heapLimit + 16 * 1024 * 1024;
            for (let index = 0; inputBytes <= targetInputBytes; index += 1) {
                if (index > 0) await write(',');
                await write(
                    JSON.stringify({
                        dictionary: 'Large',
                        expression: `entry-${index}`,
                        reading: '',
                        glossary: [`${glossaryPadding}-${index}`],
                    })
                );
            }
            await write(']}]}}');
            output.end();
            await finished(output);
            expect(fs.statSync(inputPath).size).toBeGreaterThan(heapLimit);

            const prepared = await prepareYomitanDictionaryBackup(inputPath);
            try {
                expect(prepared.dictionaries).toHaveLength(1);
                const descriptor = fs.openSync(
                    prepared.dictionaries[0].archivePath,
                    'r'
                );
                try {
                    const magic = Buffer.alloc(2);
                    fs.readSync(descriptor, magic, 0, magic.length, 0);
                    expect(magic.toString()).toBe('PK');
                } finally {
                    fs.closeSync(descriptor);
                }
            } finally {
                await prepared.cleanup();
            }
        },
        240_000
    );

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
