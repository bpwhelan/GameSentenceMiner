// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GamePrivilegeNotice } from './GamePrivilegeNotice';
import { GAME_PRIVILEGE_WARNING_CHANNEL } from '../../../shared/game_privileges';
import { I18nProvider } from '../i18n';

const warning = { id: '123:session-1', pid: 123, exeName: 'game.exe' };

describe('GamePrivilegeNotice', () => {
  let container: HTMLDivElement;
  let root: Root;
  let invoke: ReturnType<typeof vi.fn>;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const button = (label: string) => [...container.querySelectorAll('button')].find(value => value.textContent === label)!;
  const emit = async (value: unknown) => act(async () => { listeners.get(GAME_PRIVILEGE_WARNING_CHANNEL)?.({}, value); });

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    listeners.clear();
    invoke = vi.fn(async (channel: string) => channel === 'game-privileges.getWarning' ? warning : undefined);
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: {
      invoke,
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('explains the possible effects and restarts only when explicitly clicked', async () => {
    await act(async () => root.render(<GamePrivilegeNotice />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('game.exe is running as administrator');
    expect(container.textContent).toContain('may interfere with OBS capture, text hooking, the overlay, or hotkeys');
    expect(invoke).not.toHaveBeenCalledWith('game-privileges.restartAsAdmin', warning.id);
    await act(async () => button('Restart GSM as administrator').click());
    expect(invoke).toHaveBeenCalledWith('game-privileges.restartAsAdmin', warning.id);
  });

  it('dismisses only the displayed session and hides when the backend clears the warning', async () => {
    await act(async () => root.render(<GamePrivilegeNotice />));
    await act(async () => button('Dismiss for this game session').click());
    expect(invoke).toHaveBeenCalledWith('game-privileges.dismiss', warning.id);
    await emit(null);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('ignores stale startup responses after a live warning arrives', async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await act(async () => root.render(<GamePrivilegeNotice />));
    await emit(warning);
    await act(async () => resolve(null));
    expect(container.textContent).toContain('game.exe');
  });

  it('disables actions while restarting and permits retry after failure', async () => {
    await act(async () => root.render(<GamePrivilegeNotice />));
    let reject!: (error: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
    await act(async () => button('Restart GSM as administrator').click());
    expect(button('Restarting…').disabled).toBe(true);
    expect(button('Dismiss for this game session').disabled).toBe(true);
    await act(async () => reject(new Error('Failed')));
    expect(container.textContent).toContain('Could not restart GSM.');
    expect(button('Restart GSM as administrator').disabled).toBe(false);
  });

  it.each(['ja', 'ukr', 'zh', 'ko', 'es'])('localizes the warning and buttons in %s', async locale => {
    await act(async () => root.render(<I18nProvider initialLocale={locale}><GamePrivilegeNotice /></I18nProvider>));
    expect(container.textContent).toContain('game.exe');
    expect(container.textContent).not.toContain('gamePrivileges.');
    expect(container.textContent).not.toContain('is running as administrator');
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });
});
