// settings.ts
import { ipcMain, dialog, app, shell, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import extract from 'extract-zip';
import semver from 'semver';
import {
    getAutoUpdateGSMApp,
    getAutoUpdateElectron,
    getAgentPath,
    getPullPreReleases,
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
    getLocale,
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
    setPullPreReleases,
    setConsoleMode,
    setCustomPythonPackage,
    setHasCompletedSetup,
    setIconStyle,
    setLocale,
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
import { APP_NAME, BASE_DIR, getSanitizedPythonEnv } from '../util.js';
// Replaced WebSocket usage with stdout IPC helpers
import {
    isPythonLaunchBlockedByUpdate,
    mainWindow,
    sendOpenOverlaySettings,
    sendOpenSettings,
} from '../main.js';
import { reinstallPython } from '../python/python_downloader.js';
import { runPipInstall } from '../main.js';
import { getExecutableNameFromSource, getWindowTitleFromSource } from './obs.js';
import { resolveSwitchAgentScript } from '../agent_script_resolver.js';

export let window_transparency_process: any = null; // Process for the Window Transparency Tool
const AGENT_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
type DownloadableTool = 'agent' | 'textractor';
type ToolName = DownloadableTool | 'luna';
type ToolDownloadStage =
    | 'preparing'
    | 'fetch_release'
    | 'download_archive'
    | 'extract_archive'
    | 'download_data'
    | 'install_plugins'
    | 'finalize';

interface ToolDownloadProgressEvent {
    tool: DownloadableTool;
    stage: ToolDownloadStage;
    message: string;
    progress?: number | null;
    downloadedBytes?: number;
    totalBytes?: number;
    assetName?: string;
}

type ToolDownloadProgressReporter = (
    progress: Omit<ToolDownloadProgressEvent, 'tool'>
) => void;

const TOOL_DOWNLOAD_PROGRESS_CHANNEL = 'settings-tool-download-progress';

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function isPermissionOrLockError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const code =
        typeof (error as { code?: unknown }).code === 'string'
            ? ((error as { code: string }).code || '').toUpperCase()
            : '';
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

async function copyFileWithRetry(
    sourcePath: string,
    destinationPath: string,
    attempts: number = 10,
    retryDelayMs: number = 250
): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            fs.copyFileSync(sourcePath, destinationPath);
            return;
        } catch (error) {
            lastError = error;
            if (!isPermissionOrLockError(error) || attempt === attempts - 1) {
                throw error;
            }
            await sleep(retryDelayMs);
        }
    }

    if (lastError) {
        throw lastError;
    }
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

function parseContentLengthHeader(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
    }

    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    if (Array.isArray(value) && value.length > 0) {
        return parseContentLengthHeader(value[0]);
    }

    return undefined;
}

function clampUnitProgress(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    return Math.max(0, Math.min(1, value));
}

function emitToolDownloadProgress(
    event: IpcMainInvokeEvent,
    progress: ToolDownloadProgressEvent
): void {
    event.sender.send(TOOL_DOWNLOAD_PROGRESS_CHANNEL, progress);
}

