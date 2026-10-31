// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { GpuSettings } from './GpuSettings';

describe('GPU settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();
  const listeners = new Map<string, (...args: any[]) => void>();
  const status = {
    settings: { meiki: false, firered: false, whisper: false },
    diagnostics: { driver: { available: true, name: 'RTX 5070' }, libraries: {
      cublas: { available: false }, cublasLt: { available: false }, cudart: { available: false },
      cufft: { available: false }, cudnn: { available: false },
    }, onnx: { available: false }, whisper: { available: true } },
    runtime: { meiki: [], firered: [], whisper: [] },
    availability: { meiki: 'cuda', firered: 'cuda', whisper: 'cuda' },
  };
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    listeners.clear();
    invoke.mockReset().mockResolvedValue(status);
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: {
      invoke,
      on: (channel: string, listener: (...args: any[]) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });
  async function render(active = true) {
    await act(async () => root.render(<I18nProvider><GpuSettings active={active} /></I18nProvider>));
  }
  it('checks support without installing packages and keeps system installation first', async () => {
    await render();
    expect(container.querySelectorAll('[role=switch]')).toHaveLength(3);
    expect(container.textContent).toContain('RTX 5070');
    expect(invoke.mock.calls.every(([channel]) => channel === 'settings.gpu')).toBe(true);
    const install = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Install / repair ONNX'))!;
    expect(install.disabled).toBe(true);
  });
  it('shows requested GPU use separately from actual CPU fallback', async () => {
    await render();
    invoke.mockResolvedValueOnce({ ...status, settings: { ...status.settings, meiki: true },
      runtime: { ...status.runtime, meiki: [{ pid: 1, enabled: true, device: 'cpu', error: 'CUDA initialization failed' }] } });
    await act(async () => container.querySelector<HTMLInputElement>('#gpu-meiki')!.click());
    expect(invoke).toHaveBeenLastCalledWith('settings.gpu', { settings: { meiki: true } });
    const engine = container.querySelector('#gpu-meiki')!.closest('.gpu-engine')!;
    expect(engine.textContent).toContain('Enabled');
    expect(engine.textContent).toContain('Loaded on CPU');
    expect(engine.textContent).toContain('CUDA initialization failed');
  });
  it('preserves the saved choice if a change fails and ignores a late refresh', async () => {
    await render();
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { vi.advanceTimersByTime(5000); });
    invoke.mockResolvedValueOnce({ ...status, settings: { ...status.settings, whisper: true } });
    await act(async () => container.querySelector<HTMLInputElement>('#gpu-whisper')!.click());
    await act(async () => finish(status));
    expect(container.querySelector<HTMLInputElement>('#gpu-whisper')!.checked).toBe(true);
    invoke.mockRejectedValueOnce(new Error('could not save'));
    await act(async () => container.querySelector<HTMLInputElement>('#gpu-whisper')!.click());
    expect(container.querySelector<HTMLInputElement>('#gpu-whisper')!.checked).toBe(true);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('could not save');
  });
  it('does not probe CUDA while the page is hidden', async () => {
    await render(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('shows package and restart stages and releases the controls after completion', async () => {
    await render();
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const restore = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Use CPU ONNX Runtime')!;
    await act(async () => restore.click());
    expect(restore.disabled).toBe(true);
    await act(async () => listeners.get('settings-gpu-install-progress')?.({}, { phase: 'installing' }));
    expect(container.textContent).toContain('Downloading and checking');
    await act(async () => listeners.get('settings-gpu-install-progress')?.({}, { phase: 'starting' }));
    expect(container.textContent).toContain('Waiting for GSM to reconnect');
    await act(async () => finish({ success: true, message: 'Done' }));
    expect(restore.disabled).toBe(false);
    expect(container.textContent).not.toContain('Applying changes');
    expect(container.textContent).not.toContain('Waiting for GSM to reconnect');
  });
  it('clears a transient backend connection error once the backend returns', async () => {
    invoke.mockRejectedValueOnce(new Error('backend is not connected'));
    await render();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('not connected');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(container.querySelector('[role=alert]')).toBeNull();
  });
});
