import {execFile} from 'child_process';
import * as path from 'path';
import {
    getLastSteamGameLaunched, getLastVNLaunched,
    getLaunchVNOnStart,
    getTextractorPath,
    getVNs, setLastVNLaunched,
    setLaunchVNOnStart,
    setTextractorPath,
    setVNs
} from "../store.js";
import {BrowserWindow, dialog, ipcMain} from "electron";
import {getAssetsDir} from "../util.js";
import {isQuitting, mainWindow} from "../main.js";

let VNWindow: BrowserWindow | null = null;

// Function to launch VN
async function launchVN(vnPath: string): Promise<number> {
    const vnDir = path.dirname(vnPath);
    process.chdir(vnDir);
    return new Promise((resolve, reject) => {
        console.log("Launching VN:", vnPath);
        let proc = execFile(vnPath, {windowsHide: false}, (error) => {
            if (error) {
                console.error(`Error launching VN: ${error.message}`);
                reject(0);
            } else {
                resolve(proc.pid ? proc.pid : 0);
            }
        });
    });
}

async function launchTextractor(): Promise<number> {
    return new Promise((resolve, reject) => {
        const textractor_proc = execFile(getTextractorPath(), {windowsHide: false}, (error) => {
            if (error) {
                reject(`Error launching Textractor: ${error.message}`);
            } else {
                resolve(textractor_proc.pid ? textractor_proc.pid : 0);
            }
        });
    });
}

export function addVNToStore(vnPath: string): void {
    const vns: string[] = getVNs() || [];
    vns.push(vnPath);
    setVNs(vns);
}

export async function launchVNWorkflow(vnPath: string) {
    const currentPath = process.cwd();
    try {
        launchVN(vnPath);
        process.chdir(currentPath);
        launchTextractor();
    } catch (error) {
        console.error(error);
    }
}

export function openVNWindow() {
    if (VNWindow) {
        VNWindow.show();
        VNWindow.focus();
        return;
    }

    VNWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
        },
    });

    VNWindow.loadFile(path.join(getAssetsDir(), "VN.html"));

    VNWindow.on("close", (event) => {
        if (!isQuitting) {
            event.preventDefault();
            VNWindow?.hide()
        }
    });

    VNWindow.on("closed", () => {
        VNWindow = null;
    });

    registerVNIPC();
}

export function registerVNIPC() {
    ipcMain.handle("vn.launchVN", async (_, vnPath: string) => {
        try {
            await launchVNWorkflow(vnPath);
            setLastVNLaunched(vnPath);
            return {status: "success", message: "VN launched successfully"};
        } catch (error) {
            console.error("Error launching VN:", error);
            return {status: "error", message: "Failed to launch VN"};
        }
    });


    ipcMain.handle("vn.addVN", async () => {
        console.log("Adding VN");
        if (mainWindow) {
            console.log("VNWindow is open");
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
                    properties: ['openFile'],
                    filters: [
                        {name: 'Executables', extensions: ['exe']}, // Adjust filters as needed
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: "canceled", message: "No file selected"};
                }

                const vnPath = filePaths[0];
                addVNToStore(vnPath);
                return {status: "success", message: "VN added successfully", path: vnPath};
            } catch (error) {
                console.error("Error adding VN:", error);
                return {status: "error", message: "Failed to add VN"};
            }
        }
    });

    ipcMain.handle("vn.removeVN", async (_, vnPath: string) => {
        try {
            const vns: string[] = getVNs() || [];
            const updatedVNs = vns.filter(vn => vn !== vnPath);
            setVNs(updatedVNs);
            return {status: "success", message: "VN removed successfully"};
        } catch (error) {
            console.error("Error removing VN:", error);
            return {status: "error", message: "Failed to remove VN"};
        }
    });

    ipcMain.handle("vn.getVNs", async () => {
        try {
            return getVNs();
        } catch (error) {
            console.error("Error fetching VNs:", error);
            return [];
        }
    });

    ipcMain.handle("vn.setTextractorPath", async (_, path: string) => {
        if (mainWindow) {
            try {
                const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
                    properties: ['openFile'],
                    filters: [
                        {name: 'Executables', extensions: ['exe']}, // Adjust filters as needed
                        {name: 'All Files', extensions: ['*']}
                    ]
                });

                if (canceled || !filePaths.length) {
                    return {status: "canceled", message: "No file selected"};
                }

                setTextractorPath(filePaths[0]);
                return {status: "success", message: "Textractor path set successfully", path: filePaths[0]};
            } catch (error) {
                console.error("Error setting Textractor path:", error);
                return {status: "error", message: "Failed to set Textractor path"};
            }
        }
    });

    ipcMain.handle("vn.setVNLaunchOnStart", async (_, launchOnStart: string) => {
        setLaunchVNOnStart(launchOnStart || "");
    });

    ipcMain.handle("vn.getVNLaunchOnStart", async (_,) => {
        return getLaunchVNOnStart();
    });

    ipcMain.handle("vn.getLastVNLaunched", async () => {
        return getLastVNLaunched();
    });
}
