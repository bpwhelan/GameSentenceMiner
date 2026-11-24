import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameLauncherService, buildGameLaunchCommand, chooseGameExecutable } from './game_launcher.js';
import { normalizeGameLaunchOptions, type GameLaunchOptions } from '../../shared/game_launcher.js';
import { quoteWindowsArgument } from '../windows_command_line.js';
import { launchGameAsUser } from '../runtime/windows_game_launcher.js';

const game = 'C:\\Games\\月姫 Remake\\game.exe';
const launcher = 'C:\\Tools\\Locale Emulator\\LEProc.exe';

describe('game launch commands', () => {
    it('launches directly in the game folder, preserving quoted arguments and shell characters', () => {
        expect(buildGameLaunchCommand(normalizeGameLaunchOptions({
            executablePath: game, arguments: '--title "月姫 & friends" "" --flag=$VALUE',
        }))).toEqual({ executable: game, args: ['--title', '月姫 & friends', '', '--flag=$VALUE'], cwd: 'C:\\Games\\月姫 Remake' });
    });

    it('supports launcher templates without splitting paths or expanding placeholders inside game arguments', () => {
        expect(buildGameLaunchCommand(normalizeGameLaunchOptions({
            executablePath: game, launcherPath: launcher, launcherArguments: '-run "{game}" {args}',
            arguments: '--save "D:\\Save Files" --literal={game}', workingDirectory: 'D:\\Working Folder',
        }))).toEqual({ executable: launcher, args: ['-run', game, '--save', 'D:\\Save Files', '--literal={game}'], cwd: 'D:\\Working Folder' });
    });

    it('uses a safe default launcher template for SKIF and accepts empty arguments', () => {
        expect(buildGameLaunchCommand(normalizeGameLaunchOptions({ executablePath: game, launcherPath: launcher })).args).toEqual([game]);
    });

    it('boots the selected ROM in Yuzu and preserves emulator arguments', () => {
        const romPath = 'D:\\Switch ROMs\\月姫 [01001234].nsp';
        const options = normalizeGameLaunchOptions({ mode: 'yuzu', executablePath: 'C:\\Yuzu\\yuzu.exe', romPath, arguments: '-f' });
        expect(buildGameLaunchCommand(options)).toEqual({ executable: 'C:\\Yuzu\\yuzu.exe', args: ['-g', romPath, '-f'], cwd: 'C:\\Yuzu' });
        expect(buildGameLaunchCommand({ ...options, launcherPath: launcher })).toEqual({
            executable: launcher, args: ['C:\\Yuzu\\yuzu.exe', '-g', romPath, '-f'], cwd: 'C:\\Yuzu',
        });
    });

    it('rejects embedded argument-list placeholders and null bytes', () => {
        expect(() => buildGameLaunchCommand(normalizeGameLaunchOptions({ executablePath: game, launcherPath: launcher, launcherArguments: '--args={args}' }))).toThrow('invalidArguments');
        expect(() => buildGameLaunchCommand(normalizeGameLaunchOptions({ executablePath: game, arguments: 'bad\0argument' }))).toThrow('invalidArguments');
    });
});

describe('captured executable resolution', () => {
    it('uses the full path belonging to the captured name and title', () => {
        const windows = [{ path: game, title: '月姫' }, { path: 'D:\\Other\\game.exe', title: 'Other game' }];
        expect(chooseGameExecutable(windows, 'GAME.EXE', '月姫')).toBe(game);
        expect(chooseGameExecutable(windows, 'game.exe', 'Unknown title')).toBeNull();
        expect(chooseGameExecutable(windows, 'different.exe', '月姫')).toBeNull();
    });

    it('deduplicates multiple windows from the same executable and ignores non-absolute paths', () => {
        expect(chooseGameExecutable([{ path: game, title: 'Game' }, { path: game.toUpperCase(), title: 'Options' }, { path: 'game.exe', title: 'Game' }], 'game.exe', '')).toBe(game);
    });
});

