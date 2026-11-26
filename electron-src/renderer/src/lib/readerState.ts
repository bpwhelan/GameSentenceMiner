import type {
  ReaderHistoryCursor,
  ReaderHistoryLine,
  ReaderLine,
  ReaderScanModifier,
  ReaderState,
} from '../../../shared/reader';

export const READER_PAGE_SIZE = 40;
export const READER_FOLLOW_TRIM_THRESHOLD = 50;
export const READER_LIVE_SNAPSHOT_LIMIT = 50;
export const READER_OVERFLOW_LIMIT = 200;
export const READER_HISTORY_LIMIT = 1000;
export const READER_HISTORY_CHARACTER_LIMIT = 1_000_000;

export const emptyReaderState = (): ReaderState => ({ sessionId: '', lines: [] });
export const readerLineKey = (line: ReaderLine): string => `${line.sessionId}/${line.id}`;

const VALID_SCAN_MODIFIERS = new Set<ReaderScanModifier>(['shift', 'ctrl', 'alt', 'meta', 'none']);

export function normalizeScanModifier(value: unknown): ReaderScanModifier {
  return typeof value === 'string' && VALID_SCAN_MODIFIERS.has(value as ReaderScanModifier)
    ? (value as ReaderScanModifier)
    : 'shift';
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max = 100000): string =>
  typeof value === 'string' ? value.slice(0, max) : '';
const number = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;

function lineTimestamp(line: ReaderLine): number {
  if (typeof line.timestamp === 'number' && Number.isFinite(line.timestamp) && line.timestamp > 0) {
    return line.timestamp;
  }
  if (line.capturedAt) {
    const ms = Date.parse(line.capturedAt);
    if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  }
  return 0;
}

function boundHistory(lines: ReaderLine[], maxLines = READER_HISTORY_LIMIT): ReaderLine[] {
  let characters = 0;
  let start = lines.length;
  while (start > 0 && lines.length - start < maxLines) {
    const line = lines[start - 1];
    const size =
      line.text.length +
      line.id.length +
      line.sessionId.length +
      line.scene.length +
      line.source.length +
      line.capturedAt.length;
    if (characters + size > READER_HISTORY_CHARACTER_LIMIT) break;
    characters += size;
    start--;
  }
  return lines.slice(start);
}

function readLine(value: unknown, sessionId = ''): ReaderLine | null {
  const raw = record(value);
  if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.text !== 'string') return null;
  const capturedAt = text(raw.captured_at || raw.capturedAt, 100);
  const parsedMs = capturedAt ? Date.parse(capturedAt) : NaN;
  const timestamp =
    typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
      ? raw.timestamp
      : Number.isFinite(parsedMs)
        ? parsedMs / 1000
        : undefined;
  const rowid =
    typeof raw.rowid === 'number' && Number.isSafeInteger(raw.rowid) ? raw.rowid : undefined;
  const translation = typeof raw.translation === 'string' && raw.translation ? raw.translation : undefined;
  return {
    id: text(raw.id, 500),
    sessionId: text(raw.session_id || raw.sessionId || sessionId, 500),
    text: text(raw.text),
    sequence: number(raw.stream_sequence ?? raw.sequence),
    revision: number(raw.revision, 1),
    state: raw.state === 'expired' ? 'expired' : raw.state === 'frozen' ? 'frozen' : 'provisional',
    source: text(raw.source_display_name || raw.source, 100),
    scene: text(raw.scene, 500),
    capturedAt,
    excludedFromStats: Boolean(raw.excluded_from_stats ?? raw.excludedFromStats),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(rowid !== undefined ? { rowid } : {}),
    ...(translation !== undefined ? { translation } : {}),
  };
}

export function historyLineToReaderLine(item: ReaderHistoryLine): ReaderLine {
  return {
    id: text(item.id, 500),
    sessionId: '',
    text: text(item.text),
    sequence: 0,
    revision: 1,
    state: 'expired',
    source: '',
    scene: text(item.scene, 500),
    capturedAt: text(item.capturedAt, 100),
    excludedFromStats: false,
    timestamp: Number.isFinite(item.timestamp) ? item.timestamp : 0,
    rowid: item.rowid,
    ...(item.translation ? { translation: item.translation } : {}),
  };
}

