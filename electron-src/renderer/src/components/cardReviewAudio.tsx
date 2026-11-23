import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { useTranslation } from "../i18n";

export type Range = [number, number];
export const audioFilters = [
  { value: "none", labelKey: "cardReview.audioFilterNone" },
  { value: "boostQuiet", labelKey: "cardReview.audioFilterBoost" },
  { value: "reduceRumble", labelKey: "cardReview.audioFilterRumble" },
  { value: "reduceNoise", labelKey: "cardReview.audioFilterNoise" },
] as const;
export type AudioFilter = typeof audioFilters[number]["value"];

export type AudioForm = {
  id: number;
  url: string | null;
  duration: number;
  initialRange?: Range;
  initialCuts?: Range[];
  available: boolean;
  reused: boolean;
  voice: boolean;
  vadRan: boolean;
  tts: boolean;
  fallback: boolean;
  offset: number;
  canExpandStart: boolean;
  canExpandEnd: boolean;
};

export function keepRanges([start, end]: Range, cuts: Range[]): Range[] {
  let cursor = start;
  const ranges: Range[] = [];
  for (const [from, to] of [...cuts].sort(([a], [b]) => a - b)) {
    if (to <= cursor || from >= end) continue;
    if (from > cursor) ranges.push([cursor, from]);
    cursor = Math.min(end, to);
  }
  if (end > cursor) ranges.push([cursor, end]);
  return ranges;
}

const PEAKS = 640;

function waveform(buffer: AudioBuffer): string {
  const samples = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const values = Array.from({ length: PEAKS }, (_, x) => {
    const start = Math.floor(x * buffer.length / PEAKS);
    const end = Math.floor((x + 1) * buffer.length / PEAKS);
    let peak = 0;
    for (const channel of samples) {
      for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(channel[sample]));
    }
    return peak;
  });
  const scale = Math.max(0.04, ...values);
  return values.map((value, i) => {
    const peak = Math.max(0.3, 20 * value / scale);
    return `M${i} ${22 - peak}v${2 * peak}`;
  }).join("");
}

type Timeline = { start: number; end: number; when: number };

