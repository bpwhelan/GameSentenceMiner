import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import log from 'electron-log/main.js';

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
const FOREGROUND_RECONCILE_INTERVAL_MS = 1_000;
const SELF_SWITCH_EVENT_WINDOW_MS = 3_000;
const OBS_RECONCILE_RETRY_MIN_MS = 1_000;
const OBS_RECONCILE_RETRY_MAX_MS = 30_000;
const DIAGNOSTIC_REPEAT_MS = 30_000;
const MAX_DIAGNOSTIC_KEYS = 500;

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
            log.warn(`[SceneSwitcher] Failed to read OBS collection ${fileName}:`, error);
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
    if (
        activeCollectionName === collectionName &&
        latestForeground &&
        matchWindowSceneRule(saved, latestForeground).matched
    ) {
        // Scene creation changes OBS before this generated rule is persisted.
        // That event can look like a manual override for the already-focused
        // game, so release only that hold and immediately reconcile the rule.
        manualHoldContextKey = '';
        logDiagnostic(
            `generated-rule:${collectionName}:${saved.sceneUuid}`,
            `Saved generated rule for scene "${saved.sceneName}" and released the stale manual hold for ${describeForeground(latestForeground)}.`
        );
        scheduleEvaluation();
    }
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
let startupSceneSyncPending = false;
let startupSceneSyncToken = 0;
let obsReconcileRetryTimer: ReturnType<typeof setTimeout> | null = null;
let obsReconcileRetryDelayMs = OBS_RECONCILE_RETRY_MIN_MS;
let foregroundReconcileTimer: ReturnType<typeof setInterval> | null = null;
let foregroundReconcileInFlight = false;
let latestDecisionKey = '';
const diagnosticLastLoggedAt = new Map<string, number>();

function describeForeground(snapshot: ForegroundWindowSnapshot): string {
    const executable = normalizeExecutableName(
        snapshot.executableName ?? snapshot.executablePath
    );
    return `window title=${JSON.stringify(snapshot.title)}, hwnd=${snapshot.hwnd}, executable=${JSON.stringify(executable || 'unknown')}`;
}

function getForegroundEvaluationKey(snapshot: ForegroundWindowSnapshot): string {
    return JSON.stringify([
        snapshot.hwnd,
        snapshot.pid,
        snapshot.title,
        normalizeExecutableName(snapshot.executableName ?? snapshot.executablePath).toLowerCase(),
    ]);
}

function logDiagnostic(
    key: string,
    message: string,
    level: 'info' | 'warn' = 'info'
): void {
    const now = Date.now();
    const lastLoggedAt = diagnosticLastLoggedAt.get(key);
    if (
        key === latestDecisionKey ||
        (lastLoggedAt !== undefined && now - lastLoggedAt < DIAGNOSTIC_REPEAT_MS)
    ) {
        latestDecisionKey = key;
        return;
    }
    latestDecisionKey = key;
    diagnosticLastLoggedAt.set(key, now);
    if (diagnosticLastLoggedAt.size > MAX_DIAGNOSTIC_KEYS) {
        const oldestKey = diagnosticLastLoggedAt.keys().next().value;
        if (oldestKey !== undefined) {
            diagnosticLastLoggedAt.delete(oldestKey);
        }
    }
    log[level](`[SceneSwitcher] ${message}`);
}

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
    if (generation !== latestGeneration) {
        return;
    }
    const targetName =
        getActiveCollection()?.rules.find((rule) => rule.sceneUuid === sceneUuid)?.sceneName ??
        sceneUuid;
    if (current.id === sceneUuid) {
        logDiagnostic(
            `current:${sceneUuid}:${generation}`,
            `OBS is already on the matched scene "${targetName}" for ${describeForeground(latestForeground!)}.`
        );
        return;
    }
    logDiagnostic(
        `switch:${current.id}:${sceneUuid}:${generation}`,
        `Switching OBS from "${current.name}" to matched scene "${targetName}" for ${describeForeground(latestForeground!)}.`
    );
    expectWindowSceneSwitcherOBSSceneChange(sceneUuid);
    await dependencies.switchScene(sceneUuid);
    if (generation !== latestGeneration || !obsConnected) {
        return;
    }
    const verified = await dependencies.getCurrentScene();
    if (generation !== latestGeneration) {
        return;
    }
    if (verified.id === sceneUuid) {
        logDiagnostic(
            `verified:${sceneUuid}:${generation}`,
            `Verified OBS switched to "${targetName}".`
        );
        return;
    }
    logDiagnostic(
        `unverified:${verified.id}:${sceneUuid}:${generation}`,
        `OBS accepted the switch to "${targetName}" but still reports "${verified.name}"; the 1-second reconciliation loop will retry.`,
        'warn'
    );
}

