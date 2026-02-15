import Store from "electron-store";
import { SteamGame } from "./ui/steam.js";
import {ObsScene} from "./ui/obs.js";
import { BrowserWindow } from "electron";


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
    startConsoleMinimized: boolean;
    autoUpdateElectron: boolean;
    autoUpdateGSMApp: boolean;
    customPythonPackage: string;
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
    OCR: OCRConfig;
    hasCompletedSetup: boolean;
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
            advancedMode: false,
            scanRate_basic: 0.5,
            ocr1_advanced: "oneocr",
            ocr2_advanced: "glens",
            scanRate_advanced: 0.5
        },
        customPythonPackage: "GameSentenceMiner",
        windowTransparencyToolHotkey: 'Ctrl+Alt+Y',
        windowTransparencyTarget: '', // Default to empty string if not set
        runWindowTransparencyToolOnStartup: false, // Whether to run the transparency tool on startup
        runOverlayOnStartup: false, // Whether to run the overlay on startup    
        obsOcrScenes: [],
        pullPreReleases: false,
        runManualOCROnStartup: false,
        visibleTabs: ['launcher', 'stats', 'python', 'console'], // Default all tabs visible
        statsEndpoint: 'overview', // Default stats endpoint
        hasCompletedSetup: false,
    },
    cwd: "electron"
});

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
    return store.get("autoUpdateGSMApp");
}

export function setAutoUpdateElectron(autoUpdate: boolean): void {
    store.set("autoUpdateGSMApp", autoUpdate);
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

export function getVisibleTabs(): string[] {
    return store.get("visibleTabs", ['launcher', 'stats', 'python', 'console']);
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
    return store.get("VN.textractorPath");
}

export function setTextractorPath(path: string): void {
    store.set("VN.textractorPath", path);
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
