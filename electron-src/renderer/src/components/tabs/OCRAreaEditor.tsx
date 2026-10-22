import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  OCR_AREA_KINDS, getOcrAreaKind, getOcrAreaRevision, makeOcrArea,
  type OcrAreaConfig, type OcrAreaKind, type OcrAreaRectangle, type OcrAreaSaveResult
} from "../../../../shared/ocr_areas";
import type { OcrPreviewFrame } from "../../../../shared/ocr_preview";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";

type Point = { x: number; y: number };
type DrawMode = OcrAreaKind | "modifiers";
type Stroke = { start: Point; end: Point; pointerId: number; area: OcrAreaRectangle; scale: number };

function makeDragArea(mode: DrawMode, event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): OcrAreaRectangle {
  const area = makeOcrArea([0, 0, 0, 0], mode === "modifiers" ? "normal" : mode);
  // Match Qt's mousePressEvent: explicit toolbar modes persist, otherwise latch
  // modifiers at drag start. Shift+Ctrl sets both flags; Alt takes precedence.
  if (mode !== "modifiers") return area;
  return {
    ...area,
    is_excluded: event.shiftKey && !event.altKey,
    is_secondary: event.ctrlKey && !event.altKey,
    is_exclusive: event.altKey && !event.ctrlKey,
    is_black_hole: event.altKey && event.ctrlKey
  };
}

function coordinates(start: Point, end: Point): OcrAreaRectangle["coordinates"] {
  return [Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y)];
}

