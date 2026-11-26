import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import type { ReaderLine, ReaderScanModifier } from '../../../../shared/reader';
import { useLocale, useTranslation } from '../../i18n';
import { invokeIpc, onIpc } from '../../lib/ipc';
import {
  READER_FOLLOW_TRIM_THRESHOLD,
  READER_PAGE_SIZE,
  countCodePoints,
  matchesReaderQuery,
  normalizeScanModifier,
  readerLineKey,
  selectReaderRange,
} from '../../lib/readerState';
import { useReader } from '../../lib/useReader';
import { useDocumentVisible } from '../../lib/useDocumentVisible';
import './ReadingPane.css';

const NOOP = () => {};
const TOP_LOAD_THRESHOLD_PX = 120;
const BOTTOM_FOLLOW_THRESHOLD_PX = 70;
const SEARCH_DEBOUNCE_MS = 150;
const IS_MAC = (window.gsmEnv?.platform ?? '') === 'darwin';

const ICON_PATHS: Record<string, string> = {
  book: 'M12 5c-3-2-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15',
  play: 'm8 4 12 8-12 8V4Z',
  stop: 'M6 6h12v12H6Z',
  copy: 'M8 8h12v13H8ZM4 16H2V2h12v2',
  camera: 'M3 6h4l2-3h6l2 3h4v15H3V6Zm9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  down: 'M12 3v13m-5-5 5 5 5-5M4 20h16',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6',
  close: 'm6 6 12 12M6 18 18 6',
  focus: 'M3 3h18v18H3ZM8 3v18',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  translate: 'M3 5h12M9 2v3M6 5c0 6 4 9 8 11M12 5c0 6-4 9-9 11m12 5 4-12 4 12m-6-4h4',
  clip: 'm13 7-7 7a3 3 0 0 0 4 4l9-9a5 5 0 0 0-7-7L3 11a7 7 0 0 0 10 10l8-8',
};

const Icon = memo(function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICON_PATHS[name] || ICON_PATHS.book} />
    </svg>
  );
});

function loadSize(): number {
  try {
    return Math.max(16, Math.min(40, Number(localStorage.getItem('gsm-reader-font-size')) || 24));
  } catch {
    return 24;
  }
}

function loadScanModifier(): ReaderScanModifier {
  try {
    return normalizeScanModifier(localStorage.getItem('gsm-reader-scan-modifier'));
  } catch {
    return 'shift';
  }
}

interface RowLabels {
  selectPrefix: string;
  historyOnly: string;
  stop: string;
  preparingAudio: string;
  replay: string;
  translate: string;
  screenshot: string;
  saveClip: string;
  copy: string;
}

interface ReadingLineRowProps {
  lineKey: string;
  line: ReaderLine;
  checked: boolean;
  usable: boolean;
  selecting: boolean;
  isPlaying: boolean;
  isPreparing: boolean;
  pendingAction: string | null;
  translationText: string | null;
  timeText: string;
  showSession: boolean;
  sessionTitle: string;
  sessionStateLabel: string;
  scanModifier: ReaderScanModifier;
  labels: RowLabels;
}

/**
 * Memoized transcript row with zero per-line event listeners.
 * All clicks and text-selection mouseups are handled via event delegation on `<ol className="reading-lines">`.
 */
