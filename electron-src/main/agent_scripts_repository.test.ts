import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    axiosGet: vi.fn(),
    extractZip: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: mocks.axiosGet,
    },
}));

vi.mock('extract-zip', () => ({
    default: mocks.extractZip,
}));

vi.mock('node:fs', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:fs')>(),
}));

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-agent-repository-'));
    tempRoots.push(root);
    return root;
}

async function loadRepositoryModule(baseDir: string) {
    vi.resetModules();
    vi.doMock('./util.js', () => ({
        BASE_DIR: baseDir,
    }));
    return import('./agent_scripts_repository.js');
}

function mockSuccessfulGitHubResponses(commit = 'abc123') {
    mocks.axiosGet.mockImplementation((url: string) => {
        if (url === 'https://api.github.com/repos/0xDC00/scripts') {
            return Promise.resolve({ data: { default_branch: 'main' } });
        }
        if (url === 'https://api.github.com/repos/0xDC00/scripts/commits/main') {
            return Promise.resolve({ data: { sha: commit } });
        }
        if (url === `https://api.github.com/repos/0xDC00/scripts/zipball/${commit}`) {
            return Promise.resolve({
                data: Readable.from([Buffer.from('zip')]),
            });
        }
        throw new Error(`Unexpected URL: ${url}`);
    });
}

function writeFiles(root: string, files: Record<string, string>): void {
    for (const [relativePath, contents] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents);
    }
}

function mockSnapshots(currentCommit: string, snapshots: Record<string, Record<string, string>>): void {
    mockSuccessfulGitHubResponses(currentCommit);
    const defaultResponse = mocks.axiosGet.getMockImplementation()!;
    mocks.axiosGet.mockImplementation((url: string) => {
        const commit = url.split('/zipball/')[1];
        if (commit && snapshots[commit]) {
            return Promise.resolve({ data: Readable.from([Buffer.from(commit)]) });
        }
        return defaultResponse(url);
    });
    mocks.extractZip.mockImplementation(async (zipPath: string, options: { dir: string }) => {
        const commit = fs.readFileSync(zipPath, 'utf8');
        writeFiles(path.join(options.dir, `0xDC00-scripts-${commit}`), snapshots[commit]);
    });
}

function readMetadata(metadataPath: string) {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
}

