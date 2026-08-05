import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'child_process';

import {
    BACKEND_GITHUB_REPO_URL,
    execFileAsync,
    getResourcesDir,
    getSanitizedPythonEnv,
    isDev,
    PACKAGE_NAME,
    resolvePreReleaseMetadata,
} from '../util.js';
import { getPreReleaseArchiveUrl } from '../../shared/prerelease.js';

const PINNED_UV_VERSION = '0.9.22';

// ---------------------------------------------------------------------------
// General helpers
// ---------------------------------------------------------------------------

interface RunCommandOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    suppressOutput?: boolean;
    onProgress?: (event: UvCommandProgressEvent) => void;
}

export interface UvCommandProgressEvent {
    progress: number | null;
    message: string;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function formatCommand(command: string, args: string[]): string {
    const escaped = args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg));
    return [command, ...escaped].join(' ');
}

function appendRecentLines(target: string[], chunk: string): void {
    const lines = chunk.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        target.push(trimmed);
    }
    while (target.length > 40) {
        target.shift();
    }
}

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function parseUvProgressText(
    text: string,
    currentProgress: number = 0
): UvCommandProgressEvent | null {
    const cleanedLines = stripAnsi(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const latestLine = cleanedLines.slice(-1)[0];
    if (!latestLine) {
        return null;
    }

    if (/resolved|audited/i.test(latestLine)) {
        return { progress: Math.max(currentProgress, 0.25), message: latestLine };
    }

    if (/download|fetch|building|compile/i.test(latestLine)) {
        return { progress: Math.max(currentProgress, 0.45), message: latestLine };
    }

    if (/prepared|extract/i.test(latestLine)) {
        return { progress: Math.max(currentProgress, 0.65), message: latestLine };
    }

    if (/installed|uninstalled|updated|complete/i.test(latestLine)) {
        return { progress: Math.max(currentProgress, 0.85), message: latestLine };
    }

    return {
        progress: Math.max(currentProgress, Math.min(currentProgress + 0.02, 0.9)),
        message: latestLine,
    };
}

export async function runCommand(
    command: string,
    args: string[],
    stdout: boolean,
    stderr: boolean,
    prefixText: string = '',
    options: RunCommandOptions = {}
): Promise<void> {
    return new Promise((resolve, reject) => {
        const commandLine = formatCommand(command, args);
        const recentStdout: string[] = [];
        const recentStderr: string[] = [];
        let settled = false;
        let progress = 0.08;
        const finish = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (progressTimer) {
                clearInterval(progressTimer);
            }
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        const progressTimer = options.onProgress
            ? setInterval(() => {
                  progress = Math.min(progress + 0.03, 0.92);
                  const latestMessage =
                      recentStderr[recentStderr.length - 1] ||
                      recentStdout[recentStdout.length - 1] ||
                      `${prefixText.trim() || 'uv'} in progress...`;
                  options.onProgress?.({
                      progress,
                      message: latestMessage,
                  });
              }, 800)
            : null;

        const proc = spawn(command, args, {
            env: {
                ...getSanitizedPythonEnv(),
                ...(options.env || {}),
            },
            cwd: options.cwd,
        });

        if (stdout) {
            proc.stdout.on('data', (data) => {
                const text = data.toString();
                appendRecentLines(recentStdout, text);
                const parsed = options.onProgress ? parseUvProgressText(text, progress) : null;
                if (parsed) {
                    progress = parsed.progress ?? progress;
                    options.onProgress?.(parsed);
                }
                if (options.suppressOutput) {
                    return;
                }
                console.log(`${prefixText}stdout: ${text}`);
            });
        }

        if (stderr) {
            proc.stderr.on('data', (data) => {
                const text = data.toString();
                appendRecentLines(recentStderr, text);
                const parsed = options.onProgress ? parseUvProgressText(text, progress) : null;
                if (parsed) {
                    progress = parsed.progress ?? progress;
                    options.onProgress?.(parsed);
                }
                if (options.suppressOutput) {
                    return;
                }
                console.error(`${prefixText}stderr: ${text}`);
            });
        }

        proc.on('close', (code, signal) => {
            if (code === 0 && !signal) {
                finish();
                return;
            }

            const tail = [
                ...recentStdout.slice(-10).map((line) => `${prefixText}stdout: ${line}`),
                ...recentStderr.slice(-10).map((line) => `${prefixText}stderr: ${line}`),
            ];
            const details = tail.length > 0 ? `\nRecent command output:\n${tail.join('\n')}` : '';
            if (signal) {
                finish(new Error(`Command "${commandLine}" terminated by signal ${signal}.${details}`));
                return;
            }
            finish(new Error(`Command "${commandLine}" failed with exit code ${code}.${details}`));
        });

        proc.on('error', (err) => {
            finish(new Error(`Failed to start command "${commandLine}": ${toErrorMessage(err)}`));
        });
    });
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function parseVersionSegments(version: string): number[] {
    return version
        .trim()
        .split('.')
        .map((segment) => {
            const match = segment.match(/^(\d+)/);
            return match ? Number.parseInt(match[1], 10) : 0;
        });
}

function isVersionAtLeast(currentVersion: string, minimumVersion: string): boolean {
    const current = parseVersionSegments(currentVersion);
    const minimum = parseVersionSegments(minimumVersion);
    const maxLength = Math.max(current.length, minimum.length);

    for (let index = 0; index < maxLength; index++) {
        const currentValue = current[index] ?? 0;
        const minimumValue = minimum[index] ?? 0;
        if (currentValue > minimumValue) {
            return true;
        }
        if (currentValue < minimumValue) {
            return false;
        }
    }

    return true;
}

// ---------------------------------------------------------------------------
// Venv path helpers
// ---------------------------------------------------------------------------

export function getVenvDirFromPythonPath(pythonPath: string): string {
    const scriptsDir = path.dirname(pythonPath);
    return path.dirname(scriptsDir);
}

export function getPythonExecutablePathForVenv(venvDir: string): string {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

// ---------------------------------------------------------------------------
// Package introspection
// ---------------------------------------------------------------------------

export async function getInstalledPackageVersion(
    pythonPath: string,
    packageName: string
): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(pythonPath, ['-m', 'pip', 'show', packageName]);
        const match = stdout.match(/^Version:\s*(.+)$/im);
        return match ? match[1].trim() : null;
    } catch {
        return null;
    }
}

const READ_DIRECT_URL_SCRIPT = `
import json
import sys
from importlib.metadata import distributions

for dist in distributions(name=sys.argv[1]):
    try:
        raw = dist.read_text("direct_url.json")
        payload = json.loads(raw) if raw else None
    except (OSError, UnicodeError, ValueError):
        continue
    if not isinstance(payload, dict):
        continue
    url = payload.get("url")
    if isinstance(url, str) and url.strip():
        print(json.dumps({"url": url.strip()}))
        break
`.trim();

export async function getInstalledPackageDirectUrl(
    pythonPath: string,
    packageName: string
): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(pythonPath, [
            '-c',
            READ_DIRECT_URL_SCRIPT,
            packageName,
        ]);
        const payload: unknown = JSON.parse(stdout.trim());
        if (
            payload &&
            typeof payload === 'object' &&
            !Array.isArray(payload) &&
            typeof (payload as { url?: unknown }).url === 'string'
        ) {
            const url = (payload as { url: string }).url.trim();
            return url || null;
        }
    } catch {
        // PyPI installs have no direct_url.json; malformed metadata fails closed.
    }
    return null;
}

