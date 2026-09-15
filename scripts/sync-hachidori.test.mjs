import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseArguments, syncHachidori, validateReleaseMetadata } from './sync-hachidori.mjs';

const execFile = promisify(execFileCallback);

async function git(repo, ...args) {
    const { stdout } = await execFile('git', ['-C', repo, ...args]);
    return stdout.trim();
}

async function writeFixtureExtension(sourceRoot, marker) {
    const extensionDir = path.join(sourceRoot, 'extension');
    await fs.mkdir(extensionDir, { recursive: true });
    await Promise.all([
        fs.writeFile(path.join(sourceRoot, 'LICENSE'), 'fixture license\n'),
        fs.writeFile(path.join(extensionDir, 'README.md'), 'excluded fixture guide\n'),
        fs.writeFile(
            path.join(extensionDir, 'manifest.json'),
            `${JSON.stringify(
                {
                    manifest_version: 3,
                    name: 'Hachidori fixture',
                    version: marker,
                },
                null,
                2,
            )}\n`,
        ),
        fs.writeFile(
            path.join(extensionDir, 'overlay-mode.js'),
            'export const OVERLAY_MODE = false;\n',
        ),
        fs.writeFile(
            path.join(extensionDir, 'marker.js'),
            `export const marker = ${JSON.stringify(marker)};\n`,
        ),
    ]);
}

async function commitAll(sourceRoot, message) {
    await git(sourceRoot, 'add', '.');
    await git(sourceRoot, 'commit', '-m', message);
    return git(sourceRoot, 'rev-parse', 'HEAD');
}

async function createFixture(t) {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-hachidori-sync-'));
    t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
    const sourceRoot = path.join(fixtureRoot, 'hachidori');
    const targetDir = path.join(fixtureRoot, 'vendored', 'hachidori');
    await fs.mkdir(sourceRoot, { recursive: true });
    await git(sourceRoot, 'init', '--initial-branch=main');
    await git(sourceRoot, 'config', 'user.name', 'Hachidori Sync Test');
    await git(sourceRoot, 'config', 'user.email', 'hachidori-sync@example.invalid');
    await writeFixtureExtension(sourceRoot, '0.1.0');
    const firstCommit = await commitAll(sourceRoot, 'fixture: first release');
    await git(sourceRoot, 'tag', '0.1.0');
    return { sourceRoot, targetDir, firstCommit };
}

function release(tag, id) {
    return {
        tag,
        id,
        publishedAt: `2026-09-${String(id).padStart(2, '0')}T00:00:00Z`,
        url: `https://github.com/bee-san/hachidori/releases/tag/${tag}`,
    };
}

async function snapshot(directory) {
    const entries = [];
    async function visit(current, relative = '') {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const childRelative = path.posix.join(relative, entry.name);
            const child = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await visit(child, childRelative);
            } else {
                entries.push([childRelative, await fs.readFile(child, 'utf8')]);
            }
        }
    }
    await visit(directory);
    return entries.sort(([left], [right]) => left.localeCompare(right));
}

test('release metadata and CLI arguments require one complete trusted release', () => {
    const parsed = parseArguments([
        './hachidori',
        '--release-tag',
        '0.1.0',
        '--release-id',
        '1',
        '--release-published-at',
        '2026-09-01T00:00:00Z',
        '--release-url',
        'https://github.com/bee-san/hachidori/releases/tag/0.1.0',
    ]);
    assert.equal(parsed.release.tag, '0.1.0');
    assert.equal(parsed.release.id, 1);
    assert.throws(
        () => parseArguments(['./hachidori', '--release-tag', '0.1.0']),
        /require --release-tag, --release-id, --release-published-at, and --release-url together/,
    );
    assert.throws(
        () => validateReleaseMetadata(release('0.1.0', 0)),
        /positive integer release ID/,
    );
    assert.throws(
        () =>
            validateReleaseMetadata({
                ...release('0.1.0', 1),
                url: 'https://example.com/releases/tag/0.1.0',
            }),
        /bee-san\/hachidori GitHub release/,
    );
    assert.throws(
        () =>
            validateReleaseMetadata({
                ...release('0.1.0', 1),
                url: 'https://github.com/bee-san/hachidori/releases/tag/0.2.0',
            }),
        /match the Hachidori release tag exactly/,
    );
});

