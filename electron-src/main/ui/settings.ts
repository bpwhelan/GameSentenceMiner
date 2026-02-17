// settings.ts
import { ipcMain, dialog, app, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import extract from 'extract-zip';
import {
    getAutoUpdateGSMApp,
    getAutoUpdateElectron,
    getAgentPath,
    getAgentScriptsPath,
    getConsoleMode,
    getCustomPythonPackage,
    getHasCompletedSetup,
    getLaunchLunaTranslatorMinimized,
    getLunaTranslatorPath,
    getLaunchAgentMinimized,
    getLaunchTextractorMinimized,
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
    setLaunchLunaTranslatorMinimized,
    setLunaTranslatorPath,
    setLaunchAgentMinimized,
    setLaunchTextractorMinimized,
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
type DownloadableTool = 'agent' | 'textractor';
type ToolName = DownloadableTool | 'luna';

const TOOL_RELEASES_URLS: Record<ToolName, string> = {
    agent: 'https://github.com/0xDC00/agent/releases/latest',
    luna: 'https://github.com/HIllya51/LunaTranslator/releases',
    textractor: 'https://github.com/Chenx221/Textractor/releases',
};
const TEXTRACTOR_WEBSOCKET_RELEASES_URL = 'https://github.com/kuroahna/textractor_websocket/releases/';

// Optional override for downloading Agent "data" bundle during Agent installation.
// Leave as empty string to disable.
// Expected: URL to a ZIP archive containing Agent data files (for example: data/scripts/**).
const AGENT_DATA_ARCHIVE_URL = 'https://gsm.beangate.us/agent/data.zip';

interface GitHubReleaseAsset {
    name?: string;
    browser_download_url?: string;
}

interface GitHubReleaseResponse {
    tag_name?: string;
    assets?: GitHubReleaseAsset[];
}

interface InstalledToolPaths {
    agentPath?: string;
    agentScriptsPath?: string;
    lunaTranslatorPath?: string;
    textractorPath64?: string;
    textractorPath32?: string;
}

function isDownloadableTool(value: unknown): value is DownloadableTool {
    return value === 'agent' || value === 'textractor';
}

function isToolName(value: unknown): value is ToolName {
    return value === 'agent' || value === 'luna' || value === 'textractor';
}

function getToolReleasesUrl(tool: ToolName): string {
    return TOOL_RELEASES_URLS[tool];
}

function getExpectedInstallFolderName(tool: DownloadableTool): string {
    if (tool === 'agent') {
        return 'Agent';
    }
    return 'Textractor';
}

function isFolderNameAppropriate(selectedDirectory: string, expectedFolderName: string): boolean {
    const selectedName = path.basename(selectedDirectory).trim().toLowerCase();
    const expectedName = expectedFolderName.trim().toLowerCase();
    if (!selectedName || !expectedName) {
        return false;
    }

    return selectedName.includes(expectedName) || expectedName.includes(selectedName);
}

function normalizeInstallDestinationPath(tool: DownloadableTool, selectedDirectory: string): string {
    const expectedFolderName = getExpectedInstallFolderName(tool);
    if (isFolderNameAppropriate(selectedDirectory, expectedFolderName)) {
        return selectedDirectory;
    }

    return path.join(selectedDirectory, expectedFolderName);
}

function getDefaultDocumentsInstallDirectory(tool: DownloadableTool): string {
    const documentsDirectory = app.getPath('documents');
    if (tool === 'agent') {
        return path.join(documentsDirectory, 'Agent');
    }
    return path.join(documentsDirectory, 'Textractor');
}

function inferTextractorBaseDirectory(executablePath: string): string {
    const trimmedPath = executablePath.trim();
    if (!trimmedPath) {
        return '';
    }

    const executableDirectory = path.dirname(trimmedPath);
    const executableName = path.basename(trimmedPath).toLowerCase();
    const directoryName = path.basename(executableDirectory).toLowerCase();

    if (executableName === 'textractor.exe' && (directoryName === 'x64' || directoryName === 'x86')) {
        return path.dirname(executableDirectory);
    }

    return executableDirectory;
}

function getPreferredInstallDirectory(tool: DownloadableTool): string {
    if (tool === 'agent') {
        const configuredAgentPath = getAgentPath().trim();
        if (configuredAgentPath) {
            return path.dirname(configuredAgentPath);
        }

        const configuredScriptsPath = getAgentScriptsPath().trim();
        if (configuredScriptsPath) {
            const scriptsDirectoryName = path.basename(configuredScriptsPath).toLowerCase();
            const dataDirectoryName = path.basename(path.dirname(configuredScriptsPath)).toLowerCase();
            if (scriptsDirectoryName === 'scripts' && dataDirectoryName === 'data') {
                return path.dirname(path.dirname(configuredScriptsPath));
            }
            return path.dirname(configuredScriptsPath);
        }
    }

    if (tool === 'textractor') {
        const configuredTextractor64 = getTextractorPath64().trim();
        if (configuredTextractor64) {
            return inferTextractorBaseDirectory(configuredTextractor64);
        }

        const configuredTextractor32 = getTextractorPath32().trim();
        if (configuredTextractor32) {
            return inferTextractorBaseDirectory(configuredTextractor32);
        }
    }

    return getDefaultDocumentsInstallDirectory(tool);
}

async function fetchLatestGitHubRelease(owner: string, repo: string): Promise<GitHubReleaseResponse> {
    const response = await axios.get<GitHubReleaseResponse>(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
        {
            timeout: 30000,
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'GameSentenceMiner',
            },
            validateStatus: (status) => status >= 200 && status < 300,
        }
    );

    return response.data;
}

function pickReleaseAsset(
    release: GitHubReleaseResponse,
    matcher: RegExp,
): { name: string; downloadUrl: string } | null {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    for (const asset of assets) {
        const name = typeof asset.name === 'string' ? asset.name : '';
        const downloadUrl =
            typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
        if (!name || !downloadUrl) {
            continue;
        }
        if (matcher.test(name)) {
            return { name, downloadUrl };
        }
    }

    return null;
}

async function downloadZipFile(downloadUrl: string, destinationZipPath: string): Promise<void> {
    const response = await axios.get<ArrayBuffer>(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxRedirects: 5,
        headers: {
            'User-Agent': 'GameSentenceMiner',
            Accept: 'application/octet-stream',
        },
        validateStatus: (status) => status >= 200 && status < 300,
    });

    fs.writeFileSync(destinationZipPath, Buffer.from(response.data));
}