export async function isPackageInstalled(
    pythonPath: string,
    packageName: string
): Promise<boolean> {
    const version = await getInstalledPackageVersion(pythonPath, packageName);
    return version !== null;
}

// ---------------------------------------------------------------------------
// uv tooling
// ---------------------------------------------------------------------------

export async function checkAndInstallUV(pythonPath: string): Promise<void> {
    const uvVersion = await getInstalledPackageVersion(pythonPath, 'uv');
    if (uvVersion && isVersionAtLeast(uvVersion, PINNED_UV_VERSION)) {
        return;
    }

    if (uvVersion) {
        console.log(
            `uv ${uvVersion} found, updating to minimum supported ${PINNED_UV_VERSION}...`
        );
    } else {
        console.log(`uv is not installed. Installing minimum supported ${PINNED_UV_VERSION}...`);
    }

    try {
        await execFileAsync(pythonPath, [
            '-m',
            'pip',
            'install',
            '--no-warn-script-location',
            `uv==${PINNED_UV_VERSION}`,
        ]);
        console.log('uv installation complete.');
    } catch (err) {
        const message = `Failed to install uv ${PINNED_UV_VERSION}: ${toErrorMessage(err)}`;
        console.error(message);
        throw new Error(message);
    }
}

export async function checkAndEnsurePip(pythonPath: string): Promise<void> {
    try {
        await execFileAsync(pythonPath, ['-m', 'pip', '--version']);
    } catch (pipErr) {
        console.warn(
            `pip is not available in the managed environment. Attempting ensurepip --upgrade (${toErrorMessage(
                pipErr
            )})`
        );
        try {
            await execFileAsync(pythonPath, ['-m', 'ensurepip', '--upgrade']);
            console.log('ensurepip completed successfully.');
            await execFileAsync(pythonPath, ['-m', 'pip', '--version']);
        } catch (ensureErr) {
            const message = `Failed to bootstrap pip via ensurepip: ${toErrorMessage(ensureErr)}`;
            console.error(message);
            throw new Error(message);
        }
    }
}

