import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createBackupArchive,
    restoreBackupArchive,
    shouldIncludeGsmBackupPath,
    shouldIncludeOverlayBackupPath,
} from './settings_backup.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeFile(filePath: string, contents: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
}

function readText(root: string, ...parts: string[]): string {
    return fs.readFileSync(path.join(root, ...parts), 'utf8');
}

function exists(root: string, ...parts: string[]): boolean {
    return fs.existsSync(path.join(root, ...parts));
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('settings backup path filters', () => {
    it.each<[string, boolean]>([
        ['config.json', true],
        ['gsm.db-wal', true],
        ['black_bar_cache.json', false],
        ['ocr_config/Game.json', true],
        ['ocr_config/backup/Game/old.json', false],
        ['obs-studio/config/obs-studio/basic/scenes/Scene.json', true],
        ['obs-studio/config/obs-studio/logs/obs.txt', false],
        ['obs-studio/bin/64bit/obs64.exe', false],
        ['temp/image.png', false],
        ['python_venv/pyvenv.cfg', false],
        ['dictionaries/hoshidicts/audio-profile.json', true],
        ['dictionaries/hoshidicts/custom-dictionary.txt', true],
        ['dictionaries/hoshidicts/mining-profile.json', true],
        ['dictionaries/hoshidicts/tab-groups.json', false],
        ['dictionaries/hoshidicts/manifest.json', false],
        ['dictionaries/hoshidicts/generations/dictionary/blobs.bin', false],
        ['dictionaries/hoshidicts/generations/custom/index.json', false],
    ])('filters durable GSM path %s', (relativePath, expected) => {
        expect(shouldIncludeGsmBackupPath(relativePath, false)).toBe(expected);
    });

    it.each<[string, boolean]>([
        ['settings.json', true],
        ['yomitan_last_mtime.json', false],
        ['IndexedDB/chrome-extension/indexeddb.leveldb/000003.log', true],
        ['Local Extension Settings/ext/000003.log', true],
        ['IndexedDB/chrome-extension/indexeddb.leveldb/LOCK', false],
        ['Cache/Cache_Data/data_0', false],
        ['Service Worker/ScriptCache/index', false],
    ])('filters durable overlay path %s', (relativePath, expected) => {
        expect(shouldIncludeOverlayBackupPath(relativePath, false)).toBe(expected);
    });
});

describe('settings backup archive', () => {
    it('archives relevant settings and excludes temp/cache/runtime folders', async () => {
        const baseDir = makeTempDir('gsm-backup-base-');
        const overlayDir = makeTempDir('gsm-backup-overlay-');
        const homeConfigPath = path.join(makeTempDir('gsm-backup-home-'), '.config', 'owocr_config_gsm.ini');
        const outputPath = path.join(makeTempDir('gsm-backup-out-'), 'backup.zip');
        const extractDir = makeTempDir('gsm-backup-extract-');

        writeFile(path.join(baseDir, 'config.json'), '{"gsm":true}');
        writeFile(path.join(baseDir, 'gsm.db'), 'sqlite');
        writeFile(path.join(baseDir, 'current_pid.txt'), '123');
        writeFile(path.join(baseDir, 'logs', 'app.log'), 'log');
        writeFile(path.join(baseDir, 'temp', 'image.png'), 'tmp');
        writeFile(path.join(baseDir, 'ocr_config', 'Game.json'), '{"areas":[]}');
        writeFile(path.join(baseDir, 'ocr_config', 'backup', 'Game', 'old.json'), '{"old":true}');
        writeFile(path.join(baseDir, 'electron', 'config.json'), '{"desktop":true}');
        writeFile(path.join(baseDir, 'electron', 'Cache', 'data_0'), 'cache');
        writeFile(
            path.join(baseDir, 'dictionaries', 'hoshidicts', 'audio-profile.json'),
            '{"version":1,"enabled":true}',
        );
        writeFile(
            path.join(baseDir, 'dictionaries', 'hoshidicts', 'mining-profile.json'),
            '{"version":1,"deck":"Mining"}',
        );
        writeFile(
            path.join(baseDir, 'dictionaries', 'hoshidicts', 'manifest.json'),
            '{"version":1,"dictionaries":[]}',
        );
        writeFile(
            path.join(baseDir, 'dictionaries', 'hoshidicts', 'generations', 'dict', 'blobs.bin'),
            'dictionary',
        );
        writeFile(path.join(baseDir, 'obs-studio', 'config', 'obs-studio', 'global.ini'), 'global');
        writeFile(
            path.join(baseDir, 'obs-studio', 'config', 'obs-studio', 'basic', 'scenes', 'Untitled.json'),
            '{"scene":true}',
        );
        writeFile(path.join(baseDir, 'obs-studio', 'config', 'obs-studio', 'logs', 'obs.txt'), 'log');
        writeFile(path.join(baseDir, 'obs-studio', 'bin', '64bit', 'obs64.exe'), 'exe');
        writeFile(path.join(baseDir, 'texthook', 'profiles.json'), '{"profiles":[]}');
        writeFile(
            path.join(
                baseDir,
                'dictionaries',
                'hoshidicts',
                'custom-dictionary.txt'
            ),
            '猫, ねこ, cat\n'
        );
        writeFile(
            path.join(baseDir, 'dictionaries', 'hoshidicts', 'manifest.json'),
            '{"generated":true}'
        );
        writeFile(path.join(baseDir, 'texthook', 'luna_builds', 'LunaHost64.dll'), 'dll');
        writeFile(path.join(overlayDir, 'settings.json'), '{"fontSize":42}');
        writeFile(path.join(overlayDir, 'IndexedDB', 'ext.leveldb', '000003.log'), 'leveldb');
        writeFile(path.join(overlayDir, 'IndexedDB', 'ext.leveldb', 'LOCK'), 'lock');
        writeFile(path.join(overlayDir, 'Cache', 'Cache_Data', 'data_0'), 'cache');
        writeFile(homeConfigPath, '[general]\nwebsocket_port = 7331\n');

        const backupProgress: Array<{ phase: string; fileName?: string }> = [];
        const result = await createBackupArchive({
            outputPath,
            baseDir,
            overlayDir,
            homeConfigPath,
            onProgress: (progress) => {
                backupProgress.push(progress);
            },
        });
        await extract(outputPath, { dir: extractDir });

        expect(result.fileCount).toBeGreaterThan(0);
        expect(result.roots).toEqual(['gsm', 'home', 'overlay']);
        expect(backupProgress.some((progress) => progress.phase === 'scanning')).toBe(true);
        expect(
            backupProgress.some(
                (progress) =>
                    progress.phase === 'archiving' &&
                    progress.fileName === 'GameSentenceMiner/config.json',
            ),
        ).toBe(true);
        expect(backupProgress.at(-1)?.phase).toBe('done');
        expect(fs.existsSync(path.join(extractDir, 'gsm-backup-manifest.json'))).toBe(true);
        expect(fs.readFileSync(path.join(extractDir, 'GameSentenceMiner', 'config.json'), 'utf8')).toBe('{"gsm":true}');
        expect(fs.readFileSync(path.join(extractDir, 'GameSentenceMiner', 'gsm.db'), 'utf8')).toBe('sqlite');
        expect(
            readText(
                extractDir,
                'GameSentenceMiner',
                'dictionaries',
                'hoshidicts',
                'audio-profile.json',
            ),
        ).toContain('"enabled":true');
        expect(
            exists(
                extractDir,
                'GameSentenceMiner',
                'dictionaries',
                'hoshidicts',
                'manifest.json',
            ),
        ).toBe(false);
        expect(
            exists(
                extractDir,
                'GameSentenceMiner',
                'dictionaries',
                'hoshidicts',
                'generations',
            ),
        ).toBe(false);
        expect(fs.readFileSync(path.join(extractDir, 'GameSentenceMiner', 'ocr_config', 'Game.json'), 'utf8')).toBe(
            '{"areas":[]}',
        );
        expect(
            fs.existsSync(path.join(extractDir, 'GameSentenceMiner', 'ocr_config', 'backup', 'Game', 'old.json')),
        ).toBe(false);
        expect(
            fs.existsSync(path.join(extractDir, 'GameSentenceMiner', 'obs-studio', 'config', 'obs-studio', 'logs', 'obs.txt')),
        ).toBe(false);
        expect(fs.existsSync(path.join(extractDir, 'GameSentenceMiner', 'obs-studio', 'bin', '64bit', 'obs64.exe'))).toBe(
            false,
        );
        expect(fs.existsSync(path.join(extractDir, 'GameSentenceMiner', 'texthook', 'luna_builds', 'LunaHost64.dll'))).toBe(
            false,
        );
        expect(fs.readFileSync(path.join(extractDir, 'gsm_overlay', 'settings.json'), 'utf8')).toBe('{"fontSize":42}');
        expect(
            fs.readFileSync(
                path.join(
                    extractDir,
                    'GameSentenceMiner',
                    'dictionaries',
                    'hoshidicts',
                    'custom-dictionary.txt'
                ),
                'utf8'
            )
        ).toBe('猫, ねこ, cat\n');
        expect(
            fs.existsSync(
                path.join(
                    extractDir,
                    'GameSentenceMiner',
                    'dictionaries',
                    'hoshidicts',
                    'manifest.json'
                )
            )
        ).toBe(false);
        expect(fs.readFileSync(path.join(extractDir, 'gsm_overlay', 'IndexedDB', 'ext.leveldb', '000003.log'), 'utf8')).toBe(
            'leveldb',
        );
        expect(fs.existsSync(path.join(extractDir, 'gsm_overlay', 'IndexedDB', 'ext.leveldb', 'LOCK'))).toBe(false);
        expect(fs.existsSync(path.join(extractDir, 'gsm_overlay', 'Cache', 'Cache_Data', 'data_0'))).toBe(false);
        expect(fs.readFileSync(path.join(extractDir, 'home', '.config', 'owocr_config_gsm.ini'), 'utf8')).toContain(
            'websocket_port',
        );
    });

    it('restores settings, replacing stateful stores while preserving excluded runtime folders', async () => {
        const sourceBaseDir = makeTempDir('gsm-restore-source-base-');
        const sourceOverlayDir = makeTempDir('gsm-restore-source-overlay-');
        const sourceHomeConfig = path.join(makeTempDir('gsm-restore-source-home-'), '.config', 'owocr_config_gsm.ini');
        const archivePath = path.join(makeTempDir('gsm-restore-archive-'), 'backup.zip');

        writeFile(path.join(sourceBaseDir, 'config.json'), '{"restored":true}');
        writeFile(path.join(sourceBaseDir, 'gsm.db'), 'restored-db');
        writeFile(
            path.join(sourceBaseDir, 'dictionaries', 'hoshidicts', 'audio-profile.json'),
            '{"volume":25}',
        );
        writeFile(
            path.join(sourceBaseDir, 'dictionaries', 'hoshidicts', 'mining-profile.json'),
            '{"deck":"Restored"}',
        );
        writeFile(
            path.join(sourceBaseDir, 'dictionaries', 'hoshidicts', 'tab-groups.json'),
            '{"version":1,"groups":[{"id":"grammar","name":"Grammar","dictionaryIds":[]}]}',
        );
        writeFile(path.join(sourceBaseDir, 'ocr_config', 'Game.json'), '{"restored":true}');
        writeFile(path.join(sourceBaseDir, 'obs-studio', 'config', 'obs-studio', 'global.ini'), 'restored-global');
        writeFile(
            path.join(sourceBaseDir, 'obs-studio', 'config', 'obs-studio', 'basic', 'scenes', 'Restored.json'),
            '{"restoredScene":true}',
        );
        writeFile(path.join(sourceOverlayDir, 'settings.json'), '{"restoredOverlay":true}');
        writeFile(path.join(sourceOverlayDir, 'IndexedDB', 'ext.leveldb', '000003.log'), 'restored-leveldb');
        writeFile(sourceHomeConfig, '[general]\nwebsocket_port = 7331\n');

        await createBackupArchive({
            outputPath: archivePath,
            baseDir: sourceBaseDir,
            overlayDir: sourceOverlayDir,
            homeConfigPath: sourceHomeConfig,
        });

        const targetBaseDir = makeTempDir('gsm-restore-target-base-');
        const targetOverlayDir = makeTempDir('gsm-restore-target-overlay-');
        const targetHomeConfig = path.join(makeTempDir('gsm-restore-target-home-'), '.config', 'owocr_config_gsm.ini');

        writeFile(path.join(targetBaseDir, 'config.json'), '{"old":true}');
        writeFile(
            path.join(targetBaseDir, 'dictionaries', 'hoshidicts', 'audio-profile.json'),
            '{"volume":100}',
        );
        writeFile(
            path.join(targetBaseDir, 'dictionaries', 'hoshidicts', 'manifest.json'),
            '{"keep":true}',
        );
        writeFile(
            path.join(targetBaseDir, 'dictionaries', 'hoshidicts', 'tab-groups.json'),
            '{"version":1,"groups":[{"id":"old","name":"Old","dictionaryIds":[]}]}',
        );
        writeFile(
            path.join(targetBaseDir, 'dictionaries', 'hoshidicts', 'generations', 'dict', 'blobs.bin'),
            'keep-dictionary',
        );
        writeFile(path.join(targetBaseDir, 'ocr_config', 'Extra.json'), '{"stale":true}');
        writeFile(path.join(targetBaseDir, 'ocr_config', 'backup', 'Old', 'old.json'), '{"keep":true}');
        writeFile(path.join(targetBaseDir, 'obs-studio', 'config', 'obs-studio', 'logs', 'obs.txt'), 'keep-log');
        writeFile(
            path.join(targetBaseDir, 'obs-studio', 'config', 'obs-studio', 'basic', 'scenes', 'Old.json'),
            '{"oldScene":true}',
        );
        writeFile(path.join(targetOverlayDir, 'IndexedDB', 'ext.leveldb', 'stale.log'), 'stale');
        writeFile(path.join(targetOverlayDir, 'Cache', 'Cache_Data', 'data_0'), 'keep-cache');
        writeFile(targetHomeConfig, '[general]\nwebsocket_port = 1\n');

        const restoreProgress: Array<{ phase: string; fileName?: string }> = [];
        const restoreResult = await restoreBackupArchive({
            archivePath,
            baseDir: targetBaseDir,
            overlayDir: targetOverlayDir,
            homeConfigPath: targetHomeConfig,
            onProgress: (progress) => {
                restoreProgress.push(progress);
            },
        });

        expect(restoreResult.roots).toEqual(['gsm', 'home', 'overlay']);
        expect(restoreProgress.some((progress) => progress.phase === 'extracting')).toBe(true);
        expect(
            restoreProgress.some(
                (progress) =>
                    progress.phase === 'restoring' &&
                    progress.fileName === 'GameSentenceMiner/gsm.db',
            ),
        ).toBe(true);
        expect(restoreProgress.at(-1)?.phase).toBe('done');
        expect(fs.readFileSync(path.join(targetBaseDir, 'config.json'), 'utf8')).toBe('{"restored":true}');
        expect(fs.readFileSync(path.join(targetBaseDir, 'gsm.db'), 'utf8')).toBe('restored-db');
        expect(
            readText(targetBaseDir, 'dictionaries', 'hoshidicts', 'audio-profile.json'),
        ).toBe('{"volume":25}');
        expect(
            readText(targetBaseDir, 'dictionaries', 'hoshidicts', 'mining-profile.json'),
        ).toBe('{"deck":"Restored"}');
        // Tab groups live in the Hoshidicts manifest, so this file is excluded
        // from GSM settings backups and must survive a restore untouched.
        expect(
            readText(targetBaseDir, 'dictionaries', 'hoshidicts', 'tab-groups.json'),
        ).toContain('"name":"Old"');
        expect(
            readText(targetBaseDir, 'dictionaries', 'hoshidicts', 'manifest.json'),
        ).toBe('{"keep":true}');
        expect(
            readText(
                targetBaseDir,
                'dictionaries',
                'hoshidicts',
                'generations',
                'dict',
                'blobs.bin',
            ),
        ).toBe('keep-dictionary');
        expect(fs.readFileSync(path.join(targetBaseDir, 'ocr_config', 'Game.json'), 'utf8')).toBe('{"restored":true}');
        expect(fs.existsSync(path.join(targetBaseDir, 'ocr_config', 'Extra.json'))).toBe(false);
        expect(fs.existsSync(path.join(targetBaseDir, 'ocr_config', 'backup', 'Old', 'old.json'))).toBe(true);
        expect(fs.readFileSync(path.join(targetBaseDir, 'obs-studio', 'config', 'obs-studio', 'global.ini'), 'utf8')).toBe(
            'restored-global',
        );
        expect(
            fs.existsSync(path.join(targetBaseDir, 'obs-studio', 'config', 'obs-studio', 'basic', 'scenes', 'Old.json')),
        ).toBe(false);
        expect(fs.readFileSync(path.join(targetBaseDir, 'obs-studio', 'config', 'obs-studio', 'logs', 'obs.txt'), 'utf8')).toBe(
            'keep-log',
        );
        expect(fs.readFileSync(path.join(targetOverlayDir, 'settings.json'), 'utf8')).toBe('{"restoredOverlay":true}');
        expect(fs.readFileSync(path.join(targetOverlayDir, 'IndexedDB', 'ext.leveldb', '000003.log'), 'utf8')).toBe(
            'restored-leveldb',
        );
        expect(fs.existsSync(path.join(targetOverlayDir, 'IndexedDB', 'ext.leveldb', 'stale.log'))).toBe(false);
        expect(fs.readFileSync(path.join(targetOverlayDir, 'Cache', 'Cache_Data', 'data_0'), 'utf8')).toBe('keep-cache');
        expect(fs.readFileSync(targetHomeConfig, 'utf8')).toContain('websocket_port = 7331');
    });
});
