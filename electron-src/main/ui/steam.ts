import {exec, execFile} from 'child_process';
import {BrowserWindow, ipcMain, dialog} from 'electron';
import {getAssetsDir} from '../util.js';
import {isQuitting, mainWindow} from '../main.js';
import {
    getSteamGames,
    getSteamPath,
    setSteamPath,
    setLaunchSteamOnStart,
    getLaunchSteamOnStart,
    setAgentPath,
    setSteamGames,
    getAgentPath,
    getAgentScriptsPath,
    getLastSteamGameLaunched,
    setLastSteamGameLaunched,
    getTextractorPath,
} from '../store.js';
import path from "path";
import {getCurrentScene, ObsScene} from "./obs.js";
import * as fs from "fs";
import Fuse from 'fuse.js'

export let steamWindow: BrowserWindow | null = null;
export let gameConfigWindow: BrowserWindow | null = null;
let addSteamGameIPCRegistered: boolean = false;

export interface SteamGame {
    id: number;
    name: string;
    processName: string;
    script: string;
    scene: ObsScene;
    executablePath: string;
    runAgent: boolean;
    runTextractor: boolean;
}

function launchSteamGame(gameIdOrExecutable: number | string): number | null {
    try {
        if (typeof gameIdOrExecutable === 'number') {
            let process = execFile(getSteamPath(), ['-applaunch', gameIdOrExecutable.toString()]);
            return process.pid ?? null;
        } else {
            const executableDir = path.dirname(gameIdOrExecutable);
            let process = execFile(gameIdOrExecutable, [], { cwd: executableDir });
            if (!process.pid) {
                process = exec(gameIdOrExecutable, { cwd: executableDir });
            }
            return process.pid ?? null;
        }
    } catch (error) {
        console.error(`Error launching Steam game:`, error);
        return null;
    }
}


function runAgentScript(name: string, steamPid: number, gameScript: string) {
    if (!gameScript) {
        console.warn(`No agent script found for game: ${name}`);
        return;
    }

    const command = `"${getAgentPath()}" --script="${gameScript}" --pname=${steamPid}`;
    console.log(command);
    exec(command, (error) => {
        if (error) {
            console.error(`Error running agent script:`, error);
        }
    });
}

async function getPidByProcessName(processName: string): Promise<number> {
    return new Promise((resolve, reject) => {
        let command: string;

        if (process.platform === "win32") {
            command = `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`;
        } else {
            command = `pgrep ${processName}`;
        }

        const startTime = Date.now();
        const retryInterval = 1000; // Retry every second
        const timeout = 30000; // Timeout after 10 seconds

        const tryGetPid = () => {
            exec(command, (error, stdout) => {
                if (error) {
                    if (Date.now() - startTime >= timeout) {
                        return resolve(-1);
                    } else {
                        console.log("Error getting PID for Steam Game, Retrying in 1 second, Retries Left:" + Math.floor((timeout - (Date.now() - startTime)) / retryInterval));
                        return setTimeout(tryGetPid, retryInterval);
                    }
                }

                const pids = stdout
                    .trim()
                    .split("\n")
                    .map(line => {
                        if (process.platform === "win32") {
                            const match = line.match(/"([^"]+)",\s*"(\d+)"/);
                            return match ? parseInt(match[2], 10) : -1;
                        }
                        return parseInt(line.trim(), 10);
                    })
                    .filter(pid => pid !== -1) as number[];

                if (pids.length > 0) {
                    return resolve(pids[0]);
                } else if (Date.now() - startTime >= timeout) {
                    return resolve(-1);
                } else {
                    console.log("Error getting PID for Steam Game, Retrying in 1 second, Retries Left:" + Math.floor((timeout - (Date.now() - startTime)) / retryInterval));
                    setTimeout(tryGetPid, retryInterval);
                }
            });
        };

        tryGetPid();
    });
}

