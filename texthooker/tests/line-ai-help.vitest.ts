import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Line from '../src/components/Line.svelte';
import Presets from '../src/components/Presets.svelte';
import type { LineItem, Settings } from '../src/types';
import { showMenuButton$, showExpiredIcon$ } from '../src/stores/stores';

afterEach(() => {
	showMenuButton$.next(true);
	showExpiredIcon$.next(true);
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

test('menu visibility updates immediately and persists without hiding the expired indicator', async () => {
	const component = await mountLine('timed_out');
	expect(document.querySelector('[aria-label="More line actions"]')).not.toBeNull();
	(document.querySelector('[aria-label="More line actions"]') as HTMLButtonElement).click();
	await tick();
	expect(document.querySelector('.actions-menu-popover')).not.toBeNull();
	showMenuButton$.next(false);
	await tick();
	expect(document.querySelector('[aria-label="More line actions"]')).toBeNull();
	expect(document.querySelector('.actions-menu-popover')).toBeNull();
	expect(document.querySelector('[title="Line is outside replay buffer"]')).not.toBeNull();
	expect(localStorage.getItem('bannou-texthooker-showMenuButton')).toBe('0');
	showMenuButton$.next(true);
	await tick();
	expect(document.querySelector('[aria-label="More line actions"]')).not.toBeNull();
	await unmount(component);
});

test('expired icon visibility leaves translation and the line menu available', async () => {
	const component = await mountLine('timed_out');
	showExpiredIcon$.next(false);
	await tick();
	expect(document.querySelector('[title="Line is outside replay buffer"]')).toBeNull();
	expect(document.querySelector('[title="Translate"]')).not.toBeNull();
	expect(document.querySelector('[aria-label="More line actions"]')).not.toBeNull();
	expect(localStorage.getItem('bannou-texthooker-showExpiredIcon')).toBe('0');
	showExpiredIcon$.next(true);
	await tick();
	expect(document.querySelector('[title="Line is outside replay buffer"]')).not.toBeNull();
	await unmount(component);
});

test('the expired icon toggle also hides lines from before GSM started', async () => {
	const component = await mountLine(undefined);
	const indicator = '[title="Line is from before GSM was started"]';
	expect(document.querySelector(indicator)).not.toBeNull();
	showExpiredIcon$.next(false);
	await tick();
	expect(document.querySelector(indicator)).toBeNull();
	showExpiredIcon$.next(true);
	await tick();
	expect(document.querySelector(indicator)).not.toBeNull();
	await unmount(component);
});

test('presets retain visibility choices and older presets default to visible', async () => {
	const component = mount(Presets, { target: document.body });
	showMenuButton$.next(false);
	showExpiredIcon$.next(false);
	await tick();
	const settings = component.getCurrentSettings();
	expect(settings.showMenuButton$).toBe(false);
	expect(settings.showExpiredIcon$).toBe(false);
	showMenuButton$.next(true);
	showExpiredIcon$.next(true);
	component.updateSettingsWithPreset({ name: 'Hidden controls', settings });
	expect(showMenuButton$.getValue()).toBe(false);
	expect(showExpiredIcon$.getValue()).toBe(false);
	const { showMenuButton$: _menu, showExpiredIcon$: _expired, ...legacySettings } = settings;
	component.updateSettingsWithPreset({ name: 'Older preset', settings: legacySettings as Settings });
	expect(showMenuButton$.getValue()).toBe(true);
	expect(showExpiredIcon$.getValue()).toBe(true);
	await unmount(component);
});

async function mountLine(gsmStatus: LineItem['gsmStatus']) {
	const line = { id: 'line-1', text: '例文', gsmStatus };
	const component = mount(Line, { target: document.body, props: { line, index: 0, isLast: false } });
	await tick();
	return component;
}

test.each(['active', 'timed_out', 'external'] as const)(
	'%s lines offer AI help from the line actions without showing controls by default',
	async (gsmStatus) => {
		const component = await mountLine(gsmStatus);
		expect(document.querySelector('.ai-help')).toBeNull();
		expect(document.body.textContent).not.toContain('Explain sentence');
		(document.querySelector('[aria-label="More line actions"]') as HTMLButtonElement).click();
		await tick();
		const askAI = [...document.querySelectorAll('.actions-menu-popover button')].find((button) =>
			button.textContent?.includes('Ask AI'),
		) as HTMLButtonElement;
		expect(askAI).toBeDefined();
		askAI.click();
		await tick();
		expect(document.querySelector('[aria-label="AI sentence help"]')).not.toBeNull();
		expect(document.activeElement).toBe(document.querySelector('select[aria-label="Explanation type"]'));
		expect(document.querySelector('.actions-menu-popover')).toBeNull();
		(document.querySelector('[aria-label="Close AI help"]') as HTMLButtonElement).click();
		await tick();
		expect(document.querySelector('.ai-help')).toBeNull();
		await unmount(component);
	},
);

test('the opened panel can ask a question about the chosen line', async () => {
	const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ analysis: 'Because of context.' }) });
	vi.stubGlobal('fetch', fetcher);
	const component = await mountLine('external');
	(document.querySelector('[aria-label="More line actions"]') as HTMLButtonElement).click();
	await tick();
	(
		[...document.querySelectorAll('.actions-menu-popover button')].find((button) =>
			button.textContent?.includes('Ask AI'),
		) as HTMLButtonElement
	).click();
	await tick();
	const select = document.querySelector('select[aria-label="Explanation type"]') as HTMLSelectElement;
	select.value = 'custom';
	select.dispatchEvent(new Event('change'));
	await tick();
	const question = document.querySelector(
		'input[placeholder="What does this particle mean here?"]',
	) as HTMLInputElement;
	question.value = 'Why this ending?';
	question.dispatchEvent(new Event('input'));
	await tick();
	(
		[...document.querySelectorAll('.ai-help button')].find(
			(button) => button.textContent === 'Explain',
		) as HTMLButtonElement
	).click();
	await vi.waitFor(() => expect(document.querySelector('.result')?.textContent).toBe('Because of context.'));
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
		id: 'line-1',
		text: '例文',
		mode: 'custom',
		question: 'Why this ending?',
	});
	await unmount(component);
});