async function downloadZipFile(
    downloadUrl: string,
    destinationZipPath: string,
    onProgress?: (payload: { downloadedBytes: number; totalBytes?: number }) => void
): Promise<void> {
    const response = await axios.get<NodeJS.ReadableStream>(downloadUrl, {
        responseType: 'stream',
        timeout: 120000,
        maxRedirects: 5,
        headers: {
            'User-Agent': 'GameSentenceMiner',
            Accept: 'application/octet-stream',
        },
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const totalBytes = parseContentLengthHeader(response.headers?.['content-length']);
    const reader = response.data;
    const writer = fs.createWriteStream(destinationZipPath);

    await new Promise<void>((resolve, reject) => {
        let downloadedBytes = 0;
        let lastReportedBytes = 0;
        let lastReportAt = 0;

        const reportProgress = (force: boolean) => {
            if (!onProgress) {
                return;
            }

            const now = Date.now();
            if (
                force ||
                downloadedBytes - lastReportedBytes >= 256 * 1024 ||
                now - lastReportAt >= 200
            ) {
                lastReportedBytes = downloadedBytes;
                lastReportAt = now;
                onProgress({ downloadedBytes, totalBytes });
            }
        };

        const onReaderError = (error: unknown) => {
            writer.destroy();
            reject(error);
        };

        const onWriterError = (error: unknown) => {
            reject(error);
        };

        reader.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            reportProgress(false);
        });
        reader.once('error', onReaderError);
        writer.once('error', onWriterError);
        writer.once('finish', () => {
            reportProgress(true);
            resolve();
        });

        reader.pipe(writer);
    });
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

async function installTextractorWebsocketPlugins(
    tempDirectory: string,
    destinationPath: string,
    reportProgress?: ToolDownloadProgressReporter
): Promise<string[]> {
    const warnings: string[] = [];
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
            reportProgress?.({
                stage: 'install_plugins',
                message: `Downloading websocket plugin (${variant.arch})...`,
                assetName: variant.asset.name,
                progress: 0,
            });
            await downloadZipFile(variant.asset.downloadUrl, downloadedZipPath, (payload) => {
                const normalizedProgress =
                    typeof payload.totalBytes === 'number' && payload.totalBytes > 0
                        ? clampUnitProgress(payload.downloadedBytes / payload.totalBytes)
                        : null;
                reportProgress?.({
                    stage: 'install_plugins',
                    message: `Downloading websocket plugin (${variant.arch})...`,
                    assetName: variant.asset.name,
                    progress: normalizedProgress,
                    downloadedBytes: payload.downloadedBytes,
                    totalBytes: payload.totalBytes,
                });
            });
            reportProgress?.({
                stage: 'install_plugins',
                message: `Installing websocket plugin (${variant.arch})...`,
                assetName: variant.asset.name,
                progress: null,
            });
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
            try {
                await copyFileWithRetry(pluginDllPath, targetDllPath);
            } catch (error) {
                const existingFilePresent = fs.existsSync(targetDllPath);
                if (isPermissionOrLockError(error) && existingFilePresent) {
                    warnings.push(
                        `Could not overwrite ${path.basename(targetDllPath)} because it is in use. Existing plugin file was kept.`
                    );
                } else if (isPermissionOrLockError(error)) {
                    throw new Error(
                        `Permission denied while writing ${targetDllPath}. Close Textractor and check Windows folder protection/antivirus settings, then retry.`
                    );
                } else {
                    throw error;
                }
            }

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

    return warnings;
}

async function installToolArchive(
    tool: DownloadableTool,
    destinationPath: string,
    reportProgress?: ToolDownloadProgressReporter
): Promise<{
    releaseTag: string;
    assetName: string;
    paths: InstalledToolPaths;
    status?: 'asset_not_found';
    releasePageUrl?: string;
    message?: string;
}> {
    const warnings: string[] = [];
    fs.mkdirSync(destinationPath, { recursive: true });

    let release: GitHubReleaseResponse;
    let asset: { name: string; downloadUrl: string } | null = null;

    reportProgress?.({
        stage: 'fetch_release',
        message: 'Checking latest release metadata...',
        progress: null,
    });

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
        reportProgress?.({
            stage: 'download_archive',
            message: `Downloading ${asset.name}...`,
            assetName: asset.name,
            progress: 0,
        });
        await downloadZipFile(asset.downloadUrl, zipPath, (payload) => {
            const normalizedProgress =
                typeof payload.totalBytes === 'number' && payload.totalBytes > 0
                    ? clampUnitProgress(payload.downloadedBytes / payload.totalBytes)
                    : null;

            reportProgress?.({
                stage: 'download_archive',
                message: `Downloading ${asset.name}...`,
                assetName: asset.name,
                progress: normalizedProgress,
                downloadedBytes: payload.downloadedBytes,
                totalBytes: payload.totalBytes,
            });
        });
        reportProgress?.({
            stage: 'extract_archive',
            message: `Extracting ${asset.name}...`,
            assetName: asset.name,
            progress: null,
        });
        await extract(zipPath, { dir: destinationPath });

        if (tool === 'agent' && AGENT_DATA_ARCHIVE_URL.trim()) {
            const dataArchivePath = path.join(tempDirectory, 'agent-data.zip');
            const dataDestinationPath = path.join(destinationPath, 'data');
            reportProgress?.({
                stage: 'download_data',
                message: 'Downloading Agent data bundle...',
                assetName: 'agent-data.zip',
                progress: 0,
            });
            await downloadZipFile(AGENT_DATA_ARCHIVE_URL.trim(), dataArchivePath, (payload) => {
                const normalizedProgress =
                    typeof payload.totalBytes === 'number' && payload.totalBytes > 0
                        ? clampUnitProgress(payload.downloadedBytes / payload.totalBytes)
                        : null;
                reportProgress?.({
                    stage: 'download_data',
                    message: 'Downloading Agent data bundle...',
                    assetName: 'agent-data.zip',
                    progress: normalizedProgress,
                    downloadedBytes: payload.downloadedBytes,
                    totalBytes: payload.totalBytes,
                });
            });
            reportProgress?.({
                stage: 'extract_archive',
                message: 'Extracting Agent data bundle...',
                assetName: 'agent-data.zip',
                progress: null,
            });
            await extract(dataArchivePath, { dir: dataDestinationPath });
        }

        if (tool === 'textractor') {
            reportProgress?.({
                stage: 'install_plugins',
                message: 'Installing Textractor websocket plugins...',
                progress: null,
            });
            const pluginWarnings = await installTextractorWebsocketPlugins(
                tempDirectory,
                destinationPath,
                reportProgress
            );
            warnings.push(...pluginWarnings);
        }
    } finally {
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failures.
        }
    }

    const paths: InstalledToolPaths = {};
    reportProgress?.({
        stage: 'finalize',
        message: 'Updating saved tool paths...',
        progress: null,
    });

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

    reportProgress?.({
        stage: 'finalize',
        message: 'Install complete.',
        progress: 1,
    });

    return {
        releaseTag: typeof release.tag_name === 'string' ? release.tag_name : 'latest',
        assetName: asset.name,
        paths,
        message: warnings.length > 0 ? warnings.join(' ') : undefined,
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
            launchOverlay: Boolean(profile.launchOverlay),
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

function getSettingsSnapshot() {
    return {
        autoUpdateGSMApp: getAutoUpdateGSMApp(),
        autoUpdateElectron: getAutoUpdateElectron(),
        pullPreReleases: getPullPreReleases(),
        startConsoleMinimized: getStartConsoleMinimized(),
        customPythonPackage: getCustomPythonPackage(),
        showYuzuTab: getShowYuzuTab(),
        windowTransparencyToolHotkey: getWindowTransparencyToolHotkey(),
        windowTransparencyTarget: store.get('windowTransparencyTarget') || '',
        runWindowTransparencyToolOnStartup: getRunWindowTransparencyToolOnStartup(),
        runOverlayOnStartup: getRunOverlayOnStartup(),
        visibleTabs: getVisibleTabs(),
        statsEndpoint: getStatsEndpoint(),
        iconStyle: store.get('iconStyle') || 'gsm',
        locale: getLocale(),
        consoleMode: getConsoleMode(),
        setupWizardVersion: getSetupWizardVersion(),
        uiMode: getUiMode(),
        hasCompletedSetup: getHasCompletedSetup(),
    };
}

function isCurrentAppVersionPreRelease(): boolean {
    const version = app.getVersion();
    if (semver.valid(version)) {
        return Array.isArray(semver.prerelease(version));
    }
    return version.includes('-');
}

function queueBackendUpdateForNextLaunch(): string {
    const updateFlagPath = path.join(BASE_DIR, 'update_python.flag');
    fs.writeFileSync(updateFlagPath, '');
    return updateFlagPath;
}

interface SettingsIPCDependencies {
    getUpdateStatus: () => Promise<unknown>;
    checkForUpdates: () => Promise<unknown>;
    updateNow: () => Promise<unknown>;
}

export function registerSettingsIPC(deps?: SettingsIPCDependencies) {
    ipcMain.handle('settings.getSettings', async () => {
        return getSettingsSnapshot();
    });

    ipcMain.handle('settings.getUpdateStatus', async () => {
        if (!deps) {
            return null;
        }
        return await deps.getUpdateStatus();
    });

    ipcMain.handle('settings.checkForUpdates', async () => {
        if (!deps) {
            return null;
        }
        return await deps.checkForUpdates();
    });

    ipcMain.handle('settings.updateNow', async () => {
        if (!deps) {
            return null;
        }
        return await deps.updateNow();
    });

    ipcMain.handle('settings.saveSettings', async (_, settings: any) => {
        const payload = settings && typeof settings === 'object' ? settings : {};

        if (typeof payload.autoUpdateGSMApp === 'boolean') {
            setAutoUpdateGSMApp(payload.autoUpdateGSMApp);
        }
        if (typeof payload.pullPreReleases === 'boolean') {
            const currentPullPreReleases = getPullPreReleases();
            const requestedPullPreReleases = payload.pullPreReleases;
            const isChanging = requestedPullPreReleases !== currentPullPreReleases;

            if (isChanging) {
                const currentAppIsPreRelease = isCurrentAppVersionPreRelease();
                const requiresCrossChannelUpdate =
                    (requestedPullPreReleases && !currentAppIsPreRelease) ||
                    (!requestedPullPreReleases && currentAppIsPreRelease);

                if (requiresCrossChannelUpdate) {
                    const response = await dialog.showMessageBox({
                        type: 'question',
                        buttons: ['Yes', 'No'],
                        defaultId: 0,
                        cancelId: 1,
                        title: requestedPullPreReleases
                            ? 'Switch to Beta Updates'
                            : 'Switch to Stable Updates',
                        message: requestedPullPreReleases
                            ? 'Enable beta updates and queue the update now?'
                            : 'Disable beta updates and queue the stable update now?',
                        detail: requestedPullPreReleases
                            ? 'A backend update will be queued for the next launch. Restart GSM to apply it.'
                            : 'A stable backend update will be queued for the next launch. Restart GSM to apply it.',
                    });

                    if (response.response === 0) {
                        setPullPreReleases(requestedPullPreReleases);
                        try {
                            const updateFlagPath = queueBackendUpdateForNextLaunch();
                            console.log(
                                `Queued backend update marker after beta toggle change: ${updateFlagPath}`
                            );
                            await dialog.showMessageBox({
                                type: 'info',
                                buttons: ['OK'],
                                title: 'Update Queued',
                                message: `${APP_NAME} queued an update for the next launch.`,
                                detail: 'Restart GSM to apply the queued update.',
                            });
                        } catch (error) {
                            console.error('Failed to queue backend update after beta toggle:', error);
                            await dialog.showMessageBox({
                                type: 'error',
                                buttons: ['OK'],
                                title: 'Queue Failed',
                                message: 'Failed to queue update marker.',
                                detail: 'Restart GSM and run an update manually from the tray menu.',
                            });
                        }
                    } else {
                        payload.pullPreReleases = currentPullPreReleases;
                    }
                } else {
                    setPullPreReleases(requestedPullPreReleases);
                }
            }
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
        if (typeof payload.locale === 'string') {
            setLocale(payload.locale || 'en');
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
        return { success: true, settings: getSettingsSnapshot() };
    });

    ipcMain.handle('settings.setAutoUpdateGSMApp', async (_, value: boolean) => {
        setAutoUpdateGSMApp(value);
    });

    ipcMain.handle('settings.setAutoUpdateElectron', async (_, value: boolean) => {
        setAutoUpdateElectron(value);
    });

    ipcMain.handle('settings.openGSMSettings', async (_, payload) => {
        const target =
            payload && typeof payload === 'object'
                ? payload as { rootTabKey?: unknown; subtabKey?: unknown }
                : {};

        sendOpenSettings({
            root_tab_key:
                typeof target.rootTabKey === 'string' ? target.rootTabKey : '',
            subtab_key:
                typeof target.subtabKey === 'string' ? target.subtabKey : '',
        });
    });

    ipcMain.handle('settings.openOverlaySettings', async () => {
        return {
            success: sendOpenOverlaySettings(),
        };
    });

    ipcMain.handle('settings.focusHub', async () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return { success: false };
        }

        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }

        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('app.navigateToTab', 'settings');
        return { success: true };
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
        const launchOverlay = typeof payload.launchOverlay === 'boolean'
            ? payload.launchOverlay
            : false;
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
            launchOverlay,
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

    ipcMain.handle('settings.downloadAndInstallTool', async (event, payload: any) => {
        const rawTool = typeof payload?.tool === 'string' ? payload.tool.toLowerCase().trim() : '';
        if (!isDownloadableTool(rawTool)) {
            return { status: 'invalid', message: 'Unsupported tool request.' };
        }

        const tool = rawTool;
        const reportProgress: ToolDownloadProgressReporter = (progress) => {
            emitToolDownloadProgress(event, { tool, ...progress });
        };

        reportProgress({
            stage: 'preparing',
            message: 'Preparing download...',
            progress: null,
        });

        const selectedDirectory = await selectDirectoryPath();
        if (!selectedDirectory) {
            return { status: 'canceled', message: 'No directory selected.' };
        }

        const destinationPath = normalizeInstallDestinationPath(tool, selectedDirectory);
        reportProgress({
            stage: 'preparing',
            message: `Installing to ${destinationPath}`,
            progress: null,
        });

        try {
            const installResult = await installToolArchive(tool, destinationPath, reportProgress);
            if (installResult.status === 'asset_not_found') {
                if (installResult.releasePageUrl) {
                    await shell.openExternal(installResult.releasePageUrl);
                }

                reportProgress({
                    stage: 'finalize',
                    message:
                        installResult.message ||
                        'No matching downloadable asset was found. Opened releases page.',
                    progress: null,
                });

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
            reportProgress({
                stage: 'finalize',
                message:
                    typeof error?.message === 'string'
                        ? error.message
                        : `Failed to download and install ${tool}.`,
                progress: null,
            });
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
    if (isPythonLaunchBlockedByUpdate()) {
        console.warn(
            '[Update Guard] Skipping window transparency tool start while updates are in progress.'
        );
        return;
    }

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