export async function checkAndInstallPython311(pythonPath: string): Promise<void> {
    try {
        await execFileAsync(pythonPath, [
            '-m',
            'uv',
            'python',
            'install',
            '3.13',
        ]);
        await execFileAsync(pythonPath, [
            '-m',
            'uv',
            'pin',
            '3.13',
        ]);
    } catch (err) {
        const message = `Failed to install or pin Python 3.13: ${toErrorMessage(err)}`;
        console.error(message);
        throw new Error(message);
    }
}

/**
 * Purge uv's global package cache. Best-effort: cache cleanup should never fail
 * an install/update, so errors are logged and swallowed. Used by the retry/repair
 * paths to recover from a corrupt cache before re-syncing.
 */
export async function cleanUvCache(pythonPath: string): Promise<void> {
    try {
        await runCommand(pythonPath, ['-m', 'uv', 'cache', 'clean'], true, true, '', {
            suppressOutput: true,
        });
    } catch (err) {
        console.warn(`Failed to clean uv cache (non-fatal): ${toErrorMessage(err)}`);
    }
}

// ---------------------------------------------------------------------------
// Project path – where uv.lock + pyproject.toml live
// ---------------------------------------------------------------------------

/**
 * The bundled uv.lock + pyproject.toml + GameSentenceMiner source live inside
 * the resources directory in production, and at the repo root in dev mode.
 */
export function getProjectPath(): string {
    return path.resolve(getResourcesDir());
}

/**
 * Read the GSM backend version pinned in the bundled pyproject.toml. This is the
 * version shipped with this Electron release; the backend stays locked to it.
 */
