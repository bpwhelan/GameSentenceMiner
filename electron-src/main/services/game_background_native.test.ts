import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gameBackgroundBuildAvailable, gameBackgroundHelperPath } from './game_background_native.js';

const roots: string[] = [];
function workspace() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gsm-background-build-'));
    roots.push(root);
    return root;
}
afterEach(() => {
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('gsm-background-build-'))
            throw new Error('Unexpected test directory');
        rmSync(root, { recursive: true, force: true });
    }
});
describe('native game background build selection', () => {
    it('requires both architectures and selects only the manifest build', () => {
        const root = workspace();
        expect(gameBackgroundBuildAvailable(root)).toBe(false);
        for (const arch of ['x64', 'x86']) {
            const base = path.join(root, 'native', 'game-background-hooks', 'bin', arch);
            const output = path.join(base, '0123456789abcdef');
            mkdirSync(output, { recursive: true });
            writeFileSync(path.join(base, 'current.json'), JSON.stringify({ buildId: '0123456789abcdef' }));
            writeFileSync(path.join(output, 'gsm-game-background-helper.exe'), 'test');
            writeFileSync(path.join(output, 'gsm-game-background.dll'), 'test');
        }
        expect(gameBackgroundBuildAvailable(root)).toBe(true);
        expect(gameBackgroundHelperPath(root, 'x64')).toContain(path.join('x64', '0123456789abcdef'));
    });
    it('rejects corrupt manifests and paths escaping the helper directory', () => {
        const root = workspace();
        const base = path.join(root, 'native', 'game-background-hooks', 'bin', 'x64');
        mkdirSync(base, { recursive: true });
        writeFileSync(path.join(base, 'current.json'), JSON.stringify({ buildId: '../../another-program' }));
        expect(() => gameBackgroundHelperPath(root, 'x64')).toThrow(/Invalid/);
        expect(gameBackgroundBuildAvailable(root)).toBe(false);
    });
});
