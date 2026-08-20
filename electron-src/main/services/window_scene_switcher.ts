import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
    findWindowSceneSwitcherCandidates,
    getForegroundWindowContextKey,
    matchWindowSceneRule,
    normalizeExecutableName,
    validateWindowTitlePattern,
    WINDOW_SCENE_SWITCHER_MIGRATION_VERSION,
    WINDOW_SCENE_SWITCHER_SCHEMA_VERSION,
    type ForegroundWindowSnapshot,
    type SaveWindowSceneSwitcherRulePayload,
    type WindowSceneSwitcherCollection,
    type WindowSceneSwitcherConfig,
    type WindowSceneSwitcherConflict,
    type WindowSceneSwitcherHookStatus,
    type WindowSceneSwitcherRule,
    type WindowSceneSwitcherState,
    type WindowSceneSwitcherTestResult,
} from '../../shared/window_scene_switcher.js';
import {
    getWindowSceneSwitcherConfig,
    setWindowSceneSwitcherConfig,
} from '../store.js';
import {
    getRendererEntryPath,
    getSecureWebPreferences,
    isWindows,
} from '../util.js';

const AUTO_SCENE_SWITCHER_MODULE_NAME = 'auto-scene-switcher';
const FOREGROUND_SETTLE_MS = 200;
const SELF_SWITCH_EVENT_WINDOW_MS = 3_000;

interface ObsSceneRef {
    id: string;
    name: string;
}

export interface WindowSceneSwitcherRuntimeDependencies {
    isOBSConnected: () => boolean;
    getCurrentCollectionName: () => Promise<string>;
    /**
     * A null result means OBS could not provide a scene list. It is deliberately
     * distinct from an empty collection so reconciliation never prunes rules
     * during a transient OBS failure.
     */
    getScenes: () => Promise<ObsSceneRef[] | null>;
    getCurrentScene: () => Promise<ObsSceneRef>;
    switchScene: (sceneUuid: string) => Promise<void>;
    suggestRule: (
        sceneUuid: string
    ) => Promise<{ titlePattern: string; executableName?: string } | null>;
    requestForegroundSnapshot: () => void;
    restoreForegroundWindow: (hwnd: string) => void;
}

export interface WindowSceneSwitcherMigrationResult {
    migratedCollections: string[];
    blockedCollections: string[];
}

export async function hasPendingLegacyWindowSceneSwitcherMigration(
    sceneCollectionDirectory: string
): Promise<boolean> {
    if (!isWindows() || !fs.existsSync(sceneCollectionDirectory)) {
        return false;
    }
    const config = readConfig();
    const fileNames = (await fs.promises.readdir(sceneCollectionDirectory))
        .filter((fileName) => fileName.toLowerCase().endsWith('.json'));
    for (const fileName of fileNames) {
        try {
            const data = JSON.parse(
                await fs.promises.readFile(path.join(sceneCollectionDirectory, fileName), 'utf-8')
            ) as Record<string, any>;
            const collectionName = typeof data.name === 'string' ? data.name.trim() : '';
            const state = collectionName ? findCollection(config, collectionName) : undefined;
            if (
                data.modules?.[AUTO_SCENE_SWITCHER_MODULE_NAME]?.active === true ||
                !state ||
                state.migrationVersion < WINDOW_SCENE_SWITCHER_MIGRATION_VERSION ||
                !state.legacySwitcherDisabled
            ) {
                return true;
            }
        } catch {
            // The migration pass will report malformed files; don't restart OBS only for them.
        }
    }
    return false;
}

function normalizeRule(value: unknown): WindowSceneSwitcherRule | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const rule = value as Partial<WindowSceneSwitcherRule>;
    const sceneUuid = typeof rule.sceneUuid === 'string' ? rule.sceneUuid.trim() : '';
    const sceneName = typeof rule.sceneName === 'string' ? rule.sceneName.trim() : '';
    const titlePattern = typeof rule.titlePattern === 'string' ? rule.titlePattern.trim() : '';
    if (!sceneUuid || !sceneName || !titlePattern) {
        return null;
    }
    return {
        sceneUuid,
        sceneName,
        titlePattern,
        executableName: normalizeExecutableName(rule.executableName) || undefined,
        enabled: rule.enabled !== false && !validateWindowTitlePattern(titlePattern),
        source:
            rule.source === 'obs-migration' ||
            rule.source === 'gsm-generated' ||
            rule.source === 'manual'
                ? rule.source
                : 'manual',
    };
}

