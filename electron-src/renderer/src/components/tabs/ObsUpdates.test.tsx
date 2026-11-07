// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ObsUpdates } from './ObsUpdates';
import type { ObsRuntimeStatus } from '../../../../shared/obs_runtime';

describe('OBS update controls', () => {
  let root: Root, container: HTMLDivElement;
  const invoke = vi.fn();
  let status: ObsRuntimeStatus;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    status = { supported: true, managed: true, automatic: false, pinnedVersion: null, installedVersion: '32.2.2',
      targetVersion: null, rollbackVersion: null, updateAvailable: false, checkedAt: null, phase: 'idle', progress: null, error: null };
    invoke.mockReset(); invoke.mockImplementation(async () => status);
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke, on: () => () => {} } });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
  const render = () => act(async () => root.render(<I18nProvider><ObsUpdates active /></I18nProvider>));
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)!;

  it('opens without checking upstream or enabling automatic updates', async () => {
    await render();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('obs.runtime.status');
    expect(container.querySelector<HTMLInputElement>('#auto-update-obs')!.checked).toBe(false);
    expect(container.textContent).toContain('32.2.2');
  });
  it('checks and updates manually, then offers the previous installation', async () => {
    await render();
    status = { ...status, targetVersion: '33.0.1', updateAvailable: true, checkedAt: 'now' };
    await act(async () => button('Check for Updates').click());
    expect(invoke).toHaveBeenCalledWith('obs.runtime.check');
    status = { ...status, installedVersion: '33.0.1', updateAvailable: false, rollbackVersion: '32.2.2' };
    await act(async () => button('Update to 33.0.1').click());
    expect(invoke).toHaveBeenCalledWith('obs.runtime.update');
    expect(button('Restore OBS 32.2.2')).toBeDefined();
  });
  it('enables automatic mode only through an explicit setting change', async () => {
    await render();
    await act(async () => container.querySelector<HTMLInputElement>('#auto-update-obs')!.click());
    expect(invoke).toHaveBeenCalledWith('obs.runtime.setAutomatic', true);
    expect(invoke).not.toHaveBeenCalledWith('obs.runtime.update');
  });
  it('shows an update failure and leaves manual retry available', async () => {
    await render();
    invoke.mockRejectedValueOnce(new Error('OBS is recording'));
    await act(async () => button('Update OBS').click());
    expect(container.querySelector('[role=alert]')?.textContent).toContain('OBS is recording');
    expect(button('Update OBS').disabled).toBe(false);
  });
  it('does not offer managed updates for a custom OBS installation', async () => {
    status.managed = false; await render();
    expect(container.textContent).toContain('custom OBS');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
