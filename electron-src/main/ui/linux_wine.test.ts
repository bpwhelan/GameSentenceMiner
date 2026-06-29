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
    opts: { cmdline?: string[]; comm?: string; environ?: Record<string, string>; residentPages?: number },
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
        expect(ctx.wineBinary).toBe('/opt/wine/bin/wine');
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
        expect(ctx.wineBinary).toBe('');
        expect(ctx.env).toEqual({});
    });
});
