// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useReader, type UseReaderOptions } from './useReader';
import { READER_LIVE_SNAPSHOT_LIMIT, READER_PAGE_SIZE } from './readerState';
import type { ReaderLine } from '../../../shared/reader';

class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());
  constructor() {
    Socket.instances.push(this);
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

let reader: ReturnType<typeof useReader>, root: Root, container: HTMLDivElement;
const invoke = vi.fn();
const audioPlay = vi.fn(async () => {});
let renders = 0;

function Harness({ active = true, options = { gameName: 'Game A' } }: { active?: boolean; options?: UseReaderOptions }) {
  renders++;
  reader = useReader(active, options);
  return null;
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const line = {
  id: 'a',
  session_id: 'live',
  text: '言葉',
  scene: 'Game A',
  stream_sequence: 1,
  revision: 1,
  state: 'provisional',
};

beforeEach(async () => {
  delete window.__GSM_NATIVE_WINDOW_VISIBLE__;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('Audio', class { play = audioPlay; pause = vi.fn(); });
  invoke.mockReset();
  audioPlay.mockClear();
  invoke.mockImplementation(async (channel, action) => {
    if (channel === 'reader.connection') {
      return { websocketUrl: 'ws://localhost:9000', baseUrl: 'http://localhost:9000', storageKey: 'reader-test' };
    }
    if (channel === 'reader.history') {
      return { lines: [], hasMore: false, nextCursor: null };
    }
    if (action === 'state') {
      return { session_id: 'live', selected_ids: [], timed_out_ids: [] };
    }
    return {};
  });
  window.ipcRenderer = { invoke, on: () => () => {} } as any;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
    await flush();
  });
  await act(async () => {
    Socket.instances[0].onopen?.();
    Socket.instances[0].emit({ event: 'text_v2_append', data: line });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live desktop reader', () => {
  it('only shows lines for the linked game and loads that game on switch', async () => {
    await act(async () => {
      Socket.instances[0].emit({
        event: 'text_v2_append',
        data: { ...line, id: 'other', scene: 'Game B', text: '別ゲーム', stream_sequence: 2 },
      });
    });
    expect(reader.lines.map(item => item.id)).toEqual(['a']);

    invoke.mockImplementation(async (channel, arg) => {
      if (channel === 'reader.history' && arg?.scene === 'Game B') {
        return {
          lines: [{ id: 'gb-1', text: 'Game B line', scene: 'Game B', capturedAt: '2026-01-01T00:00:00.000Z', timestamp: 100, rowid: 1 }],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (channel === 'reader.connection') {
        return { websocketUrl: 'ws://localhost:9000', baseUrl: 'http://localhost:9000', storageKey: 'reader-test' };
      }
      return { session_id: 'live', selected_ids: [], timed_out_ids: [] };
    });

    await act(async () => {
      root.render(<Harness options={{ gameName: 'Game B' }} />);
      await flush();
    });
    expect(reader.lines.map(item => item.id)).toEqual(['gb-1']);
  });

  it('pages older lines from DB on demand and trims back when following latest', async () => {
    const page1 = Array.from({ length: READER_PAGE_SIZE }, (_, i) => ({
      id: `p1-${i}`,
      text: `Recent ${i}`,
      scene: 'Paged Game',
      capturedAt: '2026-01-01T00:00:00.000Z',
      timestamp: 2000 + i,
      rowid: 200 + i,
    }));
    const page2 = Array.from({ length: READER_PAGE_SIZE }, (_, i) => ({
      id: `p2-${i}`,
      text: `Older ${i}`,
      scene: 'Paged Game',
      capturedAt: '2026-01-01T00:00:00.000Z',
      timestamp: 1000 + i,
      rowid: 100 + i,
    }));

    invoke.mockImplementation(async (channel, arg) => {
      if (channel === 'reader.history' && arg?.scene === 'Paged Game') {
        if (!arg.beforeTimestamp) {
          return { lines: page1, hasMore: true, nextCursor: { beforeTimestamp: 2000, beforeRowid: 200 } };
        }
        return { lines: page2, hasMore: false, nextCursor: { beforeTimestamp: 1000, beforeRowid: 100 } };
      }
      if (channel === 'reader.connection') {
        return { websocketUrl: 'ws://localhost:9000', baseUrl: 'http://localhost:9000', storageKey: 'reader-test' };
      }
      return { session_id: 'live', selected_ids: [], timed_out_ids: [] };
    });

    await act(async () => {
      root.render(<Harness options={{ gameName: 'Paged Game', following: false }} />);
      await flush();
    });
    expect(reader.lines).toHaveLength(READER_PAGE_SIZE);
    expect(reader.hasMore).toBe(true);

    await act(async () => {
      await reader.loadOlder();
      await flush();
    });
    expect(reader.lines).toHaveLength(READER_PAGE_SIZE * 2);
    expect(reader.lines[0].id).toBe('p2-0');
    expect(reader.hasMore).toBe(false);

    // Returning to follow latest trims back down to READER_PAGE_SIZE and restores hasMore.
    await act(async () => {
      reader.trimToLatest();
    });
    expect(reader.lines).toHaveLength(READER_PAGE_SIZE);
    expect(reader.lines[0].id).toBe('p1-0');
    expect(reader.hasMore).toBe(true);
  });

  it('honors native tray visibility when WebView2 still reports a visible document', async () => {
    window.__GSM_NATIVE_WINDOW_VISIBLE__ = false;
    await act(async () => window.dispatchEvent(new Event('gsm-native-visibilitychange')));
    const before = renders;
    invoke.mockClear();
    await act(async () => {
      Socket.instances[0].emit({ event: 'text_v2_append', data: { ...line, id: 'b', stream_sequence: 2 } });
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(renders).toBe(before);
    expect(invoke).not.toHaveBeenCalled();
    window.__GSM_NATIVE_WINDOW_VISIBLE__ = true;
    await act(async () => {
      window.dispatchEvent(new Event('gsm-native-visibilitychange'));
      await flush();
    });
    expect(reader.lines).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith('reader.request', 'state');
  });

  it('buffers hidden transcript updates without rendering and publishes corrections on return', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    const before = renders;
    await act(async () => {
      Socket.instances[0].emit({ event: 'text_v2_append', data: { ...line, id: 'b', stream_sequence: 2 } });
      Socket.instances[0].emit({ event: 'text_v2_update', data: { ...line, text: '訂正', revision: 2 } });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(renders).toBe(before);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });
    expect(reader.lines).toHaveLength(2);
    expect(reader.lines[0].text).toBe('訂正');
  });

  it('keeps unchanged selection snapshots from rendering the transcript again', async () => {
    const selected = reader.selected;
    const before = renders;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(reader.selected).toBe(selected);
    expect(renders).toBe(before);
  });

  it('stops state polling when hidden or on another tab, and catches up on return', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(invoke).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });
    expect(invoke).toHaveBeenCalledWith('reader.request', 'state');
    await act(async () => root.render(<Harness active={false} />));
    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () =>
      Socket.instances[0].emit({ event: 'text_v2_append', data: { ...line, id: 'b', stream_sequence: 2 } }),
    );
    await act(async () => root.render(<Harness active />));
    expect(reader.lines).toHaveLength(2);
  });

  it('requests a compact bounded snapshot on reconnect and keeps corrections', async () => {
    expect(Socket.instances[0].send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'text_v2_snapshot_request', max_lines: READER_LIVE_SNAPSHOT_LIMIT }),
    );
    await act(async () => {
      Socket.instances[0].close();
      vi.advanceTimersByTime(1000);
      await flush();
    });
    expect(Socket.instances).toHaveLength(2);
    await act(async () => {
      Socket.instances[1].onopen?.();
      Socket.instances[1].emit({
        event: 'text_v2_snapshot',
        session_id: 'live',
        lines: [{ ...line, revision: 2, text: '新しい言葉' }],
      });
    });
    expect(reader.lines).toHaveLength(1);
    expect(reader.lines[0].text).toBe('新しい言葉');
  });

  it('does not restore selections after a newer backend reset', async () => {
    let resolve!: (result: unknown) => void;
    invoke.mockImplementation((channel, action) =>
      action === 'select' ? new Promise(done => { resolve = done; }) : Promise.resolve({}),
    );
    let selection: Promise<void>;
    await act(async () => {
      selection = reader.select(new Set(['a']));
      await flush();
    });
    await act(async () => {
      Socket.instances[0].emit({ event: 'reset_checkboxes' });
      resolve({ selected_ids: ['a'] });
      await selection;
    });
    expect(reader.selected.size).toBe(0);
  });

  it('plays only a requested replay from the configured backend', async () => {
    await act(async () => {
      Socket.instances[0].emit({ event: 'audio_ready', line_id: 'other', audio_url: '/texthooker/audio/a' });
    });
    expect(audioPlay).not.toHaveBeenCalled();
    await act(async () => {
      await reader.play(reader.lines[0] as ReaderLine);
    });
    await act(async () => {
      Socket.instances[0].emit({ event: 'audio_ready', line_id: 'a', audio_url: 'https://example.com/texthooker/audio/a' });
    });
    expect(audioPlay).not.toHaveBeenCalled();
    expect(reader.error).toBe('reader.audioError');
    await act(async () => {
      await reader.play(reader.lines[0]);
      Socket.instances[0].emit({ event: 'audio_ready', line_id: 'a', audio_url: '/texthooker/audio/a' });
      await flush();
    });
    expect(audioPlay).toHaveBeenCalledOnce();
  });
});
