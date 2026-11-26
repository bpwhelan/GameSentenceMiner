import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReaderAction,
  ReaderConnection,
  ReaderHistoryCursor,
  ReaderHistoryPage,
  ReaderLine,
  ReaderState,
} from '../../../shared/reader';
import { invokeIpc, onIpc } from './ipc';
import {
  READER_FOLLOW_TRIM_THRESHOLD,
  READER_LIVE_SNAPSHOT_LIMIT,
  READER_OVERFLOW_LIMIT,
  READER_PAGE_SIZE,
  applyReaderEvent,
  emptyReaderState,
  mergeHistoryPage,
  trimLinesToLatest,
} from './readerState';
import { startVisiblePolling } from './visiblePolling';
import { useDocumentVisible } from './useDocumentVisible';

export interface UseReaderOptions {
  gameName?: string;
  searchQuery?: string;
  following?: boolean;
}

export function useReader(active: boolean, options: UseReaderOptions = {}) {
  const gameName = options.gameName;
  const searchQuery = (options.searchQuery ?? '').trim();
  const following = options.following ?? true;

  const [state, setState] = useState<ReaderState>(emptyReaderState);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(false);

  const current = useRef(state);
  const visible = useDocumentVisible();
  const presenting = active && visible;
  const presentingRef = useRef(presenting);
  presentingRef.current = presenting;
  const gameNameRef = useRef(gameName);
  gameNameRef.current = gameName;
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const followingRef = useRef(following);
  followingRef.current = following;

  const connectionRef = useRef<ReaderConnection | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const socketOpenRef = useRef(false);
  const selectionVersion = useRef(0);
  const selectionPending = useRef(false);
  const selectionRef = useRef(selected);
  selectionRef.current = selected;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingAudio = useRef<string | null>(null);
  const audioTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);

  // Cursor-based DB pagination + small capped fallback overflow for live-only lines.
  const dbCursorRef = useRef<ReaderHistoryCursor | null>(null);
  const dbHasMoreRef = useRef(false);
  const overflowRef = useRef<ReaderLine[]>([]);
  const historyGeneration = useRef(0);
  const loadingMoreRef = useRef(false);

  const syncHasMore = useCallback(() => {
    const next = dbHasMoreRef.current || overflowRef.current.length > 0;
    if (mounted.current) setHasMore(next);
  }, []);

  const updateState = useCallback((update: ReaderState | ((before: ReaderState) => ReaderState)) => {
    const next = typeof update === 'function' ? update(current.current) : update;
    if (next === current.current) return;
    current.current = next;
    if (presentingRef.current) setState(next);
  }, []);

  const trimToLatest = useCallback(() => {
    if (searchQueryRef.current) return;
    const cur = current.current;
    if (cur.lines.length <= READER_PAGE_SIZE) return;
    const { kept, droppedDbCursor, droppedLiveOnly } = trimLinesToLatest(cur.lines, READER_PAGE_SIZE);
    if (droppedDbCursor) {
      dbCursorRef.current = droppedDbCursor;
      dbHasMoreRef.current = true;
    }
    if (droppedLiveOnly.length) {
      const combined = [...overflowRef.current, ...droppedLiveOnly];
      overflowRef.current =
        combined.length > READER_OVERFLOW_LIMIT
          ? combined.slice(-READER_OVERFLOW_LIMIT)
          : combined;
    }
    const next: ReaderState = { sessionId: cur.sessionId, lines: kept };
    current.current = next;
    if (presentingRef.current) setState(next);
    syncHasMore();
  }, [syncHasMore]);

  // Keep memory bounded while following latest or while hidden/minimized to tray.
  const trimIfNeeded = useCallback(() => {
    if (
      (followingRef.current || !presentingRef.current) &&
      current.current.lines.length > READER_FOLLOW_TRIM_THRESHOLD
    ) {
      trimToLatest();
    }
  }, [trimToLatest]);

  useEffect(() => {
    if (presenting) setState(current.current);
  }, [presenting]);

  const resetAudio = useCallback(() => {
    pendingAudio.current = null;
    if (audioTimeout.current) clearTimeout(audioTimeout.current);
    audioTimeout.current = null;
    setPreparing(null);
  }, []);

  const request = useCallback(
    async <T,>(action: ReaderAction, payload: Record<string, unknown> = {}): Promise<T> => {
      setError('');
      try {
        return await invokeIpc<T>('reader.request', action, payload);
      } catch (reason) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      }
    },
    [],
  );

  // Load initial page of DB history whenever the linked game or search query changes.
  useEffect(() => {
    const generation = ++historyGeneration.current;
    loadingMoreRef.current = false;
    dbCursorRef.current = null;
    dbHasMoreRef.current = false;
    overflowRef.current = [];
    setHasMore(false);
    setLoadingMore(false);

    const trimmedGame = (gameName ?? '').trim();
    // Reset displayed lines for the newly linked game (or clear when no game selected).
    const baseState: ReaderState = { sessionId: current.current.sessionId, lines: [] };
    current.current = baseState;
    setState(baseState);

    if (gameName !== undefined && !trimmedGame) {
      setLoadingInitial(false);
      return;
    }

    // Re-request a compact live snapshot over the open socket so active replay lines
    // for the newly selected game hydrate immediately.
    const ws = socketRef.current;
    if (ws && socketOpenRef.current) {
      try {
        ws.send(JSON.stringify({ event: 'text_v2_snapshot_request', max_lines: READER_LIVE_SNAPSHOT_LIMIT }));
      } catch {
        /* Socket will resend on reconnect. */
      }
    }

    if (!trimmedGame) {
      setLoadingInitial(false);
      return;
    }

    setLoadingInitial(true);
    void invokeIpc<ReaderHistoryPage | null>('reader.history', {
      scene: trimmedGame,
      limit: READER_PAGE_SIZE,
      ...(searchQuery ? { query: searchQuery, allMatches: true } : {}),
    })
      .then(page => {
        if (!mounted.current || generation !== historyGeneration.current) return;
        if (page && Array.isArray(page.lines)) {
          dbCursorRef.current = page.nextCursor ?? null;
          dbHasMoreRef.current = Boolean(page.hasMore && page.nextCursor);
          updateState(before => mergeHistoryPage(before, page.lines));
          if (followingRef.current) trimToLatest();
          syncHasMore();
        }
      })
      .catch(reason => {
        if (searchQuery && mounted.current && generation === historyGeneration.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (mounted.current && generation === historyGeneration.current) {
          setLoadingInitial(false);
        }
      });
  }, [gameName, searchQuery, updateState, syncHasMore, trimToLatest]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (loadingMoreRef.current) return 0;
    const generation = historyGeneration.current;

    // First drain any live-only overflow lines (newest-first from the end of overflowRef)
    // before paging further back in SQLite.
    if (overflowRef.current.length > 0) {
      const take = Math.min(READER_PAGE_SIZE, overflowRef.current.length);
      const chunk = overflowRef.current.slice(-take);
      overflowRef.current = overflowRef.current.slice(0, -take);
      const existingIds = new Set(current.current.lines.map(item => item.id));
      const unique = chunk.filter(item => !existingIds.has(item.id));
      if (unique.length > 0) {
        updateState(before => ({
          sessionId: before.sessionId,
          lines: [...unique, ...before.lines],
        }));
      }
      syncHasMore();
      if (unique.length > 0) return unique.length;
    }

    const trimmedGame = (gameNameRef.current ?? '').trim();
    const cursor = dbCursorRef.current;
    if (!trimmedGame || !dbHasMoreRef.current || !cursor) {
      syncHasMore();
      return 0;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await invokeIpc<ReaderHistoryPage | null>('reader.history', {
        scene: trimmedGame,
        limit: READER_PAGE_SIZE,
        beforeTimestamp: cursor.beforeTimestamp,
        beforeRowid: cursor.beforeRowid,
        ...(searchQueryRef.current ? { query: searchQueryRef.current } : {}),
      });
      if (!mounted.current || generation !== historyGeneration.current) return 0;
      if (page && Array.isArray(page.lines) && page.lines.length > 0) {
        dbCursorRef.current = page.nextCursor ?? null;
        dbHasMoreRef.current = Boolean(page.hasMore && page.nextCursor);
        const beforeCount = current.current.lines.length;
        updateState(before => mergeHistoryPage(before, page.lines));
        syncHasMore();
        return Math.max(0, current.current.lines.length - beforeCount);
      }
      dbHasMoreRef.current = false;
      syncHasMore();
      return 0;
    } catch {
      return 0;
    } finally {
      if (generation === historyGeneration.current) {
        loadingMoreRef.current = false;
        if (mounted.current) setLoadingMore(false);
      }
    }
  }, [updateState, syncHasMore]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const syncState = async () => {
      const version = selectionVersion.current;
      if (!selectionPending.current) {
        try {
          const value = await invokeIpc<{
            selected_ids?: string[];
            active_ids?: string[];
            timed_out_ids?: string[];
            session_id?: string;
            text_intake_paused?: boolean;
          }>('reader.request', 'state');
          if (!disposed && value) {
            if (
              version === selectionVersion.current &&
              !selectionPending.current &&
              Array.isArray(value.selected_ids)
            ) {
              const next = new Set(value.selected_ids.filter(id => typeof id === 'string'));
              if (
                selectionRef.current.size !== next.size ||
                [...next].some(id => !selectionRef.current.has(id))
              ) {
                setSelected(next);
              }
            }
            if (typeof value.text_intake_paused === 'boolean') setPaused(value.text_intake_paused);
            if (Array.isArray(value.timed_out_ids) && value.timed_out_ids.length) {
              const expired = new Set(value.timed_out_ids);
              updateState(before => {
                if (
                  value.session_id !== before.sessionId ||
                  !before.lines.some(item => item.state !== 'expired' && expired.has(item.id))
                ) {
                  return before;
                }
                return {
                  ...before,
                  lines: before.lines.map(item =>
                    expired.has(item.id) ? { ...item, state: 'expired' } : item,
                  ),
                };
              });
            }
          }
        } catch {
          /* Connection status is shown by the stream; stale state never clears a selection. */
        }
      }
    };
    const stop = startVisiblePolling(syncState, 2500);
    return () => {
      disposed = true;
      stop();
    };
  }, [active, updateState]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let socket: WebSocket | null = null;
    let generation = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const connect = async () => {
      const attempt = ++generation;
      setConnection(retries ? 'offline' : 'connecting');
      try {
        const config = await invokeIpc<ReaderConnection>('reader.connection');
        if (disposed || generation !== attempt) return;
        if (!config?.websocketUrl) throw new Error('Reader connection is unavailable.');
        connectionRef.current = config;

        const ws = new WebSocket(config.websocketUrl);
        socket = ws;
        socketRef.current = ws;

        ws.onopen = () => {
          if (disposed || generation !== attempt) return;
          socketOpenRef.current = true;
          retries = 0;
          setConnection('live');
          ws.send(
            JSON.stringify({
              event: 'text_v2_snapshot_request',
              max_lines: READER_LIVE_SNAPSHOT_LIMIT,
            }),
          );
        };
        ws.onmessage = event => {
          if (disposed || generation !== attempt) return;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (!payload || typeof payload !== 'object') return;
          updateState(before =>
            applyReaderEvent(before, payload, gameNameRef.current, searchQueryRef.current),
          );
          if (payload.event === 'text_v2_snapshot' && followingRef.current) trimToLatest();
          else trimIfNeeded();
          if (payload.event === 'reset_checkboxes') {
            selectionVersion.current++;
            setSelected(new Set());
          }
          if (payload.event === 'audio_ready' && payload.line_id === pendingAudio.current) {
            try {
              const source = new URL(String(payload.audio_url), config.baseUrl);
              if (
                source.origin !== config.baseUrl ||
                !source.pathname.startsWith('/texthooker/audio/')
              ) {
                throw new Error('Invalid audio URL.');
              }
              audioRef.current?.pause();
              const audio = new Audio(source.toString());
              audioRef.current = audio;
              audio.onended = () => setPlaying(null);
              audio.onerror = () => {
                setPlaying(null);
                setError('reader.audioError');
              };
              resetAudio();
              void audio
                .play()
                .then(() => {
                  if (!disposed && audioRef.current === audio) setPlaying(String(payload.line_id));
                })
                .catch(() => {
                  if (!disposed) setError('reader.audioError');
                });
            } catch {
              resetAudio();
              setError('reader.audioError');
            }
          }
          if (payload.event === 'audio_error' && payload.line_id === pendingAudio.current) {
            resetAudio();
            setError(String(payload.error || 'reader.audioError'));
          }
          if (payload.event === 'clip_save_failed') {
            setError(String(payload.error || 'reader.actionFailed'));
          }
          if (payload.event === 'clip_saved') setNotice('reader.clipSaved');
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          if (socketRef.current === ws) {
            socketRef.current = null;
            socketOpenRef.current = false;
          }
          if (disposed || generation !== attempt) return;
          setConnection('offline');
          retry = setTimeout(connect, Math.min(10000, 1000 * 2 ** Math.min(retries++, 4)));
        };
      } catch {
        if (!disposed && generation === attempt) {
          setConnection('offline');
          retry = setTimeout(connect, 2500);
        }
      }
    };
    void connect();
    const off = onIpc('gsm-initialized', () => {
      generation++;
      clearTimeout(retry);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      socketRef.current = null;
      void connect();
    });
    return () => {
      disposed = true;
      mounted.current = false;
      generation++;
      clearTimeout(retry);
      off();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      socketRef.current = null;
      audioRef.current?.pause();
      if (audioTimeout.current) clearTimeout(audioTimeout.current);
    };
  }, [resetAudio, updateState, trimIfNeeded, trimToLatest]);

  const select = useCallback(
    async (next: Set<string>) => {
      if (selectionPending.current) return;
      const before = selectionRef.current;
      const updates = [...new Set([...before, ...next])]
        .filter(id => before.has(id) !== next.has(id))
        .map(id => ({ id, checked: next.has(id) }));
      if (!updates.length) return;
      const version = ++selectionVersion.current;
      selectionPending.current = true;
      setSelecting(true);
      try {
        const response = await request<{ selected_ids: string[] }>('select', { updates });
        if (
          mounted.current &&
          version === selectionVersion.current &&
          Array.isArray(response.selected_ids)
        ) {
          setSelected(new Set(response.selected_ids));
        }
      } finally {
        selectionPending.current = false;
        if (mounted.current) setSelecting(false);
      }
    },
    [request],
  );

  const play = useCallback(
    async (line: ReaderLine) => {
      if (playing === line.id) {
        audioRef.current?.pause();
        setPlaying(null);
        return;
      }
      if (pendingAudio.current === line.id) {
        resetAudio();
        return;
      }
      audioRef.current?.pause();
      setPlaying(null);
      resetAudio();
      setPreparing(line.id);
      pendingAudio.current = line.id;
      audioTimeout.current = setTimeout(() => {
        resetAudio();
        if (mounted.current) setError('reader.audioTimeout');
      }, 60000);
      try {
        await request('audio', { id: line.id, playback_mode: 'browser', trim_with_vad: false });
      } catch {
        resetAudio();
      }
    },
    [playing, request, resetAudio],
  );

  return {
    ...state,
    connection,
    selected,
    selecting,
    paused,
    error,
    setError,
    notice,
    setNotice,
    playing,
    preparing,
    hasMore,
    loadingMore,
    loadingInitial,
    loadOlder,
    trimToLatest,
    select,
    request,
    play,
  };
}
