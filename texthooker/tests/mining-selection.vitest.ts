import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LineType } from '../src/types';

let svelte: typeof import('svelte');
let stores: typeof import('../src/stores/stores');
let app: ReturnType<typeof import('svelte').mount>;
let fetcher: ReturnType<typeof vi.fn>;
let hit: Element | null;

const response = (selected_ids: string[] = []) => ({ ok: true, json: async () => ({ selected_ids, clips: [] }) });

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	localStorage.clear();
	window.getSelection()?.removeAllRanges();
	const saved = new Set<string>();
	fetcher = vi.fn(async (url, options) => {
		if (String(url).endsWith('/update_checkboxes')) {
			for (const { id, checked } of JSON.parse(options.body).updates) {
				if (checked) saved.add(id); else saved.delete(id);
			}
		}
		return response(['a', 'b', 'c'].filter((id) => saved.has(id)));
	});
	vi.stubGlobal('fetch', fetcher);
	vi.stubGlobal('WebSocket', class { static OPEN = 1; static CLOSED = 3; readyState = 3; close() {} });
	vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
	vi.stubGlobal('documentPictureInPicture', { requestWindow: vi.fn() });
	vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
	hit = null;
	Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => hit) });
	svelte = await import('svelte');
	stores = await import('../src/stores/stores');
	stores.enableLineAnimation$.next(false);
	stores.autoTranslateLines$.next(false);
	const { default: App } = await import('../src/components/App.svelte');
	app = svelte.mount(App, { target: document.body });
	await settle();
	for (const [index, id] of ['a', 'b', 'c'].entries()) {
		stores.newLine$.next([`台詞${id}`, LineType.SOCKET, id, { streamSequence: index + 1, revision: 1, recordState: 'frozen', gsmStatus: 'active' }]);
	}
	await settle();
});

afterEach(async () => {
	await svelte.unmount(app);
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete (document as Partial<Document>).elementFromPoint;
	document.body.replaceChildren();
	localStorage.clear();
});

async function settle() {
	await svelte.tick();
	await vi.advanceTimersByTimeAsync(300);
	await svelte.tick();
}

function checked(id: string) { return row(id).classList.contains('mining-selected'); }
function keyToggle(id: string, shiftKey = false) {
	const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, shiftKey });
	row(id).dispatchEvent(event);
	return event;
}
function commits() { return fetcher.mock.calls.filter(([url]) => String(url).endsWith('/update_checkboxes')); }
function pointer(target: EventTarget, type: string, options: MouseEventInit = {}) {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 220, ...options });
	Object.defineProperty(event, 'pointerId', { value: 1 });
	target.dispatchEvent(event);
	return event;
}

function row(id: string) { return document.querySelector(`[data-line-id="${id}"]`)!; }
function source(id: string) { return row(id).querySelector('.line-source')!; }

test.each(['text', 'padding'])('clicking row %s toggles mining', async (part) => {
	const target = part === 'text' ? source('b') : row('b');
	pointer(target, 'pointerdown');
	pointer(window, 'pointerup');
	target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
	await settle();
	expect(checked('b')).toBe(true);
	expect(commits()).toHaveLength(1);
	target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
	await settle();
	expect(checked('b')).toBe(false);
});

test('a drag within one row preserves native text selection without mining it', async () => {
	const text = source('a');
	expect(pointer(text, 'pointerdown', { clientX: 70 }).defaultPrevented).toBe(false);
	hit = text;
	const range = document.createRange();
	range.selectNodeContents(text);
	window.getSelection()!.addRange(range);
	const selected = window.getSelection()!.toString();
	expect(pointer(window, 'pointermove', { clientX: 140 }).defaultPrevented).toBe(false);
	pointer(window, 'pointerup');
	text.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
	await settle();
	expect(window.getSelection()!.toString()).toBe(selected);
	expect(checked('a')).toBe(false);
	expect(commits()).toHaveLength(0);
});

