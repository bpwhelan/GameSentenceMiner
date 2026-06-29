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
});
