// Linux Wine/Proton launch resolution for text hooking.
//
// A Windows hooker has to be started by the same Wine/Proton installation and
// with the same prefix as the game. The process environment is the most
// reliable source of that information: it also works for Steam, UMU and a
// plain Wine launch without making GSM depend on any one launcher.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WineLaunchContext {
    /** Linux PID of the running game process, or 0 if it could not be found. */
    linuxPid: number;
    /** Resolved WINEPREFIX (or derived Proton pfx), or '' if unknown. */
    winePrefix: string;
    /** Command that starts a Windows process in the game's Wine environment. */
    wineBinary: string;
    /** True when the process was launched through umu-run. */
    isUmu: boolean;
    /** Environment captured from the game's /proc entry, never GSM's full environment. */
    env: Record<string, string>;
}

// Keep this deliberately explicit. In particular, do not pass process.env to
// a hooker: Proton's container/runtime variables must come from the game that
// is being hooked, while unrelated GSM variables can change Wine behaviour.
const WINE_ENV_KEYS = [
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'PWD', 'LANG', 'LANGUAGE',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE',
    'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP',
    'WINE', 'WINEPREFIX', 'WINELOADER', 'WINELOADERNOEXEC', 'WINESERVER',
    'WINEDLLPATH', 'WINEDLLOVERRIDES', 'WINEFSYNC', 'WINEESYNC', 'WINEDEBUG',
    'WINEARCH', 'WINE_CRASH_REPORT_DIR', 'WINE_LARGE_ADDRESS_AWARE',
    'WINEPRELOADRESERVE', 'WINE_GST_REGISTRY_DIR',
    'PROTONPATH', 'PROTON_VERB', 'PROTON_LOG', 'PROTON_DUMP_DEBUG_COMMANDS',
    'PROTON_CRASH_REPORT_DIR',
    'STEAM_COMPAT_PROTON', 'STEAM_COMPAT_APP_ID', 'STEAM_COMPAT_CLIENT_INSTALL_PATH',
    'STEAM_COMPAT_DATA_PATH', 'STEAM_COMPAT_INSTALL_PATH', 'STEAM_COMPAT_MOUNTS',
    'STEAM_COMPAT_TOOL_PATHS', 'STEAM_COMPAT_FLAGS', 'STEAM_COMPAT_LIBRARY_PATHS',
    'STEAM_COMPAT_SHADER_PATH', 'STEAM_COMPAT_TRANSCODED_MEDIA_PATH',
    'STEAM_COMPAT_MEDIA_PATH', 'STEAM_COMPAT_RUNTIME', 'PROTON_USE_XALIA',
    'STEAM_RUNTIME', 'STEAM_RUNTIME_LIBRARY_PATH', 'STEAM_RUNTIME_LIBRARY_PATHS',
    'PRESSURE_VESSEL_APP_LAUNCHER', 'PRESSURE_VESSEL_APPID', 'PRESSURE_VESSEL_FILESYSTEMS',
    'PRESSURE_VESSEL_RUNTIME', 'PRESSURE_VESSEL_RUNTIME_BASE', 'PRESSURE_VESSEL_SHELL',
    'PRESSURE_VESSEL_IMPORT_VARS', 'PRESSURE_VESSEL_EXPORT_VARS', 'PRESSURE_VESSEL_VERBOSE',
    'PRESSURE_VESSEL_ARCHITECTURES', 'PRESSURE_VESSEL_COPY_RUNTIME',
    'LD_LIBRARY_PATH',
    'DXVK_ASYNC', 'DXVK_CONFIG_FILE', 'DXVK_CONFIG', 'DXVK_HUD', 'DXVK_LOG_PATH',
    'VKD3D_CONFIG', 'VKD3D_DEBUG', 'VKD3D_FEATURE_LEVEL', 'VKD3D_SHADER_DEBUG',
    'GST_PLUGIN_SYSTEM_PATH_1_0', 'GST_PLUGIN_PATH_1_0',
];

const LAUNCHER_COMMS = new Set([
    'wine', 'wine64', 'wineserver', 'wine-preloader', 'wine64-preloader',
    'winedevice.exe', 'services.exe', 'plugplay.exe', 'svchost.exe', 'rpcss.exe',
    'conhost.exe', 'explorer.exe', 'start.exe', 'steam.exe', 'steamwebhelper',
    'gameoverlayui', 'pv-bwrap', 'pv-adverb', 'pressure-vessel-wrap', 'reaper',
    'proton', 'python', 'python3', 'umu-run', 'umu',
]);

function basenameLower(value: string): string {
    return path.basename((value || '').replace(/\\/g, '/')).toLowerCase();
}

