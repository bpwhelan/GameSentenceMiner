import Store from "electron-store";
import { SteamGame } from "./ui/steam.js";
import {ObsScene} from "./ui/obs.js";
import { BrowserWindow } from "electron";
import * as os from "os";
import path from "path";
import { findAgentScriptById } from "./agent_script_resolver.js";


interface YuzuConfig {
    emuPath: string;
    romsPath: string;
    launchGameOnStart: string;
    lastGameLaunched: string;
    games: YuzuGame[];
}

export interface YuzuGame {
    name: string;
    id: string;
    scene: ObsScene;
}

export interface VN {
    path: string;
    scene: ObsScene;
}


interface VNConfig {
    vns: VN[];
    textractorPath: string;
    launchVNOnStart: string;
    lastVNLaunched: string;
}

interface SteamConfig {
    steamPath: string;
    steamGames: SteamGame[];
    launchSteamOnStart: number;
    lastGameLaunched: number;
}

interface OCRConfig {
    twoPassOCR: boolean;
    optimize_second_scan: boolean;
    ocr1: string;
    ocr2: string;
    scanRate: number;
    language: string;
    ocr_screenshots: boolean;
    furigana_filter_sensitivity: number;
    manualOcrHotkey: string;
    areaSelectOcrHotkey: string;
    globalPauseHotkey: string;
    sendToClipboard: boolean;
    keep_newline: boolean;
    processPriority: 'low' | 'below_normal' | 'normal' | 'above_normal' | 'high';
    advancedMode?: boolean;
    scanRate_basic?: number;
    ocr1_advanced?: string;
    ocr2_advanced?: string;
    scanRate_advanced?: number;
}

export enum HookableGameType {
    Steam = "steam",
    VN = "vn",
    Yuzu = "yuzu",
    None = "none"
}

export type SceneTextHookMode = "none" | "agent" | "textractor" | "luna";
export type SceneOcrMode = "none" | "auto" | "manual";

export interface SceneLaunchProfile {
    sceneId?: string;
    sceneName: string;
    textHookMode: SceneTextHookMode;
    ocrMode: SceneOcrMode;
    agentScriptPath: string;
    launchDelaySeconds: number;
}

export interface LaunchableGame {
    name: string;
    id: string;
    type: HookableGameType;
    isHeader?: boolean; // Used to indicate if this is a header for grouping games
    scene?: ObsScene; // OBS scene name for the game
    agentDelay?: number; // Delay before starting agent scripts
}

export interface OCRGame {
    scene: ObsScene;
    configPath: string;
}

interface FrontPageState {
    agentEnabled: boolean;
    ocrEnabled: boolean;
    selectedGame?: LaunchableGame;
    launchableGames?: LaunchableGame[];
    ocrConfigs?: OCRGame[];
}

interface StoreConfig {
    frontPageState: FrontPageState;
    yuzu: YuzuConfig;
    agentScriptsPath: string;
    textractorPath: string;
    textractorPath64: string;
    textractorPath32: string;
    lunaTranslatorPath: string;
    sceneLaunchProfiles: SceneLaunchProfile[];
    sceneLaunchProfilesMigrated: boolean;
    sceneLaunchAgentScriptsMigrated: boolean;
    startConsoleMinimized: boolean;
    autoUpdateElectron: boolean;
    autoUpdateGSMApp: boolean;
    customPythonPackage: string;
    pythonExtras: string[];
    windowTransparencyToolHotkey: string;
    windowTransparencyTarget: string; // Target window for transparency tool
    runWindowTransparencyToolOnStartup: boolean; // Whether to run the transparency tool on startup
    runOverlayOnStartup: boolean; // Whether to run the overlay on startup
    obsOcrScenes: string[];
    pullPreReleases: boolean;
    runManualOCROnStartup: boolean;
    visibleTabs: string[]; // Array of visible tab IDs
    statsEndpoint: string; // Stats tab endpoint
    pythonPath: string;
    electronAppVersion: string;
    VN: VNConfig;
    steam: SteamConfig;
    agentPath: string;
    launchAgentMinimized: boolean;
    launchTextractorMinimized: boolean;
    launchLunaTranslatorMinimized: boolean;
    OCR: OCRConfig;
    hasCompletedSetup: boolean;
    consoleMode: 'simple' | 'advanced';
    setupWizardVersion: number;
    uiMode: 'basic' | 'advanced';
}

