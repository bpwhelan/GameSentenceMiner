import { describe, expect, it } from 'vitest';
import {
  applyReaderEvent,
  countCodePoints,
  emptyReaderState,
  mergeHistoryPage,
  normalizeScanModifier,
  restoreReaderState,
  selectReaderRange,
  trimLinesToLatest,
  READER_HISTORY_CHARACTER_LIMIT,
} from './readerState';

const line = (id: string, sequence: number, extra = {}) => ({
  id,
  session_id: 'session-a',
  text: `Sentence ${id}`,
  scene: 'Game A',
  stream_sequence: sequence,
  revision: 1,
  state: 'provisional',
  ...extra,
});
const append = (data: unknown) => ({ event: 'text_v2_append', data });

describe('desktop reader history', () => {
  it('bounds large captured text by size and preserves the newest lines on restore', () => {
    const state = applyReaderEvent(emptyReaderState(), {
      event: 'text_v2_snapshot',
      session_id: 'session-a',
      lines: Array.from({ length: 1000 }, (_, i) =>
        line(String(i), i + 1, { text: '語'.repeat(10000) }),
      ),
    });
    expect(state.lines.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(
      READER_HISTORY_CHARACTER_LIMIT,
    );
    expect(state.lines.at(-1)?.id).toBe('999');
    const restored = restoreReaderState(JSON.stringify(state));
    expect(restored.lines).toHaveLength(state.lines.length);
    expect(restored.lines.at(-1)?.text).toBe('語'.repeat(10000));
  });

  it('filters live events strictly to the linked game scene', () => {
    let state = emptyReaderState();
    state = applyReaderEvent(state, append(line('a1', 1, { scene: 'Game A' })), 'Game A');
    state = applyReaderEvent(state, append(line('b1', 2, { scene: 'Game B' })), 'Game A');
    state = applyReaderEvent(state, append(line('a2', 3, { scene: 'Game A' })), 'Game A');
    expect(state.lines.map(item => item.id)).toEqual(['a1', 'a2']);

    // Empty scene filter rejects all lines (e.g. no game selected / helper scene).
    const emptyGame = applyReaderEvent(emptyReaderState(), append(line('a1', 1, { scene: 'Game A' })), '');
    expect(emptyGame.lines).toHaveLength(0);
  });

  it('merges DB history pages without duplicating live lines and upgrades DB rows when live arrives', () => {
    let state = mergeHistoryPage(emptyReaderState(), [
      { id: 'h1', text: 'Old 1', scene: 'Game A', capturedAt: '2026-01-01T00:00:00.000Z', timestamp: 100, rowid: 1 },
      { id: 'h2', text: 'Old 2', scene: 'Game A', capturedAt: '2026-01-01T00:01:00.000Z', timestamp: 160, rowid: 2, translation: 'Saved TL' },
    ]);
    expect(state.lines.map(l => l.id)).toEqual(['h1', 'h2']);

    // Live snapshot includes h2 — should upgrade h2 in place without creating a duplicate.
    state = applyReaderEvent(
      state,
      { event: 'text_v2_snapshot', session_id: 'session-a', snapshot_sequence: 1, lines: [line('h2', 1, { text: 'Old 2', scene: 'Game A', state: 'frozen' })] },
      'Game A',
    );
    expect(state.lines.map(l => [l.id, l.sessionId, l.state, l.translation])).toEqual([
      ['h1', '', 'expired', undefined],
      ['h2', 'session-a', 'frozen', 'Saved TL'],
    ]);

    // Paging older history that overlaps with h1 skips h1 and prepends h0.
    state = mergeHistoryPage(state, [
      { id: 'h0', text: 'Old 0', scene: 'Game A', capturedAt: '2026-01-01T00:00:00.000Z', timestamp: 50, rowid: 0 },
      { id: 'h1', text: 'Old 1', scene: 'Game A', capturedAt: '2026-01-01T00:00:00.000Z', timestamp: 100, rowid: 1 },
    ]);
    expect(state.lines.map(l => l.id)).toEqual(['h0', 'h1', 'h2']);
  });

  it('trims older lines to latest window and computes exact DB cursor for re-paging', () => {
    const historyLines = Array.from({ length: 60 }, (_, i) => ({
      id: `l-${i}`,
      text: `Line ${i}`,
      scene: 'Game A',
      capturedAt: '2026-01-01T00:00:00.000Z',
      timestamp: 1000 + i,
      rowid: i + 1,
    }));
    const state = mergeHistoryPage(emptyReaderState(), historyLines);
    const { kept, droppedDbCursor, droppedLiveOnly } = trimLinesToLatest(state.lines, 40);
    expect(kept).toHaveLength(40);
    expect(kept[0].id).toBe('l-20');
    expect(kept[39].id).toBe('l-59');
    // Newest dropped line was l-19 (timestamp 1019, rowid 20), so cursor is (1019, 21).
    expect(droppedDbCursor).toEqual({ beforeTimestamp: 1019, beforeRowid: 21 });
    expect(droppedLiveOnly).toHaveLength(0);
  });

  it('applies corrections in place and ignores an older reconnect snapshot', () => {
    let state = applyReaderEvent(emptyReaderState(), append(line('a', 1)));
    state = applyReaderEvent(state, { event: 'text_v2_update', data: line('a', 1, { text: 'Corrected', revision: 3 }) });
    state = applyReaderEvent(state, { event: 'text_v2_snapshot', session_id: 'session-a', snapshot_sequence: 1, lines: [line('a', 1)] });
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]).toMatchObject({ text: 'Corrected', revision: 3 });
  });

  it('preserves history outside the replay snapshot and marks its media unavailable', () => {
    let state = applyReaderEvent(emptyReaderState(), append(line('a', 1)));
    state = applyReaderEvent(state, append(line('b', 2)));
    state = applyReaderEvent(state, { event: 'text_v2_snapshot', session_id: 'session-a', snapshot_sequence: 2, lines: [line('b', 2)] });
    expect(state.lines.map(item => [item.id, item.state])).toEqual([['a', 'expired'], ['b', 'provisional']]);
  });

  it('keeps a newer live append when an in-flight snapshot arrives', () => {
    let state = applyReaderEvent(emptyReaderState(), append(line('b', 2)));
    state = applyReaderEvent(state, { event: 'text_v2_snapshot', session_id: 'session-a', snapshot_sequence: 1, lines: [line('a', 1)] });
    expect(state.lines.map(item => [item.id, item.state])).toEqual([['a', 'provisional'], ['b', 'provisional']]);
  });

  it('separates session identities and never allows restored media to look available', () => {
    let state = applyReaderEvent(emptyReaderState(), append(line('a', 1)));
    state = applyReaderEvent(state, append(line('a', 1, { session_id: 'session-b' })));
    const restored = restoreReaderState(JSON.stringify(state));
    expect(restored.lines).toHaveLength(2);
    expect(restored.lines.every(item => item.state === 'expired')).toBe(true);
    expect(restored.sessionId).toBe('');
  });

  it('normalizes hover scan modifiers with shift default and counts astral code points accurately', () => {
    expect(normalizeScanModifier(null)).toBe('shift');
    expect(normalizeScanModifier('unknown')).toBe('shift');
    expect(normalizeScanModifier('ctrl')).toBe('ctrl');
    expect(normalizeScanModifier('alt')).toBe('alt');
    expect(normalizeScanModifier('meta')).toBe('meta');
    expect(normalizeScanModifier('none')).toBe('none');
    expect(countCodePoints('😀猫犬')).toBe(3);
  });

  it('selects a contiguous range without losing other selections', () => {
    expect([...selectReaderRange(new Set(['x']), ['a', 'b', 'c'], 'c', 'a', true)]).toEqual(['x', 'a', 'b', 'c']);
    expect([...selectReaderRange(new Set(['a', 'b', 'c']), ['a', 'b', 'c'], 'a', 'b', false)]).toEqual(['c']);
  });

  it('allows paging past READER_HISTORY_LIMIT without dropping older lines on live appends', () => {
    const mkPage = (offset: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `h-${offset + i}`,
        text: `Line ${offset + i}`,
        scene: 'Game A',
        capturedAt: '2026-01-01T00:00:00.000Z',
        timestamp: 1000 + offset + i,
        rowid: offset + i + 1,
      }));

    let state = mergeHistoryPage(emptyReaderState(), mkPage(600, 600));
    state = mergeHistoryPage(state, mkPage(0, 600));
    expect(state.lines).toHaveLength(1200);
    expect(state.lines[0].id).toBe('h-0');

    state = applyReaderEvent(state, append(line('live-1', 1, { scene: 'Game A' })), 'Game A');
    expect(state.lines).toHaveLength(1201);
    expect(state.lines[0].id).toBe('h-0');
    expect(state.lines.at(-1)?.id).toBe('live-1');
  });
});
