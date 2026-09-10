import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    getDevPyprojectSyncState,
    markDevPyprojectSynced,
} from './dev_environment_sync.js';

describe('development pyproject environment sync state', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
        for (const directory of temporaryDirectories.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    function createFixture(
        contents: string,
        lockContents: string = 'version = 1\n'
    ): { projectPath: string; venvPath: string } {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-dev-sync-'));
        temporaryDirectories.push(root);
        const projectPath = path.join(root, 'project');
        const venvPath = path.join(root, 'python_venv');
        fs.mkdirSync(projectPath);
        fs.mkdirSync(venvPath);
        fs.writeFileSync(path.join(projectPath, 'pyproject.toml'), contents);
        fs.writeFileSync(path.join(projectPath, 'uv.lock'), lockContents);
        fs.writeFileSync(path.join(projectPath, '.python-version'), '3.13.2\n');
        return { projectPath, venvPath };
    }

    it('requires a sync until the current pyproject content is stamped', () => {
        const { projectPath, venvPath } = createFixture('[project]\nname = "gsm"\n');

        const initialState = getDevPyprojectSyncState(projectPath, venvPath);
        expect(initialState.changed).toBe(true);

        markDevPyprojectSynced(venvPath, initialState.fingerprint);

        expect(getDevPyprojectSyncState(projectPath, venvPath).changed).toBe(false);
    });

    it('detects content changes but ignores timestamp-only changes', () => {
        const { projectPath, venvPath } = createFixture('[project]\nname = "gsm"\n');
        const pyprojectPath = path.join(projectPath, 'pyproject.toml');
        const initialState = getDevPyprojectSyncState(projectPath, venvPath);
        markDevPyprojectSynced(venvPath, initialState.fingerprint);

        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(pyprojectPath, future, future);
        expect(getDevPyprojectSyncState(projectPath, venvPath).changed).toBe(false);

        fs.appendFileSync(pyprojectPath, 'dependencies = ["example"]\n');
        expect(getDevPyprojectSyncState(projectPath, venvPath).changed).toBe(true);
    });

    it('detects lock-only dependency changes', () => {
        const { projectPath, venvPath } = createFixture(
            '[project]\nname = "gsm"\n',
            'version = 1\nrevision = 1\n'
        );
        const initialState = getDevPyprojectSyncState(projectPath, venvPath);
        markDevPyprojectSynced(venvPath, initialState.fingerprint);

        fs.writeFileSync(
            path.join(projectPath, 'uv.lock'),
            'version = 1\nrevision = 2\n'
        );

        expect(getDevPyprojectSyncState(projectPath, venvPath).changed).toBe(true);
    });

    it('detects a different selected extras set regardless of ordering', () => {
        const { projectPath, venvPath } = createFixture('[project]\nname = "gsm"\n');
        const initialState = getDevPyprojectSyncState(projectPath, venvPath, [
            'lens',
            'gpu',
        ]);
        markDevPyprojectSynced(venvPath, initialState.fingerprint);

        expect(
            getDevPyprojectSyncState(projectPath, venvPath, ['gpu', 'lens']).changed
        ).toBe(false);
        expect(getDevPyprojectSyncState(projectPath, venvPath, ['gpu']).changed).toBe(
            true
        );
    });

    it('detects a managed Python version change', () => {
        const { projectPath, venvPath } = createFixture('[project]\nname = "gsm"\n');
        const initialState = getDevPyprojectSyncState(projectPath, venvPath);
        markDevPyprojectSynced(venvPath, initialState.fingerprint);

        fs.writeFileSync(path.join(projectPath, '.python-version'), '3.13.3\n');

        expect(getDevPyprojectSyncState(projectPath, venvPath).changed).toBe(true);
    });
});
