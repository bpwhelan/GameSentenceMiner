import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopUpdateChangelogPendingRecord } from '../../shared/changelog.js';
import {
    DesktopChangelogManager,
    getDesktopUpdateChangelogTarget,
    type DesktopChangelogStoreAdapter,
} from './desktop_changelog.js';

const tempDirs: string[] = [];

function makeTempAssetsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-changelog-test-'));
    tempDirs.push(dir);
    const changelogRoot = path.join(dir, 'changelog');
    fs.mkdirSync(path.join(changelogRoot, 'releases'), { recursive: true });
    fs.mkdirSync(path.join(changelogRoot, 'images', '1.0.2'), { recursive: true });
    fs.writeFileSync(path.join(changelogRoot, 'images', '1.0.2', 'shot.png'), 'png');
    return dir;
}

function writeManifest(
    assetsDir: string,
    releases: Array<{ version: string; title?: string; file?: string; markdown: string }>
): void {
    const changelogRoot = path.join(assetsDir, 'changelog');
    fs.writeFileSync(
        path.join(changelogRoot, 'manifest.json'),
        JSON.stringify({
            releases: releases.map(({ markdown: _markdown, ...entry }) => entry),
        })
    );
    for (const release of releases) {
        const relativeFile = release.file || `releases/${release.version}.md`;
        fs.writeFileSync(path.join(changelogRoot, relativeFile), release.markdown);
    }
}

