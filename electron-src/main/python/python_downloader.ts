import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Downloader } from 'nodejs-file-downloader';
import * as tar from 'tar';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BASE_DIR, execFileAsync, getPlatform, isWindows } from '../util.js';
import { mainWindow } from '../main.js';
import { dialog } from 'electron';

// --- Constants ---

const PYTHON_VERSION = '3.11';
const VENV_DIR = path.join(BASE_DIR, 'python_venv');
const UV_DIR = path.join(BASE_DIR, 'uv');

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

// --- Core Installation Steps ---

/**
 * Downloads a file from a URL to a specified directory.
 * @param url The URL of the file to download.
 * @param directory The destination directory.
 * @param fileName The name to save the file as.
 * @returns The full path to the downloaded file.
 */
async function downloadFile(url: string, directory: string, fileName: string): Promise<string> {
    console.log(`Downloading from ${url}...`);

    fs.mkdirSync(directory, { recursive: true });

    const downloader = new Downloader({
        url,
        directory,
        fileName,
        cloneFiles: false,
    });
    
    const finalFilePath = path.join(directory, fileName);

    try {
        const { filePath, downloadStatus } = await downloader.download();
        if (downloadStatus !== 'COMPLETE' || !filePath) {
            throw new Error(`Download status was ${downloadStatus}.`);
        }
        console.log(`Download complete: ${filePath}`);
        return filePath;
    } catch (error: any) {
        if (error.code === 'ENOENT' && fs.existsSync(finalFilePath)) {
            console.warn(
                `Download appears successful, but a non-critical cleanup error occurred. Ignoring. Details: ${error.message}`
            );
            return finalFilePath;
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
            // Extract zip file using PowerShell on Windows
            if (isWindows()) {
                const execFilePromise = promisify(execFile);
                await execFilePromise('powershell.exe', [
                    '-NoProfile',
                    '-Command',
                    `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractPath}" -Force`
                ]);
            } else {
                // Use unzip on Unix-like systems
                const execFilePromise = promisify(execFile);
                await execFilePromise('unzip', ['-o', archivePath, '-d', extractPath]);
            }
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
    if (isUvInstalled()) {
        console.log(`uv is already installed at: ${getUvExecutablePath()}`);
        return;
    }

    console.log('Downloading uv...');
    
    const platform = getPlatform();
    const arch = os.arch();
    let uvUrl: string;
    let fileName: string;
    let extractedDirName: string;
    
    // Determine the correct uv download URL based on platform and architecture
    if (isWindows()) {
        if (arch === 'arm64') {
            uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-pc-windows-msvc.zip';
            extractedDirName = 'uv-aarch64-pc-windows-msvc';
        } else {
            uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
            extractedDirName = 'uv-x86_64-pc-windows-msvc';
        }
        fileName = 'uv.zip';
    } else if (platform === 'darwin') {
        // Detect ARM vs Intel Mac
        if (arch === 'arm64') {
            uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz';
            extractedDirName = 'uv-aarch64-apple-darwin';
        } else {
            uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz';
            extractedDirName = 'uv-x86_64-apple-darwin';
        }
        fileName = 'uv.tar.gz';
    } else {
        // Linux
        if (arch === 'arm64') {
            uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz';
            extractedDirName = 'uv-aarch64-unknown-linux-gnu';
        } else {
            uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz';
            extractedDirName = 'uv-x86_64-unknown-linux-gnu';
        }
        fileName = 'uv.tar.gz';
    }

    const downloadsDir = path.join(BASE_DIR, 'downloads');
    let archivePath: string | undefined;

    try {
        archivePath = await downloadFile(uvUrl, downloadsDir, fileName);
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
        
        console.log(`uv installed successfully at: ${getUvExecutablePath()}`);
    } catch (error: any) {
        console.error(`Failed to install uv: ${error.message || error}`);
        throw error;
    } finally {
        if (archivePath && fs.existsSync(archivePath)) {
            console.log(`Cleaning up downloaded archive: ${archivePath}`);
            fs.unlinkSync(archivePath);
        }
    }
}

/**
 * Performs the actual installation of Python using uv.
 */
async function _performInstallation(): Promise<void> {
    // Ensure uv is installed first
    await ensureUvInstalled();

    const uvPath = getUvExecutablePath();

    // Install Python 3.11 using uv
    console.log(`Installing Python ${PYTHON_VERSION} using uv...`);
    try {
        await execFileAsync(uvPath, ['python', 'install', PYTHON_VERSION]);
        console.log(`Python ${PYTHON_VERSION} installed successfully.`);
    } catch (error: any) {
        console.error(`Failed to install Python using uv: ${error.message || error}`);
        throw error;
    }

    // Create virtual environment using uv
    console.log(`Creating virtual environment at ${VENV_DIR}...`);
    try {
        fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
        await execFileAsync(uvPath, ['venv', '--python', PYTHON_VERSION, '--seed', VENV_DIR]);
        console.log(`Virtual environment created successfully at ${VENV_DIR}`);
    } catch (error: any) {
        console.error(`Failed to create virtual environment using uv: ${error.message || error}`);
        throw error;
    }

    // Should be unnecessary now that we use uv to create the venv
    // 
    // Install uv into the venv so it's available for package management
    console.log('Installing uv into virtual environment...');
    try {
        const pythonPath = getPythonExecutablePath();
        await execFileAsync(pythonPath, ['-m', 'pip', 'install', 'uv']);
        console.log('uv installed into virtual environment successfully.');
    } catch (error: any) {
        console.error(`Failed to install uv into venv: ${error.message || error}`);
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
    if (isPythonInstalled()) {
        const pythonPath = getPythonExecutablePath();
        console.log(`Python is already installed at: ${pythonPath}`);
        return pythonPath;
    }

    // Show notification about installation starting
    dialog.showMessageBox(mainWindow!, {
        type: 'info',
        title: 'First Time Setup',
        message: 'GSM Running First Time Setup. There are a lot of moving parts, so it may take a few minutes. Please be patient!',
    });

    console.log('Python not found. Starting installation process...');
    mainWindow?.webContents.send('notification', {
        title: 'Python Setup',
        message: 'Installing Python using uv. This may take a moment...',
    });

    await _performInstallation();

    const pythonExecutablePath = getPythonExecutablePath();
    if (!fs.existsSync(pythonExecutablePath)) {
        const errorMessage = 'Python installation failed: executable not found after setup.';
        console.error(errorMessage);
        mainWindow?.webContents.send('notification', {
            title: 'Installation Failed',
            message: errorMessage,
        });
        throw new Error(errorMessage);
    }

    console.log(`Python successfully installed at: ${pythonExecutablePath}`);
    return pythonExecutablePath;
}

/**
 * Removes the existing Python installation and reinstalls it.
 */
export async function reinstallPython(): Promise<void> {
    console.log('Starting Python reinstallation...');

    // Remove existing venv
    if (fs.existsSync(VENV_DIR)) {
        console.log(`Removing existing Python venv at: ${VENV_DIR}`);
        fs.rmSync(VENV_DIR, { recursive: true, force: true });
    }

    console.log('Existing installation removed. Proceeding with fresh installation...');
    await getOrInstallPython();
    console.log('Python reinstallation complete.');
}