async function evaluateForeground(generation: number): Promise<void> {
    if (generation !== latestGeneration || !dependencies) {
        return;
    }
    if (!obsConnected) {
        logDiagnostic('waiting:obs', 'Waiting for a healthy OBS connection.');
        return;
    }
    if (!latestForeground) {
        logDiagnostic('waiting:foreground', 'Waiting for a foreground-window snapshot.');
        return;
    }
    const collection = getActiveCollection();
    if (!collection) {
        logDiagnostic(
            `disabled:no-collection:${activeCollectionName}`,
            `No Scene Switcher configuration exists for OBS collection ${JSON.stringify(activeCollectionName || 'unknown')}.`
        );
        return;
    }
    if (!collection.enabled) {
        logDiagnostic(
            `disabled:collection:${collection.collectionName}`,
            `Scene switching is disabled for OBS collection "${collection.collectionName}".`
        );
        return;
    }
    if (!collection.legacySwitcherDisabled) {
        logDiagnostic(
            `disabled:migration:${collection.collectionName}`,
            `Scene switching is blocked because the legacy OBS switcher could not be disabled for collection "${collection.collectionName}".`,
            'warn'
        );
        return;
    }
    const contextKey = getForegroundWindowContextKey(latestForeground);
    if (contextKey === manualHoldContextKey) {
        logDiagnostic(
            `hold:manual:${contextKey}`,
            `Keeping the manually selected OBS scene until focus leaves ${describeForeground(latestForeground)}.`
        );
        return;
    }
    if (contextKey === resolvedConflictContextKey) {
        logDiagnostic(
            `hold:conflict:${contextKey}`,
            `Keeping the resolved scene-choice conflict until focus leaves ${describeForeground(latestForeground)}.`
        );
        return;
    }
    const candidates = findWindowSceneSwitcherCandidates(collection.rules, latestForeground);
    if (candidates.length === 0) {
        logDiagnostic(
            `unmatched:${collection.collectionName}:${getForegroundEvaluationKey(latestForeground)}`,
            `No enabled rule matched ${describeForeground(latestForeground)} in collection "${collection.collectionName}".`
        );
        return;
    }
    if (candidates.length > 1) {
        if (
            pendingConflict &&
            getForegroundWindowContextKey(pendingConflict.foreground) === contextKey
        ) {
            return;
        }
        logDiagnostic(
            `conflict:${contextKey}:${candidates.map((candidate) => candidate.sceneUuid).join(',')}`,
            `${candidates.length} scene rules matched ${describeForeground(latestForeground)}; opening the conflict picker.`,
            'warn'
        );
        await showConflictPicker({
            requestId: randomUUID(),
            foreground: latestForeground,
            candidates,
        });
        return;
    }
    switchChain = switchChain
        .then(() => performSceneSwitch(candidates[0].sceneUuid, generation))
        .catch((error) => log.warn('[SceneSwitcher] Failed to switch OBS scene:', error));
    await switchChain;
}

function scheduleEvaluation(): void {
    if (settleTimer) {
        clearTimeout(settleTimer);
    }
    const generation = latestGeneration;
    const startupTokenToComplete =
        startupSceneSyncPending && obsConnected ? startupSceneSyncToken : 0;
    settleTimer = setTimeout(() => {
        settleTimer = null;
        // OBS can emit its initial scene event just after the connection
        // reconciliation finishes. Keep that short startup window from
        // becoming a manual-scene hold for the already-focused game.
        if (
            startupTokenToComplete !== 0 &&
            startupTokenToComplete === startupSceneSyncToken
        ) {
            startupSceneSyncPending = false;
        }
        void evaluateForeground(generation);
    }, FOREGROUND_SETTLE_MS);
}