test('a text drag crossing rows becomes a mining range and suppresses the trailing click', async () => {
	pointer(source('a'), 'pointerdown', { clientX: 70 });
	await svelte.tick();
	expect(checked('a')).toBe(false);
	hit = source('c');
	expect(pointer(window, 'pointermove', { clientX: 140, clientY: 300 }).defaultPrevented).toBe(true);
	await svelte.tick();
	expect(['a', 'b', 'c'].map(checked)).toEqual([true, true, true]);
	expect(commits()).toHaveLength(0);
	pointer(window, 'pointerup');
	source('a').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
	await settle();
	expect(['a', 'b', 'c'].map(checked)).toEqual([true, true, true]);
	expect(commits()).toHaveLength(1);
});

test('dragging from selected row text clears the crossed range', async () => {
	keyToggle('a');
	await settle();
	keyToggle('c', true);
	await settle();
	pointer(source('c'), 'pointerdown', { clientX: 70 });
	hit = source('a');
	pointer(window, 'pointermove', { clientX: 140, clientY: 300 });
	pointer(window, 'pointerup');
	await settle();
	expect(['a', 'b', 'c'].map(checked)).toEqual([false, false, false]);
});

test('double-click editing leaves the original mining selection and buttons do not toggle it', async () => {
	const text = source('a');
	for (const detail of [1, 2]) {
		text.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
		await svelte.tick();
	}
	text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
	await settle();
	expect(text.getAttribute('contenteditable')).toBe('true');
	expect(checked('a')).toBe(false);
	(row('b').querySelector('[title="More line actions"]') as HTMLButtonElement).click();
	await settle();
	expect(checked('b')).toBe(false);
});

test('rows have no checkboxes and support keyboard mining directly', async () => {
	expect(document.querySelector('[role="checkbox"], .mining-selector')).toBeNull();
	expect((row('a') as HTMLElement).tabIndex).toBe(0);
	source('a').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
	await settle();
	expect(row('a').classList.contains('mining-selected')).toBe(true);
	expect(keyToggle('a').defaultPrevented).toBe(true);
	await settle();
	expect(row('a').classList.contains('mining-selected')).toBe(false);
});

test('drag highlights a range, shrinks when moved back, and commits once on release', async () => {
	pointer(source('a'), 'pointerdown', { clientX: 70 });
	await svelte.tick();
	hit = document.querySelector('[data-line-id="c"] .line-source');
	pointer(window, 'pointermove', { clientX: 140, clientY: 300 });
	await svelte.tick();
	expect(['a', 'b', 'c'].map(checked)).toEqual([true, true, true]);
	hit = document.querySelector('[data-line-id="b"] .line-source');
	pointer(window, 'pointermove', { clientX: 140, clientY: 260 });
	await svelte.tick();
	expect(['a', 'b', 'c'].map(checked)).toEqual([true, true, false]);
	expect(commits()).toHaveLength(0);
	fetcher.mockResolvedValue(response(['a', 'b']));
	pointer(window, 'pointerup');
	await settle();
	expect(commits()).toHaveLength(1);
	expect(JSON.parse(commits()[0][1].body)).toEqual({ updates: [{ id: 'a', checked: true }, { id: 'b', checked: true }] });
	expect(document.querySelector('[aria-label="Mining selection"]')?.textContent).toContain('to mine 2 lines');
});

test.each([1, 2])('the mining hint links to GSM Yomitan setup and shows %i selected lines', async (count) => {
	for (const id of ['a', 'b'].slice(0, count)) {
		source(id).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		await settle();
	}
	const hint = document.querySelector('.mining-summary')!;
	expect(hint.textContent?.replace(/\s+/g, ' ').trim()).toBe(`Create card with Yomitan to mine ${count} ${count === 1 ? 'line' : 'lines'}`);
	const link = hint.querySelector('a')!;
	expect(link.textContent).toBe('Yomitan');
	expect(link.getAttribute('href')).toBe('https://docs.gamesentenceminer.com/docs/getting-started/yomitan-anki/');
	expect(link.getAttribute('target')).toBe('_blank');
});

