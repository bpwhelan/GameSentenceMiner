// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSeasonalEffectsDisabled, startSeasonalEffects } from './seasonal';

describe('seasonal appearance', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    delete document.documentElement.dataset.season;
    delete document.documentElement.dataset.theme;
  });

  it('updates every window immediately on opt out without replacing its selected theme', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: {
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    } });
    document.documentElement.dataset.theme = 'solarized-light';
    stop = startSeasonalEffects(false);
    expect(document.documentElement.dataset.season).toBe('halloween');

    listeners.get('settings.seasonalEffectsChanged')?.({}, true);
    expect(document.documentElement.dataset.season).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(document.documentElement.dataset.season).toBeUndefined();

    setSeasonalEffectsDisabled(false);
    expect(document.documentElement.dataset.season).toBe('halloween');
    expect(document.documentElement.dataset.theme).toBe('solarized-light');
    stop();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[2026, 7], [2027, 1]])('ends at midnight after November %s/%s and refreshes after sleep', (year, finalDay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(year, 10, finalDay, 23, 59, 30));
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { on: () => () => {} } });
    stop = startSeasonalEffects(false);
    expect(document.documentElement.dataset.season).toBe('halloween');
    vi.advanceTimersByTime(60_000);
    expect(document.documentElement.dataset.season).toBeUndefined();
    vi.setSystemTime(new Date(year + 1, 9, 14));
    window.dispatchEvent(new Event('focus'));
    expect(document.documentElement.dataset.season).toBeUndefined();
    vi.setSystemTime(new Date(year + 1, 9, 15));
    window.dispatchEvent(new Event('focus'));
    expect(document.documentElement.dataset.season).toBe('halloween');
  });
});
