import {exec, execFile} from "child_process";
import {readdirSync} from "fs";
import {join, resolve} from "path";
import {isMainThread, parentPort, Worker} from "worker_threads";
import {
    getAgentPath,
    getAgentScriptsPath, getLaunchVNOnStart, getLaunchYuzuGameOnStart,
    getYuzuEmuPath,
    getYuzuRomsPath,
    setAgentPath, setAgentScriptsPath, setLaunchVNOnStart, setLaunchYuzuGameOnStart,
    setYuzuEmuPath,
    setYuzuRomsPath
} from "../store.js";
import {BrowserWindow, ipcMain, dialog} from "electron";
import path from "path";
import {getAssetsDir} from "../util.js";
import {isQuitting} from "../main.js";

export let yuzuWindow: BrowserWindow | null = null;

interface YuzuGame {
    id: string;
    name: string;
    path: string;
}

/**
 * Get a list of games from the ROMS directory.
 */
function getYuzuGames(directory: string): YuzuGame[] {
    const games: YuzuGame[] = [];
    const pattern = /(.+?)\s*[\[\(](\w+)[\]\)]/; // Extract name and ID

    for (const filename of readdirSync(directory)) {
        const match = pattern.exec(filename);
        if (match) {
            const name = match[1];
            const fileId = match[2];
            const absPath = resolve(join(directory, filename));
            games.push({id: fileId, name, path: absPath});
        }
    }

    return games;
}

/**
 * Launch Yuzu with the selected game.
 */
function launchYuzu(romPath: string): number | null {
    const flag = getYuzuEmuPath().toLowerCase().includes("yuzu") ? "-g" : "";
    const command = `"${getYuzuEmuPath()}" ${flag} "${romPath}"`;

    try {
        let process = execFile(getYuzuEmuPath(), [romPath], {windowsHide: false});
        return process.pid ?? null;
    } catch (error) {
        console.error(`Error launching Yuzu:`, error);
        return null;
    }
}

/**
 * Find the agent script that matches the game ID.
 */
function findAgentScript(gameId: string): string | null {
    const files = readdirSync(getAgentScriptsPath());
    for (const file of files) {
        if (file.includes(gameId) && file.endsWith(".js")) {
            return join(getAgentScriptsPath(), file);
        }
    }
    return null;
}

/**
 * Run the agent script for a game.
 */
function runAgentScript(gameId: string, yuzuPid: number) {
    const agentScript = findAgentScript(gameId);
    if (!agentScript) {
        console.warn(`No agent script found for game ID: ${gameId}`);
        return;
    }

    const command = `"${getAgentPath()}" --script="${agentScript}" --pname=${yuzuPid}`;
    console.log(`Running agent script: ${command}`);
    exec(command);
}

/**
 * Check if a process is running.
 */
function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error.code !== "ESRCH";
    }
}

/**
 * Monitor Yuzu process and stop when it exits.
 */
function monitorProcessAndFlag(yuzuPid: number) {
    if (!isMainThread) {
        parentPort?.on("message", () => {
            const checkInterval = setInterval(() => {
                if (!isProcessRunning(yuzuPid)) {
                    parentPort?.postMessage("exit");
                    clearInterval(checkInterval);
                    process.exit(0);
                }
            }, 1000);
        });
    }
}

/**
 * Main function to handle actions.
 */
export async function launchYuzuGameID(gameId: string) {
    const games = getYuzuGames(getYuzuRomsPath());
    const selectedGame = games.find((g) => g.id === gameId);

    console.log(selectedGame)

    if (selectedGame) {
        const yuzuPid = launchYuzu(selectedGame.path);
        if (yuzuPid) {
            runAgentScript(gameId, yuzuPid);
        }
    } else {
        console.log(JSON.stringify({status: "error", message: "Game not found"}));
    }
}

export function openYuzuWindow() {
    if (yuzuWindow) {
        yuzuWindow.focus();
        return;
    }

    yuzuWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
        },
    });

    yuzuWindow.loadFile(path.join(getAssetsDir(), "yuzu.html"));

    yuzuWindow.on("close", (event) => {
        if (!isQuitting) {
            event.preventDefault();
            yuzuWindow?.hide();
        } else {
            yuzuWindow = null;
        }
    });
    registerIPC();
}

function registerIPC() {
    ipcMain.handle("yuzu.getYuzuGames", async (): Promise<YuzuGame[]> => {
        try {
            return getYuzuGames(getYuzuRomsPath()) // Convert JSON string to array of YuzuGame
        } catch (error) {
            console.error("Error fetching games:", error);
            return [];
        }
    });

    ipcMain.handle("yuzu.setAgentScriptsPath", async () => {
        if (yuzuWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(yuzuWindow, {
                    properties: ['openDirectory'],
                    filters: [
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: "canceled", message: "No directory selected"};
                }

                setAgentScriptsPath(filePaths[0]);
                return {status: "success", message: "Agents Script path set successfully", path: filePaths[0]};
            } catch (error) {
                console.error("Error setting Agents Script path:", error);
                return {status: "error", message: "Failed to set Agents Script path"};
            }
        }
    });

    /**
     * Launch a selected game by its ID.
     */
    ipcMain.handle("yuzu.launchYuzuGame", async (_, gameId: string) => {
        try {
            console.log(`Launching game with ID: ${gameId}`);
            await launchYuzuGameID(gameId);
        } catch (error) {
            console.error("Error launching game:", error);
            return {status: "error", message: "Failed to launch game"};
        }
    });

    ipcMain.handle("yuzu.setAgentPath", async () => {
        if (yuzuWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(yuzuWindow, {
                    properties: ['openFile'],
                    filters: [
                        {name: 'Executables', extensions: ['exe']}, // Adjust filters as needed
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: "canceled", message: "No file selected"};
                }

                setAgentPath(filePaths[0]);
                return {status: "success", message: "Agent path set successfully", path: filePaths[0]};
            } catch (error) {
                console.error("Error setting Agent path:", error);
                return {status: "error", message: "Failed to set Agent path"};
            }
        }
    });

    ipcMain.handle("yuzu.setYuzuPath", async () => {
        if (yuzuWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(yuzuWindow, {
                    properties: ['openFile'],
                    filters: [
                        {name: 'Executables', extensions: ['exe']}, // Adjust filters as needed
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: "canceled", message: "No file selected"};
                }

                setYuzuEmuPath(filePaths[0]);
                return {status: "success", message: "Yuzu path set successfully", path: filePaths[0]};
            } catch (error) {
                console.error("Error setting Yuzu path:", error);
                return {status: "error", message: "Failed to set Yuzu path"};
            }
        }
    });

    ipcMain.handle("yuzu.setRomsPath", async () => {
        if (yuzuWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(yuzuWindow, {
                    properties: ['openDirectory'],
                    filters: [
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: "canceled", message: "No directory selected"};
                }

                setYuzuRomsPath(filePaths[0]);
                return {status: "success", message: "ROM path set successfully", path: filePaths[0]};
            } catch (error) {
                console.error("Error setting ROM path:", error);
                return {status: "error", message: "Failed to set ROM path"};
            }
        }
    });

    ipcMain.handle("yuzu.setYuzuLaunchOnStart", async (_, launchOnStart: string) => {
        setLaunchYuzuGameOnStart(launchOnStart || "");
    });

    ipcMain.handle("yuzu.getYuzuLaunchOnStart", async (_,) => {
        return getLaunchYuzuGameOnStart();
    });
}
