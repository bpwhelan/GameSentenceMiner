import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

type LiveStatsWidget = {
  applySettings: (settings: Record<string, unknown>) => void;
  handleGoalsUpdate: (payload: { goals: unknown[] }) => void;
};

const widgetSource = readFileSync(resolve(process.cwd(), 'GSM_Overlay/live_stats_widget.js'), 'utf8');
const settingsHtml = readFileSync(resolve(process.cwd(), 'GSM_Overlay/settings.html'), 'utf8');
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('live stats completed goals', () => {
  it('exposes a default-on completed-goal setting', () => {
    const dom = new JSDOM(settingsHtml);
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('#hideCompletedGoals');

    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
    expect(settingsHtml).toContain('createCheckboxBinding("hideCompletedGoals", "#hideCompletedGoals")');
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
