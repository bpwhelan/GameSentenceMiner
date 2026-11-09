import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { splitWindowsCommandLine } from '../windows_command_line.js';
import { normalizeGameLaunchOptions, type GameLaunchOptions, type GameLaunchErrorCode } from '../../shared/game_launcher.js';

export class GameLaunchError extends Error {
    constructor(readonly code: GameLaunchErrorCode) { super(code); }
}

export interface GameLaunchWindow { path: string; title: string; }

/** Never guess between two installations which happen to use the same image name. */
export function chooseGameExecutable(windows: GameLaunchWindow[], executableName: string, title: string): string | null {
    if (!executableName.trim()) return null;
    const matches = windows.filter(window => path.win32.isAbsolute(window.path) &&
        path.win32.basename(window.path).toLowerCase() === executableName.trim().toLowerCase());
    const exactTitle = title ? matches.filter(window => window.title === title) : [];
    const unique = new Map<string, string>();
    for (const window of exactTitle.length ? exactTitle : matches) {
        const key = path.win32.normalize(window.path).toLowerCase();
        if (!unique.has(key)) unique.set(key, window.path);
    }
    return unique.size === 1 ? [...unique.values()][0] : null;
}

export function buildGameLaunchCommand(options: GameLaunchOptions): { executable: string; args: string[]; cwd: string } {
    if (Object.values(options).some(value => value.includes('\0'))) throw new GameLaunchError('invalidArguments');
    const gameArgs = splitWindowsCommandLine(options.arguments);
    const args = options.launcherPath ? splitWindowsCommandLine(options.launcherArguments).flatMap(argument => {
        if (argument === '{args}') return gameArgs;
        if (argument.includes('{args}')) throw new GameLaunchError('invalidArguments');
        return [argument.replaceAll('{game}', options.executablePath)];
    }) : gameArgs;
    return {
        executable: options.launcherPath || options.executablePath,
        args,
        cwd: options.workingDirectory || path.win32.dirname(options.executablePath),
    };
}

interface LaunchChild extends EventEmitter { unref(): void; }
interface Dependencies {
    platform: string;
    load(sceneId: string): unknown;
    save(sceneId: string, options: GameLaunchOptions): void;
    detect(sceneId: string): Promise<string | null>;
    isFile(filename: string): Promise<boolean>;
    isDirectory(filename: string): Promise<boolean>;
    spawn(executable: string, args: string[], options: SpawnOptions): LaunchChild;
}

export class GameLauncherService {
    private readonly launching = new Set<string>();
    constructor(private readonly deps: Dependencies) {}

    private checkScene(sceneId: string): void {
        if (this.deps.platform !== 'win32') throw new GameLaunchError('unsupported');
        if (typeof sceneId !== 'string' || !sceneId.trim() || sceneId.length > 256) throw new GameLaunchError('invalidScene');
    }

    async getOptions(sceneId: string): Promise<GameLaunchOptions> {
        this.checkScene(sceneId);
        let options = normalizeGameLaunchOptions(this.deps.load(sceneId));
        if (!options.executablePath) {
            const detected = await this.deps.detect(sceneId);
            // Detection may take time; do not overwrite a user's intervening save.
            options = normalizeGameLaunchOptions(this.deps.load(sceneId));
            if (!options.executablePath && detected && path.win32.isAbsolute(detected) && await this.deps.isFile(detected)) {
                // Reload after the filesystem await as well, including custom arguments.
                options = normalizeGameLaunchOptions(this.deps.load(sceneId));
                if (!options.executablePath) {
                    options = { ...options, executablePath: detected };
                    this.deps.save(sceneId, options);
                }
            }
        }
        return options;
    }

    async detect(sceneId: string): Promise<string | null> {
        this.checkScene(sceneId);
        return this.deps.detect(sceneId);
    }

    private async validate(options: GameLaunchOptions, requireExecutable: boolean): Promise<void> {
        if ((requireExecutable || options.executablePath) &&
            (!path.win32.isAbsolute(options.executablePath) || !await this.deps.isFile(options.executablePath)))
            throw new GameLaunchError('missingExecutable');
        if (options.launcherPath && (!path.win32.isAbsolute(options.launcherPath) || !await this.deps.isFile(options.launcherPath)))
            throw new GameLaunchError('missingLauncher');
        const command = buildGameLaunchCommand(options);
        if ((requireExecutable || options.workingDirectory) &&
            (!path.win32.isAbsolute(command.cwd) || !await this.deps.isDirectory(command.cwd)))
            throw new GameLaunchError('invalidWorkingDirectory');
    }

    async saveOptions(sceneId: string, value: unknown): Promise<GameLaunchOptions> {
        this.checkScene(sceneId);
        const options = normalizeGameLaunchOptions(value);
        await this.validate(options, false);
        this.deps.save(sceneId, options);
        return options;
    }

    async launch(sceneId: string): Promise<void> {
        this.checkScene(sceneId);
        if (this.launching.has(sceneId)) throw new GameLaunchError('busy');
        this.launching.add(sceneId);
        try {
            const options = await this.getOptions(sceneId);
            await this.validate(options, true);
            const command = buildGameLaunchCommand(options);
            // Wait for spawn/error: having a ChildProcess object does not mean Windows started it.
            await new Promise<void>((resolve, reject) => {
                const child = this.deps.spawn(command.executable, command.args, {
                    cwd: command.cwd, shell: false, detached: true, stdio: 'ignore', windowsHide: false,
                });
                child.once('error', reject);
                child.once('spawn', () => { child.unref(); resolve(); });
            });
        } finally { this.launching.delete(sceneId); }
    }
}