test('an equal release adds provenance and repeated syncs are identical', async (t) => {
    const { sourceRoot, targetDir, firstCommit } = await createFixture(t);
    await syncHachidori({ sourceRoot, targetDir });

    const firstResult = await syncHachidori({
        sourceRoot,
        targetDir,
        release: release('0.1.0', 1),
    });
    assert.deepEqual(firstResult, { status: 'synced', commit: firstCommit });
    const source = JSON.parse(await fs.readFile(path.join(targetDir, 'SOURCE.json'), 'utf8'));
    assert.equal(source.commit, firstCommit);
    assert.deepEqual(source.release, release('0.1.0', 1));
    assert.equal(
        JSON.parse(await fs.readFile(path.join(targetDir, 'manifest.json'), 'utf8')).key.length > 0,
        true,
    );
    assert.equal(
        await fs.readFile(path.join(targetDir, 'overlay-mode.js'), 'utf8'),
        'export const OVERLAY_MODE = true;\n',
    );
    await assert.rejects(fs.access(path.join(targetDir, 'README.md')));

    const firstSnapshot = await snapshot(targetDir);
    const secondResult = await syncHachidori({
        sourceRoot,
        targetDir,
        release: release('0.1.0', 1),
    });
    assert.deepEqual(secondResult, { status: 'synced', commit: firstCommit });
    assert.deepEqual(await snapshot(targetDir), firstSnapshot);
});

test('a descendant release replaces the vendored source', async (t) => {
    const { sourceRoot, targetDir, firstCommit } = await createFixture(t);
    await syncHachidori({ sourceRoot, targetDir });
    await writeFixtureExtension(sourceRoot, '0.2.0');
    const secondCommit = await commitAll(sourceRoot, 'fixture: second release');
    await git(sourceRoot, 'tag', '0.2.0');

    const result = await syncHachidori({
        sourceRoot,
        targetDir,
        release: release('0.2.0', 2),
    });
    assert.deepEqual(result, { status: 'synced', commit: secondCommit });
    assert.notEqual(secondCommit, firstCommit);
    const source = JSON.parse(await fs.readFile(path.join(targetDir, 'SOURCE.json'), 'utf8'));
    assert.equal(source.commit, secondCommit);
    assert.equal(source.release.tag, '0.2.0');
    assert.match(await fs.readFile(path.join(targetDir, 'marker.js'), 'utf8'), /0\.2\.0/);
});

test('an older release is skipped without changing the vendored source', async (t) => {
    const { sourceRoot, targetDir, firstCommit } = await createFixture(t);
    await writeFixtureExtension(sourceRoot, '0.2.0');
    const secondCommit = await commitAll(sourceRoot, 'fixture: unreleased main');
    await syncHachidori({ sourceRoot, targetDir });
    const before = await snapshot(targetDir);
    await git(sourceRoot, 'checkout', '--detach', firstCommit);

    const result = await syncHachidori({
        sourceRoot,
        targetDir,
        release: release('0.1.0', 1),
    });
    assert.deepEqual(result, {
        status: 'skipped',
        commit: firstCommit,
        currentCommit: secondCommit,
        reason: 'release-behind',
    });
    assert.deepEqual(await snapshot(targetDir), before);
});

test('a divergent release fails before changing the vendored source', async (t) => {
    const { sourceRoot, targetDir, firstCommit } = await createFixture(t);
    await writeFixtureExtension(sourceRoot, '0.2.0-main');
    await commitAll(sourceRoot, 'fixture: current main');
    await syncHachidori({ sourceRoot, targetDir });
    const before = await snapshot(targetDir);

    await git(sourceRoot, 'checkout', '--detach', firstCommit);
    await writeFixtureExtension(sourceRoot, '0.2.0-diverged');
    const divergentCommit = await commitAll(sourceRoot, 'fixture: divergent release');
    await git(sourceRoot, 'tag', '0.2.0-diverged');

    await assert.rejects(
        syncHachidori({
            sourceRoot,
            targetDir,
            release: release('0.2.0-diverged', 3),
        }),
        new RegExp(`release 0\\.2\\.0-diverged \\(${divergentCommit}\\) diverges`),
    );
    assert.deepEqual(await snapshot(targetDir), before);
});
