// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MeikiOcrModel } from './MeikiOcrModel';

describe('Meiki OCR model selector', () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();
  const normal = { model: 'large', available: true, busy: false, installed: ['large'] };
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
    await act(async () => root.render(<I18nProvider><MeikiOcrModel /></I18nProvider>));
    return container.querySelector('select')!;
  }
  it('shows the confirmed choice and waits for a checked download before enabling changes', async () => {
    const select = await render();
    expect(select.value).toBe('large');
    expect(select.options).toHaveLength(2);
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => {
      select.value = 'small';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.disabled).toBe(true);
    expect(container.textContent).toContain('Downloading and checking');
    expect(invoke).toHaveBeenLastCalledWith('ocr.meiki-model', { model: 'small' });
    await act(async () => finish({ ...normal, model: 'small' }));
    expect(select.value).toBe('small');
    expect(select.disabled).toBe(false);
    expect(container.querySelector('[role=status]')?.textContent).toContain('Small');
  });
  it('keeps the previous selection and explains a failed download', async () => {
    const select = await render();
    invoke.mockResolvedValueOnce({ ...normal, error: 'Download failed: offline' });
    await act(async () => {
      select.value = 'small';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('large');
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
    invoke.mockResolvedValueOnce({ ...normal, model: 'small' });
    await act(async () => {
      select.value = 'small';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => finishRefresh(normal));
    expect(select.value).toBe('small');
  });
});