describe('GameLauncherService', () => {
    let profiles: Map<string, GameLaunchOptions>;
    let deps: ConstructorParameters<typeof GameLauncherService>[0];
    let service: GameLauncherService;

    beforeEach(() => {
        profiles = new Map();
        deps = {
            platform: 'win32',
            load: id => profiles.get(id),
            save: (id, options) => { profiles.set(id, options); },
            detect: vi.fn().mockResolvedValue(game),
            isFile: vi.fn().mockResolvedValue(true),
            isDirectory: vi.fn().mockResolvedValue(true),
            launch: vi.fn().mockResolvedValue(undefined),
        };
        service = new GameLauncherService(deps);
    });

    it('remembers a detected path after the game closes and keeps launch options isolated by scene UUID', async () => {
        expect((await service.getOptions('scene-a')).executablePath).toBe(game);
        vi.mocked(deps.detect).mockResolvedValue(null);
        expect((await service.getOptions('scene-a')).executablePath).toBe(game);
        expect((await service.getOptions('scene-b')).executablePath).toBe('');
        await service.saveOptions('scene-a', { executablePath: game, arguments: '--windowed' });
        expect((await service.getOptions('scene-a')).arguments).toBe('--windowed');
        expect((await service.getOptions('scene-b')).arguments).toBe('');
    });

    it('does not overwrite a manual save made while detection was pending', async () => {
        let resolve!: (path: string) => void;
        vi.mocked(deps.detect).mockImplementation(() => new Promise(done => { resolve = done; }));
        const pending = service.getOptions('scene-a');
        await service.saveOptions('scene-a', { executablePath: 'D:\\Chosen\\game.exe', arguments: '--custom' });
        resolve(game);
        expect((await pending).executablePath).toBe('D:\\Chosen\\game.exe');
        expect(profiles.get('scene-a')?.arguments).toBe('--custom');
    });

    it('launches the validated game through the user-session launcher', async () => {
        await service.launch('scene-a');
        expect(deps.launch).toHaveBeenCalledWith({ executable: game, args: [], cwd: 'C:\\Games\\月姫 Remake' });
    });

    it('surfaces asynchronous spawn failures and allows retry', async () => {
        vi.mocked(deps.launch).mockRejectedValue(new Error('Access denied'));
        await expect(service.launch('scene-a')).rejects.toThrow('Access denied');
        vi.mocked(deps.launch).mockResolvedValue(undefined);
        await expect(service.launch('scene-a')).resolves.toBeUndefined();
    });

    it('rejects overlapping launch requests', async () => {
        let finish!: () => void;
        vi.mocked(deps.launch).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
        const pending = service.launch('scene-a');
        await expect(service.launch('scene-a')).rejects.toThrow('busy');
        await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
        finish();
        await pending;
    });

    it('checks for missing files, invalid working folders, and unsupported platforms', async () => {
        vi.mocked(deps.isFile).mockResolvedValue(false);
        await expect(service.launch('scene-a')).rejects.toThrow('missingExecutable');
        vi.mocked(deps.isFile).mockResolvedValue(true);
        await service.saveOptions('scene-a', { executablePath: game, launcherPath: launcher });
        vi.mocked(deps.isFile).mockImplementation(async filename => filename !== launcher);
        await expect(service.launch('scene-a')).rejects.toThrow('missingLauncher');
        vi.mocked(deps.isFile).mockResolvedValue(true);
        vi.mocked(deps.isDirectory).mockResolvedValue(false);
        await expect(service.launch('scene-a')).rejects.toThrow('invalidWorkingDirectory');
        deps.platform = 'linux';
        await expect(service.launch('scene-a')).rejects.toThrow('unsupported');
        expect(deps.launch).not.toHaveBeenCalled();
    });

    it('leaves settings untouched when saving invalid paths', async () => {
        await service.saveOptions('scene-a', { executablePath: game });
        await expect(service.saveOptions('scene-a', { executablePath: 'game.exe' })).rejects.toThrow('missingExecutable');
        expect(profiles.get('scene-a')?.executablePath).toBe(game);
    });

    it('imports a legacy Yuzu scene once without replacing saved launch options', async () => {
        deps.defaults = vi.fn().mockResolvedValue({ mode: 'yuzu', executablePath: 'C:\\Yuzu\\yuzu.exe', romPath: 'D:\\Games\\月姫.nsp' });
        expect(await service.getOptions('scene-a')).toMatchObject({ mode: 'yuzu', romPath: 'D:\\Games\\月姫.nsp' });
        await service.saveOptions('scene-a', { executablePath: game, arguments: '--custom' });
        expect(await service.getOptions('scene-a')).toMatchObject({ mode: 'executable', executablePath: game, arguments: '--custom' });
        expect(deps.defaults).toHaveBeenCalledOnce();
    });

    it('requires a valid ROM before launching Yuzu', async () => {
        await service.saveOptions('scene-a', { mode: 'yuzu', executablePath: game });
        await expect(service.launch('scene-a')).rejects.toThrow('missingRom');
        vi.mocked(deps.isFile).mockImplementation(async filename => filename === game);
        await expect(service.saveOptions('scene-a', { mode: 'yuzu', executablePath: game, romPath: 'D:\\missing.nsp' })).rejects.toThrow('missingRom');
        expect(deps.launch).not.toHaveBeenCalled();
    });

    it('keeps a manual save made while legacy Yuzu lookup was pending', async () => {
        let finish!: (value: Partial<GameLaunchOptions>) => void;
        deps.defaults = () => new Promise(resolve => { finish = resolve; });
        const pending = service.getOptions('scene-a');
        await service.saveOptions('scene-a', { executablePath: game, arguments: '--manual' });
        finish({ mode: 'yuzu', executablePath: 'C:\\Yuzu\\yuzu.exe', romPath: 'D:\\game.nsp' });
        expect(await pending).toMatchObject({ mode: 'executable', executablePath: game, arguments: '--manual' });
    });
});

