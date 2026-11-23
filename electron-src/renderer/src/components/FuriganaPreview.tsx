import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { invokeIpc } from '../lib/ipc';
import './NativeDialogs.css';

type Box = [number, number, number, number];
type Frame = { image: string; width: number; height: number; source: string; sensitivity: number };
type Detection = { box: Box; engine: number };
const colors = ['green', 'blue', 'red'];
const engines = ['Lens', 'OneOCR', 'MeikiOCR'];

function near([left, top, right, bottom]: Box, [l, t, r, b]: Box) {
    return right + 40 >= l && r + 40 >= left && bottom + 40 >= t && b + 40 >= top;
}

function visibleGroups(lines: Box[][], sensitivity: number, view: number) {
    const groups: Detection[][] = [];
    lines.forEach((boxes, engine) => {
        if (view !== 0 && view !== engine + 1) return;
        for (const box of boxes) {
            if (box[2] - box[0] <= sensitivity || box[3] - box[1] <= sensitivity) continue;
            const group = view === 0
                ? groups.find((set) => set.some((entry) => near(entry.box, box)))
                : groups[0];
            if (group) group.push({ box, engine });
            else groups.push([{ box, engine }]);
        }
    });
    return groups;
}

export function FuriganaPreview() {
    const t = useTranslation();
    const [frame, setFrame] = useState<Frame>();
    const [lines, setLines] = useState<Box[][]>();
    const [value, setValue] = useState(0);
    const [view, setView] = useState(0);
    const [error, setError] = useState('');
    const mode = view ? engines[view - 1] : t('nativeDialogs.preview.unified');
    const groups = useMemo(() => visibleGroups(lines ?? [], value, view), [lines, value, view]);
    const resolve = (answer: number | null) => {
        void invokeIpc('ocrPreview.resolve', answer).catch((e) => setError(String(e)));
    };

    useEffect(() => {
        let live = true;
        void invokeIpc<Frame>('ocrPreview.read').then(async (next) => {
            if (!live) return;
            setFrame(next);
            setValue(next.sensitivity);
            const boxes = await invokeIpc<Box[][]>('ocrPreview.detect');
            if (live) setLines(boxes);
        }).catch((e) => { if (live) setError(String(e)); });
        return () => { live = false; };
    }, []);

    useEffect(() => {
        const title = [t('nativeDialogs.preview.title'), frame?.source, mode].filter(Boolean).join(' - ');
        void invokeIpc('ocrPreview.title', title).catch(() => {});
    }, [frame?.source, mode, t]);

    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') resolve(null);
        };
        window.addEventListener('keydown', keydown);
        return () => window.removeEventListener('keydown', keydown);
    }, []);

    return (
        <main className="native-dialog furigana-preview">
            <div className="furigana-preview-scroll">
                {frame && (
                    <div className="furigana-preview-image" style={{ width: frame.width, height: frame.height }}>
                        <img src={frame.image} alt={t('nativeDialogs.preview.screenshot')} draggable={false} />
                        <svg aria-hidden="true" viewBox={`0 0 ${frame.width} ${frame.height}`}>
                            {groups.map((group, i) => {
                                const ids = [...new Set(group.map(({ engine }) => engine))].sort();
                                const color = ids.length > 1 ? 'magenta' : colors[ids[0]];
                                const label = ids.map((id) => id === 2 ? 'Meiki' : engines[id]).join(', ');
                                const [x, y] = group[0].box;
                                return <g key={i}>
                                    {group.map(({ box: [l, top, r, b] }, j) => (
                                        <rect key={j} x={l} y={top} width={r - l} height={b - top} stroke={color} strokeWidth={2} fill="none" />
                                    ))}
                                    {view === 0 && <>
                                        <rect x={x} y={y - 18} width={label.length * 8 + 8} height={16} fill="rgba(0, 0, 0, .7)" />
                                        <text x={x + 4} y={y - 6} fill="white" fontSize={12}>{label}</text>
                                    </>}
                                </g>;
                            })}
                        </svg>
                    </div>
                )}
                {!lines && <div className="furigana-preview-loading" role="status">{error || t('nativeDialogs.preview.loading')}</div>}
            </div>
            <footer>
                <label htmlFor="furigana-preview-slider">{t('nativeDialogs.preview.sensitivity')}</label>
                <input autoFocus id="furigana-preview-slider" type="range" min={0} max={100} value={value} disabled={!lines} onChange={(e) => setValue(e.target.valueAsNumber)} />
                <output htmlFor="furigana-preview-slider">{t('nativeDialogs.preview.pixels', { value })}</output>
                <button type="button" disabled={!lines?.slice(1).some((boxes) => boxes.length)} onClick={() => setView((v) => (v + 1) % 4)}>
                    {t('nativeDialogs.preview.switch', { mode })}
                </button>
                <button type="button" disabled={!lines} onClick={() => resolve(value)}>{t('nativeDialogs.ok')}</button>
            </footer>
        </main>
    );
}
