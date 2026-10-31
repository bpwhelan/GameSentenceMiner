import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, unknown>();
const send = vi.fn();
const destroyedSend = vi.fn();
vi.mock('electron-store', () => ({
    default: class Store {
        constructor(options?: { defaults?: Record<string, unknown> }) {
            for (const [key, value] of Object.entries(options?.defaults ?? {})) values.set(key, value);
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
    beforeEach(() => { values.clear(); vi.resetModules(); });

    it('persists a theme change and updates open windows', async () => {
        const settings = await import('./store.js');
        settings.setTheme('solarized-light');
        expect(settings.getTheme()).toBe('solarized-light');
        expect(send).toHaveBeenCalledExactlyOnceWith('settings.themeChanged', 'solarized-light');
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