export const store = new Store<StoreConfig>({
    defaults: {
        frontPageState: {
            agentEnabled: false,
            ocrEnabled: false,
        },
        yuzu: {
            emuPath: "C:\\Emulation\\Emulators\\yuzu-windows-msvc\\yuzu.exe",
            romsPath: `C:\\Emulation\\Yuzu\\Games`,
            launchGameOnStart: "",
            lastGameLaunched: "",
            games: []
        },
        agentScriptsPath: `E:\\Japanese Stuff\\agent-v0.1.4-win32-x64\\data\\scripts`,
        textractorPath: `E:\\Japanese Stuff\\Textractor\\Textractor.exe`,
        textractorPath64: "",
        textractorPath32: "",
        lunaTranslatorPath: "",
        sceneLaunchProfiles: [],
        sceneLaunchProfilesMigrated: false,
        sceneLaunchAgentScriptsMigrated: false,
        startConsoleMinimized: false,
        autoUpdateElectron: false,
        autoUpdateGSMApp: false,
        VN: {
            vns: [],
            textractorPath: "",
            launchVNOnStart: "",
            lastVNLaunched: ""
        },
        pythonPath: "",
        electronAppVersion: "",
        steam: {
            steamPath: "",
            steamGames: [],
            launchSteamOnStart: 0,
            lastGameLaunched: 0
        },
        agentPath: "",
        launchAgentMinimized: false,
        launchTextractorMinimized: false,
        launchLunaTranslatorMinimized: false,
        OCR: {
            twoPassOCR: true,
            optimize_second_scan: true,
            ocr1: "oneocr",
            ocr2: "glens",
            language: "ja",
            ocr_screenshots: false,
            furigana_filter_sensitivity: 0,
            manualOcrHotkey: "Ctrl+Shift+G",
            areaSelectOcrHotkey: "Ctrl+Shift+O",
            globalPauseHotkey: "Ctrl+Shift+P",
            sendToClipboard: false,
            scanRate: 0.5,
            keep_newline: false,
            processPriority: "normal",
            advancedMode: false,
            scanRate_basic: 0.5,
            ocr1_advanced: "oneocr",
            ocr2_advanced: "glens",
            scanRate_advanced: 0.5
        },
        customPythonPackage: "GameSentenceMiner",
        pythonExtras: [],
        windowTransparencyToolHotkey: 'Ctrl+Alt+Y',
        windowTransparencyTarget: '', // Default to empty string if not set
        runWindowTransparencyToolOnStartup: false, // Whether to run the transparency tool on startup
        runOverlayOnStartup: false, // Whether to run the overlay on startup    
        obsOcrScenes: [],
        pullPreReleases: false,
        runManualOCROnStartup: false,
        visibleTabs: ['launcher', 'stats', 'console'], // Default all tabs visible
        statsEndpoint: 'overview', // Default stats endpoint
        hasCompletedSetup: false,
        consoleMode: 'simple', // 'simple' = need-to-know only, 'advanced' = full log
        setupWizardVersion: 0,
        uiMode: 'basic',
    },
    cwd: process.env.APPDATA
        ? path.join(process.env.APPDATA, 'GameSentenceMiner', 'electron')
        : path.join(os.homedir(), '.config', 'GameSentenceMiner', 'electron')
});

const DEFAULT_SCENE_TEXT_HOOK_MODE: SceneTextHookMode = "none";
const DEFAULT_SCENE_OCR_MODE: SceneOcrMode = "none";
const DEFAULT_SCENE_LAUNCH_DELAY_SECONDS = 0;

function normalizeLaunchDelaySeconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SCENE_LAUNCH_DELAY_SECONDS;
    }

    const clamped = Math.max(0, Math.min(300, value));
    return Math.round(clamped * 10) / 10;
}

function isTextHookMode(value: unknown): value is SceneTextHookMode {
    return value === "none" || value === "agent" || value === "textractor" || value === "luna";
}

function isSceneOcrMode(value: unknown): value is SceneOcrMode {
    return value === "none" || value === "auto" || value === "manual";
}

