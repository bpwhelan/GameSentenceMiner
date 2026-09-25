import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LineType } from '../src/types';

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
	vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
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
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		value: vi.fn(() => ({ matches: false })),
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

test('the compiled application starts without an uncaught initialization error', async () => {
	const { default: App } = await import('../src/components/App.svelte');
	const app = (await import('svelte')).mount(App, { target: document.body });

	await tick();
	expect(document.querySelector('main')).not.toBeNull();

	await unmount(app);
});

test('an open WebSocket shows only the connected color', async () => {
	const { socketState$ } = await import('../src/stores/stores');
	const { default: SocketConnector } = await import('../src/components/SocketConnector.svelte');
	const connector = (await import('svelte')).mount(SocketConnector, { target: document.body });

	await tick();
	socketState$.next(WebSocket.OPEN);
	await tick();

	const indicator = document.querySelector('div.text-green-700');
	expect(indicator).not.toBeNull();
	expect(indicator?.classList.contains('text-green-700')).toBe(true);
	expect(indicator?.classList.contains('text-red-500')).toBe(false);

	await unmount(connector);
	socketState$.next(-1);
});

test('replay-buffer expiry does not restart the TextFeed timer', async () => {
	const { default: App } = await import('../src/components/App.svelte');
	const { autoStartTimerDuringPause$, isPaused$, newLine$ } = await import('../src/stores/stores');

	autoStartTimerDuringPause$.next(true);
	isPaused$.next(true);
	const app = (await import('svelte')).mount(App, { target: document.body });

	await tick();
	newLine$.next([
		'expired line',
		LineType.SOCKET,
		'expired-line',
		{
			gsmSessionId: 'session',
			gsmStatus: 'timed_out',
			streamSequence: 1,
			recordState: 'expired',
		},
	]);
	await tick();

	expect(isPaused$.getValue()).toBe(true);

	newLine$.next([
		'active line',
		LineType.SOCKET,
		'active-line',
		{
			gsmSessionId: 'session',
			gsmStatus: 'active',
			streamSequence: 2,
			recordState: 'frozen',
		},
	]);
	await tick();

	expect(isPaused$.getValue()).toBe(false);

	await unmount(app);
	isPaused$.next(true);
	autoStartTimerDuringPause$.next(false);
});