function findFirstDllRecursive(rootDirectory: string): string | null {
    const pendingDirectories: string[] = [rootDirectory];

    while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop();
        if (!currentDirectory) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const absolutePath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                pendingDirectories.push(absolutePath);
                continue;
            }

            if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.dll') {
                return absolutePath;
            }
        }
    }

    return null;
}

async function installTextractorWebsocketPlugins(tempDirectory: string, destinationPath: string): Promise<void> {
    const release = await fetchLatestGitHubRelease('kuroahna', 'textractor_websocket');
    const x64Asset = pickReleaseAsset(release, /^textractor_websocket_x64\.zip$/i);
    const x86Asset = pickReleaseAsset(release, /^textractor_websocket_x86\.zip$/i);

    if (!x64Asset || !x86Asset) {
        throw new Error(
            'Textractor websocket plugin assets were not found in the latest release. Opened plugin releases page.'
        );
    }

    const variants: Array<{ asset: { name: string; downloadUrl: string }; arch: 'x64' | 'x86' }> = [
        { asset: x64Asset, arch: 'x64' },
        { asset: x86Asset, arch: 'x86' },
    ];

    for (const variant of variants) {
        const downloadedZipPath = path.join(tempDirectory, variant.asset.name);
        const extractedPluginTempDirectory = fs.mkdtempSync(
            path.join(tempDirectory, `textractor-websocket-${variant.arch}-`)
        );

        try {
            await downloadZipFile(variant.asset.downloadUrl, downloadedZipPath);
            await extract(downloadedZipPath, { dir: extractedPluginTempDirectory });

            const pluginDllPath = findFirstDllRecursive(extractedPluginTempDirectory);
            if (!pluginDllPath) {
                throw new Error(
                    `Textractor websocket plugin ZIP for ${variant.arch} did not contain a DLL file.`
                );
            }

            const targetDirectory = path.join(destinationPath, variant.arch);
            fs.mkdirSync(targetDirectory, { recursive: true });
            const targetDllPath = path.join(targetDirectory, path.basename(pluginDllPath));
            fs.copyFileSync(pluginDllPath, targetDllPath);

            const savedExtensionsPath = path.join(targetDirectory, 'SavedExtensions.txt');
            const websocketPluginName =
                variant.arch === 'x64'
                    ? 'textractor_websocket_x64'
                    : 'textractor_websocket_x86';
            const savedExtensionsValue =
                `Remove Repeated Characters>Regex Filter>Copy to Clipboard>Extra Newlines>${websocketPluginName}>`;
            fs.writeFileSync(savedExtensionsPath, savedExtensionsValue, 'utf8');
        } finally {
            try {
                fs.rmSync(extractedPluginTempDirectory, { recursive: true, force: true });
            } catch {
                // Ignore cleanup failures.
            }
        }
    }
}