const ReadingLineRow = memo(function ReadingLineRow({
  lineKey,
  line,
  checked,
  usable,
  selecting,
  isPlaying,
  isPreparing,
  pendingAction,
  translationText,
  timeText,
  showSession,
  sessionTitle,
  sessionStateLabel,
  scanModifier,
  labels,
}: ReadingLineRowProps) {
  const replayLabel = isPlaying ? labels.stop : isPreparing ? labels.preparingAudio : labels.replay;
  const replayTip = isPlaying ? labels.stop : labels.replay;
  return (
    <li data-line-key={lineKey}>
      {showSession && (
        <div className="reading-session">
          <span>{sessionTitle}</span>
          <span>{sessionStateLabel}</span>
        </div>
      )}
      <article className={`reading-line ${checked ? 'selected' : ''}`}>
        <div className="reading-line-body">
          <input
            type="checkbox"
            data-action="select"
            checked={checked}
            disabled={!usable || selecting}
            aria-label={labels.selectPrefix.replace('{text}', line.text)}
            onChange={NOOP}
          />
          <div className="reading-text-block">
            <p className="reading-text" data-gsm-reader-scan={scanModifier}>
              {line.text}
            </p>
            {translationText && (
              <p className="reading-translation" data-gsm-reader-scan={scanModifier}>
                {translationText}
              </p>
            )}
            <div className="reading-line-meta">
              <span>
                {timeText}
                {line.source ? ` · ${line.source}` : ''}
                {!usable ? ` · ${labels.historyOnly}` : ''}
              </span>
              <div className="reading-line-actions">
                <button
                  type="button"
                  data-action="play"
                  disabled={!usable}
                  aria-label={replayLabel}
                  data-tip={replayTip}
                >
                  <Icon name={isPlaying ? 'stop' : 'play'} />
                  {isPreparing && <span className="reading-spinner" />}
                </button>
                <button
                  type="button"
                  data-action="translate"
                  disabled={pendingAction === 'translate'}
                  aria-label={labels.translate}
                  data-tip={labels.translate}
                >
                  <Icon name="translate" />
                </button>
                <button
                  type="button"
                  data-action="screenshot"
                  disabled={!usable || pendingAction === 'screenshot'}
                  aria-label={labels.screenshot}
                  data-tip={labels.screenshot}
                >
                  <Icon name="camera" />
                </button>
                <button
                  type="button"
                  data-action="saveClip"
                  disabled={!usable || pendingAction === 'saveClip'}
                  aria-label={labels.saveClip}
                  data-tip={labels.saveClip}
                >
                  <Icon name="clip" />
                </button>
                <button
                  type="button"
                  data-action="copy"
                  aria-label={labels.copy}
                  data-tip={labels.copy}
                >
                  <Icon name="copy" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </article>
    </li>
  );
});

