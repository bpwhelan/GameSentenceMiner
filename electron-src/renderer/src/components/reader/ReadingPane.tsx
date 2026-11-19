import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ReaderDictionaryTransfer, ReaderLine } from '../../../../shared/reader';
import { useLocale, useTranslation } from '../../i18n';
import { invokeIpc } from '../../lib/ipc';
import { readerLineKey, selectReaderRange } from '../../lib/readerState';
import { useReader } from '../../lib/useReader';
import { retainEqual, startVisiblePolling } from '../../lib/visiblePolling';
import { useDocumentVisible } from '../../lib/useDocumentVisible';
import './ReadingPane.css';

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    book: 'M12 5c-3-2-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15',
    play: 'm8 4 12 8-12 8V4Z', stop: 'M6 6h12v12H6Z', copy: 'M8 8h12v13H8ZM4 16H2V2h12v2',
    camera: 'M3 6h4l2-3h6l2 3h4v15H3V6Zm9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    down: 'M12 3v13m-5-5 5 5 5-5M4 20h16', search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6',
    close: 'm6 6 12 12M6 18 18 6', focus: 'M3 3h18v18H3ZM8 3v18', external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
    translate: 'M3 5h12M9 2v3M6 5c0 6 4 9 8 11M12 5c0 6-4 9-9 11m12 5 4-12 4 12m-6-4h4',
    clip: 'm13 7-7 7a3 3 0 0 0 4 4l9-9a5 5 0 0 0-7-7L3 11a7 7 0 0 0 10 10l8-8',
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] || paths.book} /></svg>;
}

function loadSize(): number {
  try { return Math.max(16, Math.min(40, Number(localStorage.getItem('gsm-reader-font-size')) || 24)); } catch { return 24; }
}

