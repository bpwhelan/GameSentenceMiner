import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LineType } from '../src/types';

let svelte: typeof import('svelte');
let stores: typeof import('../src/stores/stores');
let app: ReturnType<typeof import('svelte').mount> | undefined;
let main: HTMLElement;

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
		[...container.querySelectorAll('p')].reduce(
			(total, paragraph) => total + Math.ceil((paragraph.textContent?.length ?? 0) / 12) * 40,
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
		get position() {
			return position;
		},
		set position(value: number) {
			position = value;
		},
	};
}

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
