import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Line from '../src/components/Line.svelte';
import { autoTranslateLines$, enableLineAnimation$, unblurTLTimer$ } from '../src/stores/stores';
import type { LineItem } from '../src/types';

const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
	autoTranslateLines$.next(false);
	enableLineAnimation$.next(false);
	unblurTLTimer$.next(0);
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise(() => {})),
	);
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
	vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
});

afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	autoTranslateLines$.next(false);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

async function mountLine(line: LineItem, isLast = false) {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(Line, { target, props: { line, index: 0, isLast } });
	mounted.push(component);
	await tick();
	await tick();
	return target;
}

function translateButton(target: HTMLElement) {
	return target.querySelector('[title="Translate"]') as HTMLButtonElement;
}

function pendingTranslation() {
	let finish!: (value: unknown) => void;
	const fetcher = vi.fn(
		(_url: RequestInfo | URL, _options?: RequestInit) => new Promise((resolve) => (finish = resolve)),
	);
	vi.stubGlobal('fetch', fetcher);
	return {
		fetcher,
		finish: () => finish({ ok: true, json: async () => ({ TL: 'Translation' }) }),
	};
}

test('repeated clicks share a pending translation and later manual requests consult GSM', async () => {
	const request = pendingTranslation();
	const line: LineItem = { id: 'one', text: '例文', gsmStatus: 'active' };
	const target = await mountLine(line);
	translateButton(target).click();
	translateButton(target).click();
	expect(request.fetcher).toHaveBeenCalledTimes(1);
	request.finish();
	await vi.waitFor(() => expect(line.translation).toBe('Translation'));
	await tick();
	translateButton(target).click();
	expect(request.fetcher).toHaveBeenCalledTimes(2);
});

test('mounting an already translated frozen line does not auto-translate it again', async () => {
	autoTranslateLines$.next(true);
	await mountLine({
		id: 'cached',
		text: '例文',
		translation: 'Existing translation',
		gsmStatus: 'active',
		recordState: 'frozen',
		revision: 3,
	});
	expect(fetch).not.toHaveBeenCalled();
});

test('legacy automatic translation identifies itself as automatic', async () => {
	const request = pendingTranslation();
	autoTranslateLines$.next(true);
	await mountLine({ id: 'legacy', text: '例文', gsmStatus: 'active' }, true);
	await vi.waitFor(() => expect(request.fetcher).toHaveBeenCalledTimes(1));
	expect(JSON.parse(request.fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ automatic: true });
});

test('a response arriving after unmount cannot overwrite a newer translation', async () => {
	const request = pendingTranslation();
	const line: LineItem = { id: 'stale', text: '例文', gsmStatus: 'active' };
	const target = await mountLine(line);
	translateButton(target).click();
	await unmount(mounted.pop()!);
	line.text = 'New source';
	line.translation = 'New translation';
	request.finish();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(line.translation).toBe('New translation');
});

test('translations stay beneath and separate from the editable source', async () => {
	const line: LineItem = { id: 'separate', text: '元の台詞。', translation: 'A translated line.', gsmStatus: 'active' };
	const target = await mountLine(line);
	const source = target.querySelector('.line-source')!;
	const translation = target.querySelector('[aria-label="Translation"]')!;
	expect(source.textContent?.trim()).toBe('元の台詞。');
	expect(translation.textContent).toContain('A translated line.');
	expect(source.contains(translation)).toBe(false);
});

test('a completed translation never adds layout whitespace to the source text', async () => {
	const request = pendingTranslation();
	const line: LineItem = { id: 'unmodified', text: '元の台詞。', gsmStatus: 'active' };
	const target = await mountLine(line);
	translateButton(target).click();
	request.finish();
	await vi.waitFor(() => expect(line.translation).toBe('Translation'));
	expect(line.text).toBe('元の台詞。');
});