function normalizeSceneLaunchProfile(value: unknown): SceneLaunchProfile | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const profile = value as Partial<SceneLaunchProfile>;
    if (typeof profile.sceneName !== "string" || profile.sceneName.trim().length === 0) {
        return null;
    }

    const sceneId =
        typeof profile.sceneId === "string" && profile.sceneId.trim().length > 0
            ? profile.sceneId
            : undefined;

    return {
        sceneId,
        sceneName: profile.sceneName.trim(),
        textHookMode: isTextHookMode(profile.textHookMode)
            ? profile.textHookMode
            : DEFAULT_SCENE_TEXT_HOOK_MODE,
        ocrMode: isSceneOcrMode(profile.ocrMode)
            ? profile.ocrMode
            : DEFAULT_SCENE_OCR_MODE,
        agentScriptPath:
            typeof profile.agentScriptPath === "string"
                ? profile.agentScriptPath.trim()
                : "",
        launchDelaySeconds: normalizeLaunchDelaySeconds(profile.launchDelaySeconds),
    };
}

function profileKey(profile: SceneLaunchProfile): string {
    if (profile.sceneId) {
        return `id:${profile.sceneId}`;
    }
    return `name:${profile.sceneName}`;
}

function normalizeSceneLaunchProfiles(value: unknown): SceneLaunchProfile[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const deduped = new Map<string, SceneLaunchProfile>();
    for (const entry of value) {
        const normalized = normalizeSceneLaunchProfile(entry);
        if (!normalized) {
            continue;
        }
        deduped.set(profileKey(normalized), normalized);
    }

    return Array.from(deduped.values());
}

function findSceneLaunchProfileIndex(
    profiles: SceneLaunchProfile[],
    sceneId?: string,
    sceneName?: string
): number {
    if (!sceneName) {
        return -1;
    }

    return profiles.findIndex((profile) => {
        if (sceneId && profile.sceneId && profile.sceneId === sceneId) {
            return true;
        }
        return profile.sceneName === sceneName;
    });
}

function mergeSceneLaunchProfile(
    profiles: SceneLaunchProfile[],
    scene: { id?: string; name?: string },
    patch: Partial<
        Pick<
            SceneLaunchProfile,
            "textHookMode" | "ocrMode" | "agentScriptPath" | "launchDelaySeconds"
        >
    >
): void {
    if (typeof scene.name !== "string" || scene.name.trim().length === 0) {
        return;
    }

    const sceneName = scene.name.trim();
    const sceneId =
        typeof scene.id === "string" && scene.id.trim().length > 0
            ? scene.id
            : undefined;

    const existingIndex = findSceneLaunchProfileIndex(profiles, sceneId, sceneName);

    const existing =
        existingIndex >= 0
            ? profiles[existingIndex]
            : {
                  sceneId,
                  sceneName,
                  textHookMode: DEFAULT_SCENE_TEXT_HOOK_MODE,
                  ocrMode: DEFAULT_SCENE_OCR_MODE,
                  agentScriptPath: "",
                launchDelaySeconds: DEFAULT_SCENE_LAUNCH_DELAY_SECONDS,
              };

    const next: SceneLaunchProfile = {
        sceneId: sceneId ?? existing.sceneId,
        sceneName,
        textHookMode: patch.textHookMode ?? existing.textHookMode,
        ocrMode: patch.ocrMode ?? existing.ocrMode,
        agentScriptPath:
            typeof patch.agentScriptPath === "string"
                ? patch.agentScriptPath.trim()
                : existing.agentScriptPath,
        launchDelaySeconds:
            typeof patch.launchDelaySeconds === "number"
                ? normalizeLaunchDelaySeconds(patch.launchDelaySeconds)
                : existing.launchDelaySeconds,
    };

    if (existingIndex >= 0) {
        profiles[existingIndex] = next;
        return;
    }

    profiles.push(next);
}

function collectKnownScenesForMigration(): ObsScene[] {
    const scenes: ObsScene[] = [];

    const pushScene = (value: unknown) => {
        if (!value || typeof value !== "object") {
            return;
        }
        const scene = value as Partial<ObsScene>;
        if (typeof scene.id !== "string" || typeof scene.name !== "string") {
            return;
        }

        const alreadyKnown = scenes.some(
            (entry) => entry.id === scene.id || entry.name === scene.name
        );
        if (!alreadyKnown) {
            scenes.push({ id: scene.id, name: scene.name });
        }
    };

    const steamGames = store.get("steam.steamGames", []) as Array<{ scene?: ObsScene }>;
    steamGames.forEach((game) => pushScene(game.scene));

    const yuzuGames = store.get("yuzu.games", []) as Array<{ scene?: ObsScene }>;
    yuzuGames.forEach((game) => pushScene(game.scene));

    const vns = store.get("VN.vns", []) as Array<{ scene?: ObsScene }>;
    vns.forEach((vn) => pushScene(vn.scene));

    const selectedGame = store.get("frontPageState.selectedGame") as LaunchableGame | undefined;
    if (selectedGame?.scene) {
        pushScene(selectedGame.scene);
    }

    return scenes;
}