function normalizeConfig(value: unknown): WindowSceneSwitcherConfig {
    const raw = value && typeof value === 'object'
        ? (value as Partial<WindowSceneSwitcherConfig>)
        : {};
    const collections = Array.isArray(raw.collections)
        ? raw.collections.flatMap((entry) => {
              if (!entry || typeof entry !== 'object') {
                  return [];
              }
              const collection = entry as Partial<WindowSceneSwitcherCollection>;
              const collectionName =
                  typeof collection.collectionName === 'string'
                      ? collection.collectionName.trim()
                      : '';
              const collectionFileName =
                  typeof collection.collectionFileName === 'string'
                      ? path.basename(collection.collectionFileName)
                      : '';
              if (!collectionName || !collectionFileName) {
                  return [];
              }
              return [{
                  collectionName,
                  collectionFileName,
                  enabled: collection.enabled === true,
                  migrationVersion: Number.isFinite(collection.migrationVersion)
                      ? Number(collection.migrationVersion)
                      : 0,
                  legacySwitcherDisabled: collection.legacySwitcherDisabled === true,
                  rules: Array.isArray(collection.rules)
                      ? collection.rules
                            .map(normalizeRule)
                            .filter((rule): rule is WindowSceneSwitcherRule => rule !== null)
                      : [],
                  migrationWarning:
                      typeof collection.migrationWarning === 'string'
                          ? collection.migrationWarning
                          : undefined,
              }];
          })
        : [];
    return {
        schemaVersion: WINDOW_SCENE_SWITCHER_SCHEMA_VERSION,
        collections,
    };
}

function readConfig(): WindowSceneSwitcherConfig {
    return normalizeConfig(getWindowSceneSwitcherConfig());
}

function writeConfig(config: WindowSceneSwitcherConfig): void {
    setWindowSceneSwitcherConfig(normalizeConfig(config));
}

function findCollection(
    config: WindowSceneSwitcherConfig,
    collectionName: string
): WindowSceneSwitcherCollection | undefined {
    return config.collections.find(
        (collection) => collection.collectionName === collectionName
    );
}

function findSceneSources(sceneCollection: Record<string, any>): Map<string, any> {
    const sources = Array.isArray(sceneCollection.sources) ? sceneCollection.sources : [];
    return new Map(
        sources
            .filter((source: any) => typeof source?.name === 'string')
            .map((source: any) => [source.name, source])
    );
}

function extractSceneExecutable(
    sceneSource: any,
    sourcesByName: Map<string, any>
): string | undefined {
    const items = Array.isArray(sceneSource?.settings?.items)
        ? sceneSource.settings.items
        : [];
    for (const item of items) {
        const input = sourcesByName.get(item?.name);
        const windowValue = input?.settings?.window;
        if (typeof windowValue === 'string' && windowValue.trim()) {
            return normalizeExecutableName(windowValue.split(':').at(-1));
        }
    }
    return undefined;
}

