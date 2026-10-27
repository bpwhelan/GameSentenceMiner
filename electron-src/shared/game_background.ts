export interface GameBackgroundOptions {
    enabled: boolean;
    keepRendering: boolean;
    blockGamepad: boolean;
}

export interface GameBackgroundTarget {
    pid: number;
    hwnd: string;
    path: string;
    title: string;
    arch: 'x86' | 'x64';
    specialK: boolean;
}

export interface GameBackgroundTelemetry {
    effective: number;
    focusHooks: number;
    windowHooks: number;
    inputHooks: number;
    errors: number;
    focusEvents: number;
    inputCalls: number;
    blockedCalls: number;
    foreground: boolean;
}

export type GameBackgroundReason = 'unsupported' | 'missingBuild' | 'noCapture' | 'notRunning' | 'ambiguous' | 'specialK';
export interface GameBackgroundState {
    sceneId: string;
    phase: 'disabled' | 'waiting' | 'blocked' | 'attaching' | 'active' | 'error';
    reason?: GameBackgroundReason;
    target?: GameBackgroundTarget;
    options: GameBackgroundOptions;
    telemetry?: GameBackgroundTelemetry;
    error?: string;
}

export function normalizeGameBackgroundOptions(value: unknown): GameBackgroundOptions {
    const input = value && typeof value === 'object' ? value as Partial<GameBackgroundOptions> : {};
    const keepRendering = input.keepRendering === true;
    const blockGamepad = input.blockGamepad !== false;
    return { enabled: input.enabled === true && (keepRendering || blockGamepad), keepRendering, blockGamepad };
}

export const gameBackgroundPathKey = (path: string): string => path.replace(/\//g, '\\').toLowerCase();
export const gameBackgroundTargetKey = (target: GameBackgroundTarget): string =>
    `${target.pid}:${target.hwnd}:${gameBackgroundPathKey(target.path)}`;

export function chooseGameBackgroundTarget(targets: GameBackgroundTarget[], title?: string | null): GameBackgroundTarget | undefined {
    const exact = targets.filter(target => target.title === title);
    const candidates = exact.length ? exact : targets;
    // Do not guess between processes or between two game windows.
    return candidates.length === 1 ? candidates[0] : undefined;
}
