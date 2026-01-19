// electron-src/main/launchers/obs.ts
import { BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import { BASE_DIR, getAssetsDir, isLinux, isWindows, isWindows10OrHigher } from '../util.js';
import { isQuitting } from '../main.js';
import { exec } from 'child_process';
import OBSWebSocket from 'obs-websocket-js';
import Store from 'electron-store';
import * as fs from 'node:fs';
import { sendStartOBS, sendQuitOBS } from '../main.js';
import axios from 'axios';
import { getObsOcrScenes } from '../store.js';
import { startOCR } from './ocr.js';

interface ObsConfig {
    host: string;
    port: number;
    password: string;
}

export interface ObsScene {
    name: string;
    id: string;
}

// -------------------------------------------------------------------------
// WINDOW FILTER CONFIGURATION
// -------------------------------------------------------------------------

interface WindowFilter {
    exeName?: string; // Executable name (e.g., "Code.exe", "cmd.exe")
    windowClass?: string; // Window class (e.g., "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS")
    titlePattern?: string | RegExp; // Title pattern (exact match or regex)
    // If multiple properties are specified, ALL must match (AND logic)
}

/**
 * List of windows to filter out from the window list.
 * Can filter by exe name, window class, or window title.
 * If multiple properties are specified in a single filter, ALL must match (AND logic).
 */
const WINDOW_FILTERS: WindowFilter[] = [
    // Developer tools and IDEs
    { exeName: 'Code.exe' }, // Visual Studio Code
    // System tools
    { exeName: 'cmd.exe' },
    { windowClass: 'ConsoleWindowClass' },
    { windowClass: 'CASCADIA_HOSTING_WINDOW_CLASS' },
    // Audio editors
    { exeName: 'ocenaudio.exe' },
    // Specific applications
    { exeName: 'SKIF.exe' }, // Special K
    { exeName: 'EpicGamesLauncher.exe' }, // Epic Games Launcher
    { titlePattern: 'Epic Games Launcher' }, // Epic Games Launcher by title
    { exeName: 'LunaTranslator.exe' }, // LunaTranslator
    { titlePattern: 'LunaTranslator' }, // LunaTranslator by title
    // Windows Search
    { exeName: 'SearchHost.exe' }, // Windows Search Host
    { titlePattern: 'Search' }, // Windows Search by title
    // ShareX
    { exeName: 'ShareX.exe' }, // ShareX
    { titlePattern: 'ShareX' }, // ShareX by title
    // Flydigi Space Station (must match both exe and title)
    { exeName: 'Flydigi Space Station.exe' }, // Flydigi only
    // Anki (must match both pythonw.exe AND have Anki in title)
    { exeName: 'pythonw.exe', titlePattern: '- Anki' }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: 'Browse (' }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: /^Edit$/ }, // Anki only
    { exeName: 'pythonw.exe', titlePattern: 'Preview' }, // Anki only
    // Exact title match
    { exeName: 'GameSentenceMiner.exe'},
    { titlePattern: 'GSM Overlay' },
    { titlePattern: 'GitHub Desktop' },
    { titlePattern: 'OBS Studio' },
    { titlePattern: 'iCUE' },
    { titlePattern: 'Magpie' },
    { titlePattern: 'Calculator' },

];

// -------------------------------------------------------------------------
// GAME TITLE PARSING CONFIGURATION
// -------------------------------------------------------------------------

interface TitleMatcher {
    name: string; // Identifier for debugging
    pattern: RegExp; // Regex to test if the window belongs to this category
    // Logic to extract the clean name from the MatchArray
    getName: (match: RegExpMatchArray) => string;
    // Logic to create the OBS Auto Switcher Regex based on the extracted name
    getSwitcherPattern: (cleanName: string) => string;
    priority?: number; // Lower numbers = higher priority. Default: 50. Use 100+ for fallback matchers.
}

/**
 * Expandable list of regex patterns for Emulators and Games.
 * The system checks these in order. The first match wins.
 */
