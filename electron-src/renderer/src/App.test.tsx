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
            if (channel === 'settings.getSettings') {
                return {};
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
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
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

        expect(container.querySelector('.install-session-overlay')).toBeNull();
    });

    it('does not show the install modal for backend update sessions', async () => {
        invokeMock.mockImplementation(async (channel: string) => {
            if (channel === 'install-session.getActive') {
                return createSnapshot('running', 'backend_update');
            }
            if (channel === 'settings.getSettings') {
                return { hasCompletedSetup: false };
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

        expect(container.querySelector('.install-session-overlay')).toBeNull();
    });
});
