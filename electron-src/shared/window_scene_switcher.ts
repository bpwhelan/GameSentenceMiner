export const WINDOW_SCENE_SWITCHER_SCHEMA_VERSION = 1;
export const WINDOW_SCENE_SWITCHER_MIGRATION_VERSION = 1;

export type WindowSceneSwitcherRuleSource =
    | 'obs-migration'
    | 'gsm-generated'
    | 'manual';

export interface WindowSceneSwitcherRule {
    sceneUuid: string;
    sceneName: string;
    titlePattern: string;
    executableName?: string;
    enabled: boolean;
    source: WindowSceneSwitcherRuleSource;
}

export interface WindowSceneSwitcherCollection {
    collectionName: string;
    collectionFileName: string;
    enabled: boolean;
    migrationVersion: number;
    legacySwitcherDisabled: boolean;
    rules: WindowSceneSwitcherRule[];
    migrationWarning?: string;
}

export interface WindowSceneSwitcherConfig {
    schemaVersion: number;
    collections: WindowSceneSwitcherCollection[];
}

export interface ForegroundWindowSnapshot {
    hwnd: string;
    pid: number;
    title: string;
    executablePath?: string;
    executableName?: string;
    capturedAt: number;
    sequence: number;
}

export interface WindowSceneSwitcherCandidate {
    sceneUuid: string;
    sceneName: string;
    titlePattern: string;
    executableName?: string;
    executableVerified: boolean;
}

export interface WindowSceneSwitcherConflict {
    requestId: string;
    foreground: ForegroundWindowSnapshot;
    candidates: WindowSceneSwitcherCandidate[];
}

export type WindowSceneSwitcherHookStatus =
    | 'unsupported'
    | 'starting'
    | 'running'
    | 'stopped'
    | 'failed';

export interface WindowSceneSwitcherState {
    supported: boolean;
    hookStatus: WindowSceneSwitcherHookStatus;
    hookError?: string;
    obsConnected: boolean;
    collectionName: string;
    collectionEnabled: boolean;
    migrationReady: boolean;
    rule: WindowSceneSwitcherRule | null;
    foreground: ForegroundWindowSnapshot | null;
}

export interface SaveWindowSceneSwitcherRulePayload {
    sceneUuid: string;
    sceneName: string;
    titlePattern: string;
    executableName?: string;
    enabled: boolean;
}

export interface WindowSceneSwitcherTestResult {
    matched: boolean;
    executableVerified: boolean;
    error?: string;
    foreground: ForegroundWindowSnapshot | null;
}

export function emptyWindowSceneSwitcherConfig(): WindowSceneSwitcherConfig {
    return {
        schemaVersion: WINDOW_SCENE_SWITCHER_SCHEMA_VERSION,
        collections: [],
    };
}

export function normalizeExecutableName(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim().split(/[\\/]/).pop()?.trim() ?? '';
}

export function validateWindowTitlePattern(pattern: unknown): string | null {
    if (typeof pattern !== 'string' || !pattern.trim()) {
        return 'A window title regular expression is required.';
    }
    if (pattern.length > 4096) {
        return 'The window title regular expression is too long.';
    }
    try {
        new RegExp(pattern, 'i');
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

export function getForegroundWindowContextKey(snapshot: ForegroundWindowSnapshot): string {
    // Holds and conflict suppression intentionally survive executable metadata
    // changing from unavailable to available. Only a foreground HWND or title
    // change is a new user-visible context.
    return JSON.stringify([
        snapshot.hwnd,
        snapshot.title,
    ]);
}

export function matchWindowSceneRule(
    rule: WindowSceneSwitcherRule,
    snapshot: ForegroundWindowSnapshot
): { matched: boolean; executableVerified: boolean; error?: string } {
    const error = validateWindowTitlePattern(rule.titlePattern);
    if (error) {
        return { matched: false, executableVerified: false, error };
    }
    if (!rule.enabled || !new RegExp(rule.titlePattern, 'i').test(snapshot.title)) {
        return { matched: false, executableVerified: false };
    }

    const requiredExecutable = normalizeExecutableName(rule.executableName).toLowerCase();
    const foregroundExecutable = normalizeExecutableName(
        snapshot.executableName ?? snapshot.executablePath
    ).toLowerCase();

    if (!requiredExecutable) {
        return { matched: true, executableVerified: false };
    }
    if (!foregroundExecutable) {
        return { matched: true, executableVerified: false };
    }
    return {
        matched: requiredExecutable === foregroundExecutable,
        executableVerified: true,
    };
}

export function findWindowSceneSwitcherCandidates(
    rules: WindowSceneSwitcherRule[],
    snapshot: ForegroundWindowSnapshot
): WindowSceneSwitcherCandidate[] {
    const candidates = new Map<string, WindowSceneSwitcherCandidate>();
    for (const rule of rules) {
        const result = matchWindowSceneRule(rule, snapshot);
        if (!result.matched || candidates.has(rule.sceneUuid)) {
            continue;
        }
        candidates.set(rule.sceneUuid, {
            sceneUuid: rule.sceneUuid,
            sceneName: rule.sceneName,
            titlePattern: rule.titlePattern,
            executableName: normalizeExecutableName(rule.executableName) || undefined,
            executableVerified: result.executableVerified,
        });
    }
    return [...candidates.values()].sort((left, right) =>
        left.sceneName.localeCompare(right.sceneName)
    );
}