export function restoreReaderState(serialized: string | null): ReaderState {
  try {
    const raw = record(JSON.parse(serialized || 'null'));
    if (!raw || !Array.isArray(raw.lines)) return emptyReaderState();
    return {
      sessionId: '',
      lines: boundHistory(
        raw.lines
          .slice(-READER_HISTORY_LIMIT)
          .map(item => readLine(item))
          .filter((item): item is ReaderLine => Boolean(item))
          .map(item => ({ ...item, state: 'expired' })),
      ),
    };
  } catch {
    return emptyReaderState();
  }
}

export function matchesReaderScene(lineScene: string, activeGame: string | undefined): boolean {
  if (activeGame === undefined) return true;
  const target = activeGame.trim();
  if (!target) return false;
  return lineScene.trim() === target;
}

export function matchesReaderQuery(lineText: string, query: string): boolean {
  const needle = query.trim();
  if (!needle) return true;
  return lineText.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

export function applyReaderEvent(
  previous: ReaderState,
  value: unknown,
  sceneFilter?: string,
  searchQuery = '',
): ReaderState {
  const message = record(value);
  if (!message) return previous;
  const snapshot = message.event === 'text_v2_snapshot';
  if (
    !snapshot &&
    !['text_v2_append', 'text_v2_update', 'text_v2_freeze', 'text_v2_expire'].includes(
      String(message.event),
    )
  ) {
    return previous;
  }

  const rawIncoming = (
    snapshot
      ? Array.isArray(message.lines)
        ? message.lines.slice(-READER_HISTORY_LIMIT)
        : []
      : [message.data]
  )
    .map(item => readLine(item, text(message.session_id)))
    .filter((item): item is ReaderLine => Boolean(item));

  const sessionId = text(message.session_id) || rawIncoming[0]?.sessionId || previous.sessionId;
  const incoming = rawIncoming.filter(
    item =>
      matchesReaderScene(item.scene, sceneFilter) &&
      matchesReaderQuery(item.text, searchQuery),
  );

  // If this is a single-line event that doesn't belong to the linked game (or query)
  // and isn't already tracked in our view, avoid rebuilding state at all.
  if (!snapshot && incoming.length === 0) {
    const rawFirst = rawIncoming[0];
    if (!rawFirst || !previous.lines.some(item => item.id === rawFirst.id)) {
      return sessionId === previous.sessionId ? previous : { ...previous, sessionId };
    }
  }

  const snapshotIds = new Set(incoming.map(readerLineKey));
  const snapshotSequence = number(
    message.snapshot_sequence,
    Math.max(0, ...rawIncoming.map(item => item.sequence)),
  );

  const lines = new Map<string, ReaderLine>();
  const dbIdToKey = new Map<string, string>();

  for (const item of previous.lines) {
    if (!matchesReaderScene(item.scene, sceneFilter)) continue;
    const key = readerLineKey(item);
    const expired =
      item.sessionId !== sessionId ||
      (snapshot &&
        item.sessionId === sessionId &&
        item.sequence <= snapshotSequence &&
        !snapshotIds.has(key));
    lines.set(key, expired ? { ...item, state: 'expired' as const } : item);
    if (!item.sessionId) {
      dbIdToKey.set(item.id, key);
    }
  }

  // If an update changed text so it no longer matches an active search query, drop it.
  if (!snapshot && incoming.length === 0 && rawIncoming[0]) {
    const removedKey = readerLineKey(rawIncoming[0]);
    lines.delete(removedKey);
  }

  for (const item of incoming) {
    const key = readerLineKey(item);
    // If a DB history row with the same line ID already exists, upgrade it in-place
    // so live playback/selection metadata is preserved without duplicating the row.
    const existingDbKey = dbIdToKey.get(item.id);
    let preservedTranslation: string | undefined;
    let preservedRowid: number | undefined;
    if (existingDbKey && existingDbKey !== key) {
      const dbLine = lines.get(existingDbKey);
      preservedTranslation = dbLine?.translation;
      preservedRowid = dbLine?.rowid;
      lines.delete(existingDbKey);
      dbIdToKey.delete(item.id);
    }
    const current = lines.get(key);
    if (!current || item.revision >= current.revision) {
      lines.set(key, {
        ...item,
        ...(preservedRowid !== undefined && item.rowid === undefined ? { rowid: preservedRowid } : {}),
        ...(preservedTranslation && !item.translation ? { translation: preservedTranslation } : {}),
      });
    }
  }

  const values = [...lines.values()];
  const historic = values.filter(item => item.sessionId !== sessionId);
  const current = values
    .filter(item => item.sessionId === sessionId)
    .sort((a, b) => a.sequence - b.sequence);
  const combined = [...historic, ...current];
  return { sessionId, lines: snapshot && !searchQuery ? boundHistory(combined) : combined };
}

export function mergeHistoryPage(
  previous: ReaderState,
  historyLines: readonly ReaderHistoryLine[],
): ReaderState {
  if (!historyLines.length) return previous;
  const existingById = new Map(previous.lines.map(line => [line.id, line]));
  const prepended: ReaderLine[] = [];
  let updatedExisting = false;
  const translationPatches = new Map<string, { translation?: string; rowid?: number }>();

  for (const item of historyLines) {
    const existing = existingById.get(item.id);
    if (existing) {
      if (
        (item.translation && !existing.translation) ||
        (existing.rowid === undefined && Number.isSafeInteger(item.rowid))
      ) {
        translationPatches.set(item.id, {
          translation: item.translation || existing.translation,
          rowid: existing.rowid ?? item.rowid,
        });
        updatedExisting = true;
      }
      continue;
    }
    prepended.push(historyLineToReaderLine(item));
  }

  if (!prepended.length && !updatedExisting) return previous;

  const existingLines = updatedExisting
    ? previous.lines.map(line => {
        const patch = translationPatches.get(line.id);
        return patch ? { ...line, ...patch } : line;
      })
    : previous.lines;

  return {
    sessionId: previous.sessionId,
    lines: [...prepended, ...existingLines],
  };
}

export function trimLinesToLatest(
  lines: ReaderLine[],
  keepCount = READER_PAGE_SIZE,
): {
  kept: ReaderLine[];
  droppedDbCursor: ReaderHistoryCursor | null;
  droppedLiveOnly: ReaderLine[];
} {
  if (lines.length <= keepCount) {
    return { kept: lines, droppedDbCursor: null, droppedLiveOnly: [] };
  }
  const split = lines.length - keepCount;
  const dropped = lines.slice(0, split);
  const kept = lines.slice(split);

  // Build an exact DB cursor just after the newest dropped DB-backed line so the
  // next scroll-up page fetches that line and everything older without gaps/dupes.
  let droppedDbCursor: ReaderHistoryCursor | null = null;
  for (let i = dropped.length - 1; i >= 0; i--) {
    const candidate = dropped[i];
    if (candidate.rowid !== undefined) {
      droppedDbCursor = {
        beforeTimestamp: lineTimestamp(candidate),
        beforeRowid: candidate.rowid + 1,
      };
      break;
    }
  }
  if (!droppedDbCursor && kept.length > 0) {
    const oldestKept = kept[0];
    if (oldestKept.rowid !== undefined) {
      droppedDbCursor = {
        beforeTimestamp: lineTimestamp(oldestKept),
        beforeRowid: oldestKept.rowid,
      };
    }
  }

  const droppedLiveOnly = dropped.filter(line => line.rowid === undefined);
  return { kept, droppedDbCursor, droppedLiveOnly };
}

export function countCodePoints(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

export function selectReaderRange(
  initial: ReadonlySet<string>,
  order: readonly string[],
  anchor: string,
  end: string,
  checked: boolean,
): Set<string> {
  const selected = new Set(initial);
  const first = order.indexOf(anchor);
  const last = order.indexOf(end);
  if (first < 0 || last < 0) return selected;
  for (const id of order.slice(Math.min(first, last), Math.max(first, last) + 1)) {
    checked ? selected.add(id) : selected.delete(id);
  }
  return selected;
}
