import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronHarness = vi.hoisted(() => ({
    instances: [] as any[],
    openExternal: vi.fn(),
}));

vi.mock('electron', () => {
    class BrowserWindow {
        readonly options: Record<string, unknown>;
        readonly events = new Map<string, (...args: any[]) => void>();
        minimized = false;
        destroyed = false;
        currentUrl = '';
        openHandler: ((details: { url: string }) => { action: string }) | null =
            null;
        navigationHandler:
            | ((event: { preventDefault: () => void }, url: string) => void)
            | null = null;
        loadFile = vi.fn(async (filePath: string) => {
            this.currentUrl = `file://${filePath}`;
        });
        loadURL = vi.fn(async (url: string) => {
            this.currentUrl = url;
        });
        removeMenu = vi.fn();
        restore = vi.fn(() => {
            this.minimized = false;
        });
        show = vi.fn();
        focus = vi.fn();
        setAlwaysOnTop = vi.fn();
        setVisibleOnAllWorkspaces = vi.fn();
        webContents = {
            getURL: () => this.currentUrl,
            on: vi.fn(
                (
                    event: string,
                    listener: (
                        event: { preventDefault: () => void },
                        url: string
                    ) => void
                ) => {
                    if (event === 'will-navigate') {
                        this.navigationHandler = listener;
                    }
                }
            ),
            setWindowOpenHandler: vi.fn(
                (
                    handler: (details: { url: string }) => {
                        action: string;
                    }
                ) => {
                    this.openHandler = handler;
                }
            ),
        };

        constructor(options: Record<string, unknown>) {
            this.options = options;
            electronHarness.instances.push(this);
        }

        isDestroyed() {
            return this.destroyed;
        }

        isMinimized() {
            return this.minimized;
        }

        on(event: string, listener: (...args: any[]) => void) {
            this.events.set(event, listener);
        }

        once(event: string, listener: (...args: any[]) => void) {
            this.events.set(event, listener);
        }

        emit(event: string, ...args: any[]) {
            this.events.get(event)?.(...args);
        }
    }

    return {
        BrowserWindow,
        shell: {
            openExternal: electronHarness.openExternal,
        },
    };
});

vi.mock('../../util.js', () => ({
    getRendererEntryPath: () => 'renderer.html',
    getSecureWebPreferences: () => ({
        contextIsolation: true,
        nodeIntegration: false,
    }),
}));

describe('Hoshidicts settings window', () => {
    beforeEach(() => {
        vi.resetModules();
        electronHarness.instances.length = 0;
        electronHarness.openExternal.mockReset();
        delete process.env.VITE_DEV_SERVER_URL;
    });

    it('creates one topmost standalone window and reuses it safely', async () => {
        const {
            getHoshidictsSettingsWindow,
            openHoshidictsSettingsWindow,
        } = await import('./window.js');

        const first = (await openHoshidictsSettingsWindow()) as any;

        expect(electronHarness.instances).toHaveLength(1);
        expect(first.options).toMatchObject({
            width: 1040,
            height: 820,
            minWidth: 760,
            minHeight: 600,
            alwaysOnTop: true,
            show: false,
        });
        expect(first.options.webPreferences).toEqual({
            contextIsolation: true,
            nodeIntegration: false,
        });
        expect(first.loadFile).toHaveBeenCalledWith('renderer.html', {
            query: { window: 'hoshidicts-settings' },
        });
        expect(first.setAlwaysOnTop).toHaveBeenCalledWith(
            true,
            'screen-saver'
        );
        expect(first.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
            visibleOnFullScreen: true,
        });

        first.emit('ready-to-show');
        expect(first.show).toHaveBeenCalledOnce();

        first.minimized = true;
        const second = await openHoshidictsSettingsWindow();
        expect(second).toBe(first);
        expect(electronHarness.instances).toHaveLength(1);
        expect(first.restore).toHaveBeenCalledOnce();
        expect(first.focus).toHaveBeenCalledOnce();

        expect(first.openHandler?.({ url: 'https://example.test' })).toEqual({
            action: 'deny',
        });
        expect(electronHarness.openExternal).toHaveBeenCalledWith(
            'https://example.test'
        );

        const preventDefault = vi.fn();
        first.navigationHandler?.(
            { preventDefault },
            'https://example.test/docs'
        );
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(electronHarness.openExternal).toHaveBeenCalledWith(
            'https://example.test/docs'
        );

        first.destroyed = true;
        first.emit('closed');
        expect(getHoshidictsSettingsWindow()).toBeNull();
    });
});
