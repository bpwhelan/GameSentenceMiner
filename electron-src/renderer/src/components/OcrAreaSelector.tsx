import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from '../i18n';
import { invokeIpc, onIpc } from '../lib/ipc';
import './OcrAreaSelector.css';

type Point = [number, number];
type Bounds = [number, number, number, number];
type Mode = 'normal' | 'exclusion' | 'secondary' | 'exclusive' | 'blackHole';
type Flags = { excluded?: boolean; secondary?: boolean; exclusive?: boolean; blackHole?: boolean };
export type SelectorArea = Flags & { xywh: Bounds; monitor?: number };
type Area = SelectorArea;
type Frame = { image: string; rects: Area[]; width: number; height: number; monitor?: number };
type Options = { obs: boolean; single: boolean; monitorOnly: boolean; live: boolean; help: boolean };
type Action = { index: number; area: Area; add: boolean };
type Menu = { x: number; y: number; hits: number[] };
const modes: Mode[] = ['normal', 'exclusion', 'secondary', 'exclusive', 'blackHole'];
const modeFlags: Record<Mode, Flags> = {
    normal: {}, exclusion: { excluded: true }, secondary: { secondary: true },
    exclusive: { exclusive: true }, blackHole: { blackHole: true },
};
const glyphs: Record<Mode, string> = { normal: '🟢', exclusion: '🟠', secondary: '🟣', exclusive: '🔷', blackHole: '⬛' };
const colors: Record<Mode, string> = { normal: '#0f0', exclusion: '#ffa500', secondary: '#800080', exclusive: '#00dcff', blackHole: '#000' };

function kind(area: Flags): Mode {
    if (area.blackHole) return 'blackHole';
    if (area.excluded) return 'exclusion';
    if (area.secondary) return 'secondary';
    if (area.exclusive) return 'exclusive';
    return 'normal';
}

function bounds([x, y]: Point, [endX, endY]: Point): Bounds {
    return [Math.min(x, endX), Math.min(y, endY), Math.abs(x - endX), Math.abs(y - endY)];
}

function hits(areas: Area[], [x, y]: Point) {
    return areas.flatMap(({ xywh: [left, top, w, h] }, i) => (
        x >= left && y >= top && x <= left + w && y <= top + h ? [i] : []
    ));
}

function flagsForDrag(options: Options, mode: Mode | null, event: ReactPointerEvent): Flags {
    if (mode) return modeFlags[mode];
    if (options.monitorOnly) return {};
    if (event.altKey) return event.ctrlKey ? { blackHole: true } : { exclusive: true };
    return { secondary: event.ctrlKey, excluded: event.shiftKey };
}

function apply(areas: Area[], { add, area, index }: Action) {
    const result = [...areas];
    result.splice(index, add ? 0 : 1, ...(add ? [area] : []));
    return result;
}

export interface InlineSelectorHost {
    load: () => Promise<{help: boolean; capture: Frame}>;
    save: (areas: SelectorArea[]) => Promise<void>;
    close: (saved: boolean) => void;
    refresh: () => void;
}