function importLegacyRules(sceneCollection: Record<string, any>): WindowSceneSwitcherRule[] {
    const autoSwitcher = sceneCollection.modules?.[AUTO_SCENE_SWITCHER_MODULE_NAME];
    const switches = Array.isArray(autoSwitcher?.switches) ? autoSwitcher.switches : [];
    const sourcesByName = findSceneSources(sceneCollection);
    const sceneSources = new Map<string, any>(
        [...sourcesByName.values()]
            .filter((source: any) => source?.id === 'scene' && typeof source?.uuid === 'string')
            .map((source: any) => [source.name, source])
    );
    const patternsByScene = new Map<string, string[]>();

    for (const legacyRule of switches) {
        const sceneName =
            typeof legacyRule?.scene === 'string' ? legacyRule.scene.trim() : '';
        const titlePattern =
            typeof legacyRule?.window_title === 'string'
                ? legacyRule.window_title.trim()
                : '';
        if (!sceneName || !titlePattern || !sceneSources.has(sceneName)) {
            continue;
        }
        const patterns = patternsByScene.get(sceneName) ?? [];
        if (!patterns.includes(titlePattern)) {
            patterns.push(titlePattern);
        }
        patternsByScene.set(sceneName, patterns);
    }

    return [...patternsByScene.entries()].map(([sceneName, patterns]) => {
        const sceneSource = sceneSources.get(sceneName);
        const titlePattern =
            patterns.length === 1
                ? patterns[0]
                : patterns.map((pattern) => `(?:${pattern})`).join('|');
        return {
            sceneUuid: sceneSource.uuid,
            sceneName,
            titlePattern,
            executableName: extractSceneExecutable(sceneSource, sourcesByName),
            enabled: !validateWindowTitlePattern(titlePattern),
            source: 'obs-migration' as const,
        };
    });
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
        await fs.promises.rename(tempPath, filePath);
    } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function migrateLegacyWindowSceneSwitcherCollections(
    sceneCollectionDirectory: string
): Promise<WindowSceneSwitcherMigrationResult> {
    const result: WindowSceneSwitcherMigrationResult = {
        migratedCollections: [],
        blockedCollections: [],
    };
    if (!isWindows() || !fs.existsSync(sceneCollectionDirectory)) {
        return result;
    }

    const fileNames = (await fs.promises.readdir(sceneCollectionDirectory))
        .filter((fileName) => fileName.toLowerCase().endsWith('.json'));
    const parsedCollections: Array<{
        fileName: string;
        filePath: string;
        data: Record<string, any>;
        state: WindowSceneSwitcherCollection;
    }> = [];
    const config = readConfig();

    for (const fileName of fileNames) {
        const filePath = path.join(sceneCollectionDirectory, fileName);
        try {
            const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8')) as Record<string, any>;
            const collectionName = typeof data.name === 'string' ? data.name.trim() : '';
            if (!collectionName) {
                continue;
            }
            let state = findCollection(config, collectionName);
            if (!state) {
                const autoSwitcher = data.modules?.[AUTO_SCENE_SWITCHER_MODULE_NAME];
                state = {
                    collectionName,
                    collectionFileName: fileName,
                    enabled: autoSwitcher?.active === true,
                    migrationVersion: WINDOW_SCENE_SWITCHER_MIGRATION_VERSION,
                    legacySwitcherDisabled: autoSwitcher?.active !== true,
                    rules: importLegacyRules(data),
                };
                config.collections.push(state);
            } else {
                state.collectionFileName = fileName;
                if (state.migrationVersion < WINDOW_SCENE_SWITCHER_MIGRATION_VERSION) {
                    state.rules = importLegacyRules(data);
                    state.enabled = data.modules?.[AUTO_SCENE_SWITCHER_MODULE_NAME]?.active === true;
                    state.migrationVersion = WINDOW_SCENE_SWITCHER_MIGRATION_VERSION;
                }
            }
            parsedCollections.push({ fileName, filePath, data, state });
        } catch (error) {
            console.warn(`[SceneSwitcher] Failed to read OBS collection ${fileName}:`, error);
        }
    }

    // Persist imported rules before disabling OBS's checker. A failed JSON write therefore
    // leaves the legacy checker active while GSM remains gated by legacySwitcherDisabled.
    writeConfig(config);

    for (const collection of parsedCollections) {
        const autoSwitcher = collection.data.modules?.[AUTO_SCENE_SWITCHER_MODULE_NAME];
        if (!autoSwitcher || autoSwitcher.active !== true) {
            collection.state.legacySwitcherDisabled = true;
            collection.state.migrationWarning = undefined;
            result.migratedCollections.push(collection.state.collectionName);
            continue;
        }
        try {
            autoSwitcher.active = false;
            await writeJsonAtomically(collection.filePath, collection.data);
            collection.state.legacySwitcherDisabled = true;
            collection.state.migrationWarning = undefined;
            result.migratedCollections.push(collection.state.collectionName);
        } catch (error) {
            collection.state.legacySwitcherDisabled = false;
            collection.state.migrationWarning =
                error instanceof Error ? error.message : String(error);
            result.blockedCollections.push(collection.state.collectionName);
        }
    }
    writeConfig(config);
    return result;
}

