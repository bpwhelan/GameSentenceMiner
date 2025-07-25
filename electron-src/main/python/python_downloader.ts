import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {Downloader} from "nodejs-file-downloader";
import * as tar from "tar";
import {BASE_DIR, execFileAsync, getPlatform, isArmMac, SupportedPlatform} from "../util.js";
import {mainWindow} from "../main.js";

interface PythonDownload {
    url: string;
    version: string;
    path: string;
}

const downloads: Record<SupportedPlatform, PythonDownload> = {
    linux: {
        url: 'https://github.com/astral-sh//python-build-standalone/releases/download/20250529/cpython-3.11.12+20250529-x86_64-unknown-linux-gnu-install_only.tar.gz',
        version: '3.11.12',
        path: 'python/bin/python3.11',
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

const PYTHON_DIR = path.join(BASE_DIR, 'python');

function getVenvPath(): string {
    return path.join(os.homedir(), '.config', 'GameSentenceMiner', 'python_venv');
}

/**
 * Checks if Python is installed
 */
function isPythonInstalled(): boolean {
    if (getPlatform() === 'linux') {
        const venvPath = getVenvPath();
        return fs.existsSync(path.join(venvPath, 'bin', 'python'));
    }
    return fs.existsSync(
        path.join(BASE_DIR, downloads[getPlatform()].path)
    );
}

/**
 * Downloads a file to a given destination using nodejs-file-downloader
 */
async function downloadFile(url: string, directory: string): Promise<void> {
    try {
        console.log(`Downloading Python from ${url}...`);

        const tarName = 'python.tar.gz';
        const tarPath = path.join(directory, tarName);

        const downloader = new Downloader({
            url,                   // The file URL
            directory: directory, // The directory to save the file
            fileName: tarName, // You can set the file name explicitly
            cloneFiles: false,     // Avoids duplicate file creation
        });

        const { filePath, downloadStatus } = await downloader.download();

        if (downloadStatus === "COMPLETE") {
            console.log(`Download complete: ${filePath}`);
        } else {
            throw new Error("Download failed or incomplete.");
        }
    } catch (error) {
        console.error(`Failed to download file: ${error}`);
        throw error;
    }
}

async function extractPython(archivePath: string, extractPath: string): Promise<void> {
    console.log("Extracting Python...");

    // Ensure the extraction directory exists
    fs.mkdirSync(extractPath, { recursive: true });

    try {
        await tar.x({ file: archivePath, cwd: extractPath });
        console.log("Extraction complete.");
    } catch (error) {
        console.error("Extraction failed:", error);
        throw error;
    }
}

/**
 * Installs Python if it is not present
 */
async function installPython(): Promise<void> {
    if (isPythonInstalled()) {
        return;
    }

    if (getPlatform() === 'linux') {
        console.log('Python venv not found. Creating...');
        const venvPath = getVenvPath();
        try {
            fs.mkdirSync(path.dirname(venvPath), { recursive: true });
            await execFileAsync('python3', ['-m', 'venv', venvPath]);
            console.log('Python venv created at', venvPath);
        } catch (e) {
            const errorMessage = 'Failed to create python venv. Make sure python3 and the "venv" module are installed on your system.';
            console.error(errorMessage, e);
            mainWindow?.webContents.send('notification', {
                title: 'Error',
                message: errorMessage,
            });
            throw e;
        }
        return;
    }

    console.log('Python is missing. Downloading...');

    if (!fs.existsSync(BASE_DIR)) {
        fs.mkdirSync(BASE_DIR, { recursive: true });
    }
    if (!fs.existsSync(PYTHON_DIR)) {
        fs.mkdirSync(PYTHON_DIR, { recursive: true });
    }

    const pythonDownload = downloads[getPlatform()];
    const archivePath = path.join(BASE_DIR, 'downloads');
    const tarPath = path.join(archivePath, 'python.tar.gz');

    try {
        await downloadFile(pythonDownload.url, archivePath);
        await extractPython(tarPath, BASE_DIR);
        console.log('Python installation complete.');
    } catch (error) {
        console.error('Failed to install Python:', error);
    } finally {
        if (fs.existsSync(tarPath)) {
            fs.unlinkSync(tarPath);
        }
    }
}

export async function getOrInstallPython(): Promise<string> {
    if (getPlatform() === 'linux') {
        const venvPath = getVenvPath();
        const pythonPath = path.join(venvPath, 'bin', 'python');

        if (!isPythonInstalled()) {
            mainWindow?.webContents.send('notification', {
                title: 'Install',
                message: 'Setting up Python virtual environment. Might take a while... Please check the Console tab for more details.',
            });
            console.log('Python venv not found. Creating...');
            await installPython();
        }

        if (!fs.existsSync(pythonPath)) {
            throw new Error('Python venv creation failed or missing executable.');
        }

        return pythonPath;
    }

    const pythonPath = path.join(BASE_DIR, downloads[getPlatform()].path);

    if (!isPythonInstalled()) {
        mainWindow?.webContents.send('notification', {
            title: 'Install',
            message: 'Finishing Install. Might take a while... Please check the Console tab for more details.',
        });
        console.log('Python not found. Installing...');
        await installPython();
    }

    if (!fs.existsSync(pythonPath)) {
        throw new Error('Python installation failed or missing executable.');
    }

    return pythonPath;
}

export async function reinstallPython(): Promise<void> {
    if (getPlatform() === 'linux') {
        const venvPath = getVenvPath();
        if (fs.existsSync(venvPath)) {
            console.log('Removing existing python venv...');
            fs.rmSync(venvPath, { recursive: true, force: true });
        }
        await installPython();
        return;
    }

    const pythonPath = path.join(BASE_DIR, downloads[getPlatform()].path);

    if (fs.existsSync(pythonPath)) {
        fs.unlinkSync(pythonPath);
    }

    await installPython();
}