import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, '..');
const defaultTargetDir = path.join(repoRoot, 'GSM_Overlay', 'hachidori');
const hachidoriRepository = 'https://github.com/bee-san/hachidori';
// Hachidori's own folder guide, which the overlay has no use for.
const excludedPaths = new Set(['README.md']);
const overlayModeOff = 'export const OVERLAY_MODE = false;';
const overlayModeOn = 'export const OVERLAY_MODE = true;';
const stableManifestKey =
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3EBnBqP0Ma73KIk9Nx2ye+WFabltPVObI7QWPgYhdupw89RJ7J7xRUddIGszPDhpQNYnm37eLQupFXjqlSt0B1ltnltpzGynkRflAmRbtlqPWf19TWy6EowMm1SegxRR/YPxP5M93oQ/ojzfUPDQ4bhTE23vic/xY7sZttqcewAJou/TyCJTEjcoZgqDTD4PDnXyu1rB+bMJpu+uF/geKkkAOU4IRXHOEuE1JhJorvzmlZT07H01eqXGpmjR7ySbXryhN2gWb1arY+lCWd/qXWWUcIuyjak8D/6WgIaJwsBwoL/B/60gMoXDnDCRWi5kMWH68scx2QzF6g+FDykntwIDAQAB';
const commitPattern = /^[0-9a-f]{40}$/;

async function git(sourceRoot, ...args) {
    const { stdout } = await execFile('git', ['-C', sourceRoot, ...args]);
    return stdout.trim();
}

async function gitSucceeds(sourceRoot, ...args) {
    try {
        await execFile('git', ['-C', sourceRoot, ...args]);
        return true;
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'number'
        ) {
            return false;
        }
        throw error;
    }
}

async function isAncestor(sourceRoot, ancestor, descendant) {
    try {
        await execFile('git', [
            '-C',
            sourceRoot,
            'merge-base',
            '--is-ancestor',
            ancestor,
            descendant,
        ]);
        return true;
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
            return false;
        }
        throw error;
    }
}

async function readJsonIfPresent(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return null;
        }
        throw error;
    }
}

export function classifyReleaseRelationship({
    currentCommit,
    releaseCommit,
    releaseIsAncestorOfCurrent,
    currentIsAncestorOfRelease,
}) {
    if (!commitPattern.test(currentCommit) || !commitPattern.test(releaseCommit)) {
        throw new Error('Release comparisons require exact 40-character lowercase Git commits.');
    }
    if (currentCommit === releaseCommit) {
        return 'same';
    }
    if (releaseIsAncestorOfCurrent) {
        return 'release-behind';
    }
    if (currentIsAncestorOfRelease) {
        return 'release-ahead';
    }
    return 'diverged';
}

export function validateReleaseMetadata(release) {
    if (release === null) {
        return null;
    }
    if (!release || typeof release !== 'object') {
        throw new Error('Release metadata must be an object.');
    }
    if (
        typeof release.tag !== 'string' ||
        release.tag.trim() !== release.tag ||
        release.tag.length === 0
    ) {
        throw new Error('Release metadata requires a non-empty tag.');
    }
    if (!Number.isSafeInteger(release.id) || release.id <= 0) {
        throw new Error('Release metadata requires a positive integer release ID.');
    }
    if (
        typeof release.publishedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(release.publishedAt) ||
        Number.isNaN(Date.parse(release.publishedAt))
    ) {
        throw new Error('Release metadata requires a valid publication timestamp.');
    }
    let releaseUrl;
    try {
        releaseUrl = new URL(release.url);
    } catch {
        throw new Error('Release metadata requires a valid release URL.');
    }
    if (
        releaseUrl.origin !== 'https://github.com' ||
        !releaseUrl.pathname.startsWith('/bee-san/hachidori/releases/tag/')
    ) {
        throw new Error('Release metadata URL must identify a bee-san/hachidori GitHub release.');
    }
    let urlTag;
    try {
        urlTag = decodeURIComponent(
            releaseUrl.pathname.slice('/bee-san/hachidori/releases/tag/'.length),
        );
    } catch {
        throw new Error('Release metadata URL must contain a valid encoded release tag.');
    }
    if (urlTag !== release.tag || releaseUrl.search || releaseUrl.hash) {
        throw new Error('Release metadata URL must match the Hachidori release tag exactly.');
    }
    return {
        tag: release.tag,
        id: release.id,
        publishedAt: release.publishedAt,
        url: releaseUrl.toString(),
    };
}

