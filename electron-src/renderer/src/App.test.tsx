// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    INSTALL_STAGE_DEFINITIONS,
    type InstallSessionSnapshot,
    type InstallStageState,
} from '../../shared/install_session.js';
import type { DesktopUpdateChangelogSnapshot } from '../../shared/changelog.js';

const invokeMock = vi.fn();
const sendMock = vi.fn();
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

vi.mock('@xterm/addon-fit', () => ({
    FitAddon: class {
        fit() {}
    },
}));

vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        loadAddon() {}
        open() {}
        write() {}
        dispose() {}
        hasSelection() {
            return false;
        }
        getSelection() {
            return '';
        }
        select() {}
        attachCustomKeyEventHandler() {
            return true;
        }
    },
}));

vi.mock('./components/tabs/LauncherTab', () => ({
    LauncherTab: ({ active }: { active: boolean }) => (active ? <div>Launcher Tab</div> : null),
}));

vi.mock('./components/tabs/SettingsTab', () => ({
    SettingsTab: ({ active }: { active: boolean }) => (active ? <div>Settings Tab</div> : null),
}));

vi.mock('./components/tabs/OCRTab', () => ({
    OCRTab: ({ active }: { active: boolean }) => (active ? <div>OCR Tab</div> : null),
}));

vi.mock('./components/tabs/HomeTab', () => ({
    HomeTab: ({ active }: { active: boolean }) => (active ? <div>Home Tab</div> : null),
}));

vi.mock('./components/SetupWizard', () => ({
    SetupWizard: () => null,
}));

function createSnapshot(
    status: 'running' | 'failed' = 'running',
    origin: InstallSessionSnapshot['origin'] = 'startup'
): InstallSessionSnapshot {
    const stages: InstallStageState[] = INSTALL_STAGE_DEFINITIONS.map((definition) => ({
        id: definition.id,
        label: definition.label,
        weight: definition.weight,
        status: 'pending',
        progressKind: 'indeterminate',
        progress: null,
        message: '',
        downloadedBytes: null,
        totalBytes: null,
        startedAt: null,
        finishedAt: null,
        error: null,
    }));

    const ffmpegStage = stages.find((stage) => stage.id === 'ffmpeg');
    const finalizeStage = stages.find((stage) => stage.id === 'finalize');
    if (!ffmpegStage || !finalizeStage) {
        throw new Error('Missing expected install stages for test.');
    }

    ffmpegStage.status = status === 'failed' ? 'failed' : 'running';
    ffmpegStage.progressKind = 'bytes';
    ffmpegStage.progress = 0.5;
    ffmpegStage.message = status === 'failed' ? 'FFmpeg download failed.' : 'Downloading FFmpeg...';
    ffmpegStage.downloadedBytes = 2048;
    ffmpegStage.totalBytes = 4096;
    ffmpegStage.error = status === 'failed' ? 'Connection reset' : null;
    ffmpegStage.startedAt = 1;
    ffmpegStage.finishedAt = status === 'failed' ? 2 : null;

    finalizeStage.status = status === 'failed' ? 'pending' : 'running';
    finalizeStage.progressKind = 'estimated';
    finalizeStage.progress = status === 'failed' ? null : 0.2;
    finalizeStage.message = status === 'failed' ? '' : 'Final checks...';
    finalizeStage.startedAt = status === 'failed' ? null : 1;

    return {
        id: 'session-1',
        origin,
        status,
        startedAt: 1,
        finishedAt: status === 'failed' ? 2 : null,
        currentStageId: 'ffmpeg',
        overallProgress: 0.57,
        currentMessage: ffmpegStage.message,
        error: status === 'failed' ? 'Connection reset' : null,
        stages,
        logs: [
            {
                id: 'log-1',
                message: 'Downloading FFmpeg bundle...',
                createdAt: 1,
                stream: 'stdout',
            },
        ],
    };
}

function createChangelogSnapshot(
    status: DesktopUpdateChangelogSnapshot['status'] = 'ready'
): DesktopUpdateChangelogSnapshot {
    return {
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        status,
        source: 'bundled',
        title: "What's Changed in 1.0.1",
        markdown: [
            '# Heading from markdown',
            '',
            'A **bold** change with [a link](https://example.com).',
            '',
            '![Screenshot](1.0.1/shot.png)',
            '',
            '| Feature | Supported |',
            '| --- | --- |',
            '| Tables | Yes |',
            '',
            '<script>alert("x")</script>',
        ].join('\n'),
        assetBaseUrl: 'gsm-changelog://images/',
        error: null,
    };
}