async function installToolArchive(
    tool: DownloadableTool,
    destinationPath: string
): Promise<{
    releaseTag: string;
    assetName: string;
    paths: InstalledToolPaths;
    status?: 'asset_not_found';
    releasePageUrl?: string;
    message?: string;
}> {
    fs.mkdirSync(destinationPath, { recursive: true });

    let release: GitHubReleaseResponse;
    let asset: { name: string; downloadUrl: string } | null = null;

    if (tool === 'agent') {
        release = await fetchLatestGitHubRelease('0xDC00', 'agent');
        asset = pickReleaseAsset(release, /^agent-v[\d.]+-win32-x64\.zip$/i);
    } else {
        release = await fetchLatestGitHubRelease('Chenx221', 'Textractor');
        asset = pickReleaseAsset(release, /^Textractor_\d+\.zip$/i);
    }

    if (!asset) {
        return {
            releaseTag: typeof release.tag_name === 'string' ? release.tag_name : 'latest',
            assetName: '',
            paths: {},
            status: 'asset_not_found',
            releasePageUrl: getToolReleasesUrl(tool),
            message: `No matching downloadable ZIP was found for ${tool} in the latest release assets.`,
        };
    }

    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-tool-download-'));
    const zipPath = path.join(tempDirectory, asset.name);

    try {
        await downloadZipFile(asset.downloadUrl, zipPath);
        await extract(zipPath, { dir: destinationPath });

        if (tool === 'agent' && AGENT_DATA_ARCHIVE_URL.trim()) {
            const dataArchivePath = path.join(tempDirectory, 'agent-data.zip');
            const dataDestinationPath = path.join(destinationPath, 'data');
            await downloadZipFile(AGENT_DATA_ARCHIVE_URL.trim(), dataArchivePath);
            await extract(dataArchivePath, { dir: dataDestinationPath });
        }

        if (tool === 'textractor') {
            await installTextractorWebsocketPlugins(tempDirectory, destinationPath);
        }
    } finally {
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failures.
        }
    }

    const paths: InstalledToolPaths = {};
    if (tool === 'agent') {
        const agentPath = path.join(destinationPath, 'agent.exe');
        const agentScriptsPath = path.join(destinationPath, 'data', 'scripts');
        setAgentPath(agentPath);
        setAgentScriptsPath(agentScriptsPath);
        paths.agentPath = agentPath;
        paths.agentScriptsPath = agentScriptsPath;
    } else {
        const textractorPath32 = path.join(destinationPath, 'x86', 'Textractor.exe');
        const textractorPath64 = path.join(destinationPath, 'x64', 'Textractor.exe');
        setTextractorPath32(textractorPath32);
        setTextractorPath64(textractorPath64);
        paths.textractorPath32 = textractorPath32;
        paths.textractorPath64 = textractorPath64;
    }

    return {
        releaseTag: typeof release.tag_name === 'string' ? release.tag_name : 'latest',
        assetName: asset.name,
        paths,
    };
}

