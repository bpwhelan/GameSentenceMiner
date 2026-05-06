import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as tar from 'tar';
import extract from 'extract-zip';
import { spawn } from 'child_process';
import {
    BASE_DIR,
    execFileAsync,
    getPlatform,
    getSanitizedPythonEnv,
    isWindows,
    isMacOS,
} from '../util.js';
import { installSessionManager } from '../services/install_session_state.js';
import { mainWindow } from '../main.js';
import { dialog } from 'electron';
import type { InstallProgressKind, InstallStageId } from '../../shared/install_session.js';

// --- Constants ---

const PYTHON_VERSION = '3.13.2';
const UV_VERSION = '0.9.22';
const VENV_DIR = path.join(BASE_DIR, 'python_venv');
const UV_DIR = path.join(BASE_DIR, 'uv');
const VENV_CREATION_ATTEMPTS = 4;
const VENV_CREATION_RETRY_DELAY_MS = 1_500;
const RETRYABLE_VENV_CREATION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

let pythonOperationQueue: Promise<void> = Promise.resolve();
let activePythonOperationPromise: Promise<string> | null = null;

interface DownloadProgressPayload {
    downloadedBytes: number;
    totalBytes?: number;
}

interface TrackedCommandOptions {
    stageId: InstallStageId;
    command: string;
    args: string[];
    startMessage: string;
    successMessage: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    markFailureOnError?: boolean;
}

function shouldEmitDownloadProgress(
    downloadedBytes: number,
    totalBytes: number | undefined,
    lastReport: { bytes: number; timeMs: number }
): boolean {
    const now = Date.now();
    if (downloadedBytes <= 0) {
        return false;
    }
    if (totalBytes !== undefined && downloadedBytes >= totalBytes) {
        lastReport.bytes = downloadedBytes;
        lastReport.timeMs = now;
        return true;
    }

    const bytesDelta = downloadedBytes - lastReport.bytes;
    const timeDelta = now - lastReport.timeMs;
    const progressDelta =
        typeof totalBytes === 'number' && totalBytes > 0
            ? (downloadedBytes - lastReport.bytes) / totalBytes
            : 0;

    if (bytesDelta >= 512 * 1024 || progressDelta >= 0.01 || timeDelta >= 250) {
        lastReport.bytes = downloadedBytes;
        lastReport.timeMs = now;
        return true;
    }

    return false;
}

function hasActiveInstallSession(): boolean {
    return installSessionManager.getActiveSnapshot() !== null;
}

function reportStageProgress(
    stageId: InstallStageId,
    status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed',
    progressKind: InstallProgressKind,
    progress: number | null,
    message: string,
    extras?: {
        downloadedBytes?: number | null;
        totalBytes?: number | null;
        error?: string | null;
    }
): void {
    if (!hasActiveInstallSession()) {
        return;
    }
    installSessionManager.updateStage({
        stageId,
        status,
        progressKind,
        progress,
        message,
        downloadedBytes: extras?.downloadedBytes,
        totalBytes: extras?.totalBytes,
        error: extras?.error,
    });
}

function markBootstrapStagesSkipped(message: string): void {
    reportStageProgress('uv', 'skipped', 'indeterminate', 1, message);
    reportStageProgress('python', 'skipped', 'indeterminate', 1, 'Managed Python already installed.');
    reportStageProgress('venv', 'skipped', 'indeterminate', 1, 'Virtual environment already present.');
}

function estimateCommandProgressFromText(text: string, fallback: number): number {
    const normalized = text.trim();
    if (!normalized) {
        return fallback;
    }
    if (/resolved|audited/i.test(normalized)) {
        return Math.max(fallback, 0.25);
    }
    if (/prepared|extract/i.test(normalized)) {
        return Math.max(fallback, 0.6);
    }
    if (/installed|success|complete|created/i.test(normalized)) {
        return Math.max(fallback, 0.85);
    }
    return Math.max(fallback, 0.12);
}

