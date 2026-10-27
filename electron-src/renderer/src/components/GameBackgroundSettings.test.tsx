// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeGameBackgroundOptions } from '../../../shared/game_background';
import { I18nProvider } from '../i18n';
import { GameBackgroundSettings } from './GameBackgroundSettings';

describe('GameBackgroundSettings', () => {
    let container: HTMLDivElement;
    let root: Root;
    const invoke = vi.fn();
    let state: any;
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        state = { sceneId: 'scene', phase: 'disabled', target: { pid: 1, hwnd: '2', path: 'C:\\game.exe', title: 'Game' },
            options: normalizeGameBackgroundOptions(undefined) };
        invoke.mockReset();
        invoke.mockImplementation(async (channel, payload) => {
            if (channel === 'game-background.getState') return state;
            if (channel === 'game-background.save') { state = { ...state, options: normalizeGameBackgroundOptions(payload.options) }; return state; }
            return undefined;
        });
        Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke, on: () => () => {} } });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    });
    async function render() {
        await act(async () => { root.render(<I18nProvider><GameBackgroundSettings sceneId="scene" active /></I18nProvider>); });
    }
    it('saves explicit opt-in with the displayed game identity and keeps separate toggles', async () => {
        await render();
        const controls = container.querySelectorAll('input');
        expect(controls[0].checked).toBe(false);
        expect(controls[1].checked).toBe(false);
        expect(controls[1].matches(':disabled')).toBe(true);
        expect(controls[2].matches(':disabled')).toBe(true);
        await act(async () => controls[0].click());
        expect(controls[1].matches(':disabled')).toBe(false);
        expect(controls[2].matches(':disabled')).toBe(false);
        expect(invoke).toHaveBeenCalledWith('game-background.save', {
            sceneId: 'scene', target: state.target, options: { enabled: true, keepRendering: false, blockGamepad: true },
        });
        await act(async () => controls[1].click());
        expect(invoke).toHaveBeenLastCalledWith('game-background.save', expect.objectContaining({
            options: { enabled: true, keepRendering: true, blockGamepad: true },
        }));
        await act(async () => controls[0].click());
        expect(controls[1].matches(':disabled')).toBe(true);
        await act(async () => controls[0].click());
        expect(controls[1].checked).toBe(true);
        expect(controls[2].checked).toBe(true);
    });
    it('can re-enable the hook after both sub-options have been turned off', async () => {
        state.options.keepRendering = true;
        await render();
        const controls = container.querySelectorAll('input');
        await act(async () => controls[0].click());
        await act(async () => controls[1].click());
        await act(async () => controls[2].click());
        expect(controls[0].checked).toBe(false);
        expect(controls[1].matches(':disabled')).toBe(true);
        await act(async () => controls[0].click());
        expect(controls[0].checked).toBe(true);
        expect(controls[1].matches(':disabled')).toBe(false);
        expect(controls[1].checked).toBe(false);
        expect(controls[2].checked).toBe(true);
    });
    it('disables changes when the displayed OBS scene is not the resolved scene', async () => {
        state.sceneId = 'old-scene';
        await render();
        expect(container.querySelector('fieldset')?.disabled).toBe(true);
        expect(container.textContent).toContain('Waiting for the captured game');
    });
    it('explains a Special K conflict', async () => {
        state.phase = 'blocked'; state.reason = 'specialK';
        await render();
        expect(container.textContent).toContain('Special K is loaded');
    });
});
