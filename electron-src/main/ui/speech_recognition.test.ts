import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../main.js', () => ({
    sendWindowsSpeechGetStatus: vi.fn(),
    sendWindowsSpeechStart: vi.fn(),
    sendWindowsSpeechStop: vi.fn(),
}));

vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    sanitizeFilename: (value: string) => value.replace(/[ <>:"/\\|?*\x00-\x1F]/g, ''),
}));

import {
    createWindowsSpeechSceneConfig,
    getWindowsSpeechSceneConfigPath,
    resolveWindowsSpeechSceneSettings,
} from './speech_recognition.js';

describe('Windows speech scene settings', () => {
    const sceneA = { id: 'scene-a', name: 'Game A' };
    const sceneB = { id: 'scene-b', name: 'Game B' };

    it('uses stable scene IDs for separate config files', () => {
        const pathA = getWindowsSpeechSceneConfigPath(sceneA, 'C:\\gsm');
        const pathB = getWindowsSpeechSceneConfigPath(sceneB, 'C:\\gsm');

        expect(pathA).not.toBe(pathB);
        expect(pathA).toContain('scene-a.json');
        expect(pathB).toContain('scene-b.json');
    });

    it('loads and normalizes settings from a scene config', () => {
        const result = resolveWindowsSpeechSceneSettings(sceneA, {
            version: 1,
            scene: sceneA,
            settings: {
                backend: 'SAPI',
                language: 'ja-JP',
                modelPath: ' model ',
            },
        });

        expect(result).toMatchObject({
            success: true,
            scene: sceneA,
            settings: {
                backend: 'sapi',
                language: 'ja',
                modelPath: 'model',
            },
        });
    });

    it('writes the selected scene identity into its config', () => {
        const config = createWindowsSpeechSceneConfig(sceneB, {
            backend: 'embedded',
            language: 'en',
            modelPath: 'model',
            runtimePath: 'runtime',
            licenseFile: 'license',
        });

        expect(config).toEqual({
            version: 1,
            scene: sceneB,
            settings: {
                backend: 'embedded',
                language: 'en',
                modelPath: 'model',
                runtimePath: 'runtime',
                licenseFile: 'license',
            },
        });
    });

    it('returns scene defaults when no config exists yet', () => {
        const result = resolveWindowsSpeechSceneSettings(sceneA, null);

        expect(result).toMatchObject({
            success: true,
            exists: false,
            scene: sceneA,
            settings: { backend: 'embedded', language: 'ja' },
        });
    });
});
