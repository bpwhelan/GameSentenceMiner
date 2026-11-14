// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { normalizeNotificationPreferences } from '../../../../shared/notifications';
import { NotificationSettings } from './NotificationSettings';

const invoke = vi.fn();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, value: unknown) => channel === 'settings.notifications.get'
    ? { preferences: normalizeNotificationPreferences(null), features: { notify_on_update: false } } : value);
  Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

async function render() { await act(async () => root.render(<I18nProvider><NotificationSettings active /></I18nProvider>)); }
function select(id: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`#${id}`)!;
  element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('notification settings', () => {
  it('shows quiet defaults and one global notification configuration without Python switches', async () => {
    await render();
    expect(container.querySelectorAll('.notification-event')).toHaveLength(4);
    expect(container.querySelector<HTMLSelectElement>('#notification-mode-confirmation')?.value).toBe('sound');
    expect(container.querySelectorAll('#notification-sound-confirmation option')).toHaveLength(13);
    expect(container.textContent).toContain('Applies to every game and profile');
    expect(container.textContent).not.toContain('Open profile notification switches');
    expect(container.textContent).not.toContain('disabled in the current profile');
    expect(container.textContent).toContain('Card errors');
    expect(container.textContent).toContain('Unvoiced cards are normal');
    expect(container.textContent).not.toContain('settings.notifications.');
  });

  it('saves per-event settings in order and previews the selected sound at the chosen volume', async () => {
    await render();
    await act(async () => { select('notification-mode-confirmation', 'both'); select('notification-sound-confirmation', 'chime'); });
    const saves = invoke.mock.calls.filter(([channel]) => channel === 'settings.notifications.save');
    expect(saves).toHaveLength(2);
    expect(saves[1][1].categories.confirmation).toEqual({ mode: 'both', sound: 'chime' });
    expect(invoke).toHaveBeenCalledWith('settings.notifications.preview', { sound: 'chime', volume: 15 });
    const preview = container.querySelector<HTMLButtonElement>('[aria-label="Preview Confirmations"]')!;
    await act(async () => preview.click());
    expect(invoke).toHaveBeenCalledWith('settings.notifications.preview', { sound: 'chime', volume: 15 });
    expect(invoke.mock.calls.some(([channel]) => channel === 'settings.saveSettings')).toBe(false);
  });

  it('keeps the latest edit after a failed save and lets the user retry', async () => {
    await render();
    const fallback = invoke.getMockImplementation()!;
    let failSave = true;
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'settings.notifications.save' && failSave) {
        failSave = false;
        return Promise.reject(new Error('disk full'));
      }
      return fallback(channel, ...args);
    });
    await act(async () => select('notification-sound-confirmation', 'glass'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
    expect(container.querySelector<HTMLSelectElement>('#notification-sound-confirmation')?.value).toBe('glass');
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].categories.confirmation.sound).toBe('glass');
  });

  it('previews a new selection immediately without waiting for its save', async () => {
    await render();
    const fallback = invoke.getMockImplementation()!;
    let finishSave!: () => void;
    invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'settings.notifications.save'
      ? new Promise<void>((resolve) => { finishSave = resolve; }) : fallback(channel, ...args));
    await act(async () => select('notification-sound-pauseResume', 'marimba'));
    expect(invoke).toHaveBeenCalledWith('settings.notifications.preview', { sound: 'marimba', volume: 15 });
    await act(async () => finishSave());
  });

  it('disables sound controls for banner-only and off events', async () => {
    await render();
    await act(async () => select('notification-mode-confirmation', 'banner'));
    expect(container.querySelector<HTMLSelectElement>('#notification-sound-confirmation')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Preview Confirmations"]')?.disabled).toBe(true);
  });
});