const TITLE_MATCHERS: TitleMatcher[] = [
    {
        name: 'Vita3K',
        // Pattern: Vita3K [ver] | Game Name (ID) | ...
        pattern: /^Vita3K.*?\|\s*(.+?)\s*\(/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^Vita3K.*?\\|.*${escapeRegexCharacters(n.trim())}.*\\(.*`
    },
    {
        name: 'Eden/Yuzu/Suyu',
        // Pattern: Eden | v0.0.3 | Game Name (64-bit) | ...
        // Pattern: yuzu | v0.0.3 | Game Name (64-bit) | ...
        // Pattern: suyu | v0.0.3 | Game Name (64-bit) | ...
        pattern: /^(?:Eden|yuzu|suyu)\s*\|\s*v[\d.]+\s*\|\s*(.+?)\s*(\(64-bit\)|\(32-bit\)|\||$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^(?:Eden|yuzu|suyu).*\\|.*?\\|.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'RPCS3',
        // Pattern: FPS: 30.22 | Vulkan | 0.0.38 | Demon's Souls [BLES00932]
        // Updated to use greedy matching (.*) before the pipe to skip 'Vulkan'/'Version' segments
        pattern: /^FPS:.*\|\s*([^|]+?)\s*\[\w+\]$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^FPS:.*\\|.*${escapeRegexCharacters(n.trim())}.*\\[\\w+\\]$`
    },
    {
        name: 'Cemu',
        // Pattern: Cemu ... [TitleId: 000...] Breath of the Wild [US v208]
        // Anchors on the [TitleId: ...] block
        pattern: /^Cemu.*?\[TitleId:[^\]]+\]\s*(.+?)(?:\s*\[|$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^Cemu.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'Dolphin',
        // Pattern: Dolphin 5.0 | JIT | ... | Game Name (GAMEID)
        // Anchors to the Game ID in parens at the very end
        pattern: /^Dolphin.*?\|\s*([^|]+?)\s*\([A-Z0-9]{6}\)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^Dolphin.*?\\|.*${escapeRegexCharacters(n.trim())}.*\\([A-Z0-9]{6}\\)$`
    },
    {
        name: 'PPSSPP',
        // Pattern: PPSSPP v1.19.3 - ULJS00186 : Game Name
        pattern: /^PPSSPP.*?-[A-Z0-9\s]+:\s*(.+)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^PPSSPP.*?:.*${escapeRegexCharacters(n.trim())}$`
    },
    {
        name: 'Simple Pipe-Separated (Citra/DeSmuME)',
        // Pattern: Azahar ... | Game Name 
        // Pattern: DeSmuME ... | Game Name
        // Covers: Citra, Azahar, Lime3DS, Mandarine, DeSmuME
        pattern: /^(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\|\s*(.+?)$/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^(?:Azahar|Citra|Lime3DS|Mandarine|DeSmuME).*?\\|.*${escapeRegexCharacters(n.trim())}$`
    },
    {
        name: 'Prefix Dash-Separated (mGBA/Flycast/Mesen)',
        // Pattern: mGBA - Game Name (Japan)
        // Pattern: Flycast - Game Name (USA)
        // Pattern: Mesen - Game Name [!]
        // Captures name, stopping before (Region) or [Flags]
        pattern: /^(?:mGBA|Flycast|Mesen)\s*-\s*(.+?)(?:\s*[\(\[].*|$)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^(?:mGBA|Flycast|Mesen).*-.*${escapeRegexCharacters(n.trim())}.*`
    },
    {
        name: 'Suffix Dash-Separated (VBA-M/PJ64/Snes9x/RMG)',
        // Pattern: Game Name (U) [!] - Emulator Name ...
        // Covers: VisualBoyAdvance-M, Project64, Snes9x, Rosalie's Mupen GUI
        pattern: /^(.+?)(?:\s*[\(\[].*?)?\s*-\s*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^${escapeRegexCharacters(n.trim())}.*-.*(?:VisualBoyAdvance|Project64|Snes9x|Rosalie's Mupen).*`
    },
    {
        name: 'Generic Version Suffix',
        // Pattern: Game Name - Ver1.0.0 OR Game Name ver1.00
        // Kept at the bottom as a catch-all
        pattern: /^(.+?)\s*(?:-|)\s*ver\d/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^${escapeRegexCharacters(n.trim())}.*`,
        priority: 90
    },
    {
        name: "Generic Suffix",
        // Pattern: Game Name followed by various separators and text (e.g., "Kanon プロローグ" -> "Kanon")
        // Covers: patterns with space followed by Japanese/descriptive text, or other common suffixes
        pattern: /^(.+?)\s+(?:プロローグ|エピローグ|体験版|デモ版|demo)/i,
        getName: (m) => m[1].trim(),
        getSwitcherPattern: (n) => `^${escapeRegexCharacters(n.trim())}.*`,
        priority: 100
    }
    // {
    //     name: 'MPV',
    //     // Pattern: .* - mpv
    //     pattern: /^(.+?)\s*-\s*mpv$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*mpv$`
    // },
    // {
    //     name: 'VLC',
    //     // Pattern: MyAnimeTitle - VLC.*
    //     pattern: /^(.+?)\s*-\s*VLC.*$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*VLC.*$`
    // },
    // {
    //     name: 'Memento',
    //     // Pattern: MyAnimeTitle - Memento
    //     pattern: /^(.+?)\s*-\s*Memento$/i,
    //     getName: (m) => m[1].trim(),
    //     getSwitcherPattern: (n) => `^${escapeRegexCharacters(n)}\\s*-\\s*Memento$`
    // }
];

// Helper to determine Scene Name and Switcher Pattern from a raw Window Title
function getGameInfoFromWindow(rawTitle: string): { sceneName: string; switcherRegex: string } {
    // Sort matchers by priority (lower number = higher priority)
    const sortedMatchers = [...TITLE_MATCHERS].sort((a, b) => {
        const priorityA = a.priority ?? 50;
        const priorityB = b.priority ?? 50;
        return priorityA - priorityB;
    });

    for (const matcher of sortedMatchers) {
        const match = rawTitle.match(matcher.pattern);
        if (match) {
            try {
                const cleanName = matcher.getName(match);
                if (cleanName) {
                    console.log(`[OBS] Title Match Found (${matcher.name}): "${cleanName}"`);
                    return {
                        sceneName: cleanName,
                        switcherRegex: matcher.getSwitcherPattern(cleanName)
                    };
                }
            } catch (e) {
                console.error(`[OBS] Error processing matcher ${matcher.name}:`, e);
            }
        }
    }

    // Fallback: Use the whole title, escaped
    console.log(`[OBS] No matcher found for: "${rawTitle}". Using full title.`);
    return {
        sceneName: rawTitle,
        switcherRegex: `^${escapeRegexCharacters(rawTitle)}$`
    };
}

// -------------------------------------------------------------------------

export let pythonConfig: Store | null = null;
try {
    pythonConfig = new Store();
} catch (error) {
    console.error('Failed to load pythonConfig store, using empty config.', error);
    // pythonConfig = new Store({defaults: {}});
}

let obsConfig: ObsConfig = (pythonConfig?.get('configs.Default.obs') as ObsConfig) || {
    host: 'localhost',
    port: 7274,
    password: '',
};

const OBS_CONFIG_PATH = path.join(BASE_DIR, 'obs-studio');
const SCENE_CONFIG_PATH = path.join(OBS_CONFIG_PATH, 'config', 'obs-studio', 'basic', 'scenes');
let obs = new OBSWebSocket();
let obsConnected = false;
const OLD_HELPER_SCENE = "GSM Helper";
const HELPER_SCENE = 'GSM Helper - DONT TOUCH';
const WINDOW_GETTER_INPUT = 'window_getter';
const GAME_WINDOW_INPUT = 'game_window_getter';
let sceneSwitcherRegistered = false;

let connectionPromise: Promise<void> | null = null;

// Utility function to escape regex special characters in window titles
function escapeRegexCharacters(str: string): string {
    // Escape all regex special characters that could break the auto scene switcher
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Check if a window item should be filtered out
function shouldFilterWindow(item: any): boolean {
    const windowValue = item.itemValue || '';
    const itemName = item.itemName || '';
    
    // Parse window value format: "Title:ClassName:ExeName.exe"
    const parts = windowValue.split(':');
    const exeName = parts[parts.length - 1]?.trim() || '';
    const windowClass = parts[parts.length - 2]?.trim() || '';
    const title = itemName.split(':').slice(1).join(':').trim();

    for (const filter of WINDOW_FILTERS) {
        let matches = true; // Assume match unless proven otherwise

        // Check exe name filter (if specified)
        if (filter.exeName) {
            if (exeName.toLowerCase() !== filter.exeName.toLowerCase()) {
                matches = false;
            }
        }

        // Check window class filter (if specified)
        if (filter.windowClass && matches) {
            if (windowClass !== filter.windowClass) {
                matches = false;
            }
        }

        // Check title pattern filter (if specified)
        if (filter.titlePattern && matches) {
            if (typeof filter.titlePattern === 'string') {
                // Substring match for string patterns
                if (!title.includes(filter.titlePattern)) {
                    matches = false;
                }
            } else if (filter.titlePattern instanceof RegExp) {
                // Regex match for RegExp patterns
                if (!filter.titlePattern.test(title)) {
                    matches = false;
                }
            }
        }

        // If all specified conditions match, filter this window
        if (matches) {
            return true;
        }
    }

    return false;
}

// Generate a random fallback window name
function generateFallbackWindowName(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `Scene-${dateStr}`;
}

// Shared scene creation logic
async function createSceneWithCapture(window: any, captureType: 'window' | 'game'): Promise<void> {
    await getOBSConnection();

    const rawWindowTitle = window.title;
    
    // Process the window title to get the clean Name and the Regex for the switcher
    const { sceneName, switcherRegex } = getGameInfoFromWindow(rawWindowTitle);

    let sceneExisted = false;
    try {
        // Try to create the scene
        await obs.call('CreateScene', { sceneName });
    } catch (error: any) {
        // If the scene already exists, wipe all sources from the scene
        if (error && error.code === 601) {
            sceneExisted = true;
        } else {
            throw error;
        }
    }

    // If the scene existed, remove all sources from it
    if (sceneExisted) {
        try {
            const sceneItems = await obs.call('GetSceneItemList', { sceneName });
            for (const item of sceneItems.sceneItems) {
                // Remove each input/source from the scene
                if (typeof item.sourceName === 'string') {
                    try {
                        await obs.call('RemoveInput', { inputName: item.sourceName });
                    } catch (removeErr) {
                        // Ignore errors if input doesn't exist or can't be removed
                    }
                }
            }
        } catch (wipeErr) {
            // Ignore errors wiping scene
        }
    }

    // Set the new scene as the current program scene
    await obs.call('SetCurrentProgramScene', { sceneName });

    // Configure input settings based on capture type
    let request: any = {
        sceneName,
        // Use the clean sceneName for the input name as well to keep it tidy
        inputName: `${sceneName} - ${captureType === 'window' ? 'Capture' : 'Game Capture'}`,
        inputKind: captureType === 'window' ? 'window_capture' : 'game_capture',
        inputSettings: {
            window: window.value,
            capture_audio: true,
        },
    };

    if (captureType === 'window') {
        request.inputSettings.mode = 'window';
        request.inputSettings.cursor = false;

        if (isWindows10OrHigher()) {
            request.inputSettings.method = 2;
        }
    } else {
        request.inputSettings.capture_mode = 'window';
        request.inputSettings.capture_cursor = false;
    }

    // Always create the input now (scene is fresh)
    await obs.call('CreateInput', request);

    // Configure auto scene switcher with the generated REGEX pattern
    await modifyAutoSceneSwitcherInJSON(sceneName, switcherRegex);

    console.log(`Scene and ${captureType} capture setup for window: "${rawWindowTitle}" -> Scene: "${sceneName}"`);
}

async function modifyAutoSceneSwitcherInJSON(
    sceneName: string,
    windowTitleRegex: string
): Promise<void> {
    try {
        await getOBSConnection();
        
        const currentSceneCollection = await obs.call('GetSceneCollectionList');
        const sceneCollectionName = currentSceneCollection.currentSceneCollectionName;

        const sceneCollectionPath = path.join(
            SCENE_CONFIG_PATH,
            `${sceneCollectionName}.json`.replace(' ', '_')
        );

        // Verify the file exists before proceeding
        if (!fs.existsSync(sceneCollectionPath)) {
            console.error(`Scene collection file not found: ${sceneCollectionPath}`);
            throw new Error('Scene collection file not found. Please ensure OBS is properly configured.');
        }

        sendQuitOBS();
        
        // Wait a bit for OBS to close gracefully
        await new Promise(resolve => setTimeout(resolve, 1000));

        const fileContent = await fs.promises.readFile(sceneCollectionPath, 'utf-8');
        const sceneCollection = JSON.parse(fileContent);

        // Initialize modules object if it doesn't exist
        if (!sceneCollection['modules']) {
            sceneCollection['modules'] = {};
        }

        let autoSceneSwitcher = sceneCollection['modules']['auto-scene-switcher'];

        if (!autoSceneSwitcher) {
            sceneCollection['modules']['auto-scene-switcher'] = {
                interval: 300,
                non_matching_scene: '',
                switch_if_not_matching: false,
                active: true,
                switches: [],
            };
            autoSceneSwitcher = sceneCollection['modules']['auto-scene-switcher'];
        }

        // Ensure switches array exists
        if (!Array.isArray(autoSceneSwitcher.switches)) {
            autoSceneSwitcher.switches = [];
        }

        // NOTE: We do NOT escape characters here anymore, because `windowTitleRegex`
        // is now passed in as a complete regex string from `getGameInfoFromWindow`.

        // Check if this scene already has a switch configured
        const existingSwitchIndex = autoSceneSwitcher.switches.findIndex(
            (s: any) => s.scene === sceneName
        );

        if (!autoSceneSwitcher.active) {
            const response = await dialog.showMessageBox(obsWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 0,
                title: 'Enable Auto Scene Switcher',
                message: 'Do you want to enable the auto scene switcher?',
            });

            if (response.response === 0) {
                autoSceneSwitcher.active = true;
            }
        }

        // Add or update the switch entry
        const switchEntry = {
            scene: sceneName,
            window_title: windowTitleRegex,
        };

        if (existingSwitchIndex >= 0) {
            autoSceneSwitcher.switches[existingSwitchIndex] = switchEntry;
        } else {
            autoSceneSwitcher.switches.push(switchEntry);
        }

        sceneCollection['modules']['auto-scene-switcher'] = autoSceneSwitcher;

        const updatedContent = JSON.stringify(sceneCollection, null, 2);
        
        // Write the updated content to both files
        await fs.promises.writeFile(sceneCollectionPath, updatedContent, 'utf-8');
        await fs.promises.writeFile(
            path.join(BASE_DIR, 'scene_config.json'),
            updatedContent,
            'utf-8'
        );

        console.log(`Auto-scene-switcher settings updated for "${sceneName}" with pattern: ${windowTitleRegex}`);
        
        // Restart OBS and reconnect
        sendStartOBS();
        
        // Wait for OBS to start before attempting to reconnect
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
            await connectOBSWebSocket();
        } catch (reconnectError) {
            console.warn('Initial reconnection failed, OBS may still be starting up:', reconnectError);
            // Don't throw here - the getOBSConnection retry logic will handle it
        }
    } catch (error: any) {
        console.error(`Error modifying auto-scene-switcher settings:`, error.message);
        
        // Attempt to restart OBS even if there was an error
        try {
            sendStartOBS();
        } catch (startError) {
            console.error('Failed to restart OBS after error:', startError);
        }
        
        throw error;
    }
}

async function connectOBSWebSocket(retries = 5, delay = 2000): Promise<void> {
    await obs.connect(`ws://${obsConfig.host}:${obsConfig.port}`, obsConfig.password);
    const obsOcrScenes = getObsOcrScenes();
    if (obsOcrScenes && obsOcrScenes.length > 0) {
        getCurrentScene().then((scene) => {
            if (obsOcrScenes.includes(scene.name)) {
                startOCR();
            }
        });
    }
    if (!sceneSwitcherRegistered) {
        setOBSSceneSwitcherCallback();
        sceneSwitcherRegistered = true;
    }
    obsConnected = true;
    return;
}

export async function getOBSConnection(): Promise<void> {
    if (connectionPromise) {
        return connectionPromise;
    }

    // Create a new connection attempt
    connectionPromise = new Promise(async (resolve, reject) => {
        try {
            // Try to connect immediately
            await obs.call('GetVersion');
            connectionPromise = null;
            resolve();
            return;
        } catch (error) {
            console.warn('Immediate connection attempt failed, starting retry interval...');
        }

        const interval = setInterval(async () => {
            try {
                await obs.call('GetVersion');
                clearInterval(interval);
                connectionPromise = null;
                resolve();
            } catch (error) {
                try {
                    obsConfig = (pythonConfig?.get('configs.Default.obs') as ObsConfig) || {
                        host: 'localhost',
                        port: 7274,
                        password: '',
                    };
                    await connectOBSWebSocket();
                } catch (connectError) {}
            }
        }, 1000);
    });

    return connectionPromise;
}

export let obsWindow: BrowserWindow | null = null;

export function openOBSWindow() {
    if (obsWindow) {
        obsWindow.show();
        obsWindow.focus();
        return;
    }

    obsWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: true,
        },
    });

    obsWindow.loadFile(path.join(getAssetsDir(), 'home.html'));

    obsWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            obsWindow?.hide();
        } else {
            obsWindow = null;
        }
    });

    registerOBSIPC();
}

function setOBSSceneSwitcherCallback() {
    obs.on('CurrentProgramSceneChanged', (data) => {
        const ocrScenes = getObsOcrScenes();
        if (ocrScenes && ocrScenes.length > 0 && ocrScenes.includes(data.sceneName)) {
            startOCR();
        }
        console.log(`Switched to OBS scene: ${data.sceneName}`);
    });
}

export async function registerOBSIPC() {
    ipcMain.handle('obs.launch', async () => {
        exec('obs', (error: any) => {
            if (error) {
                console.error('Error launching OBS:', error);
            }
        });
    });

    ipcMain.handle('obs.saveReplay', async () => {
        try {
            await getOBSConnection();
            await obs.call('SaveReplayBuffer');
        } catch (error) {
            console.error('Error saving replay buffer:', error);
        }
    });

    ipcMain.handle('obs.switchScene', async (_, sceneName) => {
        try {
            await getOBSConnection();
            await obs.call('SetCurrentProgramScene', { sceneName });
        } catch (error) {
            console.error('Error switching scene:', error);
        }
    });

    ipcMain.handle('obs.switchScene.id', async (_, sceneUuid) => {
        try {
            await getOBSConnection();
            await obs.call('SetCurrentProgramScene', { sceneUuid });
        } catch (error) {
            console.error('Error switching scene:', error);
        }
    });

    ipcMain.handle('obs.startRecording', async (_, windowName) => {
        try {
            await getOBSConnection();
            await obs.call('StartRecord');
        } catch (error) {
            console.error('Error starting recording:', error);
        }
    });

    ipcMain.handle('obs.getScenes', async () => {
        try {
            await getOBSConnection();
            return await getOBSScenes();
        } catch (error) {
            console.error('Error getting scenes:', error);
            return [];
        }
    });

    ipcMain.handle('obs.createScene', async (_, window) => {
        try {
            // if (window.captureSource === 'game_capture') {
            //     const response = await dialog.showMessageBox(obsWindow!, {
            //         type: 'warning',
            //         defaultId: 1,
            //         title: 'Game Capture Warning',
            //         message: 'This game was detected as game capture instead of Window Capture, the scene will be created as game capture.',
            //     });
            //     await createSceneWithCapture(window, 'game');
            // } else {
                await createSceneWithCapture(window, 'window');
            // }
        } catch (error) {
            console.error('Error setting up scene and window capture:', error);
        }
    });

    ipcMain.handle('obs.createScene.Game', async (_, window) => {
        try {
            // Show warning dialog before proceeding
            const response = await dialog.showMessageBox(obsWindow!, {
                type: 'warning',
                buttons: ['Yes', 'No'],
                defaultId: 1,
                title: 'Game Capture Warning',
                message: 'Game Capture is NOT recommended for most games.',
                detail: 'Most games should use Window Capture. Only use Game Capture for games that run in EXCLUSIVE fullscreen and have special OBS support. Visual Novels (VNs) should almost never use Game Capture.\n\nAre you sure you want to continue with Game Capture?',
            });
            if (response.response !== 0) {
                // User chose 'No', do not proceed
                return;
            }
            await createSceneWithCapture(window, 'game');
        } catch (error) {
            console.error('Error setting up scene and game capture:', error);
        }
    });

    ipcMain.handle('obs.removeScene', async (_, sceneUuid) => {
        try {
            const response = await dialog.showMessageBox(obsWindow!, {
                type: 'question',
                buttons: ['Yes', 'No'],
                defaultId: 1,
                title: 'Confirm Scene Removal',
                message: 'Are you sure you want to remove this scene?',
            });

            if (response.response === 0) {
                // User clicked 'Yes'
                await getOBSConnection();
                await obs.call('RemoveScene', { sceneUuid });
            }
        } catch (error) {
            console.error('Error removing scene:', error);
        }
    });

    ipcMain.handle('obs.getActiveScene', async () => {
        return await getCurrentScene();
    });

    ipcMain.handle('obs.getSceneActiveWindow', async () => {
        const currentScene = await getCurrentScene();
        try {
            return await getWindowTitleFromSource(currentScene.id);
        } catch (error) {
            console.error('Error getting active window from current scene:', error);
            return null;
        }
    });

    ipcMain.handle('obs.getExecutableNameFromSource', async (_, obsSceneID: string) => {
        try {
            return await getExecutableNameFromSource(obsSceneID);
        } catch (error) {
            console.error('Error getting executable name from source:', error);
            return null;
        }
    });

    ipcMain.handle('get_gsm_status', async () => {
        try {
            const texthookerPort =
                pythonConfig?.get('configs.Default.general.texthooker_port') || 55000;
            const response = await axios.get(`http://localhost:${texthookerPort}/get_status`);
            return response.data;
        } catch (error) {
            // console.error('Error fetching GSM status:', error);
            return null;
        }
    });

    ipcMain.handle('openOBS', async () => {
        sendStartOBS();
    });

    // Only allow one getWindowsFromSource to run at a time
    let getWindowsFromSourcePromise: Promise<any[]> | null = null;

    interface ObsWindowItem {
        itemName: string;
        itemValue: string;
        captureMode: string;
        [key: string]: any; // for any additional properties from OBS
    }

    async function getWindowsFromSource(sourceName: string, capture_mode: string): Promise<ObsWindowItem[]> {
        if (getWindowsFromSourcePromise) {
            return getWindowsFromSourcePromise;
        }
        getWindowsFromSourcePromise = (async () => {
            try {
                await getOBSConnection();
                const response = await obs.call('GetInputPropertiesListPropertyItems', {
                    inputName: sourceName,
                    propertyName: 'window',
                });
                return response.propertyItems.map((item: any) => ({ ...item, captureMode: capture_mode }));
            } catch (error: any) {
                if (error.message.includes('No source was found')) {
                    try {
                        await obs.call('GetSceneItemList', { sceneName: HELPER_SCENE });
                    } catch (sceneError: any) {
                        if (sceneError.message.includes('No source was found')) {
                            await obs.call('CreateScene', { sceneName: HELPER_SCENE });
                        }
                        try {
                            await obs.call('GetSceneItemList', { sceneName: OLD_HELPER_SCENE });
                            await obs.call('RemoveScene', { sceneName: OLD_HELPER_SCENE });
                        } catch (oldSceneError: any) {
                            // Do nothing
                        }
                    }

                    // Create the 'window_getter' input
                    await obs.call('CreateInput', {
                        sceneName: HELPER_SCENE,
                        inputName: sourceName,
                        inputKind: capture_mode,
                        inputSettings: {},
                    });

                    // Retry getting the window list
                    const retryResponse = await obs.call('GetInputPropertiesListPropertyItems', {
                        inputName: sourceName,
                        propertyName: 'window',
                    });
                    return retryResponse.propertyItems.map((item: any) => ({ ...item, captureMode: capture_mode }));
                } else {
                    throw error;
                }
            }
        })();

        try {
            return await getWindowsFromSourcePromise;
        } finally {
            getWindowsFromSourcePromise = null;
        }
    }

    async function  getWindowList(): Promise<any[]> {
        try {
            const windowCaptureWindows = await getWindowsFromSource(
                WINDOW_GETTER_INPUT,
                'window_capture'
            );
            const gameCaptureWindows = await getWindowsFromSource(
                GAME_WINDOW_INPUT,
                'game_capture'
            );
            const allWindows = [
                ...windowCaptureWindows.filter(
                    (windowCapture) =>
                        !gameCaptureWindows.some(
                            (gameWindow) => gameWindow.value === windowCapture.value
                        )
                ),
                ...gameCaptureWindows,
            ]
                .filter((item) => !shouldFilterWindow(item)) // Apply filters
                .sort((a, b) => a.itemName.localeCompare(b.itemName));
            // console.log(allWindows);
            return allWindows;
        } catch (error) {
            console.error('Error getting window list:', error);
            return []; // Return an empty array in case of an error
        }
    }

    ipcMain.handle('obs.getWindows', async () => {
        try {
            if (!isWindows()) {
                return ["Not Supported"];
            }
            await getOBSConnection();
            const response = await getWindowList();
            return response.map((item: any) => ({
                title: item.itemName.split(':').slice(1).join(':').trim(),
                value: item.itemValue,
            }));
        } catch (error) {
            console.error('Error getting windows:', error);
            return [];
        }
    });

    await getOBSConnection();
}

export async function getExecutableNameFromSource(
    obsSceneID: string
): Promise<string | undefined | null> {
    try {
        await getOBSConnection();

        // Get the list of scene items for the given scene
        const sceneItems = await obs.call('GetSceneItemList', { sceneUuid: obsSceneID });

        // Find the first input source with a window property
        for (const item of sceneItems.sceneItems) {
            const inputProperties = await obs.call('GetInputSettings', {
                inputUuid: item.sourceUuid as string,
            });
            if (inputProperties.inputSettings?.window) {
                const windowValue = inputProperties.inputSettings.window as string;

                return windowValue.split(':').at(-1)?.trim();
            }
        }

        return null;
    } catch (error: any) {
        console.error(
            `Error getting executable name from source in scene "${obsSceneID}":`,
            error.message
        );
        throw error;
    }
}

export async function getWindowTitleFromSource(
    obsSceneID: string
): Promise<string | undefined | null> {
    try {
        await getOBSConnection();

        // Get the list of scene items for the given scene
        const sceneItems = await obs.call('GetSceneItemList', { sceneUuid: obsSceneID });

        // Find the first input source with a window property
        for (const item of sceneItems.sceneItems) {
            const inputProperties = await obs.call('GetInputSettings', {
                inputUuid: item.sourceUuid as string,
            });

            if (inputProperties.inputSettings?.window) {
                const windowValue = inputProperties.inputSettings.window as string;
                return windowValue.split(':').at(0)?.trim();
            }
        }

        return null;
    } catch (error: any) {
        console.error(
            `Error getting window title from source in scene "${obsSceneID}":`,
            error.message
        );
        throw error;
    }
}

export async function setOBSScene(sceneName: string): Promise<void> {
    await getOBSConnection();
    await obs.call('SetCurrentProgramScene', { sceneName });
}

export async function getOBSScenes(): Promise<ObsScene[]> {
    const { scenes } = await obs.call('GetSceneList');
    return scenes
        .filter((scene: any) => scene.sceneName.toLowerCase() !== HELPER_SCENE.toLowerCase())
        .map((scene: any) => ({ name: scene.sceneName, id: scene.sceneUuid } as ObsScene));
}

export async function getCurrentScene(): Promise<ObsScene> {
    await getOBSConnection();
    const response = await obs.call('GetCurrentProgramScene');
    return { name: response.sceneName, id: response.sceneUuid };
}