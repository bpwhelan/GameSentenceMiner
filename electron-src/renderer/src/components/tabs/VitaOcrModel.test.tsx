// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { VitaOcrModel } from './VitaOcrModel';

describe('Vita OCR model selector', () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();
  const normal = { model: 'normal', available: true, busy: false, installed: ['normal'] };
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValue(normal);
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke } });
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
  async function render() {
    await act(async () => root.render(<I18nProvider><VitaOcrModel /></I18nProvider>));
    return container.querySelector('select')!;
  }
  it('shows the confirmed choice and waits for a checked download before enabling changes', async () => {
    const select = await render();
    expect(select.value).toBe('normal');
    expect(select.options).toHaveLength(3);
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => {
      select.value = 'large';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.disabled).toBe(true);
    expect(container.textContent).toContain('Downloading and checking');
    expect(invoke).toHaveBeenLastCalledWith('ocr.vita-model', { model: 'large' });
    await act(async () => finish({ ...normal, model: 'large' }));
    expect(select.value).toBe('large');
    expect(select.disabled).toBe(false);
    expect(container.querySelector('[role=status]')?.textContent).toContain('Large');
  });
  it('keeps the previous selection and explains a failed download', async () => {
    const select = await render();
    invoke.mockResolvedValueOnce({ ...normal, error: 'Download failed: offline' });
    await act(async () => {
      select.value = 'small';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('normal');
    expect(select.disabled).toBe(false);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('offline');
  });
  it('reflects changes made in the overlay settings', async () => {
    const select = await render();
    invoke.mockResolvedValue({ ...normal, model: 'small' });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(select.value).toBe('small');
  });
  it('ignores an old status response that arrives after a model switch', async () => {
    const select = await render();
    let finishRefresh!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    await act(async () => { vi.advanceTimersByTime(3000); });
    invoke.mockResolvedValueOnce({ ...normal, model: 'large' });
    await act(async () => {
      select.value = 'large';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => finishRefresh(normal));
    expect(select.value).toBe('large');
  });
  it('automatically prepares a missing runtime and offers a retry after a failed download', async () => {
    const missing = { ...normal, available: false, supported: true };
    invoke.mockResolvedValueOnce(missing).mockResolvedValueOnce({ ...missing, error: 'offline' });
    const select = await render();
    expect(invoke).toHaveBeenLastCalledWith('ocr.vita-model', { model: 'normal' });
    expect(container.querySelector('[role=alert]')?.textContent).toContain('offline');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(invoke.mock.calls.filter(call => call[1]?.model).length).toBe(1);
    invoke.mockResolvedValueOnce({ ...missing, error: 'offline' });
    await act(async () => { vi.advanceTimersByTime(3000); });
    invoke.mockResolvedValueOnce(normal);
    await act(async () => container.querySelector('button')!.click());
    expect(invoke).toHaveBeenLastCalledWith('ocr.vita-model', { model: 'normal' });
    expect(select.disabled).toBe(false);
  });
  it('does not attempt an installation on an unsupported platform', async () => {
    invoke.mockResolvedValue({ ...normal, available: false, supported: false, error: 'Not supported' });
    const select = await render();
    expect(select.disabled).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