export function OcrAreaSelector({ active = true, host, preview, autoRefresh: viewerAutoRefresh, onAutoRefreshChange }: {
    active?: boolean;
    host?: InlineSelectorHost;
    autoRefresh?: boolean;
    onAutoRefreshChange?: (enabled: boolean) => void;
    preview?: {imageData: string; width: number; height: number};
} = {}) {
    const t = useTranslation();
    const [options, setOptions] = useState<Options>();
    const [frame, setFrame] = useState<Frame>();
    const [image, setImage] = useState('');
    const [captureNonce, retry] = useState(0);
    const [areas, setAreas] = useState<Area[]>([]);
    const [draft, setDraft] = useState<Area>();
    const [mode, setMode] = useState<Mode | null>(null);
    const [menu, setMenu] = useState<Menu>();
    const [highlight, setHighlight] = useState(-1);
    const [help, setHelp] = useState(true);
    const [dimHelp, setDimHelp] = useState(false);
    const [live, setLive] = useState(Boolean(host));
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [error, setError] = useState('');
    const [closing, setClosing] = useState(false);
    const [stageSize, setStageSize] = useState<Point>([0, 0]);
    const stage = useRef<HTMLDivElement>(null);
    const imageBox = useRef<HTMLDivElement>(null);
    const menuBox = useRef<HTMLDivElement>(null);
    const helpBox = useRef<HTMLElement>(null);
    const undo = useRef<Action[]>([]);
    const redo = useRef<Action[]>([]);
    const drag = useRef<{ start: Point; origin: Point; flags: Flags; id: number } | undefined>(undefined);
    const longPress = useRef<number | undefined>(undefined);
    const liveTimer = useRef<number | undefined>(undefined);
    const refreshing = useRef(false);
    const finishing = useRef(false);
    const areaRef = useRef<Area[]>([]);
    const modeLabel = (id: Mode) => t(`nativeDialogs.area.modes.${id}`);
    const report = (e: unknown) => setError(String(e));
    const requestedTitle = t(options?.single ? 'nativeDialogs.area.addTitle' : 'nativeDialogs.area.title');

    useEffect(() => {
        let active = true;
        setError('');
        const load = async () => {
            let capture: Frame;
            if (host) {
                const layout = await host.load();
                if (!active) return;
                setOptions({obs:true, single:false, monitorOnly:false, live:false, help:layout.help});
                setHelp(layout.help);
                capture = layout.capture;
            } else {
                const next = await invokeIpc<Options>('ocrArea.options');
                if (!active) return;
                setOptions(next);
                setLive(next.live);
                setHelp(next.help);
                capture = await invokeIpc<Frame>('ocrArea.capture');
                if (!active) return;
            }
            undo.current = capture.rects.map((area, index) => ({ area, index, add: true }));
            redo.current = [];
            areaRef.current = capture.rects;
            setAreas(capture.rects);
            setImage(capture.image);
            setFrame(capture);
        };
        void load().catch((e) => { if (active) report(e); });
        return () => { active = false; };
    }, [captureNonce, host]);
    useEffect(() => {
        if (!host) void invokeIpc('ocrArea.title', requestedTitle).catch(() => {});
    }, [host, requestedTitle]);
    useEffect(() => {
        if (!stage.current) return;
        const observer = new ResizeObserver(([entry]) => {
            setStageSize([entry.contentRect.width, entry.contentRect.height]);
        });
        observer.observe(stage.current);
        return () => observer.disconnect();
    }, []);
    useLayoutEffect(() => {
        if (!menu || !menuBox.current) return;
        const element = menuBox.current;
        const bounds = element.parentElement!.getBoundingClientRect();
        element.style.left = `${Math.max(0, Math.min(menu.x - bounds.left, bounds.width - element.offsetWidth))}px`;
        element.style.top = `${Math.max(0, Math.min(menu.y - bounds.top, bounds.height - element.offsetHeight))}px`;
        element.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    }, [menu]);
    useEffect(() => () => {
        window.clearTimeout(longPress.current);
        window.clearTimeout(liveTimer.current);
    }, []);

    const refresh = useCallback(async (manual: boolean) => {
        if (host) { host.refresh(); return; }
        if (refreshing.current || finishing.current) return;
        refreshing.current = true;
        try {
            const url = await invokeIpc<string>('ocrArea.refresh');
            const next = new Image();
            next.src = url;
            await next.decode();
            setImage(url);
            if (manual) setError('');
        } catch (e) {
            if (manual) report(e);
        } finally {
            refreshing.current = false;
        }
    }, [host]);
    useEffect(() => {
        if (host || !frame || !autoRefresh) return;
        const timer = window.setInterval(() => void refresh(false), 1000);
        return () => window.clearInterval(timer);
    }, [autoRefresh, frame, refresh, host]);

    const liveSave = useCallback(() => {
        window.clearTimeout(liveTimer.current);
        if (finishing.current) return;
        const rects = areaRef.current;
        void (host ? host.save(rects) : invokeIpc('ocrArea.save', { rects })).catch(report);
    }, [host]);

    const finish = useCallback(async (save: boolean, single?: Area) => {
        if (finishing.current) return;
        finishing.current = true;
        window.clearTimeout(liveTimer.current);
        setClosing(true);
        const rects = options?.single ? (single ? [single] : []) : areaRef.current;
        try {
            if (host) {
                const applyAreas = Boolean(frame && (save || (live && rects !== frame.rects)));
                if (applyAreas) await host.save(rects);
                host.close(applyAreas);
            } else if (!frame || (options?.single && !single)) await invokeIpc('ocrArea.cancel');
            else await invokeIpc(save || live ? 'ocrArea.finish' : 'ocrArea.dismiss', { rects });
        } catch (e) {
            report(e);
            finishing.current = false;
            setClosing(false);
        }
    }, [host, frame, live, options?.single]);

    useEffect(() => host ? undefined : onIpc('ocrArea.requestClose', () => void finish(false)), [finish, host]);

    function update(next: Area[]) {
        areaRef.current = next;
        setAreas(next);
        if (!live) return;
        window.clearTimeout(liveTimer.current);
        liveTimer.current = window.setTimeout(liveSave, 300);
    }

    function record(action: Action) {
        undo.current.push(action);
        redo.current = [];
        update(apply(areaRef.current, action));
    }

    function history(back: boolean) {
        const from = back ? undo.current : redo.current;
        const to = back ? redo.current : undo.current;
        const action = from.pop();
        if (!action) return;
        to.push(action);
        update(apply(areaRef.current, back ? { ...action, add: !action.add } : action));
    }

    function all() {
        let next = areaRef.current;
        for (let index = next.length - 1; index >= 0; index--) {
            const area = next[index];
            if (kind(area) !== 'normal') continue;
            const action = { index, area, add: false };
            undo.current.push(action);
            next = apply(next, action);
        }
        const area: Area = { xywh: [0, 0, 1, 1], monitor: frame?.monitor ?? 0 };
        undo.current.push({ index: next.length, area, add: true });
        redo.current = [];
        update([...next, area]);
    }

    function toggleHelp() {
        const show = !help;
        setHelp(show);
        if (!host) void invokeIpc('ocrArea.help', show).catch(report);
    }

    function closeMenu() {
        setMenu(undefined);
        setHighlight(-1);
    }

    useEffect(() => {
        if (!active) return;
        const workspace = stage.current?.closest(".ocr-selector-workspace");
        function key(event: KeyboardEvent) {
            if (workspace && event.target instanceof Node && !workspace.contains(event.target)) return;
            if (event.defaultPrevented || closing) return;
            const control = event.ctrlKey || event.metaKey;
            const code = event.key.toLowerCase();
            if (code !== 'escape' && event.target instanceof Element && event.target.closest('.ocr-selector-feed, .ocr-line-menu')) return;
            if (code === 'escape') {
                if (menu) closeMenu();
                else void finish(false);
            } else if (frame && code === 'r' && !control && options?.obs) void refresh(true);
            else if (frame && code === 'i' && !control) toggleHelp();
            else if (frame && control && !options?.single) {
                if (code === 'a') all();
                else if (code === 'z') history(!event.shiftKey);
                else if (code === 'y') history(false);
                else if (code === 's') void finish(true);
                else return;
            } else return;
            event.preventDefault();
        }
        window.addEventListener('keydown', key);
        return () => window.removeEventListener('keydown', key);
    });

    function point(x: number, y: number, clampToImage = true): Point {
        const rect = imageBox.current!.getBoundingClientRect();
        const fx = (x - rect.left) / rect.width;
        const fy = (y - rect.top) / rect.height;
        const clamp = (value: number) => Math.max(0, Math.min(1, value));
        return clampToImage ? [clamp(fx), clamp(fy)] : [fx, fy];
    }

    function pointerDown(event: ReactPointerEvent) {
        if (!frame || !options || closing || !imageBox.current || drag.current) return;
        event.preventDefault();
        // A pointer press on the canvas should return keyboard shortcuts to the editor.
        event.currentTarget.closest<HTMLElement>('.ocr-selector-workspace')?.focus({preventScroll: true});
        if (menu) { closeMenu(); return; }
        if (event.button === 1 && !options.single) { void finish(true); return; }
        const start = point(event.clientX, event.clientY, event.button === 0);
        if (event.button === 2 && !options.single) {
            const candidates = hits(areas, start);
            if (candidates.length === 1) {
                const index = candidates[0];
                record({ index, area: areas[index], add: false });
            } else {
                setMenu({ x: event.clientX, y: event.clientY, hits: candidates });
            }
            return;
        }
        if (event.button !== 0) return;
        const flags = flagsForDrag(options, mode, event);
        drag.current = { start, origin: [event.clientX, event.clientY], flags, id: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraft({ xywh: [...start, 0, 0], ...flags });
        if (!options.single && !hits(areas, start).length) {
            longPress.current = window.setTimeout(() => {
                const drawing = drag.current;
                if (!drawing) return;
                drag.current = undefined;
                setDraft(undefined);
                setMenu({ x: drawing.origin[0], y: drawing.origin[1], hits: [] });
            }, 1000);
        }
    }

    function pointerMove(event: ReactPointerEvent) {
        const instructions = helpBox.current?.getBoundingClientRect();
        if (instructions) setDimHelp(event.clientX >= instructions.left && event.clientX <= instructions.right
            && event.clientY >= instructions.top && event.clientY <= instructions.bottom);
        const drawing = drag.current;
        if (!drawing || drawing.id !== event.pointerId) return;
        if (Math.abs(event.clientX - drawing.origin[0]) + Math.abs(event.clientY - drawing.origin[1]) > 10)
            window.clearTimeout(longPress.current);
        setDraft({ xywh: bounds(drawing.start, point(event.clientX, event.clientY)), ...drawing.flags });
    }

    function pointerUp(event: ReactPointerEvent) {
        const drawing = drag.current;
        if (!drawing || drawing.id !== event.pointerId || !frame) return;
        clearDrag();
        const xywh = bounds(drawing.start, point(event.clientX, event.clientY));
        if (xywh[2] * frame.width < 25 || xywh[3] * frame.height < 25) return;
        const area: Area = { xywh, ...drawing.flags };
        if (options?.single) void finish(true, area);
        else record({ index: areas.length, area, add: true });
    }

    function clearDrag() {
        window.clearTimeout(longPress.current);
        drag.current = undefined;
        setDraft(undefined);
    }

    const availableModes = modes.slice(0, options?.monitorOnly ? 1 : 5);
    const display = preview ?? frame;
    const fit = display ? Math.min(stageSize[0] / display.width, stageSize[1] / display.height) : 0;
    const instructionMode = options?.single ? 'single' : options?.monitorOnly ? 'monitor' : 'standard';
    const menuAction = (callback: () => void) => { closeMenu(); callback(); };
    const putBox = ({ xywh: [x, y, w, h], ...flags }: Area, index: number) => (
        <div key={index} className={`ocr-selector-box${index === highlight ? ' highlighted' : ''}`} style={{
            left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`,
            '--area-color': colors[kind(flags)],
        } as CSSProperties}>
            {menu && menu.hits.includes(index) && <span className="ocr-selector-badge">{menu.hits.indexOf(index) + 1}</span>}
        </div>
    );

    return (
        <main className="ocr-selector" onContextMenu={(e) => e.preventDefault()}>
            {frame && options && <header className="ocr-selector-toolbar">
                {availableModes.map((id) => <button type="button" key={id} disabled={closing}
                    title={t('nativeDialogs.area.tips.' + id)}
                    aria-pressed={(mode ?? 'normal') === id} onClick={() => setMode(mode === id ? null : id)}>{glyphs[id]} {modeLabel(id)}</button>)}
                <i />
                {options.single ? <span>{t('nativeDialogs.area.singleHint')}</span> : <>
                    <button type="button" disabled={closing} onClick={() => history(true)}>{t('nativeDialogs.area.undo')}</button>
                    <button type="button" disabled={closing} onClick={() => history(false)}>{t('nativeDialogs.area.redo')}</button>
                    <button type="button" disabled={closing} onClick={all}>{t('nativeDialogs.area.all')}</button>
                </>}
                {options.obs && <button type="button" disabled={closing} onClick={() => void refresh(true)}>{t('nativeDialogs.area.refresh')}</button>}
                <button type="button" disabled={closing} onClick={toggleHelp}>{t('nativeDialogs.area.help')}</button>
                {!options.single && <>
                    <i />
                    <button type="button" className="live" disabled={closing} aria-pressed={live}
                        title={t('nativeDialogs.area.autoSendTip')} onClick={() => {
                            if (live) window.clearTimeout(liveTimer.current);
                            else liveSave();
                            setLive(!live);
                        }}>{t('nativeDialogs.area.autoSend')}</button>
                    {options.obs && <button type="button" className="live" disabled={closing} aria-pressed={viewerAutoRefresh ?? autoRefresh}
                        title={t('nativeDialogs.area.autoRefreshTip')} onClick={() => onAutoRefreshChange ? onAutoRefreshChange(!viewerAutoRefresh) : setAutoRefresh(!autoRefresh)}>
                        {t('nativeDialogs.area.autoRefresh')}
                    </button>}
                </>}
                <div className="ocr-selector-space" />
                {host && <button type="button" disabled={closing} onClick={() => void finish(false)}>
                    {t(live ? 'nativeDialogs.close' : 'nativeDialogs.cancel')}
                </button>}
                <button type="button" disabled={closing} onClick={() => void finish(!options.single)}>
                    {t(options.single ? 'nativeDialogs.cancel' : host ? 'ocr.desk.editor.save' : 'nativeDialogs.area.save')}
                </button>
            </header>}
            <div ref={stage} className="ocr-selector-stage" onPointerDown={pointerDown} onPointerMove={pointerMove}
                onPointerUp={pointerUp} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag}
                onDoubleClick={(e) => {
                    if (frame && !options?.single && !hits(areas, point(e.clientX, e.clientY, false)).length) void finish(true);
                }}>
                {frame ? <>
                    <div ref={imageBox} className="ocr-selector-image" style={{ width: (display?.width ?? 0) * fit, height: (display?.height ?? 0) * fit }}>
                        <img src={preview?.imageData ?? image} alt={t('nativeDialogs.preview.screenshot')} draggable={false} />
                        <div className="ocr-selector-image-border" />
                        {areas.map(putBox)}
                        {draft && putBox(draft, -2)}
                    </div>
                    {help && <aside ref={helpBox} className={`ocr-selector-help${dimHelp ? ' dimmed' : ''}`}>
                        <strong>{t('nativeDialogs.area.title')}</strong>
                        <p>{t(`nativeDialogs.area.instructions.${instructionMode}`, { monitor: frame.monitor ?? 0 })}</p>
                    </aside>}
                </> : <div className="ocr-selector-progress">
                    <p role="status">{error || t('nativeDialogs.area.capturing')}</p>
                    <div>
                        {error && <button type="button" onClick={() => retry((n) => n + 1)}>{t('nativeDialogs.area.retry')}</button>}
                        <button type="button" onClick={() => void finish(false)}>{t('nativeDialogs.cancel')}</button>
                    </div>
                </div>}
            </div>
            {frame && error && <div className="ocr-selector-error" role="alert">{error}</div>}
            {menu && <div className="ocr-selector-menu-dismiss" onPointerDown={closeMenu}>
                <div className="ocr-selector-menu" ref={menuBox} role="menu" onPointerDown={(e) => e.stopPropagation()}>
                    {menu.hits.length ? menu.hits.map((index, order) => <button type="button" role="menuitem" key={index}
                        onFocus={() => setHighlight(index)} onPointerEnter={() => setHighlight(index)}
                        onClick={() => menuAction(() => record({ index, area: areas[index], add: false }))}>
                        {t('nativeDialogs.area.delete', { number: order + 1, type: modeLabel(kind(areas[index])) })}
                    </button>) : <>
                        {availableModes.map((id) => <button type="button" role="menuitem" key={id} onClick={() => menuAction(() => setMode(id))}>
                            {glyphs[id]} {t(`nativeDialogs.area.draw.${id}`)}
                        </button>)}
                        <hr />
                        <button type="button" role="menuitem" onClick={() => menuAction(() => void finish(true))}>{t('nativeDialogs.area.save')}</button>
                        <hr />
                        <button type="button" role="menuitem" disabled={!undo.current.length} onClick={() => menuAction(() => history(true))}>{t('nativeDialogs.area.undo')}</button>
                        <button type="button" role="menuitem" disabled={!redo.current.length} onClick={() => menuAction(() => history(false))}>{t('nativeDialogs.area.redo')}</button>
                        <hr />
                        <button type="button" role="menuitem" onClick={() => menuAction(toggleHelp)}>{t('nativeDialogs.area.toggleInstructions')}</button>
                        <hr />
                        <button type="button" role="menuitem" onClick={() => menuAction(() => void finish(false))}>{t('nativeDialogs.area.quit')}</button>
                    </>}
                </div>
            </div>}
        </main>
    );
}
