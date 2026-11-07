import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ObsRuntimeManager, pruneObsRuntime, type ObsRuntimeDependencies } from './obs_runtime.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function setup(overrides: Partial<ObsRuntimeDependencies> = {}) {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-obs-update-'));
    roots.push(baseDir);
    const put = async (file: string, value: string) => {
        await fs.mkdir(path.dirname(path.join(baseDir, file)), { recursive: true });
        await fs.writeFile(path.join(baseDir, file), value);
    };
    await put('obs-studio/bin/64bit/obs64.exe', '32.2.2');
    await put('obs-studio/config/obs-studio/basic/scenes/Game.json', 'user scenes');
    await put('obs-studio/config/obs-studio/plugin_config/obs-websocket/config.json', 'user websocket');
    const payload = Buffer.from('archive');
    const deps: ObsRuntimeDependencies = {
        baseDir, platform: 'win32', arch: 'x64',
        getOptions: () => ({ managed: true, automatic: false, pinnedVersion: null }),
        readVersion: async executable => { try { return await fs.readFile(executable, 'utf8'); } catch { return null; } },
        fetchRelease: vi.fn(async version => ({ tag_name: version ?? '33.0.1', prerelease: false, assets: [{
            name: 'OBS-Studio-33.0.1-Windows-x64.zip', browser_download_url: 'https://github.com/obsproject/obs-studio/releases/download/33.0.1/OBS-Studio-33.0.1-Windows-x64.zip',
            digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
        }] })),
        download: async (_url, destination) => { await fs.writeFile(destination, payload); },
        extract: async (_archive, destination) => {
            await fs.mkdir(path.join(destination, 'bin/64bit'), { recursive: true });
            await fs.writeFile(path.join(destination, 'bin/64bit/obs64.exe'), '33.0.1');
            for (const module of ['obs-browser', 'obs-websocket']) {
                await fs.mkdir(path.join(destination, 'core', module), { recursive: true });
                await fs.writeFile(path.join(destination, 'core', module, `${module}.dll`), 'required core module');
            }
        },
        assertIdle: vi.fn(async () => {}),
        stop: vi.fn(async () => true),
        validate: vi.fn(async () => {}),
        ...overrides,
    };
    return { manager: new ObsRuntimeManager(deps), deps, baseDir, put };
}

