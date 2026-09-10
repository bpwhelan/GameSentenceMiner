import { tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LineType } from '../src/types';

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
	vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
	vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
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
