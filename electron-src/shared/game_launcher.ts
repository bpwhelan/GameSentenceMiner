/** Launching is independent of the scene's automatic capture / hooking settings. */
export interface GameLaunchOptions {
    executablePath: string;
    arguments: string;
    workingDirectory: string;
    launcherPath: string;
    launcherArguments: string;
}

export type GameLaunchErrorCode = 'unsupported' | 'invalidScene' | 'missingExecutable' | 'missingLauncher' |
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
        executablePath: text(record.executablePath).trim(),
        arguments: text(record.arguments),
        workingDirectory: text(record.workingDirectory).trim(),
        launcherPath: text(record.launcherPath).trim(),
        launcherArguments: typeof record.launcherArguments === 'string' ? record.launcherArguments : '"{game}" {args}',
    };
}
