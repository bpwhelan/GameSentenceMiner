import {app, BrowserWindow, Tray, Menu, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'child_process';
import * as http from 'http';
import {getOrInstallPython} from "./python_downloader";


const PORT: number = 3000;
const TEXTHOOK_PAGE = path.join(__dirname, 'index.html')

// Define the web server
const server: http.Server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const url: string | undefined = req.url;

    if (url === '/' || url === TEXTHOOK_PAGE) {
        fs.readFile(TEXTHOOK_PAGE, (err: NodeJS.ErrnoException | null, content: Buffer) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading index.html');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});


const iconPath = path.join(__dirname, 'icon.png'); // Reference it directly
let pyproc: ChildProcessWithoutNullStreams;

/**
 * Runs a command and returns a promise that resolves when the command exits.
 * @param command The command to run.
 * @param args The arguments to pass.
 */
function runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);

        proc.stdout.on("data", (data) => {
            console.log(`stdout: ${data}`);
        });

        proc.stderr.on("data", (data) => {
            console.error(`stderr: ${data}`);
        });

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

        pyproc = proc;

        proc.stdout.on("data", (data) => {
            console.log(`stdout: ${data}`);
        });

        proc.stderr.on("data", (data) => {
            console.error(`stderr: ${data}`);
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

async function isPackageInstalled(pythonPath: string, packageName: string): Promise<boolean> {
    try {
        await runCommand(pythonPath, ["-m", "pip", "show", packageName]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensures GameSentenceMiner is installed before running it.
 */
async function ensureAndRunGSM(pythonPath: string) {
    const packageName = "gamesentenceminer";

    const isInstalled = await isPackageInstalled(pythonPath, packageName);

    if (!isInstalled) {
        console.log(`${packageName} is not installed. Installing now...`);
        try {
            await runCommand(pythonPath, ["-m", "pip", "install", packageName]);
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

let mainWindow: BrowserWindow;
let optionsWindow: BrowserWindow;
let tray = null;

// Determine the Python executable path.
// In development, it might be a relative path;
// in production, use process.resourcesPath to locate the bundled interpreter.
const pythonPath = getOrInstallPython().then((pythonPath) => {

    app.whenReady().then(() => {
        ensureAndRunGSM(pythonPath);

        // mainWindow = new BrowserWindow({
        //     width: 800,
        //     height: 600,
        //     webPreferences: {
        //         nodeIntegration: true
        //     },
        //     title: "GameSentenceMiner",
        //     icon: path.join(__dirname, "icon.png"),
        // });
        //
        // const extensions = new ElectronChromeExtensions({
        //     license: 'GPL-3.0', modulePath: "",
        //     session: session.defaultSession
        // });

        // mainWindow.webContents.openDevTools(); // Opens DevTools
        // mainWindow.on('close', (event: Event) => {
        //     event.preventDefault();
        //     mainWindow?.hide(); // Hides the window instead of closing it
        // });

        // mainWindow.loadFile(path.join(__dirname, 'index.html'));

        // Start the server
        server.listen(PORT, 'localhost', () => {
            console.log(`Server running at http://localhost:${PORT}/`);
            // Open the default browser to the server URL
            shell.openExternal(`http://localhost:${PORT}`);
            // Uncomment the line below if you want Electron to quit after opening the browser
            // app.quit();
        });

        tray = new Tray(iconPath); // Replace with a valid icon path
        const contextMenu = Menu.buildFromTemplate([
            // { label: 'Show App', click: () => mainWindow.show() },
            { label: 'Quit', click: () => {
                    pyproc.kill('SIGTERM')
                    app.quit();
                }}
        ]);

        tray.setToolTip('My Electron App');
        tray.setContextMenu(contextMenu);

        // Restore window when clicking the tray icon
        // tray.on('click', () => {
        //     mainWindow.show();
        // });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit(); // Ensure app fully exits (except on macOS where apps typically stay open)
        }
    });

});