/** Read a /proc/<pid>/<name> file, returning null if the process disappeared. */
function readProcFile(procRoot: string, pid: number, name: string): Buffer | null {
    try {
        return fs.readFileSync(path.join(procRoot, String(pid), name));
    } catch {
        return null;
    }
}

function readProcLink(procRoot: string, pid: number, name: string): string {
    try {
        return fs.readlinkSync(path.join(procRoot, String(pid), name));
    } catch {
        return '';
    }
}

function splitNulString(buf: Buffer | null): string[] {
    if (!buf) return [];
    return buf.toString('utf-8').split('\0').filter((s) => s.length > 0);
}

/** Parse /proc/<pid>/environ into a key→value map. */
export function readProcEnviron(pid: number, procRoot = '/proc'): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of splitNulString(readProcFile(procRoot, pid, 'environ'))) {
        const eq = entry.indexOf('=');
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
}

function readProcRss(procRoot: string, pid: number): number {
    const statm = readProcFile(procRoot, pid, 'statm');
    if (!statm) return 0;
    const fields = statm.toString('utf-8').trim().split(/\s+/);
    const residentPages = Number(fields[1] ?? 0);
    return Number.isFinite(residentPages) ? residentPages * 4096 : 0;
}

function listProcPids(procRoot: string): number[] {
    try {
        return fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry)).map(Number);
    } catch {
        return [];
    }
}

function cmdlineMatchesExe(cmdline: string[], comm: string, targetBasename: string): boolean {
    if (!targetBasename) return false;
    const normalizedComm = comm.toLowerCase();
    if (normalizedComm === targetBasename) return true;
    // /proc/comm is truncated to 15 characters.
    if (normalizedComm && targetBasename.startsWith(normalizedComm) && normalizedComm.length >= 15) {
        return true;
    }
    return cmdline.some((arg) => basenameLower(arg) === targetBasename);
}

/** Find the Linux PID of a running game, preferring the highest-RSS match. */
export function findLinuxGamePid(exePath: string, procRoot = '/proc', selfPid = process.pid): number {
    const targetBasename = basenameLower(exePath);
    if (!targetBasename) return 0;

    let bestPid = 0;
    let bestRss = -1;
    for (const pid of listProcPids(procRoot)) {
        if (pid === selfPid) continue;
        const comm = (readProcFile(procRoot, pid, 'comm')?.toString('utf-8') ?? '').trim();
        const cmdline = splitNulString(readProcFile(procRoot, pid, 'cmdline'));
        if ((cmdline.length === 0 && !comm) || !cmdlineMatchesExe(cmdline, comm, targetBasename)) continue;
        // A launcher can inherit the game's command line in some Proton
        // versions. Do not let that high-RSS helper win over the real image.
        if (LAUNCHER_COMMS.has(comm.toLowerCase()) && comm.toLowerCase() !== targetBasename) continue;
        const rss = readProcRss(procRoot, pid);
        if (rss > bestRss) {
            bestRss = rss;
            bestPid = pid;
        }
    }
    return bestPid;
}

function resolveFromPath(command: string, searchPath: string): string {
    if (!command) return '';
    if (path.isAbsolute(command)) return command;
    for (const dir of searchPath.split(':')) {
        if (!dir) continue;
        const candidate = path.join(dir, command);
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            // Keep searching.
        }
    }
    return '';
}

function existingFile(value: string, searchPath = process.env.PATH ?? ''): string {
    if (!value) return '';
    const candidate = path.isAbsolute(value) ? value : resolveFromPath(value, searchPath);
    try {
        return fs.statSync(candidate).isFile() ? candidate : '';
    } catch {
        return '';
    }
}

function candidateWinePaths(root: string): string[] {
    if (!root) return [];
    return [
        path.join(root, 'files', 'bin', 'wine'),
        path.join(root, 'dist', 'bin', 'wine'),
        path.join(root, 'files', 'bin', 'wine64'),
        path.join(root, 'dist', 'bin', 'wine64'),
    ];
}

function deriveWineFromToolPaths(env: Record<string, string>): string {
    const roots = [env.PROTONPATH, env.STEAM_COMPAT_TOOL_PATHS, env.STEAM_COMPAT_MOUNTS]
        .filter(Boolean)
        .flatMap((value) => value.split(':'));
    for (const root of roots) {
        for (const candidate of candidateWinePaths(root)) {
            if (existingFile(candidate, env.PATH)) return candidate;
        }
    }
    return '';
}

