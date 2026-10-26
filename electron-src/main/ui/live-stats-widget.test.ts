import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

type LiveStatsWidget = {
  applySettings: (settings: Record<string, unknown>) => void;
  handleGoalsUpdate: (payload: { goals: unknown[] }) => void;
  handleStatsUpdate: (payload: Record<string, unknown>) => void;
  handleTextBoundsUpdate: (rects: Array<Record<string, number>>) => void;
  handlePomodoroUpdate: (payload: Record<string, unknown>) => void;
};

const widgetSource = readFileSync(resolve(process.cwd(), 'GSM_Overlay/live_stats_widget.js'), 'utf8');
const settingsHtml = readFileSync(resolve(process.cwd(), 'GSM_Overlay/settings.html'), 'utf8');
const settingsBindings = readFileSync(resolve(process.cwd(), 'GSM_Overlay/settings/bindings.js'), 'utf8');
const overlayHtml = readFileSync(resolve(process.cwd(), 'GSM_Overlay/index.html'), 'utf8');
const mainSource = readFileSync(resolve(process.cwd(), 'GSM_Overlay/main.js'), 'utf8');

function loadWidget(): { dom: JSDOM; ipcSend: ReturnType<typeof vi.fn>; widget: LiveStatsWidget } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  const ipcSend = vi.fn();
  (dom.window as unknown as { require: (moduleId: string) => unknown }).require = (moduleId) => {
    if (moduleId !== 'electron') {
      throw new Error(`Unexpected module request: ${moduleId}`);
    }
    return { ipcRenderer: { on: vi.fn(), send: ipcSend } };
  };
  vi.spyOn(dom.window.console, 'warn').mockImplementation(() => undefined);
  dom.window.eval(widgetSource);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

  return {
    dom,
    ipcSend,
    widget: (dom.window as unknown as { GSMLiveStatsWidget: LiveStatsWidget }).GSMLiveStatsWidget,
  };
}

function goal(id: string, view: 'today' | 'overall', completed: boolean) {
  return {
    id,
    name: id,
    metric_type: 'characters',
    today: { progress: completed ? 10 : 4, required: 10, has_target: true },
    overall: { progress: completed ? 100 : 40, target: 100, percent: completed ? 100 : 40 },
    view,
  };
}

function configureGoals(widget: LiveStatsWidget, hideCompletedGoals?: boolean) {
  widget.applySettings({
    showLiveStats: false,
    showLiveGoals: true,
    liveStatsVisibilityMode: 'goals',
    hideCompletedGoals,
    overlayGoals: {
      today_complete: { enabled: true, view: 'today' },
      today_incomplete: { enabled: true, view: 'today' },
      overall_complete: { enabled: true, view: 'overall' },
      overall_incomplete: { enabled: true, view: 'overall' },
    },
  });
}

function renderedGoalLabels(dom: JSDOM): string[] {
  return Array.from(dom.window.document.querySelectorAll('.gsm-live-goal-label'))
    .map((element) => element.getAttribute('data-text') || '');
}

