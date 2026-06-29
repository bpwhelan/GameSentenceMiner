import {
    getExecutableNameFromSource,
    getCurrentScene,
    sceneHasVisibleOutput,
    getWindowTitleFromSource,
    ObsScene
} from './ui/obs.js';
import { getOCRRuntimeState, startManualOCR, startOCR, stopOCR } from './ui/ocr.js';
import { getOverlayRuntimeState, runOverlayWithSource, stopOverlay } from './ui/front.js';
import {
    getAgentPath,
    getAgentScriptsPath,
    getForceManualOcrAllProfiles,
    getIgnoreActiveSceneForOcr,
    getLaunchAgentMinimized,
    getLaunchLunaTranslatorMinimized,
    getLaunchTextractorMinimized,
    getLunaTranslatorPath,
    getObsOcrScenes,
    getSceneLaunchProfileForScene,
    getSteamGames,
    getTextractorPath32,
    getTextractorPath64,
    runtimeState,
    upsertSceneLaunchProfile
} from './store.js';
import type { SceneLaunchProfile, SceneOcrMode, SceneTextHookMode } from './store.js';
import { exec, ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
    isHighConfidenceScriptMatch,
    isSwitchEmulatorTarget,
    resolveSwitchAgentScript
} from './agent_script_resolver.js';
import type { SwitchScriptResolutionResult } from './agent_script_resolver.js';
import {
    getProfileFor,
    getRuntimeStatus,
    setTextHookUserStartListener,
    setTextHookUserStopListener,
    startHookSession,
    stopHookSession,
} from './ui/texthook.js';

type IntegratedTextHookEngine = "textractor" | "luna" | "agent";

export class AutoLauncher {
    private intervalId: NodeJS.Timeout | null = null;
    private lastHookedPid: number = -1;
    private lastHookedGameId: string = "";
    private readonly defaultPollingInterval: number = 5000;
    private readonly fastPollingInterval: number = 500;
    private readonly ocrPollingInterval: number = 5000;
    private readonly minLoopDelayMs: number = 500;
    private readonly backoffStep: number = 50;
    private currentPollingInterval: number = this.defaultPollingInterval;
    private isPolling: boolean = false;
    private agentProcess: ChildProcess | null = null;
    private hasWarnedAboutExternalAgent: boolean = false;
    private hasWarnedAboutMissingTextractor: boolean = false;
    private hasWarnedAboutMissingLuna: boolean = false;
    private activeOcrMode: SceneOcrMode = "none";
    private activeOcrSceneId: string = "";
    private expectedAutoLauncherOcrStop: boolean = false;
    private lastObservedAutoLauncherOcrRunning: boolean = false;
    private suppressedAutoOcrSceneId: string = "";
    private suppressedAutoOcrReason: string = "";
    private lastLauncherPollAt: number = 0;
    private lastOcrPollAt: number = 0;
    private lastTextHookStartFailureKey: string = "";
    private suppressedAutoTextHookSceneId: string = "";
    private suppressedAutoTextHookReason: string = "";
    private lastTextHookAutomationSceneId: string = "";
    private lastTextHookSuppressionSkipSceneId: string = "";

