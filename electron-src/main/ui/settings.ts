// settings.ts
import { ipcMain, dialog } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    getAutoUpdateGSMApp,
    getAutoUpdateElectron,
    getAgentPath,
    getAgentScriptsPath,
    getConsoleMode,
    getCustomPythonPackage,
    getHasCompletedSetup,
    getLunaTranslatorPath,
    getPythonPath,
    getRunOverlayOnStartup,
    getRunWindowTransparencyToolOnStartup,
    getSceneLaunchProfileForScene,
    getSceneLaunchProfiles,
    getSetupWizardVersion,
    getShowYuzuTab,
    getStartConsoleMinimized,
    getStatsEndpoint,
    getTextractorPath32,
    getTextractorPath64,
    getUiMode,
    getVisibleTabs,
    getWindowTransparencyTarget,
    getWindowTransparencyToolHotkey,
    getYuzuGamesConfig,
    setAutoUpdateElectron,
    setAutoUpdateGSMApp,
    setAgentPath,
    setAgentScriptsPath,
    setConsoleMode,
    setCustomPythonPackage,
    setHasCompletedSetup,
    setIconStyle,
    setLunaTranslatorPath,
    setRunOverlayOnStartup,
    setRunWindowTransparencyToolOnStartup,
    setSceneLaunchProfiles,
    setSetupWizardVersion,
    setShowYuzuTab,
    setStartConsoleMinimized,
    setStatsEndpoint,
    setTextractorPath32,
    setTextractorPath64,
    setUiMode,
    setVisibleTabs,
    setWindowTransparencyTarget,
    setWindowTransparencyToolHotkey,
    upsertSceneLaunchProfile,
    store,
} from '../store.js';
import type { SceneLaunchProfile } from '../store.js';
import { getSanitizedPythonEnv } from '../util.js';
// Replaced WebSocket usage with stdout IPC helpers
import { sendOpenSettings } from '../main.js';
import { reinstallPython } from '../python/python_downloader.js';
import { runPipInstall } from '../main.js';
import { getExecutableNameFromSource, getWindowTitleFromSource } from './obs.js';
import { resolveSwitchAgentScript } from '../agent_script_resolver.js';

export let window_transparency_process: any = null; // Process for the Window Transparency Tool
const AGENT_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function isTextHookMode(value: unknown): value is SceneLaunchProfile["textHookMode"] {
    return value === "none" || value === "agent" || value === "textractor" || value === "luna";
}

function isOcrMode(value: unknown): value is SceneLaunchProfile["ocrMode"] {
    return value === "none" || value === "auto" || value === "manual";
}

function normalizeSceneProfiles(value: unknown): SceneLaunchProfile[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const deduped = new Map<string, SceneLaunchProfile>();
    for (const entry of value) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const profile = entry as Partial<SceneLaunchProfile>;
        if (typeof profile.sceneName !== "string" || profile.sceneName.trim().length === 0) {
            continue;
        }

        const sceneId =
            typeof profile.sceneId === "string" && profile.sceneId.trim().length > 0
                ? profile.sceneId
                : undefined;
        const normalized: SceneLaunchProfile = {
            sceneId,
            sceneName: profile.sceneName.trim(),
            textHookMode: isTextHookMode(profile.textHookMode)
                ? profile.textHookMode
                : "none",
            ocrMode: isOcrMode(profile.ocrMode) ? profile.ocrMode : "none",
            agentScriptPath:
                typeof profile.agentScriptPath === "string"
                    ? profile.agentScriptPath.trim()
                    : "",
        };

        const key = sceneId ? `id:${sceneId}` : `name:${normalized.sceneName}`;
        deduped.set(key, normalized);
    }

    return Array.from(deduped.values());
}

async function selectExecutablePath(defaultPath = "") {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            { name: 'Executables', extensions: ['exe'] },
            { name: 'All Files', extensions: ['*'] },
        ],
        defaultPath: defaultPath || undefined,
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    return result.filePaths[0];
}

async function selectDirectoryPath(defaultPath = "") {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        defaultPath: defaultPath || undefined,
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    return result.filePaths[0];
}

