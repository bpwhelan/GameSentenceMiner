import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallSessionManager } from './install_session.js';
import { syncStartupBackend } from './startup_backend_update.js';

vi.mock('electron-log/main.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('startup backend sync', () => {
    let dataDir: string;
    beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-startup-update-')); });
    afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

    function setup(overrides: Partial<Parameters<typeof syncStartupBackend>[0]> = {}) {
        const sessions = new InstallSessionManager();
        const updater = {
            lastBackendUpdateWasSuccessful: true,
            lastBackendUpdateFailureReason: null as string | null,
            updateGSM: vi.fn(async () => {
                sessions.startSession('backend_update');
                sessions.finishActive(updater.lastBackendUpdateWasSuccessful ? 'completed' : 'failed');
            }),
        };
        const options = {
            appVersionChanged: false,
            updateFlagPath: path.join(dataDir, 'update_python.flag'),
            autoUpdateEnabled: false,
            hasPendingDesktopUpdate: false,
            forceUpdate: false,
            ...overrides,
        };
        return { options, updater, sessions };
    }

    it('checks the backend for unread release notes after a restart with automatic updates disabled', async () => {
        const { options, updater, sessions } = setup({ hasPendingDesktopUpdate: true });

        await expect(syncStartupBackend(options, updater)).resolves.toBe(true);

        expect(updater.updateGSM).toHaveBeenCalledExactlyOnceWith(false, false);
        expect(sessions.getLastFinishedSnapshot()?.status).toBe('completed');
    });

    it('keeps ordinary launches fast when no sync is needed', async () => {
        const { options, updater } = setup();
        await expect(syncStartupBackend(options, updater)).resolves.toBe(true);
        expect(updater.updateGSM).not.toHaveBeenCalled();
    });

    it.each([
        { appVersionChanged: true },
        { forceUpdate: true },
    ])('forces a sync for %j', async (overrides) => {
        const { options, updater } = setup(overrides);
        await expect(syncStartupBackend(options, updater)).resolves.toBe(true);
        expect(updater.updateGSM).toHaveBeenCalledExactlyOnceWith(false, true);
    });

    it('still checks for compatible backend updates when automatic updates are enabled', async () => {
        const { options, updater } = setup({ autoUpdateEnabled: true });
        await syncStartupBackend(options, updater);
        expect(updater.updateGSM).toHaveBeenCalledExactlyOnceWith(false, false);
    });

    it('forces the recovery-flag sync and removes the flag only after success', async () => {
        const { options, updater } = setup();
        fs.writeFileSync(options.updateFlagPath, '');
        updater.lastBackendUpdateWasSuccessful = false;
        updater.lastBackendUpdateFailureReason = 'Network timeout';

        await expect(syncStartupBackend(options, updater)).resolves.toBe(false);
        expect(updater.updateGSM).toHaveBeenCalledExactlyOnceWith(false, true);
        expect(fs.existsSync(options.updateFlagPath)).toBe(true);

        updater.lastBackendUpdateWasSuccessful = true;
        updater.lastBackendUpdateFailureReason = null;
        await expect(syncStartupBackend(options, updater)).resolves.toBe(true);
        expect(fs.existsSync(options.updateFlagPath)).toBe(false);
    });

    it('does not let a failed version-change sync count as a completed desktop upgrade', async () => {
        const { options, updater } = setup({ appVersionChanged: true });
        updater.lastBackendUpdateWasSuccessful = false;
        await expect(syncStartupBackend(options, updater)).resolves.toBe(false);
    });

    it('preserves the recovery flag if the updater throws', async () => {
        const { options, updater } = setup();
        fs.writeFileSync(options.updateFlagPath, '');
        updater.updateGSM.mockRejectedValueOnce(new Error('Sync interrupted'));
        await expect(syncStartupBackend(options, updater)).rejects.toThrow('Sync interrupted');
        expect(fs.existsSync(options.updateFlagPath)).toBe(true);
    });
});