function rect(left: number, top: number, right: number, bottom: number) {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stats intake pause warning', () => {
  it.each(['one-line', 'stacked'])('stays visible with stats disabled in %s layout and clears on resume', (layout) => {
    const { dom, widget } = loadWidget();
    widget.applySettings({ showLiveStats: false, showLiveGoals: false, liveStatsVisibilityMode: 'hidden', liveStatsLayoutV2: layout });
    dom.window.dispatchEvent(new dom.window.CustomEvent('gsm-live-stats-update', {
      detail: { reason: 'connect', updated_at: 100, text_intake_paused: true, session_active: false },
    }));

    const root = dom.window.document.querySelector('#gsm-live-stats')!;
    const warning = root.querySelector('.gsm-live-stats-intake-warning');
    expect(root.classList.contains('gsm-live-stats-visible')).toBe(true);
    expect(root.classList.contains('gsm-live-stats-intake-paused')).toBe(true);
    expect(warning?.getAttribute('data-text')).toBe('Stats intake paused');
    expect(warning?.getAttribute('aria-label')).toBe('Stats intake paused');
    // Keep the warning out of dictionary text scans, like the other stats text.
    expect(warning?.textContent).toBe('');

    widget.handleStatsUpdate({ updated_at: 101, text_intake_paused: false });
    expect(root.classList.contains('gsm-live-stats-intake-paused')).toBe(false);
    expect(root.classList.contains('gsm-live-stats-visible')).toBe(false);
    dom.window.close();
  });

  it('survives auto-hide and text overlap until intake resumes', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
    dom.window.clearTimeout = clearTimeout as unknown as typeof dom.window.clearTimeout;
    widget.applySettings({ liveStatsDisplayModeV2: 'new-line', liveStatsAutoHideSeconds: 1 });
    widget.handleStatsUpdate({ updated_at: 100, text_intake_paused: true });
    const root = dom.window.document.querySelector<HTMLElement>('#gsm-live-stats')!;
    root.getBoundingClientRect = vi.fn(() => rect(800, 10, 1000, 110) as DOMRect);
    widget.handleTextBoundsUpdate([rect(850, 40, 900, 80)]);
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(root.classList.contains('gsm-live-stats-visible')).toBe(true);

    widget.handleStatsUpdate({ updated_at: 101, text_intake_paused: false });
    expect(root.classList.contains('gsm-live-stats-visible')).toBe(false);
    dom.window.close();
  });

  it('updates immediately in Today mode and ignores stale daily pause state', () => {
    const { dom, widget } = loadWidget();
    widget.applySettings({ liveStatsScope: 'today', showLiveStats: false });
    const root = dom.window.document.querySelector('#gsm-live-stats')!;
    widget.handleStatsUpdate({ scope: 'session', updated_at: 200, text_intake_paused: true });
    expect(root.classList.contains('gsm-live-stats-intake-paused')).toBe(true);
    widget.handleStatsUpdate({ scope: 'today', updated_at: 199, text_intake_paused: false });
    expect(root.classList.contains('gsm-live-stats-intake-paused')).toBe(true);
    widget.handleStatsUpdate({ scope: 'session', updated_at: 201, text_intake_paused: false });
    expect(root.classList.contains('gsm-live-stats-intake-paused')).toBe(false);
    widget.handleStatsUpdate({ scope: 'today', updated_at: 200, text_intake_paused: true });
    expect(root.classList.contains('gsm-live-stats-intake-paused')).toBe(false);
    dom.window.close();
  });
});