async function selectAgentScriptPath(defaultPath = "") {
    const fallbackPath = defaultPath || getAgentScriptsPath() || "";
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            { name: 'JavaScript Files', extensions: ['js', 'mjs', 'cjs'] },
            { name: 'All Files', extensions: ['*'] },
        ],
        defaultPath: fallbackPath || undefined,
    });

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    return result.filePaths[0];
}

function listAgentScriptsRecursive(rootPath: string): string[] {
    const normalizedRootPath = typeof rootPath === "string" ? rootPath.trim() : "";
    if (!normalizedRootPath || !fs.existsSync(normalizedRootPath)) {
        return [];
    }

    const files: string[] = [];
    const pendingDirectories: string[] = [normalizedRootPath];

    while (pendingDirectories.length > 0) {
        const directory = pendingDirectories.pop();
        if (!directory) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const absolutePath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                pendingDirectories.push(absolutePath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const extension = path.extname(entry.name).toLowerCase();
            if (AGENT_SCRIPT_EXTENSIONS.has(extension)) {
                files.push(absolutePath);
            }
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

async function resolveAgentScriptForScene(scene: { id: string; name: string }) {
    let processName: string | null = null;
    let windowTitle: string | null = null;

    try {
        processName = (await getExecutableNameFromSource(scene.id)) ?? null;
    } catch (error) {
        console.warn('Failed to inspect scene process for agent script resolution:', error);
    }

    try {
        windowTitle = (await getWindowTitleFromSource(scene.id)) ?? null;
    } catch (error) {
        console.warn('Failed to inspect scene window title for agent script resolution:', error);
    }

    const yuzuGame = getYuzuGamesConfig().find((game) => {
        if (!game.scene) {
            return false;
        }
        if (typeof game.scene.id === 'string' && game.scene.id === scene.id) {
            return true;
        }
        return typeof game.scene.name === 'string' && game.scene.name === scene.name;
    });

    const resolution = resolveSwitchAgentScript({
        scriptsPath: getAgentScriptsPath(),
        processName,
        windowTitle,
        sceneName: scene.name,
        explicitGameId: yuzuGame?.id ?? null,
    });
    const isExactYuzuIdMatch =
        Boolean(yuzuGame?.id) && resolution.reason === "matched_explicit_id";

    if (resolution.path) {
        return {
            status: 'success',
            path: resolution.path,
            reason: resolution.reason,
            isExactYuzuIdMatch,
            isSwitchTarget: resolution.isSwitchTarget,
            titleId: resolution.titleId,
            candidates: resolution.candidates,
            processName,
            windowTitle,
        };
    }

    return {
        status: 'not_found',
        reason: resolution.reason,
        isExactYuzuIdMatch,
        isSwitchTarget: resolution.isSwitchTarget,
        titleId: resolution.titleId,
        candidates: resolution.candidates,
        processName,
        windowTitle,
    };
}

export function registerSettingsIPC() {
    ipcMain.handle('settings.getSettings', async () => {
        return {
            autoUpdateGSMApp: getAutoUpdateGSMApp(),
            autoUpdateElectron: getAutoUpdateElectron(),
            // pythonPath: getPythonPath(),
            // agentScriptsPath: getAgentScriptsPath(),
            startConsoleMinimized: getStartConsoleMinimized(),
            customPythonPackage: getCustomPythonPackage(),
            showYuzuTab: getShowYuzuTab(),
            windowTransparencyToolHotkey: getWindowTransparencyToolHotkey(),
            windowTransparencyTarget: store.get('windowTransparencyTarget') || '', // Default to empty string if not set
            runWindowTransparencyToolOnStartup: getRunWindowTransparencyToolOnStartup(),
            runOverlayOnStartup: getRunOverlayOnStartup(),
            visibleTabs: getVisibleTabs(),
            statsEndpoint: getStatsEndpoint(),
            iconStyle: store.get('iconStyle') || 'gsm',
            consoleMode: getConsoleMode(),
            setupWizardVersion: getSetupWizardVersion(),
            uiMode: getUiMode(),
            hasCompletedSetup: getHasCompletedSetup(),
        };
    });

    ipcMain.handle('settings.saveSettings', async (_, settings: any) => {
        const payload = settings && typeof settings === 'object' ? settings : {};

        if (typeof payload.autoUpdateGSMApp === 'boolean') {
            setAutoUpdateGSMApp(payload.autoUpdateGSMApp);
        }
        // if (typeof payload.autoUpdateElectron === 'boolean') {
        //     setAutoUpdateElectron(payload.autoUpdateElectron);
        // }
        if (typeof payload.startConsoleMinimized === 'boolean') {
            setStartConsoleMinimized(payload.startConsoleMinimized);
        }
        if (typeof payload.customPythonPackage === 'string') {
            setCustomPythonPackage(payload.customPythonPackage);
        }
        if (typeof payload.showYuzuTab === 'boolean') {
            setShowYuzuTab(payload.showYuzuTab);
        }
        if (typeof payload.windowTransparencyToolHotkey === 'string') {
            setWindowTransparencyToolHotkey(payload.windowTransparencyToolHotkey);
        }
        if (typeof payload.windowTransparencyTarget === 'string') {
            setWindowTransparencyTarget(payload.windowTransparencyTarget);
        }
        if (typeof payload.runWindowTransparencyToolOnStartup === 'boolean') {
            setRunWindowTransparencyToolOnStartup(payload.runWindowTransparencyToolOnStartup);
        }
        if (typeof payload.runOverlayOnStartup === 'boolean') {
            setRunOverlayOnStartup(payload.runOverlayOnStartup);
        }
        if (Array.isArray(payload.visibleTabs)) {
            setVisibleTabs(payload.visibleTabs);
        }
        if (typeof payload.statsEndpoint === 'string') {
            setStatsEndpoint(payload.statsEndpoint || 'overview');
        }
        if (typeof payload.iconStyle === 'string') {
            setIconStyle(payload.iconStyle || 'gsm');
        }
        if (payload.consoleMode === 'simple' || payload.consoleMode === 'advanced') {
            setConsoleMode(payload.consoleMode);
        }
        if (payload.uiMode === 'basic' || payload.uiMode === 'advanced') {
            setUiMode(payload.uiMode);
        }
        if (typeof payload.hasCompletedSetup === 'boolean') {
            setHasCompletedSetup(payload.hasCompletedSetup);
        }
        if (typeof payload.setupWizardVersion === 'number' && Number.isFinite(payload.setupWizardVersion)) {
            setSetupWizardVersion(payload.setupWizardVersion);
        }
        return { success: true };
    });

    ipcMain.handle('settings.setAutoUpdateGSMApp', async (_, value: boolean) => {
        setAutoUpdateGSMApp(value);
    });

    ipcMain.handle('settings.setAutoUpdateElectron', async (_, value: boolean) => {
        setAutoUpdateElectron(value);
    });

    ipcMain.handle('settings.openGSMSettings', async () => {
        sendOpenSettings();
    });

    ipcMain.handle('settings.reinstallPython', async () => {
        // Pop box saying are you sure you want to, and then reinstall Python
        const response = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Yes', 'No'],
            title: 'Reinstall Python',
            message:
                'Are you sure you want to reinstall Python? This will remove the current installation and install a fresh copy.',
        });
        if (response.response === 0) {
            // Yes
            try {
                await reinstallPython();
                return { success: true, message: 'Python reinstalled successfully.' };
            } catch (error) {
                console.error('Failed to reinstall Python:', error);
                return { success: false, message: 'Failed to reinstall Python.' };
            }
        }
    });

    ipcMain.handle('settings.runWindowTransparencyTool', async () => {
        runWindowTransparencyTool();
    });

    ipcMain.handle('settings.runPipInstall', async (_, pkg: string) => {
        try {
            await runPipInstall(pkg);
            return { success: true };
        } catch (error: any) {
            console.error('Failed to run pip install:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('settings.getGameSettings', async () => {
        return {
            agentPath: getAgentPath() || '',
            agentScriptsPath: getAgentScriptsPath() || '',
            textractorPath64: getTextractorPath64() || '',
            textractorPath32: getTextractorPath32() || '',
            lunaTranslatorPath: getLunaTranslatorPath() || '',
            sceneProfiles: getSceneLaunchProfiles(),
        };
    });

    ipcMain.handle('settings.saveGameSettings', async (_, settings: any) => {
        if (settings && typeof settings === 'object') {
            if (typeof settings.agentPath === 'string') {
                setAgentPath(settings.agentPath.trim());
            }
            if (typeof settings.agentScriptsPath === 'string') {
                setAgentScriptsPath(settings.agentScriptsPath.trim());
            }
            if (typeof settings.textractorPath64 === 'string') {
                setTextractorPath64(settings.textractorPath64.trim());
            }
            if (typeof settings.textractorPath32 === 'string') {
                setTextractorPath32(settings.textractorPath32.trim());
            }
            if (typeof settings.lunaTranslatorPath === 'string') {
                setLunaTranslatorPath(settings.lunaTranslatorPath.trim());
            }
            if (Array.isArray(settings.sceneProfiles)) {
                setSceneLaunchProfiles(normalizeSceneProfiles(settings.sceneProfiles));
            }
        }

        return { success: true };
    });

    ipcMain.handle('settings.getSceneLaunchProfile', async (_, scene: any) => {
        if (
            !scene ||
            typeof scene !== 'object' ||
            typeof scene.id !== 'string' ||
            typeof scene.name !== 'string'
        ) {
            return null;
        }

        return getSceneLaunchProfileForScene({ id: scene.id, name: scene.name });
    });

    ipcMain.handle('settings.saveSceneLaunchProfile', async (_, payload: any) => {
        if (!payload || typeof payload !== 'object') {
            return { success: false };
        }

        const scene = payload.scene;
        if (
            !scene ||
            typeof scene !== 'object' ||
            typeof scene.id !== 'string' ||
            typeof scene.name !== 'string'
        ) {
            return { success: false };
        }

        const textHookMode = isTextHookMode(payload.textHookMode)
            ? payload.textHookMode
            : "none";
        const ocrMode = isOcrMode(payload.ocrMode) ? payload.ocrMode : "none";
        const agentScriptPath =
            typeof payload.agentScriptPath === 'string'
                ? payload.agentScriptPath.trim()
                : "";

        upsertSceneLaunchProfile({
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode,
            ocrMode,
            agentScriptPath,
        });

        return { success: true };
    });

    ipcMain.handle('settings.resolveAgentScriptForScene', async (_, payload: any) => {
        const scene = payload?.scene;
        if (
            !scene ||
            typeof scene !== 'object' ||
            typeof scene.id !== 'string' ||
            typeof scene.name !== 'string'
        ) {
            return { status: 'invalid' };
        }

        return resolveAgentScriptForScene({ id: scene.id, name: scene.name });
    });

    ipcMain.handle('settings.selectAgentPath', async () => {
        const filePath = await selectExecutablePath(getAgentPath());
        if (!filePath) {
            return { status: 'canceled', message: 'No file selected' };
        }
        setAgentPath(filePath);
        return { status: 'success', path: filePath };
    });

    ipcMain.handle('settings.selectAgentScriptsPath', async () => {
        const directory = await selectDirectoryPath(getAgentScriptsPath());
        if (!directory) {
            return { status: 'canceled', message: 'No directory selected' };
        }
        setAgentScriptsPath(directory);
        return { status: 'success', path: directory };
    });

    ipcMain.handle('settings.selectAgentScriptPath', async (_, payload: any) => {
        const fallbackPath =
            payload && typeof payload.path === 'string' ? payload.path.trim() : "";
        const filePath = await selectAgentScriptPath(fallbackPath);
        if (!filePath) {
            return { status: 'canceled', message: 'No file selected' };
        }
        return { status: 'success', path: filePath };
    });

    ipcMain.handle('settings.listAgentScripts', async (_, payload: any) => {
        const payloadPath =
            payload && typeof payload.path === "string" ? payload.path.trim() : "";
        let scriptsPath = payloadPath || getAgentScriptsPath() || "";

        if (scriptsPath && fs.existsSync(scriptsPath)) {
            try {
                const stats = fs.statSync(scriptsPath);
                if (stats.isFile()) {
                    scriptsPath = path.dirname(scriptsPath);
                }
            } catch {
                // Keep the current value and let the listing logic handle failures.
            }
        }

        if (!scriptsPath) {
            return {
                status: 'missing_path',
                scripts: [],
                message: 'Set Agent Scripts Path first.',
            };
        }

        const scripts = listAgentScriptsRecursive(scriptsPath);
        if (scripts.length === 0) {
            return {
                status: 'empty',
                scripts: [],
                message: `No scripts found in ${scriptsPath}.`,
            };
        }

        return {
            status: 'success',
            scripts,
            path: scriptsPath,
        };
    });

    ipcMain.handle('settings.selectTextractorPath64', async () => {
        const filePath = await selectExecutablePath(getTextractorPath64());
        if (!filePath) {
            return { status: 'canceled', message: 'No file selected' };
        }
        setTextractorPath64(filePath);
        return { status: 'success', path: filePath };
    });

    ipcMain.handle('settings.selectTextractorPath32', async () => {
        const filePath = await selectExecutablePath(getTextractorPath32());
        if (!filePath) {
            return { status: 'canceled', message: 'No file selected' };
        }
        setTextractorPath32(filePath);
        return { status: 'success', path: filePath };
    });

    ipcMain.handle('settings.selectLunaTranslatorPath', async () => {
        const filePath = await selectExecutablePath(getLunaTranslatorPath());
        if (!filePath) {
            return { status: 'canceled', message: 'No file selected' };
        }
        setLunaTranslatorPath(filePath);
        return { status: 'success', path: filePath };
    });

    // ipcMain.handle('settings.selectPythonPath', async () => {
    //     const result = await dialog.showOpenDialog({
    //         properties: ['openFile'],
    //         filters: [
    //             { name: 'Executables', extensions: ['exe'] },
    //             { name: 'All Files', extensions: ['*'] },
    //         ],
    //     });
    //
    //     if (!result.canceled && result.filePaths.length > 0) {
    //         setPythonPath(result.filePaths[0]);
    //         return { filePath: result.filePaths[0] };
    //     }
    //
    //     return null;
    // });
    //
    // ipcMain.handle('settings.selectAgentScriptsPath', async () => {
    //     const result = await dialog.showOpenDialog({
    //         properties: ['openDirectory'],
    //     });
    //
    //     if (!result.canceled && result.filePaths.length > 0) {
    //         setAgentScriptsPath(result.filePaths[0]);
    //         return { filePath: result.filePaths[0] };
    //     }
    //
    //     return null;
    // });

    ipcMain.handle('settings.setStartConsoleMinimized', async (_, value: boolean) => {
        setStartConsoleMinimized(value);
    });
}

export function runWindowTransparencyTool() {
    const hotkey = getWindowTransparencyToolHotkey();
    if (window_transparency_process && !window_transparency_process.killed) {
        console.log('Stopping existing Window Transparency Tool process');
        window_transparency_process.kill();
    }
    console.log(
        `Starting Window Transparency Tool with hotkey: ${hotkey} and target: ${getWindowTransparencyTarget()}`
    );
    window_transparency_process = spawn(getPythonPath(), [
        '-m',
        'GameSentenceMiner.tools.window_transparency',
        '--hotkey',
        hotkey,
        '--window',
        getWindowTransparencyTarget(),
    ], {
        env: getSanitizedPythonEnv()
    });
    window_transparency_process.stdout.on('data', (data: any) => {
        console.log(`Window Transparency Tool: ${data}`);
    });
    window_transparency_process.stderr.on('data', (data: any) => {
        console.error(`Window Transparency Tool Error: ${data}`);
    });
}

export function stopWindowTransparencyTool() {
    if (window_transparency_process) {
        window_transparency_process.kill();
        window_transparency_process = null;
    }
}