export async function launchSteamGameID(name: string, shouldLaunchAgent: boolean = true): Promise<void> {
    const games = getSteamGames();
    const selectedGame = games.find((g: SteamGame) => String(g.name) === String(name));

    if (selectedGame) {
        if (selectedGame.executablePath) {
            const steamPid = launchSteamGame(selectedGame.executablePath);
        } else {
            const steamPid = launchSteamGame(selectedGame.id);
        }
        if (selectedGame.runAgent) {
            setTimeout(() => {
                if (shouldLaunchAgent) {
                    getPidByProcessName(selectedGame.processName).then((gamePid) => {
                        if (gamePid === -1) {
                            console.warn(`Game process not found for Process Name: ${selectedGame.processName}, need to manually connect!`);
                        }
                        runAgentScript(name, gamePid, selectedGame.script);
                    });
                }
            }, 3000);
        }
        if (selectedGame.runTextractor) {
            const textractorPath = getTextractorPath();
            const textractorProcess = execFile(textractorPath, {windowsHide: false});
            console.log(`Textractor launched with PID: ${textractorProcess.pid}`);
        }
    } else {
        console.log(JSON.stringify({status: 'error', message: 'Game not found'}));
    }
}

export function openSteamWindow() {
    if (steamWindow) {
        steamWindow.show();
        steamWindow.focus();
        return;
    }

    steamWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
        },
    });

    steamWindow.loadFile(path.join(getAssetsDir(), 'steam.html'));

    steamWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            steamWindow?.hide();
        } else {
            steamWindow = null;
        }
    });

    registerSteamIPC();
}

