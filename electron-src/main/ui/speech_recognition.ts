import { ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    sendWindowsSpeechGetStatus,
    sendWindowsSpeechStart,
    sendWindowsSpeechStop,
} from '../main.js';
import { BASE_DIR, sanitizeFilename } from '../util.js';
import type { ObsScene } from './obs.js';

const CONFIG_DIR_NAME = 'windows_speech_config';

type JsonObject = Record<string, unknown>;

export interface WindowsSpeechSceneSettings {
    backend: 'embedded' | 'sapi';
    language: 'ja' | 'en';
    modelPath: string;
    runtimePath: string;
    licenseFile: string;
}

export interface WindowsSpeechSceneConfig {
    version: 1;
    scene: ObsScene;
    settings: WindowsSpeechSceneSettings;
}

export interface WindowsSpeechSceneSnapshot {
    success: boolean;
    exists: boolean;
    scene: ObsScene;
    settings: WindowsSpeechSceneSettings;
    configPath?: string;
    error?: string;
}

const DEFAULT_SETTINGS: WindowsSpeechSceneSettings = {
    backend: 'embedded',
    language: 'ja',
    modelPath: '',
    runtimePath: '',
    licenseFile: '',
};

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeScene(value: unknown): ObsScene | null {
    if (!isObject(value)) {
        return null;
    }
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!id || !name) {
        return null;
    }
    return { id, name };
}

function normalizeBackend(value: unknown): 'embedded' | 'sapi' {
    return String(value ?? '').trim().toLowerCase() === 'sapi' ? 'sapi' : 'embedded';
}

function normalizeLanguage(value: unknown): 'ja' | 'en' {
    return String(value ?? '').trim().toLowerCase().startsWith('en') ? 'en' : 'ja';
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeWindowsSpeechSceneSettings(value: unknown): WindowsSpeechSceneSettings {
    const settings = isObject(value) ? value : {};
    return {
        backend: normalizeBackend(settings.backend),
        language: normalizeLanguage(settings.language),
        modelPath: stringValue(settings.modelPath),
        runtimePath: stringValue(settings.runtimePath),
        licenseFile: stringValue(settings.licenseFile),
    };
}

export function getWindowsSpeechSceneConfigPath(scene: ObsScene, baseDir = BASE_DIR): string {
    const stableName = sanitizeFilename(scene.id) || sanitizeFilename(scene.name) || 'scene';
    return path.join(baseDir, CONFIG_DIR_NAME, `${stableName}.json`);
}

export function createWindowsSpeechSceneConfig(
    scene: ObsScene,
    settings: WindowsSpeechSceneSettings
): WindowsSpeechSceneConfig {
    return {
        version: 1,
        scene: { ...scene },
        settings: normalizeWindowsSpeechSceneSettings(settings),
    };
}

export function resolveWindowsSpeechSceneSettings(
    scene: ObsScene,
    storedConfig: unknown
): WindowsSpeechSceneSnapshot {
    const config = isObject(storedConfig) ? storedConfig : null;
    return {
        success: true,
        exists: config !== null,
        scene: { ...scene },
        settings: config
            ? normalizeWindowsSpeechSceneSettings(config.settings)
            : { ...DEFAULT_SETTINGS },
    };
}

function readSceneConfig(scene: ObsScene): WindowsSpeechSceneSnapshot {
    const configPath = getWindowsSpeechSceneConfigPath(scene);
    if (!fs.existsSync(configPath)) {
        return { ...resolveWindowsSpeechSceneSettings(scene, null), configPath };
    }
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    return {
        ...resolveWindowsSpeechSceneSettings(scene, JSON.parse(raw)),
        configPath,
    };
}

function writeSceneConfig(scene: ObsScene, settings: WindowsSpeechSceneSettings): string {
    const configPath = getWindowsSpeechSceneConfigPath(scene);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
        configPath,
        JSON.stringify(createWindowsSpeechSceneConfig(scene, settings), null, 4),
        'utf8'
    );
    return configPath;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function registerWindowsSpeechRecognitionIPC(): void {
    ipcMain.handle('speech-recognition.loadScene', async (_event, payload: { scene?: unknown }) => {
        const scene = normalizeScene(payload?.scene);
        if (!scene) {
            return {
                success: false,
                exists: false,
                scene: { id: '', name: '' },
                settings: { ...DEFAULT_SETTINGS },
                error: 'A valid OBS scene is required.',
            } satisfies WindowsSpeechSceneSnapshot;
        }
        try {
            return readSceneConfig(scene);
        } catch (error) {
            return {
                success: false,
                exists: false,
                scene,
                settings: { ...DEFAULT_SETTINGS },
                error: errorMessage(error),
            } satisfies WindowsSpeechSceneSnapshot;
        }
    });

    ipcMain.handle(
        'speech-recognition.saveScene',
        async (_event, payload: { scene?: unknown; settings?: unknown }) => {
            const scene = normalizeScene(payload?.scene);
            if (!scene) {
                return { success: false, error: 'A valid OBS scene is required.' };
            }
            try {
                const settings = normalizeWindowsSpeechSceneSettings(payload?.settings);
                return { success: true, scene, configPath: writeSceneConfig(scene, settings) };
            } catch (error) {
                return { success: false, error: errorMessage(error) };
            }
        }
    );

    ipcMain.handle(
        'speech-recognition.start',
        async (_event, payload: { scene?: unknown; settings?: unknown }) => {
            const scene = normalizeScene(payload?.scene);
            if (!scene) {
                return { success: false, error: 'A valid OBS scene is required.' };
            }
            try {
                const settings = normalizeWindowsSpeechSceneSettings(payload?.settings);
                const configPath = writeSceneConfig(scene, settings);
                const backendConnected = sendWindowsSpeechStart({
                    sceneId: scene.id,
                    sceneName: scene.name,
                    settings,
                });
                return { success: true, scene, configPath, backendConnected };
            } catch (error) {
                return { success: false, error: errorMessage(error) };
            }
        }
    );

    ipcMain.handle('speech-recognition.stop', async () => ({
        success: true,
        backendConnected: sendWindowsSpeechStop(),
    }));

    ipcMain.handle('speech-recognition.getStatus', async () => ({
        success: true,
        backendConnected: sendWindowsSpeechGetStatus(),
    }));
}
