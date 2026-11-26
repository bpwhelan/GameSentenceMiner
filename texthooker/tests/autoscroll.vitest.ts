import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LineType } from '../src/types';

let svelte: typeof import('svelte');
let stores: typeof import('../src/stores/stores');
let app: ReturnType<typeof import('svelte').mount> | undefined;
let main: HTMLElement;
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	localStorage.clear();
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise(() => {})),
	);
	vi.stubGlobal(
		'WebSocket',
		class {
			static OPEN = 1;
			static CLOSED = 3;
			readyState = WebSocket.CLOSED;
			close() {}
		},
	);
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false })),
	);
	vi.stubGlobal('documentPictureInPicture', { requestWindow: vi.fn() });
	vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
	Object.defineProperty(Element.prototype, 'animate', {
		configurable: true,
		value: () => {
			const animation = { onfinish: null as (() => void) | null, cancel() {} };
			queueMicrotask(() => animation.onfinish?.());
			return animation;
		},
	});

	svelte = await import('svelte');
	stores = await import('../src/stores/stores');
	stores.enableLineAnimation$.next(false);
	const { default: App } = await import('../src/components/App.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	app = svelte.mount(App, { target });
	await settleLayout();
	main = document.querySelector('main')!;
});

afterEach(async () => {
	if (app) await svelte.unmount(app);
	app = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
	else Reflect.deleteProperty(Element.prototype, 'animate');
	document.body.replaceChildren();
	localStorage.clear();
});

async function settleLayout() {
	await svelte.tick();
	await svelte.tick();
	await vi.advanceTimersByTimeAsync(300);
}

// jsdom has no layout. Derive the scroll extent from the rendered paragraphs so
// measuring before vs. after a text update produces different scroll decisions.
function modelScroll(view: Window, container: HTMLElement, vertical = false, reverse = false) {
	const viewport = 600;
	const extent = () =>
		viewport +
		[...container.querySelectorAll('.line-source, .translation-text')].reduce(
			(total, paragraph) => total + (paragraph.closest('[hidden]') ? 0 : Math.ceil((paragraph.textContent?.length ?? 0) / 12) * 40),
			0,
		);
	Object.defineProperties(container, {
		scrollHeight: { configurable: true, get: extent },
		scrollWidth: { configurable: true, get: extent },
		clientWidth: { configurable: true, get: () => viewport },
	});
	vi.spyOn(view, 'innerHeight', 'get').mockReturnValue(viewport);
	let position = 0;
	const newest = () => (vertical ? (reverse ? 1 : -1) * (extent() - viewport) : reverse ? 0 : extent() - viewport);
	Object.defineProperty(container, 'scrollLeft', { configurable: true, get: () => position });
	vi.spyOn(view, 'scrollY', 'get').mockImplementation(() => position);
	const scroll = vi.fn((options: ScrollToOptions) => {
		const max = extent() - viewport;
		position = vertical
			? reverse
				? Math.min(max, Math.max(0, options.left ?? 0))
				: Math.max(-max, Math.min(0, options.left ?? 0))
			: Math.min(max, Math.max(0, options.top ?? 0));
	});
	if (vertical) {
		container.scrollTo = scroll;
	} else {
		vi.spyOn(view, 'scrollTo').mockImplementation(scroll);
	}
	return {
		scroll,
		newest,
		oldest: () => !vertical && reverse ? extent() - viewport : 0,
		get position() {
			return position;
		},
		set position(value: number) {
			position = value;
		},
	};
}

