import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'child_process';

import {
    DOWNLOAD_DIR,
    execFileAsync,
    getResourcesDir,
    getSanitizedPythonEnv,
    isDev,
} from '../util.js';

const GITHUB_OWNER = 'bpwhelan';
const GITHUB_REPO = 'GameSentenceMiner';
const PINNED_UV_VERSION = '0.9.22';
const RUNTIME_LOCK_MANIFEST_FILE = 'runtime-lock-manifest.json';

export type LockSource = 'release' | 'bundled' | 'dev' | 'none';

export interface LockFileInfo {
    hasLockfile: boolean;
    lockfilePath: string;
    projectPath: string;
    source: LockSource;
    releaseTag?: string;
    projectVersion?: string;
    allowedExtras?: string[];
    manifestPath?: string;
    manifestVerified?: boolean;
    matchesRequestedVersion?: boolean;
}

interface RuntimeLockManifest {
    schemaVersion?: number;
    generatedAt?: string;
    projectName?: string;
    projectVersion?: string;
    uvVersion?: string;
    lockSha256?: string;
    pyprojectSha256?: string;
    allowedExtras?: string[];
}

interface RunCommandOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    suppressOutput?: boolean;
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
        const recentStdout: string[] = [];
        const recentStderr: string[] = [];
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
                if (options.suppressOutput) {
                    appendRecentLines(recentStdout, text);
                    return;
                }
                console.log(`${prefixText}stdout: ${text}`);
            });
        }

        if (stderr) {
            proc.stderr.on('data', (data) => {
                const text = data.toString();
                if (options.suppressOutput) {
                    appendRecentLines(recentStderr, text);
                    return;
                }
                console.error(`${prefixText}stderr: ${text}`);
            });
        }

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                const tail = [
                    ...recentStdout.slice(-10).map((line) => `${prefixText}stdout: ${line}`),
                    ...recentStderr.slice(-10).map((line) => `${prefixText}stderr: ${line}`),
                ];
                const details =
                    tail.length > 0 ? `\nRecent command output:\n${tail.join('\n')}` : '';
                reject(new Error(`Command failed with exit code ${code}.${details}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}

function normalizeExtras(extras: string[] = []): string[] {
    const normalized = extras
        .map((extra) => extra.trim().toLowerCase())
        .filter((extra) => extra.length > 0);
    return Array.from(new Set(normalized));
}

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

function normalizeVersion(version: string | null | undefined): string | null {
    if (!version) {
        return null;
    }
    const trimmed = version.trim();
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

function versionsMatch(expected: string | null | undefined, actual: string | null | undefined): boolean {
    const normalizedExpected = normalizeVersion(expected);
    const normalizedActual = normalizeVersion(actual);
    if (!normalizedExpected || !normalizedActual) {
        return false;
    }
    return normalizedExpected === normalizedActual;
}

function sha256File(filePath: string): string | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(filePath));
        return hash.digest('hex').toLowerCase();
    } catch {
        return null;
    }
}

export function getVenvDirFromPythonPath(pythonPath: string): string {
    const scriptsDir = path.dirname(pythonPath);
    return path.dirname(scriptsDir);
}

export function getPythonExecutablePathForVenv(venvDir: string): string {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

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
        console.error('Failed to install uv:', err);
        process.exit(1);
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
        console.error('Failed to install or pin Python 3.13:', err);
        process.exit(1);
    }
}

export async function cleanUvCache(pythonPath: string): Promise<void> {
    await runCommand(pythonPath, ['-m', 'uv', 'cache', 'clean'], true, true, '', {
        suppressOutput: true,
    });
}

function getReleaseTagCandidates(version: string): string[] {
    const trimmed = version.trim();
    if (!trimmed) {
        return [];
    }
    if (trimmed.startsWith('v')) {
        return [trimmed, trimmed.slice(1)];
    }
    return [`v${trimmed}`, trimmed];
}

function getLockAssetCandidates(): string[] {
    const arch =
        process.arch === 'x64'
            ? 'x64'
            : process.arch === 'arm64'
              ? 'arm64'
              : process.arch;
    const platformAlias =
        process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macos'
              : process.platform;
    return [
        `uv-${process.platform}-${arch}.lock`,
        `uv-${platformAlias}-${arch}.lock`,
        'uv.lock',
    ];
}

async function downloadReleaseAsset(
    version: string,
    assetNames: string[],
    destPath: string
): Promise<{ downloaded: boolean; tag?: string; asset?: string }> {
    try {
        for (const tag of getReleaseTagCandidates(version)) {
            for (const assetName of assetNames) {
                const url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;
                const response = await fetch(url);
                if (!response.ok) {
                    continue;
                }
                const content = await response.text();
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.writeFileSync(destPath, content);
                return { downloaded: true, tag, asset: assetName };
            }
        }
        return { downloaded: false };
    } catch (err) {
        console.error('Error downloading release asset:', err);
        return { downloaded: false };
    }
}

function readRuntimeLockManifest(manifestPath: string): RuntimeLockManifest | null {
    if (!fs.existsSync(manifestPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeLockManifest;
        const normalizedAllowedExtras = Array.isArray(parsed.allowedExtras)
            ? normalizeExtras(
                  parsed.allowedExtras.filter((extra): extra is string => typeof extra === 'string')
              )
            : undefined;
        return {
            ...parsed,
            lockSha256:
                typeof parsed.lockSha256 === 'string'
                    ? parsed.lockSha256.trim().toLowerCase()
                    : undefined,
            pyprojectSha256:
                typeof parsed.pyprojectSha256 === 'string'
                    ? parsed.pyprojectSha256.trim().toLowerCase()
                    : undefined,
            projectVersion:
                typeof parsed.projectVersion === 'string'
                    ? parsed.projectVersion.trim()
                    : undefined,
            allowedExtras: normalizedAllowedExtras,
        };
    } catch (err) {
        console.warn(`Failed to parse runtime lock manifest at ${manifestPath}:`, err);
        return null;
    }
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

interface LockValidationResult {
    valid: boolean;
    projectVersion: string | null;
    allowedExtras: string[] | null;
    manifestPath?: string;
    manifestVerified: boolean;
    failureReason?: string;
}

function validateRuntimeLockArtifacts(
    lockfilePath: string,
    pyprojectPath: string,
    expectedVersion: string | null,
    manifestPath?: string
): LockValidationResult {
    if (!fs.existsSync(lockfilePath) || !fs.existsSync(pyprojectPath)) {
        return {
            valid: false,
            projectVersion: null,
            allowedExtras: null,
            manifestVerified: false,
            failureReason: 'Missing uv.lock and/or pyproject.toml artifacts.',
        };
    }

    const projectVersion = extractProjectVersion(pyprojectPath);
    const allowedExtrasFromPyproject = extractOptionalDependencyExtras(pyprojectPath);

    if (expectedVersion && projectVersion && !versionsMatch(expectedVersion, projectVersion)) {
        return {
            valid: false,
            projectVersion,
            allowedExtras: allowedExtrasFromPyproject,
            manifestVerified: false,
            failureReason: `Artifact project version ${projectVersion} does not match expected ${expectedVersion}.`,
        };
    }

    let manifestVerified = false;
    let allowedExtras = allowedExtrasFromPyproject;
    const manifest = manifestPath ? readRuntimeLockManifest(manifestPath) : null;

    if (manifest) {
        const lockSha256 = manifest.lockSha256;
        if (lockSha256) {
            const currentLockSha256 = sha256File(lockfilePath);
            if (!currentLockSha256 || currentLockSha256 !== lockSha256) {
                return {
                    valid: false,
                    projectVersion,
                    allowedExtras,
                    manifestPath,
                    manifestVerified: false,
                    failureReason: 'runtime-lock-manifest lockSha256 mismatch.',
                };
            }
            manifestVerified = true;
        }

        const pyprojectSha256 = manifest.pyprojectSha256;
        if (pyprojectSha256) {
            const currentPyprojectSha256 = sha256File(pyprojectPath);
            if (!currentPyprojectSha256 || currentPyprojectSha256 !== pyprojectSha256) {
                return {
                    valid: false,
                    projectVersion,
                    allowedExtras,
                    manifestPath,
                    manifestVerified: false,
                    failureReason: 'runtime-lock-manifest pyprojectSha256 mismatch.',
                };
            }
            manifestVerified = true;
        }

        if (manifest.projectVersion && projectVersion && !versionsMatch(manifest.projectVersion, projectVersion)) {
            return {
                valid: false,
                projectVersion,
                allowedExtras,
                manifestPath,
                manifestVerified: false,
                failureReason: `Manifest projectVersion ${manifest.projectVersion} does not match pyproject version ${projectVersion}.`,
            };
        }

        if (expectedVersion && manifest.projectVersion && !versionsMatch(expectedVersion, manifest.projectVersion)) {
            return {
                valid: false,
                projectVersion,
                allowedExtras,
                manifestPath,
                manifestVerified: false,
                failureReason: `Manifest projectVersion ${manifest.projectVersion} does not match expected ${expectedVersion}.`,
            };
        }

        if (manifest.allowedExtras) {
            allowedExtras = manifest.allowedExtras;
        }
    }

    return {
        valid: true,
        projectVersion,
        allowedExtras,
        manifestPath: manifest ? manifestPath : undefined,
        manifestVerified,
    };
}

function extractProjectVersion(pyprojectPath: string): string | null {
    if (!fs.existsSync(pyprojectPath)) {
        return null;
    }
    try {
        const pyproject = fs.readFileSync(pyprojectPath, 'utf8');
        const projectSectionMatch = pyproject.match(/\[project\]([\s\S]*?)(?:\n\[|$)/);
        if (!projectSectionMatch) {
            return null;
        }
        const versionMatch = projectSectionMatch[1].match(/^\s*version\s*=\s*"([^"]+)"/m);
        return versionMatch ? versionMatch[1].trim() : null;
    } catch {
        return null;
    }
}

export function getLockProjectVersion(lockInfo: LockFileInfo): string | null {
    return lockInfo.projectVersion ?? extractProjectVersion(path.join(lockInfo.projectPath, 'pyproject.toml'));
}

export interface ResolvedExtras {
    selectedExtras: string[];
    ignoredExtras: string[];
    allowedExtras: string[] | null;
}

export function resolveRequestedExtras(
    lockInfo: LockFileInfo,
    requestedExtras: string[] = []
): ResolvedExtras {
    const normalizedRequested = normalizeExtras(requestedExtras);
    if (!lockInfo.hasLockfile) {
        return {
            selectedExtras: normalizedRequested,
            ignoredExtras: [],
            allowedExtras: null,
        };
    }

    let allowedExtras: string[] | null = lockInfo.allowedExtras ?? null;
    if (!allowedExtras) {
        allowedExtras = extractOptionalDependencyExtras(path.join(lockInfo.projectPath, 'pyproject.toml'));
    }

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

function removeDirectoryIfExists(directoryPath: string): void {
    if (fs.existsSync(directoryPath)) {
        fs.rmSync(directoryPath, { recursive: true, force: true });
    }
}

function pruneOldRuntimeSyncDirectories(maxDirectoriesToKeep: number = 5): void {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        return;
    }

    try {
        const runtimeSyncDirectories = fs
            .readdirSync(DOWNLOAD_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('runtime-sync-'))
            .map((entry) => {
                const absolutePath = path.join(DOWNLOAD_DIR, entry.name);
                const stat = fs.statSync(absolutePath);
                return { absolutePath, mtimeMs: stat.mtimeMs };
            })
            .sort((left, right) => right.mtimeMs - left.mtimeMs);

        for (const staleDirectory of runtimeSyncDirectories.slice(maxDirectoriesToKeep)) {
            removeDirectoryIfExists(staleDirectory.absolutePath);
        }
    } catch (err) {
        console.warn('Failed to prune runtime-sync cache directories:', err);
    }
}

export async function getLockFile(
    releaseVersion: string | null,
    preRelease: boolean
): Promise<LockFileInfo> {
    const normalizedRequestedVersion = normalizeVersion(releaseVersion);

    if (isDev) {
        const projectPath = './';
        const lockfilePath = './uv.lock';
        const pyprojectPath = path.join(projectPath, 'pyproject.toml');
        const validation = validateRuntimeLockArtifacts(
            lockfilePath,
            pyprojectPath,
            null,
            undefined
        );
        return {
            hasLockfile: validation.valid,
            lockfilePath,
            projectPath,
            source: 'dev',
            projectVersion: validation.projectVersion ?? undefined,
            allowedExtras: validation.allowedExtras ?? undefined,
            manifestPath: validation.manifestPath,
            manifestVerified: validation.manifestVerified,
            matchesRequestedVersion:
                normalizedRequestedVersion && validation.projectVersion
                    ? versionsMatch(normalizedRequestedVersion, validation.projectVersion)
                    : undefined,
        };
    }

    if (!preRelease && normalizedRequestedVersion) {
        const sanitizedVersion = normalizedRequestedVersion.replace(/[^A-Za-z0-9._-]/g, '_');
        const versionedProjectDir = path.join(DOWNLOAD_DIR, `runtime-sync-${sanitizedVersion}`);
        const lockfilePath = path.join(versionedProjectDir, 'uv.lock');
        const pyprojectPath = path.join(versionedProjectDir, 'pyproject.toml');
        const manifestPath = path.join(versionedProjectDir, RUNTIME_LOCK_MANIFEST_FILE);

        let releaseTag: string | undefined;
        const hasCached = fs.existsSync(lockfilePath) && fs.existsSync(pyprojectPath);
        if (!hasCached) {
            console.log(
                `Downloading versioned sync artifacts for GameSentenceMiner ${normalizedRequestedVersion}...`
            );
            const lockResult = await downloadReleaseAsset(
                normalizedRequestedVersion,
                getLockAssetCandidates(),
                lockfilePath
            );
            const pyprojectResult = await downloadReleaseAsset(
                normalizedRequestedVersion,
                ['pyproject.toml'],
                pyprojectPath
            );
            releaseTag = lockResult.tag || pyprojectResult.tag;

            // Optional: runtime lock manifest for integrity checks and allowed extras.
            await downloadReleaseAsset(
                normalizedRequestedVersion,
                [RUNTIME_LOCK_MANIFEST_FILE],
                manifestPath
            );

            if (!lockResult.downloaded || !pyprojectResult.downloaded) {
                removeDirectoryIfExists(versionedProjectDir);
            }
        }

        if (fs.existsSync(lockfilePath) && fs.existsSync(pyprojectPath)) {
            const validation = validateRuntimeLockArtifacts(
                lockfilePath,
                pyprojectPath,
                normalizedRequestedVersion,
                manifestPath
            );
            if (validation.valid) {
                pruneOldRuntimeSyncDirectories();
                return {
                    hasLockfile: true,
                    lockfilePath,
                    projectPath: versionedProjectDir,
                    source: 'release',
                    releaseTag,
                    projectVersion: validation.projectVersion ?? undefined,
                    allowedExtras: validation.allowedExtras ?? undefined,
                    manifestPath: validation.manifestPath,
                    manifestVerified: validation.manifestVerified,
                    matchesRequestedVersion:
                        validation.projectVersion !== null
                            ? versionsMatch(normalizedRequestedVersion, validation.projectVersion)
                            : undefined,
                };
            }

            console.warn(
                `Discarding invalid release runtime lock artifacts for ${normalizedRequestedVersion}: ${validation.failureReason ?? 'validation failed.'}`
            );
            removeDirectoryIfExists(versionedProjectDir);
        }
    }

    const bundledProjectPath = getResourcesDir();
    const bundledLockfilePath = path.join(bundledProjectPath, 'uv.lock');
    const bundledPyprojectPath = path.join(bundledProjectPath, 'pyproject.toml');
    const bundledManifestPath = path.join(bundledProjectPath, RUNTIME_LOCK_MANIFEST_FILE);
    const hasBundled = fs.existsSync(bundledLockfilePath) && fs.existsSync(bundledPyprojectPath);
    if (hasBundled) {
        const validation = validateRuntimeLockArtifacts(
            bundledLockfilePath,
            bundledPyprojectPath,
            null,
            bundledManifestPath
        );

        if (validation.valid) {
            return {
                hasLockfile: true,
                lockfilePath: bundledLockfilePath,
                projectPath: bundledProjectPath,
                source: 'bundled',
                projectVersion: validation.projectVersion ?? undefined,
                allowedExtras: validation.allowedExtras ?? undefined,
                manifestPath: validation.manifestPath,
                manifestVerified: validation.manifestVerified,
                matchesRequestedVersion:
                    normalizedRequestedVersion && validation.projectVersion
                        ? versionsMatch(normalizedRequestedVersion, validation.projectVersion)
                        : undefined,
            };
        }

        console.warn(
            `Bundled runtime lock artifacts are invalid: ${validation.failureReason ?? 'validation failed.'}`
        );
    }

    return {
        hasLockfile: false,
        lockfilePath: bundledLockfilePath,
        projectPath: bundledProjectPath,
        source: 'none',
        matchesRequestedVersion: false,
    };
}

export async function syncLockedEnvironment(
    pythonPath: string,
    projectPath: string,
    extras: string[] = [],
    checkOnly: boolean = false
): Promise<void> {
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

interface StagedSyncOptions {
    pythonPath: string;
    projectPath: string;
    packageSpecifier: string;
    extras?: string[];
    verifyImport?: string;
}

export async function stagedSyncAndInstallWithRollback({
    pythonPath,
    projectPath,
    packageSpecifier,
    extras = [],
    verifyImport = 'GameSentenceMiner',
}: StagedSyncOptions): Promise<void> {
    const currentVenvDir = getVenvDirFromPythonPath(pythonPath);
    const stagedVenvDir = `${currentVenvDir}.staged`;
    const rollbackVenvDir = `${currentVenvDir}.rollback`;
    const stagedPythonPath = getPythonExecutablePathForVenv(stagedVenvDir);

    if (fs.existsSync(stagedVenvDir)) {
        fs.rmSync(stagedVenvDir, { recursive: true, force: true });
    }
    if (fs.existsSync(rollbackVenvDir)) {
        fs.rmSync(rollbackVenvDir, { recursive: true, force: true });
    }

    try {
        await runCommand(
            pythonPath,
            ['-m', 'uv', 'venv', '--clear', '--seed', '--python', pythonPath, stagedVenvDir],
            true,
            true,
            'Stage: ',
            {
                suppressOutput: true,
            }
        );
        await checkAndInstallUV(stagedPythonPath);
        await syncLockedEnvironment(stagedPythonPath, projectPath, extras, false);
        await installPackageNoDeps(stagedPythonPath, packageSpecifier, true);

        await runCommand(
            stagedPythonPath,
            ['-c', `import ${verifyImport}`],
            false,
            true,
            'Stage Verify: ',
            {
                suppressOutput: true,
            }
        );

        if (fs.existsSync(currentVenvDir)) {
            fs.renameSync(currentVenvDir, rollbackVenvDir);
        }

        let swapped = false;
        try {
            fs.renameSync(stagedVenvDir, currentVenvDir);
            swapped = true;
        } catch (swapError) {
            if (!fs.existsSync(currentVenvDir) && fs.existsSync(rollbackVenvDir)) {
                fs.renameSync(rollbackVenvDir, currentVenvDir);
            }
            throw swapError;
        }

        if (swapped && fs.existsSync(rollbackVenvDir)) {
            fs.rmSync(rollbackVenvDir, { recursive: true, force: true });
        }
    } catch (error) {
        if (fs.existsSync(stagedVenvDir)) {
            fs.rmSync(stagedVenvDir, { recursive: true, force: true });
        }
        throw error;
    }
}