describe('App install-session integration', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        listeners.clear();
        invokeMock.mockReset();
        sendMock.mockReset();

        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return createSnapshot('failed');
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return null;
            }
            if (channel === 'settings.getSettings') {
                return {};
            }
            if (
                channel === 'state.set' ||
                channel === 'logs.openFolder' ||
                channel === 'install-session.retry' ||
                channel === 'changelog.markDesktopUpdateSeen' ||
                channel === 'open-external'
            ) {
                return null;
            }
            return {};
        });

        Object.defineProperty(window, 'ipcRenderer', {
            configurable: true,
            value: {
                invoke: invokeMock,
                send: sendMock,
                on: (channel: string, callback: (...args: unknown[]) => void) => {
                    const callbacks = listeners.get(channel) ?? [];
                    callbacks.push(callback);
                    listeners.set(channel, callbacks);
                    return () => {
                        listeners.set(
                            channel,
                            (listeners.get(channel) ?? []).filter((entry) => entry !== callback)
                        );
                    };
                },
            },
        });

        Object.defineProperty(window, 'clipboard', {
            configurable: true,
            value: {
                writeText: vi.fn(),
                readText: vi.fn(() => ''),
            },
        });

        Object.defineProperty(window, 'gsmEnv', {
            configurable: true,
            value: {
                platform: 'win32',
            },
        });

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.unstubAllGlobals();
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    });

    it('loads the stats tab from the configured GSM single port', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetchMock);

        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return null;
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return null;
            }
            if (channel === 'settings.getSettings') {
                return {
                    hasCompletedSetup: true,
                    statsEndpoint: 'overview',
                    singlePort: 6123,
                };
            }
            if (channel === 'state.set') {
                return null;
            }
            return {};
        });

        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        const statsButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Stats'
        );
        expect(statsButton).toBeDefined();

        await act(async () => {
            statsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:6123/overview',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        expect(container.querySelector('iframe[title="stats"]')?.getAttribute('src')).toBe(
            'http://localhost:6123/overview'
        );
    });

    it('hides the Texthook / Agent tab on platforms without hooking (macOS)', async () => {
        Object.defineProperty(window, 'gsmEnv', {
            configurable: true,
            value: {
                platform: 'darwin',
            },
        });
        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return null;
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return null;
            }
            if (channel === 'settings.getSettings') {
                return { hasCompletedSetup: true };
            }
            if (channel === 'state.set') {
                return null;
            }
            return {};
        });

        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(
            Array.from(container.querySelectorAll('.tab-button')).map((button) => button.textContent)
        ).not.toContain('Texthook / Agent');

        await act(async () => {
            for (const callback of listeners.get('app.navigateToTab') ?? []) {
                callback({}, 'texthook');
            }
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(container.textContent).toContain('Home Tab');
        expect(container.textContent).not.toContain('Texthook / Agent');
    });

    it('shows the blocking install modal automatically for an active failed session', async () => {
        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(invokeMock).toHaveBeenCalledWith('install-session.getActive');
        expect(container.querySelector('.install-session-overlay')).not.toBeNull();
        expect(container.textContent).toContain('Installing GSM');
        expect(container.textContent).toContain('57%');
        expect(container.textContent).toContain('2.0 KB / 4.0 KB');
        expect(container.textContent).toContain('Retry');
        expect(container.textContent).toContain('Open Logs');
        expect(container.textContent).toContain('Quit');

        const retryButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Retry'
        );
        const openLogsButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Open Logs'
        );
        const quitButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Quit'
        );

        expect(retryButton).toBeDefined();
        expect(openLogsButton).toBeDefined();
        expect(quitButton).toBeDefined();

        retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        openLogsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        quitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(invokeMock).toHaveBeenCalledWith('install-session.retry');
        expect(invokeMock).toHaveBeenCalledWith('logs.openFolder');
        expect(sendMock).toHaveBeenCalledWith('app-close');
    });

    it('does not show the install modal after setup has already completed', async () => {
        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return createSnapshot('failed', 'startup');
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return null;
            }
            if (channel === 'settings.getSettings') {
                return { hasCompletedSetup: true };
            }
            if (
                channel === 'state.set' ||
                channel === 'logs.openFolder' ||
                channel === 'install-session.retry' ||
                channel === 'changelog.markDesktopUpdateSeen' ||
                channel === 'open-external'
            ) {
                return null;
            }
            return {};
        });

        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(container.querySelector('.install-session-overlay')).toBeNull();
    });

    it('does not show the install modal for backend update sessions', async () => {
        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return createSnapshot('running', 'backend_update');
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return null;
            }
            if (channel === 'settings.getSettings') {
                return { hasCompletedSetup: false };
            }
            if (
                channel === 'state.set' ||
                channel === 'logs.openFolder' ||
                channel === 'install-session.retry' ||
                channel === 'changelog.markDesktopUpdateSeen' ||
                channel === 'open-external'
            ) {
                return null;
            }
            return {};
        });

        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(container.querySelector('.install-session-overlay')).toBeNull();
    });

    it('shows the whats changed dialog for a pending desktop update changelog', async () => {
        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return createSnapshot('running', 'backend_update');
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return createChangelogSnapshot();
            }
            if (channel === 'settings.getSettings') {
                return { hasCompletedSetup: true };
            }
            if (
                channel === 'state.set' ||
                channel === 'logs.openFolder' ||
                channel === 'install-session.retry' ||
                channel === 'changelog.markDesktopUpdateSeen' ||
                channel === 'open-external'
            ) {
                return { success: true };
            }
            return {};
        });

        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(container.querySelector('.install-session-overlay')).toBeNull();
        expect(container.querySelector('.whats-changed-overlay')).not.toBeNull();
        expect(container.textContent).toContain("What's Changed in 1.0.1");
        expect(container.textContent).toContain('A bold change with');
        expect(container.querySelector('table')).not.toBeNull();
        expect(container.querySelector('script')).toBeNull();
        expect(container.querySelector('img')?.getAttribute('src')).toBe(
            'gsm-changelog://images/1.0.1/shot.png'
        );
        const markdownLink = container.querySelector('.whats-changed-body a');
        expect(markdownLink?.getAttribute('href')).toBe('https://example.com');
        markdownLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(invokeMock).toHaveBeenCalledWith('open-external', 'https://example.com');

        const continueButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Syncing backend...'
        );
        expect(continueButton).toBeDefined();
        expect(continueButton?.hasAttribute('disabled')).toBe(true);
    });

    it('enables continue after the backend update session completes', async () => {
        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return createSnapshot('running', 'backend_update');
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return createChangelogSnapshot();
            }
            if (channel === 'changelog.markDesktopUpdateSeen') {
                return { success: true };
            }
            if (channel === 'settings.getSettings') {
                return { hasCompletedSetup: true };
            }
            if (
                channel === 'state.set' ||
                channel === 'logs.openFolder' ||
                channel === 'install-session.retry' ||
                channel === 'open-external'
            ) {
                return null;
            }
            return {};
        });

        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        const completed = createSnapshot('running', 'backend_update');
        completed.status = 'completed';
        completed.overallProgress = 1;
        completed.currentMessage = 'Backend update complete.';
        completed.finishedAt = 2;

        await act(async () => {
            for (const callback of listeners.get('install-session.finished') ?? []) {
                callback({}, completed);
            }
            await Promise.resolve();
        });

        const continueButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Continue'
        );
        expect(continueButton).toBeDefined();
        expect(continueButton?.hasAttribute('disabled')).toBe(false);

        await act(async () => {
            continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await Promise.resolve();
        });

        expect(invokeMock).toHaveBeenCalledWith('changelog.markDesktopUpdateSeen', '1.0.1');
        expect(container.querySelector('.whats-changed-overlay')).toBeNull();
    });

    it('keeps failed desktop update changelog sessions actionable', async () => {
        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return createSnapshot('running', 'backend_update');
            }
            if (channel === 'changelog.getPendingDesktopUpdate') {
                return createChangelogSnapshot();
            }
            if (channel === 'settings.getSettings') {
                return { hasCompletedSetup: true };
            }
            if (
                channel === 'state.set' ||
                channel === 'logs.openFolder' ||
                channel === 'install-session.retry' ||
                channel === 'changelog.markDesktopUpdateSeen' ||
                channel === 'open-external'
            ) {
                return { success: true };
            }
            return {};
        });

        const { default: App } = await import('./App.js');

        await act(async () => {
            root.render(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });

        const failed = createSnapshot('failed', 'backend_update');
        await act(async () => {
            for (const callback of listeners.get('install-session.finished') ?? []) {
                callback({}, failed);
            }
            await Promise.resolve();
        });

        const retryButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Retry'
        );
        const openLogsButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Open Logs'
        );
        const quitButton = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Quit'
        );

        expect(container.textContent).toContain('Backend sync failed.');
        expect(retryButton).toBeDefined();
        expect(openLogsButton).toBeDefined();
        expect(quitButton).toBeDefined();

        retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        openLogsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        quitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(invokeMock).toHaveBeenCalledWith('install-session.retry');
        expect(invokeMock).toHaveBeenCalledWith('logs.openFolder');
        expect(sendMock).toHaveBeenCalledWith('app-close');
        expect(invokeMock).not.toHaveBeenCalledWith('changelog.markDesktopUpdateSeen', '1.0.1');
    });
});