describe('live stats Session/Today scope', () => {
  const now = new Date('2026-10-05T12:00:00Z').getTime();

  function payload(scope: 'session' | 'today', totalCharacters: number, active = false) {
    return {
      type: 'live_stats_update',
      scope,
      reason: 'refresh',
      updated_at: now / 1000,
      session_active: active,
      session_start_time: now / 1000 - 30,
      last_line_time: now / 1000 - 10,
      session_expires_at: now / 1000 + 1800,
      period_end: now / 1000 + 3600,
      values: {
        chars_per_hour: 7200,
        total_characters: totalCharacters,
        active_reading_time: 30,
        raw_reading_time: scope === 'today' ? 120 : 30,
        cards_mined: 2,
      },
    };
  }

  function value(dom: JSDOM, key: string) {
    return dom.window.document.querySelector(`[data-field-key="${key}"]`)?.getAttribute('data-text');
  }

  it('offers Session by default and Today in saved overlay settings', () => {
    const dom = new JSDOM(settingsHtml);
    const select = dom.window.document.querySelector<HTMLSelectElement>('#liveStatsScope');
    expect(select?.value).toBe('session');
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual(['session', 'today']);
    expect(settingsBindings).toContain('createSelectBinding("liveStatsScope", "#liveStatsScope",');
    expect(mainSource).toContain('"liveStatsScope": "session"');
    dom.window.close();
  });

  it('keeps the session default and switches to cached day totals immediately', () => {
    const { dom, widget } = loadWidget();
    vi.spyOn(dom.window.Date, 'now').mockReturnValue(now);
    // Existing backends send session snapshots without a scope.
    const session = payload('session', 20);
    delete (session as { scope?: string }).scope;
    widget.handleStatsUpdate(session);
    widget.handleStatsUpdate(payload('today', 500));
    expect(value(dom, 'total_characters')).toBe('20');

    widget.applySettings({ liveStatsScope: 'today' });
    expect(value(dom, 'total_characters')).toBe('500');
    widget.handleStatsUpdate(payload('session', 0));
    expect(value(dom, 'total_characters')).toBe('500');

    widget.applySettings({ liveStatsScope: 'unknown' });
    expect(value(dom, 'total_characters')).toBe('0');
    dom.window.close();
  });

  it('routes daily snapshot requests through the active overlay and Today setting', () => {
    const start = mainSource.indexOf('  ipcMain.on("request-live-stats-today",');
    const end = mainSource.indexOf('  ipcMain.on("translate-blocks",', start);
    const sender = {};
    const send = vi.fn();
    let handler: (event: { sender: object }, payload?: Record<string, string>) => void;
    const settings = { liveStatsScope: 'session', showLiveStats: true };
    const backend = { connected: true, send };
    vm.runInNewContext(mainSource.slice(start, end), {
      ipcMain: { on: (_channel: string, callback: typeof handler) => { handler = callback; } },
      mainWindow: { isDestroyed: () => false, webContents: sender },
      userSettings: settings,
      backend,
    });
    handler!({ sender });
    expect(send).not.toHaveBeenCalled();
    settings.liveStatsScope = 'today';
    handler!({ sender: {} });
    expect(send).not.toHaveBeenCalled();
    handler!({ sender });
    expect(send).toHaveBeenCalledWith({ type: 'get-live-stats-today', reason: 'refresh' });
    send.mockClear();
    backend.connected = false;
    handler!({ sender });
    expect(send).not.toHaveBeenCalled();
    backend.connected = true;
    settings.showLiveStats = false;
    handler!({ sender });
    expect(send).not.toHaveBeenCalled();
  });

  it('clears the previous game and immediately requests the selected game totals', () => {
    const { dom, ipcSend, widget } = loadWidget();
    vi.spyOn(dom.window.Date, 'now').mockReturnValue(now);
    widget.applySettings({ liveStatsScope: 'today' });
    widget.handleStatsUpdate({ ...payload('today', 500), game_name: 'First Game' });
    expect(value(dom, 'total_characters')).toBe('500');
    ipcSend.mockClear();

    widget.handleStatsUpdate({
      ...payload('session', 0), game_name: 'Second Game', reason: 'game_changed', updated_at: now / 1000 + 1,
    });
    expect(value(dom, 'total_characters')).not.toBe('500');
    expect(ipcSend).toHaveBeenCalledWith('request-live-stats-today', { reason: 'game_changed' });
    widget.handleStatsUpdate({ ...payload('today', 40), game_name: 'Second Game', updated_at: now / 1000 + 2 });
    expect(value(dom, 'total_characters')).toBe('40');

    // A query started before the switch must not bring back the old game.
    widget.handleStatsUpdate({ ...payload('today', 500), game_name: 'First Game' });
    expect(value(dom, 'total_characters')).toBe('40');

    widget.handleStatsUpdate({
      ...payload('session', 0), game_name: 'First Game', reason: 'game_changed', updated_at: now / 1000 + 3,
    });
    widget.handleStatsUpdate({ ...payload('today', 520), game_name: 'First Game', updated_at: now / 1000 + 4 });
    expect(value(dom, 'total_characters')).toBe('520');
    dom.window.close();
  });

  it('follows daily game changes after reconnect before the first live line', () => {
    const { dom, widget } = loadWidget();
    vi.spyOn(dom.window.Date, 'now').mockReturnValue(now);
    widget.applySettings({ liveStatsScope: 'today' });
    widget.handleStatsUpdate({ ...payload('session', 0), game_name: '', reason: 'connect' });
    widget.handleStatsUpdate({ ...payload('today', 500), game_name: 'First Game' });
    widget.handleStatsUpdate({ ...payload('today', 40), game_name: 'Second Game', updated_at: now / 1000 + 1 });
    expect(value(dom, 'total_characters')).toBe('40');
    // Old session metadata must not undo the newer active game.
    widget.handleStatsUpdate({ ...payload('session', 500), game_name: 'First Game' });
    expect(value(dom, 'total_characters')).toBe('40');
    dom.window.close();
  });

  it('ticks daily raw time from the accumulated total and freezes it while inactive', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    let clock = now;
    vi.spyOn(dom.window.Date, 'now').mockImplementation(() => clock);
    widget.applySettings({ liveStatsScope: 'today' });
    widget.handleStatsUpdate(payload('today', 500, true));
    expect(value(dom, 'raw_reading_time')).toBe('2:00');

    clock += 10000;
    vi.advanceTimersByTime(1000);
    expect(value(dom, 'raw_reading_time')).toBe('2:10');
    widget.handleStatsUpdate(payload('today', 500, false));
    clock += 1800000;
    vi.advanceTimersByTime(1000);
    expect(value(dom, 'raw_reading_time')).toBe('2:00');
    dom.window.close();
  });

  it('replaces a pending daily gap with active time after thirty minutes without a refresh', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    let clock = now;
    vi.spyOn(dom.window.Date, 'now').mockImplementation(() => clock);
    widget.applySettings({ liveStatsScope: 'today' });
    widget.handleStatsUpdate({
      ...payload('today', 500, true),
      session_expires_at: now / 1000 + 7200,
      raw_time_gap_limit_seconds: 1800,
      raw_time_pending_active_seconds: 25,
    });

    clock += 1790000;
    vi.advanceTimersByTime(1000);
    expect(value(dom, 'raw_reading_time')).toBe('31:50');
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(value(dom, 'raw_reading_time')).toBe('2:15');

    widget.handleStatsUpdate({
      ...payload('today', 500, true),
      updated_at: clock / 1000,
      session_expires_at: now / 1000 + 7200,
      raw_time_gap_limit_seconds: 1800,
      raw_time_pending_active_seconds: 25,
      values: { ...payload('today', 500, true).values, raw_reading_time: 135 },
    });
    clock += 10000;
    vi.advanceTimersByTime(1000);
    expect(value(dom, 'raw_reading_time')).toBe('2:15');
    dom.window.close();
  });

  it('clears every daily field at cutover even without a new backend update', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    let clock = now;
    vi.spyOn(dom.window.Date, 'now').mockImplementation(() => clock);
    widget.applySettings({ liveStatsScope: 'today' });
    const today = payload('today', 500, true);
    today.period_end = now / 1000 + 1;
    widget.handleStatsUpdate(today);

    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(value(dom, 'total_characters')).toBe('0');
    expect(value(dom, 'cards_mined')).toBe('0');
    expect(value(dom, 'active_reading_time')).toBe('0:00');
    expect(value(dom, 'raw_reading_time')).toBe('0:00');
    widget.handleStatsUpdate(today);
    expect(value(dom, 'total_characters')).toBe('0');
    dom.window.close();
  });

  it('requests fresh day totals only while Today stats are enabled', () => {
    vi.useFakeTimers();
    const { dom, ipcSend, widget } = loadWidget();
    vi.spyOn(dom.window.Date, 'now').mockReturnValue(now);
    ipcSend.mockClear();
    vi.advanceTimersByTime(6000);
    expect(ipcSend).not.toHaveBeenCalledWith('request-live-stats-today', expect.anything());

    widget.applySettings({ liveStatsScope: 'today' });
    expect(ipcSend).toHaveBeenCalledWith('request-live-stats-today', { reason: 'scope_changed' });
    ipcSend.mockClear();
    widget.applySettings({ showLiveStats: false });
    vi.advanceTimersByTime(6000);
    expect(ipcSend).not.toHaveBeenCalledWith('request-live-stats-today', expect.anything());
    dom.window.close();
  });

  it('allows brief daily stats to hide between background refreshes', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    vi.spyOn(dom.window.Date, 'now').mockReturnValue(now);
    widget.applySettings({ liveStatsScope: 'today', liveStatsDisplayModeV2: 'new-line', liveStatsAutoHideSeconds: 1 });
    widget.handleStatsUpdate(payload('today', 500));
    expect(dom.window.document.querySelector('#gsm-live-stats')?.classList.contains('gsm-live-stats-visible')).toBe(true);
    vi.advanceTimersByTime(1000);
    widget.handleStatsUpdate(payload('today', 500));
    expect(dom.window.document.querySelector('#gsm-live-stats')?.classList.contains('gsm-live-stats-visible')).toBe(false);
    dom.window.close();
  });
});

