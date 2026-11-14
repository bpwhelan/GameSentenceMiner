import { describe, expect, it } from 'vitest';
import { applyReaderEvent, emptyReaderState, restoreReaderState, selectReaderRange } from './readerState';

const line = (id: string, sequence: number, extra = {}) => ({
  id, session_id: 'session-a', text: `Sentence ${id}`, stream_sequence: sequence,
  revision: 1, state: 'provisional', ...extra,
});
const append = (data: unknown) => ({ event: 'text_v2_append', data });

describe('desktop reader history', () => {
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
  it('rejects malformed records and bounds history without replacing it with control messages', () => {
    const state = applyReaderEvent(emptyReaderState(), { event: 'text_v2_snapshot', session_id: 'session-a', lines: [null, { id: 'x' }, ...Array.from({ length: 1100 }, (_, i) => line(String(i), i + 1))] });
    expect(state.lines).toHaveLength(1000);
    expect(applyReaderEvent(state, { event: 'audio_ready', audio_url: '/audio/a' })).toBe(state);
    expect(restoreReaderState('{bad')).toEqual(emptyReaderState());
  });
  it('selects a contiguous range without losing other selections', () => {
    expect([...selectReaderRange(new Set(['x']), ['a', 'b', 'c'], 'c', 'a', true)]).toEqual(['x', 'a', 'b', 'c']);
    expect([...selectReaderRange(new Set(['a', 'b', 'c']), ['a', 'b', 'c'], 'a', 'b', false)]).toEqual(['c']);
  });
});