export function getBundledBackendVersion(): string | null {
    try {
        const pyprojectPath = path.join(getProjectPath(), 'pyproject.toml');
        const pyproject = fs.readFileSync(pyprojectPath, 'utf8');
        const match = pyproject.match(/\[project\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
        return match ? match[1].trim() : null;
    } catch (err) {
        console.warn(`Failed to read bundled backend version: ${toErrorMessage(err)}`);
        return null;
    }
}

/**
 * Return whether an installed backend is compatible with the Electron build.
 * Stable clients accept their bundled Python version plus PEP 440 post releases
 * of that exact version, such as 2026.7.4.post1.
 */
export function isBackendVersionCompatible(
    installedVersion: string,
    bundledVersion: string
): boolean {
    const escapedBundledVersion = bundledVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        `^${escapedBundledVersion}(?:\\.post\\d+)?(?:\\+[A-Za-z0-9.-]+)?$`,
        'i'
    ).test(installedVersion);
}

export type BackendInstallReason =
    | 'missing'
    | 'source-mismatch'
    | 'version-mismatch'
    | 'post-release-check'
    | 'current';

export interface BundledBackendInstallPlan {
    shouldInstall: boolean;
    forceReinstall: boolean;
    reason: BackendInstallReason;
}

export interface BundledBackendInstallInput {
    installedVersion: string | null;
    bundledVersion: string | null;
    packageSpecifier: string;
    isPreRelease: boolean;
    isDevelopment?: boolean;
    installedDirectUrl: string | null;
}

function normalizePackageSource(value: string | null): string | null {
    const normalized = value?.trim().replace(/\/+$/u, '') ?? '';
    return normalized || null;
}

export function planBundledBackendInstall(
    input: BundledBackendInstallInput
): BundledBackendInstallPlan {
    if (!input.installedVersion) {
        return {
            shouldInstall: true,
            forceReinstall: true,
            reason: 'missing',
        };
    }

    const installedSource = normalizePackageSource(input.installedDirectUrl);
    const expectedSource = normalizePackageSource(input.packageSpecifier);
    const expectedDevelopmentSource =
        input.isDevelopment && expectedSource
            ? normalizePackageSource(pathToFileURL(path.resolve(expectedSource)).href)
            : null;
    const sourceMatches =
        input.isPreRelease || input.isDevelopment
            ? installedSource !== null &&
              (installedSource === expectedSource ||
                  installedSource === expectedDevelopmentSource)
            : installedSource === null;
    if (!sourceMatches) {
        return {
            shouldInstall: true,
            forceReinstall: true,
            reason: 'source-mismatch',
        };
    }

    if (
        !input.isPreRelease &&
        input.bundledVersion !== null &&
        !isBackendVersionCompatible(
            input.installedVersion,
            input.bundledVersion
        )
    ) {
        return {
            shouldInstall: true,
            forceReinstall: true,
            reason: 'version-mismatch',
        };
    }

    if (!input.isPreRelease && input.bundledVersion !== null) {
        return {
            shouldInstall: true,
            forceReinstall: false,
            reason: 'post-release-check',
        };
    }

    return {
        shouldInstall: false,
        forceReinstall: false,
        reason: 'current',
    };
}

function getNextReleaseVersion(version: string): string | null {
    if (!/^\d+(?:\.\d+)+$/.test(version)) {
        return null;
    }

    const parts = version.split('.').map((part) => Number.parseInt(part, 10));
    parts[parts.length - 1] += 1;
    return parts.join('.');
}

/**
 * Specifier for installing the GSM backend package.
 *
 * Pre-release (beta) builds are cut from a branch whose backend code is not
 * published to PyPI, so we install from that branch's GitHub source archive
 * (`<repo>/archive/refs/heads/<branch>.zip`), read from the bundled
 * prerelease.json. This makes beta testers actually run the branch's backend
 * instead of a stale (or nonexistent) PyPI wheel for the bundled version. The zip
 * archive (rather than a `git+` specifier) keeps git from being a hard runtime
 * requirement on the user's machine. uv downloads + builds it in a temp dir, which
 * also sidesteps the read-only egg-info build failure that bundled-source installs
 * hit on AppImage squashfs mounts and macOS .app bundles (issue #479).
 *
 * For stable production releases we install from PyPI within the compatible
 * release window. For example, a client bundling 2026.7.4 installs
 * `GameSentenceMiner>=2026.7.4,<2026.7.5`, allowing 2026.7.4.postN hotfixes
 * without allowing the backend for a newer Electron client. Dependencies remain
 * locked by the bundled uv.lock (see {@link syncLockedEnvironment}).
 *
 * In dev we install from the local working tree (writable, picks up local
 * changes, and the dev version usually isn't published to PyPI). We also fall
 * back to the bundled source path if the version can't be read.
 */
export function getBundledBackendSpecifier(): string {
    if (isDev) {
        return getProjectPath();
    }

    const preReleaseArchive = getPreReleaseArchiveUrl(
        resolvePreReleaseMetadata(),
        BACKEND_GITHUB_REPO_URL
    );
    if (preReleaseArchive) {
        return preReleaseArchive;
    }

    const version = getBundledBackendVersion();
    if (version) {
        const nextReleaseVersion = getNextReleaseVersion(version);
        if (nextReleaseVersion) {
            return `${PACKAGE_NAME}>=${version},<${nextReleaseVersion}`;
        }
        return `${PACKAGE_NAME}==${version}`;
    }

    console.warn(
        'Could not determine bundled backend version; falling back to bundled source path.'
    );
    return getProjectPath();
}

// ---------------------------------------------------------------------------
// Extras resolution
// ---------------------------------------------------------------------------

function normalizeExtras(extras: string[] = []): string[] {
    const normalized = extras
        .map((extra) => extra.trim().toLowerCase())
        .filter((extra) => extra.length > 0);
    return Array.from(new Set(normalized));
}

function extractOptionalDependencyExtras(pyprojectPath: string): string[] | null {
    if (!fs.existsSync(pyprojectPath)) {
        return null;
    }

    try {
        const pyproject = fs.readFileSync(pyprojectPath, 'utf8');
        const optionalSectionMatch = pyproject.match(
            /\[project\.optional-dependencies\]([\s\S]*?)(?:\n\[|$)/
        );
        if (!optionalSectionMatch) {
            return [];
        }

        const extras: string[] = [];
        for (const rawLine of optionalSectionMatch[1].split(/\r?\n/)) {
            const line = rawLine.trim();
            if (line.length === 0 || line.startsWith('#')) {
                continue;
            }

            const match = line.match(/^([A-Za-z0-9._-]+)\s*=\s*\[/);
            if (match) {
                extras.push(match[1].toLowerCase());
            }
        }
        return Array.from(new Set(extras));
    } catch (err) {
        console.warn(`Failed to parse optional dependencies from ${pyprojectPath}:`, err);
        return null;
    }
}

export interface ResolvedExtras {
    selectedExtras: string[];
    ignoredExtras: string[];
    allowedExtras: string[] | null;
}

/**
 * Filter the user's requested extras against what pyproject.toml actually
 * defines.  Returns accepted, rejected, and full allowed sets.
 */
export function resolveRequestedExtras(
    requestedExtras: string[] = []
): ResolvedExtras {
    const normalizedRequested = normalizeExtras(requestedExtras);

    const pyprojectPath = path.join(getProjectPath(), 'pyproject.toml');
    const allowedExtras = extractOptionalDependencyExtras(pyprojectPath);

    if (!allowedExtras) {
        return {
            selectedExtras: normalizedRequested,
            ignoredExtras: [],
            allowedExtras: null,
        };
    }

    const allowedSet = new Set(allowedExtras.map((extra) => extra.toLowerCase()));
    const selectedExtras = normalizedRequested.filter((extra) => allowedSet.has(extra));
    const ignoredExtras = normalizedRequested.filter((extra) => !allowedSet.has(extra));

    return {
        selectedExtras,
        ignoredExtras,
        allowedExtras,
    };
}

// ---------------------------------------------------------------------------
// Sync & install
// ---------------------------------------------------------------------------

/**
 * Run `uv sync --frozen` against the bundled uv.lock + pyproject.toml.
 *
 * This resolves the shared cross-platform lockfile that ships with every
 * release and syncs the venv to match it, including any requested extras.
 *
 * @param checkOnly  When true adds `--check` (dry-run, throws on mismatch).
 */
export async function syncLockedEnvironment(
    pythonPath: string,
    extras: string[] = [],
    checkOnly: boolean = false,
    onProgress?: (event: UvCommandProgressEvent) => void
): Promise<void> {
    const projectPath = getProjectPath();
    const normalizedExtras = normalizeExtras(extras);
    const args = [
        '-m',
        'uv',
        'sync',
        '--active',
        '--project',
        projectPath,
        '--frozen',
        '--no-dev',
        '--no-editable',
        '--no-install-project',
        '--inexact',
    ];

    if (checkOnly) {
        args.push('--check');
    }

    for (const extra of normalizedExtras) {
        args.push('--extra', extra);
    }

    await runCommand(pythonPath, args, true, true, 'Sync: ', {
        env: {
            VIRTUAL_ENV: getVenvDirFromPythonPath(pythonPath),
        },
        suppressOutput: true,
        onProgress,
    });
}

/**
 * Install (or upgrade) a single package without pulling in its
 * dependencies – the lockfile sync above already handles those.
 */
export async function installPackageNoDeps(
    pythonPath: string,
    packageSpecifier: string,
    forceReinstall: boolean = false,
    onProgress?: (event: UvCommandProgressEvent) => void
): Promise<void> {
    const args = ['-m', 'uv', 'pip', 'install', '--no-deps', '--upgrade'];
    if (forceReinstall) {
        args.push('--force-reinstall');
    }
    args.push(packageSpecifier);
    await runCommand(pythonPath, args, true, true, 'Install: ', {
        suppressOutput: true,
        onProgress,
    });
}
