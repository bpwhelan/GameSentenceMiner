import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'child_process';

import {
    execFileAsync,
    getResourcesDir,
    getSanitizedPythonEnv,
} from '../util.js';

const PINNED_UV_VERSION = '0.9.22';

// ---------------------------------------------------------------------------
// General helpers
// ---------------------------------------------------------------------------

interface RunCommandOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    suppressOutput?: boolean;
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
        const finish = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

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

export async function cleanUvCache(pythonPath: string): Promise<void> {
    await runCommand(pythonPath, ['-m', 'uv', 'cache', 'clean'], true, true, '', {
        suppressOutput: true,
    });
}

// ---------------------------------------------------------------------------
// Project path – where uv.lock + pyproject.toml live
// ---------------------------------------------------------------------------

/**
 * In production the bundled uv.lock + pyproject.toml are inside the
 * resources directory.  In dev mode they are at the repo root.
 */
export function getProjectPath(): string {
    return path.resolve(getResourcesDir());
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
 * Run `uv sync --locked` against the bundled uv.lock + pyproject.toml.
 *
 * This resolves the shared cross-platform lockfile that ships with every
 * release and syncs the venv to match it, including any requested extras.
 *
 * @param checkOnly  When true adds `--check` (dry-run, throws on mismatch).
 */
export async function syncLockedEnvironment(
    pythonPath: string,
    extras: string[] = [],
    checkOnly: boolean = false
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
        '--locked',
        '--no-dev',
        '--no-editable',
        '--no-install-project',
        '--inexact',
        '--no-progress',
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
    });
}

/**
 * Install (or upgrade) a single package without pulling in its
 * dependencies – the lockfile sync above already handles those.
 */
export async function installPackageNoDeps(
    pythonPath: string,
    packageSpecifier: string,
    forceReinstall: boolean = false
): Promise<void> {
    const args = ['-m', 'uv', 'pip', 'install', '--no-progress', '--no-deps', '--upgrade'];
    if (forceReinstall) {
        args.push('--force-reinstall');
    }
    args.push(packageSpecifier);
    await runCommand(pythonPath, args, true, true, 'Install: ', {
        suppressOutput: true,
    });
}