function ensureSceneLaunchProfilesMigrated(): void {
    const profilesMigrated = store.get("sceneLaunchProfilesMigrated", false);
    const agentScriptsMigrated = store.get("sceneLaunchAgentScriptsMigrated", false);
    if (profilesMigrated && agentScriptsMigrated) {
        return;
    }

    const profiles = normalizeSceneLaunchProfiles(store.get("sceneLaunchProfiles", []));
    const assignSceneAgentScriptIfMissing = (
        scene: { id?: string; name?: string } | undefined,
        scriptPath: string | undefined
    ) => {
        if (
            !scene ||
            typeof scene.name !== "string" ||
            typeof scriptPath !== "string"
        ) {
            return;
        }

        const normalizedScriptPath = scriptPath.trim();
        if (normalizedScriptPath.length === 0) {
            return;
        }

        const sceneName = scene.name.trim();
        if (sceneName.length === 0) {
            return;
        }

        const sceneId =
            typeof scene.id === "string" && scene.id.trim().length > 0
                ? scene.id.trim()
                : undefined;

        const existingIndex = findSceneLaunchProfileIndex(
            profiles,
            sceneId,
            sceneName
        );
        if (existingIndex >= 0 && profiles[existingIndex].agentScriptPath.trim().length > 0) {
            return;
        }

        mergeSceneLaunchProfile(
            profiles,
            { id: sceneId, name: sceneName },
            { agentScriptPath: normalizedScriptPath }
        );
    };

    if (!profilesMigrated) {
        const frontPageState = store.get("frontPageState") as Partial<FrontPageState> | undefined;
        const selectedGame = frontPageState?.selectedGame;
        const selectedScene = selectedGame?.scene;

        if (selectedScene) {
            if (frontPageState?.agentEnabled) {
                mergeSceneLaunchProfile(profiles, selectedScene, {
                    textHookMode:
                        selectedGame?.type === HookableGameType.VN ? "textractor" : "agent",
                });
            }

            if (frontPageState?.ocrEnabled) {
                mergeSceneLaunchProfile(profiles, selectedScene, { ocrMode: "auto" });
            } else if (store.get("runManualOCROnStartup", false)) {
                const existingIndex = findSceneLaunchProfileIndex(
                    profiles,
                    selectedScene.id,
                    selectedScene.name
                );
                const existing = existingIndex >= 0 ? profiles[existingIndex] : null;

                if (!existing || existing.ocrMode === DEFAULT_SCENE_OCR_MODE) {
                    mergeSceneLaunchProfile(profiles, selectedScene, { ocrMode: "manual" });
                }
            }
        }

        const obsOcrScenesRaw = store.get("obsOcrScenes", []);
        const obsOcrScenes = Array.isArray(obsOcrScenesRaw)
            ? obsOcrScenesRaw.filter((scene): scene is string => typeof scene === "string")
            : [];
        const knownScenes = collectKnownScenesForMigration();

        for (const sceneName of obsOcrScenes) {
            const matchingScenes = knownScenes.filter((scene) => scene.name === sceneName);
            if (matchingScenes.length === 0) {
                mergeSceneLaunchProfile(profiles, { name: sceneName }, { ocrMode: "auto" });
                continue;
            }

            matchingScenes.forEach((scene) => {
                mergeSceneLaunchProfile(profiles, scene, { ocrMode: "auto" });
            });
        }

        store.set("sceneLaunchProfilesMigrated", true);
    }

    if (!agentScriptsMigrated) {
        const steamGames = store.get("steam.steamGames", []) as Array<{
            scene?: ObsScene;
            script?: string;
            runAgent?: boolean;
        }>;
        steamGames.forEach((game) => {
            if (!game.runAgent) {
                return;
            }
            assignSceneAgentScriptIfMissing(game.scene, game.script);
        });

        const yuzuGames = store.get("yuzu.games", []) as Array<{
            id?: string;
            scene?: ObsScene;
        }>;
        const agentScriptsPath = store.get("agentScriptsPath", "");
        if (typeof agentScriptsPath === "string" && agentScriptsPath.trim().length > 0) {
            yuzuGames.forEach((game) => {
                if (!game.scene || typeof game.id !== "string" || game.id.trim().length === 0) {
                    return;
                }
                const matchedScript = findAgentScriptById(agentScriptsPath, game.id.trim());
                if (!matchedScript) {
                    return;
                }
                assignSceneAgentScriptIfMissing(game.scene, matchedScript);
            });
        }

        store.set("sceneLaunchAgentScriptsMigrated", true);
    }

    store.set("sceneLaunchProfiles", normalizeSceneLaunchProfiles(profiles));
}

