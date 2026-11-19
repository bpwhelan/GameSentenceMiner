import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderAction, ReaderConnection, ReaderLine, ReaderState } from '../../../shared/reader';
import { invokeIpc, onIpc } from './ipc';
import { applyReaderEvent, emptyReaderState, restoreReaderState } from './readerState';
import { startVisiblePolling } from './visiblePolling';
import { useDocumentVisible } from './useDocumentVisible';

export function useReader(active: boolean) {
  const [state, setState] = useState<ReaderState>(emptyReaderState);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const current = useRef(state);
  const visible = useDocumentVisible();
  const presenting = active && visible;
  const presentingRef = useRef(presenting); presentingRef.current = presenting;
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connectionRef = useRef<ReaderConnection | null>(null);
  const selectionVersion = useRef(0);
  const selectionPending = useRef(false);
  const selectionRef = useRef(selected); selectionRef.current = selected;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingAudio = useRef<string | null>(null);
  const audioTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const persist = useCallback(() => {
    clearTimeout(persistTimer.current);
    if (!connectionRef.current) return;
    try { localStorage.setItem(connectionRef.current.storageKey, JSON.stringify(current.current)); }
    catch { if (mounted.current && presentingRef.current) setNotice('reader.historyUnavailable'); }
  }, []);
  // Keep intake/corrections and persistence live without rebuilding hidden React trees.
  const updateState = useCallback((update: ReaderState | ((before: ReaderState) => ReaderState)) => {
    const next = typeof update === 'function' ? update(current.current) : update;
    if (next === current.current) return;
    current.current = next;
    if (presentingRef.current) setState(next);
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(persist, 700);
  }, [persist]);
  useEffect(() => { if (presenting) setState(current.current); }, [presenting]);
  const resetAudio = useCallback(() => {
    pendingAudio.current = null;
    if (audioTimeout.current) clearTimeout(audioTimeout.current);
    audioTimeout.current = null;
    setPreparing(null);
  }, []);

  const request = useCallback(async <T,>(action: ReaderAction, payload: Record<string, unknown> = {}): Promise<T> => {
    setError('');
    try { return await invokeIpc<T>('reader.request', action, payload); }
    catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const syncState = async () => {
      const version = selectionVersion.current;
      if (!selectionPending.current) {
        try {
          const value = await invokeIpc<{ selected_ids?: string[]; active_ids?: string[]; timed_out_ids?: string[]; session_id?: string; text_intake_paused?: boolean }>('reader.request', 'state');
          if (!disposed && value) {
            if (version === selectionVersion.current && !selectionPending.current && Array.isArray(value.selected_ids)) {
              const next = new Set(value.selected_ids.filter(id => typeof id === 'string'));
              if (selectionRef.current.size !== next.size || [...next].some(id => !selectionRef.current.has(id))) setSelected(next);
            }
            if (typeof value.text_intake_paused === 'boolean') setPaused(value.text_intake_paused);
            if (Array.isArray(value.timed_out_ids) && value.timed_out_ids.length) {
              const expired = new Set(value.timed_out_ids);
              updateState(before => {
                if (value.session_id !== before.sessionId || !before.lines.some(item => item.state !== 'expired' && expired.has(item.id))) return before;
                return { ...before, lines: before.lines.map(item => expired.has(item.id) ? { ...item, state: 'expired' } : item) };
              });
            }
          }
        } catch { /* Connection status is shown by the stream; stale state never clears a selection. */ }
      }
    };
    const stop = startVisiblePolling(syncState, 2500);
    return () => { disposed = true; stop(); };
  }, [active, updateState]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false, socket: WebSocket | null = null, generation = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let loadedKey = '', retries = 0;
    const connect = async () => {
      const attempt = ++generation;
      setConnection(retries ? 'offline' : 'connecting');
      try {
        const config = await invokeIpc<ReaderConnection>('reader.connection');
        if (disposed || generation !== attempt) return;
        if (!config?.websocketUrl || !config.storageKey) throw new Error('Reader connection is unavailable.');
        connectionRef.current = config;
        if (loadedKey !== config.storageKey) {
          loadedKey = config.storageKey;
          try { updateState(restoreReaderState(localStorage.getItem(loadedKey))); } catch { updateState(emptyReaderState()); }
          setSelected(new Set());
        }
        const ws = new WebSocket(config.websocketUrl); socket = ws;
        ws.onopen = () => {
          if (disposed || generation !== attempt) return;
          retries = 0; setConnection('live');
          ws.send(JSON.stringify({ event: 'text_v2_snapshot_request', max_lines: 1000 }));
        };
        ws.onmessage = event => {
          if (disposed || generation !== attempt) return;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(event.data); } catch { return; }
          if (!payload || typeof payload !== 'object') return;
          updateState(before => applyReaderEvent(before, payload));
          if (payload.event === 'reset_checkboxes') { selectionVersion.current++; setSelected(new Set()); }
          if (payload.event === 'audio_ready' && payload.line_id === pendingAudio.current) {
            try {
              const source = new URL(String(payload.audio_url), config.baseUrl);
              if (source.origin !== config.baseUrl || !source.pathname.startsWith('/texthooker/audio/')) throw new Error('Invalid audio URL.');
              audioRef.current?.pause();
              const audio = new Audio(source.toString()); audioRef.current = audio;
              audio.onended = () => setPlaying(null);
              audio.onerror = () => { setPlaying(null); setError('reader.audioError'); };
              resetAudio();
              void audio.play().then(() => { if (!disposed && audioRef.current === audio) setPlaying(String(payload.line_id)); }).catch(() => { if (!disposed) setError('reader.audioError'); });
            } catch { resetAudio(); setError('reader.audioError'); }
          }
          if (payload.event === 'audio_error' && payload.line_id === pendingAudio.current) { resetAudio(); setError(String(payload.error || 'reader.audioError')); }
          if (payload.event === 'clip_save_failed') setError(String(payload.error || 'reader.actionFailed'));
          if (payload.event === 'clip_saved') setNotice('reader.clipSaved');
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          if (disposed || generation !== attempt) return;
          setConnection('offline');
          retry = setTimeout(connect, Math.min(10000, 1000 * 2 ** Math.min(retries++, 4)));
        };
      } catch {
        if (!disposed && generation === attempt) { setConnection('offline'); retry = setTimeout(connect, 2500); }
      }
    };
    void connect();
    const off = onIpc('gsm-initialized', () => {
      generation++; clearTimeout(retry); if (socket) { socket.onclose = null; socket.close(); }
      void connect();
    });
    window.addEventListener('pagehide', persist);
    return () => {
      disposed = true; mounted.current = false; generation++; clearTimeout(retry); off();
      if (socket) { socket.onclose = null; socket.close(); }
      audioRef.current?.pause(); if (audioTimeout.current) clearTimeout(audioTimeout.current);
      window.removeEventListener('pagehide', persist);
      persist();
    };
  }, [resetAudio, updateState, persist]);

  const select = useCallback(async (next: Set<string>) => {
    if (selectionPending.current) return;
    const before = selectionRef.current;
    const updates = [...new Set([...before, ...next])].filter(id => before.has(id) !== next.has(id)).map(id => ({ id, checked: next.has(id) }));
    if (!updates.length) return;
    const version = ++selectionVersion.current; selectionPending.current = true; setSelecting(true);
    try {
      const response = await request<{ selected_ids: string[] }>('select', { updates });
      if (mounted.current && version === selectionVersion.current && Array.isArray(response.selected_ids)) setSelected(new Set(response.selected_ids));
    } finally { selectionPending.current = false; if (mounted.current) setSelecting(false); }
  }, [request]);

  const play = useCallback(async (line: ReaderLine) => {
    if (playing === line.id) { audioRef.current?.pause(); setPlaying(null); return; }
    if (pendingAudio.current === line.id) { resetAudio(); return; }
    audioRef.current?.pause(); setPlaying(null); resetAudio(); setPreparing(line.id); pendingAudio.current = line.id;
    audioTimeout.current = setTimeout(() => { resetAudio(); if (mounted.current) setError('reader.audioTimeout'); }, 60000);
    try { await request('audio', { id: line.id, playback_mode: 'browser', trim_with_vad: false }); }
    catch { resetAudio(); }
  }, [playing, request, resetAudio]);

  return { ...state, connection, selected, selecting, paused, error, setError, notice, setNotice, playing, preparing, select, request, play };
}
