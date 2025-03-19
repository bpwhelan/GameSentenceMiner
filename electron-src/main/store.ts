import Store from "electron-store";
import { SteamGame } from "./launchers/steam.js";

interface YuzuConfig {
    emuPath: string;
    romsPath: string;
}

interface StoreConfig {
    yuzu: YuzuConfig;
    agentScriptsPath: string;
    startConsoleMinimized: boolean;
    pythonPath: string;
    autoUpdateElectron: boolean;
    autoUpdateGSMApp: boolean;
}

const store = new Store({
    defaults: {
        yuzu: {
            emuPath: "C:\\Emulation\\Emulators\\yuzu-windows-msvc\\yuzu.exe",
            romsPath: `C:\\Emulation\\Yuzu\\Games`,
        },
        agentScriptsPath: `E:\\Japanese Stuff\\agent-v0.1.4-win32-x64\\data\\scripts`,
        textractorPath: `E:\\Japanese Stuff\\Textractor\\Textractor.exe`,
        startConsoleMinimized: true,
        autoUpdateElectron: true,
        autoUpdateGSMApp: false,
    },
    cwd: "electron"
});

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

// Yuzu config getters and setters
export function getYuzuConfig(): YuzuConfig {
    return store.get('yuzu');
}

export function setYuzuConfig(config: YuzuConfig): void {
    store.set('yuzu.emuPath', config);
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

export function getVNs(): string[] {
    return store.get('VN.vns');
}

export function setVNs(vns: string[]): void {
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

export function getSteamPath(): string {
    return store.get('steam.steamPath');
}

export function setSteamPath(path: string): void {
    store.set('steam.steamPath', path);
}

export function getLaunchSteamOnStart(): number {
    return store.get('steam.launchSteamOnStart');
}

export function setLaunchSteamOnStart(gameId: number): void {
    store.set('steam.launchSteamOnStart', Number(gameId));
}

export function getSteamGames(): SteamGame[] {
    return store.get('steam.steamGames');
}

export function setSteamGames(games: SteamGame[]): void {
    store.set('steam.steamGames', games);
}