export function getFrontPageState(): FrontPageState {
    return store.get('frontPageState');
}

export function setFrontPageState(state: FrontPageState): void {
    store.set('frontPageState', state);
}

export function getAutoUpdateGSMApp(): boolean {
    return store.get("autoUpdateGSMApp");
}

export function setAutoUpdateGSMApp(autoUpdate: boolean): void {
    store.set("autoUpdateGSMApp", autoUpdate);
}

export function getAutoUpdateElectron(): boolean {
    return store.get("autoUpdateElectron");
}

export function setAutoUpdateElectron(autoUpdate: boolean): void {
    store.set("autoUpdateElectron", autoUpdate);
}

export function getPythonPath(): string {
    return store.get("pythonPath");
}

export function setPythonPath(path: string): void {
    store.set("pythonPath", path);
}

export function getElectronAppVersion(): string {
    return store.get("electronAppVersion");
}

export function setElectronAppVersion(version: string): void {
    store.set("electronAppVersion", version);
}

export function getCustomPythonPackage(): string {
    return store.get("customPythonPackage");
}

export function setCustomPythonPackage(packageName: string): void {
    store.set("customPythonPackage", packageName);
}

export function getPythonExtras(): string[] {
    const extras = store.get("pythonExtras", []);
    if (!Array.isArray(extras)) {
        return [];
    }
    const normalized = extras
        .filter((extra): extra is string => typeof extra === "string")
        .map((extra) => extra.trim().toLowerCase())
        .filter((extra) => extra.length > 0);
    return Array.from(new Set(normalized));
}

export function setPythonExtras(extras: string[]): void {
    const normalized = extras
        .map((extra) => extra.trim().toLowerCase())
        .filter((extra) => extra.length > 0);
    store.set("pythonExtras", Array.from(new Set(normalized)));
}

export function setPythonExtraEnabled(extra: string, enabled: boolean): void {
    const normalized = extra.trim().toLowerCase();
    if (!normalized) {
        return;
    }
    const extras = getPythonExtras();
    const alreadyEnabled = extras.includes(normalized);
    if (enabled && !alreadyEnabled) {
        setPythonExtras([...extras, normalized]);
        return;
    }
    if (!enabled && alreadyEnabled) {
        setPythonExtras(extras.filter((entry) => entry !== normalized));
    }
}

export function getWindowTransparencyToolHotkey(): string {
    return store.get("windowTransparencyToolHotkey");
}

export function setWindowTransparencyToolHotkey(hotkey: string): void {
    store.set("windowTransparencyToolHotkey", hotkey);
}

export function setWindowTransparencyTarget(target: string): void {
    store.set("windowTransparencyTarget", target);
}

export function getWindowTransparencyTarget(): string {
    return store.get("windowTransparencyTarget") || '';
}

export function getRunWindowTransparencyToolOnStartup(): boolean {
    return store.get("runWindowTransparencyToolOnStartup");
}

export function setRunWindowTransparencyToolOnStartup(run: boolean): void {
    store.set("runWindowTransparencyToolOnStartup", run);
}

export function getRunOverlayOnStartup(): boolean {
    return store.get("runOverlayOnStartup");
}

export function setRunOverlayOnStartup(run: boolean): void {
    store.set("runOverlayOnStartup", run);
}

export function getObsOcrScenes(): string[] {
    return store.get("obsOcrScenes") || [];
}
export function setObsOcrScenes(scenes: string[]): void {
    store.set("obsOcrScenes", scenes);
}

export function getPullPreReleases(): boolean {
    return store.get("pullPreReleases", false);
}

export function setPullPreReleases(pull: boolean): void {
    store.set("pullPreReleases", pull);
}

export function getRunManualOCROnStartup(): boolean {
    return store.get("runManualOCROnStartup");
}

export function setRunManualOCROnStartup(run: boolean): void {
    store.set("runManualOCROnStartup", run);
}

export function getSceneLaunchProfiles(): SceneLaunchProfile[] {
    ensureSceneLaunchProfilesMigrated();
    return normalizeSceneLaunchProfiles(store.get("sceneLaunchProfiles", []));
}