export function upsertGeneratedWindowSceneRule(
    collectionName: string,
    collectionFileName: string,
    rule: Omit<WindowSceneSwitcherRule, 'enabled' | 'source'>
): WindowSceneSwitcherRule | null {
    if (!collectionName.trim() || !rule.sceneUuid.trim() || validateWindowTitlePattern(rule.titlePattern)) {
        return null;
    }
    const config = readConfig();
    let collection = findCollection(config, collectionName);
    if (!collection) {
        collection = {
            collectionName,
            collectionFileName: path.basename(collectionFileName) || `${collectionName}.json`,
            enabled: true,
            migrationVersion: WINDOW_SCENE_SWITCHER_MIGRATION_VERSION,
            legacySwitcherDisabled: true,
            rules: [],
        };
        config.collections.push(collection);
    }
    const saved: WindowSceneSwitcherRule = {
        ...rule,
        sceneUuid: rule.sceneUuid.trim(),
        sceneName: rule.sceneName.trim(),
        titlePattern: rule.titlePattern.trim(),
        executableName: normalizeExecutableName(rule.executableName) || undefined,
        enabled: true,
        source: 'gsm-generated',
    };
    const index = collection.rules.findIndex((candidate) => candidate.sceneUuid === saved.sceneUuid);
    if (index >= 0) {
        collection.rules[index] = saved;
    } else {
        collection.rules.push(saved);
    }
    writeConfig(config);
    return saved;
}

let dependencies: WindowSceneSwitcherRuntimeDependencies | null = null;
let activeCollectionName = '';
let hookStatus: WindowSceneSwitcherHookStatus = isWindows() ? 'starting' : 'unsupported';
let hookError = '';
let obsConnected = false;
let latestForeground: ForegroundWindowSnapshot | null = null;
let latestGeneration = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let switchChain = Promise.resolve();
let pendingAutoSceneUuid = '';
let pendingAutoSceneDeadline = 0;
let manualHoldContextKey = '';
let resolvedConflictContextKey = '';
let pendingConflict: WindowSceneSwitcherConflict | null = null;
let conflictWindow: BrowserWindow | null = null;
let ipcRegistered = false;

function notifyStateChanged(): void {
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
            window.webContents.send('scene-switcher.stateChanged');
        }
    }
}

function getActiveCollection(): WindowSceneSwitcherCollection | undefined {
    return findCollection(readConfig(), activeCollectionName);
}

function isOwnWindowProcess(pid: number): boolean {
    if (!pid) {
        return false;
    }
    if (pid === process.pid) {
        return true;
    }
    return BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.webContents.getOSProcessId() === pid
    );
}

function closeConflictWindow(): void {
    if (conflictWindow && !conflictWindow.isDestroyed()) {
        conflictWindow.destroy();
    }
    conflictWindow = null;
}

function cancelPendingConflict(restoreForeground: boolean): void {
    const conflict = pendingConflict;
    pendingConflict = null;
    closeConflictWindow();
    if (restoreForeground && conflict) {
        dependencies?.restoreForegroundWindow(conflict.foreground.hwnd);
    }
}