export function registerSteamIPC() {
    ipcMain.handle('steam.getSteamGames', async (): Promise<SteamGame[]> => {
        try {
            return getSteamGames();
        } catch (error) {
            console.error('Error fetching games:', error);
            return [];
        }
    });

    ipcMain.handle("steam.getSteamLaunchOnStart", async () => {
        return getLaunchSteamOnStart();
    });

    ipcMain.handle("steam.setSteamLaunchOnStart", async (_, gameId: number) => {
        setLaunchSteamOnStart(gameId || 0);
    });

    ipcMain.handle("steam.getLastSteamGameLaunched", async () => {
        return getLastSteamGameLaunched();
    });

    ipcMain.handle('steam.launchSteamGame', async (_, req: { name: string, shouldLaunchAgent: boolean }) => {
        try {
            await launchSteamGameID(req.name, req.shouldLaunchAgent);
            setLastSteamGameLaunched(req.name);
            return {status: 'success', message: 'Game launched successfully'};
        } catch (error) {
            console.error('Error launching game:', error);
            return {status: 'error', message: 'Failed to launch game'};
        }
    });

    ipcMain.handle('steam.setSteamPath', async () => {
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
                    properties: ['openFile'],
                    filters: [
                        {name: 'Executables', extensions: ['exe']},
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: 'canceled', message: 'No file selected'};
                }

                setSteamPath(filePaths[0]);
                return {status: 'success', message: 'Steam path set successfully', path: filePaths[0]};
            } catch (error) {
                console.error('Error setting Steam path:', error);
                return {status: 'error', message: 'Failed to set Steam path'};
            }
        }
    });

    ipcMain.handle('steam.setAgentPath', async () => {
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
                    properties: ['openFile'],
                    filters: [
                        {name: 'Executables', extensions: ['exe']},
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: 'canceled', message: 'No file selected'};
                }

                setAgentPath(filePaths[0]);
                return {status: 'success', message: 'Agent path set successfully', path: filePaths[0]};
            } catch (error) {
                console.error('Error setting Agent path:', error);
                return {status: 'error', message: 'Failed to set Agent path'};
            }
        }
    });

    ipcMain.handle('steam.getExecutablePath', async () => {
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
                    properties: ['openFile'],
                    filters: [
                        {name: 'Executables', extensions: ['exe']},
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: 'canceled', message: 'No file selected'};
                }

                return {status: 'success', message: 'Agent path set successfully', path: filePaths[0]};
            } catch (error) {
                console.error('Error setting Agent path:', error);
                return {status: 'error', message: 'Failed to set Agent path'};
            }
        }
    });

    ipcMain.handle('steam.removeSteamGame', async (_, gameName: string) => {
        try {
            console.log('Removing game with Name:', gameName);
            const games: SteamGame[] = getSteamGames() || [];
            const updatedGames = games.filter(game => String(game.name) !== String(gameName));
            setSteamGames(updatedGames);
            return {status: 'success', message: 'Game removed successfully'};
        } catch (error) {
            console.error('Error removing game:', error);
            return {status: 'error', message: 'Failed to remove game'};
        }
    });

    ipcMain.handle('steam.getLaunchOnStart', async () => {
        return getLaunchSteamOnStart();
    });

    ipcMain.handle('steam.showGameConfigDialog', async () => {
        if (mainWindow) {
            // Show the game configuration dialog
            gameConfigWindow = new BrowserWindow({
                width: 1280,
                height: 1000,
                parent: mainWindow,
                modal: true,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                },
            });

            gameConfigWindow.loadFile(path.join(getAssetsDir(), 'steamConfig.html'));

            gameConfigWindow.on('close', (event) => {
                event.preventDefault();
                gameConfigWindow?.hide()
            });

            if (!addSteamGameIPCRegistered) {
                addSteamGameIPCRegistered = true;

                ipcMain.handle("steam.saveSteamGame", async (_, config) => {
                    console.log(config)
                    try {
                        const {
                            steamId,
                            gameName,
                            executableName,
                            scriptPath,
                            scene,
                            executablePath,
                            runAgent,
                            runTextractor
                        } = config;
                        const games = getSteamGames() || [];
                        const newGame = {
                            id: parseInt(steamId, 10),
                            name: gameName,
                            processName: executableName,
                            script: scriptPath,
                            scene: scene,
                            executablePath: executablePath,
                            runAgent: runAgent,
                            runTextractor: runTextractor
                        };
                        games.push(newGame);
                        setSteamGames(games);
                        mainWindow?.webContents.send('steamGamesUpdated');
                        gameConfigWindow?.hide()
                        return {status: 'success', message: 'Configuration saved successfully!'};
                    } catch (error) {
                        console.error('Error saving configuration:', error);
                        return {status: 'error', message: 'Failed to save configuration'};
                    }
                });

                ipcMain.handle("steam.getAgentScriptPath", async (_, gameName: string) => {
                    if (gameConfigWindow) {
                        const agentScriptsPath = getAgentScriptsPath();

                        try {
                            const files = await fs.promises.readdir(agentScriptsPath);

                            const fuse = new Fuse(files, {
                                keys: ['name'],
                                threshold: 0.6
                            });

                            const results = fuse.search(gameName);

                            if (results.length > 0) {
                                const bestMatch = path.join(agentScriptsPath, results[0].item);
                                // Option 1: Pre-populate in UI (you'd need to send this back to the renderer)
                                // return { status: "success", message: "Likely match found", path: bestMatch };

                                // Option 2: Set defaultPath to guide the user
                                const {canceled, filePaths} = await dialog.showOpenDialog(gameConfigWindow, {
                                    properties: ['openFile'],
                                    filters: [
                                        {name: 'Executables', extensions: ['js']},
                                        {name: 'All Files', extensions: ['*']}
                                    ],
                                    defaultPath: bestMatch
                                });

                                if (canceled || !filePaths.length) {
                                    return {status: "canceled", message: "No file selected"};
                                }

                                return {
                                    status: "success",
                                    message: "Agent Script path set successfully",
                                    path: filePaths[0]
                                };
                            } else {
                                // No good match found, show the dialog as before
                                const {canceled, filePaths} = await dialog.showOpenDialog(gameConfigWindow, {
                                    properties: ['openFile'],
                                    filters: [
                                        {name: 'Executables', extensions: ['js']},
                                        {name: 'All Files', extensions: ['*']}
                                    ],
                                    defaultPath: agentScriptsPath
                                });

                                if (canceled || !filePaths.length) {
                                    return {status: "canceled", message: "No file selected"};
                                }

                                return {
                                    status: "success",
                                    message: "Agent Script path set successfully",
                                    path: filePaths[0]
                                };
                            }
                        } catch (error: any) {
                            console.error("Error setting Agent Script path:", error);
                            return {status: "error", message: "Failed to set Agent Script path"};
                        }
                    }
                    return {status: "error", message: "gameConfigWindow is not defined"};
                });
            }
        }
    });
}