import type { ReaderLine, ReaderState } from '../../../shared/reader';
export const READER_HISTORY_LIMIT = 1000;
export const READER_HISTORY_CHARACTER_LIMIT = 1_000_000;
export const emptyReaderState = (): ReaderState => ({ sessionId: '', lines: [] });
export const readerLineKey = (line: ReaderLine): string => `${line.sessionId}/${line.id}`;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 100000): string => typeof value === 'string' ? value.slice(0, max) : '';
const number = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;

function boundHistory(lines: ReaderLine[]): ReaderLine[] {
  let characters = 0, start = lines.length;
  while (start > 0 && lines.length - start < READER_HISTORY_LIMIT) {
    const line = lines[start - 1];
    const size = line.text.length + line.id.length + line.sessionId.length + line.scene.length + line.source.length + line.capturedAt.length;
    if (characters + size > READER_HISTORY_CHARACTER_LIMIT) break;
    characters += size;
    start--;
  }
  return lines.slice(start);
}

function readLine(value: unknown, sessionId = ''): ReaderLine | null {
  const raw = record(value);
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.text !== 'string') return null;
  return {
    id: text(raw.id, 500), sessionId: text(raw.session_id || raw.sessionId || sessionId, 500), text: text(raw.text),
    sequence: number(raw.stream_sequence ?? raw.sequence), revision: number(raw.revision, 1),
    state: raw.state === 'expired' ? 'expired' : raw.state === 'frozen' ? 'frozen' : 'provisional',
    source: text(raw.source_display_name || raw.source, 100), scene: text(raw.scene, 500),
    capturedAt: text(raw.captured_at || raw.capturedAt, 100), excludedFromStats: Boolean(raw.excluded_from_stats ?? raw.excludedFromStats),
  };
}

export function restoreReaderState(serialized: string | null): ReaderState {
  try {
    const raw = record(JSON.parse(serialized || 'null'));
    if (!raw || !Array.isArray(raw.lines)) return emptyReaderState();
    return { sessionId: '', lines: boundHistory(raw.lines.slice(-READER_HISTORY_LIMIT).map(item => readLine(item)).filter((item): item is ReaderLine => Boolean(item)).map(item => ({ ...item, state: 'expired' }))) };
  } catch { return emptyReaderState(); }
}

export function applyReaderEvent(previous: ReaderState, value: unknown): ReaderState {
  const message = record(value);
  if (!message) return previous;
  const snapshot = message.event === 'text_v2_snapshot';
  if (!snapshot && !['text_v2_append', 'text_v2_update', 'text_v2_freeze', 'text_v2_expire'].includes(String(message.event))) return previous;
  const incoming = (snapshot ? (Array.isArray(message.lines) ? message.lines.slice(-READER_HISTORY_LIMIT) : []) : [message.data])
    .map(item => readLine(item, text(message.session_id))).filter((item): item is ReaderLine => Boolean(item));
  const sessionId = text(message.session_id) || incoming[0]?.sessionId || previous.sessionId;
  const snapshotIds = new Set(incoming.map(readerLineKey));
  const snapshotSequence = number(message.snapshot_sequence, Math.max(0, ...incoming.map(item => item.sequence)));
  const lines = new Map(previous.lines.map(item => {
    const expired = item.sessionId !== sessionId || (snapshot && item.sequence <= snapshotSequence && !snapshotIds.has(readerLineKey(item)));
    return [readerLineKey(item), expired ? { ...item, state: 'expired' as const } : item];
  }));
  for (const item of incoming) {
    const key = readerLineKey(item);
    const current = lines.get(key);
    if (!current || item.revision >= current.revision) lines.set(key, item);
  }
  const values = [...lines.values()];
  const historic = values.filter(item => item.sessionId !== sessionId);
  const current = values.filter(item => item.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
  return { sessionId, lines: boundHistory([...historic, ...current]) };
}

export function selectReaderRange(initial: ReadonlySet<string>, order: readonly string[], anchor: string, end: string, checked: boolean): Set<string> {
  const selected = new Set(initial), first = order.indexOf(anchor), last = order.indexOf(end);
  if (first < 0 || last < 0) return selected;
  for (const id of order.slice(Math.min(first, last), Math.max(first, last) + 1)) checked ? selected.add(id) : selected.delete(id);
  return selected;
}
