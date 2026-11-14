// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVisiblePolling } from './visiblePolling';

function visibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}
beforeEach(() => { vi.useFakeTimers(); visibility('visible'); });
afterEach(() => { vi.useRealTimers(); visibility('visible'); });
describe('visible polling', () => {
  it('sleeps while hidden and refreshes immediately on return', async () => {
    const poll = vi.fn(async () => {});
    const stop = startVisiblePolling(poll, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    visibility('hidden');
    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    visibility('visible');
    expect(poll).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap slow requests, including hide/show during a request', async () => {
    let finish!: () => void;
    const poll = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startVisiblePolling(poll, 1000);
    visibility('hidden'); visibility('visible');
    await vi.advanceTimersByTimeAsync(10000);
    expect(poll).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    stop(); finish();
    await vi.advanceTimersByTimeAsync(10000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start hidden and keeps polling after a failure', async () => {
    visibility('hidden');
    const poll = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined);
    const stop = startVisiblePolling(poll, 1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(poll).not.toHaveBeenCalled();
    visibility('visible');
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
  });
});
