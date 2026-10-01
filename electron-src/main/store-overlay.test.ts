import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, unknown>();
vi.mock('electron-store', () => ({
    default: class Store {
        constructor(options?: { defaults?: Record<string, unknown> }) {
            for (const [key, value] of Object.entries(options?.defaults ?? {})) values.set(key, value);
        }
        get(key: string, fallback?: unknown) { return values.get(key) ?? fallback; }
        set(key: string | Record<string, unknown>, value?: unknown) {
            if (typeof key === 'string') values.set(key, value);
            else for (const [name, setting] of Object.entries(key)) values.set(name, setting);
        }
    },
}));
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('./data_dir.js', () => ({ getBaseDir: () => 'C:/test-gsm' }));
vi.mock('./agent_script_resolver.js', () => ({ findAgentScriptById: vi.fn() }));

describe('overlay automation settings', () => {
    beforeEach(() => { values.clear(); vi.resetModules(); });

    it('keeps global startup and active-game options mutually exclusive in storage', async () => {
        const settings = await import('./store.js');
        expect(settings.getRunOverlayWithActiveGame()).toBe(false);
        settings.setRunOverlayOnStartup(true);
        expect(settings.getRunOverlayOnStartup()).toBe(true);
        settings.setRunOverlayWithActiveGame(true);
        expect(settings.getRunOverlayOnStartup()).toBe(false);
        expect(values.get('runOverlayOnStartup')).toBe(false);
        settings.setRunOverlayOnStartup(true);
        expect(settings.getRunOverlayWithActiveGame()).toBe(false);
        expect(values.get('runOverlayWithActiveGame')).toBe(false);
        settings.setRunOverlayOnStartup(false);
        expect(settings.getRunOverlayOnStartup()).toBe(false);
        expect(settings.getRunOverlayWithActiveGame()).toBe(false);
    });

    it('gives active-game mode precedence in an imported conflicting config', async () => {
        const settings = await import('./store.js');
        values.set('runOverlayOnStartup', true);
        values.set('runOverlayWithActiveGame', true);
        expect(settings.getRunOverlayOnStartup()).toBe(false);
    });
});