test.each([
	{ vertical: false, reverse: false },
	{ vertical: false, reverse: true },
	{ vertical: true, reverse: false },
	{ vertical: true, reverse: true },
])('scrolling into history prepends in place and returning to newest compacts the view in layout %j', async ({ vertical, reverse }) => {
	stores.displayVertical$.next(vertical);
	stores.reverseLineOrder$.next(reverse);
	const viewport = modelScroll(window, main, vertical, reverse);
	const rows = () => [...main.querySelectorAll<HTMLElement>('.textline2')];
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
		const rendered = rows();
		const index = rendered.indexOf(this);
		const x = vertical ? (reverse ? index : -index) * 40 - viewport.position : 0;
		const y = !vertical ? (reverse ? rendered.length - 1 - index : index) * 40 - viewport.position : 0;
		return new DOMRect(x, y, 40, 40);
	});
	const lines = Array.from({ length: 95 }, (_, index) => ({ id: `history-${index}`, text: `文章 ${index}` }));
	const renderedIds = () => rows().map((row) => row.dataset.lineId);
	const goTo = async (position: number) => {
		viewport.position = position;
		(vertical ? main : document).dispatchEvent(new Event('scroll'));
		await settleLayout();
	};
	stores.lineData$.next(lines);
	await settleLayout();
	expect(renderedIds()).toEqual(lines.slice(-40).map((line) => line.id));

	const anchor = rows()[0];
	viewport.position = viewport.oldest();
	const anchorPosition = () => {
		const bounds = anchor.getBoundingClientRect();
		return vertical ? bounds.left : bounds.top;
	};
	const before = anchorPosition();
	await goTo(viewport.oldest());
	expect(renderedIds()).toEqual(lines.slice(-80).map((line) => line.id));
	expect(Math.abs(anchorPosition() - before)).toBe(0);

	await goTo(viewport.oldest());
	expect(renderedIds()).toEqual(lines.map((line) => line.id));
	await receiveLine('新しい文章。', 1, 'new');
	expect(renderedIds().at(-1)).toBe('new');
	expect(viewport.position).not.toBe(viewport.newest());

	await goTo(viewport.newest());
	const allLines = stores.lineData$.getValue();
	expect(allLines).toHaveLength(96);
	expect(renderedIds()).toEqual(allLines.slice(-40).map((line) => line.id));
	await receiveLine('もっと新しい文章。', 1, 'newest');
	expect(renderedIds()).toHaveLength(40);
	expect(renderedIds().at(-1)).toBe('newest');
	expect(viewport.position).toBe(viewport.newest());
});

async function receiveLine(text: string, revision: number, id = 'speech', extra = {}) {
	stores.newLine$.next([
		text,
		LineType.SOCKET,
		id,
		{
			streamSequence: id === 'speech' ? 1 : 2,
			revision,
			recordState: 'provisional',
			gsmStatus: 'active',
			...extra,
		},
	]);
	await settleLayout();
}

test.each([false, true])('scroll alone pages through saved game history past the live cap with auto-translate=%s', async (autoTranslate) => {
	const scene = 'Reading scene';
	stores.autoTranslateLines$.next(autoTranslate);
	stores.maxLines$.next(50);
	const viewport = modelScroll(window, main);
	const live = Array.from({ length: 50 }, (_, i) => ({ id: `live-${i}`, text: `台詞 ${i}`, scene }));
	const archive = Array.from({ length: 51 }, (_, i) => ({ id: `saved-${i}`, text: `履歴 ${i}` }));
	const cursor = { beforeTimestamp: 1000, beforeRowid: 12 };
	const fetcher = vi.mocked(fetch);
	fetcher.mockResolvedValueOnce({
		ok: true, json: async () => ({ scene, lines: [...archive.slice(-40), live[0]], hasMore: true, nextCursor: cursor }),
	} as Response);
	fetcher.mockResolvedValueOnce({
		ok: true, json: async () => ({ scene, lines: archive.slice(0, 11), hasMore: false, nextCursor: null }),
	} as Response);
	stores.lineData$.next(live);
	stores.textfeedSessionSync$.next({
		sessionId: 'reading', scene, orderedIds: [], activeIds: [], timedOutIds: [], missingLines: [], requestedIds: [],
	});
	await settleLayout();
	const goTo = async (position: number) => {
		viewport.position = position;
		document.dispatchEvent(new Event('scroll'));
		await settleLayout();
	};
	const renderedIds = () => [...main.querySelectorAll<HTMLElement>('[data-line-id]:not([hidden])')].map((row) => row.dataset.lineId);
	const historyRequests = () => fetcher.mock.calls
		.filter(([url]) => String(url).endsWith('/api/textfeed/history'))
		.map(([, options]) => JSON.parse(String(options?.body)));

	await goTo(viewport.oldest()); // Reveal the rest of the local 50-line window.
	await goTo(viewport.oldest());
	expect(renderedIds()).toEqual([...archive.slice(-40), ...live].map((line) => line.id));
	await goTo(viewport.oldest());
	expect(renderedIds()).toEqual([...archive, ...live].map((line) => line.id));
	await goTo(viewport.oldest());
	expect(historyRequests()).toEqual([{ scene, beforeLineId: live[0].id }, { scene, cursor }]);
	expect(stores.lineData$.getValue().map(({ id }) => id)).toEqual(live.map(({ id }) => id));
	expect(main.querySelector('.load-older')).toBeNull();
	expect(document.querySelector('[aria-label="Transcript search"]')).toBeNull();
	await goTo(viewport.newest());
	expect(renderedIds()).toEqual(live.slice(-40).map(({ id }) => id));
});