test('Shift-click selects the anchored range and Escape clears it', async () => {
	fetcher.mockResolvedValue(response(['a']));
	keyToggle('a');
	await settle();
	fetcher.mockResolvedValue(response(['a', 'b', 'c']));
	keyToggle('c', true);
	await settle();
	expect(['a', 'b', 'c'].map(checked)).toEqual([true, true, true]);
	fetcher.mockResolvedValue(response());
	window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
	await settle();
	expect(['a', 'b', 'c'].map(checked)).toEqual([false, false, false]);
	expect(JSON.parse(commits().at(-1)![1].body).updates).toEqual(['a', 'b', 'c'].map((id) => ({ id, checked: false })));
});

test('cancelled pointer gestures restore selection without touching mining state', async () => {
	pointer(source('b'), 'pointerdown', { clientX: 70 });
	hit = source('c');
	pointer(window, 'pointermove', { clientX: 140, clientY: 300 });
	await svelte.tick();
	expect(checked('b')).toBe(true);
	pointer(window, 'pointercancel');
	await settle();
	expect(checked('b')).toBe(false);
	expect(commits()).toHaveLength(0);
});

test('failed batches retain changes from a later click and retry explicit states', async () => {
	let reject!: (error: Error) => void;
	fetcher.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
	keyToggle('a');
	await svelte.tick();
	keyToggle('b');
	await svelte.tick();
	reject(new Error('offline'));
	await settle();
	expect(document.querySelector('[aria-label="Mining selection"]')?.textContent).toContain('Could not save');
	fetcher.mockResolvedValue(response(['a', 'b']));
	(document.querySelector('[aria-label="Mining selection"] button') as HTMLButtonElement).click();
	await settle();
	expect(['a', 'b', 'c'].map(checked)).toEqual([true, true, false]);
	expect(JSON.parse(commits().at(-1)![1].body).updates).toEqual([{ id: 'b', checked: true }, { id: 'a', checked: true }]);
});

test('retrying after a cancelled drag saves the restored selection', async () => {
	let reject!: (error: Error) => void;
	fetcher.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
	keyToggle('a');
	await svelte.tick();
	pointer(source('a'), 'pointerdown', { clientX: 70 });
	hit = source('b');
	pointer(window, 'pointermove', { clientX: 140, clientY: 300 });
	await svelte.tick();
	reject(new Error('offline'));
	await settle();
	pointer(window, 'pointercancel');
	await svelte.tick();
	expect(checked('a')).toBe(true);
	fetcher.mockResolvedValue(response(['a']));
	(document.querySelector('[aria-label="Mining selection"] button') as HTMLButtonElement).click();
	await settle();
	expect(JSON.parse(commits().at(-1)![1].body).updates).toEqual([{ id: 'a', checked: true }]);
});

test('an authoritative expiry clears selection even when the reader is paused', async () => {
	keyToggle('a');
	await settle();
	stores.isPaused$.next(true);
	stores.newLine$.next(['', LineType.RESETCHECKBOXES, '']);
	await settle();
	expect(checked('a')).toBe(false);
	expect(document.querySelector('[aria-label="Mining selection"]')).toBeNull();
});

test.each([false, true])('expiry clears a selection request still in flight (request fails: %s)', async (fails) => {
	let complete!: (value: unknown) => void;
	let reject!: (error: Error) => void;
	fetcher.mockImplementationOnce(() => new Promise((resolve, fail) => { complete = resolve; reject = fail; }));
	keyToggle('a');
	await svelte.tick();
	expect(checked('a')).toBe(true);
	stores.newLine$.next(['', LineType.RESETCHECKBOXES, '']);
	await svelte.tick();
	if (fails) reject(new Error('late failure'));
	else complete(response(['a']));
	await settle();
	expect(checked('a')).toBe(false);
	expect(commits()).toHaveLength(2);
	expect(JSON.parse(commits().at(-1)![1].body).updates).toEqual([{ id: 'a', checked: false }]);
	expect(document.querySelector('[aria-label="Mining selection"]')).toBeNull();
});
