import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import log from 'electron-log/main.js';
import semver from 'semver';

import type {
    DesktopUpdateChangelogPendingRecord,
    DesktopUpdateChangelogSnapshot,
} from '../../shared/changelog.js';

interface ChangelogManifestEntry {
    version: string;
    title?: string;
    file?: string;
}

interface ChangelogManifest {
    releases?: ChangelogManifestEntry[];
}

interface RemoteChangelogPayload {
    title?: unknown;
    markdown?: unknown;
    assetBaseUrl?: unknown;
}

export interface DesktopChangelogStoreAdapter {
    getPending(): DesktopUpdateChangelogPendingRecord | null;
    setPending(record: DesktopUpdateChangelogPendingRecord): void;
    clearPending(toVersion?: string): void;
    hasSeen(version: string): boolean;
    markSeen(version: string): void;
}

export interface DesktopChangelogManagerOptions {
    assetsDir: string;
    repo?: string;
    fetchImpl?: typeof fetch;
    remoteTimeoutMs?: number;
}

export interface DesktopUpdateChangelogTriggerInput {
    storedVersion: string;
    currentVersion: string;
    updateFlagExists?: boolean;
    existingPending: DesktopUpdateChangelogPendingRecord | null;
    isSeen: (version: string) => boolean;
}

type SnapshotListener = (snapshot: DesktopUpdateChangelogSnapshot | null) => void;

const DEFAULT_REPO = 'bpwhelan/GameSentenceMiner';
const BUNDLED_ASSET_BASE_URL = 'gsm-changelog://images/';

function cloneSnapshot(
    snapshot: DesktopUpdateChangelogSnapshot | null
): DesktopUpdateChangelogSnapshot | null {
    return snapshot ? { ...snapshot } : null;
}

function versionKey(record: DesktopUpdateChangelogPendingRecord): string {
    return `${record.fromVersion}->${record.toVersion}`;
}

function fallbackMarkdown(toVersion: string): string {
    return [
        `# What's Changed in ${toVersion}`,
        '',
        'This update is installed. Detailed release notes are not available in this build.',
    ].join('\n');
}

function makeLoadingSnapshot(
    record: DesktopUpdateChangelogPendingRecord
): DesktopUpdateChangelogSnapshot {
    return {
        fromVersion: record.fromVersion,
        toVersion: record.toVersion,
        status: 'loading',
        source: null,
        title: `What's Changed in ${record.toVersion}`,
        markdown: '',
        assetBaseUrl: BUNDLED_ASSET_BASE_URL,
        error: null,
    };
}

function makeReadySnapshot(
    record: DesktopUpdateChangelogPendingRecord,
    payload: {
        title?: string;
        markdown: string;
        assetBaseUrl?: string;
        source: 'bundled' | 'remote';
        error?: string | null;
    }
): DesktopUpdateChangelogSnapshot {
    return {
        fromVersion: record.fromVersion,
        toVersion: record.toVersion,
        status: 'ready',
        source: payload.source,
        title: payload.title?.trim() || `What's Changed in ${record.toVersion}`,
        markdown: payload.markdown,
        assetBaseUrl: payload.assetBaseUrl || BUNDLED_ASSET_BASE_URL,
        error: payload.error ?? null,
    };
}

function isSafeRelativePath(value: string): boolean {
    if (!value || path.isAbsolute(value)) {
        return false;
    }
    const normalized = value.replaceAll('\\', '/');
    return !normalized.split('/').includes('..');
}