describe('live stats idle work', () => {
  it('has no heartbeat with disabled or inactive session stats, and restarts for live time', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    widget.applySettings({ showLiveStats: false, showLiveGoals: false });
    expect(vi.getTimerCount()).toBe(0);
    widget.applySettings({ showLiveStats: true });
    widget.handleStatsUpdate({ session_active: false, values: { raw_reading_time: 30 } });
    expect(vi.getTimerCount()).toBe(0);
    widget.handleStatsUpdate({ session_active: true, session_start_time: Date.now() / 1000 - 30 });
    expect(vi.getTimerCount()).toBe(1);
    widget.applySettings({ showLiveStats: false });
    expect(vi.getTimerCount()).toBe(0);
    dom.window.close();
  });

  it('stops live time work for an obscured game and catches up immediately when restored', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    let now = Date.now();
    vi.spyOn(dom.window.Date, 'now').mockImplementation(() => now);
    widget.handleStatsUpdate({ session_active: true, session_start_time: now / 1000 - 30 });
    expect(vi.getTimerCount()).toBe(1);
    dom.window.dispatchEvent(new dom.window.CustomEvent('gsm-window-state-update', { detail: { data: 'obscured' } }));
    expect(vi.getTimerCount()).toBe(0);
    now += 10000;
    dom.window.dispatchEvent(new dom.window.CustomEvent('gsm-window-state-update', { detail: { data: 'active' } }));
    expect(vi.getTimerCount()).toBe(1);
    expect(dom.window.document.querySelector('[data-field-key="raw_reading_time"]')?.getAttribute('data-text')).toBe('0:40');
    dom.window.close();
  });

  it('keeps running Pomodoro countdowns live and sleeps while paused', () => {
    vi.useFakeTimers();
    const { dom, widget } = loadWidget();
    const publish = (running: boolean) => widget.handlePomodoroUpdate({
      enabled: true, running, remainingMs: 60000, endTimestamp: Date.now() + 60000,
    });
    publish(true);
    expect(vi.getTimerCount()).toBe(1);
    publish(false);
    expect(vi.getTimerCount()).toBe(0);
    dom.window.close();
  });
});

