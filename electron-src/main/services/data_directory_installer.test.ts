import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Run the actual installer helper with isolated profiles; never install/uninstall GSM.
describe.skipIf(process.platform !== 'win32')('installer data folder selection', { timeout: 45000 }, () => {
    let root: string;
    let profile: string;
    let appData: string;
    let pointer: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-installer-'));
        profile = path.join(root, 'home');
        appData = path.join(root, 'roaming');
        pointer = path.join(profile, '.config', 'GameSentenceMiner', 'data_dir.json');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function run(mode: string, selected = path.join(root, 'data')) {
        const output = path.join(root, 'state.ini');
        const selection = path.join(root, 'selection.txt');
        fs.writeFileSync(selection, `${selected}\r\n${path.join(root, 'application')}`, 'utf16le');
        const result = spawnSync('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', path.resolve('build/data-directory.ps1'), '-Mode', mode,
            '-ProfileRoot', profile, '-AppDataRoot', appData,
            '-OutputPath', output, '-SelectionFile', selection,
        ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        expect(result.error).toBeUndefined();
        return { ...result, state: fs.readFileSync(output, 'utf16le') };
    }

    it('offers the default on a fresh install without saving until installation', () => {
        const result = run('Inspect');
        expect(result.status).toBe(0);
        expect(result.state).toContain(`Path=${path.join(appData, 'GameSentenceMiner')}`);
        expect(result.state).toContain('Locked=0');
        expect(run('Validate').status).toBe(0);
        expect(fs.existsSync(pointer)).toBe(false);
    });

    it('writes valid UTF-8 JSON for paths with spaces, Unicode, and PowerShell metacharacters', () => {
        const target = path.join(root, "日本語 user's $GSM `data` [1]");
        const result = run('Initialize', target);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(pointer, 'utf8'))).toEqual({ version: 2, dataDir: target });
        expect(fs.readdirSync(target)).toEqual([]);
        expect(run('Inspect').state).toContain(`Path=${target}`);
    });

    it.each(['stable', 'legacy', 'default'])('preserves %s installations', (kind) => {
        const target = path.join(root, 'existing');
        const legacy = path.join(appData, 'GameSentenceMiner');
        const original = kind === 'stable' ? pointer : path.join(legacy, kind === 'legacy' ? 'data_dir.json' : 'gsm.db');
        const content = kind === 'default' ? 'keep database' : JSON.stringify({ dataDir: target });
        fs.mkdirSync(path.dirname(original), { recursive: true });
        fs.writeFileSync(original, content);
        expect(run('Inspect').state).toContain('Locked=1');
        expect(run('Initialize').status).toBe(1);
        expect(fs.readFileSync(original, 'utf8')).toBe(content);
    });

    it('prefers the stable pointer, including after deleting the old AppData directory', () => {
        const target = path.join(root, 'selected');
        expect(run('Initialize', target).status).toBe(0);
        const legacy = path.join(appData, 'GameSentenceMiner');
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, 'data_dir.json'), JSON.stringify({ dataDir: path.join(root, 'stale') }));
        expect(run('Inspect').state).toContain(`Path=${target}`);
        fs.rmSync(appData, { recursive: true });
        expect(run('Inspect').state).toContain(`Path=${target}`);
    });

    it('rejects a nonempty folder without modifying its contents', () => {
        const target = path.join(root, 'occupied');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
        expect(run('Initialize', target).status).toBe(1);
        expect(fs.readdirSync(target)).toEqual(['keep.txt']);
        expect(fs.existsSync(pointer)).toBe(false);
    });

    it.each(['relative/data', 'application', 'application/data'])('rejects unsafe destination %s', (value) => {
        const target = value.startsWith('application') ? path.join(root, value) : value;
        expect(run('Initialize', target).status).toBe(1);
        expect(fs.existsSync(pointer)).toBe(false);
    });
});
