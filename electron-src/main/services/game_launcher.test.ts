import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameLauncherService, buildGameLaunchCommand, chooseGameExecutable } from './game_launcher.js';
import { normalizeGameLaunchOptions, type GameLaunchOptions } from '../../shared/game_launcher.js';
import { quoteWindowsArgument } from '../windows_command_line.js';

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
    let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };
    let deps: ConstructorParameters<typeof GameLauncherService>[0];
    let service: GameLauncherService;

    beforeEach(() => {
        profiles = new Map();
        child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        deps = {
            platform: 'win32',
            load: id => profiles.get(id),
            save: (id, options) => { profiles.set(id, options); },
            detect: vi.fn().mockResolvedValue(game),
            isFile: vi.fn().mockResolvedValue(true),
            isDirectory: vi.fn().mockResolvedValue(true),
            spawn: vi.fn().mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; }),
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

    it('spawns just the game without a shell and detaches it from GSM', async () => {
        await service.launch('scene-a');
        expect(deps.spawn).toHaveBeenCalledWith(game, [], {
            cwd: 'C:\\Games\\月姫 Remake', shell: false, detached: true, stdio: 'ignore', windowsHide: false,
        });
        expect(child.unref).toHaveBeenCalledOnce();
    });

    it('surfaces asynchronous spawn failures and allows retry', async () => {
        vi.mocked(deps.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('error', new Error('Access denied'))); return child; });
        await expect(service.launch('scene-a')).rejects.toThrow('Access denied');
        vi.mocked(deps.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
        await expect(service.launch('scene-a')).resolves.toBeUndefined();
    });

    it('rejects overlapping launch requests', async () => {
        vi.mocked(deps.spawn).mockReturnValue(child);
        const pending = service.launch('scene-a');
        await expect(service.launch('scene-a')).rejects.toThrow('busy');
        await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce());
        child.emit('spawn');
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
        expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('leaves settings untouched when saving invalid paths', async () => {
        await service.saveOptions('scene-a', { executablePath: game });
        await expect(service.saveOptions('scene-a', { executablePath: 'game.exe' })).rejects.toThrow('missingExecutable');
        expect(profiles.get('scene-a')?.executablePath).toBe(game);
    });
});

it.skipIf(process.platform !== 'win32')('passes Unicode, quotes and spaces through a real Windows launcher process', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'gsm-launch-月姫-'));
    const fixture = path.join(folder, 'launcher fixture.cjs');
    const output = path.join(folder, 'result.json');
    await writeFile(fixture, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()}));`);
    const args = ['--title', '月姫 & friends', '', 'a"quoted"value', 'C:\\Save Folder\\'];
    const options = normalizeGameLaunchOptions({
        executablePath: process.execPath, launcherPath: process.execPath,
        launcherArguments: `${quoteWindowsArgument(fixture)} "{game}" {args}`,
        arguments: args.map(quoteWindowsArgument).join(' '), workingDirectory: folder,
    });
    const service = new GameLauncherService({
        platform: 'win32', load: () => options, save: () => {}, detect: async () => null,
        isFile: async filename => (await stat(filename)).isFile(),
        isDirectory: async filename => (await stat(filename)).isDirectory(),
        spawn: (file, args, options) => spawn(file, args, { ...options, windowsHide: true }),
    });
    try {
        await service.launch('real-windows-fixture');
        await vi.waitFor(async () => {
            expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ args: [process.execPath, ...args], cwd: folder });
        }, { timeout: 5000 });
    } finally { await rm(folder, { recursive: true, force: true }); }
});