export function parseArguments(args) {
    let sourceRoot = null;
    const releaseValues = new Map();
    const releaseFlags = new Map([
        ['--release-tag', 'tag'],
        ['--release-id', 'id'],
        ['--release-published-at', 'publishedAt'],
        ['--release-url', 'url'],
    ]);

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (releaseFlags.has(argument)) {
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error(`${argument} requires a value.`);
            }
            releaseValues.set(releaseFlags.get(argument), value);
            index += 1;
            continue;
        }
        if (argument.startsWith('--')) {
            throw new Error(`Unknown option: ${argument}`);
        }
        if (sourceRoot !== null) {
            throw new Error(`Unexpected positional argument: ${argument}`);
        }
        sourceRoot = path.resolve(argument);
    }

    if (sourceRoot === null) {
        throw new Error(
            'Usage: node scripts/sync-hachidori.mjs /path/to/hachidori ' +
                '[--release-tag TAG --release-id ID --release-published-at TIMESTAMP --release-url URL]',
        );
    }
    if (releaseValues.size !== 0 && releaseValues.size !== releaseFlags.size) {
        throw new Error(
            'Release syncs require --release-tag, --release-id, --release-published-at, and --release-url together.',
        );
    }

    const release =
        releaseValues.size === 0
            ? null
            : validateReleaseMetadata({
                  tag: releaseValues.get('tag'),
                  id: Number(releaseValues.get('id')),
                  publishedAt: releaseValues.get('publishedAt'),
                  url: releaseValues.get('url'),
              });
    return { sourceRoot, release };
}

