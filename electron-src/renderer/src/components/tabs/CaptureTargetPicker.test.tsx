// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptureTargetPicker } from './CaptureTargetPicker';
import type { ObsWindow } from '../../types/models';

const invoke = vi.fn();
const select = vi.fn();
const refresh = vi.fn(async () => {});
const windows: ObsWindow[] = [
  { title: 'Zulu Game', suggestedSceneName: 'Zulu', value: 'z', targetKind: 'window', lastFocusedAt: 200 },
  { title: 'Alpha Game', value: 'a', targetKind: 'window' },
  { title: 'Display 1', value: 'm', targetKind: 'monitor' },
  { title: 'Capture Card', value: 'c', targetKind: 'capture_card' },
];
let container: HTMLDivElement;
let root: Root;
const render = async (overrides = {}) => act(async () => {
  root.render(<CaptureTargetPicker windows={windows} selectedValue="" disabled={false} loading={false}
    supported previewsEnabled onSelect={select} onRefresh={refresh} {...overrides} />);
});
const search = async (value: string) => act(async () => {
  const input = container.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockReset().mockResolvedValue([]);
  select.mockClear();
  refresh.mockClear();
  Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

it('keeps recent order, groups devices, and filters without choosing a game', async () => {
  await render();
  expect(Array.from(container.querySelectorAll('[data-window-value]')).map(el => el.getAttribute('data-window-value')))
    .toEqual(['z', 'a', 'm', 'c']);
  expect(container.textContent).toContain('Recently focused first');
  await search('  aLpHa ');
  expect(container.querySelectorAll('[data-window-value]')).toHaveLength(1);
  expect(select).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-window-value="a"]')!.click());
  expect(select).toHaveBeenCalledWith('a');
  await search('no such game');
  expect(container.textContent).toContain('No matching windows or devices.');
});

it('allows selection while thumbnails load and displays previews when they arrive', async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(new Promise(r => { resolve = r; }));
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-window-value="z"]')!.click());
  expect(select).toHaveBeenCalledWith('z');
  await act(async () => resolve([{ value: 'z', imageData: 'data:image/jpeg;base64,preview' }]));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,preview');
  expect(container.querySelector('[data-window-value="a"]')?.textContent).toContain('Preview unavailable');
});

it('keeps selection visible through filtering, and disables cards during creation', async () => {
  await render({ selectedValue: 'z', disabled: true });
  expect(container.querySelector('[aria-pressed="true"]')?.getAttribute('data-window-value')).toBe('z');
  expect(container.querySelector<HTMLButtonElement>('[data-window-value="z"]')?.disabled).toBe(true);
  await render({ selectedValue: 'z' });
  await search('Alpha');
  expect(container.textContent).toContain('Selected: Zulu Game');
});

it('refreshes previews on request, not on status polls or ordering changes', async () => {
  await render();
  await render({ windows: [...windows] });
  await render({ windows: [windows[1], windows[0], ...windows.slice(2)] });
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh capture targets"]')!.click());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('supports non-Windows selection and capture failure without blocking the picker', async () => {
  await render({ previewsEnabled: false });
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockRejectedValue(new Error('Unavailable'));
  await render();
  expect(container.textContent).toContain('Preview unavailable');
  expect(container.querySelector<HTMLButtonElement>('[data-window-value="a"]')?.disabled).toBe(false);
});
