import {exec, execFile} from "child_process";
import {readdirSync} from "fs";
import {join, resolve} from "path";
import {isMainThread, parentPort, Worker} from "worker_threads";
import {
    getAgentPath,
    getAgentScriptsPath,
    getLastSteamGameLaunched,
    getLastYuzuGameLaunched,
    getLaunchVNOnStart,
    getLaunchYuzuGameOnStart,
    getYuzuEmuPath, getYuzuGamesConfig,
    getYuzuRomsPath,
    setAgentPath,
    setAgentScriptsPath,
    setLastYuzuGameLaunched,
    setLaunchVNOnStart,
    setLaunchYuzuGameOnStart,
    setYuzuEmuPath, setYuzuGamesConfig,
    setYuzuRomsPath, YuzuGame
} from "../store.js";
import {BrowserWindow, ipcMain, dialog} from "electron";
import path from "path";
import {getAssetsDir} from "../util.js";
import {isQuitting, mainWindow} from "../main.js";
import {ObsScene} from "./obs.js";

export let yuzuWindow: BrowserWindow | null = null;

interface nsGame {
    id: string;
    name: string;
    path: string;
}

/**
 * Get a list of games from the ROMS directory.
 */
export function getYuzuGames(directory: string): nsGame[] {
    const games: nsGame[] = [];
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

export function getConfiguredYuzuGames(): YuzuGame[] {
    return getYuzuGamesConfig();
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
export async function launchYuzuGameID(gameId: string, shouldLaunchAgent: boolean) {
    const games = getYuzuGames(getYuzuRomsPath());
    const selectedGame = games.find((g) => g.id === gameId);

    console.log(selectedGame)

    if (selectedGame) {
        const yuzuPid = launchYuzu(selectedGame.path);
        if (yuzuPid && shouldLaunchAgent) {
            runAgentScript(gameId, yuzuPid);
        }
    } else {
        console.log(JSON.stringify({status: "error", message: "Game not found"}));
    }
}

export function openYuzuWindow() {
    if (yuzuWindow) {
        yuzuWindow.show();
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
    registerYuzuIPC();
}

export function registerYuzuIPC() {
    ipcMain.handle("yuzu.getYuzuGames", async (): Promise<nsGame[]> => {
        try {
            return getYuzuGames(getYuzuRomsPath()) // Convert JSON string to array of YuzuGame
        } catch (error) {
            // console.error("Error fetching games:", error);
            return [];
        }
    });

    ipcMain.handle("yuzu.getConfiguredYuzuGames", async (): Promise<YuzuGame[]> => {
        return getConfiguredYuzuGames();
    });

    ipcMain.handle("yuzu.addToHomeBtn", async (_, req: YuzuGame) => {
        let games = getYuzuGamesConfig()
        // Check if game already exists and remove it
        const existingIndex = games.findIndex(g => g.id === req.id);
        if (existingIndex !== -1) {
            games.splice(existingIndex, 1);
        }
        games.push(req)
        setYuzuGamesConfig(games);
    });

    ipcMain.handle("yuzu.removeFromHomeBtn", async (_, gameId: string) => {
        let games = getYuzuGamesConfig();
        games = games.filter(g => g.id !== gameId);
        setYuzuGamesConfig(games);
    });

    ipcMain.handle("yuzu.setAgentScriptsPath", async () => {
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
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
    ipcMain.handle("yuzu.launchYuzuGame", async (_, req: {id: string, shouldLaunchAgent: boolean}) => {
        try {
            console.log(`Launching game with ID: ${req.id}`);
            await launchYuzuGameID(req.id, req.shouldLaunchAgent);
            setLastYuzuGameLaunched(req.id);
            return {status: "success", message: "Game launched successfully"};
        } catch (error) {
            console.error("Error launching game:", error);
            return {status: "error", message: "Failed to launch game"};
        }
    });

    ipcMain.handle("yuzu.setAgentPath", async () => {
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
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
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
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
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
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

    ipcMain.handle("yuzu.getLastYuzuGameLaunched", async () => {
        return getLastYuzuGameLaunched();
    });
}
