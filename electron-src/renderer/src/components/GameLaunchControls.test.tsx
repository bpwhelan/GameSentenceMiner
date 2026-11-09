// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameLaunchControls } from './GameLaunchControls';
import { normalizeGameLaunchOptions } from '../../../shared/game_launcher';

const invoke = vi.fn();
const game = 'C:\\Games\\月姫\\game.exe';
async function flush() { for (let i = 0; i < 10; ++i) await Promise.resolve(); }

describe('GameLaunchControls', () => {
    let container: HTMLDivElement;
    let root: Root;
    const button = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!;
    const edit = async (id: string, value: string) => {
        await act(async () => {
            const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await flush();
        });
    };

    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers();
        invoke.mockReset().mockImplementation(async (channel: string) => {
            if (channel === 'game-launcher.getOptions') return normalizeGameLaunchOptions({ executablePath: game });
            return { success: true };
        });
        Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke } });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.useRealTimers();
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    });

    async function render(sceneId = 'scene-a') {
        await act(async () => { root.render(<GameLaunchControls key={sceneId} sceneId={sceneId} active />); await flush(); });
    }
    async function click(text: string) { await act(async () => { button(text).click(); await flush(); }); }

    it('launches the selected scene and keeps options collapsed initially', async () => {
        await render();
        expect(container.querySelector('#game-launch-executable')).toBeNull();
        await click('Launch game');
        expect(invoke).toHaveBeenCalledWith('game-launcher.launch', 'scene-a');
        expect(container.textContent).toContain('Launch request sent.');
    });

    it('opens the path options when no executable has been found', async () => {
        invoke.mockImplementation(async () => normalizeGameLaunchOptions(null));
        await render();
        await click('Launch game');
        expect(container.querySelector('#game-launch-executable')).toBe(document.activeElement);
        expect(invoke).not.toHaveBeenCalledWith('game-launcher.launch', 'scene-a');
    });

    it('preserves unsaved edits during polling and saves them before launching', async () => {
        await render();
        await click('Launch options');
        await edit('game-launch-arguments', '--windowed "save slot 1"');
        await act(async () => { vi.advanceTimersByTime(5000); await flush(); });
        expect(container.querySelector<HTMLInputElement>('#game-launch-arguments')!.value).toBe('--windowed "save slot 1"');
        await click('Launch game');
        const saved = invoke.mock.calls.find(call => call[0] === 'game-launcher.save');
        expect(saved).toEqual(['game-launcher.save', 'scene-a', expect.objectContaining({ executablePath: game, arguments: '--windowed "save slot 1"' })]);
        expect(invoke.mock.calls.findIndex(call => call[0] === 'game-launcher.save')).toBeLessThan(invoke.mock.calls.findIndex(call => call[0] === 'game-launcher.launch'));
    });

    it('does not launch if saving options fails, and lets the user fix the draft', async () => {
        const original = invoke.getMockImplementation()!;
        invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'game-launcher.save'
            ? { success: false, code: 'missingLauncher' } : original(channel, ...args));
        await render();
        await click('Launch options');
        await edit('game-launch-launcher', 'D:\\Missing\\SKIF.exe');
        await click('Launch game');
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('Choose an existing launcher executable.');
        expect(invoke).not.toHaveBeenCalledWith('game-launcher.launch', 'scene-a');
        expect(container.querySelector<HTMLInputElement>('#game-launch-launcher')!.value).toBe('D:\\Missing\\SKIF.exe');
    });

    it('applies a browsed executable only when the picker returns a path', async () => {
        const original = invoke.getMockImplementation()!;
        invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'game-launcher.browse' ? null : original(channel, ...args));
        await render();
        await click('Launch options');
        const browse = container.querySelector<HTMLButtonElement>('[data-browse="executablePath"]')!;
        await act(async () => { browse.click(); await flush(); });
        expect(container.querySelector<HTMLInputElement>('#game-launch-executable')!.value).toBe(game);
        invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'game-launcher.browse' ? 'D:\\New Game\\game.exe' : original(channel, ...args));
        await act(async () => { browse.click(); await flush(); });
        await click('Save');
        expect(invoke).toHaveBeenCalledWith('game-launcher.save', 'scene-a', expect.objectContaining({ executablePath: 'D:\\New Game\\game.exe' }));
    });

    it('discards the previous scene draft and ignores its late save response', async () => {
        let finish!: (result: unknown) => void;
        const original = invoke.getMockImplementation()!;
        invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'game-launcher.save'
            ? new Promise(resolve => { finish = resolve; }) : original(channel, ...args));
        await render();
        await click('Launch options');
        await edit('game-launch-arguments', '--old');
        await click('Launch game');
        await render('scene-b');
        await act(async () => { finish({ success: true }); await flush(); });
        expect(invoke).not.toHaveBeenCalledWith('game-launcher.launch', 'scene-a');
        await click('Launch options');
        expect(container.querySelector<HTMLInputElement>('#game-launch-arguments')!.value).toBe('');
        await click('Launch game');
        expect(invoke).toHaveBeenCalledWith('game-launcher.launch', 'scene-b');
    });
});