async function runTrackedCommand({
    stageId,
    command,
    args,
    startMessage,
    successMessage,
    cwd,
    env,
    markFailureOnError = true,
}: TrackedCommandOptions): Promise<void> {
    reportStageProgress(stageId, 'running', 'estimated', 0.05, startMessage);

    await new Promise<void>((resolve, reject) => {
        let progress = 0.08;
        let latestMessage = startMessage;
        let settled = false;

        const finish = (error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearInterval(progressTimer);
            if (error) {
                if (markFailureOnError) {
                    reportStageProgress(stageId, 'failed', 'estimated', progress, latestMessage, {
                        error: error.message,
                    });
                }
                reject(error);
                return;
            }
            reportStageProgress(stageId, 'completed', 'estimated', 1, successMessage);
            resolve();
        };

        const progressTimer = setInterval(() => {
            progress = Math.min(progress + 0.03, 0.92);
            reportStageProgress(stageId, 'running', 'estimated', progress, latestMessage);
        }, 800);

        const proc = spawn(command, args, {
            cwd,
            env: {
                ...getSanitizedPythonEnv(),
                ...(env ?? {}),
            },
            windowsHide: true,
        });

        const handleOutput = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
            const text = chunk.toString().trim();
            if (!text) {
                return;
            }
            latestMessage = text.split(/\r?\n/).slice(-1)[0] || latestMessage;
            progress = estimateCommandProgressFromText(latestMessage, progress);
            reportStageProgress(stageId, 'running', 'estimated', progress, latestMessage);
            if (stream === 'stderr') {
                console.error(text);
            } else {
                console.log(text);
            }
        };

        proc.stdout.on('data', (chunk) => handleOutput(chunk, 'stdout'));
        proc.stderr.on('data', (chunk) => handleOutput(chunk, 'stderr'));
        proc.on('close', (code) => {
            if (code === 0) {
                finish();
                return;
            }
            finish(new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}`));
        });
        proc.on('error', (error) => {
            finish(new Error(`Failed to start command "${command} ${args.join(' ')}": ${toErrorMessage(error)}`));
        });
    });
}

// --- Path Helpers ---

/**
 * Gets the path to the uv executable.
 */
function getUvExecutablePath(): string {
    return isWindows() 
        ? path.join(UV_DIR, 'uv.exe')
        : path.join(UV_DIR, 'uv');
}

/**
 * Gets the expected full path to the Python executable in the venv.
 */
function getPythonExecutablePath(): string {
    return isWindows()
        ? path.join(VENV_DIR, 'Scripts', 'python.exe')
        : path.join(VENV_DIR, 'bin', 'python');
}

/**
 * Checks if the Python executable is present at its expected location.
 */
function isPythonInstalled(): boolean {
    return fs.existsSync(getPythonExecutablePath());
}

/**
 * Checks if uv is installed.
 */
function isUvInstalled(): boolean {
    return fs.existsSync(getUvExecutablePath());
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDirectoryRemovalError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const code =
        typeof (error as { code?: unknown }).code === 'string'
            ? ((error as { code: string }).code || '').toUpperCase()
            : '';
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
}

async function removeDirectoryWithRetry(
    targetPath: string,
    label: string,
    attempts: number = 12,
    retryDelayMs: number = 250
): Promise<void> {
    if (!fs.existsSync(targetPath)) {
        return;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            fs.rmSync(targetPath, { recursive: true, force: true });
            return;
        } catch (error) {
            lastError = error;
            if (!isRetryableDirectoryRemovalError(error) || attempt === attempts - 1) {
                throw error;
            }

            console.warn(
                `Failed to remove ${label} at ${targetPath} (attempt ${attempt + 1}/${attempts}). Retrying...`
            );
            await sleep(retryDelayMs);
        }
    }

    if (lastError) {
        throw lastError;
    }
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function isRetryableVenvCreationError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const code =
        typeof (error as { code?: unknown }).code === 'string'
            ? ((error as { code: string }).code || '').toUpperCase()
            : '';
    if (RETRYABLE_VENV_CREATION_CODES.has(code)) {
        return true;
    }

    const message = toErrorMessage(error).toLowerCase();
    return (
        message.includes('os error 32') ||
        message.includes('used by another process') ||
        message.includes('cannot access the file because it is being used by another process') ||
        message.includes('venvlauncher.exe') ||
        message.includes('scripts\\python.exe') ||
        message.includes('scripts/python.exe')
    );
}

function schedulePythonOperation(operation: () => Promise<string>): Promise<string> {
    const scheduledOperation = pythonOperationQueue
        .catch(() => undefined)
        .then(operation);

    activePythonOperationPromise = scheduledOperation;
    pythonOperationQueue = scheduledOperation.then(
        () => undefined,
        () => undefined
    );
    scheduledOperation.finally(() => {
        if (activePythonOperationPromise === scheduledOperation) {
            activePythonOperationPromise = null;
        }
    });
    return scheduledOperation;
}

/**
 * Checks whether the managed uv executable can actually be launched.
 */
async function isUvExecutableUsable(): Promise<boolean> {
    const uvPath = getUvExecutablePath();
    if (!fs.existsSync(uvPath)) {
        return false;
    }

    try {
        await execFileAsync(uvPath, ['--version'], { windowsHide: true });
        return true;
    } catch (error: any) {
        console.warn(`Managed uv executable is present but unusable: ${error.message || error}`);
        return false;
    }
}

/**
 * Removes the managed uv installation so it can be rebuilt cleanly.
 */
async function clearUvInstallation(): Promise<void> {
    if (!fs.existsSync(UV_DIR)) {
        return;
    }

    console.warn(`Removing managed uv installation at: ${UV_DIR}`);
    await removeDirectoryWithRetry(UV_DIR, 'managed uv installation');
}

// --- Core Installation Steps ---

/**
 * Downloads a file from a URL to a specified directory.
 * @param url The URL of the file to download.
 * @param directory The destination directory.
 * @param fileName The name to save the file as.
 * @returns The full path to the downloaded file.
 */
async function downloadFile(
    url: string,
    directory: string,
    fileName: string,
    onProgress?: (payload: DownloadProgressPayload) => void
): Promise<string> {
    console.log(`Downloading from ${url}...`);

    fs.mkdirSync(directory, { recursive: true });
    
    const finalFilePath = path.join(directory, fileName);
    const tempFilePath = `${finalFilePath}.download`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const totalBytesHeader = response.headers.get('content-length');
        const totalBytes = totalBytesHeader ? Number.parseInt(totalBytesHeader, 10) : undefined;
        let buffer: Buffer;
        const lastReport = { bytes: 0, timeMs: 0 };

        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let downloadedBytes = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                const chunk = Buffer.from(value);
                chunks.push(chunk);
                downloadedBytes += chunk.length;
                if (onProgress && shouldEmitDownloadProgress(downloadedBytes, totalBytes, lastReport)) {
                    onProgress({ downloadedBytes, totalBytes });
                }
            }

            if (onProgress && downloadedBytes > 0 && lastReport.bytes !== downloadedBytes) {
                onProgress({ downloadedBytes, totalBytes });
            }

            buffer = Buffer.concat(chunks);
        } else {
            buffer = Buffer.from(await response.arrayBuffer());
            onProgress?.({ downloadedBytes: buffer.length, totalBytes });
        }

        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }

        fs.writeFileSync(tempFilePath, buffer);

        if (fs.existsSync(finalFilePath)) {
            fs.unlinkSync(finalFilePath);
        }

        fs.renameSync(tempFilePath, finalFilePath);
        console.log(`Download complete: ${finalFilePath}`);
        return finalFilePath;
    } catch (error: any) {
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch {
            // Best-effort cleanup only.
        }

        console.error(`Failed to download file from ${url}: ${error.message || error}`);
        throw error;
    }
}

/**
 * Extracts a .tar.gz or .zip archive to a specified path.
 * @param archivePath The full path to the archive file.
 * @param extractPath The directory to extract the contents into.
 */
async function extractArchive(archivePath: string, extractPath: string): Promise<void> {
    console.log(`Extracting ${archivePath} to ${extractPath}...`);

    fs.mkdirSync(extractPath, { recursive: true });

    try {
        if (archivePath.endsWith('.zip')) {
            // Extract zip file using extract-zip (works reliably on all platforms)
            await extract(archivePath, { dir: path.resolve(extractPath) });
        } else {
            // Extract tar.gz file
            await tar.x({
                file: archivePath,
                cwd: extractPath,
            });
        }
        console.log('Extraction complete.');
    } catch (error: any) {
        console.error(`Extraction failed: ${error.message || error}`);
        throw error;
    }
}

/**
 * Downloads and installs uv if not already present.
 */
async function ensureUvInstalled(): Promise<void> {
    if (await isUvExecutableUsable()) {
        console.log(`uv is already installed at: ${getUvExecutablePath()}`);
        reportStageProgress('uv', 'skipped', 'indeterminate', 1, 'Managed uv runtime already installed.');
        return;
    }

    if (isUvInstalled() || fs.existsSync(UV_DIR)) {
        console.warn('Cached uv installation is missing or invalid. Reinstalling.');
        reportStageProgress('uv', 'running', 'indeterminate', 0.05, 'Cleaning up broken uv installation...');
        await clearUvInstallation();
    }

    console.log('Downloading uv...');
    reportStageProgress('uv', 'running', 'bytes', 0, 'Downloading uv runtime...');
    
    const platform = getPlatform();
    const arch = os.arch();
    let uvUrl: string;
    let fileName: string;
    let extractedDirName: string;
    
    // Determine the correct uv download URL based on platform and architecture
    if (isWindows()) {
        if (arch === 'arm64') {
            uvUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-pc-windows-msvc.zip`;
            extractedDirName = 'uv-aarch64-pc-windows-msvc';
        } else {
            uvUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;
            extractedDirName = 'uv-x86_64-pc-windows-msvc';
        }
        fileName = 'uv.zip';
    } else if (platform === 'darwin') {
        // Detect ARM vs Intel Mac
        if (arch === 'arm64') {
            uvUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`;
            extractedDirName = 'uv-aarch64-apple-darwin';
        } else {
            uvUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-apple-darwin.tar.gz`;
            extractedDirName = 'uv-x86_64-apple-darwin';
        }
        fileName = 'uv.tar.gz';
    } else {
        // Linux
        if (arch === 'arm64') {
            uvUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz`;
            extractedDirName = 'uv-aarch64-unknown-linux-gnu';
        } else {
            uvUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`;
            extractedDirName = 'uv-x86_64-unknown-linux-gnu';
        }
        fileName = 'uv.tar.gz';
    }

    const downloadsDir = path.join(BASE_DIR, 'downloads');
    let archivePath: string | undefined;

    try {
        archivePath = await downloadFile(uvUrl, downloadsDir, fileName, ({ downloadedBytes, totalBytes }) => {
            const ratio =
                typeof totalBytes === 'number' && totalBytes > 0
                    ? downloadedBytes / totalBytes
                    : null;
            reportStageProgress('uv', 'running', 'bytes', ratio, 'Downloading uv runtime...', {
                downloadedBytes,
                totalBytes: totalBytes ?? null,
            });
        });
        reportStageProgress('uv', 'running', 'estimated', 0.92, 'Extracting uv runtime...');
        await extractArchive(archivePath, UV_DIR);
        
        // The extracted archive contains a directory with uv binary, need to move it up
        const extractedDir = path.join(UV_DIR, extractedDirName);
        if (fs.existsSync(extractedDir)) {
            const uvBinary = isWindows() ? 'uv.exe' : 'uv';
            const sourcePath = path.join(extractedDir, uvBinary);
            const destPath = getUvExecutablePath();
            
            if (fs.existsSync(sourcePath)) {
                fs.renameSync(sourcePath, destPath);
                fs.rmSync(extractedDir, { recursive: true, force: true });
            }
        }
        
        // Make executable on Unix-like systems
        if (!isWindows()) {
            fs.chmodSync(getUvExecutablePath(), 0o755);
        }

        if (!(await isUvExecutableUsable())) {
            throw new Error(`uv installation failed verification at: ${getUvExecutablePath()}`);
        }
        
        console.log(`uv installed successfully at: ${getUvExecutablePath()}`);
        reportStageProgress('uv', 'completed', 'estimated', 1, 'Managed uv runtime installed.');
    } catch (error: any) {
        console.error(`Failed to install uv: ${error.message || error}`);
        reportStageProgress('uv', 'failed', 'estimated', 0.95, 'Failed to install managed uv runtime.', {
            error: error.message || String(error),
        });
        throw error;
    } finally {
        if (archivePath && fs.existsSync(archivePath)) {
            console.log(`Cleaning up downloaded archive: ${archivePath}`);
            fs.unlinkSync(archivePath);
        }
    }
}

// --- Homebrew Installation (macOS only) ---

/**
 * Checks if Homebrew is installed on macOS.
 */
async function isHomebrewInstalled(): Promise<boolean> {
    if (!isMacOS()) return false;
    
    try {
        await execFileAsync('which', ['brew']);
        return true;
    } catch {
        return false;
    }
}

async function showHomebrewRequiredDialog(): Promise<void> {
    const response = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Homebrew Required',
        message: 'Homebrew is required to install Python on macOS.',
        detail: 'Please install Homebrew from https://brew.sh/ and restart the application.',
        buttons: ['OK'],
    });
}