async function showConflictPicker(conflict: WindowSceneSwitcherConflict): Promise<void> {
    pendingConflict = conflict;
    closeConflictWindow();
    const picker = new BrowserWindow({
        width: 560,
        height: 420,
        minWidth: 460,
        minHeight: 320,
        show: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        title: 'GameSentenceMiner',
        webPreferences: getSecureWebPreferences(),
    });
    conflictWindow = picker;
    picker.once('ready-to-show', () => {
        if (!picker.isDestroyed()) {
            picker.show();
            picker.focus();
        }
    });
    picker.on('closed', () => {
        if (conflictWindow === picker) {
            conflictWindow = null;
        }
        if (pendingConflict?.requestId === conflict.requestId) {
            resolvedConflictContextKey = getForegroundWindowContextKey(conflict.foreground);
            pendingConflict = null;
            dependencies?.restoreForegroundWindow(conflict.foreground.hwnd);
        }
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
        const url = new URL(devServerUrl);
        url.searchParams.set('window', 'scene-switcher-picker');
        await picker.loadURL(url.toString());
    } else {
        await picker.loadFile(getRendererEntryPath(), {
            query: { window: 'scene-switcher-picker' },
        });
    }
}

async function performSceneSwitch(sceneUuid: string, generation: number): Promise<void> {
    if (!dependencies || generation !== latestGeneration || !obsConnected) {
        return;
    }
    const current = await dependencies.getCurrentScene();
    if (generation !== latestGeneration || current.id === sceneUuid) {
        return;
    }
    pendingAutoSceneUuid = sceneUuid;
    pendingAutoSceneDeadline = Date.now() + SELF_SWITCH_EVENT_WINDOW_MS;
    await dependencies.switchScene(sceneUuid);
}

async function evaluateForeground(generation: number): Promise<void> {
    if (
        generation !== latestGeneration ||
        !dependencies ||
        !latestForeground ||
        !obsConnected
    ) {
        return;
    }
    const collection = getActiveCollection();
    if (!collection?.enabled || !collection.legacySwitcherDisabled) {
        return;
    }
    const contextKey = getForegroundWindowContextKey(latestForeground);
    if (contextKey === manualHoldContextKey || contextKey === resolvedConflictContextKey) {
        return;
    }
    const candidates = findWindowSceneSwitcherCandidates(collection.rules, latestForeground);
    if (candidates.length === 0) {
        return;
    }
    if (candidates.length > 1) {
        if (
            pendingConflict &&
            getForegroundWindowContextKey(pendingConflict.foreground) === contextKey
        ) {
            return;
        }
        await showConflictPicker({
            requestId: randomUUID(),
            foreground: latestForeground,
            candidates,
        });
        return;
    }
    switchChain = switchChain
        .then(() => performSceneSwitch(candidates[0].sceneUuid, generation))
        .catch((error) => console.warn('[SceneSwitcher] Failed to switch OBS scene:', error));
    await switchChain;
}

function scheduleEvaluation(): void {
    if (settleTimer) {
        clearTimeout(settleTimer);
    }
    const generation = latestGeneration;
    settleTimer = setTimeout(() => {
        settleTimer = null;
        void evaluateForeground(generation);
    }, FOREGROUND_SETTLE_MS);
}

export function configureWindowSceneSwitcherRuntime(
    nextDependencies: WindowSceneSwitcherRuntimeDependencies
): void {
    dependencies = nextDependencies;
    obsConnected = nextDependencies.isOBSConnected();
}

export function handleForegroundWindowSnapshot(snapshot: ForegroundWindowSnapshot): void {
    if (!isWindows()) {
        return;
    }
    // Receiving a valid snapshot proves that the hook is operational even if its
    // separate startup-status message was missed or arrived out of order.
    if (hookStatus !== 'running' || hookError) {
        hookStatus = 'running';
        hookError = '';
    }
    if (isOwnWindowProcess(snapshot.pid)) {
        notifyStateChanged();
        return;
    }
    if (
        latestForeground &&
        snapshot.sequence <= latestForeground.sequence &&
        snapshot.capturedAt <= latestForeground.capturedAt
    ) {
        return;
    }
    const previousKey = latestForeground
        ? getForegroundWindowContextKey(latestForeground)
        : '';
    const nextKey = getForegroundWindowContextKey(snapshot);
    latestForeground = snapshot;
    latestGeneration += 1;
    if (previousKey !== nextKey) {
        manualHoldContextKey = '';
        resolvedConflictContextKey = '';
        cancelPendingConflict(false);
    }
    scheduleEvaluation();
    notifyStateChanged();
}

export function setForegroundWindowHookStatus(
    status: WindowSceneSwitcherHookStatus,
    error = ''
): void {
    if (status === 'starting' && latestForeground) {
        status = 'running';
        error = '';
    }
    hookStatus = status;
    hookError = error;
    notifyStateChanged();
}

export async function handleOBSConnected(): Promise<void> {
    if (!dependencies) {
        return;
    }
    // OBS may emit its initial program-scene event while we are still loading
    // the collection. Keep automatic switching inactive during that window so
    // the startup event is not mistaken for a user's manual scene override.
    obsConnected = false;
    activeCollectionName = await dependencies.getCurrentCollectionName();
    const scenes = await dependencies.getScenes();
    if (scenes !== null) {
        await reconcileWindowSceneSwitcherRules(scenes);
    }
    obsConnected = true;
    dependencies.requestForegroundSnapshot();
    scheduleEvaluation();
    notifyStateChanged();
}

export function handleOBSDisconnected(): void {
    obsConnected = false;
    cancelPendingConflict(false);
    notifyStateChanged();
}

export async function handleOBSCollectionChanged(collectionName: string): Promise<void> {
    activeCollectionName = collectionName.trim();
    manualHoldContextKey = '';
    resolvedConflictContextKey = '';
    cancelPendingConflict(false);
    if (dependencies && obsConnected) {
        const scenes = await dependencies.getScenes();
        if (scenes !== null) {
            await reconcileWindowSceneSwitcherRules(scenes);
        }
        scheduleEvaluation();
    }
    notifyStateChanged();
}

export function handleOBSSceneChanged(scene: ObsSceneRef): void {
    if (!obsConnected) {
        return;
    }
    if (
        pendingAutoSceneUuid === scene.id &&
        Date.now() <= pendingAutoSceneDeadline
    ) {
        pendingAutoSceneUuid = '';
        pendingAutoSceneDeadline = 0;
        return;
    }
    if (latestForeground) {
        manualHoldContextKey = getForegroundWindowContextKey(latestForeground);
    }
}

export function renameWindowSceneSwitcherRule(sceneUuid: string, sceneName: string): void {
    const config = readConfig();
    let changed = false;
    for (const collection of config.collections) {
        for (const rule of collection.rules) {
            if (rule.sceneUuid === sceneUuid && rule.sceneName !== sceneName) {
                rule.sceneName = sceneName;
                changed = true;
            }
        }
    }
    if (changed) {
        writeConfig(config);
        notifyStateChanged();
    }
}

export function removeWindowSceneSwitcherRule(sceneUuid: string): void {
    const config = readConfig();
    let changed = false;
    for (const collection of config.collections) {
        const nextRules = collection.rules.filter((rule) => rule.sceneUuid !== sceneUuid);
        changed = changed || nextRules.length !== collection.rules.length;
        collection.rules = nextRules;
    }
    if (changed) {
        writeConfig(config);
        notifyStateChanged();
    }
}

export async function reconcileWindowSceneSwitcherRules(scenes: ObsSceneRef[]): Promise<void> {
    if (!activeCollectionName) {
        return;
    }
    const config = readConfig();
    const collection = findCollection(config, activeCollectionName);
    if (!collection) {
        return;
    }
    const scenesById = new Map(scenes.map((scene) => [scene.id, scene.name]));
    collection.rules = collection.rules.flatMap((rule) => {
        const currentName = scenesById.get(rule.sceneUuid);
        return currentName ? [{ ...rule, sceneName: currentName }] : [];
    });
    writeConfig(config);
    notifyStateChanged();
}

async function getState(sceneUuid = ''): Promise<WindowSceneSwitcherState> {
    if (!activeCollectionName && dependencies && obsConnected) {
        activeCollectionName = await dependencies.getCurrentCollectionName();
    }
    const collection = getActiveCollection();
    return {
        supported: isWindows(),
        hookStatus,
        hookError: hookError || undefined,
        obsConnected,
        collectionName: activeCollectionName,
        collectionEnabled: collection?.enabled === true,
        migrationReady: collection?.legacySwitcherDisabled === true,
        rule:
            collection?.rules.find((candidate) => candidate.sceneUuid === sceneUuid) ?? null,
        foreground: latestForeground,
    };
}

function saveManualRule(payload: SaveWindowSceneSwitcherRulePayload): WindowSceneSwitcherRule {
    const error = validateWindowTitlePattern(payload.titlePattern);
    if (error) {
        throw new Error(error);
    }
    if (!activeCollectionName || !payload.sceneUuid.trim() || !payload.sceneName.trim()) {
        throw new Error('A current OBS scene collection and scene are required.');
    }
    const config = readConfig();
    let collection = findCollection(config, activeCollectionName);
    if (!collection) {
        collection = {
            collectionName: activeCollectionName,
            collectionFileName: `${activeCollectionName.replace(/\s+/g, '_')}.json`,
            enabled: true,
            migrationVersion: WINDOW_SCENE_SWITCHER_MIGRATION_VERSION,
            legacySwitcherDisabled: true,
            rules: [],
        };
        config.collections.push(collection);
    }
    const rule: WindowSceneSwitcherRule = {
        sceneUuid: payload.sceneUuid.trim(),
        sceneName: payload.sceneName.trim(),
        titlePattern: payload.titlePattern.trim(),
        executableName: normalizeExecutableName(payload.executableName) || undefined,
        enabled: payload.enabled,
        source: 'manual',
    };
    const index = collection.rules.findIndex(
        (candidate) => candidate.sceneUuid === rule.sceneUuid
    );
    if (index >= 0) {
        collection.rules[index] = rule;
    } else {
        collection.rules.push(rule);
    }
    writeConfig(config);
    scheduleEvaluation();
    notifyStateChanged();
    return rule;
}

export function registerWindowSceneSwitcherIPC(): void {
    if (ipcRegistered) {
        return;
    }
    ipcRegistered = true;

    ipcMain.handle('scene-switcher.getState', async (_event, sceneUuid?: string) =>
        getState(typeof sceneUuid === 'string' ? sceneUuid : '')
    );
    ipcMain.handle('scene-switcher.saveRule', async (_event, payload) => {
        try {
            return { success: true, rule: saveManualRule(payload) };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    ipcMain.handle('scene-switcher.removeRule', async (_event, sceneUuid?: string) => {
        removeWindowSceneSwitcherRule(String(sceneUuid ?? ''));
        return { success: true };
    });
    ipcMain.handle('scene-switcher.setCollectionEnabled', async (_event, enabled?: boolean) => {
        const config = readConfig();
        const collection = findCollection(config, activeCollectionName);
        if (!collection) {
            return { success: false };
        }
        collection.enabled = enabled === true;
        writeConfig(config);
        scheduleEvaluation();
        notifyStateChanged();
        return { success: true };
    });
    ipcMain.handle('scene-switcher.suggestRule', async (_event, sceneUuid?: string) => {
        if (!dependencies || typeof sceneUuid !== 'string') {
            return null;
        }
        return dependencies.suggestRule(sceneUuid);
    });
    ipcMain.handle('scene-switcher.testRule', async (_event, payload) => {
        const rule: WindowSceneSwitcherRule = {
            sceneUuid: 'test',
            sceneName: 'test',
            titlePattern: String(payload?.titlePattern ?? ''),
            executableName: normalizeExecutableName(payload?.executableName) || undefined,
            enabled: true,
            source: 'manual',
        };
        if (!latestForeground) {
            return {
                matched: false,
                executableVerified: false,
                foreground: null,
            } satisfies WindowSceneSwitcherTestResult;
        }
        const result = matchWindowSceneRule(rule, latestForeground);
        return { ...result, foreground: latestForeground } satisfies WindowSceneSwitcherTestResult;
    });
    ipcMain.handle('scene-switcher.getPendingConflict', async () => pendingConflict);
    ipcMain.handle(
        'scene-switcher.resolveConflict',
        async (_event, payload?: { requestId?: string; sceneUuid?: string | null }) => {
            const conflict = pendingConflict;
            if (!conflict || payload?.requestId !== conflict.requestId) {
                return { success: false, stale: true };
            }
            const sceneUuid =
                typeof payload.sceneUuid === 'string' ? payload.sceneUuid : '';
            if (
                sceneUuid &&
                !conflict.candidates.some((candidate) => candidate.sceneUuid === sceneUuid)
            ) {
                return { success: false, stale: true };
            }
            resolvedConflictContextKey = getForegroundWindowContextKey(conflict.foreground);
            pendingConflict = null;
            closeConflictWindow();
            if (sceneUuid) {
                const generation = latestGeneration;
                switchChain = switchChain
                    .then(() => performSceneSwitch(sceneUuid, generation))
                    .catch((error) =>
                        console.warn('[SceneSwitcher] Conflict scene switch failed:', error)
                    );
                await switchChain;
            }
            dependencies?.restoreForegroundWindow(conflict.foreground.hwnd);
            return { success: true };
        }
    );
}

export function shutdownWindowSceneSwitcher(): void {
    if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
    }
    pendingConflict = null;
    closeConflictWindow();
}