test.each([false, true])('search includes saved matches and clearing restores the latest page with auto-translate=%s', async (autoTranslate) => {
	stores.autoTranslateLines$.next(autoTranslate);
	const scene = 'Search game';
	const viewport = modelScroll(window, main);
	const live = Array.from({ length: 45 }, (_, i) => ({
		id: `live-${i}`, text: i === 0 || i === 42 ? '猫' : '犬', scene,
	}));
	stores.lineData$.next([...live, { id: 'other', text: '猫', scene: 'Different game' }]);
	stores.textfeedSessionSync$.next({
		sessionId: 'search', scene, orderedIds: [], activeIds: [], timedOutIds: [], missingLines: [], requestedIds: [],
	});
	await settleLayout();
	const archive = Array.from({ length: 50 }, (_, i) => ({ id: `saved-${i}`, text: '猫' }));
	vi.mocked(fetch).mockResolvedValueOnce({
		ok: true, json: async () => ({ scene, lines: [...archive, live[0]], hasMore: false }),
	} as Response);
	document.querySelector<HTMLButtonElement>('button[aria-label="Search transcript"]')!.click();
	await settleLayout();
	const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
	const type = async (value: string) => {
		input.value = value;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settleLayout();
	};
	const ids = () => [...main.querySelectorAll<HTMLElement>('[data-line-id]:not([hidden])')].map(row => row.dataset.lineId);
	await type('猫');
	const options = vi.mocked(fetch).mock.calls.findLast(([url]) => String(url).endsWith('/api/textfeed/history'))?.[1];
	expect(JSON.parse(String(options?.body))).toEqual({ scene, query: '猫', allMatches: true });
	expect(ids()).toEqual([...archive.slice(-38), live[0], live[42]].map(line => line.id));
	expect(viewport.position).toBe(viewport.newest());
	viewport.position = viewport.oldest();
	document.dispatchEvent(new Event('scroll'));
	await settleLayout();
	expect(ids()[0]).toBe('saved-0');
	await type('');
	expect(ids()).toEqual(stores.lineData$.getValue().slice(-40).map(line => line.id));
	expect(viewport.position).toBe(viewport.newest());
});

test('an empty replay snapshot opens the newest saved lines so the reader can scroll immediately', async () => {
	const viewport = modelScroll(window, main);
	const scene = 'Previously played game';
	const archive = Array.from({ length: 40 }, (_, i) => ({ id: `saved-${i}`, text: `履歴 ${i}` }));
	vi.mocked(fetch).mockResolvedValueOnce({
		ok: true, json: async () => ({ scene, lines: archive, hasMore: false, nextCursor: null }),
	} as Response);
	stores.textfeedSessionSync$.next({
		sessionId: 'restart', scene, orderedIds: [], activeIds: [], timedOutIds: [], missingLines: [], requestedIds: [],
	});
	await settleLayout();
	expect([...main.querySelectorAll<HTMLElement>('[data-line-id]')].map((row) => row.dataset.lineId))
		.toEqual(archive.map((line) => line.id));
	expect(viewport.position).toBe(viewport.newest());
	expect(stores.lineData$.getValue()).toEqual([]);
});