describe('incoming lines during pause', () => {
	let app: ReturnType<typeof mount>;
	let stores: typeof import('../src/stores/stores');

	beforeEach(async () => {
		stores = await import('../src/stores/stores');
		stores.lineData$.next([]);
		stores.lineIDs$.next([]);
		stores.timedOutIDs$.next([]);
		stores.allowNewLineDuringPause$.next(false);
		stores.allowPasteDuringPause$.next(false);
		stores.autoStartTimerDuringPause$.next(false);
		stores.autoStartTimerDuringPausePaste$.next(false);
		stores.isPaused$.next(true);
		const { default: App } = await import('../src/components/App.svelte');
		app = mount(App, { target: document.body });
		await tick();
	});

	afterEach(async () => {
		await unmount(app);
		stores.lineData$.next([]);
		stores.lineIDs$.next([]);
		stores.timedOutIDs$.next([]);
		stores.allowNewLineDuringPause$.next(stores.defaultSettings.allowNewLineDuringPause$);
		stores.allowPasteDuringPause$.next(stores.defaultSettings.allowPasteDuringPause$);
		stores.autoStartTimerDuringPause$.next(stores.defaultSettings.autoStartTimerDuringPause$);
		stores.autoStartTimerDuringPausePaste$.next(stores.defaultSettings.autoStartTimerDuringPausePaste$);
		stores.isPaused$.next(true);
	});

	test.each(['v2', 'legacy'] as const)('%s new lines respect the pause setting', async (protocol) => {
		const metadata = protocol === 'v2' ? { streamSequence: 1, revision: 1, gsmStatus: 'active' as const } : {};
		stores.newLine$.next(['blocked line', LineType.SOCKET, 'blocked', metadata]);
		await tick();

		expect(stores.lineData$.getValue()).toEqual([]);
		expect(stores.lineIDs$.getValue()).toEqual([]);
		expect(stores.isPaused$.getValue()).toBe(true);
		expect(document.querySelectorAll('main .textline2')).toHaveLength(0);

		stores.allowNewLineDuringPause$.next(true);
		stores.newLine$.next(['allowed line', LineType.SOCKET, 'allowed', metadata]);
		await tick();

		expect(stores.lineData$.getValue().map((line) => line.id)).toEqual(['allowed']);
		expect(stores.isPaused$.getValue()).toBe(true);
		expect(document.querySelectorAll('main .textline2')).toHaveLength(1);

		stores.allowNewLineDuringPause$.next(false);
		stores.isPaused$.next(false);
		stores.newLine$.next(['resumed line', LineType.SOCKET, 'resumed', metadata]);
		await tick();

		expect(stores.lineData$.getValue().map((line) => line.id)).toEqual(['allowed', 'resumed']);
	});

	test('v2 corrections and expiry still update existing lines while new lines are blocked', async () => {
		const metadata = { streamSequence: 1, revision: 1, gsmStatus: 'active' as const };
		stores.lineData$.next([{ id: 'existing', text: 'draft', ...metadata, recordState: 'provisional' }]);
		stores.lineIDs$.next(['existing']);
		await tick();

		stores.newLine$.next([
			'corrected line',
			LineType.SOCKET,
			'existing',
			{ ...metadata, revision: 2, recordState: 'frozen' },
		]);
		await tick();
		expect(stores.lineData$.getValue()).toEqual([
			expect.objectContaining({ id: 'existing', text: 'corrected line', revision: 2, recordState: 'frozen' }),
		]);

		stores.autoStartTimerDuringPause$.next(true);
		stores.newLine$.next([
			'corrected line',
			LineType.SOCKET,
			'existing',
			{ ...metadata, revision: 3, gsmStatus: 'timed_out', recordState: 'expired' },
		]);
		await tick();
		expect(stores.lineData$.getValue()).toEqual([
			expect.objectContaining({ id: 'existing', revision: 3, gsmStatus: 'timed_out', recordState: 'expired' }),
		]);
		expect(stores.lineIDs$.getValue()).toEqual([]);
		expect(stores.timedOutIDs$.getValue()).toEqual(['existing']);
		expect(stores.isPaused$.getValue()).toBe(true);
	});

	test.each(['v2', 'legacy'] as const)('%s new lines can autostart the timer', async (protocol) => {
		stores.autoStartTimerDuringPause$.next(true);
		stores.newLine$.next([
			'autostart line',
			LineType.SOCKET,
			'autostart',
			protocol === 'v2' ? { streamSequence: 1, revision: 1, gsmStatus: 'active' } : {},
		]);
		await tick();

		expect(stores.lineData$.getValue().map((line) => line.id)).toEqual(['autostart']);
		expect(stores.isPaused$.getValue()).toBe(false);
	});

	test.each([false, true])('expiry respects allow-new-line=%s without autostarting', async (allowNewLine) => {
		stores.allowNewLineDuringPause$.next(allowNewLine);
		stores.autoStartTimerDuringPause$.next(true);
		stores.newLine$.next([
			'expired line',
			LineType.SOCKET,
			'expired',
			{ streamSequence: 1, revision: 2, gsmStatus: 'timed_out', recordState: 'expired' },
		]);
		await tick();

		expect(stores.lineData$.getValue().map((line) => line.id)).toEqual(allowNewLine ? ['expired'] : []);
		expect(stores.isPaused$.getValue()).toBe(true);
	});

	test('paste permission is independent of the new-line permission', async () => {
		stores.allowNewLineDuringPause$.next(true);
		stores.newLine$.next(['blocked paste', LineType.PASTE, 'blocked-paste']);
		await tick();
		expect(stores.lineData$.getValue()).toEqual([]);

		stores.allowNewLineDuringPause$.next(false);
		stores.allowPasteDuringPause$.next(true);
		stores.newLine$.next(['allowed paste', LineType.PASTE, 'allowed-paste']);
		await tick();
		expect(stores.lineData$.getValue().map((line) => line.id)).toEqual(['allowed-paste']);
		expect(stores.isPaused$.getValue()).toBe(true);
	});
});