function isTextHookMode(value: unknown): value is SceneLaunchProfile["textHookMode"] {
    return value === "none" || value === "agent" || value === "textractor" || value === "luna";
}

function isOcrMode(value: unknown): value is SceneLaunchProfile["ocrMode"] {
    return value === "none" || value === "auto" || value === "manual";
}

function normalizeLaunchDelaySeconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
    }

    const clamped = Math.max(0, Math.min(300, value));
    return Math.round(clamped * 10) / 10;
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
            launchDelaySeconds: normalizeLaunchDelaySeconds(profile.launchDelaySeconds),
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
            launchAgentMinimized: getLaunchAgentMinimized(),
            launchTextractorMinimized: getLaunchTextractorMinimized(),
            launchLunaTranslatorMinimized: getLaunchLunaTranslatorMinimized(),
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
            if (typeof settings.launchAgentMinimized === 'boolean') {
                setLaunchAgentMinimized(settings.launchAgentMinimized);
            }
            if (typeof settings.launchTextractorMinimized === 'boolean') {
                setLaunchTextractorMinimized(settings.launchTextractorMinimized);
            }
            if (typeof settings.launchLunaTranslatorMinimized === 'boolean') {
                setLaunchLunaTranslatorMinimized(settings.launchLunaTranslatorMinimized);
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
        const launchDelaySeconds = normalizeLaunchDelaySeconds(payload.launchDelaySeconds);

        upsertSceneLaunchProfile({
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode,
            ocrMode,
            agentScriptPath,
            launchDelaySeconds,
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

    ipcMain.handle('settings.downloadAndInstallTool', async (_, payload: any) => {
        const rawTool = typeof payload?.tool === 'string' ? payload.tool.toLowerCase().trim() : '';
        if (!isDownloadableTool(rawTool)) {
            return { status: 'invalid', message: 'Unsupported tool request.' };
        }

        const tool = rawTool;
        const preferredInstallDirectory = getPreferredInstallDirectory(tool);
        const pickerDefaultDirectory = path.dirname(preferredInstallDirectory) || preferredInstallDirectory;
        const selectedDirectory = await selectDirectoryPath(pickerDefaultDirectory);
        if (!selectedDirectory) {
            return { status: 'canceled', message: 'No directory selected.' };
        }

        const destinationPath = normalizeInstallDestinationPath(tool, selectedDirectory);

        try {
            const installResult = await installToolArchive(tool, destinationPath);
            if (installResult.status === 'asset_not_found') {
                if (installResult.releasePageUrl) {
                    await shell.openExternal(installResult.releasePageUrl);
                }

                return {
                    status: 'asset_not_found',
                    tool,
                    destinationPath,
                    releaseTag: installResult.releaseTag,
                    releasePageUrl: installResult.releasePageUrl,
                    message:
                        installResult.message ||
                        'No matching downloadable asset found. Opened the releases page.',
                };
            }

            return {
                status: 'success',
                tool,
                destinationPath,
                releaseTag: installResult.releaseTag,
                assetName: installResult.assetName,
                paths: installResult.paths,
            };
        } catch (error: any) {
            console.error(`Failed to download/install ${tool}:`, error);
            if (tool === 'textractor') {
                await shell.openExternal(TEXTRACTOR_WEBSOCKET_RELEASES_URL);
            }
            return {
                status: 'error',
                message: typeof error?.message === 'string'
                    ? error.message
                    : `Failed to download and install ${tool}.`,
            };
        }
    });

    ipcMain.handle('settings.openToolReleasesPage', async (_, payload: any) => {
        const rawTool = typeof payload?.tool === 'string' ? payload.tool.toLowerCase().trim() : '';
        if (!isToolName(rawTool)) {
            return { status: 'invalid', message: 'Unsupported tool request.' };
        }

        const releasePageUrl = getToolReleasesUrl(rawTool);
        await shell.openExternal(releasePageUrl);
        return {
            status: 'success',
            tool: rawTool,
            url: releasePageUrl,
        };
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