describe('live stats completed goals', () => {
  it('exposes a default-on completed-goal setting', () => {
    const dom = new JSDOM(settingsHtml);
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('#hideCompletedGoals');

    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
    expect(settingsBindings).toContain('createCheckboxBinding("hideCompletedGoals", "#hideCompletedGoals")');
  });

  it('hides completed today and overall goals by default', () => {
    const { dom, widget } = loadWidget();
    configureGoals(widget);

    widget.handleGoalsUpdate({
      goals: [
        goal('today_complete', 'today', true),
        goal('today_incomplete', 'today', false),
        goal('overall_complete', 'overall', true),
        goal('overall_incomplete', 'overall', false),
      ],
    });

    expect(renderedGoalLabels(dom)).toEqual([
      '🎯 today_incomplete',
      '🎯 overall_incomplete',
    ]);
  });

  it('collapses the goals line when every selected goal is completed', () => {
    const { dom, widget } = loadWidget();
    configureGoals(widget);

    widget.handleGoalsUpdate({
      goals: [
        goal('today_complete', 'today', true),
        goal('overall_complete', 'overall', true),
      ],
    });

    const goals = dom.window.document.querySelector('.gsm-live-stats-goals');
    expect(goals?.children).toHaveLength(0);
    expect(goals?.classList.contains('visible')).toBe(false);
    expect(dom.window.document.querySelector('#gsm-live-stats')?.classList.contains('gsm-live-stats-visible')).toBe(false);
  });

  it('keeps completed goals visible when the option is disabled', () => {
    const { dom, widget } = loadWidget();
    configureGoals(widget, false);

    widget.handleGoalsUpdate({
      goals: [goal('today_complete', 'today', true)],
    });

    expect(renderedGoalLabels(dom)).toEqual(['🎯 today_complete']);
  });

  it('reports whether any goal can render independently of the current visibility mode', () => {
    const { ipcSend, widget } = loadWidget();
    configureGoals(widget);

    widget.handleGoalsUpdate({ goals: [goal('today_incomplete', 'today', false)] });
    expect(ipcSend).toHaveBeenLastCalledWith('live-goals-availability-changed', { available: true });

    widget.handleGoalsUpdate({ goals: [goal('today_complete', 'today', true)] });
    expect(ipcSend).toHaveBeenLastCalledWith('live-goals-availability-changed', { available: false });
  });
});