export async function syncHachidori({ sourceRoot, targetDir = defaultTargetDir, release = null }) {
    const normalizedRelease = validateReleaseMetadata(release);

    const sourceExtensionDir = path.join(sourceRoot, 'extension');
    const sourceManifestPath = path.join(sourceExtensionDir, 'manifest.json');
    const sourceLicensePath = path.join(sourceRoot, 'LICENSE');
    await Promise.all([fs.access(sourceManifestPath), fs.access(sourceLicensePath)]);

    const dirty = await git(sourceRoot, 'status', '--porcelain');
    if (dirty) {
        throw new Error(
            'The Hachidori checkout must be clean so SOURCE.json identifies the exact vendored source.',
        );
    }
    const commit = await git(sourceRoot, 'rev-parse', 'HEAD');
    if (!commitPattern.test(commit)) {
        throw new Error(`The Hachidori checkout did not resolve to an exact commit: ${commit}`);
    }

    if (normalizedRelease !== null) {
        if (
            !(await gitSucceeds(
                sourceRoot,
                'check-ref-format',
                `refs/tags/${normalizedRelease.tag}`,
            ))
        ) {
            throw new Error(`Invalid Hachidori release tag: ${normalizedRelease.tag}`);
        }
        const taggedCommit = await git(
            sourceRoot,
            'rev-parse',
            '--verify',
            `refs/tags/${normalizedRelease.tag}^{commit}`,
        );
        if (taggedCommit !== commit) {
            throw new Error(
                `Hachidori release tag ${normalizedRelease.tag} points to ${taggedCommit}, ` +
                    `but the checkout is ${commit}.`,
            );
        }

        const currentSource = await readJsonIfPresent(path.join(targetDir, 'SOURCE.json'));
        if (currentSource !== null) {
            if (
                currentSource.repository !== hachidoriRepository ||
                !commitPattern.test(currentSource.commit || '')
            ) {
                throw new Error(
                    'The existing Hachidori SOURCE.json does not identify a valid upstream commit.',
                );
            }
            if (
                !(await gitSucceeds(
                    sourceRoot,
                    'cat-file',
                    '-e',
                    `${currentSource.commit}^{commit}`,
                ))
            ) {
                throw new Error(
                    `The Hachidori checkout does not contain currently vendored commit ${currentSource.commit}; ` +
                        'fetch full upstream history before syncing a release.',
                );
            }
            const releaseIsAncestorOfCurrent =
                commit === currentSource.commit
                    ? true
                    : await isAncestor(sourceRoot, commit, currentSource.commit);
            const currentIsAncestorOfRelease =
                commit === currentSource.commit
                    ? true
                    : await isAncestor(sourceRoot, currentSource.commit, commit);
            const relationship = classifyReleaseRelationship({
                currentCommit: currentSource.commit,
                releaseCommit: commit,
                releaseIsAncestorOfCurrent,
                currentIsAncestorOfRelease,
            });
            if (relationship === 'release-behind') {
                return {
                    status: 'skipped',
                    commit,
                    currentCommit: currentSource.commit,
                    reason: 'release-behind',
                };
            }
            if (relationship === 'diverged') {
                throw new Error(
                    `Hachidori release ${normalizedRelease.tag} (${commit}) diverges from ` +
                        `currently vendored commit ${currentSource.commit}; review the histories manually.`,
                );
            }
        }
    }

    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(sourceExtensionDir, targetDir, {
        recursive: true,
        filter: (source) => !excludedPaths.has(path.relative(sourceExtensionDir, source)),
    });

    const manifestPath = path.join(targetDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.key = stableManifestKey;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // The overlay hosts Hachidori in its own window, so it runs in Hachidori's overlay mode.
    const overlayModePath = path.join(targetDir, 'overlay-mode.js');
    const overlayMode = await fs.readFile(overlayModePath, 'utf8');
    if (!overlayMode.includes(overlayModeOff)) {
        throw new Error(
            `overlay-mode.js no longer contains "${overlayModeOff}"; update this script for the new switch.`,
        );
    }
    await fs.writeFile(overlayModePath, overlayMode.replace(overlayModeOff, overlayModeOn));

    await fs.copyFile(sourceLicensePath, path.join(targetDir, 'LICENSE.hachidori'));
    const sourceMetadata = {
        name: 'Hachidori',
        repository: hachidoriRepository,
        commit,
    };
    if (normalizedRelease !== null) {
        sourceMetadata.release = normalizedRelease;
    }
    Object.assign(sourceMetadata, {
        sourceDirectory: 'extension',
        license: 'GPL-3.0-or-later',
        modifications: [
            'manifest.json includes a fixed public key so the GSM-hosted extension keeps one stable ID.',
            'overlay-mode.js enables overlay mode: hover lookups, no word highlight, and no first-run setup page.',
            'README.md is left out.',
        ],
    });
    await fs.writeFile(
        path.join(targetDir, 'SOURCE.json'),
        `${JSON.stringify(sourceMetadata, null, 2)}\n`,
    );

    return { status: 'synced', commit };
}

async function main() {
    const { sourceRoot, release } = parseArguments(process.argv.slice(2));
    const result = await syncHachidori({ sourceRoot, release });
    if (result.status === 'skipped') {
        console.log(
            `[sync-hachidori] Skipped release ${result.commit}; ` +
                `currently vendored ${result.currentCommit} is newer.`,
        );
        return;
    }
    console.log(`[sync-hachidori] Synced ${result.commit} to ${defaultTargetDir}`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[sync-hachidori] ${error instanceof Error ? error.message : error}`);
        process.exit(1);
    });
}