    constructor() {
        setTextHookUserStopListener(() => {
            void this.suppressTextHookAutoStartForCurrentScene("user-stopped");
        });
        setTextHookUserStartListener(() => {
            this.clearTextHookSuppression("user-started");
        });
    }

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
        if (this.intervalId) return;
        this.logInternal(
            `Starting AutoLauncher polling... (launcher=${this.defaultPollingInterval}ms, ocr=${this.ocrPollingInterval}ms)`
        );
        this.hasWarnedAboutExternalAgent = false;
        this.lastLauncherPollAt = 0;
        this.lastOcrPollAt = 0;
        this.scheduleNextPoll(0);
    }

    public stopPolling() {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
            this.intervalId = null;
        }
        this.logInternal("Stopped AutoLauncher polling.");
        this.resetAgentTracking();
        this.stopOcrAutomation();
        this.stopOverlayAutomation();
        this.expectedAutoLauncherOcrStop = false;
        this.lastObservedAutoLauncherOcrRunning = false;
        this.clearOcrSuppression("polling-stopped");
        this.clearTextHookSuppression("polling-stopped");
    }

    private scheduleNextPoll(delay: number) {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
        }
        this.intervalId = setTimeout(() => this.poll(), delay);
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
        this.stopAutoLauncherOwnedOcr("stop-ocr-automation");
        this.activeOcrMode = "none";
        this.activeOcrSceneId = "";
    }

    private stopOverlayAutomation() {
        const stopRequested = stopOverlay({ onlyIfSource: "auto-launcher" });
        if (stopRequested) {
            this.logInternal("AutoLauncher: Requested overlay stop.");
        }
    }

    private stopAutoLauncherOwnedOcr(reason: string) {
        const stopRequested = stopOCR({ onlyIfSource: "auto-launcher" });
        this.expectedAutoLauncherOcrStop = stopRequested;
        if (stopRequested) {
            this.logInternal(`AutoLauncher: Requested OCR stop (${reason}).`);
        }
    }

    private setOcrSuppression(sceneId: string, reason: string) {
        this.suppressedAutoOcrSceneId = sceneId;
        this.suppressedAutoOcrReason = reason;
    }

    private clearOcrSuppression(reason: string) {
        if (!this.suppressedAutoOcrSceneId) {
            return;
        }
        this.logInternal(
            `AutoLauncher: Clearing OCR auto-start suppression for scene ${this.suppressedAutoOcrSceneId} (${reason}).`
        );
        this.suppressedAutoOcrSceneId = "";
        this.suppressedAutoOcrReason = "";
    }

    private isAutoOcrSuppressedForScene(sceneId: string): boolean {
        return this.suppressedAutoOcrSceneId === sceneId;
    }

    private setTextHookSuppression(sceneId: string, reason: string) {
        if (!sceneId) {
            return;
        }
        this.suppressedAutoTextHookSceneId = sceneId;
        this.suppressedAutoTextHookReason = reason;
        this.lastTextHookSuppressionSkipSceneId = "";
        this.logInternal(
            `AutoLauncher: Text hook auto-start suppressed for scene ${sceneId} (${reason}).`
        );
    }

    private clearTextHookSuppression(reason: string) {
        if (!this.suppressedAutoTextHookSceneId) {
            return;
        }
        this.logInternal(
            `AutoLauncher: Clearing text hook auto-start suppression for scene ${this.suppressedAutoTextHookSceneId} (${reason}).`
        );
        this.suppressedAutoTextHookSceneId = "";
        this.suppressedAutoTextHookReason = "";
        this.lastTextHookSuppressionSkipSceneId = "";
    }

    private isAutoTextHookSuppressedForScene(sceneId: string): boolean {
        return this.suppressedAutoTextHookSceneId === sceneId;
    }

    private clearTextHookSuppressionIfSceneChanged(currentScene: ObsScene) {
        if (
            this.suppressedAutoTextHookSceneId &&
            this.suppressedAutoTextHookSceneId !== currentScene.id
        ) {
            this.clearTextHookSuppression("scene-changed");
        }
    }

    private async suppressTextHookAutoStartForCurrentScene(reason: string) {
        let sceneId = this.lastTextHookAutomationSceneId;
        try {
            const scene = await this.resolveCurrentScene();
            sceneId = scene?.id || sceneId;
        } catch {
            // Use the last polled scene if OBS is temporarily unavailable.
        }
        this.setTextHookSuppression(sceneId, reason);
    }

    private logSuppressedTextHookAutoStartOnce(currentScene: ObsScene) {
        if (this.lastTextHookSuppressionSkipSceneId === currentScene.id) {
            return;
        }
        this.lastTextHookSuppressionSkipSceneId = currentScene.id;
        this.logInternal(
            `AutoLauncher: Text hook auto-start suppressed for scene "${currentScene.name}" until manual start or scene change.`
        );
    }

    private stopOcrIfSceneChanged(currentScene: ObsScene) {
        if (
            this.suppressedAutoOcrSceneId &&
            this.suppressedAutoOcrSceneId !== currentScene.id
        ) {
            this.clearOcrSuppression("scene-changed");
        }

        if (this.activeOcrMode === "none" || !this.activeOcrSceneId) {
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
            this.stopAutoLauncherOwnedOcr("scene-changed");
        }

        this.activeOcrMode = "none";
        this.activeOcrSceneId = "";
    }

    private async applyOcrMode(mode: SceneOcrMode, scene: ObsScene) {
        const runtime = getOCRRuntimeState();
        const isAutoLauncherOwned =
            runtime.isRunning && runtime.source === "auto-launcher";
        const desiredRunMode = mode === "manual" ? "manual" : "auto";

        // If OCR is user-started, leave it alone regardless of scene OCR mode.
        if (runtime.isRunning && runtime.source !== "auto-launcher") {
            this.activeOcrMode = "none";
            this.activeOcrSceneId = "";
            return;
        }

        if (mode === "none") {
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
            isAutoLauncherOwned && runtime.mode !== desiredRunMode;
        if (
            isAutoLauncherOwned &&
            this.activeOcrMode === mode &&
            !shouldRestartForSceneChange &&
            !shouldRestartForModeMismatch
        ) {
            return;
        }

        if (isAutoLauncherOwned) {
            this.stopAutoLauncherOwnedOcr("restart-with-new-mode");
        }

        try {
            if (mode === "auto") {
                await startOCR({
                    scene,
                    promptForAreaSelection: false,
                    source: "auto-launcher",
                });
            } else {
                startManualOCR({ source: "auto-launcher" });
            }
        } catch (error) {
            this.errorInternal(
                `[AutoLauncher:OCR] start session FAILED scene="${scene.name}" (${scene.id}) mode="${mode}"`,
                error
            );
            throw error;
        }

        this.activeOcrMode = mode;
        this.activeOcrSceneId = scene.id;
    }

    private async resolveSceneExecutableName(scene: ObsScene): Promise<string | null> {
        try {
            const executableName = await getExecutableNameFromSource(scene.id);
            if (!executableName || executableName.trim().length === 0) {
                return null;
            }
            return executableName.trim();
        } catch {
            return null;
        }
    }

    private async isSceneSessionActive(scene: ObsScene): Promise<boolean> {
        const executableName = await this.resolveSceneExecutableName(scene);
        if (executableName) {
            return this.isProcessRunningByName(executableName);
        }

        const hasVisibleOutput = await sceneHasVisibleOutput(scene);
        return hasVisibleOutput === true;
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

    private resolveDesiredOcrMode(
        currentScene: ObsScene
    ): { mode: SceneOcrMode; forcedManual: boolean } {
        const sceneProfile = getSceneLaunchProfileForScene(currentScene);
        let ocrMode: SceneOcrMode = sceneProfile?.ocrMode ?? "none";

        // Legacy fallback for users who had OCR scenes configured before scene profiles existed.
        if (!sceneProfile && ocrMode === "none") {
            const legacyScenes = getObsOcrScenes();
            if (legacyScenes.includes(currentScene.name)) {
                ocrMode = "auto";
            }
        }

        // "Turn on manual OCR for all profiles": any scene not already set to auto
        // OCR falls back to manual OCR so background OCR utilities (screen cropper,
        // manual capture hotkeys, etc.) stay available even when not actively gaming.
        // Only scenes we promote from "none" should bypass the session-active gate;
        // scenes a user explicitly set to manual keep their existing gated behavior.
        const forcedManual = getForceManualOcrAllProfiles() && ocrMode === "none";
        if (forcedManual) {
            ocrMode = "manual";
        }

        return { mode: ocrMode, forcedManual };
    }

    private async runOcrAutomation(currentScene: ObsScene) {
        try {
            const runtimeBefore = getOCRRuntimeState();
            const wasAutoLauncherRunning =
                runtimeBefore.isRunning && runtimeBefore.source === "auto-launcher";

            if (
                this.lastObservedAutoLauncherOcrRunning &&
                !wasAutoLauncherRunning
            ) {
                if (!this.expectedAutoLauncherOcrStop) {
                    this.setOcrSuppression(
                        currentScene.id,
                        "manually-stopped-while-game-active"
                    );
                    this.logInternal(
                        `AutoLauncher: OCR auto-start suppressed for scene "${currentScene.name}" until game/session changes.`
                    );
                }
                this.expectedAutoLauncherOcrStop = false;
            }
            this.lastObservedAutoLauncherOcrRunning = wasAutoLauncherRunning;

            const ignoreActiveScene = getIgnoreActiveSceneForOcr();
            const { mode: ocrMode, forcedManual: forcedManualOcr } =
                this.resolveDesiredOcrMode(currentScene);

            // "Ignore active OBS scene for OCR": once OCR is running under
            // auto-launcher control, leave it running regardless of scene
            // changes (don't stop/restart it just because the active scene
            // switched). It keeps the area config of the scene it started with.
            //
            // Exception: a forced-manual fallback session ("Turn on manual OCR
            // for all profiles") must still defer to a scene whose Game
            // Automation profile actually wants auto OCR. Without this, manual
            // OCR started on a menu/idle scene gets pinned and never upgrades to
            // auto when we land on the game scene.
            if (ignoreActiveScene && wasAutoLauncherRunning) {
                const desiredRunMode = ocrMode === "manual" ? "manual" : "auto";
                const needsManualToAutoUpgrade =
                    runtimeBefore.mode === "manual" && desiredRunMode === "auto";
                if (!needsManualToAutoUpgrade) {
                    return;
                }
            }

            this.stopOcrIfSceneChanged(currentScene);

            if (ocrMode === "none") {
                if (this.isAutoOcrSuppressedForScene(currentScene.id)) {
                    this.clearOcrSuppression("scene-not-configured");
                }
                await this.applyOcrMode("none", currentScene);
                return;
            }

            const isSceneActive = await this.isSceneSessionActive(currentScene);
            if (!isSceneActive && !forcedManualOcr && !ignoreActiveScene) {
                if (this.isAutoOcrSuppressedForScene(currentScene.id)) {
                    this.clearOcrSuppression("scene-inactive");
                }
                const runtime = getOCRRuntimeState();
                if (runtime.isRunning && runtime.source === "auto-launcher") {
                    this.logInternal(
                        `AutoLauncher: Scene "${currentScene.name}" has no detectable active game/session. Stopping OCR automation.`
                    );
                }
                this.stopOcrAutomation();
                return;
            }

            if (this.isAutoOcrSuppressedForScene(currentScene.id)) {
                return;
            }

            await this.applyOcrMode(ocrMode, currentScene);
        } catch (error) {
            this.errorInternal('[AutoLauncher:OCR] poll error:', error);
        }
    }

    private async runOverlayAutomation(currentScene: ObsScene) {
        try {
            const sceneProfile = getSceneLaunchProfileForScene(currentScene);
            const shouldLaunchOverlay = sceneProfile?.launchOverlay === true;

            if (!shouldLaunchOverlay) {
                this.stopOverlayAutomation();
                return;
            }

            const isSceneActive = await this.isSceneSessionActive(currentScene);
            if (!isSceneActive) {
                this.stopOverlayAutomation();
                return;
            }

            const runtime = getOverlayRuntimeState();
            if (runtime.isRunning) {
                return;
            }

            await runOverlayWithSource("auto-launcher");
        } catch (error) {
            this.errorInternal('[AutoLauncher:Overlay] poll error:', error);
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

    private async getPreferredTextractorPath(
        gamePid: number,
    ): Promise<string | null> {
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
        launchDelaySeconds: number = 0,
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

    private resolveIntegratedTextHookEngine(
        exeName: string | null | undefined
    ): IntegratedTextHookEngine | null {
        if (!exeName) {
            return null;
        }

        const profile = getProfileFor(exeName);
        if (!profile || !profile.autoHook) {
            return null;
        }

        if (profile.engine === "agent") {
            return profile.agentScriptPath?.trim() ? "agent" : null;
        }

        if (!profile.hookId && !profile.hookFunction && !profile.manualHookCode) {
            return null;
        }

        return profile.engine;
    }

    private async handleIntegratedTextHookAutomation(
        exeName: string | null | undefined,
        engine: IntegratedTextHookEngine,
        launchDelaySeconds: number = 0
    ): Promise<void> {
        if (!exeName) {
            return;
        }

        const gamePid = await this.getPidByProcessName(exeName);
        if (gamePid <= 0) {
            return;
        }

        const currentStatus = getRuntimeStatus();
        if (currentStatus.running) {
            if (
                currentStatus.pid === gamePid &&
                currentStatus.engine === engine &&
                currentStatus.exeName.toLowerCase() === exeName.toLowerCase()
            ) {
                return;
            }

            // Same rule as OCR auto-start: never tear down a session the user
            // started manually. If a user attaches a different engine (e.g.
            // Luna while a Textractor profile is saved), leave it alone instead
            // of repeatedly killing it to re-attach the saved profile.
            if (currentStatus.source !== "auto-launcher") {
                return;
            }

            this.logInternal(
                `AutoLauncher: Stopping active text hook for ${currentStatus.exeName} before attaching ${engine} to ${exeName}.`
            );
            stopHookSession();
        }

        if (launchDelaySeconds > 0) {
            this.logInternal(
                `AutoLauncher: Waiting ${launchDelaySeconds.toFixed(1)}s before starting ${engine} text hook.`
            );
            await new Promise((resolve) => setTimeout(resolve, launchDelaySeconds * 1000));

            const currentPid = await this.getPidByProcessName(exeName);
            if (currentPid !== gamePid) {
                this.logInternal(
                    `AutoLauncher: Game process changed during ${engine} text hook delay (Old: ${gamePid}, New: ${currentPid}). Skipping attach.`
                );
                return;
            }
        }

        const result = await startHookSession({
            engine,
            exeName,
            pidOverride: gamePid,
            source: "auto-launcher",
        });
        const failureKey = `${engine}:${exeName}:${gamePid}:${result.error ?? "unknown"}`;

        if (!result.success) {
            if (this.lastTextHookStartFailureKey !== failureKey) {
                this.warnInternal(
                    `AutoLauncher: Failed to start ${engine} text hook for ${exeName} (PID: ${gamePid}): ${result.error ?? "unknown error"}`
                );
                this.lastTextHookStartFailureKey = failureKey;
            }
            return;
        }

        this.lastTextHookStartFailureKey = "";
        this.currentPollingInterval = this.defaultPollingInterval;
        this.logInternal(
            `AutoLauncher: Started ${engine} text hook for ${exeName} (PID: ${gamePid}).`
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

            // Nintendo Switch emulators (yuzu, ryujinx, ...) keep a single
            // process alive across games; the active game is identified by the
            // live window title, not the executable. While the emulator is
            // open, poll fast so the agent attaches as soon as a game's title
            // appears and detaches as soon as the title goes away (back to the
            // emulator menu). The validator re-checks the title every poll.
            if (this.isSwitchEmulatorExecutable(exeName)) {
                let keepFastPolling = false;
                const emuPid = await this.getPidByProcessName(exeName.trim());
                if (emuPid > 0) {
                    keepFastPolling = true;
                    this.currentPollingInterval = this.fastPollingInterval;
                }

                const validateContext = this.createSwitchContextValidator(
                    currentScene,
                    exeName,
                    currentScene.name
                );
                await this.handleGame(
                    exeName,
                    scriptPath,
                    profileKey,
                    launchDelaySeconds,
                    validateContext
                );
                return keepFastPolling;
            }

            await this.handleGame(
                exeName,
                scriptPath,
                profileKey,
                launchDelaySeconds
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

        if (this.isSwitchEmulatorExecutable(exeName)) {
            const emuProcessName = exeName.trim();
            const precheckPid = await this.getPidByProcessName(emuProcessName);
            if (precheckPid > 0) {
                keepFastPolling = true;
                this.currentPollingInterval = this.fastPollingInterval;
            }

            const windowTitle = await this.resolveSceneWindowTitle(
                currentScene,
                emuProcessName,
                precheckPid > 0 ? precheckPid : undefined
            );
            const resolution = resolveSwitchAgentScript({
                scriptsPath: getAgentScriptsPath(),
                processName: emuProcessName,
                windowTitle,
                sceneName: currentScene.name,
                explicitGameId: null,
            });
            const scriptPath = this.getAutoLaunchableSwitchScriptPath(resolution);
            if (scriptPath) {
                const validateSwitchContext = this.createSwitchContextValidator(
                    currentScene,
                    emuProcessName,
                    currentScene.name
                );

                if (precheckPid <= 0) {
                    this.resetAgentTracking();
                    return keepFastPolling;
                }

                if (!(await validateSwitchContext(precheckPid))) {
                    this.resetAgentTracking();
                    return keepFastPolling;
                }

                await this.handleGame(
                    emuProcessName,
                    scriptPath,
                    this.getSwitchGameTrackingId(scriptPath, resolution.titleId),
                    0,
                    validateSwitchContext
                );
            } else {
                this.resetAgentTracking();
            }

            return keepFastPolling;
        }

        this.resetAgentTracking();
        return keepFastPolling;
    }

    private isSwitchEmulatorExecutable(exeName: string | null | undefined): exeName is string {
        if (!exeName || exeName.trim().length === 0) {
            return false;
        }
        return isSwitchEmulatorTarget(exeName, null);
    }

    private getAutoLaunchableSwitchScriptPath(
        resolution: SwitchScriptResolutionResult
    ): string | null {
        if (!resolution.path || !resolution.isSwitchTarget) {
            return null;
        }

        if (
            resolution.reason === "matched_explicit_id" ||
            resolution.reason === "matched_title_id" ||
            resolution.reason === "matched_name"
        ) {
            return resolution.path;
        }

        if (resolution.reason !== "matched_fuzzy_name") {
            return null;
        }

        const selectedCandidate = resolution.candidates.find(
            (candidate) => candidate.path === resolution.path
        );
        if (!selectedCandidate) {
            return null;
        }

        return isHighConfidenceScriptMatch(selectedCandidate.score)
            ? resolution.path
            : null;
    }

    private getSwitchGameTrackingId(scriptPath: string, titleId: string | null): string {
        const normalizedTitleId = titleId?.trim();
        return `switch:${normalizedTitleId || scriptPath}`;
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

    private async resolveSceneWindowTitle(
        currentScene: ObsScene,
        processName: string,
        knownPid?: number
    ): Promise<string | null> {
        let windowTitle: string | null = null;
        const pid =
            typeof knownPid === "number"
                ? knownPid
                : await this.getPidByProcessName(processName);
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
        return windowTitle;
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

        const windowTitle = await this.resolveSceneWindowTitle(currentScene, exeName);
        const resolution = resolveSwitchAgentScript({
            scriptsPath: getAgentScriptsPath(),
            processName: exeName,
            windowTitle,
            sceneName: currentScene.name,
            explicitGameId: null,
        });
        const resolvedScriptPath = this.getAutoLaunchableSwitchScriptPath(resolution);

        if (!resolvedScriptPath) {
            return null;
        }

        if (sceneProfile.agentScriptPath?.trim() !== resolvedScriptPath) {
            upsertSceneLaunchProfile({
                sceneId: currentScene.id,
                sceneName: currentScene.name,
                textHookMode: sceneProfile.textHookMode,
                ocrMode: sceneProfile.ocrMode,
                launchOverlay: sceneProfile.launchOverlay,
                agentScriptPath: resolvedScriptPath,
                launchDelaySeconds: sceneProfile.launchDelaySeconds,
            });
        }

        return resolvedScriptPath;
    }

    private async runSavedTextHookProfileAutomation(
        currentScene: ObsScene,
        exeName: string | null | undefined
    ): Promise<void> {
        const savedProfileEngine = this.resolveIntegratedTextHookEngine(exeName);
        if (!savedProfileEngine) {
            return;
        }

        if (this.isAutoTextHookSuppressedForScene(currentScene.id)) {
            this.logSuppressedTextHookAutoStartOnce(currentScene);
            return;
        }

        await this.handleIntegratedTextHookAutomation(exeName, savedProfileEngine);
    }

    private async runLauncherTextHookAutomation(
        currentScene: ObsScene,
        exeName: string | null | undefined,
        sceneProfile: SceneLaunchProfile | null,
        textHookMode: SceneTextHookMode,
        launchDelaySeconds: number
    ): Promise<boolean> {
        if (!sceneProfile) {
            return this.handleAgentAutomation(currentScene, exeName, sceneProfile, true);
        }

        if (textHookMode === "agent") {
            return this.handleAgentAutomation(currentScene, exeName, sceneProfile, false);
        }

        this.resetAgentTracking();

        if (textHookMode === "textractor") {
            await this.handleTextractorAutomation(
                exeName,
                launchDelaySeconds,
            );
            return false;
        }

        if (textHookMode === "luna") {
            await this.handleLunaAutomation(exeName, launchDelaySeconds);
            return false;
        }

        return false;
    }

    private async runTextHookAutomation(currentScene: ObsScene): Promise<boolean> {
        let keepFastPolling = false;
        this.lastTextHookAutomationSceneId = currentScene.id;
        this.clearTextHookSuppressionIfSceneChanged(currentScene);

        try {
            const sceneProfile = getSceneLaunchProfileForScene(currentScene);
            const textHookMode: SceneTextHookMode = sceneProfile?.textHookMode ?? "none";
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

            await this.runSavedTextHookProfileAutomation(currentScene, exeName);
            keepFastPolling = await this.runLauncherTextHookAutomation(
                currentScene,
                exeName,
                sceneProfile,
                textHookMode,
                launchDelaySeconds
            );
        } catch (error) {
            this.errorInternal("AutoLauncher poll error:", error);
        }

        return keepFastPolling;
    }

    private computeNextLoopDelay(now: number): number {
        const timeUntilLauncherPoll = Math.max(
            this.minLoopDelayMs,
            this.currentPollingInterval - (now - this.lastLauncherPollAt)
        );
        const timeUntilOcrPoll = Math.max(
            this.minLoopDelayMs,
            this.ocrPollingInterval - (now - this.lastOcrPollAt)
        );
        return Math.min(timeUntilLauncherPoll, timeUntilOcrPoll);
    }

    private async poll() {
        if (this.isPolling) {
            this.scheduleNextPoll(this.minLoopDelayMs);
            return;
        }

        this.isPolling = true;
        const startTime = Date.now();
        let keepFastPolling = false;

        try {
            const currentScene = await this.resolveCurrentScene();
            if (!currentScene) {
                return;
            }

            if (startTime - this.lastLauncherPollAt >= this.currentPollingInterval) {
                keepFastPolling = await this.runTextHookAutomation(currentScene);
                this.lastLauncherPollAt = startTime;
            }

            if (startTime - this.lastOcrPollAt >= this.ocrPollingInterval) {
                await this.runOcrAutomation(currentScene);
                await this.runOverlayAutomation(currentScene);
                this.lastOcrPollAt = startTime;
            }
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
            const now = Date.now();
            this.scheduleNextPoll(this.computeNextLoopDelay(now));
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
            } else if (validateContext) {
                // Agent is already running for this PID/game. Switch emulators
                // keep the same process across games, so re-check the live
                // window title each poll and tear the agent down when the user
                // exits to the emulator menu or swaps games (title stops
                // matching). It re-attaches once a matching title reappears.
                const stillValid = await validateContext(pid);
                if (!stillValid) {
                    this.logInternal(
                        `AutoLauncher: Game ID ${gameId} no longer active (window title changed). Stopping agent.`
                    );
                    this.resetAgentTracking();
                }
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