test('finalizing a line during auto-translation does not send a second translation request', async () => {
	stores.autoTranslateLines$.next(true);
	const fetcher = vi.fn((_url: RequestInfo | URL) => new Promise(() => {}));
	vi.stubGlobal('fetch', fetcher);
	await receiveLine('翻訳する台詞。', 1, 'speech', { recordState: undefined });
	const translationCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/translate-line'));
	expect(translationCalls()).toHaveLength(1);
	await receiveLine('翻訳する台詞。', 2, 'speech', { recordState: 'frozen' });
	expect(translationCalls()).toHaveLength(1);
});

test('a completed line auto-translates on its initial append without a later freeze event', async () => {
	stores.autoTranslateLines$.next(true);
	const fetcher = vi.fn((_url: RequestInfo | URL) => new Promise(() => {}));
	vi.stubGlobal('fetch', fetcher);
	await receiveLine('取り込み時に完成した台詞。', 1, 'speech', { recordState: 'frozen' });
	expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/translate-line'))).toHaveLength(1);
});

test.each([
	{ vertical: false, reverse: false },
	{ vertical: false, reverse: true },
	{ vertical: true, reverse: false },
	{ vertical: true, reverse: true },
])('the latest translation follows to the same padded end as a new line in layout %j', async ({ vertical, reverse }) => {
	stores.displayVertical$.next(vertical);
	stores.reverseLineOrder$.next(reverse);
	const viewport = modelScroll(window, main, vertical, reverse);
	await receiveLine('最後の台詞。', 1);
	let complete!: (value: unknown) => void;
	vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { complete = resolve; })));
	const row = main.querySelector('.textline2') as HTMLElement;
	row.scrollIntoView = vi.fn();
	(row.querySelector('[title="Translate"]') as HTMLButtonElement).click();
	viewport.scroll.mockClear();
	complete({ ok: true, json: async () => ({ TL: 'A long translated sentence. '.repeat(20) }) });
	await settleLayout();
	expect(viewport.scroll).toHaveBeenCalled();
	expect(viewport.position).toBe(viewport.newest());
	if (!vertical && !reverse) expect(viewport.scroll).toHaveBeenLastCalledWith({ top: main.scrollHeight + 100, left: 0, behavior: 'auto' });
});

test('a delayed translation does not pull the reader back down after they scroll away', async () => {
	const viewport = modelScroll(window, main);
	await receiveLine('長い最後の台詞。'.repeat(40), 1);
	let complete!: (value: unknown) => void;
	vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { complete = resolve; })));
	const row = main.querySelector('.textline2') as HTMLElement;
	row.scrollIntoView = vi.fn();
	(row.querySelector('[title="Translate"]') as HTMLButtonElement).click();
	viewport.position = 100;
	viewport.scroll.mockClear();
	complete({ ok: true, json: async () => ({ TL: 'A long translated sentence. '.repeat(20) }) });
	await settleLayout();
	expect(viewport.scroll).not.toHaveBeenCalled();
	expect(viewport.position).toBe(100);
});