function makeStore(): DesktopChangelogStoreAdapter & {
    pending: DesktopUpdateChangelogPendingRecord | null;
    seen: Set<string>;
} {
    return {
        pending: null,
        seen: new Set<string>(),
        getPending() {
            return this.pending;
        },
        setPending(record) {
            this.pending = record;
        },
        clearPending(toVersion) {
            if (!toVersion || this.pending?.toVersion === toVersion) {
                this.pending = null;
            }
        },
        hasSeen(version) {
            return this.seen.has(version);
        },
        markSeen(version) {
            this.seen.add(version);
            this.clearPending(version);
        },
    };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('getDesktopUpdateChangelogTarget', () => {
    it('does not trigger for first install', () => {
        expect(
            getDesktopUpdateChangelogTarget({
                storedVersion: '',
                currentVersion: '1.0.0',
                existingPending: null,
                isSeen: () => false,
            })
        ).toBeNull();
    });

    it('does not trigger from the backend update flag alone', () => {
        expect(
            getDesktopUpdateChangelogTarget({
                storedVersion: '1.0.0',
                currentVersion: '1.0.0',
                updateFlagExists: true,
                existingPending: null,
                isSeen: () => false,
            })
        ).toBeNull();
    });

    it('returns a target for a desktop version change', () => {
        expect(
            getDesktopUpdateChangelogTarget({
                storedVersion: '1.0.0',
                currentVersion: '1.0.1',
                existingPending: null,
                isSeen: () => false,
            })
        ).toEqual({ fromVersion: '1.0.0', toVersion: '1.0.1' });
    });

    it('suppresses already-seen target versions', () => {
        expect(
            getDesktopUpdateChangelogTarget({
                storedVersion: '1.0.0',
                currentVersion: '1.0.1',
                existingPending: null,
                isSeen: (version) => version === '1.0.1',
            })
        ).toBeNull();
    });

    it('keeps an un-seen pending target for the current version', () => {
        expect(
            getDesktopUpdateChangelogTarget({
                storedVersion: '1.0.1',
                currentVersion: '1.0.1',
                existingPending: { fromVersion: '1.0.0', toVersion: '1.0.1' },
                isSeen: () => false,
            })
        ).toEqual({ fromVersion: '1.0.0', toVersion: '1.0.1' });
    });
});

describe('DesktopChangelogManager', () => {
    it('aggregates bundled changelog entries for skipped versions', async () => {
        const assetsDir = makeTempAssetsDir();
        writeManifest(assetsDir, [
            { version: '1.0.1', title: 'One', markdown: '# One\n\nFirst change.' },
            {
                version: '1.0.2',
                title: 'Two',
                markdown: '# Two\n\nSecond change.\n\n![Shot](1.0.2/shot.png)',
            },
        ]);
        const snapshots: unknown[] = [];
        const manager = new DesktopChangelogManager(makeStore(), {
            assetsDir,
            fetchImpl: vi.fn(async () => {
                throw new Error('offline');
            }) as unknown as typeof fetch,
        });
        manager.setSnapshotListener((snapshot) => snapshots.push(snapshot));

        manager.startDesktopUpdate({ fromVersion: '1.0.0', toVersion: '1.0.2' });
        await vi.waitFor(() => {
            expect(manager.getPendingSnapshot()?.status).toBe('ready');
        });

        const ready = manager.getPendingSnapshot();
        expect(ready?.status).toBe('ready');
        expect(ready?.source).toBe('bundled');
        expect(ready?.title).toBe("What's Changed from 1.0.0 to 1.0.2");
        expect(ready?.markdown).toContain('First change.');
        expect(ready?.markdown).toContain('Second change.');
        expect(ready?.markdown).toContain('![Shot](1.0.2/shot.png)');
        expect(snapshots.length).toBeGreaterThan(1);
    });

    it('uses a remote changelog when the release asset is available', async () => {
        const assetsDir = makeTempAssetsDir();
        writeManifest(assetsDir, [
            { version: '1.0.1', title: 'Bundled', markdown: '# Bundled\n\nBundled change.' },
        ]);
        const manager = new DesktopChangelogManager(makeStore(), {
            assetsDir,
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                title: 'Remote notes',
                markdown: '# Remote\n\nRemote change.',
                assetBaseUrl: 'https://github.com/bpwhelan/GameSentenceMiner/releases/download/v1.0.1/',
            }))) as unknown as typeof fetch,
        });

        manager.startDesktopUpdate({ fromVersion: '1.0.0', toVersion: '1.0.1' });
        await vi.waitFor(() => {
            expect(manager.getPendingSnapshot()?.source).toBe('remote');
        });

        const snapshot = manager.getPendingSnapshot();
        expect(snapshot?.source).toBe('remote');
        expect(snapshot?.title).toBe('Remote notes');
        expect(snapshot?.markdown).toContain('Remote change.');
    });

    it('keeps bundled notes when remote fetch fails', async () => {
        const assetsDir = makeTempAssetsDir();
        writeManifest(assetsDir, [
            { version: '1.0.1', title: 'Bundled', markdown: '# Bundled\n\nBundled change.' },
        ]);
        const manager = new DesktopChangelogManager(makeStore(), {
            assetsDir,
            fetchImpl: vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch,
        });

        manager.startDesktopUpdate({ fromVersion: '1.0.0', toVersion: '1.0.1' });
        await vi.waitFor(() => {
            expect(manager.getPendingSnapshot()?.source).toBe('bundled');
        });

        const snapshot = manager.getPendingSnapshot();
        expect(snapshot?.source).toBe('bundled');
        expect(snapshot?.markdown).toContain('Bundled change.');
    });

    it('marks a changelog as seen and clears pending state', async () => {
        const assetsDir = makeTempAssetsDir();
        writeManifest(assetsDir, [
            { version: '1.0.1', title: 'Bundled', markdown: '# Bundled\n\nBundled change.' },
        ]);
        const store = makeStore();
        const manager = new DesktopChangelogManager(store, { assetsDir });

        manager.startDesktopUpdate({ fromVersion: '1.0.0', toVersion: '1.0.1' });
        expect(manager.markSeen('1.0.1')).toBe(true);

        expect(store.pending).toBeNull();
        expect(store.seen.has('1.0.1')).toBe(true);
        expect(manager.getPendingSnapshot()).toBeNull();
    });
});