export const ReadingPane = memo(function ReadingPane({
  active,
  focus,
  gameName,
  onToggleFocus,
  onOpenBrowser,
}: {
  active: boolean;
  focus: boolean;
  gameName?: string;
  onToggleFocus: () => void;
  onOpenBrowser: () => void;
}) {
  const t = useTranslation();
  const [locale] = useLocale();
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ukr' ? 'uk' : locale, {
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  );
  const [fontSize, setFontSize] = useState(loadSize);
  const [scanModifier, setScanModifier] = useState<ReaderScanModifier>(loadScanModifier);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchStart, setSearchStart] = useState<number | null>(null);
  const [translations, setTranslations] = useState<
    Record<string, { source: string; text: string; visible: boolean }>
  >({});
  const [pending, setPending] = useState<string | null>(null);

  const visible = useDocumentVisible();
  const presenting = active && visible;

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setDebouncedQuery('');
      return;
    }
    const id = window.setTimeout(() => setDebouncedQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const reader = useReader(active, {
    gameName,
    searchQuery: debouncedQuery,
    following,
  });

  const scroll = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number; firstKey: string } | null>(
    null,
  );
  const search = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);
  const previousKeys = useRef(new Set<string>());
  const previousLastKey = useRef<string | null>(null);
  const selectionFocus = useRef<HTMLInputElement | null>(null);

  const trimmedGameName = (gameName ?? '').trim();
  const hasLinkedGame = gameName === undefined || Boolean(trimmedGameName);

  const filtered = useMemo(
    () => (query.trim() ? reader.lines.filter(line => matchesReaderQuery(line.text, query)) : reader.lines),
    [reader.lines, query],
  );
  const searching = Boolean(query.trim() || debouncedQuery);
  const firstVisible = searching ? searchStart ?? Math.max(0, filtered.length - READER_PAGE_SIZE) : 0;
  const visibleLines = useMemo(() => firstVisible ? filtered.slice(firstVisible) : filtered, [filtered, firstVisible]);

  function changeQuery(value: string) {
    prependAnchor.current = null;
    setSearchStart(null);
    setFollowing(true);
    setUnseen(0);
    setQuery(value);
  }

  const lineByKey = useMemo(() => {
    const map = new Map<string, ReaderLine>();
    for (const line of filtered) map.set(readerLineKey(line), line);
    return map;
  }, [filtered]);

  const canUseMedia = useCallback(
    (line: ReaderLine) =>
      reader.connection === 'live' &&
      Boolean(reader.sessionId) &&
      line.sessionId === reader.sessionId &&
      line.state !== 'expired',
    [reader.connection, reader.sessionId],
  );

  const selectedLines = useMemo(
    () =>
      reader.lines.filter(
        line => Boolean(reader.sessionId) && line.sessionId === reader.sessionId && reader.selected.has(line.id),
      ),
    [reader.lines, reader.sessionId, reader.selected],
  );

  const characterCount = useMemo(
    () => filtered.reduce((count, line) => count + countCodePoints(line.text), 0),
    [filtered],
  );

  const rowLabels = useMemo<RowLabels>(
    () => ({
      selectPrefix: t('reader.selectLine', { text: '{text}' }),
      historyOnly: t('reader.historyOnly'),
      stop: t('reader.stop'),
      preparingAudio: t('reader.preparingAudio'),
      replay: t('reader.replay'),
      translate: t('reader.translate'),
      screenshot: t('reader.screenshot'),
      saveClip: t('reader.saveClip'),
      copy: t('reader.copy'),
    }),
    [t],
  );

  useEffect(() => {
    try {
      localStorage.setItem('gsm-reader-font-size', String(fontSize));
    } catch {
      /* ignore storage quota errors */
    }
  }, [fontSize]);

  useEffect(() => {
    try {
      localStorage.setItem('gsm-reader-scan-modifier', scanModifier);
    } catch {
      /* ignore storage quota errors */
    }
  }, [scanModifier]);

  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);

  // Reset per-game UI state when switching games.
  useEffect(() => {
    setFollowing(true);
    setUnseen(0);
    setQuery('');
    setSearchStart(null);
    setDebouncedQuery('');
    setTranslations({});
    setPending(null);
    anchor.current = null;
    previousKeys.current.clear();
    previousLastKey.current = null;
    savedScrollTop.current = 0;
    prependAnchor.current = null;
  }, [gameName]);

  // Drop translations for lines no longer in memory so the map never leaks.
  useEffect(() => {
    const live = new Map(reader.lines.map(line => [readerLineKey(line), line.text]));
    setTranslations(before => {
      const keys = Object.keys(before);
      if (!keys.length) return before;
      const entries = Object.entries(before).filter(
        ([key, translation]) => live.get(key) === translation.source,
      );
      return entries.length === keys.length ? before : Object.fromEntries(entries);
    });
  }, [reader.lines]);

  // Track unseen lines (only newly appended lines at the bottom, never older prepended pages).
  useEffect(() => {
    const nextKeys = new Set(reader.lines.map(readerLineKey));
    const prevLast = previousLastKey.current;
    if (!following && previousKeys.current.size && prevLast) {
      let lastIndex = -1;
      for (let i = reader.lines.length - 1; i >= 0; i--) {
        if (readerLineKey(reader.lines[i]) === prevLast) {
          lastIndex = i;
          break;
        }
      }
      if (lastIndex >= 0) {
        let addedAtEnd = 0;
        for (let i = lastIndex + 1; i < reader.lines.length; i++) {
          if (!previousKeys.current.has(readerLineKey(reader.lines[i]))) addedAtEnd++;
        }
        if (addedAtEnd > 0) setUnseen(value => value + addedAtEnd);
      }
    }
    previousKeys.current = nextKeys;
    previousLastKey.current = reader.lines.length
      ? readerLineKey(reader.lines[reader.lines.length - 1])
      : null;
  }, [reader.lines, following]);

  // Preserve scroll position when prepending older pages; stick to bottom when following.
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!presenting || !el) return;
    const savedAnchor = prependAnchor.current;
    const currentFirstKey = visibleLines.length ? readerLineKey(visibleLines[0]) : '';
    if (savedAnchor && currentFirstKey && currentFirstKey !== savedAnchor.firstKey) {
      const delta = el.scrollHeight - savedAnchor.scrollHeight;
      el.scrollTop = savedAnchor.scrollTop + Math.max(0, delta);
      savedScrollTop.current = el.scrollTop;
      prependAnchor.current = null;
      return;
    }
    if (following) {
      el.scrollTop = el.scrollHeight;
      savedScrollTop.current = el.scrollTop;
    } else {
      el.scrollTop = savedScrollTop.current;
    }
  }, [visibleLines, following, presenting, fontSize]);

  useEffect(() => {
    if (!active) return;
    const attachDictionary = () => {
      void invokeIpc('reader.attachDictionary').catch(reason =>
        reader.setError(reason instanceof Error ? reason.message : String(reason)),
      );
    };
    const off = onIpc('dictionary-library-changed', attachDictionary);
    attachDictionary();
    return () => {
      off();
      window.dispatchEvent(new Event('gsm-reader-feed-closed'));
    };
  }, [active]);

  const triggerLoadOlder = useCallback(() => {
    if ((!firstVisible && !reader.hasMore) || reader.loadingMore || reader.loadingInitial) return;
    const el = scroll.current;
    if (el && visibleLines.length) {
      prependAnchor.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        firstKey: readerLineKey(visibleLines[0]),
      };
    }
    setFollowing(false);
    if (firstVisible) {
      setSearchStart(Math.max(0, firstVisible - READER_PAGE_SIZE));
      return;
    }
    void reader.loadOlder().then(added => {
      if (!added) prependAnchor.current = null;
    });
  }, [reader, visibleLines, firstVisible]);

  const follow = useCallback(() => {
    prependAnchor.current = null;
    setSearchStart(null);
    setFollowing(true);
    setUnseen(0);
    reader.trimToLatest();
    if (scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      savedScrollTop.current = scroll.current.scrollTop;
    }
  }, [reader]);

  const selectLine = useCallback(
    async (line: ReaderLine, checked: boolean, shift: boolean) => {
      const order = filtered.filter(canUseMedia).map(item => item.id);
      const next =
        shift && anchor.current
          ? selectReaderRange(reader.selected, order, anchor.current, line.id, checked)
          : new Set(reader.selected);
      if (!shift || !anchor.current) checked ? next.add(line.id) : next.delete(line.id);
      anchor.current = line.id;
      setFollowing(false);
      try {
        await reader.select(next);
      } catch {
        /* The hook shows action errors. */
      }
    },
    [filtered, canUseMedia, reader],
  );

  const action = useCallback(
    async (line: ReaderLine, name: 'translate' | 'screenshot' | 'saveClip' | 'copy') => {
      const key = readerLineKey(line);
      if (name === 'translate') {
        const cached = translations[key];
        if (cached?.source === line.text) {
          setTranslations(values => ({
            ...values,
            [key]: { ...values[key], visible: !values[key].visible },
          }));
          return;
        }
        if (line.translation) {
          setTranslations(values => ({
            ...values,
            [key]: { source: line.text, text: line.translation!, visible: true },
          }));
          return;
        }
      }
      setPending(`${key}/${name}`);
      reader.setError('');
      try {
        if (name === 'copy') {
          await invokeIpc('reader.copy', line.text);
          reader.setNotice('reader.copied');
        } else {
          const response = await reader.request<{ TL?: string; already_saved?: boolean }>(name, {
            id: line.id,
            text: line.text,
          });
          if (name === 'translate' && typeof response.TL === 'string') {
            setTranslations(values => ({
              ...values,
              [key]: { source: line.text, text: response.TL!, visible: true },
            }));
          } else {
            reader.setNotice(
              name === 'saveClip' && response.already_saved ? 'reader.clipSaved' : 'reader.requested',
            );
          }
        }
      } catch (reason) {
        reader.setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending(null);
      }
    },
    [translations, reader],
  );

  // Single delegated click handler for all transcript rows (checkboxes + action buttons).
  const handleListClick = useCallback(
    (event: MouseEvent<HTMLOListElement>) => {
      const target = event.target as HTMLElement | null;
      const control = target?.closest<HTMLElement>('[data-action]');
      if (!control) return;
      const row = control.closest<HTMLElement>('[data-line-key]');
      const key = row?.dataset.lineKey;
      if (!key) return;
      const line = lineByKey.get(key);
      if (!line) return;
      const act = control.dataset.action;
      if (act === 'select' && control instanceof HTMLInputElement) {
        if (control.disabled) return;
        selectionFocus.current = control;
        void selectLine(line, control.checked, event.shiftKey);
      } else if (act === 'play') {
        if (canUseMedia(line)) void reader.play(line);
      } else if (
        act === 'translate' ||
        act === 'screenshot' ||
        act === 'saveClip' ||
        act === 'copy'
      ) {
        if ((act === 'screenshot' || act === 'saveClip') && !canUseMedia(line)) return;
        void action(line, act);
      }
    },
    [lineByKey, selectLine, canUseMedia, reader, action],
  );

  // Single delegated mouseup handler for text selection pausing auto-follow.
  const handleListMouseUp = useCallback((event: MouseEvent<HTMLOListElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.reading-text') && window.getSelection()?.toString()) {
      setFollowing(false);
    }
  }, []);

  const labelError = reader.error.startsWith('reader.') ? t(reader.error) : reader.error;

  return (
    <section
      className="reading-pane"
      aria-label={t('reader.title')}
      style={{ '--reading-font-size': `${fontSize}px` } as CSSProperties}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
          event.preventDefault();
          setSearchOpen(true);
          search.current?.focus();
        }
        if (event.key === 'Escape' && searchOpen) {
          setSearchOpen(false);
          changeQuery('');
        }
      }}
    >
      <header className="reading-toolbar">
        <div className="reading-title">
          <Icon name="book" />
          <h2>{t('reader.title')}</h2>
          {trimmedGameName && (
            <span className="reading-game-badge" title={trimmedGameName}>
              {trimmedGameName}
            </span>
          )}
          <span className={`reading-status ${reader.connection}`} role="status">
            {t(`reader.connection.${reader.connection}`)}
          </span>
        </div>
        <div className="reading-tools">
          <button
            type="button"
            onClick={() => {
              if (searchOpen) changeQuery('');
              setSearchOpen(!searchOpen);
            }}
            aria-label={t('reader.search')}
            aria-pressed={searchOpen}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            onClick={() => setFontSize(value => Math.max(16, value - 2))}
            disabled={fontSize <= 16}
            aria-label={t('reader.smaller')}
          >
            {t('reader.smallerSymbol')}
          </button>
          <button
            type="button"
            onClick={() => setFontSize(value => Math.min(40, value + 2))}
            disabled={fontSize >= 40}
            aria-label={t('reader.larger')}
          >
            {t('reader.largerSymbol')}
          </button>
          <button
            type="button"
            onClick={onToggleFocus}
            aria-pressed={focus}
            aria-label={t(focus ? 'reader.showControls' : 'reader.focus')}
            data-tip={t(focus ? 'reader.showControls' : 'reader.focus')}
          >
            <Icon name="focus" />
          </button>
          <button
            type="button"
            onClick={onOpenBrowser}
            aria-label={t('reader.browser')}
            data-tip={t('reader.browser')}
          >
            <Icon name="external" />
          </button>
        </div>
      </header>
      {searchOpen && (
        <div className="reading-search">
          <Icon name="search" />
          <input
            ref={search}
            type="search"
            value={query}
            onChange={event => changeQuery(event.target.value)}
            placeholder={t('reader.search')}
            aria-label={t('reader.search')}
          />
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              changeQuery('');
            }}
            aria-label={t('reader.close')}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {reader.paused && <div className="reading-notice">{t('reader.intakePaused')}</div>}
      {reader.error && (
        <div className="reading-error" role="alert">
          <span>{labelError}</span>
          <button type="button" onClick={() => reader.setError('')} aria-label={t('reader.dismiss')}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <div
        className="reading-transcript"
        ref={scroll}
        onWheel={event => {
          if (!event.ctrlKey && event.deltaY < 0 && event.currentTarget.scrollTop === 0) {
            triggerLoadOlder();
          }
        }}
        onScroll={event => {
          if (!presenting) return;
          const element = event.currentTarget;
          savedScrollTop.current = element.scrollTop;
          const atEnd =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            BOTTOM_FOLLOW_THRESHOLD_PX;
          if (!atEnd && element.scrollTop <= TOP_LOAD_THRESHOLD_PX && (reader.hasMore || firstVisible > 0)) {
            triggerLoadOlder();
            return;
          }
          if (!atEnd) {
            if (query.trim() && searchStart === null) setSearchStart(firstVisible);
            setFollowing(false);
          } else if (!reader.selected.size) {
            setFollowing(true);
            setUnseen(0);
            if (reader.lines.length > READER_FOLLOW_TRIM_THRESHOLD) {
              reader.trimToLatest();
            }
          }
        }}
      >
        {presenting && (reader.loadingMore || reader.hasMore) && filtered.length > 0 && (
          <div className="reading-history-banner">
            {reader.loadingMore ? (
              <span role="status">{t('reader.loadingOlder')}</span>
            ) : (
              <button type="button" className="reading-load-older" onClick={triggerLoadOlder}>
                {t('reader.loadOlder')}
              </button>
            )}
          </div>
        )}
        {!filtered.length && !reader.loadingInitial && (
          <div className="reading-empty">
            <Icon name="book" />
            <h3>
              {t(
                !hasLinkedGame
                  ? 'reader.selectGameTitle'
                  : query
                    ? 'reader.noMatches'
                    : 'reader.emptyTitle',
              )}
            </h3>
            <p>
              {t(
                !hasLinkedGame
                  ? 'reader.selectGameHint'
                  : query
                    ? 'reader.noMatchesHint'
                    : 'reader.emptyHint',
              )}
            </p>
          </div>
        )}
        <ol
          className="reading-lines"
          onClick={handleListClick}
          onMouseUp={handleListMouseUp}
        >
          {presenting &&
            visibleLines.map((line, index) => {
              const key = readerLineKey(line);
              const usable = canUseMedia(line);
              const checked =
                Boolean(reader.sessionId) &&
                line.sessionId === reader.sessionId &&
                reader.selected.has(line.id);
              const translation = translations[key];
              const translationText =
                translation?.source === line.text && translation.visible ? translation.text : null;
              const isCurrentSession =
                Boolean(reader.sessionId) && line.sessionId === reader.sessionId;
              const newSession = !index || visibleLines[index - 1].sessionId !== line.sessionId;
              const date = line.capturedAt ? new Date(line.capturedAt) : null;
              const timeText =
                date && Number.isFinite(date.getTime()) ? timeFormat.format(date) : '';
              const pendingAction =
                pending && pending.startsWith(`${key}/`) ? pending.slice(key.length + 1) : null;
              return (
                <ReadingLineRow
                  key={key}
                  lineKey={key}
                  line={line}
                  checked={checked}
                  usable={usable}
                  selecting={reader.selecting}
                  isPlaying={reader.playing === line.id}
                  isPreparing={reader.preparing === line.id}
                  pendingAction={pendingAction}
                  translationText={translationText}
                  timeText={timeText}
                  showSession={newSession}
                  sessionTitle={
                    line.scene ||
                    t(isCurrentSession ? 'reader.currentSession' : 'reader.previousSession')
                  }
                  sessionStateLabel={t(
                    isCurrentSession ? 'reader.currentSession' : 'reader.previousSession',
                  )}
                  scanModifier={scanModifier}
                  labels={rowLabels}
                />
              );
            })}
        </ol>
      </div>
      {reader.selected.size > 0 && (
        <div className="reading-selection">
          <span aria-live="polite">{t('reader.selected', { count: reader.selected.size })}</span>
          <button
            type="button"
            disabled={reader.selecting}
            onClick={() =>
              void reader
                .select(new Set())
                .then(() => selectionFocus.current?.focus())
                .catch(() => {})
            }
          >
            {t('reader.clearSelection')}
          </button>
          <button
            type="button"
            disabled={
              reader.connection !== 'live' ||
              reader.selecting ||
              !selectedLines.length ||
              selectedLines.some(line => !canUseMedia(line))
            }
            onClick={() =>
              void reader
                .request('createMedia', { ids: selectedLines.map(line => line.id) })
                .then(() => reader.setNotice('reader.requested'))
                .catch(() => {})
            }
          >
            <Icon name="clip" />
            {t('reader.createMedia')}
          </button>
        </div>
      )}
      {reader.notice && (
        <div className="reading-notice" role="status">
          <span>{t(reader.notice)}</span>
          <button type="button" onClick={() => reader.setNotice('')} aria-label={t('reader.dismiss')}>
            <Icon name="close" />
          </button>
        </div>
      )}
      <footer className="reading-footer">
        <span>{t('reader.lineCount', { count: filtered.length })}</span>
        <span>{t('reader.characterCount', { count: characterCount })}</span>
        <label className="reading-scan-modifier">
          <select
            aria-label={t('reader.lookupModifier')}
            value={scanModifier}
            onChange={event => setScanModifier(normalizeScanModifier(event.target.value))}
          >
            <option value="shift">{t('reader.modifier.shift')}</option>
            <option value="ctrl">{t('reader.modifier.ctrl')}</option>
            <option value="alt">{t('reader.modifier.alt')}</option>
            {IS_MAC && <option value="meta">{t('reader.modifier.meta')}</option>}
            <option value="none">{t('reader.modifier.none')}</option>
          </select>
          <span>
            {t(
              scanModifier === 'none'
                ? 'reader.lookupHintHoverOnly'
                : 'reader.lookupHintWithModifier',
            )}
          </span>
        </label>
        <button
          type="button"
          aria-pressed={following}
          onClick={following ? () => setFollowing(false) : follow}
        >
          <Icon name="down" />
          {t(following ? 'reader.following' : unseen ? 'reader.newLines' : 'reader.follow', {
            count: unseen,
          })}
        </button>
      </footer>
    </section>
  );
});
