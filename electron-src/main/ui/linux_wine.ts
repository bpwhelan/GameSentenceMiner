// electron-src/main/ui/linux_wine.ts
//
// Linux Wine/Proton launch resolution for text hooking.
//
// On Linux the game runs inside a Wine/Proton prefix, so to hook it we must launch the
// Windows hooker .exe (LunaHostCLI / TextractorCLI) inside that same prefix. The user points
// GSM at the game executable; from there we locate the running Linux game process and recover
// its real Wine environment from /proc/<pid>/environ, then reuse that environment + wine loader
// to spawn the hooker.
//
// This mirrors, in a focused way, the Proton process-resolution logic in the Python
// base_window_monitor (steam-dir / largest-RSS heuristics), but is driven by the user's exe
// path so it also works on Wayland where X11 window enumeration is unavailable.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WineLaunchContext {
    /** Linux PID of the running game process, or 0 if it could not be found. */
    linuxPid: number;
    /** Resolved WINEPREFIX (or derived Proton pfx), or '' if unknown. */
    winePrefix: string;
    /** Wine loader binary to invoke, or '' to let the caller fall back to system `wine`. */
    wineBinary: string;
    /** Environment variables (from the game's environ) to merge into the spawn. */
    env: Record<string, string>;
}

// Wine/Proton env vars worth carrying over to the hooker so it lands in the same prefix.
const WINE_ENV_KEYS = [
    'WINEPREFIX',
    'WINELOADER',
    'WINELOADERNOEXEC',
    'WINESERVER',
    'WINEDLLPATH',
    'WINEDLLOVERRIDES',
    'WINEFSYNC',
    'WINEESYNC',
    'WINEDEBUG',
    'WINEARCH',
    'PROTONPATH',
    'STEAM_COMPAT_DATA_PATH',
    'STEAM_COMPAT_CLIENT_INSTALL_PATH',
    'STEAM_COMPAT_INSTALL_PATH',
    'STEAM_COMPAT_MOUNTS',
    'LD_LIBRARY_PATH',
    'GST_PLUGIN_SYSTEM_PATH_1_0',
];

// Launcher/helper comms that own a game window but are not the game itself — never rank these
// as the game process. Kept in sync (loosely) with the Python _PROTON_LAUNCHER_COMMS denylist.
const LAUNCHER_COMMS = new Set([
    'wine',
    'wine64',
    'wineserver',
    'wine-preloader',
    'wine64-preloader',
    'winedevice.exe',
    'services.exe',
    'plugplay.exe',
    'svchost.exe',
    'rpcss.exe',
    'conhost.exe',
    'explorer.exe',
    'start.exe',
    'steam.exe',
    'steamwebhelper',
    'gameoverlayui',
    'pv-bwrap',
    'pv-adverb',
    'pressure-vessel-wrap',
    'reaper',
    'proton',
    'python',
    'python3',
]);

function basenameLower(value: string): string {
    return path.basename((value || '').replace(/\\/g, '/')).toLowerCase();
}

/** Read a /proc/<pid>/<name> file, returning null on any error (process gone, EPERM, …). */
function readProcFile(procRoot: string, pid: number, name: string): Buffer | null {
    try {
        return fs.readFileSync(path.join(procRoot, String(pid), name));
    } catch {
        return null;
    }
}

function splitNulString(buf: Buffer | null): string[] {
    if (!buf) return [];
    return buf
        .toString('utf-8')
        .split('\0')
        .filter((s) => s.length > 0);
}

/** Parse /proc/<pid>/environ into a key→value map. */
export function readProcEnviron(pid: number, procRoot = '/proc'): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of splitNulString(readProcFile(procRoot, pid, 'environ'))) {
        const eq = entry.indexOf('=');
        if (eq > 0) {
            env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
    }
    return env;
}

/** Resident set size in bytes from /proc/<pid>/statm (resident pages × page size). */
function readProcRss(procRoot: string, pid: number): number {
    const statm = readProcFile(procRoot, pid, 'statm');
    if (!statm) return 0;
    const fields = statm.toString('utf-8').trim().split(/\s+/);
    const residentPages = Number(fields[1] ?? 0);
    if (!Number.isFinite(residentPages)) return 0;
    return residentPages * 4096;
}

