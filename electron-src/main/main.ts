import {app, BrowserWindow, Tray, Menu} from 'electron';
import * as path from 'path';
import {spawn, execFile, ChildProcessWithoutNullStreams} from 'child_process';
import {getOrInstallPython} from "./python_downloader";
import {BASE_DIR} from "./util";

const iconPath = path.join(__dirname, 'icon.png'); // Reference it directly
let mainWindow: BrowserWindow;
let tray: Tray;
let pyProc: ChildProcessWithoutNullStreams;
let isQuitting = false;

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 * @param stdout
 * @param stderr
 */
function runCommand(command: string, args: string[], stdout: boolean, stderr: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);

        if (stdout) {
            proc.stdout.on("data", (data) => {
                console.log(`stdout: ${data}`);
            });
        }

        if (stderr) {
            proc.stderr.on("data", (data) => {
                console.error(`stderr: ${data}`);
            });
        }


        proc.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });

        proc.on("error", (err) => {
            reject(err);
        });
    });
}

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 */
function runGSM(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);

        pyProc = proc;

        proc.stdout.on('data', (data) => {
            mainWindow.webContents.send('terminal-output', data.toString());
        });

        // Capture stderr (optional)
        proc.stderr.on('data', (data) => {
            mainWindow.webContents.send('terminal-error', data.toString());
        });

        proc.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
            app.quit()
        });

        proc.on("error", (err) => {
            reject(err);
        });
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        icon: iconPath,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.setMenu(null);

    const originalLog = console.log;
    console.log = function (...args) {
        const message = args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ');
        mainWindow.webContents.send('terminal-output', `${message}\r\n`);
        originalLog.apply(console, args);
    };

    mainWindow.on('close', function (event) {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    })
}

function createTray() {
    tray = new Tray(iconPath); // Replace with a valid icon path
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Console', click: () => mainWindow.show() },
        { label: 'Quit', click: () => quit() }
    ]);

    tray.setToolTip('GameSentenceMiner');
    tray.setContextMenu(contextMenu);

    // Restore window when clicking the tray icon
    tray.on('click', () => {
        mainWindow.show();
    });
}

async function isPackageInstalled(pythonPath: string, packageName: string): Promise<boolean> {
    try {
        await runCommand(pythonPath, ["-m", "pip", "show", packageName], false, false);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensures GameSentenceMiner is installed before running it.
 */
async function ensureAndRunGSM(pythonPath: string): Promise<void> {
    const packageName = "gamesentenceminer";

    const isInstalled = await isPackageInstalled(pythonPath, packageName);

    if (!isInstalled) {
        console.log(`${packageName} is not installed. Installing now...`);
        try {
            await runCommand(pythonPath, ["-m", "pip", "install", "--no-warn-script-location", packageName], true, true);
            console.log("Installation complete.");
        } catch (err) {
            console.error("Failed to install package:", err);
            process.exit(1);
        }
    } else {
        console.log(`${packageName} is already installed.`);
    }

    console.log("Starting GameSentenceMiner...");
    try {
        return await runGSM(pythonPath, ["-m", "GameSentenceMiner.gsm"]);
    } catch (err) {
        console.error("Failed to start GameSentenceMiner:", err);
    }
}

app.setPath('userData', path.join(BASE_DIR, 'electron'));


app.whenReady().then(() => {
    createWindow();
    createTray();
    getOrInstallPython().then((pythonPath) => {
        ensureAndRunGSM(pythonPath).then(() => {
            quit();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            quit();
        }
    });

    app.on('before-quit', () => {
        isQuitting = true;
    });
});

function quit(): void {
    pyProc.stdin.write('exit');
    app.quit();
}