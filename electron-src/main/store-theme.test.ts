import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, unknown>();
const send = vi.fn();
const destroyedSend = vi.fn();
const legacyFeatures = vi.hoisted(() => ({ value: {} as Record<string, unknown>, read: vi.fn() }));
vi.mock('./gsm_config.js', () => ({ getLegacyNotificationFeatures: () => {
    legacyFeatures.read();
    return legacyFeatures.value;
} }));
vi.mock('electron-store', () => ({
    default: class Store {
        constructor(options?: { defaults?: Record<string, unknown> }) {
            for (const [key, value] of Object.entries(options?.defaults ?? {})) if (!values.has(key)) values.set(key, value);
        }
        get(key: string, fallback?: unknown) { return values.get(key) ?? fallback; }
        set(key: string, value: unknown) { values.set(key, value); }
    },
}));
vi.mock('electron', () => ({
    BrowserWindow: class {
        static getAllWindows() {
            return [
                { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
                { isDestroyed: () => true, webContents: { send: destroyedSend } },
            ];
        }
    },
}));
vi.mock('./data_dir.js', () => ({ getBaseDir: () => 'C:/test-gsm' }));
vi.mock('./agent_script_resolver.js', () => ({ findAgentScriptById: vi.fn() }));

describe('shared desktop theme', () => {
    beforeEach(() => { values.clear(); legacyFeatures.value = {}; vi.resetModules(); });

    it('migrates disabled Python switches once and lets desktop settings enable them afterwards', async () => {
        legacyFeatures.value = { notify_on_audio_generated: false, notify_on_anki_enhancement_failed: false };
        const settings = await import('./store.js');
        expect(settings.getNotificationPreferences().categories.confirmation.mode).toBe('off');
        expect(settings.getNotificationPreferences().categories.cardError.mode).toBe('off');
        expect(legacyFeatures.read).toHaveBeenCalledOnce();
        settings.setNotificationPreferences({ volume: 12, categories: { confirmation: { mode: 'sound', sound: 'bell' } } });
        const reloaded = settings.getNotificationPreferences();
        expect(reloaded.categories.confirmation).toEqual({ mode: 'sound', sound: 'bell' });
        expect(reloaded.volume).toBe(12);
        vi.resetModules();
        const restarted = await import('./store.js');
        expect(restarted.getNotificationPreferences()).toEqual(reloaded);
        expect(legacyFeatures.read).toHaveBeenCalledOnce();
    });

    it('preserves desktop sound choices and makes an explicit first save authoritative', async () => {
        legacyFeatures.value = { notify_on_update: false };
        const settings = await import('./store.js');
        settings.setNotificationPreferences({ volume: 9, categories: { confirmation: { mode: 'both', sound: 'chime' } } });
        expect(settings.getNotificationPreferences().categories.confirmation).toEqual({ mode: 'both', sound: 'chime' });
        legacyFeatures.value = { notify_on_text_intake_state: false };
        expect(settings.getNotificationPreferences().categories.pauseResume.mode).toBe('sound');
    });

    it('restores paired pause/resume tones for the previous default only once', async () => {
        const settings = await import('./store.js');
        values.set('notificationPreferencesMigrationVersion', 1);
        values.set('notificationPreferences', { categories: { pauseResume: { mode: 'sound', sound: 'soft-ping' } } });
        expect(settings.getNotificationPreferences().categories.pauseResume.sound).toBe('pause-resume');
        settings.setNotificationPreferences({ categories: { pauseResume: { mode: 'sound', sound: 'soft-ping' } } });
        expect(settings.getNotificationPreferences().categories.pauseResume.sound).toBe('soft-ping');
    });

    it('persists notification choices and safely fills missing preferences', async () => {
        const settings = await import('./store.js');
        expect(settings.getNotificationPreferences().volume).toBe(15);
        settings.setNotificationPreferences({ volume: 7, events: { AnkiCardUpdated: { mode: 'off' } } });
        expect(settings.getNotificationPreferences().categories.confirmation.mode).toBe('off');
        expect(settings.getNotificationPreferences().volume).toBe(7);
        expect(values.get('notificationPreferences')).toEqual(settings.getNotificationPreferences());
    });

    it('persists a theme change and updates open windows', async () => {
        const settings = await import('./store.js');
        settings.setTheme('solarized-light');
        expect(settings.getTheme()).toBe('solarized-light');
        expect(send).toHaveBeenCalledExactlyOnceWith('settings.themeChanged', 'solarized-light');
        expect(destroyedSend).not.toHaveBeenCalled();
    });

    it('persists visible tabs and notifies open windows without polling', async () => {
        const settings = await import('./store.js');
        settings.setVisibleTabs(['speech', 'launcher']);
        expect(settings.getVisibleTabs()).toEqual(['speech', 'launcher']);
        expect(send).toHaveBeenCalledExactlyOnceWith('settings.visibleTabsChanged', ['speech', 'launcher']);
        expect(destroyedSend).not.toHaveBeenCalled();
    });

    it('broadcasts the default when the selection is cleared, and skips unchanged selections', async () => {
        const settings = await import('./store.js');
        settings.setTheme('gsm-dark');
        expect(send).not.toHaveBeenCalled();
        values.set('theme', 'solarized-light');
        settings.setTheme('');
        expect(settings.getTheme()).toBe('gsm-dark');
        expect(send).toHaveBeenCalledExactlyOnceWith('settings.themeChanged', 'gsm-dark');
    });

    it('persists the blanket seasonal opt out and broadcasts only actual changes', async () => {
        const settings = await import('./store.js');
        expect(settings.getSeasonalEffectsDisabled()).toBe(false);
        settings.setSeasonalEffectsDisabled(false);
        expect(send).not.toHaveBeenCalled();
        settings.setSeasonalEffectsDisabled(true);
        expect(settings.getSeasonalEffectsDisabled()).toBe(true);
        expect(values.get('theme')).toBe('gsm-dark');
        expect(send).toHaveBeenCalledExactlyOnceWith('settings.seasonalEffectsChanged', true);
        expect(destroyedSend).not.toHaveBeenCalled();
    });
});
