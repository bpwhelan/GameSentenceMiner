// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingPane } from './ReadingPane';
import { READER_PAGE_SIZE } from '../../lib/readerState';

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

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function setSelectValue(select: HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  descriptor?.set?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('ReadingPane', () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();

  beforeEach(() => {
    delete window.__GSM_NATIVE_WINDOW_VISIBLE__;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    Socket.instances = [];
    vi.stubGlobal('WebSocket', Socket);
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, arg?: any) => {
      if (channel === 'reader.connection') {
        return { websocketUrl: 'ws://localhost:9000', baseUrl: 'http://localhost:9000', storageKey: 'reader-test' };
      }
      if (channel === 'reader.attachDictionary') return null;
      if (channel === 'reader.copy') return null;
      if (channel === 'reader.history') return { lines: [], hasMore: false, nextCursor: null };
      if (channel === 'reader.request' && arg === 'state') {
        return { session_id: 'live', selected_ids: [], timed_out_ids: [] };
      }
      if (channel === 'reader.request' && arg === 'select') {
        return { selected_ids: ['l1'] };
      }
      return {};
    });
    window.ipcRenderer = { invoke, on: () => () => {} } as any;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows a choose-game empty state when no game is linked and filters lines to the linked game', async () => {
    await act(async () => {
      root.render(
        <ReadingPane active focus={false} gameName="" onToggleFocus={() => {}} onOpenBrowser={() => {}} />,
      );
      await flush();
    });
    expect(container.textContent).toContain('Choose a game');
    expect(container.querySelectorAll('.reading-line')).toHaveLength(0);

    await act(async () => {
      root.render(
        <ReadingPane active focus={false} gameName="Steins;Gate" onToggleFocus={() => {}} onOpenBrowser={() => {}} />,
      );
      await flush();
    });
    await act(async () => {
      Socket.instances[0].onopen?.();
      Socket.instances[0].emit({
        event: 'text_v2_append',
        data: { id: 'sg-1', session_id: 'live', text: 'エル・プサイ・コングルゥ', scene: 'Steins;Gate', stream_sequence: 1, revision: 1, state: 'provisional' },
      });
      Socket.instances[0].emit({
        event: 'text_v2_append',
        data: { id: 'other-1', session_id: 'live', text: '別のゲーム', scene: 'Other Game', stream_sequence: 2, revision: 1, state: 'provisional' },
      });
      await flush();
    });

    const lines = Array.from(container.querySelectorAll('.reading-text')).map(el => el.textContent);
    expect(lines).toEqual(['エル・プサイ・コングルゥ']);
    expect(container.querySelector('.reading-game-badge')?.textContent).toBe('Steins;Gate');
  });

  it('defaults hover modifier dropdown to shift, updates scan attributes, and persists choice', async () => {
    await act(async () => {
      root.render(
        <ReadingPane active focus={false} gameName="Steins;Gate" onToggleFocus={() => {}} onOpenBrowser={() => {}} />,
      );
      await flush();
    });
    await act(async () => {
      Socket.instances[0].onopen?.();
      Socket.instances[0].emit({
        event: 'text_v2_append',
        data: { id: 'l1', session_id: 'live', text: '日本語テスト', scene: 'Steins;Gate', stream_sequence: 1, revision: 1, state: 'provisional' },
      });
      await flush();
    });

    const select = container.querySelector<HTMLSelectElement>('.reading-scan-modifier select');
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect(select!.value).toBe('shift');
    expect(container.querySelector('.reading-text')?.getAttribute('data-gsm-reader-scan')).toBe('shift');

    await act(async () => {
      setSelectValue(select!, 'ctrl');
      await flush();
    });
    expect(localStorage.getItem('gsm-reader-scan-modifier')).toBe('ctrl');
    expect(container.querySelector('.reading-text')?.getAttribute('data-gsm-reader-scan')).toBe('ctrl');

    await act(async () => {
      setSelectValue(select!, 'none');
      await flush();
    });
    expect(localStorage.getItem('gsm-reader-scan-modifier')).toBe('none');
    expect(container.querySelector('.reading-text')?.getAttribute('data-gsm-reader-scan')).toBe('none');
  });

  it('loads older lines in real time on scroll up and delegates row actions through a single list handler', async () => {
    const page1 = Array.from({ length: READER_PAGE_SIZE }, (_, i) => ({
      id: `p1-${i}`,
      text: `Page1 Line ${i}`,
      scene: 'Steins;Gate',
      capturedAt: '2026-01-01T00:00:00.000Z',
      timestamp: 2000 + i,
      rowid: 200 + i,
    }));
    const page2 = Array.from({ length: READER_PAGE_SIZE }, (_, i) => ({
      id: `p2-${i}`,
      text: `Page2 Line ${i}`,
      scene: 'Steins;Gate',
      capturedAt: '2026-01-01T00:00:00.000Z',
      timestamp: 1000 + i,
      rowid: 100 + i,
    }));

    invoke.mockImplementation(async (channel: string, arg?: any) => {
      if (channel === 'reader.connection') {
        return { websocketUrl: 'ws://localhost:9000', baseUrl: 'http://localhost:9000', storageKey: 'reader-test' };
      }
      if (channel === 'reader.history') {
        if (!arg?.beforeTimestamp) {
          return { lines: page1, hasMore: true, nextCursor: { beforeTimestamp: 2000, beforeRowid: 200 } };
        }
        return { lines: page2, hasMore: false, nextCursor: { beforeTimestamp: 1000, beforeRowid: 100 } };
      }
      if (channel === 'reader.copy') return null;
      return { session_id: 'live', selected_ids: [], timed_out_ids: [] };
    });

    await act(async () => {
      root.render(
        <ReadingPane active focus={false} gameName="Steins;Gate" onToggleFocus={() => {}} onOpenBrowser={() => {}} />,
      );
      await flush();
    });

    expect(container.querySelectorAll('.reading-line')).toHaveLength(READER_PAGE_SIZE);

    // Delegated copy click on first row works without per-button React handlers.
    const firstCopy = container.querySelector<HTMLButtonElement>('button[data-action="copy"]')!;
    await act(async () => {
      firstCopy.click();
      await flush();
    });
    expect(invoke).toHaveBeenCalledWith('reader.copy', 'Page1 Line 0');

    // Scrolling near the top fetches the older page in real time.
    const transcript = container.querySelector<HTMLDivElement>('.reading-transcript')!;
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 400 });
    transcript.scrollTop = 50;
    await act(async () => {
      transcript.dispatchEvent(new Event('scroll'));
      await flush();
    });

    expect(container.querySelectorAll('.reading-line')).toHaveLength(READER_PAGE_SIZE * 2);
    expect(container.querySelector('.reading-text')?.textContent).toBe('Page2 Line 0');
  });

  it('opens a game-wide search at the latest match, reveals older matches on wheel, and clears to the latest page', async () => {
    vi.useFakeTimers();
    try {
      const history = Array.from({ length: 125 }, (_, i) => ({
        id: String(i), text: `猫 ${i}`, scene: 'Game', capturedAt: '', timestamp: i, rowid: i,
      }));
      invoke.mockImplementation(async (channel, options) => {
        if (channel === 'reader.history') {
          return { lines: options.allMatches ? history : history.slice(-40), hasMore: false };
        }
        return {};
      });
      await act(async () => {
        root.render(<ReadingPane active focus={false} gameName="Game" onToggleFocus={() => {}} onOpenBrowser={() => {}} />);
      });
      await act(async () => container.querySelector<HTMLButtonElement>('.reading-tools button')!.click());
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      const enter = async (value: string) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      };
      const transcript = container.querySelector<HTMLDivElement>('.reading-transcript')!;
      const items = () => [...container.querySelectorAll('.reading-text')].map(el => el.textContent);
      Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 2000 });
      await enter('猫');
      expect(invoke).toHaveBeenCalledWith('reader.history', expect.objectContaining({ scene: 'Game', query: '猫', allMatches: true }));
      expect(items()).toEqual(history.slice(-40).map(line => line.text));
      expect(transcript.scrollTop).toBe(2000);
      for (let i = 0; i < 3; i++) {
        transcript.scrollTop = 0;
        await act(async () => transcript.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -20 })));
      }
      expect(items()).toEqual(history.map(line => line.text));
      await enter('');
      expect(items()).toEqual(history.slice(-40).map(line => line.text));
      expect(transcript.scrollTop).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });
});