it.skipIf(process.platform !== 'win32')('passes Unicode, quotes and spaces through a real Windows launcher process', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'gsm-launch-月姫-'));
    const fixture = path.join(folder, 'launcher fixture.cjs');
    const output = path.join(folder, 'result.json');
    await writeFile(fixture, `
const {execFileSync} = require('node:child_process');
const elevated = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], {windowsHide:true, encoding:'utf8'}).trim();
require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), elevated, pid:process.pid, parentEnvironment:process.env.GSM_LAUNCHER_TEST_ONLY ?? null}));`);
    const args = ['--title', '月姫 & friends', '', 'a"quoted"value', 'C:\\Save Folder\\'];
    const options = normalizeGameLaunchOptions({
        executablePath: process.execPath, launcherPath: process.execPath,
        launcherArguments: `${quoteWindowsArgument(fixture)} "{game}" {args}`,
        arguments: args.map(quoteWindowsArgument).join(' '), workingDirectory: folder,
    });
    let launchedPid = 0;
    const service = new GameLauncherService({
        platform: 'win32', load: () => options, save: () => {}, detect: async () => null,
        isFile: async filename => (await stat(filename)).isFile(),
        isDirectory: async filename => (await stat(filename)).isDirectory(),
        launch: async command => { launchedPid = await launchGameAsUser(command); },
    });
    vi.stubEnv('GSM_LAUNCHER_TEST_ONLY', 'must-not-leak-into-desktop-launches');
    try {
        // Hosted images can run even Explorer as administrator. In that case
        // the launcher must refuse and must never start the fixture.
        try {
            await service.launch('real-windows-fixture');
        } catch (error) {
            if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw error;
            expect((error as Error).message).toBe('The desktop launcher is running as administrator. The game was not launched.');
            expect(launchedPid).toBe(0);
            await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
            return;
        }
        expect(launchedPid).toBeGreaterThan(0);
        await vi.waitFor(async () => {
            expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
                args: [process.execPath, ...args], cwd: folder, elevated: 'False', pid: launchedPid, parentEnvironment: null,
            });
        }, { timeout: 10_000 });
    } finally {
        vi.unstubAllEnvs();
        const relative = path.relative(path.resolve(tmpdir()), path.resolve(folder));
        if (!relative.startsWith('gsm-launch-') || relative.includes(path.sep)) throw new Error('Unexpected fixture cleanup path');
        await rm(folder, { recursive: true, force: true });
    }
}, 30_000);

it.skipIf(process.platform !== 'win32')('reports a real Windows launch error without exposing the helper command', async () => {
    try {
        await launchGameAsUser({ executable: 'C:\\does-not-exist\\gsm-missing-fixture.exe', args: [], cwd: tmpdir() });
        throw new Error('Expected Windows launch to fail');
    } catch (error) {
        expect((error as Error).message).not.toContain('-EncodedCommand');
        expect((error as Error).message).not.toContain('CLIXML');
        expect((error as Error).message).not.toContain('<Objs');
        expect((error as Error).message).not.toContain('Expected Windows launch to fail');
    }
}, 30_000);
