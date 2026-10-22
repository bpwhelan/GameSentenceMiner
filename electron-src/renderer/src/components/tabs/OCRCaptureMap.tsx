import { useTranslation } from "../../i18n";

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
  onEdit
}: {
  config: CaptureMapConfig | null;
  disabled: boolean;
  onEdit: () => void;
}) {
  const t = useTranslation();
  const { areas, available } = buildCaptureMap(config);
  const hasAreas = Boolean(config?.rectangles?.length);
  const geometry = config?.window_geometry;
  const aspectRatio =
    geometry?.width &&
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
        className="desk-map-canvas"
        onClick={onEdit}
        disabled={disabled}
        aria-label={t("ocr.sceneAndAreas.selectAreas")}
      >
        <span
          className="desk-map-crosshair"
          aria-hidden="true"
        />
        {available ? (
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
            {areas.map((area) => (
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
      <div className="desk-map-caption">
        <span>{t("ocr.desk.layoutOverview")}</span>
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