/**
 * Installs Homebrew on macOS with user confirmation.
 */
async function installHomebrew(): Promise<void> {
    if (!isMacOS()) {
        throw new Error('Homebrew installation is only supported on macOS');
    }

    const response = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        title: 'Install Homebrew',
        message: 'Homebrew is required to install Python on macOS. Would you like to install it now?',
        detail: 'This will run the official Homebrew installation script.',
    });

    if (response.response !== 0) {
        throw new Error('User declined Homebrew installation');
    }

    console.log('Installing Homebrew...');
    mainWindow?.webContents.send('notification', {
        title: 'Installing Homebrew',
        message: 'Installing Homebrew package manager. This may take a few minutes and may require your password...',
    });

    try {
        // Run the official Homebrew installation script
        // The script will handle prompting for password if needed
        const installScript = '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
        
        // Use spawn instead of execFile for interactive scripts
        await new Promise<void>((resolve, reject) => {
            const brewInstall = spawn(installScript, {
                stdio: 'inherit', // This allows the script to interact with the terminal
            });
            
            brewInstall.on('close', (code: number) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Homebrew installation exited with code ${code}`));
                }
            });
            
            brewInstall.on('error', (err: Error) => {
                reject(err);
            });
        });
        
        console.log('Homebrew installed successfully');
    } catch (error: any) {
        console.error(`Failed to install Homebrew: ${error.message || error}`);
        throw new Error(`Homebrew installation failed: ${error.message || error}`);
    }
}

/**
 * Ensures Homebrew is installed on macOS.
 */
async function ensureHomebrewInstalled(): Promise<boolean> {
    if (!isMacOS()) return false;

    if (await isHomebrewInstalled()) {
        console.log('Homebrew is already installed');
        return true;
    }

    await showHomebrewRequiredDialog();
    return false;
}

/**
 * Installs Python 3.13 using Homebrew on macOS.
 */
async function installPythonWithHomebrew(): Promise<void> {
    console.log('Installing Python 3.13 with Homebrew...');
    
    try {
        // Install Python 3.13
        await execFileAsync('brew', ['install', 'python@3.13']);
        console.log('Python 3.13 installed successfully via Homebrew');
    } catch (error: any) {
        console.error(`Failed to install Python with Homebrew: ${error.message || error}`);
        throw error;
    }
}

/**
 * Creates a virtual environment using the Homebrew-installed Python.
 */
async function createVenvWithHomebrewPython(): Promise<void> {
    console.log(`Creating virtual environment at ${VENV_DIR}...`);
    
    try {
        fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
        
        // Use the Homebrew Python 3.13 to create venv
        const homebrewPython = '/opt/homebrew/bin/python3.13'; // ARM Mac
        const homebrewPythonIntel = '/usr/local/bin/python3.13'; // Intel Mac
        
        // Try ARM path first, fall back to Intel
        let pythonBin = homebrewPython;
        if (!fs.existsSync(homebrewPython)) {
            if (fs.existsSync(homebrewPythonIntel)) {
                pythonBin = homebrewPythonIntel;
            } else {
                throw new Error('Could not find Homebrew Python 3.13 installation');
            }
        }
        
        await execFileAsync(pythonBin, ['-m', 'venv', VENV_DIR]);
        console.log(`Virtual environment created successfully at ${VENV_DIR}`);
        
        // Ensure pip is installed in the venv
        console.log('Ensuring pip is installed in the virtual environment...');
        const venvPython = getPythonExecutablePath();
        await execFileAsync(venvPython, ['-m', 'ensurepip', '--upgrade']);
        console.log('pip ensured successfully');
    } catch (error: any) {
        console.error(`Failed to create virtual environment: ${error.message || error}`);
        throw error;
    }
}

/**
 * Verifies the venv Python executable works.
 */
async function verifyVenvPython(): Promise<boolean> {
    const venvPython = getPythonExecutablePath();
    
    if (!fs.existsSync(venvPython)) {
        console.error(`Venv Python not found at: ${venvPython}`);
        return false;
    }
    
    try {
        // Test that Python runs
        await execFileAsync(venvPython, ['--version']);
        console.log(`Venv Python verified at: ${venvPython}`);
        return true;
    } catch (error: any) {
        console.error(`Venv Python exists but doesn't work: ${error.message || error}`);
        return false;
    }
}

async function resetManagedVenv(reason: string): Promise<void> {
    if (!fs.existsSync(VENV_DIR)) {
        return;
    }

    console.warn(`${reason} Removing managed virtual environment at: ${VENV_DIR}`);
    await removeDirectoryWithRetry(VENV_DIR, 'Python venv');
}

async function createManagedVenvWithRetry(uvPath: string): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= VENV_CREATION_ATTEMPTS; attempt += 1) {
        if (fs.existsSync(VENV_DIR)) {
            const existingVenvWorks = await verifyVenvPython();
            if (existingVenvWorks) {
                console.log(`Virtual environment already usable at: ${VENV_DIR}`);
                return;
            }

            await resetManagedVenv(
                `Detected partial or unusable virtual environment before attempt ${attempt}/${VENV_CREATION_ATTEMPTS}.`
            );
        }

        try {
            fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
            await runTrackedCommand({
                stageId: 'venv',
                command: uvPath,
                args: ['venv', '--python', PYTHON_VERSION, '--seed', VENV_DIR],
                startMessage: `Creating virtual environment (attempt ${attempt}/${VENV_CREATION_ATTEMPTS})...`,
                successMessage: 'Virtual environment created successfully.',
                markFailureOnError: false,
            });

            const venvWorks = await verifyVenvPython();
            if (!venvWorks) {
                throw new Error(
                    `Virtual environment creation completed but Python verification failed at ${getPythonExecutablePath()}`
                );
            }

            console.log(`Virtual environment created successfully at ${VENV_DIR}`);
            return;
        } catch (error) {
            lastError = error;
            const retryable = isRetryableVenvCreationError(error);
            console.error(
                `Failed to create virtual environment using uv (attempt ${attempt}/${VENV_CREATION_ATTEMPTS}): ${toErrorMessage(
                    error
                )}`
            );

            if (!retryable || attempt === VENV_CREATION_ATTEMPTS) {
                reportStageProgress('venv', 'failed', 'estimated', null, 'Failed to create virtual environment.', {
                    error: toErrorMessage(error),
                });
                throw error;
            }

            console.warn(
                `Virtual environment creation hit a transient file lock. Retrying in ${VENV_CREATION_RETRY_DELAY_MS}ms...`
            );
            reportStageProgress(
                'venv',
                'running',
                'estimated',
                0.35,
                `Virtual environment creation hit a transient file lock. Retrying (${attempt}/${VENV_CREATION_ATTEMPTS})...`
            );
            await sleep(VENV_CREATION_RETRY_DELAY_MS);
            await resetManagedVenv('Cleaning up after failed virtual environment creation attempt.');
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error('Virtual environment creation failed for an unknown reason.');
}

/**
 * Uninstalls Python 3.13 globally from Homebrew after venv setup.
 * Only uninstalls if the venv Python is verified to work independently.
 */
async function uninstallHomebrewPythonGlobally(): Promise<void> {
    console.log('Verifying venv before uninstalling global Python...');
    
    // First verify the venv works
    const venvWorks = await verifyVenvPython();
    if (!venvWorks) {
        console.warn('Venv Python is not working, skipping global Python uninstall to avoid breaking the venv');
        return;
    }
    
    console.log('Venv verified, uninstalling global Python 3.13 from Homebrew...');
    
    try {
        await execFileAsync('brew', ['uninstall', 'python@3.13']);
        console.log('Python 3.13 uninstalled globally from Homebrew');
        
        // Verify venv still works after uninstall
        const stillWorks = await verifyVenvPython();
        if (!stillWorks) {
            console.error('WARNING: Venv stopped working after uninstalling global Python!');
            console.error('Attempting to reinstall Python...');
            await execFileAsync('brew', ['install', 'python@3.13']);
        }
    } catch (error: any) {
        // Don't throw on uninstall errors, just log them
        console.warn(`Failed to uninstall Python globally (this is non-critical): ${error.message || error}`);
    }
}

/**
 * Performs the installation of Python using Homebrew (macOS only).
 */
async function _performHomebrewInstallation(): Promise<void> {
    // Ensure Homebrew is installed
    await ensureHomebrewInstalled();

    // Install Python 3.13 using Homebrew
    await installPythonWithHomebrew();

    // Create virtual environment
    await createVenvWithHomebrewPython();

    // Verify venv works
    console.log('Verifying virtual environment installation...');
    const venvPath = getPythonExecutablePath();
    if (!fs.existsSync(venvPath)) {
        throw new Error(`Virtual environment Python not found at expected path: ${venvPath}`);
    }
    console.log(`Virtual environment Python found at: ${venvPath}`);
    
    // Note: We intentionally do NOT uninstall the global Python 3.13 installation.
    // This prevents breaking the venv (which may use symlinks) and avoids interfering
    // with any existing Python installations the user may have. The venv is isolated
    // and will use its own Python regardless of what's installed globally.
    console.log('Python 3.13 installation complete. Global installation left intact to avoid conflicts.');
}

async function performManagedPythonInstall(): Promise<string> {
    if (isPythonInstalled()) {
        const pythonPath = getPythonExecutablePath();
        console.log(`Python is already installed at: ${pythonPath}`);
        markBootstrapStagesSkipped('Managed uv runtime already available.');
        return pythonPath;
    }

    console.log('Python not found. Starting installation process...');

    if (isMacOS()) {
        await _performHomebrewInstallation();
    } else {
        await _performInstallation();
    }

    const pythonExecutablePath = getPythonExecutablePath();
    if (!fs.existsSync(pythonExecutablePath)) {
        const errorMessage = 'Python installation failed: executable not found after setup.';
        console.error(errorMessage);
        reportStageProgress('python', 'failed', 'estimated', null, 'Managed Python installation failed.', {
            error: errorMessage,
        });
        throw new Error(errorMessage);
    }

    console.log(`Python successfully installed at: ${pythonExecutablePath}`);
    return pythonExecutablePath;
}

/**
 * Performs the actual installation of Python using uv.
 */
async function _performInstallation(): Promise<void> {
    // Ensure uv is installed first
    await ensureUvInstalled();

    const uvPath = getUvExecutablePath();

    // Install pinned Python using uv
    console.log(`Installing Python ${PYTHON_VERSION} using uv...`);
    try {
        await runTrackedCommand({
            stageId: 'python',
            command: uvPath,
            args: ['python', 'install', PYTHON_VERSION],
            startMessage: `Installing Python ${PYTHON_VERSION} using uv...`,
            successMessage: `Python ${PYTHON_VERSION} installed successfully.`,
        });
        console.log(`Python ${PYTHON_VERSION} installed successfully.`);
    } catch (error: any) {
        console.error(`Failed to install Python using uv: ${error.message || error}`);
        reportStageProgress('python', 'failed', 'estimated', null, `Failed to install Python ${PYTHON_VERSION}.`, {
            error: error.message || String(error),
        });
        throw error;
    }

    // Create virtual environment using uv
    console.log(`Creating virtual environment at ${VENV_DIR}...`);
    try {
        await createManagedVenvWithRetry(uvPath);
    } catch (error: any) {
        console.error(`Failed to create virtual environment using uv: ${error.message || error}`);
        throw error;
    }

    // Ensure pip is installed in the venv
    console.log('Ensuring pip is installed in the virtual environment...');
    try {
        const venvPython = getPythonExecutablePath();
        await runTrackedCommand({
            stageId: 'verify_runtime',
            command: venvPython,
            args: ['-m', 'ensurepip', '--upgrade'],
            startMessage: 'Ensuring pip is installed in the virtual environment...',
            successMessage: 'Managed Python runtime verified.',
        });
        console.log('pip ensured successfully');
    } catch (error: any) {
        console.error(`Failed to ensure pip: ${error.message || error}`);
        reportStageProgress('verify_runtime', 'failed', 'estimated', null, 'Failed to verify managed Python runtime.', {
            error: error.message || String(error),
        });
        throw error;
    }
}

// --- Public API ---

/**
 * Checks for Python and installs it if missing, then returns the path to the executable.
 * This is the primary function to be called from other parts of the application.
 * @returns A promise that resolves to the path of the Python executable.
 */
export async function getOrInstallPython(): Promise<string> {
    if (activePythonOperationPromise) {
        return await activePythonOperationPromise;
    }

    if (isPythonInstalled()) {
        const pythonPath = getPythonExecutablePath();
        console.log(`Python is already installed at: ${pythonPath}`);
        markBootstrapStagesSkipped('Managed uv runtime already available.');
        return pythonPath;
    }

    return await schedulePythonOperation(async () => await performManagedPythonInstall());
}

/**
 * Removes the existing Python installation and reinstalls it.
 */
export async function reinstallPython(): Promise<void> {
    await schedulePythonOperation(async () => {
        console.log('Starting Python reinstallation...');
        await resetManagedVenv('Removing existing Python venv before reinstallation.');
        console.log('Existing installation removed. Proceeding with fresh installation...');
        return await performManagedPythonInstall();
    });
    console.log('Python reinstallation complete.');
}