describe('live stats hotkey visibility cycle', () => {
  it('skips goal-only modes when no goal can be shown', () => {
    const start = mainSource.indexOf('function normalizeLiveStatsVisibilityMode');
    const end = mainSource.indexOf('\nfunction buildOverlaySettingsPayload', start);
    if (start < 0 || end < 0) {
      throw new Error('Unable to find live stats visibility helpers in GSM_Overlay/main.js');
    }

    const context = vm.createContext({
      LIVE_STATS_VISIBILITY_CYCLE_ORDER: ['stats', 'goals', 'hidden', 'all'],
      VALID_LIVE_STATS_VISIBILITY_MODES: new Set(['all', 'stats', 'goals', 'hidden']),
      liveGoalsAvailable: false,
      module: { exports: {} },
      userSettings: {},
    });
    vm.runInContext(
      `${mainSource.slice(start, end)}\nmodule.exports = { getLiveStatsVisibilityCycleModes };`,
      context,
    );

    const helpers = (context.module as { exports: {
      getLiveStatsVisibilityCycleModes: (settings: Record<string, unknown>, goalsAvailable: boolean) => string[];
    } }).exports;

    expect(Array.from(helpers.getLiveStatsVisibilityCycleModes({}, false))).toEqual(['stats', 'hidden']);
    expect(Array.from(helpers.getLiveStatsVisibilityCycleModes({}, true))).toEqual([
      'stats',
      'goals',
      'hidden',
      'all',
    ]);
  });
});

describe('live stats text overlap avoidance', () => {
  it('exposes a default-on setting and forwards authoritative rendered text bounds', () => {
    const dom = new JSDOM(settingsHtml);
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('#hideLiveStatsOnTextOverlap');

    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
    expect(settingsBindings).toContain(
      'createCheckboxBinding("hideLiveStatsOnTextOverlap", "#hideLiveStatsOnTextOverlap")',
    );
    expect(mainSource).toContain('"hideLiveStatsOnTextOverlap": true');
    expect(overlayHtml).toMatch(
      /handleTextBoundsUpdate\(\s*renderedTextBoxes\.map\(box => box\.getBoundingClientRect\(\)\)\s*\)/,
    );
  });

  it('stays hidden after an overlap until a later non-overlapping text event', () => {
    const { dom, widget } = loadWidget();
    widget.handleStatsUpdate({ values: {}, session_active: true });

    const root = dom.window.document.querySelector<HTMLElement>('#gsm-live-stats');
    expect(root).not.toBeNull();
    root!.getBoundingClientRect = vi.fn(() => rect(800, 10, 1000, 110) as DOMRect);

    widget.handleTextBoundsUpdate([rect(850, 40, 900, 80)]);
    expect(root?.classList.contains('gsm-live-stats-visible')).toBe(false);

    widget.handleStatsUpdate({ values: { total_characters: 10 }, session_active: true });
    expect(root?.classList.contains('gsm-live-stats-visible')).toBe(false);

    widget.applySettings({ liveStatsLayoutV2: 'stacked' });
    expect(root?.classList.contains('gsm-live-stats-visible')).toBe(false);

    widget.handleTextBoundsUpdate([rect(100, 300, 300, 360)]);
    expect(root?.classList.contains('gsm-live-stats-visible')).toBe(true);
  });

  it('does not hide for overlaps when the option is disabled', () => {
    const { dom, widget } = loadWidget();
    widget.handleStatsUpdate({ values: {}, session_active: true });

    const root = dom.window.document.querySelector<HTMLElement>('#gsm-live-stats');
    expect(root).not.toBeNull();
    root!.getBoundingClientRect = vi.fn(() => rect(800, 10, 1000, 110) as DOMRect);

    widget.applySettings({ hideLiveStatsOnTextOverlap: false });
    widget.handleTextBoundsUpdate([rect(850, 40, 900, 80)]);

    expect(root?.classList.contains('gsm-live-stats-visible')).toBe(true);
  });
});
