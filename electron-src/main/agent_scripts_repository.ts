import axios from 'axios';
import extract from 'extract-zip';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASE_DIR } from './util.js';
import { isListableAgentScriptPath } from '../shared/agent_scripts.js';

const AGENT_SCRIPTS_OWNER = '0xDC00';
const AGENT_SCRIPTS_REPO = 'scripts';
const AGENT_SCRIPTS_REPOSITORY = `${AGENT_SCRIPTS_OWNER}/${AGENT_SCRIPTS_REPO}`;
const GITHUB_API_BASE = `https://api.github.com/repos/${AGENT_SCRIPTS_REPOSITORY}`;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MANAGED_AGENT_SCRIPTS_ROOT = path.join(BASE_DIR, 'agent-scripts');
const MANAGED_AGENT_SCRIPTS_PATH = path.join(MANAGED_AGENT_SCRIPTS_ROOT, 'scripts');
const MANAGED_AGENT_SCRIPTS_METADATA_FILE = path.join(
    MANAGED_AGENT_SCRIPTS_ROOT,
    'metadata.json',
);

interface GitHubRepositoryResponse {
    default_branch?: string;
}

interface GitHubCommitResponse {
    sha?: string;
}

interface ManagedAgentScriptsMetadata {
    repository: string;
    branch: string;
    commit: string;
    checkedAt: number;
    installedAt: number;
    scriptCount: number;
    // Only files still owned by the updater; local overrides are never enrolled.
    fileHashes?: Record<string, string>;
}

interface RemoteAgentScriptsSnapshot {
    branch: string;
    commit: string;
    archiveUrl: string;
}

export interface ManagedAgentScriptsStatus {
    path: string;
    repository: string;
    branch?: string;
    commit?: string;
    installed: boolean;
    updated: boolean;
    scriptCount: number;
    checkedAt?: number;
    warning?: string;
}

let ensurePromise: Promise<ManagedAgentScriptsStatus> | null = null;

function githubHeaders(): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'GameSentenceMiner',
    };
}

function normalizePathForCompare(value: string): string {
    try {
        return path.resolve(value).toLowerCase();
    } catch {
        return value.trim().toLowerCase();
    }
}