export function useReviewAudio(url: string | null, range: Range, cuts: Range[], autoplay: boolean) {
  const engine = useRef<AudioContext | null>(null);
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const timer = useRef(0);
  const cursorRef = useRef<number | null>(null);
  const playbackEnd = useRef<number | null>(null);
  const timeline = useRef<Timeline[]>([]);
  const [asset, setAsset] = useState<{ buffer: AudioBuffer; path: string; url: string }>();
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const current = asset?.url === url ? asset : undefined;
  const setPosition = useCallback((seconds: number | null) => {
    cursorRef.current = seconds;
    setCursor(seconds);
  }, []);
  const stop = useCallback((reset = false) => {
    cancelAnimationFrame(timer.current);
    for (const source of sources.current) {
      source.stop();
      source.disconnect();
    }
    sources.current = [];
    timeline.current = [];
    if (reset) setPosition(null);
    setPlaying(false);
  }, [setPosition]);

  useEffect(() => () => { stop(); void engine.current?.close(); }, [stop]);
  useEffect(() => {
    stop(true);
    setAsset(undefined);
    setFailed(false);
    if (!url) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        engine.current ??= new AudioContext();
        const buffer = await engine.current.decodeAudioData(bytes);
        if (!controller.signal.aborted) setAsset({ buffer, path: waveform(buffer), url });
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [url, stop]);

  const playFrom = useCallback((position: number | null, selection: Range = range) => {
    const context = engine.current;
    if (!context || !current) return;
    stop();
    const start = position != null && position >= selection[0] && position < selection[1] ? position : selection[0];
    const segments = keepRanges([start, Math.min(selection[1], current.buffer.duration)], cuts);
    if (!segments.length) return;
    void context.resume().catch(() => stop());
    playbackEnd.current = null;
    let when = context.currentTime;
    for (const [from, to] of segments) {
      const source = context.createBufferSource();
      source.buffer = current.buffer;
      source.connect(context.destination);
      source.start(when, from, to - from);
      sources.current.push(source);
      timeline.current.push({ start: from, end: to, when });
      when += to - from;
    }
    setPlaying(true);
    const paint = () => {
      const now = context.currentTime;
      const segment = timeline.current.find(part => part.when + part.end - part.start > now);
      const at = segment ? segment.start + Math.max(0, now - segment.when) : null;
      if (at !== null && (playbackEnd.current === null || at < playbackEnd.current)) {
        setPosition(at);
        timer.current = requestAnimationFrame(paint);
      } else {
        stop(true);
      }
    };
    timer.current = requestAnimationFrame(paint);
  }, [current, cuts, range, setPosition, stop]);

  // Auto-play each new clip once. Changes to the trim handles don't restart playback.
  const autoplayed = useRef<string | null>(null);
  useEffect(() => {
    if (!autoplay) { autoplayed.current = null; return; }
    if (current && autoplayed.current !== current.url) {
      autoplayed.current = current.url;
      playFrom(null);
    }
  }, [autoplay, current, playFrom]);

  return {
    path: current?.path,
    failed,
    playing,
    cursor,
    stop,
    playFrom,
    limitEnd: (end: number) => { playbackEnd.current = end; },
    toggle: () => { if (playing) stop(); else playFrom(cursorRef.current); },
    seek: (position: number) => {
      setPosition(position);
      if (playing) playFrom(position);
    },
  };
}

type WaveformProps = {
  audio: AudioForm;
  range: Range;
  cuts: Range[];
  path?: string;
  cursor: number | null;
  cutMode: boolean;
  step: number;
  onRange: (range: Range) => void;
  onCut: (cut: Range) => void;
  onEditCut: (index: number, cut: Range | null) => void;
  onInteract: () => void;
  onSeek: (position: number) => void;
  onExpand: (left: boolean) => void;
};

export function ReviewWaveform({
  audio, range, cuts, path, cursor, cutMode, step, onRange, onCut, onEditCut, onInteract, onSeek, onExpand,
}: WaveformProps) {
  const t = useTranslation();
  const graph = useRef<HTMLDivElement>(null);
  const drag = useRef<{ edge: 0 | 1; index?: number; offset: number } | { start: number } | null>(null);
  const [preview, setPreview] = useState<Range>();
  const [previewCut, setPreviewCut] = useState<{ index: number; range: Range }>();
  const [selectedCut, selectCut] = useState<number>();
  const editing = preview ?? range;
  const visibleCuts = previewCut
    ? cuts.map((cut, i) => i === previewCut.index ? previewCut.range : cut)
    : cuts;
  const percent = (n: number) => audio.duration ? 100 * n / audio.duration : 0;
  const seconds = (e: PointerEvent) => {
    const rect = graph.current!.getBoundingClientRect();
    return audio.duration * Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };
  const moveEdge = (current: Range, edge: 0 | 1, at: number): Range => {
    const gap = Math.min(0.015, current[1] - current[0]);
    return edge === 1
      ? [current[0], Math.min(audio.duration, Math.max(current[0] + gap, at))]
      : [Math.max(0, Math.min(current[1] - gap, at)), current[1]];
  };
  const newCut = (start: number, end: number): Range => [
    Math.max(range[0], Math.min(start, end)),
    Math.min(range[1], Math.max(start, end)),
  ];
  const clearDrag = () => {
    drag.current = null;
    setPreview(undefined);
    setPreviewCut(undefined);
  };
  const removeCut = (index: number, restoreFocus = false) => {
    onEditCut(index, null);
    selectCut(undefined);
    if (restoreFocus) graph.current?.querySelector<HTMLButtonElement>(".cr-wave-handle")?.focus();
  };
  const renderHandle = (edge: 0 | 1, position: number, index?: number) => {
    const cut = index != null;
    const start = edge === 0;
    const label = cut
      ? t(start ? "cardReview.cutStart" : "cardReview.cutEnd", { count: index + 1 })
      : t(start ? "cardReview.trimStart" : "cardReview.trimEnd");
    return <button key={edge} type="button" className={cut ? "cr-wave-handle cr-cut-handle" : "cr-wave-handle"}
      data-edge={edge} data-cut={index} aria-label={label}
      style={{ left: `clamp(4px, ${percent(position)}%, calc(100% - 4px))` }}
      onFocus={cut ? () => selectCut(index) : undefined}
      onKeyDown={event => {
        if (cut && event.key === "Delete") {
          event.preventDefault();
          removeCut(index, true);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const current = cut ? cuts[index] : range;
        const next = moveEdge(current, edge, current[edge] + (event.key === "ArrowRight" ? step : -step));
        if (cut) onEditCut(index, next);
        else onRange(next);
      }} />;
  };
  const selected = selectedCut == null ? undefined : visibleCuts[selectedCut];

  return <div className="cr-waveform">
    <div className="cr-wave-head">
      <div>{audio.canExpandStart && <button type="button" onClick={() => onExpand(true)}
        aria-label={t("cardReview.expandStart")}>◀ +{step}s</button>}</div>
      <div>
        <div>{t("cardReview.waveTime", {
          start: (audio.offset + editing[0]).toFixed(2),
          end: (audio.offset + editing[1]).toFixed(2),
          duration: keepRanges(editing, visibleCuts).reduce((total, [a, b]) => total + b - a, 0).toFixed(2),
        })}</div>
        <small>{t("cardReview.waveTip")}</small>
      </div>
      <div>{audio.canExpandEnd && <button type="button" onClick={() => onExpand(false)}
        aria-label={t("cardReview.expandEnd")}>+{step}s ▶</button>}</div>
    </div>
    <div className={`cr-wave-graph${cutMode ? " cr-wave-cut-mode" : ""}`} ref={graph}
      onPointerDown={event => {
        if (event.button !== 0) return;
        onInteract();
        const at = seconds(event);
        const target = (event.target as Element).closest<HTMLElement>("[data-edge], [data-cut]");
        const edge = target?.dataset.edge;
        const index = target?.dataset.cut == null ? undefined : Number(target.dataset.cut);
        if (cutMode || event.shiftKey) {
          selectCut(undefined);
          drag.current = { start: at };
        } else {
          selectCut(index);
          if (edge == null) {
            if (index == null) onSeek(at);
            return;
          }
          const side = edge === "0" ? 0 : 1;
          const current = index == null ? range : cuts[index];
          drag.current = { edge: side, index, offset: current[side] - at };
        }
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active) return;
        const at = seconds(event);
        if ("start" in active) setPreviewCut({ index: -1, range: newCut(active.start, at) });
        else if (active.index == null) setPreview(moveEdge(range, active.edge, at + active.offset));
        else setPreviewCut({ index: active.index, range: moveEdge(cuts[active.index], active.edge, at + active.offset) });
      }}
      onPointerUp={event => {
        const previous = drag.current;
        clearDrag();
        if (!previous) return;
        const at = seconds(event);
        if ("start" in previous) {
          const next = newCut(previous.start, at);
          if (next[1] - next[0] > 0.015) {
            selectCut(cuts.length);
            onCut(next);
          }
        } else if (previous.index == null) onRange(moveEdge(range, previous.edge, at + previous.offset));
        else onEditCut(previous.index, moveEdge(cuts[previous.index], previous.edge, at + previous.offset));
      }}
      onPointerCancel={clearDrag}>
      <div className="cr-wave-selection" style={{ left: `${percent(editing[0])}%`, right: `${100 - percent(editing[1])}%` }} />
      <svg viewBox={`0 0 ${PEAKS} 44`} preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
      {visibleCuts.map(([a, b], i) =>
        <i className="cr-wave-cut" key={i} data-cut={i}
          style={{ left: `${percent(a)}%`, width: `${percent(b - a)}%` }} />)}
      {previewCut?.index === -1 && previewCut.range[1] > previewCut.range[0] &&
        <i className="cr-wave-cut cr-draft-cut" style={{
          left: `${percent(previewCut.range[0])}%`,
          width: `${percent(previewCut.range[1] - previewCut.range[0])}%`,
        }} />}
      {cursor != null && <i className="cr-wave-cursor" style={{ left: `${percent(cursor)}%` }} />}
      {renderHandle(0, editing[0])}
      {renderHandle(1, editing[1])}
      {visibleCuts.map(([a, b], i) => <div key={i} className={selectedCut === i ? "cr-selected-cut" : undefined}>
        {renderHandle(0, a, i)}
        {renderHandle(1, b, i)}
      </div>)}
    </div>
    {selected && selectedCut != null && <div className="cr-cut-tools">
      <span>{t("cardReview.cutTime", {
        count: selectedCut + 1, start: (audio.offset + selected[0]).toFixed(2),
        end: (audio.offset + selected[1]).toFixed(2),
      })}</span>
      <button type="button" onClick={() => removeCut(selectedCut, true)}>{t("cardReview.removeCut")}</button>
    </div>}
  </div>;
}
