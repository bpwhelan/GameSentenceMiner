import {exec, execFile} from 'child_process';
import {BrowserWindow, ipcMain, dialog} from 'electron';
import {getAssetsDir} from '../util.js';
import {isQuitting} from '../main.js';
import {
    getSteamGames,
    getSteamPath,
    setSteamPath,
    setLaunchSteamOnStart,
    getLaunchSteamOnStart,
    setAgentPath, setSteamGames, getAgentPath, getAgentScriptsPath,
} from '../store.js';
import path from "path";

export let steamWindow: BrowserWindow | null = null;
export let gameConfigWindow: BrowserWindow | null = null;
let addSteamGameIPCRegistered: boolean = false;

export interface SteamGame {
    id: number;
    name: string;
    processName: string;
    script: string;
}

function launchSteamGame(gameId: number): number | null {
    try {
        let process = execFile(getSteamPath(), ['-applaunch', gameId.toString()]);
        return process.pid ?? null;
    } catch (error) {
        console.error(`Error launching Steam game:`, error);
        return null;
    }
}

function runAgentScript(gameId: number, steamPid: number, gameScript: string) {
    if (!gameScript) {
        console.warn(`No agent script found for game ID: ${gameId}`);
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

        exec(command, (error, stdout) => {
            if (error) {
                return reject(-1);
            }

            const pids = stdout
                .trim()
                .split("\n")
                .map(line => {
                    if (process.platform === "win32") {
                        const match = line.match(/"([^"]+)",\s*"(\d+)"/);
                        console.log(match ? parseInt(match[2], 10) : -1);
                        return match ? parseInt(match[2], 10) : -1;
                    }
                    return parseInt(line.trim(), 10);
                })
                .filter(pid => pid !== -1) as number[];

            resolve(pids[0] ?? -1);
        });
    });
}

export async function launchSteamGameID(gameId: number) {
    const games = getSteamGames();
    const selectedGame = games.find((g: SteamGame) => g.id === gameId);

    if (selectedGame) {
        const steamPid = launchSteamGame(selectedGame.id);
        setTimeout(() => {
            getPidByProcessName(selectedGame.processName).then((gamePid) => {
                if (gamePid === -1) {
                    console.warn(`Game process not found for Process Name: ${selectedGame.processName}, need to manually connect!`);
                }
                runAgentScript(gameId, gamePid, selectedGame.script);
            });
        }, 5000);
    } else {
        console.log(JSON.stringify({status: 'error', message: 'Game not found'}));
    }
}

export function openSteamWindow() {
    if (steamWindow) {
        steamWindow.focus();
        return;
    }

    steamWindow = new BrowserWindow({
        width: 800,
        height: 600,
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

    registerIPC();
}

function registerIPC() {
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

    ipcMain.handle('steam.launchSteamGame', async (_, gameId: number) => {
        try {
            await launchSteamGameID(gameId);
        } catch (error) {
            console.error('Error launching game:', error);
            return {status: 'error', message: 'Failed to launch game'};
        }
    });

    ipcMain.handle('steam.setSteamPath', async () => {
        if (steamWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(steamWindow, {
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
        if (steamWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(steamWindow, {
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

    ipcMain.handle('steam.removeSteamGame', async (_, gameId: number) => {
        try {
            console.log('Removing game with ID:', gameId);
            const games: SteamGame[] = getSteamGames() || [];
            const updatedGames = games.filter(game => Number(game.id) !== Number(gameId));
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
        if (steamWindow) {
            // Show the game configuration dialog
            gameConfigWindow = new BrowserWindow({
                width: 800,
                height: 600,
                parent: steamWindow,
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
                    try {
                        const {steamId, gameName, executablePath, scriptPath} = config;
                        const games = getSteamGames() || [];
                        const newGame = {
                            id: parseInt(steamId, 10),
                            name: gameName,
                            processName: executablePath,
                            script: scriptPath
                        };
                        games.push(newGame);
                        setSteamGames(games);
                        steamWindow?.webContents.send('steamGamesUpdated');
                        return {status: 'success', message: 'Configuration saved successfully!'};
                    } catch (error) {
                        console.error('Error saving configuration:', error);
                        return {status: 'error', message: 'Failed to save configuration'};
                    }
                });

                ipcMain.handle("steam.getAgentScriptPath", async () => {
                    if (gameConfigWindow) {
                        try {
                            const {canceled, filePaths} = await dialog.showOpenDialog(gameConfigWindow, {
                                properties: ['openFile'],
                                filters: [
                                    {name: 'Executables', extensions: ['js']}, // Adjust filters as needed
                                    {name: 'All Files', extensions: ['*']}
                                ],
                                defaultPath : getAgentScriptsPath()
                            });

                            if (canceled || !filePaths.length) {
                                return {status: "canceled", message: "No file selected"};
                            }

                            return {status: "success", message: "Agent Script path set successfully", path: filePaths[0]};
                        } catch (error) {
                            console.error("Error setting Agent Script path:", error);
                            return {status: "error", message: "Failed to set Agent Script path"};
                        }
                    }
                });
            }
        }
    });
}