function readMetadata(): ManagedAgentScriptsMetadata | null {
    try {
        if (!fs.existsSync(MANAGED_AGENT_SCRIPTS_METADATA_FILE)) {
            return null;
        }
        const parsed = JSON.parse(
            fs.readFileSync(MANAGED_AGENT_SCRIPTS_METADATA_FILE, 'utf8'),
        ) as Partial<ManagedAgentScriptsMetadata>;
        if (
            parsed.repository !== AGENT_SCRIPTS_REPOSITORY ||
            typeof parsed.branch !== 'string' ||
            typeof parsed.commit !== 'string' ||
            typeof parsed.checkedAt !== 'number' ||
            typeof parsed.installedAt !== 'number' ||
            typeof parsed.scriptCount !== 'number'
        ) {
            return null;
        }
        if (parsed.fileHashes !== undefined) {
            if (
                !parsed.fileHashes ||
                typeof parsed.fileHashes !== 'object' ||
                Array.isArray(parsed.fileHashes) ||
                !Object.values(parsed.fileHashes).every(
                    (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
                )
            ) {
                // A damaged manifest must not re-enroll previously protected files.
                parsed.fileHashes = {};
            } else {
                parsed.fileHashes = Object.fromEntries(
                    Object.entries(parsed.fileHashes).map(([filePath, hash]) => [fileHashKey(filePath), hash]),
                );
            }
        }
        return parsed as ManagedAgentScriptsMetadata;
    } catch {
        return null;
    }
}

function writeMetadata(metadata: ManagedAgentScriptsMetadata): void {
    fs.mkdirSync(MANAGED_AGENT_SCRIPTS_ROOT, { recursive: true });
    const temporaryPath = `${MANAGED_AGENT_SCRIPTS_METADATA_FILE}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(temporaryPath, MANAGED_AGENT_SCRIPTS_METADATA_FILE);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
}

function fileHashKey(relativePath: string): string {
    const portablePath = relativePath.split(path.sep).join('/');
    return process.platform === 'win32' ? portablePath.toLowerCase() : portablePath;
}

function hashFile(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectFileHashes(rootDirectory: string): Record<string, string> {
    const hashes: Record<string, string> = Object.create(null);
    const visit = (relativeDirectory: string) => {
        for (const entry of fs.readdirSync(path.join(rootDirectory, relativeDirectory), { withFileTypes: true })) {
            const relativePath = path.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) {
                visit(relativePath);
            } else if (entry.isFile()) {
                hashes[fileHashKey(relativePath)] = hashFile(path.join(rootDirectory, relativePath));
            }
        }
    };
    visit('');
    return hashes;
}

function preserveLocalFiles(
    extractedRepositoryRoot: string,
    previousHashes: Record<string, string>,
    nextHashes: Record<string, string>,
): void {
    const localRoot = fs.lstatSync(MANAGED_AGENT_SCRIPTS_PATH, { throwIfNoEntry: false });
    if (!localRoot) {
        return;
    }
    if (!localRoot.isDirectory()) {
        throw new Error('The managed Agent scripts path must be a directory, not a symbolic link.');
    }

    // Remove conflicting entries only from the downloaded staging directory.
    // Neither custom files nor modified upstream files belong to future updates.
    const discardIncomingPath = (relativePath: string) => {
        fs.rmSync(path.join(extractedRepositoryRoot, relativePath), { recursive: true, force: true });
        const key = fileHashKey(relativePath);
        for (const incomingKey of Object.keys(nextHashes)) {
            if (incomingKey === key || incomingKey.startsWith(`${key}/`)) {
                delete nextHashes[incomingKey];
            }
        }
    };
    const visit = (relativeDirectory: string) => {
        const directory = path.join(MANAGED_AGENT_SCRIPTS_PATH, relativeDirectory);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relativePath = path.join(relativeDirectory, entry.name);
            const source = path.join(MANAGED_AGENT_SCRIPTS_PATH, relativePath);
            const destination = path.join(extractedRepositoryRoot, relativePath);
            if (entry.isDirectory()) {
                const incoming = fs.lstatSync(destination, { throwIfNoEntry: false });
                if (incoming && !incoming.isDirectory()) {
                    discardIncomingPath(relativePath);
                }
                fs.mkdirSync(destination, { recursive: true });
                visit(relativePath);
            } else {
                const key = fileHashKey(relativePath);
                if (
                    entry.isFile() &&
                    Object.hasOwn(previousHashes, key) &&
                    previousHashes[key] === hashFile(source)
                ) {
                    continue;
                }
                discardIncomingPath(relativePath);
                if (
                    entry.isSymbolicLink() &&
                    process.platform === 'win32' &&
                    fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()
                ) {
                    // Junctions do not require Windows symbolic-link privileges.
                    const target = path.resolve(path.dirname(source), fs.readlinkSync(source));
                    fs.symlinkSync(target, destination, 'junction');
                } else {
                    fs.cpSync(source, destination, {
                        recursive: true,
                        verbatimSymlinks: true,
                        preserveTimestamps: true,
                    });
                }
            }
        }
    };
    visit('');
}

function countListableAgentScripts(rootDirectory: string): number {
    if (!rootDirectory || !fs.existsSync(rootDirectory)) {
        return 0;
    }

    let count = 0;
    const pendingDirectories: string[] = [rootDirectory];
    while (pendingDirectories.length > 0) {
        const directory = pendingDirectories.pop();
        if (!directory) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                pendingDirectories.push(absolutePath);
            } else if (entry.isFile() && isListableAgentScriptPath(absolutePath)) {
                count += 1;
            }
        }
    }

    return count;
}

function shouldCheckForUpdates(metadata: ManagedAgentScriptsMetadata | null): boolean {
    if (!metadata) {
        return true;
    }
    return Date.now() - metadata.checkedAt >= UPDATE_INTERVAL_MS;
}

async function fetchRemoteSnapshot(): Promise<RemoteAgentScriptsSnapshot> {
    const repositoryResponse = await axios.get<GitHubRepositoryResponse>(
        GITHUB_API_BASE,
        {
            timeout: 30000,
            headers: githubHeaders(),
            validateStatus: (status) => status >= 200 && status < 300,
        },
    );
    const branch =
        typeof repositoryResponse.data.default_branch === 'string' &&
        repositoryResponse.data.default_branch.trim().length > 0
            ? repositoryResponse.data.default_branch.trim()
            : 'main';

    const commitResponse = await axios.get<GitHubCommitResponse>(
        `${GITHUB_API_BASE}/commits/${encodeURIComponent(branch)}`,
        {
            timeout: 30000,
            headers: githubHeaders(),
            validateStatus: (status) => status >= 200 && status < 300,
        },
    );
    const commit =
        typeof commitResponse.data.sha === 'string' &&
        commitResponse.data.sha.trim().length > 0
            ? commitResponse.data.sha.trim()
            : branch;

    return {
        branch,
        commit,
        archiveUrl: `${GITHUB_API_BASE}/zipball/${encodeURIComponent(commit)}`,
    };
}

async function downloadFile(downloadUrl: string, destinationPath: string): Promise<void> {
    const response = await axios.get<NodeJS.ReadableStream>(downloadUrl, {
        responseType: 'stream',
        timeout: 120000,
        maxRedirects: 5,
        headers: {
            Accept: '*/*',
            'User-Agent': 'GameSentenceMiner',
        },
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const writer = fs.createWriteStream(destinationPath);
    await new Promise<void>((resolve, reject) => {
        const onReaderError = (error: unknown) => {
            writer.destroy();
            reject(error);
        };
        response.data.once('error', onReaderError);
        writer.once('error', reject);
        writer.once('finish', resolve);
        response.data.pipe(writer);
    });
}

function findExtractedRepositoryRoot(extractDirectory: string): string | null {
    const directLoaderPath = path.join(extractDirectory, 'libLoader.js');
    if (fs.existsSync(directLoaderPath)) {
        return extractDirectory;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(extractDirectory, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidate = path.join(extractDirectory, entry.name);
        if (fs.existsSync(path.join(candidate, 'libLoader.js'))) {
            return candidate;
        }
    }

    return null;
}

async function getPreviousFileHashes(
    metadata: ManagedAgentScriptsMetadata | null,
    snapshot: RemoteAgentScriptsSnapshot,
    incomingHashes: Record<string, string>,
    tempDirectory: string,
): Promise<Record<string, string>> {
    if (metadata?.fileHashes) {
        return metadata.fileHashes;
    }
    // Older installs have no manifest. Compare against their pinned upstream
    // commit, never against current local contents or a moving branch name.
    if (!metadata || !/^[a-f0-9]{40}$/i.test(metadata.commit)) {
        return {};
    }
    if (metadata.commit === snapshot.commit) {
        return { ...incomingHashes };
    }
    try {
        const previousDirectory = path.join(tempDirectory, 'previous');
        fs.mkdirSync(previousDirectory);
        const previousZip = path.join(tempDirectory, 'previous.zip');
        await downloadFile(`${GITHUB_API_BASE}/zipball/${encodeURIComponent(metadata.commit)}`, previousZip);
        await extract(previousZip, { dir: previousDirectory });
        const previousRoot = findExtractedRepositoryRoot(previousDirectory);
        if (!previousRoot) {
            throw new Error('Previous Agent scripts archive did not contain libLoader.js.');
        }
        return collectFileHashes(previousRoot);
    } catch (error) {
        console.warn('Could not verify previous Agent scripts; preserving all existing files:', error);
        return {};
    }
}

function replaceManagedScriptsDirectory(
    extractedRepositoryRoot: string,
    metadata: ManagedAgentScriptsMetadata,
): void {
    fs.mkdirSync(MANAGED_AGENT_SCRIPTS_ROOT, { recursive: true });
    const backupPath = path.join(
        MANAGED_AGENT_SCRIPTS_ROOT,
        `scripts-old-${randomUUID()}`,
    );
    let didMoveExisting = false;
    let didInstall = false;

    if (fs.existsSync(MANAGED_AGENT_SCRIPTS_PATH)) {
        fs.renameSync(MANAGED_AGENT_SCRIPTS_PATH, backupPath);
        didMoveExisting = true;
    }

    try {
        fs.renameSync(extractedRepositoryRoot, MANAGED_AGENT_SCRIPTS_PATH);
        didInstall = true;
        writeMetadata(metadata);
    } catch (error) {
        try {
            if (didInstall) {
                fs.renameSync(MANAGED_AGENT_SCRIPTS_PATH, extractedRepositoryRoot);
            }
            if (didMoveExisting) {
                fs.renameSync(backupPath, MANAGED_AGENT_SCRIPTS_PATH);
            }
        } catch (restoreError) {
            throw new Error(
                `Agent scripts update failed; the previous install is saved at ${backupPath}: ${restoreError}`,
                { cause: error },
            );
        }
        throw error;
    }

    if (didMoveExisting) {
        try {
            fs.rmSync(backupPath, { recursive: true, force: true });
        } catch {
            // A stale backup can be cleaned on a later update.
        }
    }
}

async function installRemoteSnapshot(
    snapshot: RemoteAgentScriptsSnapshot,
    metadata: ManagedAgentScriptsMetadata | null,
): Promise<ManagedAgentScriptsStatus> {
    fs.mkdirSync(MANAGED_AGENT_SCRIPTS_ROOT, { recursive: true });
    const tempDirectory = fs.mkdtempSync(
        path.join(MANAGED_AGENT_SCRIPTS_ROOT, 'download-'),
    );
    const zipPath = path.join(tempDirectory, 'scripts.zip');
    const extractDirectory = path.join(tempDirectory, 'incoming');

    try {
        await downloadFile(snapshot.archiveUrl, zipPath);
        fs.mkdirSync(extractDirectory);
        await extract(zipPath, { dir: extractDirectory });
        const extractedRepositoryRoot = findExtractedRepositoryRoot(extractDirectory);
        if (!extractedRepositoryRoot) {
            throw new Error('Downloaded Agent scripts archive did not contain libLoader.js.');
        }

        if (countListableAgentScripts(extractedRepositoryRoot) === 0) {
            throw new Error('Downloaded Agent scripts archive did not contain any scripts.');
        }

        const fileHashes = collectFileHashes(extractedRepositoryRoot);
        const previousHashes = await getPreviousFileHashes(metadata, snapshot, fileHashes, tempDirectory);
        preserveLocalFiles(extractedRepositoryRoot, previousHashes, fileHashes);
        const scriptCount = countListableAgentScripts(extractedRepositoryRoot);
        const now = Date.now();
        replaceManagedScriptsDirectory(extractedRepositoryRoot, {
            repository: AGENT_SCRIPTS_REPOSITORY,
            branch: snapshot.branch,
            commit: snapshot.commit,
            checkedAt: now,
            installedAt: now,
            scriptCount,
            fileHashes,
        });

        return {
            path: MANAGED_AGENT_SCRIPTS_PATH,
            repository: AGENT_SCRIPTS_REPOSITORY,
            branch: snapshot.branch,
            commit: snapshot.commit,
            installed: true,
            updated: true,
            scriptCount,
            checkedAt: now,
        };
    } finally {
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failures.
        }
    }
}

async function ensureManagedAgentScriptsCurrentInternal(
    force: boolean,
): Promise<ManagedAgentScriptsStatus> {
    const metadata = readMetadata();
    const localScriptCount = countListableAgentScripts(MANAGED_AGENT_SCRIPTS_PATH);
    const hasUsableLocalCopy = localScriptCount > 0;

    if (!force && hasUsableLocalCopy && !shouldCheckForUpdates(metadata)) {
        return {
            path: MANAGED_AGENT_SCRIPTS_PATH,
            repository: AGENT_SCRIPTS_REPOSITORY,
            branch: metadata?.branch,
            commit: metadata?.commit,
            installed: true,
            updated: false,
            scriptCount: localScriptCount,
            checkedAt: metadata?.checkedAt,
        };
    }

    let snapshot: RemoteAgentScriptsSnapshot;
    try {
        snapshot = await fetchRemoteSnapshot();
    } catch (error) {
        if (hasUsableLocalCopy) {
            return {
                path: MANAGED_AGENT_SCRIPTS_PATH,
                repository: AGENT_SCRIPTS_REPOSITORY,
                branch: metadata?.branch,
                commit: metadata?.commit,
                installed: true,
                updated: false,
                scriptCount: localScriptCount,
                checkedAt: metadata?.checkedAt,
                warning: `Could not check for Agent script updates: ${(error as Error).message}`,
            };
        }
        throw error;
    }

    if (!force && hasUsableLocalCopy && metadata?.commit === snapshot.commit) {
        const now = Date.now();
        writeMetadata({
            ...metadata,
            repository: AGENT_SCRIPTS_REPOSITORY,
            branch: snapshot.branch,
            commit: snapshot.commit,
            checkedAt: now,
            installedAt: metadata.installedAt,
            scriptCount: localScriptCount,
        });
        return {
            path: MANAGED_AGENT_SCRIPTS_PATH,
            repository: AGENT_SCRIPTS_REPOSITORY,
            branch: snapshot.branch,
            commit: snapshot.commit,
            installed: true,
            updated: false,
            scriptCount: localScriptCount,
            checkedAt: now,
        };
    }

    return installRemoteSnapshot(snapshot, metadata);
}

export function getManagedAgentScriptsPath(): string {
    return MANAGED_AGENT_SCRIPTS_PATH;
}

export function getEffectiveAgentScriptsPath(configuredPath: string | null | undefined): string {
    const trimmedPath = typeof configuredPath === 'string' ? configuredPath.trim() : '';
    return trimmedPath || MANAGED_AGENT_SCRIPTS_PATH;
}

export function isManagedAgentScriptsPath(candidatePath: string | null | undefined): boolean {
    const trimmedPath = typeof candidatePath === 'string' ? candidatePath.trim() : '';
    if (!trimmedPath) {
        return true;
    }

    const candidate = normalizePathForCompare(trimmedPath);
    const root = normalizePathForCompare(MANAGED_AGENT_SCRIPTS_ROOT);
    const scriptsPath = normalizePathForCompare(MANAGED_AGENT_SCRIPTS_PATH);
    return (
        candidate === root ||
        candidate === scriptsPath ||
        candidate.startsWith(`${root}${path.sep}`) ||
        candidate.startsWith(`${scriptsPath}${path.sep}`)
    );
}

export async function ensureManagedAgentScriptsCurrent(
    options: { force?: boolean } = {},
): Promise<ManagedAgentScriptsStatus> {
    if (ensurePromise) {
        return ensurePromise;
    }

    ensurePromise = ensureManagedAgentScriptsCurrentInternal(options.force === true)
        .finally(() => {
            ensurePromise = null;
        });
    return ensurePromise;
}

export const __test = {
    AGENT_SCRIPTS_REPOSITORY,
    MANAGED_AGENT_SCRIPTS_METADATA_FILE,
    MANAGED_AGENT_SCRIPTS_PATH,
    MANAGED_AGENT_SCRIPTS_ROOT,
    countListableAgentScripts,
    findExtractedRepositoryRoot,
    shouldCheckForUpdates,
};
