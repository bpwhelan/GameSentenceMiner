import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Line from '../src/components/Line.svelte';
import type { LineItem } from '../src/types';

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
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