async function runForegroundReconciliation(): Promise<void> {
    if (!dependencies || foregroundReconcileInFlight) {
        return;
    }
    foregroundReconcileInFlight = true;
    try {
        const runtimeOBSConnected = dependencies.isOBSConnected();
        if (!runtimeOBSConnected) {
            if (obsConnected || startupSceneSyncPending) {
                logDiagnostic(
                    'runtime:obs-lost',
                    'The OBS runtime is disconnected; pausing scene reconciliation.',
                    'warn'
                );
                handleOBSDisconnected();
            }
            return;
        }
        if (!obsConnected) {
            if (!startupSceneSyncPending) {
                logDiagnostic(
                    'runtime:obs-recovered',
                    'The 1-second reconciliation loop found a healthy OBS connection; reloading the active collection.'
                );
                await handleOBSConnected();
            }
            return;
        }
        // Force-publishing the current HWND makes the hook an optimization
        // rather than a single point of failure. The resulting snapshot also
        // re-verifies the actual OBS program scene every second.
        dependencies.requestForegroundSnapshot();
    } catch (error) {
        logDiagnostic(
            `runtime:error:${error instanceof Error ? error.message : String(error)}`,
            `Continuous reconciliation failed and will retry: ${error instanceof Error ? error.message : String(error)}`,
            'warn'
        );
    } finally {
        foregroundReconcileInFlight = false;
    }
}

function startForegroundReconciliation(): void {
    if (foregroundReconcileTimer) {
        clearInterval(foregroundReconcileTimer);
    }
    foregroundReconcileTimer = setInterval(() => {
        void runForegroundReconciliation();
    }, FOREGROUND_RECONCILE_INTERVAL_MS);
}

function clearOBSReconcileRetry(resetDelay: boolean): void {
    if (obsReconcileRetryTimer) {
        clearTimeout(obsReconcileRetryTimer);
        obsReconcileRetryTimer = null;
    }
    if (resetDelay) {
        obsReconcileRetryDelayMs = OBS_RECONCILE_RETRY_MIN_MS;
    }
}

function scheduleOBSReconciliationRetry(): void {
    if (
        obsReconcileRetryTimer ||
        !dependencies ||
        !dependencies.isOBSConnected()
    ) {
        return;
    }
    const delay = obsReconcileRetryDelayMs;
    obsReconcileRetryDelayMs = Math.min(
        obsReconcileRetryDelayMs * 2,
        OBS_RECONCILE_RETRY_MAX_MS
    );
    obsReconcileRetryTimer = setTimeout(() => {
        obsReconcileRetryTimer = null;
        void handleOBSConnected().catch((error) =>
            log.warn('[SceneSwitcher] OBS reconciliation retry failed:', error)
        );
    }, delay);
}

function reconcileHealthyOBSConnection(reason: string): void {
    if (
        obsConnected ||
        startupSceneSyncPending ||
        !dependencies?.isOBSConnected()
    ) {
        return;
    }
    void handleOBSConnected().catch((error) =>
        log.warn(`[SceneSwitcher] Failed to reconcile ${reason}:`, error)
    );
}

export function configureWindowSceneSwitcherRuntime(
    nextDependencies: WindowSceneSwitcherRuntimeDependencies
): void {
    dependencies = nextDependencies;
    obsConnected = nextDependencies.isOBSConnected();
    startForegroundReconciliation();
    logDiagnostic(
        `runtime:configured:${obsConnected}`,
        `Runtime configured; OBS connected=${obsConnected}; foreground and scene state will reconcile every ${FOREGROUND_RECONCILE_INTERVAL_MS}ms.`
    );
    if (obsConnected) {
        // OBS may have connected before the scene-switcher runtime was wired
        // (for example while the main window was being created). Reconcile the
        // collection now instead of leaving activeCollectionName empty.
        void handleOBSConnected().catch((error) =>
            log.warn('[SceneSwitcher] Failed to reconcile after runtime setup:', error)
        );
    }
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
        // Own windows are intentionally not candidates, but they are still a
        // real focus boundary. Without this, a manual hold created during scene
        // setup can remain attached to the previously focused game forever.
        latestGeneration += 1;
        if (!pendingConflict) {
            const releasedHold = Boolean(manualHoldContextKey || resolvedConflictContextKey);
            manualHoldContextKey = '';
            resolvedConflictContextKey = '';
            if (releasedHold) {
                logDiagnostic(
                    `own-focus:released:${snapshot.pid}`,
                    'Focus moved to a GameSentenceMiner window; stale scene holds were released.'
                );
            }
        }
        reconcileHealthyOBSConnection('after a foreground-window event');
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
    const previousEvaluationKey = latestForeground
        ? getForegroundEvaluationKey(latestForeground)
        : '';
    const nextKey = getForegroundWindowContextKey(snapshot);
    const nextEvaluationKey = getForegroundEvaluationKey(snapshot);
    latestForeground = snapshot;
    if (previousEvaluationKey !== nextEvaluationKey) {
        latestGeneration += 1;
        logDiagnostic(
            `foreground:${nextEvaluationKey}`,
            `Observed foreground ${describeForeground(snapshot)}.`
        );
    }
    if (previousKey !== nextKey) {
        manualHoldContextKey = '';
        resolvedConflictContextKey = '';
        cancelPendingConflict(false);
    }
    reconcileHealthyOBSConnection('after a foreground-window event');
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
    logDiagnostic(
        `hook:${status}:${error}`,
        error
            ? `Foreground hook status=${status}: ${error}`
            : `Foreground hook status=${status}.`,
        status === 'failed' ? 'warn' : 'info'
    );
    notifyStateChanged();
}