describe('managed Agent scripts repository', () => {
    beforeEach(() => {
        mocks.axiosGet.mockReset();
        mocks.extractZip.mockReset();
    });

    afterEach(() => {
        vi.doUnmock('./util.js');
        for (const root of tempRoots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('downloads and installs the 0xDC00 scripts ZIP into the managed AppData path', async () => {
        const baseDir = makeTempRoot();
        mockSuccessfulGitHubResponses('commit-one');
        mocks.extractZip.mockImplementation(async (_zipPath: string, options: { dir: string }) => {
            const extractedRoot = path.join(options.dir, '0xDC00-scripts-commit-one');
            fs.mkdirSync(extractedRoot, { recursive: true });
            fs.writeFileSync(path.join(extractedRoot, 'libLoader.js'), '');
            fs.writeFileSync(path.join(extractedRoot, 'NS_01000AE01954A000_Game.js'), '');
        });

        const repository = await loadRepositoryModule(baseDir);
        const status = await repository.ensureManagedAgentScriptsCurrent();

        expect(status).toMatchObject({
            path: path.join(baseDir, 'agent-scripts', 'scripts'),
            repository: '0xDC00/scripts',
            branch: 'main',
            commit: 'commit-one',
            installed: true,
            updated: true,
            scriptCount: 1,
        });
        expect(fs.existsSync(path.join(status.path, 'libLoader.js'))).toBe(true);
        expect(fs.existsSync(path.join(status.path, 'NS_01000AE01954A000_Game.js'))).toBe(true);
        expect(fs.existsSync(repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE)).toBe(true);
    });

    it('uses a fresh local install without checking GitHub again', async () => {
        const baseDir = makeTempRoot();
        const repository = await loadRepositoryModule(baseDir);
        fs.mkdirSync(repository.__test.MANAGED_AGENT_SCRIPTS_PATH, { recursive: true });
        fs.writeFileSync(path.join(repository.__test.MANAGED_AGENT_SCRIPTS_PATH, 'libLoader.js'), '');
        fs.writeFileSync(path.join(repository.__test.MANAGED_AGENT_SCRIPTS_PATH, 'PC_Game.js'), '');
        fs.mkdirSync(path.dirname(repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE), {
            recursive: true,
        });
        fs.writeFileSync(
            repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE,
            JSON.stringify({
                repository: '0xDC00/scripts',
                branch: 'main',
                commit: 'current',
                checkedAt: Date.now(),
                installedAt: Date.now(),
                scriptCount: 1,
            }),
            'utf8',
        );

        const status = await repository.ensureManagedAgentScriptsCurrent();

        expect(status).toMatchObject({
            installed: true,
            updated: false,
            commit: 'current',
            scriptCount: 1,
        });
        expect(mocks.axiosGet).not.toHaveBeenCalled();
    });

    it('keeps custom scripts and their supporting files while updating untouched upstream files', async () => {
        const repository = await loadRepositoryModule(makeTempRoot());
        mockSnapshots('one', { one: {
            'libLoader.js': 'loader one',
            'PC_Game.js': 'game one',
            'PC_Removed.js': 'removed upstream',
            'helpers/libGame.js': 'helper one',
        } });
        const first = await repository.ensureManagedAgentScriptsCurrent();
        writeFiles(first.path, {
            'PC_Steam_Sora_no_Kiseki_the_1st_DialogueOnly.js': 'custom dialogue hook',
            'custom/libDialogue.js': 'custom helper',
            'custom/options.json': '{"dialogueOnly":true}',
        });
        mockSnapshots('two', { two: {
            'libLoader.js': 'loader two',
            'PC_Game.js': 'game two',
            'helpers/libGame.js': 'helper two',
            'PC_New.js': 'new game',
        } });

        const status = await repository.ensureManagedAgentScriptsCurrent({ force: true });

        expect(status).toMatchObject({ updated: true, commit: 'two', scriptCount: 3 });
        expect(fs.readFileSync(path.join(status.path, 'PC_Steam_Sora_no_Kiseki_the_1st_DialogueOnly.js'), 'utf8'))
            .toBe('custom dialogue hook');
        expect(fs.readFileSync(path.join(status.path, 'custom/libDialogue.js'), 'utf8')).toBe('custom helper');
        expect(fs.readFileSync(path.join(status.path, 'custom/options.json'), 'utf8')).toBe('{"dialogueOnly":true}');
        expect(fs.readFileSync(path.join(status.path, 'PC_Game.js'), 'utf8')).toBe('game two');
        expect(fs.readFileSync(path.join(status.path, 'helpers/libGame.js'), 'utf8')).toBe('helper two');
        expect(fs.existsSync(path.join(status.path, 'PC_Removed.js'))).toBe(false);
    });

    it('preserves edited upstream files and filename collisions across repeated forced updates', async () => {
        const repository = await loadRepositoryModule(makeTempRoot());
        mockSnapshots('one', { one: {
            'libLoader.js': 'loader one',
            'PC_Game.js': 'game one',
            'PC_Removed.js': 'original removed game',
        } });
        const first = await repository.ensureManagedAgentScriptsCurrent();
        const localFiles = {
            'libLoader.js': 'custom loader',
            'PC_Game.js': 'custom game',
            'PC_Removed.js': 'custom removed game',
            'PC_Collision.js': 'custom collision',
        };
        writeFiles(first.path, localFiles);
        // Even an upstream version that happens to match a local override must not
        // turn that override back into a file that GSM owns on the next update.
        mockSnapshots('two', { two: { ...localFiles, 'PC_New.js': 'new game' } });
        await repository.ensureManagedAgentScriptsCurrent({ force: true });
        mockSnapshots('three', { three: {
            'libLoader.js': 'loader three',
            'PC_Game.js': 'game three',
            'PC_Collision.js': 'upstream collision',
            'PC_New.js': 'new game three',
        } });

        const status = await repository.ensureManagedAgentScriptsCurrent({ force: true });

        for (const [relativePath, contents] of Object.entries(localFiles)) {
            expect(fs.readFileSync(path.join(status.path, relativePath), 'utf8')).toBe(contents);
        }
        expect(fs.readFileSync(path.join(status.path, 'PC_New.js'), 'utf8')).toBe('new game three');
        expect(status.scriptCount).toBe(4);
    });

    it('uses the pinned previous archive to protect edits when upgrading an install without file hashes', async () => {
        const previousCommit = 'a'.repeat(40);
        const nextCommit = 'b'.repeat(40);
        const previousFiles = { 'libLoader.js': 'loader one', 'PC_Game.js': 'game one' };
        const repository = await loadRepositoryModule(makeTempRoot());
        mockSnapshots(previousCommit, { [previousCommit]: previousFiles });
        const first = await repository.ensureManagedAgentScriptsCurrent();
        const metadataPath = repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE;
        const legacyMetadata = readMetadata(metadataPath);
        delete legacyMetadata.fileHashes;
        legacyMetadata.checkedAt = 0;
        fs.writeFileSync(metadataPath, JSON.stringify(legacyMetadata));
        writeFiles(first.path, { 'PC_Game.js': 'custom game', 'PC_Custom.js': 'custom script' });
        mockSnapshots(nextCommit, {
            [previousCommit]: previousFiles,
            [nextCommit]: { 'libLoader.js': 'loader two', 'PC_Game.js': 'game two' },
        });

        const status = await repository.ensureManagedAgentScriptsCurrent();

        expect(fs.readFileSync(path.join(status.path, 'libLoader.js'), 'utf8')).toBe('loader two');
        expect(fs.readFileSync(path.join(status.path, 'PC_Game.js'), 'utf8')).toBe('custom game');
        expect(fs.readFileSync(path.join(status.path, 'PC_Custom.js'), 'utf8')).toBe('custom script');
        expect(status.scriptCount).toBe(2);
    });

    it.each(['missing', 'corrupt', 'unavailable', 'mutable-ref', 'invalid-hashes'])(
        'preserves every existing file when the previous baseline is %s', async (baseline) => {
            const repository = await loadRepositoryModule(makeTempRoot());
            const scriptsPath = repository.getManagedAgentScriptsPath();
            writeFiles(scriptsPath, { 'libLoader.js': 'local loader', 'PC_Game.js': 'local game' });
            const metadataPath = repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE;
            if (baseline === 'corrupt') {
                fs.writeFileSync(metadataPath, '{broken');
            } else if (baseline !== 'missing') {
                fs.writeFileSync(metadataPath, JSON.stringify({
                    repository: '0xDC00/scripts', branch: 'main',
                    commit: baseline === 'mutable-ref' ? 'main' : 'a'.repeat(40),
                    checkedAt: 0, installedAt: 1, scriptCount: 1,
                    ...(baseline === 'invalid-hashes' ? { fileHashes: ['invalid'] } : {}),
                }));
            }
            mockSnapshots('next', {
                next: { 'libLoader.js': 'remote loader', 'PC_Game.js': 'remote game', 'PC_New.js': 'new game' },
                ...(baseline === 'invalid-hashes' ? {
                    ['a'.repeat(40)]: { 'libLoader.js': 'local loader', 'PC_Game.js': 'local game' },
                } : {}),
            });

            const status = await repository.ensureManagedAgentScriptsCurrent();

            expect(fs.readFileSync(path.join(status.path, 'libLoader.js'), 'utf8')).toBe('local loader');
            expect(fs.readFileSync(path.join(status.path, 'PC_Game.js'), 'utf8')).toBe('local game');
            expect(fs.readFileSync(path.join(status.path, 'PC_New.js'), 'utf8')).toBe('new game');
            if (baseline === 'mutable-ref') {
                expect(mocks.axiosGet.mock.calls.map(([url]) => url)).not.toContain(
                    'https://api.github.com/repos/0xDC00/scripts/zipball/main',
                );
            }
        },
    );

    it('retains file ownership through a same-commit update check', async () => {
        const repository = await loadRepositoryModule(makeTempRoot());
        mockSnapshots('one', { one: { 'libLoader.js': 'loader one', 'PC_Game.js': 'game one' } });
        await repository.ensureManagedAgentScriptsCurrent();
        const metadataPath = repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE;
        const metadata = readMetadata(metadataPath);
        expect(metadata.fileHashes).toBeDefined();
        metadata.checkedAt = 0;
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));

        const status = await repository.ensureManagedAgentScriptsCurrent();

        expect(status.updated).toBe(false);
        expect(readMetadata(metadataPath).fileHashes).toEqual(metadata.fileHashes);
    });

    it('preserves local files and directories that conflict with the new upstream layout', async () => {
        const repository = await loadRepositoryModule(makeTempRoot());
        writeFiles(repository.getManagedAgentScriptsPath(), {
            'PC_Game.js': 'local game',
            'custom/options.json': 'local options',
            'notes': 'local notes',
        });
        mockSnapshots('one', { one: {
            'libLoader.js': 'loader', 'PC_New.js': 'new game',
            'custom': 'upstream file', 'notes/README.md': 'upstream notes',
        } });

        const status = await repository.ensureManagedAgentScriptsCurrent();

        expect(fs.readFileSync(path.join(status.path, 'custom/options.json'), 'utf8')).toBe('local options');
        expect(fs.readFileSync(path.join(status.path, 'notes'), 'utf8')).toBe('local notes');
        const hashes = readMetadata(repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE).fileHashes;
        expect(Object.keys(hashes).map((key) => key.toLowerCase()).sort()).toEqual(['libloader.js', 'pc_new.js']);
    });

    it('keeps download artifacts out of installs from archives without a wrapper directory', async () => {
        const repository = await loadRepositoryModule(makeTempRoot());
        mockSuccessfulGitHubResponses('one');
        mocks.extractZip.mockImplementation(async (_zipPath: string, options: { dir: string }) => {
            writeFiles(options.dir, { 'libLoader.js': 'loader', 'PC_Game.js': 'game' });
        });

        const status = await repository.ensureManagedAgentScriptsCurrent();

        expect(fs.readdirSync(status.path).sort()).toEqual(['PC_Game.js', 'libLoader.js']);
    });

    it.each(['preserve', 'install', 'metadata'])(
        'leaves the existing scripts and metadata intact after a failure during %s', async (phase) => {
            const repository = await loadRepositoryModule(makeTempRoot());
            mockSnapshots('one', { one: { 'libLoader.js': 'loader one', 'PC_Game.js': 'game one' } });
            const first = await repository.ensureManagedAgentScriptsCurrent();
            writeFiles(first.path, { 'PC_Custom.js': 'custom script', 'PC_Game.js': 'local game' });
            const metadataPath = repository.__test.MANAGED_AGENT_SCRIPTS_METADATA_FILE;
            const metadataBefore = fs.readFileSync(metadataPath, 'utf8');
            mockSnapshots('two', { two: {
                'libLoader.js': 'loader two', 'PC_Game.js': 'game two', 'PC_New.js': 'new game',
            } });
            const renameSync = fs.renameSync;
            const copySpy = vi.spyOn(fs, 'cpSync');
            const renameSpy = vi.spyOn(fs, 'renameSync');
            if (phase === 'preserve') {
                copySpy.mockImplementation(() => { throw new Error('Simulated preservation failure'); });
            } else {
                renameSpy.mockImplementation((source, destination) => {
                    if (
                        (phase === 'metadata' && destination === metadataPath) ||
                        (phase === 'install' && destination === first.path && String(source).includes('download-'))
                    ) {
                        throw new Error(`Simulated ${phase} failure`);
                    }
                    return renameSync(source, destination);
                });
            }

            try {
                await expect(repository.ensureManagedAgentScriptsCurrent({ force: true })).rejects.toThrow('Simulated');
            } finally {
                copySpy.mockRestore();
                renameSpy.mockRestore();
            }

            expect(fs.readFileSync(path.join(first.path, 'PC_Custom.js'), 'utf8')).toBe('custom script');
            expect(fs.readFileSync(path.join(first.path, 'PC_Game.js'), 'utf8')).toBe('local game');
            expect(fs.readFileSync(path.join(first.path, 'libLoader.js'), 'utf8')).toBe('loader one');
            expect(fs.existsSync(path.join(first.path, 'PC_New.js'))).toBe(false);
            expect(fs.readFileSync(metadataPath, 'utf8')).toBe(metadataBefore);
            expect(fs.readdirSync(repository.__test.MANAGED_AGENT_SCRIPTS_ROOT).sort()).toEqual(['metadata.json', 'scripts']);
        },
    );

    it('preserves a local directory link without changing its target', async () => {
        const baseDir = makeTempRoot();
        const repository = await loadRepositoryModule(baseDir);
        const scriptsPath = repository.getManagedAgentScriptsPath();
        const externalPath = path.join(baseDir, 'external');
        writeFiles(scriptsPath, { 'PC_Game.js': 'local game' });
        writeFiles(externalPath, { 'notes.txt': 'external notes' });
        fs.symlinkSync(externalPath, path.join(scriptsPath, 'custom'), 'junction');
        mockSnapshots('one', { one: {
            'libLoader.js': 'loader', 'PC_New.js': 'new game', 'custom/notes.txt': 'upstream notes',
        } });

        const status = await repository.ensureManagedAgentScriptsCurrent();

        expect(fs.lstatSync(path.join(status.path, 'custom')).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(path.join(status.path, 'custom/notes.txt'), 'utf8')).toBe('external notes');
        expect(fs.readFileSync(path.join(externalPath, 'notes.txt'), 'utf8')).toBe('external notes');
    });
});
