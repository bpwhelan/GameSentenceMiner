import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { findLinuxGamePid, readProcEnviron, resolveWineLaunch } from './linux_wine.js';

const tempRoots: string[] = [];

function makeProcRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-proc-'));
    tempRoots.push(dir);
    return dir;
}

/** Create a fake /proc/<pid> entry with the given cmdline args, comm, environ map, and RSS pages. */
function writeProcEntry(
    procRoot: string,
    pid: number,
    opts: {
        cmdline?: string[];
        comm?: string;
        environ?: Record<string, string>;
        parentPid?: number;
        residentPages?: number;
    },
): void {
    const dir = path.join(procRoot, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    const cmdline = (opts.cmdline ?? []).map((a) => `${a}\0`).join('');
    fs.writeFileSync(path.join(dir, 'cmdline'), cmdline);
    fs.writeFileSync(path.join(dir, 'comm'), `${opts.comm ?? ''}\n`);
    const environ = Object.entries(opts.environ ?? {})
        .map(([k, v]) => `${k}=${v}\0`)
        .join('');
    fs.writeFileSync(path.join(dir, 'environ'), environ);
    const resident = opts.residentPages ?? 0;
    // statm: size resident shared text lib data dt
    fs.writeFileSync(path.join(dir, 'statm'), `${resident + 100} ${resident} 0 0 0 0 0\n`);
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${opts.comm ?? ''}) S ${opts.parentPid ?? 1} 0 0 0\n`);
}

afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('findLinuxGamePid', () => {
    it('matches a process by exe basename from its cmdline', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 100, {
            cmdline: ['/usr/bin/wine', 'Z:\\games\\Game.exe'],
            comm: 'Game.exe',
            residentPages: 5000,
        });
        expect(findLinuxGamePid('Z:\\games\\Game.exe', procRoot, 1)).toBe(100);
        // basename match works regardless of the stored path style
        expect(findLinuxGamePid('/home/u/Game.exe', procRoot, 1)).toBe(100);
    });

    it('prefers the highest-RSS match over launcher shims', () => {
        const procRoot = makeProcRoot();
        // A low-memory matching process and the real high-memory game.
        writeProcEntry(procRoot, 200, { cmdline: ['game.exe'], comm: 'game.exe', residentPages: 50 });
        writeProcEntry(procRoot, 201, { cmdline: ['game.exe'], comm: 'game.exe', residentPages: 90000 });
        expect(findLinuxGamePid('game.exe', procRoot, 1)).toBe(201);
    });

    it('skips known launcher comms', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 300, { cmdline: ['game.exe'], comm: 'wineserver', residentPages: 99999 });
        writeProcEntry(procRoot, 301, { cmdline: ['game.exe'], comm: 'game.exe', residentPages: 10 });
        expect(findLinuxGamePid('game.exe', procRoot, 1)).toBe(301);
    });

    it('excludes the GSM process itself', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 400, { cmdline: ['game.exe'], comm: 'game.exe', residentPages: 100 });
        expect(findLinuxGamePid('game.exe', procRoot, 400)).toBe(0);
    });

    it('returns 0 when nothing matches', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 500, { cmdline: ['other.exe'], comm: 'other.exe' });
        expect(findLinuxGamePid('game.exe', procRoot, 1)).toBe(0);
    });
});

describe('readProcEnviron', () => {
    it('parses NUL-separated KEY=VALUE pairs', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 600, {
            environ: { WINEPREFIX: '/home/u/.wine', PATH: '/usr/bin', EMPTY: '' },
        });
        const env = readProcEnviron(600, procRoot);
        expect(env.WINEPREFIX).toBe('/home/u/.wine');
        expect(env.PATH).toBe('/usr/bin');
    });
});

describe('resolveWineLaunch', () => {
    it('extracts the prefix and wine loader from the running game environ', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 700, {
            cmdline: ['wine', 'game.exe'],
            comm: 'game.exe',
            residentPages: 8000,
            environ: {
                WINEPREFIX: '/home/u/.local/share/wineprefixes/game',
                WINELOADER: '/opt/wine/bin/wine',
                WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
            },
        });
        const ctx = resolveWineLaunch('game.exe', procRoot, 1);
        expect(ctx.linuxPid).toBe(700);
        expect(ctx.winePrefix).toBe('/home/u/.local/share/wineprefixes/game');
        expect(ctx.launcherPath).toBe('/opt/wine/bin/wine');
        expect(ctx.launcherKind).toBe('wine');
        expect(ctx.env.WINEPREFIX).toBe('/home/u/.local/share/wineprefixes/game');
        expect(ctx.env.WINEDLLOVERRIDES).toBe('winemenubuilder.exe=d');
    });

    it('derives the Proton pfx from STEAM_COMPAT_DATA_PATH when WINEPREFIX is absent', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 800, {
            cmdline: ['game.exe'],
            comm: 'game.exe',
            residentPages: 8000,
            environ: { STEAM_COMPAT_DATA_PATH: '/steam/steamapps/compatdata/12345' },
        });
        const ctx = resolveWineLaunch('game.exe', procRoot, 1);
        expect(ctx.winePrefix).toBe(path.join('/steam/steamapps/compatdata/12345', 'pfx'));
        expect(ctx.env.WINEPREFIX).toBe(path.join('/steam/steamapps/compatdata/12345', 'pfx'));
    });

    it('returns an empty context when the game is not running', () => {
        const procRoot = makeProcRoot();
        const ctx = resolveWineLaunch('missing.exe', procRoot, 1);
        expect(ctx.linuxPid).toBe(0);
        expect(ctx.winePrefix).toBe('');
        expect(ctx.launcherPath).toBe('');
        expect(ctx.launcherKind).toBe('wine');
        expect(ctx.env).toEqual({});
    });

    it('uses a supplied PID without racing a second process lookup', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 900, {
            cmdline: ['unexpected-name.exe'],
            comm: 'unexpected-name.exe',
            environ: {
                WINELOADER: '/opt/wine/bin/wine',
                LC_ALL: 'ja_JP.UTF-8',
                GSM_INTERNAL_SECRET: 'do-not-copy',
            },
        });

        const ctx = resolveWineLaunch('game.exe', procRoot, 1, 900);

        expect(ctx.linuxPid).toBe(900);
        expect(ctx.env.LC_ALL).toBe('ja_JP.UTF-8');
        expect(ctx.env.GSM_INTERNAL_SECRET).toBeUndefined();
    });

    it('uses umu-run only when the process ancestry identifies an UMU launch', () => {
        const procRoot = makeProcRoot();
        const binDir = path.join(procRoot, 'bin');
        const umuRunner = path.join(binDir, 'umu-run');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(umuRunner, '#!/bin/sh\n');
        fs.chmodSync(umuRunner, 0o755);
        writeProcEntry(procRoot, 910, {
            cmdline: ['game.exe'],
            comm: 'game.exe',
            parentPid: 911,
            environ: {
                PATH: binDir,
                WINELOADER: '/opt/wine/bin/wine',
                PROTON_VERB: 'waitforexitandrun',
            },
        });
        writeProcEntry(procRoot, 911, {
            cmdline: [umuRunner],
            comm: 'umu-run',
            parentPid: 1,
        });

        const ctx = resolveWineLaunch('game.exe', procRoot, 1);

        expect(ctx.launcherPath).toBe(umuRunner);
        expect(ctx.launcherKind).toBe('umu');
        expect(ctx.env.PROTON_VERB).toBe('run');
    });

    it('does not misclassify a regular Proton launch as UMU from shared environment variables', () => {
        const procRoot = makeProcRoot();
        writeProcEntry(procRoot, 920, {
            cmdline: ['game.exe'],
            comm: 'game.exe',
            environ: {
                WINELOADER: '/opt/proton/files/bin/wine',
                PROTON_VERB: 'waitforexitandrun',
                STEAM_COMPAT_TOOL_PATHS: '/opt/proton',
            },
        });

        const ctx = resolveWineLaunch('game.exe', procRoot, 1);

        expect(ctx.launcherPath).toBe('/opt/proton/files/bin/wine');
        expect(ctx.launcherKind).toBe('wine');
        expect(ctx.env.PROTON_VERB).toBe('waitforexitandrun');
    });
});
