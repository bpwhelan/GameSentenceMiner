/** Launching is independent of the scene's automatic capture / hooking settings. */
export interface GameLaunchOptions {
    mode: 'executable' | 'yuzu';
    executablePath: string;
    romPath: string;
    arguments: string;
    workingDirectory: string;
    launcherPath: string;
    launcherArguments: string;
}

export type GameLaunchErrorCode = 'unsupported' | 'invalidScene' | 'missingExecutable' | 'missingRom' | 'missingLauncher' |
    'invalidWorkingDirectory' | 'invalidArguments' | 'busy' | 'failed';

export interface GameLaunchResult {
    success: boolean;
    code?: GameLaunchErrorCode;
    error?: string;
}

export function normalizeGameLaunchOptions(value: unknown): GameLaunchOptions {
    const record = value && typeof value === 'object' ? value as Partial<GameLaunchOptions> : {};
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    return {
        mode: record.mode === 'yuzu' ? 'yuzu' : 'executable',
        executablePath: text(record.executablePath).trim(),
        romPath: text(record.romPath).trim(),
        arguments: text(record.arguments),
        workingDirectory: text(record.workingDirectory).trim(),
        launcherPath: text(record.launcherPath).trim(),
        launcherArguments: typeof record.launcherArguments === 'string' ? record.launcherArguments : '"{game}" {args}',
    };
}