function listProcPids(procRoot: string): number[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(procRoot);
    } catch {
        return [];
    }
    const pids: number[] = [];
    for (const entry of entries) {
        if (/^\d+$/.test(entry)) {
            pids.push(Number(entry));
        }
    }
    return pids;
}

function cmdlineMatchesExe(cmdline: string[], comm: string, targetBasename: string): boolean {
    if (!targetBasename) return false;
    if (comm && comm.toLowerCase() === targetBasename) return true;
    // /proc/comm is truncated to 15 chars.
    if (comm && targetBasename.startsWith(comm.toLowerCase()) && comm.length >= 15) return true;
    for (const arg of cmdline) {
        if (basenameLower(arg) === targetBasename) return true;
    }
    return false;
}

/**
 * Find the Linux PID of the running game identified by exePath. Matches the exe basename against
 * each process's cmdline/comm and, when several match, prefers the highest-RSS one (the actual
 * game over launcher shims). Returns 0 if nothing matches. `selfPid` is excluded.
 */
export function findLinuxGamePid(exePath: string, procRoot = '/proc', selfPid = process.pid): number {
    const targetBasename = basenameLower(exePath);
    if (!targetBasename) return 0;

    let bestPid = 0;
    let bestRss = -1;
    for (const pid of listProcPids(procRoot)) {
        if (pid === selfPid) continue;
        const comm = (readProcFile(procRoot, pid, 'comm')?.toString('utf-8') ?? '').trim();
        if (comm && LAUNCHER_COMMS.has(comm.toLowerCase())) continue;
        const cmdline = splitNulString(readProcFile(procRoot, pid, 'cmdline'));
        if (cmdline.length === 0 && !comm) continue;
        if (!cmdlineMatchesExe(cmdline, comm, targetBasename)) continue;
        const rss = readProcRss(procRoot, pid);
        if (rss > bestRss) {
            bestRss = rss;
            bestPid = pid;
        }
    }
    return bestPid;
}

/** Derive the Proton wine loader from PROTONPATH/STEAM_COMPAT_DATA_PATH, or '' if not derivable. */
function deriveProtonWine(env: Record<string, string>): string {
    const protonPath = env.PROTONPATH || '';
    if (protonPath) {
        for (const rel of ['files/bin/wine', 'dist/bin/wine']) {
            const candidate = path.join(protonPath, rel);
            try {
                if (fs.existsSync(candidate)) return candidate;
            } catch {
                /* ignore */
            }
        }
    }
    return '';
}

/**
 * Resolve everything needed to launch the hooker inside the game's Wine/Proton prefix.
 * The running game's /proc/<pid>/environ is the source of truth; when the game cannot be found
 * the returned context has linuxPid 0 and empty prefix/binary so the caller can decide how to
 * proceed (e.g. log and try a bare `wine`).
 */
export function resolveWineLaunch(exePath: string, procRoot = '/proc', selfPid = process.pid): WineLaunchContext {
    const linuxPid = findLinuxGamePid(exePath, procRoot, selfPid);
    const gameEnv = linuxPid > 0 ? readProcEnviron(linuxPid, procRoot) : {};

    const env: Record<string, string> = {};
    for (const key of WINE_ENV_KEYS) {
        if (typeof gameEnv[key] === 'string' && gameEnv[key].length > 0) {
            env[key] = gameEnv[key];
        }
    }

    // Prefix: explicit WINEPREFIX, else the standard Proton compatdata pfx.
    let winePrefix = env.WINEPREFIX || '';
    if (!winePrefix && env.STEAM_COMPAT_DATA_PATH) {
        winePrefix = path.join(env.STEAM_COMPAT_DATA_PATH, 'pfx');
    }
    if (winePrefix) {
        env.WINEPREFIX = winePrefix;
    }

    // Wine loader: the game's own loader, else a derived Proton wine, else let caller default.
    const wineBinary = env.WINELOADER || deriveProtonWine(gameEnv) || '';

    return { linuxPid, winePrefix, wineBinary, env };
}
