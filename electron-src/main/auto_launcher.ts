import {
    getExecutableNameFromSource,
    getCurrentScene,
    getWindowTitleFromSource,
    ObsScene
} from './ui/obs.js';
import { getOCRRuntimeState, startOCR, stopOCR } from './ui/ocr.js';
import {
    getAgentPath,
    getAgentScriptsPath,
    getLaunchAgentMinimized,
    getLaunchLunaTranslatorMinimized,
    getLaunchTextractorMinimized,
    getLunaTranslatorPath,
    getObsOcrScenes,
    getSceneLaunchProfileForScene,
    getSteamGames,
    getTextractorPath32,
    getTextractorPath64,
    getYuzuEmuPath,
    getYuzuGamesConfig,
    runtimeState,
    upsertSceneLaunchProfile
} from './store.js';
import type { SceneLaunchProfile, SceneOcrMode } from './store.js';
import { exec, ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { findAgentScriptById, resolveSwitchAgentScript } from './agent_script_resolver.js';

export class AutoLauncher {
    private intervalId: NodeJS.Timeout | null = null;
    private ocrIntervalId: NodeJS.Timeout | null = null;
    private lastHookedPid: number = -1;
    private lastHookedGameId: string = "";
    private readonly defaultPollingInterval: number = 5000;
    private readonly fastPollingInterval: number = 500;
    private readonly ocrPollingInterval: number = 750;
    private readonly backoffStep: number = 50;
    private currentPollingInterval: number = this.defaultPollingInterval;
    private isPolling: boolean = false;
    private isOcrPolling: boolean = false;
    private agentProcess: ChildProcess | null = null;
    private hasWarnedAboutExternalAgent: boolean = false;
    private hasWarnedAboutMissingTextractor: boolean = false;
    private hasWarnedAboutMissingLuna: boolean = false;
    private activeOcrMode: SceneOcrMode = "none";
    private activeOcrSceneId: string = "";

    private normalizeLaunchDelaySeconds(value: unknown): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return 0;
        }
        return Math.max(0, Math.min(300, value));
    }

    private formatLogArgument(arg: unknown): string {
        if (typeof arg === "string") {
            return arg;
        }
        if (arg instanceof Error) {
            return arg.stack ?? arg.message;
        }
        try {
            return JSON.stringify(arg);
        } catch {
            return String(arg);
        }
    }

    private writeTerminalOnly(stream: NodeJS.WriteStream, args: unknown[]) {
        const message = args.map((arg) => this.formatLogArgument(arg)).join(' ');
        stream.write(`${message}\n`);
    }

    private logInternal(...args: unknown[]) {
        this.writeTerminalOnly(process.stdout, args);
    }

    private warnInternal(...args: unknown[]) {
        this.writeTerminalOnly(process.stderr, args);
    }

    private errorInternal(...args: unknown[]) {
        this.writeTerminalOnly(process.stderr, args);
    }

    public startPolling() {
        if (this.intervalId && this.ocrIntervalId) return;
        this.logInternal(
            `Starting AutoLauncher polling... (launcher=${this.defaultPollingInterval}ms, ocr=${this.ocrPollingInterval}ms)`
        );
        this.hasWarnedAboutExternalAgent = false;
        this.scheduleNextPoll(0);
        this.scheduleNextOcrPoll(0);
    }

    public stopPolling() {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
            this.intervalId = null;
        }
        if (this.ocrIntervalId) {
            clearTimeout(this.ocrIntervalId);
            this.ocrIntervalId = null;
        }
        this.logInternal("Stopped AutoLauncher polling.");
        this.resetAgentTracking();
        this.stopOcrAutomation();
    }

    private scheduleNextPoll(delay: number) {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
        }
        this.intervalId = setTimeout(() => this.poll(), delay);
    }

    private scheduleNextOcrPoll(delay: number) {
        if (this.ocrIntervalId) {
            clearTimeout(this.ocrIntervalId);
        }
        this.ocrIntervalId = setTimeout(() => this.pollOcrOnly(), delay);
    }

    private killAgent() {
        if (this.agentProcess) {
            this.logInternal("AutoLauncher: Killing agent process.");
            this.agentProcess.kill();
            this.agentProcess = null;
        }
    }

    private resetAgentTracking() {
        this.killAgent();
        this.lastHookedPid = -1;
        this.lastHookedGameId = "";
    }

    private stopOcrAutomation() {
        stopOCR({ onlyIfSource: "auto-launcher" });
        this.activeOcrMode = "none";
        this.activeOcrSceneId = "";
    }

    private stopOcrIfSceneChanged(currentScene: ObsScene) {
        if (this.activeOcrMode !== "auto" || !this.activeOcrSceneId) {
            return;
        }

        if (this.activeOcrSceneId === currentScene.id) {
            return;
        }

        const runtime = getOCRRuntimeState();
        if (runtime.isRunning && runtime.source === "auto-launcher") {
            this.logInternal(
                `AutoLauncher: Scene changed (${this.activeOcrSceneId} -> ${currentScene.id}). Stopping OCR before applying new scene mode.`
            );
            stopOCR({ onlyIfSource: "auto-launcher" });
        }

        this.activeOcrMode = "none";
        this.activeOcrSceneId = "";
    }

    private async applyOcrMode(mode: SceneOcrMode, scene: ObsScene) {
        const runtime = getOCRRuntimeState();
        const isAutoLauncherOwned =
            runtime.isRunning && runtime.source === "auto-launcher";

        // If OCR is user-started, leave it alone regardless of scene OCR mode.
        if (runtime.isRunning && runtime.source !== "auto-launcher") {
            this.activeOcrMode = "none";
            this.activeOcrSceneId = "";
            return;
        }

        // For "none" and "manual", only stop OCR if AutoLauncher started it.
        // Manual mode is user-driven; AutoLauncher does not start manual OCR.
        if (mode !== "auto") {
            if (isAutoLauncherOwned) {
                stopOCR({ onlyIfSource: "auto-launcher" });
            }
            this.activeOcrMode = "none";
            this.activeOcrSceneId = "";
            return;
        }

        const shouldRestartForSceneChange =
            isAutoLauncherOwned && this.activeOcrSceneId !== scene.id;
        const shouldRestartForModeMismatch =
            isAutoLauncherOwned && runtime.mode !== "auto";
        if (
            isAutoLauncherOwned &&
            this.activeOcrMode === "auto" &&
            !shouldRestartForSceneChange &&
            !shouldRestartForModeMismatch
        ) {
            return;
        }

        if (isAutoLauncherOwned) {
            stopOCR({ onlyIfSource: "auto-launcher" });
        }

        try {
            await startOCR({
                scene,
                promptForAreaSelection: false,
                source: "auto-launcher",
            });
        } catch (error) {
            this.errorInternal(
                `[AutoLauncher:OCR] startOCR FAILED scene="${scene.name}" (${scene.id})`,
                error
            );
            throw error;
        }

        this.activeOcrMode = "auto";
        this.activeOcrSceneId = scene.id;
    }

    private toObsScene(value: unknown): ObsScene | null {
        if (!value || typeof value !== "object") {
            return null;
        }
        const scene = value as Partial<ObsScene>;
        if (typeof scene.id !== "string" || typeof scene.name !== "string") {
            return null;
        }
        return { id: scene.id, name: scene.name };
    }

    private async resolveCurrentScene(): Promise<ObsScene | null> {
        try {
            return await getCurrentScene();
        } catch (error) {
            const cached = this.toObsScene(runtimeState.get('obs.activeScene'));
            if (cached) return cached;
            this.warnInternal('AutoLauncher: Unable to resolve current OBS scene.', error);
            return null;
        }
    }

    private async pollOcrOnly() {
        if (this.isOcrPolling) {
            this.scheduleNextOcrPoll(this.ocrPollingInterval);
            return;
        }
        this.isOcrPolling = true;
        try {
            const currentScene = await this.resolveCurrentScene();
            if (!currentScene) return;

            this.stopOcrIfSceneChanged(currentScene);

            const sceneProfile = getSceneLaunchProfileForScene(currentScene);
            let ocrMode: SceneOcrMode = sceneProfile?.ocrMode ?? "none";

            // Legacy fallback for users who had OCR scenes configured before scene profiles existed.
            if (!sceneProfile && ocrMode === "none") {
                const legacyScenes = getObsOcrScenes();
                if (legacyScenes.includes(currentScene.name)) {
                    ocrMode = "auto";
                }
            }

            await this.applyOcrMode(ocrMode, currentScene);
        } catch (error) {
            this.errorInternal('[AutoLauncher:OCR] poll error:', error);
        } finally {
            this.isOcrPolling = false;
            this.scheduleNextOcrPoll(this.ocrPollingInterval);
        }
    }

    // Check if ANY Agent process is running on the system, not just the one GSM spawned
    private async isAgentAlreadyRunning(): Promise<boolean> {
        return new Promise((resolve) => {
            if (process.platform !== "win32") {
                exec('pgrep -x Agent', (error, stdout) => {
                    resolve(!error && stdout.trim().length > 0);
                });
                return;
            }

            const agentPath = getAgentPath();
            const agentExeName = agentPath ? path.basename(agentPath) : 'Agent.exe';
            const command = `tasklist /FI "IMAGENAME eq ${agentExeName}" /FO CSV /NH`;
            exec(command, (error, stdout) => {
                if (error || stdout.trim().toLowerCase().includes("no tasks are running")) {
                    resolve(false);
                    return;
                }

                const lines = stdout.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
                resolve(lines.length > 0);
            });
        });
    }

    private async isProcessRunningByName(processName: string): Promise<boolean> {
        if (!processName) {
            return false;
        }

        return new Promise((resolve) => {
            if (process.platform === "win32") {
                const command = `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`;
                exec(command, (error, stdout) => {
                    if (error || stdout.trim().toLowerCase().includes("no tasks are running")) {
                        resolve(false);
                        return;
                    }

                    const lines = stdout.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
                    resolve(lines.length > 0);
                });
                return;
            }

            const nameWithoutExtension = processName.replace(/\.exe$/i, '');
            exec(`pgrep -x "${nameWithoutExtension}"`, (error, stdout) => {
                resolve(!error && stdout.trim().length > 0);
            });
        });
    }

    private async getProcessExecutablePath(pid: number): Promise<string | null> {
        return new Promise((resolve) => {
            if (process.platform !== "win32" || pid <= 0) {
                resolve(null);
                return;
            }

            const cmd = `powershell -NoLogo -NoProfile -Command "${'$'}p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (${'$'}p -and ${'$'}p.Path) { ${'$'}p.Path }"`;
            exec(cmd, { windowsHide: true }, (err, stdout) => {
                if (err) {
                    resolve(null);
                    return;
                }

                const executablePath = stdout.trim();
                resolve(executablePath.length > 0 ? executablePath : null);
            });
        });
    }

    private getPortableExecutableBitness(executablePath: string): "x86" | "x64" | "unknown" {
        let fd: number | null = null;
        try {
            fd = fs.openSync(executablePath, 'r');
            const dosHeader = Buffer.alloc(64);
            fs.readSync(fd, dosHeader, 0, 64, 0);

            const mzSignature = dosHeader.readUInt16LE(0);
            if (mzSignature !== 0x5a4d) {
                return "unknown";
            }

            const peOffset = dosHeader.readUInt32LE(0x3c);
            const peHeader = Buffer.alloc(6);
            fs.readSync(fd, peHeader, 0, 6, peOffset);

            const signature = peHeader.toString('ascii', 0, 4);
            if (signature !== 'PE\u0000\u0000') {
                return "unknown";
            }

            const machine = peHeader.readUInt16LE(4);
            if (machine === 0x14c) {
                return "x86";
            }
            if (machine === 0x8664) {
                return "x64";
            }
            return "unknown";
        } catch {
            return "unknown";
        } finally {
            if (fd !== null) {
                fs.closeSync(fd);
            }
        }
    }

    private deriveTextractorSiblingPath(basePath: string, targetBitness: "x86" | "x64"): string | null {
        if (!basePath) {
            return null;
        }

        const folderToken = targetBitness === "x64" ? "x64" : "x86";
        const numericToken = targetBitness === "x64" ? "64" : "32";
        const candidates = [
            basePath.replace(/([\\/])(x64|x86)([\\/])/i, `$1${folderToken}$3`),
            basePath.replace(/([\\/])(64|32)(-?bit)?([\\/])/i, `$1${numericToken}$4`),
            basePath.replace(/(x64|x86)/i, folderToken),
            basePath.replace(/(64|32)(-?bit)?/i, numericToken),
        ];

        for (const candidate of candidates) {
            if (candidate !== basePath && fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    private async getPreferredTextractorPath(gamePid: number): Promise<string | null> {
        const configured64 = getTextractorPath64().trim();
        const configured32 = getTextractorPath32().trim();

        const candidates: string[] = [];
        const addCandidate = (value: string | null | undefined) => {
            if (!value) {
                return;
            }
            if (!fs.existsSync(value)) {
                return;
            }
            if (!candidates.includes(value)) {
                candidates.push(value);
            }
        };

        const gamePath = await this.getProcessExecutablePath(gamePid);
        const gameBitness = gamePath ? this.getPortableExecutableBitness(gamePath) : "unknown";

        if (gameBitness === "x86") {
            addCandidate(configured32);
            addCandidate(this.deriveTextractorSiblingPath(configured64, "x86"));
            addCandidate(configured64);
        } else if (gameBitness === "x64") {
            addCandidate(configured64);
            addCandidate(this.deriveTextractorSiblingPath(configured32, "x64"));
            addCandidate(configured32);
        } else {
            addCandidate(configured64);
            addCandidate(configured32);
        }

        return candidates.length > 0 ? candidates[0] : null;
    }

    private launchDetachedExecutable(
        executablePath: string,
        label: string,
        windowsHide: boolean = false
    ): boolean {
        if (!executablePath || !fs.existsSync(executablePath)) {
            return false;
        }

        try {
            const child = spawn(executablePath, [], {
                cwd: path.dirname(executablePath),
                detached: true,
                stdio: 'ignore',
                windowsHide,
            });
            child.unref();
            this.logInternal(`AutoLauncher: Launched ${label}: ${executablePath}`);
            return true;
        } catch (error) {
            this.errorInternal(`AutoLauncher: Failed to launch ${label}:`, error);
            return false;
        }
    }

    private async handleTextractorAutomation(
        exeName: string | null | undefined,
        launchDelaySeconds: number = 0
    ): Promise<void> {
        if (!exeName) {
            return;
        }

        const gamePid = await this.getPidByProcessName(exeName);
        if (gamePid <= 0) {
            return;
        }

        const textractorPath = await this.getPreferredTextractorPath(gamePid);
        if (!textractorPath) {
            if (!this.hasWarnedAboutMissingTextractor) {
                this.warnInternal(
                    'AutoLauncher: Textractor path is not configured. Set Textractor 64-bit/32-bit path in Game Settings.'
                );
                this.hasWarnedAboutMissingTextractor = true;
            }
            return;
        }

        this.hasWarnedAboutMissingTextractor = false;

        const textractorExeName = path.basename(textractorPath);
        const alreadyRunning = await this.isProcessRunningByName(textractorExeName);
        if (alreadyRunning) {
            return;
        }

        if (launchDelaySeconds > 0) {
            this.logInternal(
                `AutoLauncher: Waiting ${launchDelaySeconds.toFixed(1)}s before launching Textractor.`
            );
            await new Promise((resolve) => setTimeout(resolve, launchDelaySeconds * 1000));

            const currentPid = await this.getPidByProcessName(exeName);
            if (currentPid !== gamePid) {
                this.logInternal(
                    `AutoLauncher: Game process changed during Textractor delay (Old: ${gamePid}, New: ${currentPid}). Skipping launch.`
                );
                return;
            }
        }

        this.launchDetachedExecutable(
            textractorPath,
            'Textractor',
            getLaunchTextractorMinimized()
        );
    }

    private async handleLunaAutomation(
        exeName: string | null | undefined,
        launchDelaySeconds: number = 0
    ): Promise<void> {
        if (!exeName) {
            return;
        }

        const gamePid = await this.getPidByProcessName(exeName);
        if (gamePid <= 0) {
            return;
        }

        const lunaPath = getLunaTranslatorPath().trim();
        if (!lunaPath || !fs.existsSync(lunaPath)) {
            if (!this.hasWarnedAboutMissingLuna) {
                this.warnInternal(
                    'AutoLauncher: LunaTranslator path is not configured. Set it in Game Settings.'
                );
                this.hasWarnedAboutMissingLuna = true;
            }
            return;
        }

        this.hasWarnedAboutMissingLuna = false;

        const lunaExeName = path.basename(lunaPath);
        const alreadyRunning = await this.isProcessRunningByName(lunaExeName);
        if (alreadyRunning) {
            return;
        }

        if (launchDelaySeconds > 0) {
            this.logInternal(
                `AutoLauncher: Waiting ${launchDelaySeconds.toFixed(1)}s before launching LunaTranslator.`
            );
            await new Promise((resolve) => setTimeout(resolve, launchDelaySeconds * 1000));

            const currentPid = await this.getPidByProcessName(exeName);
            if (currentPid !== gamePid) {
                this.logInternal(
                    `AutoLauncher: Game process changed during LunaTranslator delay (Old: ${gamePid}, New: ${currentPid}). Skipping launch.`
                );
                return;
            }
        }

        this.launchDetachedExecutable(
            lunaPath,
            'LunaTranslator',
            getLaunchLunaTranslatorMinimized()
        );
    }

    // On Windows, fetch the live window title for a PID using PowerShell (MainWindowTitle).
    // Returns null if unavailable or on non-Windows platforms.
    private async getLiveWindowTitle(pid: number): Promise<string | null> {
        return new Promise((resolve) => {
            if (process.platform !== "win32" || pid <= 0) return resolve(null);

            const cmd = `powershell -NoLogo -NoProfile -Command "${'$'}p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (${'$'}p -and ${'$'}p.MainWindowTitle) { ${'$'}p.MainWindowTitle }"`;
            exec(cmd, { windowsHide: true }, (err, stdout) => {
                if (err) return resolve(null);
                const title = stdout.trim();
                resolve(title.length > 0 ? title : null);
            });
        });
    }

    private async getPidByProcessName(processName: string): Promise<number> {
        return new Promise((resolve) => {
            let command: string;

            if (process.platform === "win32") {
                command = `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`;
            } else {
                command = `pgrep ${processName}`;
            }

            const startTime = Date.now();
            const retryInterval = 1000;
            const timeout = 5000;

            const tryGetPid = () => {
                exec(command, (error, stdout) => {
                    if (error) {
                        if (Date.now() - startTime >= timeout) {
                            resolve(-1);
                        } else {
                            setTimeout(tryGetPid, retryInterval);
                        }
                        return;
                    }

                    interface ProcessCandidate {
                        pid: number;
                        memory: number;
                    }

                    const candidates: ProcessCandidate[] = [];
                    const lines = stdout.trim().split(/\r?\n/);

                    lines.forEach((line) => {
                        if (process.platform === "win32") {
                            const match = line.match(/"([^"]+)",\s*"(\d+)",\s*"[^"]*",\s*"[^"]*",\s*"([^"]+)"/);
                            if (!match) {
                                return;
                            }

                            const pid = parseInt(match[2], 10);
                            const memStr = match[3].replace(/[^\d]/g, '');
                            const memory = parseInt(memStr, 10);

                            if (!isNaN(pid) && memory > 20000) {
                                candidates.push({ pid, memory: isNaN(memory) ? 0 : memory });
                            }
                            return;
                        }

                        const pid = parseInt(line.trim(), 10);
                        if (!isNaN(pid)) {
                            candidates.push({ pid, memory: 0 });
                        }
                    });

                    if (candidates.length > 0) {
                        candidates.sort((a, b) => b.memory - a.memory);
                        resolve(candidates[0].pid);
                        return;
                    }

                    if (Date.now() - startTime >= timeout) {
                        resolve(-1);
                    } else {
                        setTimeout(tryGetPid, retryInterval);
                    }
                });
            };

            tryGetPid();
        });
    }

    private async handleAgentAutomation(
        currentScene: ObsScene,
        exeName: string | null | undefined,
        sceneProfile: SceneLaunchProfile | null,
        allowLegacyFallback: boolean
    ): Promise<boolean> {
        if (sceneProfile) {
            if (!exeName) {
                this.resetAgentTracking();
                return false;
            }

            const scriptPath = await this.resolveSceneAgentScript(
                currentScene,
                exeName,
                sceneProfile
            );
            if (!scriptPath) {
                this.resetAgentTracking();
                return false;
            }

            const profileKey = sceneProfile.sceneId?.trim() || currentScene.id;
            const launchDelaySeconds = this.normalizeLaunchDelaySeconds(
                sceneProfile.launchDelaySeconds
            );
            const switchGame = this.getSwitchGameForScene(currentScene);
            const validateContext =
                switchGame?.scene?.name
                    ? this.createSwitchContextValidator(
                        currentScene,
                        exeName,
                        switchGame.scene.name
                    )
                    : undefined;

            await this.handleGame(
                exeName,
                scriptPath,
                profileKey,
                launchDelaySeconds,
                validateContext
            );
            return false;
        }

        if (!allowLegacyFallback) {
            this.resetAgentTracking();
            return false;
        }

        let keepFastPolling = false;

        const steamGame = getSteamGames().find((game) => game.processName === exeName);
        if (steamGame) {
            const shouldRunAgent = Boolean(steamGame.runAgent);
            if (!shouldRunAgent) {
                this.resetAgentTracking();
                return false;
            }

            const targetProcess = steamGame.processName || exeName;
            if (targetProcess) {
                await this.handleGame(targetProcess, steamGame.script, String(steamGame.id), steamGame.agentDelay);
            }
            return false;
        }

        const yuzuGame = this.getSwitchGameForScene(currentScene);
        if (yuzuGame) {
            const emuProcessName = exeName || path.basename(getYuzuEmuPath());
            if (!emuProcessName) {
                this.resetAgentTracking();
                return false;
            }

            const precheckPid = await this.getPidByProcessName(emuProcessName);
            if (precheckPid > 0) {
                keepFastPolling = true;
                this.currentPollingInterval = this.fastPollingInterval;
            }

            const scriptPath = findAgentScriptById(getAgentScriptsPath(), yuzuGame.id);
            if (scriptPath) {
                const validateYuzuContext = this.createSwitchContextValidator(
                    currentScene,
                    emuProcessName,
                    yuzuGame.scene.name
                );

                if (precheckPid <= 0) {
                    this.resetAgentTracking();
                    return keepFastPolling;
                }

                if (!(await validateYuzuContext(precheckPid))) {
                    this.resetAgentTracking();
                    return keepFastPolling;
                }

                await this.handleGame(emuProcessName, scriptPath, yuzuGame.id, 0, validateYuzuContext);
            }

            return keepFastPolling;
        }

        this.resetAgentTracking();
        return keepFastPolling;
    }

    private getSwitchGameForScene(currentScene: ObsScene) {
        return (
            getYuzuGamesConfig().find((game) => {
                if (!game.scene) {
                    return false;
                }
                if (game.scene.id === currentScene.id) {
                    return true;
                }
                return game.scene.name === currentScene.name;
            }) ?? null
        );
    }

    private createSwitchContextValidator(
        expectedScene: ObsScene,
        processName: string,
        expectedTitle: string
    ): (pid: number) => Promise<boolean> {
        return async (pid: number) => {
            const scene = await this.resolveCurrentScene();
            if (!scene || scene.id !== expectedScene.id) {
                return false;
            }

            const liveTitle = await this.getLiveWindowTitle(pid);
            if (!liveTitle) {
                this.logInternal(
                    `AutoLauncher: Could not read live window title for ${processName} (PID: ${pid}); skipping hook.`
                );
                return false;
            }

            const matches = this.titlesRoughlyMatch(expectedTitle, liveTitle);
            if (!matches) {
                this.logInternal(
                    `AutoLauncher: Switch title mismatch for ${processName}. Expected "${expectedTitle}", got "${liveTitle}".`
                );
            }
            return matches;
        };
    }

    private async resolveSceneAgentScript(
        currentScene: ObsScene,
        exeName: string,
        sceneProfile: SceneLaunchProfile
    ): Promise<string | null> {
        const configuredScriptPath = sceneProfile.agentScriptPath?.trim() ?? "";
        if (configuredScriptPath.length > 0) {
            if (fs.existsSync(configuredScriptPath)) {
                return configuredScriptPath;
            }
        }

        let windowTitle: string | null = null;
        const pid = await this.getPidByProcessName(exeName);
        if (pid > 0) {
            windowTitle = await this.getLiveWindowTitle(pid);
        }
        if (!windowTitle) {
            try {
                windowTitle = (await getWindowTitleFromSource(currentScene.id)) ?? null;
            } catch {
                windowTitle = null;
            }
        }

        const yuzuGame = getYuzuGamesConfig().find((game) => {
            if (!game.scene) {
                return false;
            }
            if (game.scene.id === currentScene.id) {
                return true;
            }
            return game.scene.name === currentScene.name;
        });

        // Do not auto-fill/persist scripts from fuzzy or name-based matches.
        // Only allow automatic script selection when a Yuzu scene has an exact ID match.
        if (!yuzuGame?.id) {
            return null;
        }

        const resolution = resolveSwitchAgentScript({
            scriptsPath: getAgentScriptsPath(),
            processName: exeName,
            windowTitle,
            sceneName: currentScene.name,
            explicitGameId: yuzuGame.id,
        });

        let resolvedScriptPath: string | null = null;
        if (resolution.reason === "matched_explicit_id" && resolution.path) {
            resolvedScriptPath = resolution.path;
        } else {
            resolvedScriptPath = findAgentScriptById(getAgentScriptsPath(), yuzuGame.id);
        }

        if (!resolvedScriptPath) {
            return null;
        }

        if (sceneProfile.agentScriptPath?.trim() !== resolvedScriptPath) {
            upsertSceneLaunchProfile({
                sceneId: currentScene.id,
                sceneName: currentScene.name,
                textHookMode: sceneProfile.textHookMode,
                ocrMode: sceneProfile.ocrMode,
                agentScriptPath: resolvedScriptPath,
                launchDelaySeconds: sceneProfile.launchDelaySeconds,
            });
        }

        return resolvedScriptPath;
    }

    private async poll() {
        if (this.isPolling) return;
        this.isPolling = true;
        let keepFastPolling = false;

        try {
            const currentScene = await getCurrentScene();
            if (!currentScene) {
                return;
            }

            const sceneProfile = getSceneLaunchProfileForScene(currentScene);
            const textHookMode = sceneProfile?.textHookMode ?? "none";
            const launchDelaySeconds = this.normalizeLaunchDelaySeconds(
                sceneProfile?.launchDelaySeconds
            );

            let exeName: string | null | undefined = null;
            try {
                exeName = await getExecutableNameFromSource(currentScene.id);
            } catch (error) {
                // OCR automation should not depend on executable detection.
                this.warnInternal(
                    `AutoLauncher: Could not resolve executable for scene "${currentScene.name}". Text hook launchers may be skipped.`,
                    error
                );
            }

            if (sceneProfile && textHookMode !== "agent") {
                this.resetAgentTracking();
                if (textHookMode === "textractor") {
                    await this.handleTextractorAutomation(exeName, launchDelaySeconds);
                } else if (textHookMode === "luna") {
                    await this.handleLunaAutomation(exeName, launchDelaySeconds);
                }
                return;
            }

            keepFastPolling = await this.handleAgentAutomation(
                currentScene,
                exeName,
                sceneProfile,
                !sceneProfile
            );
        } catch (error) {
            this.errorInternal("AutoLauncher poll error:", error);
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
        validateContext?: (pid: number) => Promise<boolean>
    ) {
        if (!processName || !scriptPath) return;

        const pid = await this.getPidByProcessName(processName);

        if (pid > 0) {
            if (pid !== this.lastHookedPid || gameId !== this.lastHookedGameId) {
                const agentRunning = await this.isAgentAlreadyRunning();
                if (agentRunning && !this.agentProcess) {
                    if (!this.hasWarnedAboutExternalAgent) {
                        this.warnInternal(
                            'AutoLauncher: External Agent process detected. Please close all Agent instances before GSM can launch its own.'
                        );
                        this.hasWarnedAboutExternalAgent = true;
                    }
                    return;
                }

                this.killAgent();

                this.logInternal(`AutoLauncher: Found target ${processName} (PID: ${pid}) for Game ID ${gameId}. Hooking...`);

                if (delay > 0) {
                    this.logInternal(`AutoLauncher: Waiting ${delay}s before hooking...`);
                    await new Promise((resolve) => setTimeout(resolve, delay * 1000));

                    const currentPid = await this.getPidByProcessName(processName);
                    if (currentPid !== pid) {
                        this.logInternal(
                            `AutoLauncher: Process ID changed during delay (Old: ${pid}, New: ${currentPid}). Aborting hook.`
                        );
                        return;
                    }
                }

                if (validateContext) {
                    const stillValid = await validateContext(pid);
                    if (!stillValid) {
                        this.logInternal(`AutoLauncher: Context changed for Game ID ${gameId}; skipping hook.`);
                        this.resetAgentTracking();
                        return;
                    }
                }

                this.launchAgent(pid, scriptPath);
                this.currentPollingInterval = this.defaultPollingInterval;
                this.lastHookedPid = pid;
                this.lastHookedGameId = gameId;
                this.hasWarnedAboutExternalAgent = false;
            } else if (!this.agentProcess) {
                const agentRunning = await this.isAgentAlreadyRunning();
                if (agentRunning) {
                    if (!this.hasWarnedAboutExternalAgent) {
                        this.warnInternal(
                            'AutoLauncher: External Agent process detected. Cannot relaunch agent. Please close all Agent instances first.'
                        );
                        this.hasWarnedAboutExternalAgent = true;
                    }
                    return;
                }

                if (validateContext) {
                    const stillValid = await validateContext(pid);
                    if (!stillValid) {
                        this.logInternal(`AutoLauncher: Context changed for Game ID ${gameId}; skipping agent relaunch.`);
                        this.resetAgentTracking();
                        return;
                    }
                }

                this.logInternal(`AutoLauncher: Agent for ${processName} (PID: ${pid}) not running. Relaunching...`);
                this.launchAgent(pid, scriptPath);
                this.currentPollingInterval = this.defaultPollingInterval;
            }
            return;
        }

        if (this.lastHookedPid !== -1 && this.lastHookedGameId === gameId) {
            this.logInternal(`AutoLauncher: Game ${gameId} process ended. Cleaning up agent.`);
            this.resetAgentTracking();
        }
    }

    private launchAgent(pid: number, scriptPath: string) {
        const command = `"${getAgentPath()}" --script="${scriptPath}" --pname=${pid}`;
        this.logInternal(`AutoLauncher: Launching agent: ${command}`);
        const child = exec(command, { windowsHide: getLaunchAgentMinimized() }, (error) => {
            if (error) {
                this.errorInternal('AutoLauncher: Error launching agent:', error);
            }
        });
        this.agentProcess = child;
        child.on('exit', (code) => {
            this.logInternal(`AutoLauncher: Agent process exited with code ${code}`);
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

        if (normalizedTitle.includes(normalizedScene) || normalizedScene.includes(normalizedTitle)) {
            return true;
        }

        const sceneTokens = new Set(normalizedScene.split(' '));
        const titleTokens = new Set(normalizedTitle.split(' '));

        let overlap = 0;
        sceneTokens.forEach((token) => {
            if (titleTokens.has(token)) {
                overlap += 1;
            }
        });

        const minSize = Math.min(sceneTokens.size, titleTokens.size);
        return minSize > 0 ? overlap / minSize >= 0.6 : false;
    }

    private normalizeTitle(value: string): string {
        return value
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

export const autoLauncher = new AutoLauncher();