describe('managed OBS updates', () => {
    it('checks without changing OBS and keeps manual mode by default', async () => {
        const { manager, deps } = await setup();
        expect(await manager.check()).toMatchObject({ installedVersion: '32.2.2', targetVersion: '33.0.1', updateAvailable: true, automatic: false });
        expect(deps.stop).not.toHaveBeenCalled();
    });
    it.each(['32.2.2', '32.1.2'])('uses pinned %s without downgrading or reinstalling', async pinnedVersion => {
        const { manager, deps } = await setup({ getOptions: () => ({ managed: true, automatic: true, pinnedVersion }) });
        await manager.update();
        expect(deps.fetchRelease).toHaveBeenCalledWith(pinnedVersion);
        expect(deps.stop).not.toHaveBeenCalled();
    });
    it('preserves complete configuration and keeps a working rollback', async () => {
        const { manager, baseDir } = await setup();
        expect(await manager.update()).toMatchObject({ installedVersion: '33.0.1', rollbackVersion: '32.2.2', phase: 'idle' });
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/config/obs-studio/plugin_config/obs-websocket/config.json'), 'utf8')).toBe('user websocket');
        expect(await manager.rollback()).toMatchObject({ installedVersion: '32.2.2', rollbackVersion: '33.0.1' });
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/config/obs-studio/basic/scenes/Game.json'), 'utf8')).toBe('user scenes');
    });
    it('rejects a bad checksum before stopping OBS', async () => {
        const { manager, deps } = await setup({ download: async (_url, destination) => { await fs.writeFile(destination, 'corrupted'); } });
        await expect(manager.update()).rejects.toThrow(/checksum/i);
        expect(deps.stop).not.toHaveBeenCalled();
        expect(await manager.status()).toMatchObject({ installedVersion: '32.2.2', phase: 'error' });
    });
    it('restores the old binaries and configuration when the new OBS fails validation', async () => {
        const validate = vi.fn().mockRejectedValueOnce(new Error('WebSocket did not connect')).mockResolvedValue(undefined);
        const { manager, baseDir } = await setup({ validate });
        await expect(manager.update()).rejects.toThrow('WebSocket did not connect');
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/bin/64bit/obs64.exe'), 'utf8')).toBe('32.2.2');
        expect(validate).toHaveBeenLastCalledWith('32.2.2', true);
    });
    it('preserves third-party legacy plugins without copying old built-in modules into OBS 33', async () => {
        const { manager, baseDir, put } = await setup();
        await put('obs-studio/obs-plugins/64bit/obs-websocket.dll', 'old built-in');
        await put('obs-studio/obs-plugins/64bit/advanced-scene-switcher.dll', 'third-party');
        await put('obs-studio/data/obs-plugins/advanced-scene-switcher/locale/en-US.ini', 'plugin data');
        await put('obs-studio/obs-plugins/64bit/custom-plugin/locales/en-US.pak', 'custom dependency');
        await manager.update();
        await expect(fs.access(path.join(baseDir, 'obs-studio/obs-plugins/64bit/obs-websocket.dll'))).rejects.toThrow();
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/obs-plugins/64bit/advanced-scene-switcher.dll'), 'utf8')).toBe('third-party');
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/data/obs-plugins/advanced-scene-switcher/locale/en-US.ini'), 'utf8')).toBe('plugin data');
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/obs-plugins/64bit/custom-plugin/locales/en-US.pak'), 'utf8')).toBe('custom dependency');
    });
    it('coalesces concurrent updates into one installation', async () => {
        const { manager, deps } = await setup();
        await Promise.all([manager.update(), manager.update()]);
        expect(deps.stop).toHaveBeenCalledTimes(1);
        expect(deps.fetchRelease).toHaveBeenCalledTimes(1);
    });
    it('checks again before shutdown if recording starts during the download', async () => {
        const assertIdle = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('OBS is recording'));
        const { manager, deps } = await setup({ assertIdle });
        await expect(manager.update()).rejects.toThrow('OBS is recording');
        expect(deps.stop).not.toHaveBeenCalled();
    });
    it('disconnects capture clients before closing OBS and resumes them after validation', async () => {
        const order: string[] = [];
        const { manager } = await setup({
            suspendClients: async () => { order.push('suspend'); return async () => { order.push('resume'); }; },
            stop: async () => { order.push('stop'); return true; },
            validate: async () => { order.push('validate'); },
        });
        await manager.update();
        expect(order).toEqual(['suspend', 'stop', 'validate', 'resume']);
    });
    it('resumes capture clients when OBS refuses to close', async () => {
        const resume = vi.fn(async () => {});
        const { manager } = await setup({ suspendClients: async () => resume, stop: async () => { throw new Error('OBS did not close'); } });
        await expect(manager.update()).rejects.toThrow('OBS did not close');
        expect(resume).toHaveBeenCalledTimes(1);
        expect(manager.busy).toBe(false);
    });
    it('refuses to interrupt recording or touch a custom OBS installation', async () => {
        const { manager, deps } = await setup({ assertIdle: vi.fn(async () => { throw new Error('OBS is recording'); }) });
        await expect(manager.update()).rejects.toThrow('OBS is recording');
        expect(deps.stop).not.toHaveBeenCalled();
        const custom = await setup({ getOptions: () => ({ managed: false, automatic: false, pinnedVersion: null }) });
        await expect(custom.manager.update()).rejects.toThrow(/portable/i);
        expect(custom.deps.fetchRelease).not.toHaveBeenCalled();
    });
    it('recovers an interrupted directory swap before reporting an installation', async () => {
        const { manager, baseDir } = await setup();
        await fs.rename(path.join(baseDir, 'obs-studio'), path.join(baseDir, 'obs-studio.previous'));
        expect(await manager.status()).toMatchObject({ installedVersion: '32.2.2' });
    });
    it('trims legacy browser files but keeps the required OBS 33 core runtime', async () => {
        const { baseDir, put } = await setup();
        await put('obs-studio/core/obs-browser/libcef.dll', 'browser');
        await put('obs-studio/core/obs-websocket/obs-websocket.dll', 'keep');
        await put('obs-studio/obs-plugins/64bit/libcef.dll', 'browser');
        await put('obs-studio/obs-plugins/64bit/debug.pdb', 'debug');
        await pruneObsRuntime(path.join(baseDir, 'obs-studio'));
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/core/obs-browser/libcef.dll'), 'utf8')).toBe('browser');
        await expect(fs.access(path.join(baseDir, 'obs-studio/obs-plugins/64bit/libcef.dll'))).rejects.toThrow();
        await expect(fs.access(path.join(baseDir, 'obs-studio/obs-plugins/64bit/debug.pdb'))).rejects.toThrow();
        expect(await fs.readFile(path.join(baseDir, 'obs-studio/core/obs-websocket/obs-websocket.dll'), 'utf8')).toBe('keep');
    });
});
