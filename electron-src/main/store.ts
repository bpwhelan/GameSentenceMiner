import Store from "electron-store";

interface YuzuConfig {
    emuPath: string;
    romsPath: string;
}

interface StoreConfig {
    yuzu: YuzuConfig;
    agentScriptsPath: string;
    startConsoleMinimized: boolean;
    pythonPath: string;
}

const store = new Store({
    defaults: {
        yuzu: {
            emuPath: "C:\\Emulation\\Emulators\\yuzu-windows-msvc\\yuzu.exe",
            romsPath: `C:\\Emulation\\Yuzu\\Games`,
        },
        agentScriptsPath: `E:\\Japanese Stuff\\agent-v0.1.4-win32-x64\\data\\scripts`,
        startConsoleMinimized: true
    },
});



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

// Agent scripts path getters and setters
export function getAgentScriptsPath(): string {
    return store.get('agentScriptsPath');
}

export function setAgentScriptsPath(path: string): void {
    store.set('agentScriptsPath', path);
}

export function getStartConsoleMinimized(): boolean {
    return store.get("startConsoleMinimized");
}

export function setStartConsoleMinimized(shouldMinimize: boolean): void {
    store.set("startConsoleMinimized", shouldMinimize);
}
