import {
    getExecutableNameFromSource,
    getCurrentScene,
    getWindowTitleFromSource,
    ObsScene
} from './ui/obs.js';
import {
    getSteamGames,
    getYuzuGamesConfig,
    YuzuGame,
    getAgentPath,
    getAgentScriptsPath,
    getYuzuEmuPath
} from './store.js';
import { SteamGame } from './ui/steam.js';
import { exec, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class AutoLauncher {
    private intervalId: NodeJS.Timeout | null = null;
    private lastHookedPid: number = -1;
    private lastHookedGameId: string = "";
    private readonly defaultPollingInterval: number = 5000;
    private readonly fastPollingInterval: number = 500;
    private readonly backoffStep: number = 50;
    private currentPollingInterval: number = this.defaultPollingInterval;
    private isPolling: boolean = false;
    private agentProcess: ChildProcess | null = null;
    private hasWarnedAboutExternalAgent: boolean = false;

    constructor() {
    }

    public startPolling() {
        if (this.intervalId) return;
        console.log("Starting AutoLauncher polling...");
        this.hasWarnedAboutExternalAgent = false;
        this.scheduleNextPoll(0); // Run immediately
    }

    public stopPolling() {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
            this.intervalId = null;
            console.log("Stopped AutoLauncher polling.");
            this.killAgent();
        }
    }

    private scheduleNextPoll(delay: number) {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
        }
        this.intervalId = setTimeout(() => this.poll(), delay);
    }

    private killAgent() {
        if (this.agentProcess) {
            console.log("AutoLauncher: Killing agent process.");
            this.agentProcess.kill();
            this.agentProcess = null;
        }
    }

    // Check if ANY Agent process is running on the system, not just the one we spawned
    private async isAgentAlreadyRunning(): Promise<boolean> {
        return new Promise((resolve) => {
            if (process.platform !== "win32") {
                // For non-Windows, use pgrep to check for Agent process
                exec('pgrep -x Agent', (error, stdout) => {
                    resolve(!error && stdout.trim().length > 0);
                });
                return;
            }

            // For Windows, use tasklist to check if Agent.exe is running
            const agentPath = getAgentPath();
            const agentExeName = agentPath ? path.basename(agentPath) : 'Agent.exe';
            
            const command = `tasklist /FI "IMAGENAME eq ${agentExeName}" /FO CSV /NH`;
            exec(command, (error, stdout) => {
                if (error || stdout.trim().toLowerCase().includes("no tasks are running")) {
                    resolve(false);
                    return;
                }
                
                // If stdout has any content (excluding just whitespace), Agent is running
                const lines = stdout.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
                resolve(lines.length > 0);
            });
        });
    }

    // On Windows, fetch the live window title for a PID using PowerShell (MainWindowTitle).
    // Returns null if unavailable or on non-Windows platforms.
    private async getLiveWindowTitle(pid: number): Promise<string | null> {
        return new Promise(resolve => {
            if (process.platform !== "win32" || pid <= 0) return resolve(null);

            const cmd = `powershell -NoLogo -NoProfile -Command "${'$'}p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (${ '$' }p -and ${ '$' }p.MainWindowTitle) { ${ '$' }p.MainWindowTitle }"`;
            exec(cmd, { windowsHide: true }, (err, stdout) => {
                if (err) return resolve(null);
                const title = stdout.trim();
                resolve(title.length > 0 ? title : null);
            });
        });
    }

    private async getPidByProcessName(processName: string): Promise<number> {
        return new Promise((resolve, reject) => {
            let command: string;

            // Windows: Get Name, PID, and Memory Usage in CSV format without headers
            // Output format: "Image Name","PID","Session Name","Session#","Mem Usage"
            if (process.platform === "win32") {
                command = `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`;
            } else {
                command = `pgrep ${processName}`;
            }

            const startTime = Date.now();
            const retryInterval = 1000; // Retry every second
            const timeout = 5000; // Timeout after 5 seconds

            const tryGetPid = () => {
                exec(command, (error, stdout) => {
                    if (error) {
                        if (Date.now() - startTime >= timeout) {
                            return resolve(-1);
                        } else {
                            return setTimeout(tryGetPid, retryInterval);
                        }
                    }

                    interface ProcessCandidate {
                        pid: number;
                        memory: number;
                    }

                    const candidates: ProcessCandidate[] = [];
                    const lines = stdout.trim().split(/\r?\n/);

                    lines.forEach(line => {
                        if (process.platform === "win32") {
                            // Regex to capture: "Name", "PID", (skipped), (skipped), "Memory"
                            // Example: "HogwartsLegacy.exe","78224","Console","1","9,873,708 K"
                            const match = line.match(/"([^"]+)",\s*"(\d+)",\s*"[^"]*",\s*"[^"]*",\s*"([^"]+)"/);
                            
                            if (match) {
                                const pid = parseInt(match[2], 10);
                                // Remove non-numeric characters (commas, ' K', etc) to parse memory size
                                const memStr = match[3].replace(/[^\d]/g, ''); 
                                const memory = parseInt(memStr, 10);
                                
                                // Filter out processes with less than 20MB of memory (likely wrappers/launchers)
                                if (!isNaN(pid) && memory > 20000) {
                                    candidates.push({ pid, memory: isNaN(memory) ? 0 : memory });
                                }
                            }
                        } else {
                            // Linux/Mac (pgrep output is just the PID)
                            const pid = parseInt(line.trim(), 10);
                            if (!isNaN(pid)) {
                                candidates.push({ pid, memory: 0 });
                            }
                        }
                    });

                    if (candidates.length > 0) {
                        // Sort by memory descending (highest memory first)
                        // This ensures we pick the actual game process, not a splash screen or wrapper
                        candidates.sort((a, b) => b.memory - a.memory);
                        
                        return resolve(candidates[0].pid);
                    } else if (Date.now() - startTime >= timeout) {
                        return resolve(-1);
                    } else {
                        setTimeout(tryGetPid, retryInterval);
                    }
                });
            };

            tryGetPid();
        });
    }

    private async poll() {
        if (this.isPolling) return;
        this.isPolling = true;
        let keepFastPolling = false;
        try {
            const currentScene: ObsScene = await getCurrentScene();
            if (!currentScene) {
                return;
            }

            // Get the process/executable name from OBS source in the current scene
            const exeName = await getExecutableNameFromSource(currentScene.id);
            // verbose log can be noisy, kept enabled as per original
            // console.log(`AutoLauncher: Current scene ID: ${currentScene.id}, exeName: ${exeName}`);

            // Check if it's a configured Steam Game
            const steamGame = getSteamGames().find(g =>
                (g.processName === exeName)
            );
            
            // if (steamGame?.scene.id && steamGame.scene.id !== currentScene.id) {
            //     // Save scene id in the game
            //     steamGame.scene.id = currentScene.id;
            //     steamGame.scene.name = currentScene.name;
            // }

            if (steamGame && steamGame.runAgent) {
                const targetProcess = steamGame.processName || exeName;
                // console.log(`AutoLauncher: Steam game detected (ID: ${steamGame.id}), target process: ${targetProcess}`);
                if (targetProcess) {
                    await this.handleGame(targetProcess, steamGame.script, String(steamGame.id), steamGame.agentDelay);
                }
                return;
            }

            // Check if it's a configured Yuzu Game
            const yuzuGame = getYuzuGamesConfig().find(g =>
                (g.scene && g.scene.id === currentScene.id)
            );

            if (yuzuGame) {
                // Use the actual process name from the OBS source (covers forks like Suyu/Ryujinx)
                const emuProcessName = exeName || path.basename(getYuzuEmuPath());
                if (!emuProcessName) {
                    return;
                }

                const precheckPid = await this.getPidByProcessName(emuProcessName);

                // If the emulator is already running, temporarily speed up polling to catch game launch ASAP
                if (precheckPid > 0) {
                    keepFastPolling = true;
                    this.currentPollingInterval = this.fastPollingInterval;
                }

                // console.log(`AutoLauncher: Yuzu game detected (ID: ${yuzuGame.id}), emulator process: ${emuProcessName}`);
                const scriptPath = this.findYuzuScript(yuzuGame.id);
                if (scriptPath) {
                    const validateYuzuContext = async () => {
                        const scene = await getCurrentScene();
                        if (!scene || scene.id !== yuzuGame.scene.id) return false;

                        const pid = await this.getPidByProcessName(emuProcessName);
                        const liveTitle = await this.getLiveWindowTitle(pid);
                        const currentTitle = liveTitle ?? await getWindowTitleFromSource(scene.id);
                        return this.titlesRoughlyMatch(yuzuGame.scene.name, currentTitle);
                    };

                    // Evaluate the window title just before attempting to hook
                    const liveTitle = await this.getLiveWindowTitle(precheckPid);
                    const windowTitle = liveTitle ?? await getWindowTitleFromSource(currentScene.id);

                    if (!this.titlesRoughlyMatch(yuzuGame.scene.name, windowTitle)) {
                        this.killAgent();
                        this.lastHookedPid = -1;
                        this.lastHookedGameId = "";
                        return;
                    }

                    await this.handleGame(emuProcessName, scriptPath, yuzuGame.id, 0, validateYuzuContext);
                } else {
                    // console.log(`AutoLauncher: No Yuzu script found for game ID: ${yuzuGame.id}`);
                }
                return;
            }

            // console.log("AutoLauncher: No matching Steam or Yuzu game for current scene.");
        } catch (error) {
            console.error("AutoLauncher poll error:", error);
        } finally {
            this.isPolling = false;
            if (!keepFastPolling && this.currentPollingInterval < this.defaultPollingInterval) {
                this.currentPollingInterval = Math.min(
                    this.defaultPollingInterval,
                    this.currentPollingInterval + this.backoffStep
                );
            }
            this.scheduleNextPoll(this.currentPollingInterval);
        }
    }

    private async handleGame(
        processName: string,
        scriptPath: string,
        gameId: string,
        delay: number = 0,
        validateContext?: () => Promise<boolean>
    ) {
        if (!processName || !scriptPath) return;

        const pid = await this.getPidByProcessName(processName);

        if (pid > 0) {
            // Re-hook if PID changed or if Game ID changed (different game on same process/emulator)
            if (pid !== this.lastHookedPid || gameId !== this.lastHookedGameId) {
                // Check if ANY Agent process is running (even ones we didn't spawn)
                const agentRunning = await this.isAgentAlreadyRunning();
                if (agentRunning && !this.agentProcess) {
                    if (!this.hasWarnedAboutExternalAgent) {
                        console.warn(`AutoLauncher: External Agent process detected. Please close all Agent instances before GSM can launch its own.`);
                        this.hasWarnedAboutExternalAgent = true;
                    }
                    return;
                }

                // Kill any previous agent
                this.killAgent();

                console.log(`AutoLauncher: Found target ${processName} (PID: ${pid}) for Game ID ${gameId}. Hooking...`);

                if (delay > 0) {
                    console.log(`AutoLauncher: Waiting ${delay}s before hooking...`);
                    await new Promise(resolve => setTimeout(resolve, delay * 1000));

                    // Re-check PID after delay
                    const currentPid = await this.getPidByProcessName(processName);
                    
                    // If PID changed (game restarted) or doesn't match the one we waited for, abort
                    if (currentPid !== pid) {
                        console.log(`AutoLauncher: Process ID changed during delay (Old: ${pid}, New: ${currentPid}). Aborting hook.`);
                        return;
                    }
                }

                if (validateContext) {
                    const stillValid = await validateContext();
                    if (!stillValid) {
                        console.log(`AutoLauncher: Context changed for Game ID ${gameId}; skipping hook and killing agent.`);
                        this.killAgent();
                        this.lastHookedPid = -1;
                        this.lastHookedGameId = "";
                        return;
                    }
                }

                this.launchAgent(pid, scriptPath);
                this.currentPollingInterval = this.defaultPollingInterval;
                this.lastHookedPid = pid;
                this.lastHookedGameId = gameId;
                this.hasWarnedAboutExternalAgent = false; // Reset flag on successful launch
            } else if (!this.agentProcess) {
                // Check if ANY Agent process is running (even ones we didn't spawn)
                const agentRunning = await this.isAgentAlreadyRunning();
                if (agentRunning) {
                    if (!this.hasWarnedAboutExternalAgent) {
                        console.warn(`AutoLauncher: External Agent process detected. Cannot relaunch agent. Please close all Agent instances first.`);
                        this.hasWarnedAboutExternalAgent = true;
                    }
                    return;
                }

                if (validateContext) {
                    const stillValid = await validateContext();
                    if (!stillValid) {
                        console.log(`AutoLauncher: Context changed for Game ID ${gameId}; skipping agent relaunch and killing agent.`);
                        this.killAgent();
                        this.lastHookedPid = -1;
                        this.lastHookedGameId = "";
                        return;
                    }
                }

                console.log(`AutoLauncher: Agent for ${processName} (PID: ${pid}) not running. Relaunching...`);
                this.launchAgent(pid, scriptPath);
                this.currentPollingInterval = this.defaultPollingInterval;
            }
        } else {
            // Process not running
            if (this.lastHookedPid !== -1 && this.lastHookedGameId === gameId) {
                console.log(`AutoLauncher: Game ${gameId} process ended. Cleaning up agent.`);
                this.killAgent();
                // Reset tracker if the tracked process is gone
                this.lastHookedPid = -1;
                this.lastHookedGameId = "";
            }
        }
    }

    private launchAgent(pid: number, scriptPath: string) {
        const command = `"${getAgentPath()}" --script="${scriptPath}" --pname=${pid}`;
        console.log(`AutoLauncher: Launching agent: ${command}`);
        const child = exec(command, (error) => {
            if (error) {
                console.error(`AutoLauncher: Error launching agent:`, error);
            }
        });
        this.agentProcess = child;
        child.on('exit', (code) => {
            console.log(`AutoLauncher: Agent process exited with code ${code}`);
            if (this.agentProcess === child) {
                this.agentProcess = null;
            }
        });
    }

    private titlesRoughlyMatch(sceneName: string, windowTitle?: string | null): boolean {
        if (!windowTitle) return false;

        const normalizedScene = this.normalizeTitle(sceneName);
        const normalizedTitle = this.normalizeTitle(windowTitle);

        if (!normalizedScene || !normalizedTitle) return false;

        // Direct partial containment check first for fast positive match
        if (normalizedTitle.includes(normalizedScene) || normalizedScene.includes(normalizedTitle)) {
            return true;
        }

        const sceneTokens = new Set(normalizedScene.split(' '));
        const titleTokens = new Set(normalizedTitle.split(' '));

        let overlap = 0;
        sceneTokens.forEach(token => {
            if (titleTokens.has(token)) {
                overlap += 1;
            }
        });

        // Require majority overlap on the smaller token set to allow loose partial matches
        const minSize = Math.min(sceneTokens.size, titleTokens.size);
        return minSize > 0 ? (overlap / minSize) >= 0.6 : false;
    }

    private normalizeTitle(value: string): string {
        return value
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private findYuzuScript(gameId: string): string | null {
        try {
            const scriptsPath = getAgentScriptsPath();
            if (!fs.existsSync(scriptsPath)) return null;

            const files = fs.readdirSync(scriptsPath);
            for (const file of files) {
                if (file.includes(gameId) && file.endsWith(".js")) {
                    return path.join(scriptsPath, file);
                }
            }
        } catch (e) {
            console.error("AutoLauncher: Error finding Yuzu script:", e);
        }
        return null;
    }
}

export const autoLauncher = new AutoLauncher();