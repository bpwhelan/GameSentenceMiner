import path from 'node:path';
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

export interface GameLaunchCommand { executable: string; args: string[]; cwd: string; }

export function buildGameLaunchCommand(options: GameLaunchOptions): GameLaunchCommand {
    if (Object.values(options).some(value => value.includes('\0'))) throw new GameLaunchError('invalidArguments');
    const gameArgs = [
        ...(options.mode === 'yuzu' ? ['-g', options.romPath] : []),
        ...splitWindowsCommandLine(options.arguments),
    ];
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

interface Dependencies {
    platform: string;
    load(sceneId: string): unknown;
    save(sceneId: string, options: GameLaunchOptions): void;
    detect(sceneId: string): Promise<string | null>;
    defaults?(sceneId: string): Promise<Partial<GameLaunchOptions> | null>;
    isFile(filename: string): Promise<boolean>;
    isDirectory(filename: string): Promise<boolean>;
    launch(command: GameLaunchCommand): Promise<unknown>;
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
        if (!this.deps.load(sceneId) && this.deps.defaults) {
            const defaults = await this.deps.defaults(sceneId);
            if (!this.deps.load(sceneId) && defaults) {
                this.deps.save(sceneId, normalizeGameLaunchOptions(defaults));
            }
        }
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
        if (options.mode === 'yuzu' && (requireExecutable || options.romPath) &&
            (!path.win32.isAbsolute(options.romPath) || !await this.deps.isFile(options.romPath)))
            throw new GameLaunchError('missingRom');
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
            await this.deps.launch(command);
        } finally { this.launching.delete(sceneId); }
    }
}
