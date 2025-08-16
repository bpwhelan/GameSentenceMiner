import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Downloader } from 'nodejs-file-downloader';
import * as tar from 'tar';
import { BASE_DIR, execFileAsync, getPlatform, isArmMac, SupportedPlatform } from '../util.js';
import { mainWindow } from '../main.js';

// --- Interfaces and Constants ---

interface PythonDownload {
    url: string;
    version: string;
    path: string; // Relative path to the executable within the extracted archive
}

const downloads: Record<SupportedPlatform, PythonDownload> = {
    linux: {
        url: 'https://github.com/astral-sh//python-build-standalone/releases/download/20250529/cpython-3.11.12+20250529-x86_64-unknown-linux-gnu-install_only.tar.gz',
        version: '3.11.12',
        path: 'python/bin/python3.11', // This path is not used for Linux, which uses a venv
    },
    darwin: {
        url: isArmMac
            ? 'https://github.com/astral-sh//python-build-standalone/releases/download/20250529/cpython-3.11.12+20250529-aarch64-apple-darwin-install_only.tar.gz'
            : 'https://github.com/astral-sh//python-build-standalone/releases/download/20250529/cpython-3.11.12+20250529-x86_64-apple-darwin-install_only.tar.gz',
        version: '3.11.12',
        path: 'python/bin/python3.11',
    },
    win32: {
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20250529/cpython-3.11.12+20250529-x86_64-pc-windows-msvc-install_only.tar.gz',
        version: '3.11.12',
        path: 'python/python.exe',
    },
};

// --- Path Helpers ---

const PYTHON_DIR = path.join(BASE_DIR, 'python');
const DOWNLOADS_DIR = path.join(BASE_DIR, 'downloads');

/**
 * Gets the path for the Python virtual environment (Linux only).
 */
function getVenvPath(): string {
    return path.join(os.homedir(), '.config', 'GameSentenceMiner', 'python_venv');
}

/**
 * Gets the expected full path to the Python executable, depending on the platform.
 * This does not check if the file actually exists.
 */
function getPythonExecutablePath(): string {
    const platform = getPlatform();
    if (platform === 'linux') {
        return path.join(getVenvPath(), 'bin', 'python');
    }
    return path.join(BASE_DIR, downloads[platform].path);
}

/**
 * Checks if the Python executable is present at its expected location.
 */
function isPythonInstalled(): boolean {
    return fs.existsSync(getPythonExecutablePath());
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
        // ** THE FIX IS HERE **
        // WORKAROUND: The library sometimes throws an ENOENT error when trying to delete
        // its temporary '.download' file after a successful rename.
        // If the final file exists, we can safely ignore this specific error.
        if (error.code === 'ENOENT' && fs.existsSync(finalFilePath)) {
            console.warn(
                `Download appears successful, but a non-critical cleanup error occurred. Ignoring. Details: ${error.message}`
            );
            return finalFilePath;
        }

        // Otherwise, it's a real error.
        console.error(`Failed to download file from ${url}:`, error);
        throw error; // Re-throw to be caught by the calling function
    }
}

/**
 * Extracts a .tar.gz archive to a specified path.
 * @param archivePath The full path to the .tar.gz file.
 * @param extractPath The directory to extract the contents into.
 */
async function extractArchive(archivePath: string, extractPath: string): Promise<void> {
    console.log(`Extracting ${archivePath} to ${extractPath}...`);

    fs.mkdirSync(extractPath, { recursive: true });

    try {
        await tar.x({
            file: archivePath,
            cwd: extractPath,
        });
        console.log('Extraction complete.');
    } catch (error) {
        console.error('Extraction failed:', error);
        throw error;
    }
}

/**
 * Performs the actual installation of Python. This function is for internal use
 * and assumes an installation is required.
 */
async function _performInstallation(): Promise<void> {
    const platform = getPlatform();

    if (platform === 'linux') {
        console.log('Creating Python virtual environment...');
        const venvPath = getVenvPath();
        try {
            fs.mkdirSync(path.dirname(venvPath), { recursive: true });
            await execFileAsync('python3', ['-m', 'venv', venvPath]);
            console.log(`Python venv created successfully at ${venvPath}`);
        } catch (e) {
            const errorMessage =
                'Failed to create Python venv. Make sure `python3` and the `python3-venv` package are installed on your system.';
            console.error(errorMessage, e);
            mainWindow?.webContents.send('notification', {
                title: 'Python Error',
                message: errorMessage,
            });
            throw e;
        }
    } else {
        console.log('Downloading and extracting standalone Python build...');
        const pythonDownload = downloads[platform];
        const archiveName = 'python.tar.gz';
        let archivePath: string | undefined;

        try {
            archivePath = await downloadFile(pythonDownload.url, DOWNLOADS_DIR, archiveName);
            await extractArchive(archivePath, BASE_DIR);
            console.log('Python installation complete.');
        } catch (error) {
            console.error('Failed to install Python from standalone build:', error);
            throw error;
        } finally {
            if (archivePath && fs.existsSync(archivePath)) {
                console.log(`Cleaning up downloaded archive: ${archivePath}`);
                fs.unlinkSync(archivePath);
            }
        }
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

    console.log('Python not found. Starting installation process...');
    const message =
        getPlatform() === 'linux'
            ? 'Setting up Python virtual environment. This may take a moment...'
            : 'Downloading Python. This may take a while depending on your connection...';

    mainWindow?.webContents.send('notification', {
        title: 'Python Setup',
        message: message,
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
    const platform = getPlatform();

    if (platform === 'linux') {
        const venvPath = getVenvPath();
        if (fs.existsSync(venvPath)) {
            console.log(`Removing existing Python venv at: ${venvPath}`);
            fs.rmSync(venvPath, { recursive: true, force: true });
        }
    } else {
        if (fs.existsSync(PYTHON_DIR)) {
            console.log(`Removing existing Python installation at: ${PYTHON_DIR}`);
            fs.rmSync(PYTHON_DIR, { recursive: true, force: true });
        }
    }

    console.log('Existing installation removed. Proceeding with fresh installation...');
    await getOrInstallPython();
    console.log('Python reinstallation complete.');
}