function stripLeadingHeading(markdown: string): string {
    return markdown.replace(/^\s*# .*(?:\r?\n)+/, '').trim();
}

function compareVersions(a: string, b: string): number {
    if (semver.valid(a) && semver.valid(b)) {
        return semver.compare(a, b);
    }
    return a.localeCompare(b);
}

function versionInRange(version: string, fromVersion: string, toVersion: string): boolean {
    if (semver.valid(version) && semver.valid(fromVersion) && semver.valid(toVersion)) {
        return semver.gt(version, fromVersion) && semver.lte(version, toVersion);
    }
    return version === toVersion;
}

function selectManifestEntries(
    manifest: ChangelogManifest,
    fromVersion: string,
    toVersion: string
): ChangelogManifestEntry[] {
    const releases = Array.isArray(manifest.releases) ? manifest.releases : [];
    const ranged = releases
        .filter((entry) => typeof entry.version === 'string')
        .filter((entry) => versionInRange(entry.version, fromVersion, toVersion))
        .sort((a, b) => compareVersions(a.version, b.version));

    if (ranged.length > 0) {
        return ranged;
    }

    return releases
        .filter((entry) => entry.version === toVersion)
        .sort((a, b) => compareVersions(a.version, b.version));
}

function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

async function fetchWithTimeout(
    fetchImpl: typeof fetch,
    url: string,
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

export function getDesktopUpdateChangelogTarget(
    input: DesktopUpdateChangelogTriggerInput
): DesktopUpdateChangelogPendingRecord | null {
    void input.updateFlagExists;

    if (
        input.existingPending &&
        input.existingPending.toVersion === input.currentVersion &&
        !input.isSeen(input.existingPending.toVersion)
    ) {
        return input.existingPending;
    }

    if (!input.storedVersion.trim()) {
        return null;
    }

    if (input.storedVersion === input.currentVersion) {
        return null;
    }

    if (input.isSeen(input.currentVersion)) {
        return null;
    }

    return {
        fromVersion: input.storedVersion,
        toVersion: input.currentVersion,
    };
}

export class DesktopChangelogManager {
    private snapshot: DesktopUpdateChangelogSnapshot | null = null;
    private listener: SnapshotListener | null = null;
    private resolvingKey: string | null = null;
    private readonly repo: string;
    private readonly fetchImpl: typeof fetch;
    private readonly remoteTimeoutMs: number;

    public constructor(
        private readonly store: DesktopChangelogStoreAdapter,
        private readonly options: DesktopChangelogManagerOptions
    ) {
        this.repo = options.repo ?? DEFAULT_REPO;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.remoteTimeoutMs = options.remoteTimeoutMs ?? 2500;
    }

    public setSnapshotListener(listener: SnapshotListener | null): void {
        this.listener = listener;
    }

    public getPendingRecord(): DesktopUpdateChangelogPendingRecord | null {
        const pending = this.store.getPending();
        if (pending && this.store.hasSeen(pending.toVersion)) {
            this.store.clearPending(pending.toVersion);
            return null;
        }
        return pending;
    }

    public startDesktopUpdate(
        record: DesktopUpdateChangelogPendingRecord
    ): DesktopUpdateChangelogSnapshot | null {
        if (this.store.hasSeen(record.toVersion)) {
            this.store.clearPending(record.toVersion);
            this.snapshot = null;
            this.emit();
            return null;
        }

        this.store.setPending(record);
        if (
            !this.snapshot ||
            this.snapshot.fromVersion !== record.fromVersion ||
            this.snapshot.toVersion !== record.toVersion
        ) {
            this.snapshot = makeLoadingSnapshot(record);
            this.emit();
        }
        this.resolve(record);
        return cloneSnapshot(this.snapshot);
    }

    public getPendingSnapshot(): DesktopUpdateChangelogSnapshot | null {
        const pending = this.getPendingRecord();
        if (!pending) {
            this.snapshot = null;
            return null;
        }

        if (
            !this.snapshot ||
            this.snapshot.fromVersion !== pending.fromVersion ||
            this.snapshot.toVersion !== pending.toVersion
        ) {
            this.snapshot = makeLoadingSnapshot(pending);
            this.resolve(pending);
        }

        return cloneSnapshot(this.snapshot);
    }

    public markSeen(toVersion?: string): boolean {
        const pending = this.store.getPending();
        const version = toVersion || pending?.toVersion || this.snapshot?.toVersion || '';
        if (!version) {
            return false;
        }

        this.store.markSeen(version);
        if (!this.snapshot || this.snapshot.toVersion === version) {
            this.snapshot = null;
            this.emit();
        }
        return true;
    }

    private resolve(record: DesktopUpdateChangelogPendingRecord): void {
        const key = versionKey(record);
        if (this.resolvingKey === key) {
            return;
        }
        this.resolvingKey = key;

        void this.resolveBundled(record)
            .then((bundled) => {
                if (!this.isCurrent(record)) {
                    return;
                }
                this.snapshot = bundled;
                this.emit();
                void this.resolveRemote(record);
            })
            .catch((error) => {
                if (!this.isCurrent(record)) {
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                this.snapshot = makeReadySnapshot(record, {
                    source: 'bundled',
                    markdown: fallbackMarkdown(record.toVersion),
                    error: message,
                });
                this.emit();
                log.warn(`Falling back to generic bundled changelog: ${message}`);
            })
            .finally(() => {
                if (this.resolvingKey === key) {
                    this.resolvingKey = null;
                }
            });
    }

    private isCurrent(record: DesktopUpdateChangelogPendingRecord): boolean {
        const pending = this.store.getPending();
        return (
            pending?.fromVersion === record.fromVersion &&
            pending?.toVersion === record.toVersion &&
            !this.store.hasSeen(record.toVersion)
        );
    }

    private async resolveBundled(
        record: DesktopUpdateChangelogPendingRecord
    ): Promise<DesktopUpdateChangelogSnapshot> {
        const changelogRoot = path.join(this.options.assetsDir, 'changelog');
        const manifestPath = path.join(changelogRoot, 'manifest.json');
        const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as ChangelogManifest;
        const entries = selectManifestEntries(parsed, record.fromVersion, record.toVersion);

        if (entries.length === 0) {
            return makeReadySnapshot(record, {
                source: 'bundled',
                markdown: fallbackMarkdown(record.toVersion),
                error: `No bundled changelog entry found for ${record.toVersion}.`,
            });
        }

        const sections: string[] = [];
        for (const entry of entries) {
            const relativeFile = entry.file || `releases/${entry.version}.md`;
            if (!isSafeRelativePath(relativeFile)) {
                throw new Error(`Unsafe bundled changelog path: ${relativeFile}`);
            }
            const markdownPath = path.resolve(changelogRoot, relativeFile);
            const rootWithSeparator = `${path.resolve(changelogRoot)}${path.sep}`;
            if (!markdownPath.startsWith(rootWithSeparator)) {
                throw new Error(`Bundled changelog path escaped root: ${relativeFile}`);
            }
            const rawMarkdown = await fs.readFile(markdownPath, 'utf8');
            if (entries.length === 1) {
                sections.push(rawMarkdown.trim());
            } else {
                sections.push(
                    [
                        `## ${entry.title || entry.version}`,
                        '',
                        stripLeadingHeading(rawMarkdown),
                    ].join('\n')
                );
            }
        }

        const title =
            entries.length === 1
                ? entries[0]?.title || `What's Changed in ${record.toVersion}`
                : `What's Changed from ${record.fromVersion} to ${record.toVersion}`;

        return makeReadySnapshot(record, {
            source: 'bundled',
            title,
            markdown: sections.join('\n\n').trim(),
            assetBaseUrl: BUNDLED_ASSET_BASE_URL,
        });
    }

    private async resolveRemote(record: DesktopUpdateChangelogPendingRecord): Promise<void> {
        const url = `https://github.com/${this.repo}/releases/download/v${encodeURIComponent(
            record.toVersion
        )}/changelog-v${encodeURIComponent(record.toVersion)}.json`;

        try {
            const response = await fetchWithTimeout(this.fetchImpl, url, this.remoteTimeoutMs);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload = (await response.json()) as RemoteChangelogPayload;
            if (typeof payload.markdown !== 'string' || payload.markdown.trim().length === 0) {
                throw new Error('Remote changelog payload did not include markdown.');
            }
            const assetBaseUrl =
                typeof payload.assetBaseUrl === 'string' && isHttpsUrl(payload.assetBaseUrl)
                    ? payload.assetBaseUrl
                    : '';
            const title =
                typeof payload.title === 'string' && payload.title.trim().length > 0
                    ? payload.title
                    : undefined;

            if (!this.isCurrent(record)) {
                return;
            }

            this.snapshot = makeReadySnapshot(record, {
                source: 'remote',
                title,
                markdown: payload.markdown.trim(),
                assetBaseUrl,
            });
            this.emit();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.info(`Using bundled changelog for ${record.toVersion}; remote fetch failed: ${message}`);
        }
    }

    private emit(): void {
        if (this.listener) {
            this.listener(cloneSnapshot(this.snapshot));
        }
    }
}