export function OCRAreaEditor({ config, frame, disabled, onSaved, onCancel }: {
  config: OcrAreaConfig | null;
  frame: OcrPreviewFrame;
  disabled: boolean;
  onSaved: (config: OcrAreaConfig) => void;
  onCancel: () => void;
}) {
  const t = useTranslation();
  const [rectangles, setRectangles] = useState<OcrAreaRectangle[]>(() => (config?.rectangles ?? []) as OcrAreaRectangle[]);
  const [history, setHistory] = useState<OcrAreaRectangle[][]>([]);
  const [drawMode, setDrawMode] = useState<DrawMode>("modifiers");
  const [selected, setSelected] = useState(-1);
  const [stroke, setStroke] = useState<Stroke | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const canvasRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    mounted.current = true;
    canvasRef.current?.focus();
    return () => { mounted.current = false; };
  }, []);
  const locked = disabled || saving;
  const aspectRatio = frame.width / frame.height;

  // SVG uses xMidYMid meet. Ignore the surrounding letterbox when mapping to source fractions.
  const point = (event: PointerEvent<SVGSVGElement>, clamp: boolean) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
    if (!(scale > 0)) return null;
    const x = (event.clientX - bounds.left - (bounds.width - frame.width * scale) / 2) / (frame.width * scale);
    const y = (event.clientY - bounds.top - (bounds.height - frame.height * scale) / 2) / (frame.height * scale);
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), scale };
  };
  const change = (next: OcrAreaRectangle[]) => {
    setHistory((previous) => [...previous, rectangles]);
    setRectangles(next);
    setError("");
  };
  const cancelStroke = () => {
    strokeRef.current = null;
    setStroke(null);
  };
  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous || locked) return;
    setRectangles(previous);
    setHistory((current) => current.slice(0, -1));
    setSelected(-1);
    setError("");
    cancelStroke();
  };
  const save = async () => {
    if (locked || strokeRef.current) return;
    setSaving(true);
    setError("");
    try {
      const result = await invokeIpc<OcrAreaSaveResult>("ocr.save-preview-areas", {
        sceneId: frame.sceneId,
        sceneName: frame.sceneName,
        expectedRevision: getOcrAreaRevision(config),
        rectangles
      });
      if (!mounted.current) return;
      if (result.success) onSaved(result.config);
      else setError(t("ocr.desk.editor.errors." + result.error));
    } catch {
      if (mounted.current) setError(t("ocr.desk.editor.errors.failed"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const drawn = stroke ? { ...stroke.area, coordinates: coordinates(stroke.start, stroke.end) } : null;

  return (
    <div className="desk-area-editor" onKeyDown={(event) => {
      if (locked) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (strokeRef.current) cancelStroke();
        else onCancel();
      }
    }}>
      <div className="desk-area-editor-toolbar">
        <label>
          <span>{t("ocr.desk.editor.areaType")}</span>
          <select value={drawMode} disabled={locked} onChange={(event) => setDrawMode(event.target.value as DrawMode)}>
            <option value="modifiers">{t("ocr.desk.editor.keyboardModifiers")}</option>
            {OCR_AREA_KINDS.map((value) => <option key={value} value={value}>{t("ocr.desk.areaKinds." + value)}</option>)}
          </select>
        </label>
        <button type="button" disabled={locked || !history.length || !!stroke} onClick={undo}>{t("ocr.desk.editor.undo")}</button>
        <button type="button" disabled={locked || !rectangles.length || !!stroke} onClick={() => { change([]); setSelected(-1); }}>{t("ocr.desk.editor.clear")}</button>
      </div>
      <div className="desk-map-canvas desk-map-canvas--preview desk-map-canvas--editing">
        <svg
          ref={canvasRef}
          className="desk-map-source"
          viewBox={`0 0 1000 ${1000 / aspectRatio}`}
          preserveAspectRatio="xMidYMid meet"
          tabIndex={0}
          role="group"
          aria-label={t("ocr.desk.editor.canvas")}
          onKeyDown={(event) => {
            if (locked) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
              event.preventDefault(); undo();
            } else if ((event.key === "Delete" || event.key === "Backspace") && selected >= 0) {
              event.preventDefault();
              change(rectangles.filter((_, index) => index !== selected)); setSelected(-1);
            }
          }}
          onPointerDown={(event) => {
            if (locked || strokeRef.current || event.button !== 0) return;
            const start = point(event, false);
            if (!start) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            const target = (event.target as Element).closest("[data-area-index]");
            setSelected(target ? Number(target.getAttribute("data-area-index")) : -1);
            const next = { start, end: start, pointerId: event.pointerId, area: makeDragArea(drawMode, event), scale: start.scale };
            strokeRef.current = next;
            setStroke(next);
          }}
          onPointerMove={(event) => {
            const current = strokeRef.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const end = point(event, true);
            if (!end) return;
            const next = { ...current, end };
            strokeRef.current = next;
            setStroke(next);
          }}
          onPointerUp={(event) => {
            const current = strokeRef.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const end = point(event, true);
            if (end && !locked) {
              const bounds = coordinates(current.start, end);
              if (bounds[2] * frame.width * current.scale >= 4 && bounds[3] * frame.height * current.scale >= 4) {
                change([...rectangles, { ...current.area, coordinates: bounds }]);
                setSelected(rectangles.length);
              }
            }
            cancelStroke();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancelStroke}
          onLostPointerCapture={cancelStroke}
        >
          <image href={frame.imageData} x="0" y="0" width="1000" height={1000 / aspectRatio} />
          {[...rectangles, ...(drawn ? [drawn] : [])].map((area, index) => {
            const [x, y, width, height] = area.coordinates;
            return (
              <g key={index} data-area-index={index} className={"desk-map-area desk-map-area--" + getOcrAreaKind(area) + (selected === index ? " is-selected" : "") + (index === rectangles.length ? " is-drawing" : "")}>
                <rect x={x * 1000} y={y * 1000 / aspectRatio} width={width * 1000} height={height * 1000 / aspectRatio} />
                <text x={x * 1000 + 8} y={y * 1000 / aspectRatio + 22}>{index + 1}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="desk-area-editor-hint">{t("ocr.desk.editor.hint")}</p>
      {drawMode === "modifiers" ? <p className="desk-area-editor-hint">{t("ocr.desk.editor.modifierHint")}</p> : null}
      <div className="desk-area-editor-toolbar">
        <label>
          <span>{t("ocr.desk.editor.selectedArea")}</span>
          <select value={selected} disabled={locked} onChange={(event) => setSelected(Number(event.target.value))}>
            <option value={-1}>{t("ocr.desk.editor.none")}</option>
            {rectangles.map((area, index) => <option key={index} value={index}>{t("ocr.desk.editor.areaLabel", { number: index + 1, kind: t("ocr.desk.areaKinds." + getOcrAreaKind(area)) })}</option>)}
          </select>
        </label>
        <button type="button" disabled={locked || selected < 0 || !!stroke} onClick={() => { change(rectangles.filter((_, index) => index !== selected)); setSelected(-1); }}>{t("ocr.desk.editor.remove")}</button>
        <div className="desk-area-editor-actions">
          <button type="button" disabled={saving} onClick={onCancel}>{t("ocr.desk.editor.cancel")}</button>
          <button type="button" className="desk-primary" disabled={locked || !history.length || !!stroke} onClick={() => void save()}>{t(saving ? "ocr.desk.editor.saving" : "ocr.desk.editor.save")}</button>
        </div>
      </div>
      {error ? <p className="desk-area-editor-error" role="alert">{error}</p> : null}
    </div>
  );
}