export function setSceneLaunchProfiles(profiles: SceneLaunchProfile[]): void {
    store.set("sceneLaunchProfiles", normalizeSceneLaunchProfiles(profiles));
    store.set("sceneLaunchProfilesMigrated", true);
    store.set("sceneLaunchAgentScriptsMigrated", true);
}

export function getSceneLaunchProfileForScene(scene: ObsScene): SceneLaunchProfile | null {
    const profiles = getSceneLaunchProfiles();

    const byIdIndex = profiles.findIndex(
        (profile) => profile.sceneId && profile.sceneId === scene.id
    );
    if (byIdIndex >= 0) {
        const byId = profiles[byIdIndex];
        if (byId.sceneName !== scene.name) {
            profiles[byIdIndex] = { ...byId, sceneName: scene.name };
            setSceneLaunchProfiles(profiles);
            return profiles[byIdIndex];
        }
        return byId;
    }

    const byNameIndex = profiles.findIndex((profile) => profile.sceneName === scene.name);
    if (byNameIndex >= 0) {
        const upgraded = {
            ...profiles[byNameIndex],
            sceneId: scene.id,
            sceneName: scene.name,
        };
        profiles[byNameIndex] = upgraded;
        setSceneLaunchProfiles(profiles);
        return upgraded;
    }

    return null;
}

export function upsertSceneLaunchProfile(profile: SceneLaunchProfile): void {
    const normalized = normalizeSceneLaunchProfile(profile);
    if (!normalized) {
        return;
    }

    const profiles = getSceneLaunchProfiles();
    mergeSceneLaunchProfile(
        profiles,
        { id: normalized.sceneId, name: normalized.sceneName },
        {
            textHookMode: normalized.textHookMode,
            ocrMode: normalized.ocrMode,
            agentScriptPath: normalized.agentScriptPath,
            launchDelaySeconds: normalized.launchDelaySeconds,
        }
    );
    setSceneLaunchProfiles(profiles);
}

export function getVisibleTabs(): string[] {
    return store.get("visibleTabs", ['launcher', 'stats', 'console']);
}

export function setVisibleTabs(tabs: string[]): void {
    store.set("visibleTabs", tabs);
}

export function getStatsEndpoint(): string {
    return store.get("statsEndpoint", 'overview');
}

export function setStatsEndpoint(endpoint: string): void {
    store.set("statsEndpoint", endpoint);
}

export function getIconStyle(): string {
    return store.get("iconStyle") || "gsm";
}

export function setIconStyle(style: string): void {
    store.set("iconStyle", style);
}

export function getHasCompletedSetup(): boolean {
    return store.get("hasCompletedSetup");
}

export function setHasCompletedSetup(completed: boolean): void {
    store.set("hasCompletedSetup", completed);
}

export function getConsoleMode(): 'simple' | 'advanced' {
    return store.get("consoleMode") || 'simple';
}

export function setConsoleMode(mode: 'simple' | 'advanced'): void {
    store.set("consoleMode", mode);
}

export function getSetupWizardVersion(): number {
    return store.get("setupWizardVersion") || 0;
}

export function setSetupWizardVersion(version: number): void {
    store.set("setupWizardVersion", version);
}

export function getUiMode(): 'basic' | 'advanced' {
    return store.get("uiMode") || 'basic';
}

export function setUiMode(mode: 'basic' | 'advanced'): void {
    store.set("uiMode", mode);
}

//OCR
export function getKeepNewline(): boolean {
    return store.get("OCR.keep_newline");
}

export function setKeepNewline(keep: boolean): void {
    store.set("OCR.keep_newline", keep);
}

export function getOCRConfig(): OCRConfig {
    return store.get("OCR");
}

export function setOCRConfig(config: OCRConfig): void {
    store.set("OCR", config);
}

export function getTwoPassOCR(): boolean {
    return store.get("OCR.twoPassOCR");
}

export function setTwoPassOCR(twoPass: boolean): void {
    store.set("OCR.twoPassOCR", twoPass);
}

export function getOCR1(): string {
    return store.get("OCR.ocr1");
}

export function setOCR1(ocr: string): void {
    store.set("OCR.ocr1", ocr);
}

export function getOCR2(): string {
    return store.get("OCR.ocr2");
}

export function setOCR2(ocr: string): void {
    store.set("OCR.ocr2", ocr);
}

export function getOCRScanRate(): number {
    return store.get("OCR.scanRate");
}

export function setOCRScanRate(scanRate: number): void {
    store.set("OCR.scanRate", scanRate);
}