function deriveWineFromProcess(procRoot: string, linuxPid: number, env: Record<string, string>): string {
    // WINELOADER is already the launcher's authoritative path. Keep it even
    // when a synthetic/test proc tree points at a path that is not visible to
    // the host; a real process normally makes this path executable.
    if (env.WINELOADER) {
        return path.isAbsolute(env.WINELOADER)
            ? env.WINELOADER
            : resolveFromPath(env.WINELOADER, env.PATH) || env.WINELOADER;
    }
    if (env.WINE) {
        return path.isAbsolute(env.WINE)
            ? env.WINE
            : resolveFromPath(env.WINE, env.PATH) || env.WINE;
    }

    const wineServer = existingFile(env.WINESERVER, env.PATH);
    if (wineServer) {
        const sibling = path.join(path.dirname(wineServer), 'wine');
        if (existingFile(sibling, env.PATH)) return sibling;
    }

    const fromTools = deriveWineFromToolPaths(env);
    if (fromTools) return fromTools;

    // For plain Wine, /proc/<pid>/exe is normally wine-preloader. Its sibling
    // is the launcher users expect (`wine` or `wine64`).
    const image = readProcLink(procRoot, linuxPid, 'exe');
    if (image) {
        for (const name of ['wine', 'wine64']) {
            const sibling = path.join(path.dirname(image), name);
            if (existingFile(sibling, env.PATH)) return sibling;
        }
    }
    for (const name of ['wine', 'wine64']) {
        const found = resolveFromPath(name, env.PATH ?? '');
        if (existingFile(found, env.PATH)) return found;
    }
    return '';
}

function processWasLaunchedByUmu(procRoot: string, linuxPid: number): boolean {
    let currentPid = linuxPid;
    const visited = new Set<number>();
    for (let depth = 0; depth < 12 && currentPid > 1 && !visited.has(currentPid); depth += 1) {
        visited.add(currentPid);
        const stat = readProcFile(procRoot, currentPid, 'stat')?.toString('utf-8') ?? '';
        const close = stat.lastIndexOf(')');
        if (close < 0) break;
        const fields = stat.slice(close + 2).trim().split(/\s+/);
        const parentPid = Number(fields[1]);
        if (!Number.isFinite(parentPid) || parentPid <= 0 || parentPid === currentPid) break;
        currentPid = parentPid;
        const comm = (readProcFile(procRoot, currentPid, 'comm')?.toString('utf-8') ?? '').trim().toLowerCase();
        const args = splitNulString(readProcFile(procRoot, currentPid, 'cmdline')).map(basenameLower);
        if (comm === 'umu-run' || comm === 'umu' || args.includes('umu-run') || args.includes('umu')) return true;
    }
    return false;
}

/**
 * Resolve the environment and Windows launcher for a running Wine/Proton game.
 * `linuxPidOverride` is used by the auto-launcher so it does not race a second
 * process lookup while a game is starting.
 */
export function resolveWineLaunch(
    exePath: string,
    procRoot = '/proc',
    selfPid = process.pid,
    linuxPidOverride?: number,
): WineLaunchContext {
    const linuxPid = linuxPidOverride && linuxPidOverride > 0
        ? linuxPidOverride
        : findLinuxGamePid(exePath, procRoot, selfPid);
    const gameEnv = linuxPid > 0 ? readProcEnviron(linuxPid, procRoot) : {};
    const env: Record<string, string> = {};
    for (const key of WINE_ENV_KEYS) {
        if (typeof gameEnv[key] === 'string' && gameEnv[key].length > 0) env[key] = gameEnv[key];
    }
    // Locale variables are not a fixed allowlist because users commonly launch
    // Japanese VNs with LC_ALL/LC_CTYPE overrides.
    for (const [key, value] of Object.entries(gameEnv)) {
        if (/^LC_/.test(key) && value) env[key] = value;
    }

    let winePrefix = env.WINEPREFIX || '';
    if (!winePrefix && env.STEAM_COMPAT_DATA_PATH) winePrefix = path.join(env.STEAM_COMPAT_DATA_PATH, 'pfx');
    if (winePrefix) env.WINEPREFIX = winePrefix;

    // UMU commonly leaves the launcher out of the visible process ancestry,
    // so retain the environment signature used by UMU as a second detector.
    const isUmu = linuxPid > 0 && (
        processWasLaunchedByUmu(procRoot, linuxPid) ||
        Boolean(gameEnv.PROTON_VERB && gameEnv.STEAM_COMPAT_TOOL_PATHS)
    );
    const umuBinary = isUmu ? resolveFromPath('umu-run', env.PATH ?? '') || existingFile('/usr/bin/umu-run') : '';
    const wineBinary = umuBinary || deriveWineFromProcess(procRoot, linuxPid, gameEnv);
    if (isUmu) {
        // `waitforexitandrun` is correct for a game, but would make the helper
        // wait for the game to exit. UMU uses `run` for sidecar processes.
        env.PROTON_VERB = 'run';
    }
    return { linuxPid, winePrefix, wineBinary, isUmu, env };
}

export const __test = { deriveProtonWine: deriveWineFromToolPaths, processWasLaunchedByUmu };
