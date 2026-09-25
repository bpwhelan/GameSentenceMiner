import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LineItem } from '../src/types';

const sessionId = 'persisted-session';
const linesStorageKey = 'bannou-texthooker-lineData';
const timerStorageKey = 'bannou-texthooker-timeValue';
const persistedLines: LineItem[] = [
	{
		id: 'history',
		text: '昔の文章',
		translation: 'Saved translation',
		gsmSessionId: sessionId,
		gsmStatus: 'timed_out',
		streamSequence: 1,
		revision: 3,
		recordState: 'expired',
	},
	{
		id: 'recent',
		text: '読みかけ',
		gsmSessionId: sessionId,
		gsmStatus: 'active',
		streamSequence: 2,
		revision: 1,
		recordState: 'provisional',
	},
];
const recentRecord = {
	id: 'recent',
	text: '読み終わり',
	session_id: sessionId,
	stream_sequence: 2,
	revision: 2,
	state: 'frozen',
};

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: MockWebSocket[] = [];
	readyState = MockWebSocket.CONNECTING;
	onopen?: (event: Event) => void;
	onclose?: (event: Event) => void;
	onmessage?: (event: MessageEvent) => void;
	send = vi.fn();

	constructor() {
		MockWebSocket.instances.push(this);
	}

	open() {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.(new Event('open'));
	}

	close() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.(new Event('close'));
	}

	receive(payload: object) {
		this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
	}
}

let svelte: typeof import('svelte');
let stores: typeof import('../src/stores/stores');
let app: ReturnType<typeof import('svelte').mount> | undefined;
let socket: MockWebSocket;

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	localStorage.clear();
	localStorage.setItem('bannou-texthooker-persistLines', '1');
	localStorage.setItem(linesStorageKey, JSON.stringify(persistedLines));
	localStorage.setItem(timerStorageKey, '7200');
	MockWebSocket.instances = [];
	vi.stubGlobal('WebSocket', MockWebSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn(() => new Promise(() => {})),
	);
	vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
	vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue();
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false })),
	);

	svelte = await import('svelte');
	stores = await import('../src/stores/stores');
	const { default: App } = await import('../src/components/App.svelte');
	app = svelte.mount(App, { target: document.body });
	await svelte.tick();
	socket = MockWebSocket.instances[0];
	socket.open();
	await svelte.tick();
	expect(JSON.parse(socket.send.mock.calls[0][0]).event).toBe('text_v2_snapshot_request');
	expect(stores.lineData$.getValue()).toEqual(persistedLines);
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

async function receiveSnapshot(lines: object[]) {
	socket.receive({ event: 'text_v2_snapshot', session_id: sessionId, lines });
	await vi.advanceTimersByTimeAsync(0);
	await svelte.tick();
}

function expectPersistedLines(lines: LineItem[]) {
	expect(stores.lineData$.getValue()).toEqual(lines);
	expect(JSON.parse(localStorage.getItem(linesStorageKey)!)).toEqual(lines);
	expect(document.querySelectorAll('main .textline2')).toHaveLength(lines.length);
}

test('an empty reconnect snapshot preserves saved history, character count, CPH, and timer', async () => {
	expect(document.querySelector('.timer')?.textContent).toBe('02:00:00 (4/h) 8 / 2');
	await receiveSnapshot([]);

	expectPersistedLines(persistedLines);
	expect(document.querySelector('.timer')?.textContent).toBe('02:00:00 (4/h) 8 / 2');
	expect(stores.timeValue$.getValue()).toBe(7200);
	expect(localStorage.getItem(timerStorageKey)).toBe('7200');
	expect(stores.isPaused$.getValue()).toBe(true);
});

test('a shorter reconnect snapshot preserves history while updating and backfilling recent records', async () => {
	const lines = [{ ...recentRecord, id: 'new', text: '次の文章', stream_sequence: 3, revision: 1 }, recentRecord];
	await receiveSnapshot(lines);

	const expectedLines: LineItem[] = [
		persistedLines[0],
		{ ...persistedLines[1], text: '読み終わり', revision: 2, recordState: 'frozen' },
		{
			id: 'new',
			text: '次の文章',
			excludedFromStats: false,
			gsmSessionId: sessionId,
			gsmStatus: 'active',
			sessionBackfill: true,
			streamSequence: 3,
			revision: 1,
			recordState: 'frozen',
		},
	];
	expectPersistedLines(expectedLines);
	expect(document.querySelector('.timer')?.textContent).toBe('02:00:00 (7/h) 13 / 3');
	expect(stores.timeValue$.getValue()).toBe(7200);

	await receiveSnapshot(lines);
	expectPersistedLines(expectedLines);
});

test.each(['Reset Lines', 'Reset Data'])(
	'%s still clears saved lines and keeps them removed on reconnect',
	async (reset) => {
		await receiveSnapshot([recentRecord]);
		stores.skipResetConfirmations$.next(true);
		stores.settingsOpen$.set(true);
		await svelte.tick();
		const button = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
			(element) => element.textContent?.trim() === reset,
		);
		expect(button).toBeDefined();
		button!.click();
		await svelte.tick();

		expect(stores.lineData$.getValue()).toEqual([]);
		expect(localStorage.getItem(linesStorageKey)).toBeNull();
		expect(stores.timeValue$.getValue()).toBe(reset === 'Reset Lines' ? 7200 : 0);

		await receiveSnapshot([recentRecord]);
		expectPersistedLines([]);
	},
);
