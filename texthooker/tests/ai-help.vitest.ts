import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import AIHelp from '../src/components/AIHelp.svelte';

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

async function openHelp() {
	const component = mount(AIHelp, { target: document.body, props: { id: 'line-1', text: '例文' } });
	await tick();
	return component;
}

function button(text: string) {
	return [...document.querySelectorAll('button')].find((element) => element.textContent === text)!;
}

test('explains a selected task and renders provider text safely', async () => {
	const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ analysis: '<img src=x onerror=bad()>\nGrammar explanation' }) });
	vi.stubGlobal('fetch', fetcher);
	const component = await openHelp();
	const select = document.querySelector('select')!;
	select.value = 'grammar';
	select.dispatchEvent(new Event('change'));
	await tick();
	button('Explain').click();
	await vi.waitFor(() => expect(document.querySelector('.result')?.textContent).toContain('Grammar explanation'));
	expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ id: 'line-1', text: '例文', mode: 'grammar', question: '' });
	expect(document.querySelector('img')).toBeNull();
	await unmount(component);
});

test('shows setup-required guidance and allows retry after setup', async () => {
	const fetcher = vi.fn()
		.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'ai_setup_required', error: 'AI setup is open. Paste your key and retry.' }) })
		.mockResolvedValueOnce({ ok: true, json: async () => ({ analysis: 'Ready now' }) });
	vi.stubGlobal('fetch', fetcher);
	const component = await openHelp();
	button('Explain').click();
	await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toContain('Paste your key'));
	button('Explain').click();
	await vi.waitFor(() => expect(document.querySelector('.result')?.textContent).toBe('Ready now'));
	expect(document.querySelector('[role=alert]')).toBeNull();
	await unmount(component);
});

test('custom questions require text and duplicate clicks do not send another request', async () => {
	const fetcher = vi.fn(() => new Promise(() => {}));
	vi.stubGlobal('fetch', fetcher);
	const component = await openHelp();
	const select = document.querySelector('select')!;
	select.value = 'custom';
	select.dispatchEvent(new Event('change'));
	await tick();
	expect(button('Explain').disabled).toBe(true);
	const input = document.querySelector('input')!;
	input.value = 'Why this ending?';
	input.dispatchEvent(new Event('input'));
	await tick();
	button('Explain').click();
	button('Explain').click();
	await tick();
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(fetcher.mock.calls[0][1].body).question).toBe('Why this ending?');
	await unmount(component);
});