test.each([
	{ vertical: false, reverse: false },
	{ vertical: false, reverse: true },
	{ vertical: true, reverse: false },
	{ vertical: true, reverse: true },
])('follows repeated speech revisions in layout %j', async ({ vertical, reverse }) => {
	stores.displayVertical$.next(vertical);
	stores.reverseLineOrder$.next(reverse);
	const viewport = modelScroll(window, main, vertical, reverse);
	await receiveLine('認識中の文章。', 1);
	expect(viewport.position).toBe(viewport.newest());

	for (let revision = 2; revision <= 8; revision += 1) {
		viewport.scroll.mockClear();
		await receiveLine('音声認識の長い文章。'.repeat(revision * 12), revision);
		expect(main.querySelectorAll('.textline2')).toHaveLength(1);
		expect(viewport.scroll).toHaveBeenCalled();
		expect(viewport.position).toBe(viewport.newest());
	}

	await receiveLine('次の文章。', 1, 'next');
	expect(viewport.position).toBe(viewport.newest());
});

test('scrolling up pauses following revisions, and returning to the bottom resumes it', async () => {
	const viewport = modelScroll(window, main);
	await receiveLine('認識中の長い文章。'.repeat(40), 1);
	viewport.position = 100;
	viewport.scroll.mockClear();
	await receiveLine('認識中の長い文章。'.repeat(60), 2);
	expect(viewport.scroll).not.toHaveBeenCalled();
	expect(viewport.position).toBe(100);

	viewport.position = viewport.newest();
	await receiveLine('認識中の長い文章。'.repeat(80), 3);
	expect(viewport.scroll).toHaveBeenCalled();
	expect(viewport.position).toBe(viewport.newest());
});

test('always-scroll mode also follows revisions when scrolled away', async () => {
	const viewport = modelScroll(window, main);
	await receiveLine('認識中の長い文章。'.repeat(40), 1);
	stores.alwaysScrollToNewest$.next(true);
	viewport.position = 100;
	viewport.scroll.mockClear();
	await receiveLine('認識中の長い文章。'.repeat(60), 2);
	expect(viewport.scroll).toHaveBeenCalled();
	expect(viewport.position).toBe(viewport.newest());
});

test('older lines, stale revisions, and status-only updates do not trigger scrolling', async () => {
	const viewport = modelScroll(window, main);
	await receiveLine('前の文章。', 1);
	await receiveLine('最新の文章。', 2, 'next');
	viewport.scroll.mockClear();
	await receiveLine('訂正された前の文章。', 2);
	await receiveLine('古い更新。', 1, 'next');
	await receiveLine('最新の文章。', 3, 'next', { recordState: 'frozen' });
	expect(viewport.scroll).not.toHaveBeenCalled();
});

test.each([false, true])(
	'main and floating windows follow independently (main at bottom: %s)',
	async (mainAtBottom) => {
		const frame = document.createElement('iframe');
		document.body.appendChild(frame);
		const pipWindow = frame.contentWindow!;
		vi.mocked(window.documentPictureInPicture.requestWindow).mockResolvedValue(pipWindow);
		(document.querySelector('[title="Open Floating Window"]') as HTMLElement)
			.querySelector('svg')!
			.dispatchEvent(new MouseEvent('click'));
		await settleLayout();
		const pipContainer = pipWindow.document.getElementById('pip-container')!;
		expect(pipContainer).not.toBeNull();
		const mainViewport = modelScroll(window, main);
		const pipViewport = modelScroll(pipWindow, pipContainer);
		await receiveLine('認識中の長い文章。'.repeat(40), 1);
		mainViewport.position = mainAtBottom ? mainViewport.newest() : 100;
		pipViewport.position = mainAtBottom ? 100 : pipViewport.newest();
		mainViewport.scroll.mockClear();
		pipViewport.scroll.mockClear();
		await receiveLine('認識中の長い文章。'.repeat(60), 2);
		expect(mainViewport.scroll.mock.calls.length > 0).toBe(mainAtBottom);
		expect(pipViewport.scroll.mock.calls.length > 0).toBe(!mainAtBottom);
		expect(mainViewport.position).toBe(mainAtBottom ? mainViewport.newest() : 100);
		expect(pipViewport.position).toBe(mainAtBottom ? 100 : pipViewport.newest());
		pipWindow.dispatchEvent(new Event('pagehide'));
		await svelte.tick();
	},
);
