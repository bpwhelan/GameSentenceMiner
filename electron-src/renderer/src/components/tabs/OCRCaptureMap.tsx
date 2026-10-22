import { useState } from "react";
import { useTranslation } from "../../i18n";
import type { ObsScene } from "../../types/models";
import { useOCRPreview } from "./useOCRPreview";

export interface CaptureMapConfig {
  coordinate_system?: string;
  rectangles?: unknown[];
  window_geometry?: { width?: number; height?: number } | null;
}

type AreaKind = "normal" | "secondary" | "excluded" | "black-hole" | "exclusive";
interface CaptureArea {
  number: number;
  kind: AreaKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

const AREA_KINDS: AreaKind[] = ["normal", "secondary", "excluded", "black-hole", "exclusive"];

// Saved selector coordinates are fractions of the source, not pixel positions.
// Legacy pixel configurations remain editable in the selector without guessing a source size.
export function buildCaptureMap(config: CaptureMapConfig | null) {
  const areas: CaptureArea[] = [];
  const rectangles = Array.isArray(config?.rectangles) ? config.rectangles : [];
  if (config?.coordinate_system !== "percentage" || !rectangles.length) {
    return { areas, available: false };
  }
  for (const [index, value] of rectangles.entries()) {
    if (!value || typeof value !== "object") continue;
    const area = value as Record<string, unknown>;
    const coordinates = area.coordinates;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length !== 4 ||
      !coordinates.every((n) => typeof n === "number" && Number.isFinite(n))
    )
      continue;
    const [x, y, width, height] = coordinates as number[];
    if (width <= 0 || height <= 0) continue;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(1, x + width);
    const bottom = Math.min(1, y + height);
    if (right <= left || bottom <= top) continue;
    areas.push({
      number: index + 1,
      kind: area.is_excluded
        ? "excluded"
        : area.is_black_hole
          ? "black-hole"
          : area.is_exclusive
            ? "exclusive"
            : area.is_secondary
              ? "secondary"
              : "normal",
      x: left * 100,
      y: top * 100,
      width: (right - left) * 100,
      height: (bottom - top) * 100
    });
  }
  return { areas, available: areas.length === rectangles.length };
}

export function OCRCaptureMap({
  config,
  disabled,
  onEdit,
  active,
  scene,
  ocrRunning
}: {
  config: CaptureMapConfig | null;
  disabled: boolean;
  onEdit: () => void;
  active: boolean;
  scene: ObsScene | null;
  ocrRunning: boolean;
}) {
  const t = useTranslation();
  const [paused, setPaused] = useState(false);
  const [showBoxes, setShowBoxes] = useState(true);
  const { frame, unavailable } = useOCRPreview({
    active,
    paused,
    sceneId: scene?.id ?? "",
    sceneName: scene?.name ?? "",
    includeBoxes: showBoxes && ocrRunning
  });
  const { areas, available } = buildCaptureMap(config);
  const detectedBoxes = showBoxes && ocrRunning ? (frame?.boxes ?? []) : [];
  const hasAreas = Boolean(config?.rectangles?.length);
  const geometry = config?.window_geometry;
  const aspectRatio = frame
    ? frame.width / frame.height
    : geometry?.width &&
        geometry?.height &&
        Number.isFinite(geometry.width) &&
        Number.isFinite(geometry.height) &&
        geometry.width > 0 &&
        geometry.height > 0
      ? geometry.width / geometry.height
      : 16 / 9;

  return (
    <div className="desk-map">
      <button
        type="button"
        className={"desk-map-canvas" + (frame ? " desk-map-canvas--preview" : "")}
        onClick={onEdit}
        disabled={disabled}
        aria-label={t("ocr.sceneAndAreas.selectAreas")}
      >
        <span
          className="desk-map-crosshair"
          aria-hidden="true"
        />
        {available || frame ? (
          <svg
            className="desk-map-source"
            viewBox={`0 0 1000 ${1000 / aspectRatio}`}
            aria-hidden="true"
          >
            <rect
              className="desk-map-source-border"
              x="1"
              y="1"
              width="998"
              height={1000 / aspectRatio - 2}
              rx="5"
            />
            {frame ? (
              <image
                href={frame.imageData}
                x="0"
                y="0"
                width="1000"
                height={1000 / aspectRatio}
              />
            ) : null}
            {(available ? areas : []).map((area) => (
              <g
                key={area.number}
                className={"desk-map-area desk-map-area--" + area.kind}
              >
                <rect
                  x={area.x * 10}
                  y={(area.y * 10) / aspectRatio}
                  width={area.width * 10}
                  height={(area.height * 10) / aspectRatio}
                  rx="3"
                />
                <text
                  x={area.x * 10 + 8}
                  y={(area.y * 10) / aspectRatio + 22}
                >
                  {area.number}
                </text>
              </g>
            ))}
            {detectedBoxes.map((box, index) => (
              <polygon
                key={index}
                className="desk-preview-box"
                points={box.points
                  .map(([x, y]) => `${x * 1000},${(y * 1000) / aspectRatio}`)
                  .join(" ")}
              >
                {box.text ? <title>{box.text}</title> : null}
              </polygon>
            ))}
          </svg>
        ) : (
          <span className="desk-map-empty">
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8" />
            </svg>
            <strong>{t(hasAreas ? "ocr.desk.savedLayout" : "ocr.desk.wholeWindow")}</strong>
            <span>{t(hasAreas ? "ocr.desk.savedLayoutHint" : "ocr.desk.wholeWindowHint")}</span>
          </span>
        )}
        <span
          className="desk-map-edit"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24">
            <path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" />
          </svg>
        </span>
      </button>
      <div className="desk-preview-controls">
        <span
          className={"desk-preview-state" + (frame && !paused && !unavailable ? " is-live" : "")}
        >
          <i aria-hidden="true" />
          {t(
            !scene
              ? "ocr.footer.noSceneSelected"
              : unavailable
                ? frame
                  ? "ocr.desk.preview.stale"
                  : "ocr.desk.preview.unavailable"
                : paused
                  ? "ocr.desk.preview.paused"
                  : frame
                    ? "ocr.desk.preview.live"
                    : "ocr.desk.preview.loading"
          )}
        </span>
        <div>
          <label className="desk-preview-box-toggle">
            <input
              type="checkbox"
              checked={showBoxes}
              onChange={(event) => setShowBoxes(event.target.checked)}
            />
            <span>{t("ocr.desk.preview.textBoxes")}</span>
          </label>
          <button
            type="button"
            className="desk-preview-pause"
            disabled={!scene || disabled}
            aria-pressed={paused}
            onClick={() => setPaused((current) => !current)}
          >
            {t(paused ? "ocr.desk.preview.resume" : "ocr.desk.preview.pause")}
          </button>
        </div>
      </div>
      <div className="desk-map-caption">
        <span>
          {frame
            ? !showBoxes
              ? frame.sourceName
              : !ocrRunning
                ? t("ocr.desk.preview.startHint")
                : detectedBoxes.length
                  ? t("ocr.desk.preview.detected", { count: detectedBoxes.length })
                  : t("ocr.desk.preview.waiting")
            : t("ocr.desk.layoutOverview")}
        </span>
        {available ? (
          <div className="desk-map-legend">
            {AREA_KINDS.filter((kind) => areas.some((area) => area.kind === kind)).map((kind) => (
              <span
                key={kind}
                className={"desk-map-key desk-map-key--" + kind}
              >
                <i aria-hidden="true" />
                {t("ocr.desk.areaKinds." + kind)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
