import { describe, expect, it, vi } from 'vitest';

import type { AppUpdateStatus } from '../../shared/app_update.js';
import type { DesktopUpdateChangelogSnapshot } from '../../shared/changelog.js';
import { DevUpdatePreview } from './dev_update_preview.js';

const status: AppUpdateStatus = {
    currentVersion: '2026.9.4', latestVersion: null, updateAvailable: false,
    checkedAt: null, error: null, checking: false, downloading: false, channel: 'latest',
};
const notes: DesktopUpdateChangelogSnapshot = {
    fromVersion: '2026.9.4', toVersion: '2026.9.4', status: 'ready', source: 'remote',
    title: 'Latest release', markdown: 'Online notes.', assetBaseUrl: '', error: null,
};

describe('development update preview', () => {
    it('populates an offer for the already-installed version without changing the real status', async () => {
        const changed = vi.fn();
        const preview = new DevUpdatePreview(true, changed);
        await preview.show(async () => notes);
        expect(preview.apply(status)).toMatchObject({
            updateAvailable: true, latestVersion: '2026.9.4', preview: true, downloading: false,
        });
        expect(preview.getChangelog()).toEqual(notes);
        expect(status.updateAvailable).toBe(false);
        expect(changed).toHaveBeenCalledTimes(1);
        preview.clear();
        expect(preview.apply(status)).toEqual(status);
        expect(preview.getChangelog()).toBeNull();
    });

    it('does nothing when development tools are disabled', async () => {
        const load = vi.fn(async () => notes);
        const changed = vi.fn();
        const preview = new DevUpdatePreview(false, changed);
        await preview.show(load);
        preview.clear();
        expect(load).not.toHaveBeenCalled();
        expect(changed).not.toHaveBeenCalled();
        expect(preview.getChangelog()).toBeNull();
        expect(preview.apply(status)).toEqual(status);
    });

    it('does not restore the preview after clearing a pending request', async () => {
        const preview = new DevUpdatePreview(true, vi.fn());
        let finish!: (snapshot: DesktopUpdateChangelogSnapshot) => void;
        const pending = preview.show(() => new Promise((resolve) => { finish = resolve; }));
        preview.clear();
        finish(notes);
        await pending;
        expect(preview.getChangelog()).toBeNull();
    });

    it('keeps a real download visible', async () => {
        const preview = new DevUpdatePreview(true, vi.fn());
        await preview.show(async () => notes);
        const downloading = { ...status, downloading: true, updateAvailable: true, latestVersion: '2026.10.0' };
        expect(preview.apply(downloading)).toEqual(downloading);
    });
});
