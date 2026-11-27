// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { SetupWizard } from './SetupWizard';
import type { OnboardingSnapshot } from '../../../shared/onboarding';

describe('first-run setup', () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();
  const complete = vi.fn();
  const action = vi.fn();
  let snapshot: OnboardingSnapshot;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    snapshot = { progress: { version: 2, step: 'language', status: 'active' }, targetLanguage: 'ja', locale: 'en' };
    invoke.mockReset(); complete.mockReset(); action.mockReset();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'settings.onboarding.get') return snapshot;
      if (channel === 'settings.onboarding.dictionary') return { reader: 'yomitan', recommended: { name: 'Jitendex', homepage: 'https://jitendex.org' }, installed: [], busy: false };
      if (channel === 'obs.getScenes') return [];
      return { success: true };
    });
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke } });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(locale = 'en') {
    await act(async () => root.render(<I18nProvider initialLocale={locale}><SetupWizard onComplete={complete} onGuideStep={action} canTextHook /></I18nProvider>));
  }
  function button(text: string) {
    const element = Array.from(container.querySelectorAll('button')).find(item => item.textContent === text);
    expect(element, text).toBeTruthy(); return element!;
  }
  async function click(text: string) { await act(async () => button(text).click()); }

  it('saves both languages before advancing and never completes dependency installation', async () => {
    await render();
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('#setup-language')!;
      select.value = 'ko'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Continue');
    expect(invoke).toHaveBeenCalledWith('settings.saveSettings', { locale: 'en' });
    expect(invoke).toHaveBeenCalledWith('settings.onboarding.language', 'ko');
    expect(invoke).toHaveBeenCalledWith('settings.onboarding.save', { version: 2, step: 'dictionary', status: 'active' });
    expect(complete).not.toHaveBeenCalled();
    expect(button('Continue').disabled).toBe(true);
  });

  it('keeps the current step when persistence fails', async () => {
    await render();
    invoke.mockRejectedValueOnce(new Error('offline'));
    await click('Continue');
    expect(container.querySelector('#setup-language')).toBeTruthy();
    expect(container.querySelector('[role=alert]')).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
  });

  it('resumes saved progress, lets a dictionary step be skipped, and pauses without marking completion', async () => {
    snapshot.progress.step = 'dictionary';
    await render();
    expect(container.querySelector('h1')?.textContent).toContain('Look up');
    await click('Skip this step');
    await click('Set up later');
    expect(invoke).toHaveBeenLastCalledWith('settings.onboarding.save', { version: 2, step: 'game', status: 'paused' });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('resumes game and capture directly in the workspace and opens optional Anki setup', async () => {
    snapshot.progress.step = 'game';
    await render();
    expect(action).toHaveBeenLastCalledWith('game');
    expect(container.querySelector('[role=dialog]')).toBeNull();
    await click('Skip this step');
    expect(action).toHaveBeenLastCalledWith('capture');
    expect(container.querySelector('[role=dialog]')).toBeNull();
    await click('Continue');
    expect(action).toHaveBeenLastCalledWith(null);
    await click('Set up Anki');
    expect(invoke).toHaveBeenCalledWith('settings.mining.recommendedAnki');
    await click('Skip this step');
    expect(button('Finish setup')).toBeTruthy();
  });

  it('does not claim a dictionary is ready just because installation was requested', async () => {
    snapshot.progress.step = 'dictionary';
    await render();
    await click('Install or enable Jitendex');
    expect(invoke).toHaveBeenCalledWith('settings.onboarding.dictionary', { action: 'install' });
    expect(button('Continue').disabled).toBe(true);
    expect(container.textContent).not.toContain('Ready for lookups with Jitendex.');
  });

  it('allows setup during import and verifies the dictionary independently of Sudachi', async () => {
    snapshot.progress.step = 'dictionary';
    const fallback = invoke.getMockImplementation()!;
    const state = { reader: 'yomitan', recommended: { name: 'Jitendex' }, installed: [] as string[], recommendedInstalled: false, busy: false };
    invoke.mockImplementation(async (channel, payload) => {
      if (channel !== 'settings.onboarding.dictionary') return fallback(channel, payload);
      if (payload.action === 'install') state.busy = true;
      return { ...state };
    });
    await render();
    await click('Install or enable Jitendex');
    expect(button('Continue').disabled).toBe(false);
    await click('Continue');
    expect(container.querySelector('.setup-guide')).toBeTruthy();
    expect(container.textContent).toContain('Downloading and importing');
    state.busy = false;
    state.installed = ['Jitendex'];
    state.recommendedInstalled = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(container.textContent).toContain('Ready for lookups with Jitendex.');
    await click('Back');
    expect(container.textContent).not.toContain('Install or enable Jitendex');
    expect(button('Continue').disabled).toBe(false);
    expect(invoke.mock.calls.some(([channel]) => channel === 'settings.onboarding.sudachi')).toBe(false);
  });

  it('waits for successful final persistence before closing', async () => {
    snapshot.progress.step = 'finish';
    await render();
    invoke.mockResolvedValueOnce({ success: false });
    await click('Finish setup');
    expect(complete).not.toHaveBeenCalled();
    await click('Finish setup');
    expect(complete).toHaveBeenCalledOnce();
  });

  it('falls back to English when a locale has no onboarding namespace', async () => {
    await render('es');
    expect(container.textContent).not.toContain('onboarding.');
  });
});
