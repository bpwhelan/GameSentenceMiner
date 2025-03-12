import {exec, spawn, execFile} from "child_process";
import {readdirSync} from "fs";
import {join, resolve} from "path";
import {isMainThread, parentPort, Worker} from "worker_threads";
import {getAgentScriptsPath, getYuzuEmuPath, getYuzuRomsPath} from "../store.js";
import {ipcMain} from "electron";

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
        let process = execFile(getYuzuEmuPath(), [romPath]);
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

    const command = `agent --script="${agentScript}" --pname=${yuzuPid}`;
    exec(command, (error) => {
        if (error) {
            console.error(`Error running agent script:`, error);
        }
    });
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
async function launch(gameId: string) {
    const games = getYuzuGames(getYuzuRomsPath());
    const selectedGame = games.find((g) => g.id === gameId);

    if (selectedGame) {
        const yuzuPid = launchYuzu(selectedGame.path);
        if (yuzuPid) {
            setTimeout(() => {
                runAgentScript(gameId, yuzuPid);
            }, 2000);
        }
    } else {
        console.log(JSON.stringify({status: "error", message: "Game not found"}));
    }
}

export function registerYuzuIPC() {
    /**
     * Fetch the list of available Yuzu games by running the Python script.
     */
    ipcMain.handle("getGames", async (): Promise<YuzuGame[]> => {
        try {
            return getYuzuGames(getYuzuRomsPath()) // Convert JSON string to array of YuzuGame
        } catch (error) {
            console.error("Error fetching games:", error);
            return [];
        }
    });

    /**
     * Launch a selected game by its ID.
     */
    ipcMain.handle("launchGame", async (_, gameId: string) => {
        try {
            await launch(gameId);
        } catch (error) {
            console.error("Error launching game:", error);
            return {status: "error", message: "Failed to launch game"};
        }
    });
}