export function setOCRLanguage(language: string): void {
    store.set("OCR.language", language);
}

export function setShouldOCRScreenshots(shouldOCR: boolean): void {
    store.set("OCR.ocr_screenshots", shouldOCR);
}

export function getShouldOCRScreenshots(): boolean {
    return store.get("OCR.ocr_screenshots");
}

export function getOCRLanguage(): string {
    return store.get("OCR.language");
}

export function getFuriganaFilterSensitivity(): number {
    return store.get("OCR.furigana_filter_sensitivity");
}

export function setFuriganaFilterSensitivity(size: number): void {
    store.set("OCR.furigana_filter_sensitivity", size);
}

export function getManualOcrHotkey(): string {
    return store.get("OCR.manualOcrHotkey");
}

export function setManualOcrHotkey(hotkey: string): void {
    store.set("OCR.manualOcrHotkey", hotkey);
}

export function getSendToClipboard(): boolean {
    return store.get("OCR.sendToClipboard");
}

export function setSendToClipboard(sendToClipboard: boolean): void {
    store.set("OCR.sendToClipboard", sendToClipboard);
}

export function getAreaSelectOcrHotkey(): string {
    return store.get("OCR.areaSelectOcrHotkey");
}

export function setAreaSelectOcrHotkey(hotkey: string): void {
    store.set("OCR.areaSelectOcrHotkey", hotkey);
}

export function setOptimizeSecondScan(optimize: boolean): void {
    store.set("OCR.optimize_second_scan", optimize);
}

export function getAdvancedMode(): boolean {
    return store.get("OCR.advancedMode") || false;
}

export function setAdvancedMode(advancedMode: boolean): void {
    store.set("OCR.advancedMode", advancedMode);
}

// Yuzu config getters and setters
export function getYuzuConfig(): YuzuConfig {
    return store.get('yuzu');
}

export function setYuzuConfig(config: YuzuConfig): void {
    store.set('yuzu', config);
}


// Yuzu emulator path getters and setters
export function getYuzuEmuPath(): string {
    return store.get('yuzu.emuPath');
}

export function setYuzuEmuPath(path: string): void {
    store.set('yuzu.emuPath', path);
}

// Yuzu ROMs path getters and setters
export function getYuzuRomsPath(): string {
    return store.get('yuzu.romsPath');
}

export function setYuzuRomsPath(path: string): void {
    store.set('yuzu.romsPath', path);
}

export function getLaunchYuzuGameOnStart(): string {
    return store.get("yuzu.launchGameOnStart");
}

export function setLaunchYuzuGameOnStart(path: string): void {
    store.set("yuzu.launchGameOnStart", path);
}

export function getLastYuzuGameLaunched(): string {
    return store.get("yuzu.lastGameLaunched");
}

export function setLastYuzuGameLaunched(path: string): void {
    store.set("yuzu.lastGameLaunched", path);
}

export function getYuzuGamesConfig(): YuzuGame[] {
    return store.get('yuzu.games') || [];
}

export function setYuzuGamesConfig(games: YuzuGame[]): void {
    store.set('yuzu.games', games);
}

// Agent scripts path getters and setters
export function getAgentScriptsPath(): string {
    return store.get('agentScriptsPath');
}

export function setAgentScriptsPath(path: string): void {
    store.set('agentScriptsPath', path);
}

export function setAgentPath(path: string): void {
    store.set('agentPath', path);
}

export function getAgentPath(): string {
    return store.get('agentPath');
}

export function getLaunchAgentMinimized(): boolean {
    return store.get("launchAgentMinimized", false);
}

export function setLaunchAgentMinimized(shouldMinimize: boolean): void {
    store.set("launchAgentMinimized", shouldMinimize);
}

export function getLaunchTextractorMinimized(): boolean {
    return store.get("launchTextractorMinimized", false);
}

export function setLaunchTextractorMinimized(shouldMinimize: boolean): void {
    store.set("launchTextractorMinimized", shouldMinimize);
}

export function getLaunchLunaTranslatorMinimized(): boolean {
    return store.get("launchLunaTranslatorMinimized", false);
}

export function setLaunchLunaTranslatorMinimized(shouldMinimize: boolean): void {
    store.set("launchLunaTranslatorMinimized", shouldMinimize);
}

export function getStartConsoleMinimized(): boolean {
    return store.get("startConsoleMinimized");
}

export function setStartConsoleMinimized(shouldMinimize: boolean): void {
    store.set("startConsoleMinimized", shouldMinimize);
}