export async function handleOBSConnected(): Promise<void> {
    if (!dependencies || startupSceneSyncPending) {
        return;
    }
    clearOBSReconcileRetry(false);
    // OBS may emit its initial program-scene event while we are still loading
    // the collection. Keep automatic switching inactive during that window so
    // the startup event is not mistaken for a user's manual scene override.
    const syncToken = startupSceneSyncToken + 1;
    startupSceneSyncToken = syncToken;
    obsConnected = false;
    startupSceneSyncPending = true;
    try {
        const collectionName = await dependencies.getCurrentCollectionName();
        if (syncToken !== startupSceneSyncToken) {
            return;
        }
        activeCollectionName = collectionName;
        const scenes = await dependencies.getScenes();
        if (syncToken !== startupSceneSyncToken) {
            return;
        }
        if (scenes !== null) {
            await reconcileWindowSceneSwitcherRules(scenes);
        }
        if (syncToken !== startupSceneSyncToken) {
            return;
        }
        obsConnected = true;
        clearOBSReconcileRetry(true);
        const collection = getActiveCollection();
        logDiagnostic(
            `obs-ready:${activeCollectionName}:${scenes?.length ?? 'unknown'}`,
            `OBS reconciliation is ready for collection ${JSON.stringify(activeCollectionName)} with ${collection?.rules.length ?? 0} saved rule(s).`
        );
        dependencies.requestForegroundSnapshot();
        scheduleEvaluation();
        notifyStateChanged();
    } catch (error) {
        if (syncToken === startupSceneSyncToken) {
            obsConnected = false;
            startupSceneSyncPending = false;
            scheduleOBSReconciliationRetry();
            notifyStateChanged();
        }
        throw error;
    }
}

export function handleOBSDisconnected(): void {
    startupSceneSyncToken += 1;
    obsConnected = false;
    startupSceneSyncPending = false;
    clearOBSReconcileRetry(true);
    cancelPendingConflict(false);
    logDiagnostic('obs:disconnected', 'OBS disconnected; scene switching is paused.', 'warn');
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

export function expectWindowSceneSwitcherOBSSceneChange(sceneUuid: string): void {
    const normalizedSceneUuid = sceneUuid.trim();
    if (!normalizedSceneUuid) {
        return;
    }
    pendingAutoSceneUuid = normalizedSceneUuid;
    pendingAutoSceneDeadline = Date.now() + SELF_SWITCH_EVENT_WINDOW_MS;
}

export function handleOBSSceneChanged(scene: ObsSceneRef): void {
    if (!obsConnected || startupSceneSyncPending) {
        return;
    }
    if (
        pendingAutoSceneUuid === scene.id &&
        Date.now() <= pendingAutoSceneDeadline
    ) {
        pendingAutoSceneUuid = '';
        pendingAutoSceneDeadline = 0;
        logDiagnostic(
            `scene:auto-event:${scene.id}`,
            `Observed the expected automatic OBS scene change to "${scene.name}".`
        );
        return;
    }
    if (latestForeground) {
        manualHoldContextKey = getForegroundWindowContextKey(latestForeground);
        logDiagnostic(
            `scene:manual:${scene.id}:${manualHoldContextKey}`,
            `Observed an external OBS scene change to "${scene.name}"; holding it until focus leaves ${describeForeground(latestForeground)}.`
        );
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
                        log.warn('[SceneSwitcher] Conflict scene switch failed:', error)
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
    if (foregroundReconcileTimer) {
        clearInterval(foregroundReconcileTimer);
        foregroundReconcileTimer = null;
    }
    foregroundReconcileInFlight = false;
    clearOBSReconcileRetry(true);
    pendingConflict = null;
    closeConflictWindow();
    dependencies = null;
    latestDecisionKey = '';
    diagnosticLastLoggedAt.clear();
}
