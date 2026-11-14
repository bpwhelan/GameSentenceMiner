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
      if (channel === 'settings.onboarding.sudachi') return { state: 'setup_required', dictionary: 'small' };
      if (channel === 'obs.getScenes') return [];
      return { success: true };
    });
    Object.defineProperty(window, 'ipcRenderer', { configurable: true, value: { invoke } });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(locale = 'en') {
    await act(async () => root.render(<I18nProvider initialLocale={locale}><SetupWizard onComplete={complete} onAction={action} /></I18nProvider>));
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

  it('hands off to the real game setup and returns to the same guide step', async () => {
    snapshot.progress.step = 'game';
    await render();
    await click('Add my first game');
    expect(action).toHaveBeenCalledWith('game');
    expect(container.querySelector('[role=dialog]')).toBeNull();
    await click('Return to guide');
    expect(container.querySelector('h1')?.textContent).toContain('Bring your game');
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not claim a dictionary is ready just because installation was requested', async () => {
    snapshot.progress.step = 'dictionary';
    await render();
    await click('Install or enable Jitendex');
    expect(invoke).toHaveBeenCalledWith('settings.onboarding.dictionary', { action: 'install' });
    expect(button('Continue').disabled).toBe(true);
    expect(container.textContent).not.toContain('An enabled dictionary is ready.');
  });

  it('downloads only the selected edition after a setup action and exposes retry errors', async () => {
    snapshot.progress.step = 'dictionary';
    await render();
    expect(invoke).not.toHaveBeenCalledWith('settings.onboarding.sudachi', expect.objectContaining({ action: 'install' }));
    await act(async () => {
      const edition = container.querySelector<HTMLSelectElement>('#sudachi-edition')!;
      edition.value = 'full'; edition.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(container.querySelector<HTMLSelectElement>('#sudachi-edition')!.value).toBe('full');
    invoke.mockResolvedValueOnce({ state: 'error', error: 'Network unavailable' });
    await click('Download / use selected dictionary');
    expect(invoke).toHaveBeenCalledWith('settings.onboarding.sudachi', { action: 'install', dictionary: 'full' });
    expect(container.textContent).toContain('Network unavailable');
    expect(button('Try again')).toBeTruthy();
    expect(button('Continue').disabled).toBe(true);
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