export function setShowYuzuTab(shouldShow: boolean): void {
    store.set("showYuzuTab", shouldShow);
}

export function getShowYuzuTab(): boolean {
    return store.get("showYuzuTab");
}

export function getVNs(): VN[] {
    return store.get('VN.vns');
}

export function setVNs(vns: VN[]): void {
    store.set('VN.vns', vns);
}

export function getTextractorPath(): string {
    const vnPath = store.get("VN.textractorPath");
    if (typeof vnPath === "string" && vnPath.trim().length > 0) {
        return vnPath;
    }

    const x64Path = store.get("textractorPath64");
    if (typeof x64Path === "string" && x64Path.trim().length > 0) {
        return x64Path;
    }

    return store.get("textractorPath", "");
}

export function setTextractorPath(path: string): void {
    const nextPath = path || "";
    store.set("VN.textractorPath", nextPath);
    store.set("textractorPath64", nextPath);
    store.set("textractorPath", nextPath);
}

export function getTextractorPath64(): string {
    const configured = store.get("textractorPath64", "");
    if (typeof configured === "string" && configured.trim().length > 0) {
        return configured;
    }
    return getTextractorPath();
}

export function setTextractorPath64(path: string): void {
    const nextPath = path || "";
    store.set("textractorPath64", nextPath);
    store.set("VN.textractorPath", nextPath);
    store.set("textractorPath", nextPath);
}

export function getTextractorPath32(): string {
    return store.get("textractorPath32", "");
}

export function setTextractorPath32(path: string): void {
    store.set("textractorPath32", path || "");
}

export function getLunaTranslatorPath(): string {
    return store.get("lunaTranslatorPath", "");
}

export function setLunaTranslatorPath(path: string): void {
    store.set("lunaTranslatorPath", path || "");
}

export function getLaunchVNOnStart(): string {
    return store.get("VN.launchVNOnStart");
}

export function setLaunchVNOnStart(VN: string): void {
    store.set("VN.launchVNOnStart", VN);
}

export function getLastVNLaunched(): string {
    return store.get("VN.lastVNLaunched");
}

export function setLastVNLaunched(VN: string): void {
    store.set("VN.lastVNLaunched", VN);
}

export function getSteamPath(): string {
    return store.get('steam.steamPath');
}

export function setSteamPath(path: string): void {
    store.set('steam.steamPath', path);
}

export function getLaunchSteamOnStart(): number {
    return store.get('steam.launchSteamOnStart');
}

export function setLaunchSteamOnStart(name: number): void {
    store.set('steam.launchSteamOnStart', String(name));
}

export function getLastSteamGameLaunched(): number {
    return store.get('steam.lastGameLaunched');
}

export function setLastSteamGameLaunched(name: string): void {
    store.set('steam.lastGameLaunched', String(name));
}

export function getSteamGames(): SteamGame[] {
    return store.get('steam.steamGames');
}

export function setSteamGames(games: SteamGame[]): void {
    store.set('steam.steamGames', games);
}

// ============================================================================
// Runtime State Manager
// ============================================================================
// This manages ephemeral runtime state that doesn't need to persist to disk.
// It's separate from the settings store above which saves to disk.

class RuntimeStateManager {
    private state: Map<string, any> = new Map();

    /**
     * Get a state value
     */
    get(key: string): any {
        return this.state.get(key);
    }

    /**
     * Set a state value and broadcast to all windows
     */
    set(key: string, value: any): void {
        const oldValue = this.state.get(key);
        this.state.set(key, value);
        
        // Broadcast to all windows
        this.broadcastStateChange(key, value, oldValue);
    }

    /**
     * Remove a state value
     */
    remove(key: string): void {
        const oldValue = this.state.get(key);
        this.state.delete(key);
        
        // Broadcast removal
        this.broadcastStateChange(key, undefined, oldValue);
    }

    /**
     * Get all state as an object
     */
    getAll(): Record<string, any> {
        return Object.fromEntries(this.state);
    }

    /**
     * Clear all state
     */
    clear(): void {
        this.state.clear();
        
        // Notify all windows that state was cleared
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('state-cleared');
            }
        });
    }

    /**
     * Broadcast state change to all windows
     */
    private broadcastStateChange(key: string, value: any, oldValue: any): void {
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                win.webContents.send('state-changed', { key, value, oldValue });
            }
        });
    }
}

export const runtimeState = new RuntimeStateManager();