export const ReadingPane = memo(function ReadingPane({ active, focus, onToggleFocus, onOpenBrowser }: {
  active: boolean; focus: boolean; onToggleFocus: () => void; onOpenBrowser: () => void;
}) {
  const t = useTranslation(), [locale] = useLocale();
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale === 'ukr' ? 'uk' : locale, { hour: '2-digit', minute: '2-digit' }), [locale]);
  const reader = useReader(active);
  const visible = useDocumentVisible();
  const presenting = active && visible;
  const [fontSize, setFontSize] = useState(loadSize);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [translations, setTranslations] = useState<Record<string, { source: string; text: string; visible: boolean }>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<ReaderDictionaryTransfer[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);
  const previousKeys = useRef(new Set<string>());
  const selectionFocus = useRef<HTMLInputElement | null>(null);
  const filtered = useMemo(() => reader.lines.filter(line => !query || line.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [reader.lines, query]);
  const selectedLines = useMemo(() => reader.lines.filter(line => line.sessionId === reader.sessionId && reader.selected.has(line.id)), [reader.lines, reader.sessionId, reader.selected]);
  const characterCount = useMemo(() => filtered.reduce((count, line) => count + [...line.text].length, 0), [filtered]);
  const canUseMedia = (line: ReaderLine) => reader.connection === 'live' && line.sessionId === reader.sessionId && line.state !== 'expired';

  useEffect(() => { try { localStorage.setItem('gsm-reader-font-size', String(fontSize)); } catch {} }, [fontSize]);
  useEffect(() => { if (searchOpen) search.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    const live = new Map(reader.lines.map(line => [readerLineKey(line), line.text]));
    setTranslations(before => {
      const entries = Object.entries(before).filter(([key, translation]) => live.get(key) === translation.source);
      return entries.length === Object.keys(before).length ? before : Object.fromEntries(entries);
    });
  }, [reader.lines]);
  useEffect(() => {
    const keys = new Set(reader.lines.map(readerLineKey));
    const added = reader.lines.filter(line => !previousKeys.current.has(readerLineKey(line))).length;
    if (!following && previousKeys.current.size && added) setUnseen(value => value + added);
    previousKeys.current = keys;
    if (presenting && scroll.current) scroll.current.scrollTop = following ? scroll.current.scrollHeight : savedScrollTop.current;
  }, [reader.lines, following, presenting, fontSize]);
  useEffect(() => {
    if (!active) return;
    void invokeIpc('reader.attachDictionary').catch(reason => reader.setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { window.dispatchEvent(new Event('gsm-reader-feed-closed')); };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const refresh = async () => {
      const value = await invokeIpc<ReaderDictionaryTransfer[]>('reader.dictionaryTransfers');
      if (!disposed && Array.isArray(value)) setTransfers(before => retainEqual(before, value));
    };
    const stop = startVisiblePolling(refresh, 1000);
    return () => { disposed = true; stop(); };
  }, [active]);

  const follow = () => { setFollowing(true); setUnseen(0); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; };
  async function selectLine(line: ReaderLine, checked: boolean, shift: boolean) {
    const order = filtered.filter(canUseMedia).map(item => item.id);
    const next = shift && anchor.current ? selectReaderRange(reader.selected, order, anchor.current, line.id, checked) : new Set(reader.selected);
    if (!shift || !anchor.current) checked ? next.add(line.id) : next.delete(line.id);
    anchor.current = line.id; setFollowing(false);
    try { await reader.select(next); } catch { /* The hook shows action errors. */ }
  }
  async function action(line: ReaderLine, name: 'translate' | 'screenshot' | 'saveClip' | 'copy') {
    const key = readerLineKey(line);
    if (name === 'translate' && translations[key]?.source === line.text) {
      setTranslations(values => ({ ...values, [key]: { ...values[key], visible: !values[key].visible } })); return;
    }
    setPending(`${key}/${name}`); reader.setError('');
    try {
      if (name === 'copy') { await invokeIpc('reader.copy', line.text); reader.setNotice('reader.copied'); }
      else {
        const response = await reader.request<{ TL?: string; already_saved?: boolean }>(name, { id: line.id, text: line.text });
        if (name === 'translate' && typeof response.TL === 'string') setTranslations(values => ({ ...values, [key]: { source: line.text, text: response.TL!, visible: true } }));
        else reader.setNotice(name === 'saveClip' && response.already_saved ? 'reader.clipSaved' : 'reader.requested');
      }
    } catch (reason) { reader.setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPending(null); }
  }
  const labelError = reader.error.startsWith('reader.') ? t(reader.error) : reader.error;
  return <section className="reading-pane" aria-label={t('reader.title')} style={{ '--reading-font-size': `${fontSize}px` } as CSSProperties} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') { event.preventDefault(); setSearchOpen(true); search.current?.focus(); }
    if (event.key === 'Escape' && searchOpen) { setSearchOpen(false); setQuery(''); }
  }}>
    <header className="reading-toolbar">
      <div className="reading-title"><Icon name="book" /><h2>{t('reader.title')}</h2><span className={`reading-status ${reader.connection}`} role="status">{t(`reader.connection.${reader.connection}`)}</span></div>
      <div className="reading-tools">
        <button type="button" onClick={() => setSearchOpen(value => !value)} aria-label={t('reader.search')} aria-pressed={searchOpen} data-tip={t('reader.search')}><Icon name="search" /></button>
        <button type="button" onClick={() => setFontSize(value => Math.max(16, value - 2))} disabled={fontSize <= 16} aria-label={t('reader.smaller')}>{t('reader.smallerSymbol')}</button>
        <button type="button" onClick={() => setFontSize(value => Math.min(40, value + 2))} disabled={fontSize >= 40} aria-label={t('reader.larger')}>{t('reader.largerSymbol')}</button>
        <button type="button" onClick={onToggleFocus} aria-pressed={focus} aria-label={t(focus ? 'reader.showControls' : 'reader.focus')} data-tip={t(focus ? 'reader.showControls' : 'reader.focus')}><Icon name="focus" /></button>
        <button type="button" onClick={onOpenBrowser} aria-label={t('reader.browser')} data-tip={t('reader.browser')}><Icon name="external" /></button>
      </div>
    </header>
    {searchOpen && <div className="reading-search"><Icon name="search" /><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('reader.search')} aria-label={t('reader.search')} /><button type="button" onClick={() => { setSearchOpen(false); setQuery(''); }} aria-label={t('reader.close')}><Icon name="close" /></button></div>}
    {reader.paused && <div className="reading-notice">{t('reader.intakePaused')}</div>}
    {transfers.map(transfer => <div key={transfer.name} className={transfer.phase === 'failed' ? 'reading-error' : 'reading-notice'} role="status">{t(`reader.transfer.${transfer.phase}`, { name: transfer.name, count: transfer.records.toLocaleString() })}</div>)}
    {reader.error && <div className="reading-error" role="alert"><span>{labelError}</span><button type="button" onClick={() => reader.setError('')} aria-label={t('reader.dismiss')}><Icon name="close" /></button></div>}
    <div className="reading-transcript" ref={scroll} onScroll={event => {
      if (!presenting) return;
      const element = event.currentTarget;
      savedScrollTop.current = element.scrollTop;
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
      if (!atEnd) setFollowing(false);
      else if (!reader.selected.size) { setFollowing(true); setUnseen(0); }
    }}>
      {!filtered.length && <div className="reading-empty"><Icon name="book" /><h3>{t(query ? 'reader.noMatches' : 'reader.emptyTitle')}</h3><p>{t(query ? 'reader.noMatchesHint' : 'reader.emptyHint')}</p></div>}
      <ol className="reading-lines">
        {presenting && filtered.map((line, index) => {
          const key = readerLineKey(line), usable = canUseMedia(line);
          const checked = line.sessionId === reader.sessionId && reader.selected.has(line.id);
          const translation = translations[key];
          const newSession = !index || filtered[index - 1].sessionId !== line.sessionId;
          const date = new Date(line.capturedAt);
          return <li key={key}>
            {newSession && <div className="reading-session"><span>{line.scene || t(line.sessionId === reader.sessionId ? 'reader.currentSession' : 'reader.previousSession')}</span><span>{t(line.sessionId === reader.sessionId ? 'reader.currentSession' : 'reader.previousSession')}</span></div>}
            <article className={`reading-line ${checked ? 'selected' : ''}`}>
              <div className="reading-line-body">
                <input type="checkbox" checked={checked} disabled={!usable || reader.selecting} aria-label={t('reader.selectLine', { text: line.text })} onClick={event => { selectionFocus.current = event.currentTarget; void selectLine(line, event.currentTarget.checked, event.shiftKey); }} onChange={() => {}} />
                <div className="reading-text-block">
                  <p className="reading-text" data-gsm-reader-scan="shift" onMouseUp={() => { if (window.getSelection()?.toString()) setFollowing(false); }}>{line.text}</p>
                  {translation?.source === line.text && translation.visible && <p className="reading-translation" data-gsm-reader-scan="shift">{translation.text}</p>}
                  <div className="reading-line-meta">
                    <span>{Number.isFinite(date.getTime()) ? timeFormat.format(date) : ''}{line.source ? ` · ${line.source}` : ''}{!usable ? ` · ${t('reader.historyOnly')}` : ''}</span>
                    <div className="reading-line-actions">
                      <button type="button" disabled={!usable} aria-label={t(reader.playing === line.id ? 'reader.stop' : reader.preparing === line.id ? 'reader.preparingAudio' : 'reader.replay')} data-tip={t(reader.playing === line.id ? 'reader.stop' : 'reader.replay')} onClick={() => void reader.play(line)}><Icon name={reader.playing === line.id ? 'stop' : 'play'} />{reader.preparing === line.id && <span className="reading-spinner" />}</button>
                      <button type="button" disabled={pending === `${key}/translate`} aria-label={t('reader.translate')} data-tip={t('reader.translate')} onClick={() => void action(line, 'translate')}><Icon name="translate" /></button>
                      <button type="button" disabled={!usable || pending === `${key}/screenshot`} aria-label={t('reader.screenshot')} data-tip={t('reader.screenshot')} onClick={() => void action(line, 'screenshot')}><Icon name="camera" /></button>
                      <button type="button" disabled={!usable || pending === `${key}/saveClip`} aria-label={t('reader.saveClip')} data-tip={t('reader.saveClip')} onClick={() => void action(line, 'saveClip')}><Icon name="clip" /></button>
                      <button type="button" aria-label={t('reader.copy')} data-tip={t('reader.copy')} onClick={() => void action(line, 'copy')}><Icon name="copy" /></button>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </li>;
        })}
      </ol>
    </div>
    {reader.selected.size > 0 && <div className="reading-selection"><span aria-live="polite">{t('reader.selected', { count: reader.selected.size })}</span><button type="button" disabled={reader.selecting} onClick={() => void reader.select(new Set()).then(() => selectionFocus.current?.focus()).catch(() => {})}>{t('reader.clearSelection')}</button><button type="button" disabled={reader.connection !== 'live' || reader.selecting || !selectedLines.length || selectedLines.some(line => !canUseMedia(line))} onClick={() => void reader.request('createMedia', { ids: selectedLines.map(line => line.id) }).then(() => reader.setNotice('reader.requested')).catch(() => {})}><Icon name="clip" />{t('reader.createMedia')}</button></div>}
    {reader.notice && <div className="reading-notice" role="status"><span>{t(reader.notice)}</span><button type="button" onClick={() => reader.setNotice('')} aria-label={t('reader.dismiss')}><Icon name="close" /></button></div>}
    <footer className="reading-footer"><span>{t('reader.lineCount', { count: filtered.length })}</span><span>{t('reader.characterCount', { count: characterCount })}</span><span>{t('reader.lookupHint')}</span><button type="button" aria-pressed={following} onClick={following ? () => setFollowing(false) : follow}><Icon name="down" />{t(following ? 'reader.following' : unseen ? 'reader.newLines' : 'reader.follow', { count: unseen })}</button></footer>
  </section>;
});
