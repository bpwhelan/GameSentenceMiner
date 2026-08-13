import { RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";

import type { HoshidictsReaderPreferences } from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import "./HoshidictsPopupPreview.css";

const PREVIEW_CHANNEL = "gsm.hoshidicts.preview.v1";
const PREVIEW_PATH = "./hoshidicts-preview/index.html";
const STAGE_HORIZONTAL_PADDING = 96;
const STAGE_VERTICAL_PADDING = 112;
const FIT_PADDING = 24;

type PreviewStatus = "loading" | "connecting" | "ready" | "error";

interface PreviewStatusMessage {
  channel: typeof PREVIEW_CHANNEL;
  type: "status";
  status: PreviewStatus;
}

interface PreviewReadyMessage {
  channel: typeof PREVIEW_CHANNEL;
  type: "frame-ready";
}

type PreviewFrameMessage = PreviewStatusMessage | PreviewReadyMessage;

interface PreviewPreferencesMessage {
  channel: typeof PREVIEW_CHANNEL;
  type: "preferences";
  preferences: HoshidictsReaderPreferences;
}

interface PreviewRefreshMessage {
  channel: typeof PREVIEW_CHANNEL;
  type: "refresh";
}

type PreviewParentMessage =
  | PreviewPreferencesMessage
  | PreviewRefreshMessage;

export interface HoshidictsPopupPreviewProps {
  preferences: HoshidictsReaderPreferences;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePreviewFrameMessage(value: unknown): PreviewFrameMessage | null {
  return isRecord(value) && value.channel === PREVIEW_CHANNEL
    ? (value as unknown as PreviewFrameMessage)
    : null;
}

export function HoshidictsPopupPreview({
  preferences
}: HoshidictsPopupPreviewProps) {
  const t = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [scaleToFit, setScaleToFit] = useState(true);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const stageWidth = preferences.popupWidthPx + STAGE_HORIZONTAL_PADDING;
  const stageHeight = preferences.popupHeightPx + STAGE_VERTICAL_PADDING;

  const postToPreview = useCallback((message: PreviewParentMessage) => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const sendPreferences = useCallback(() => {
    postToPreview({
      channel: PREVIEW_CHANNEL,
      type: "preferences",
      preferences
    });
  }, [postToPreview, preferences]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateSize = () => {
      setViewportSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parsePreviewFrameMessage(event.data);
      if (!message) return;
      if (message.type === "frame-ready") {
        setStatus("connecting");
        sendPreferences();
        return;
      }
      setStatus(message.status);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendPreferences]);

  useEffect(() => {
    sendPreferences();
  }, [sendPreferences]);

  const scale = useMemo(() => {
    if (!scaleToFit || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return 1;
    }
    return Math.max(
      0.1,
      Math.min(
        1,
        (viewportSize.width - FIT_PADDING) / stageWidth,
        (viewportSize.height - FIT_PADDING) / stageHeight
      )
    );
  }, [scaleToFit, stageHeight, stageWidth, viewportSize]);

  const canvasStyle = {
    width: `${stageWidth * scale}px`,
    height: `${stageHeight * scale}px`
  } satisfies CSSProperties;
  const stageStyle = {
    width: `${stageWidth}px`,
    height: `${stageHeight}px`,
    transform: `scale(${scale})`
  } satisfies CSSProperties;
  const scalePercent = Math.round(scale * 100);

  return (
    <section className="hoshidicts-popup-preview">
      <header className="hoshidicts-popup-preview__header">
        <div className="hoshidicts-popup-preview__title">
          <div>
            <h3>{t("settings.hoshidicts.design.preview.title")}</h3>
            <span className="hoshidicts-popup-preview__word" lang="ja">
              蜂
            </span>
          </div>
          <div
            className="hoshidicts-popup-preview__status"
            data-status={status}
            role="status"
            aria-live="polite"
          >
            <span aria-hidden="true" />
            {t(`settings.hoshidicts.design.preview.status.${status}`)}
          </div>
        </div>

        <div className="hoshidicts-popup-preview__toolbar">
          <div
            className="hoshidicts-popup-preview__size-mode"
            role="group"
            aria-label={t("settings.hoshidicts.design.preview.sizeMode")}
          >
            <button
              type="button"
              className={scaleToFit ? "is-active" : ""}
              aria-pressed={scaleToFit}
              onClick={() => setScaleToFit(true)}
            >
              {t("settings.hoshidicts.design.preview.scaleToFit")}
            </button>
            <button
              type="button"
              className={!scaleToFit ? "is-active" : ""}
              aria-pressed={!scaleToFit}
              onClick={() => setScaleToFit(false)}
            >
              {t("settings.hoshidicts.design.preview.actualSize")}
            </button>
          </div>
          <span className="hoshidicts-popup-preview__scale">
            {t("settings.hoshidicts.design.preview.scalePercent", {
              percent: scalePercent
            })}
          </span>
          <button
            type="button"
            className="hoshidicts-popup-preview__refresh"
            onClick={() => {
              setStatus("connecting");
              postToPreview({
                channel: PREVIEW_CHANNEL,
                type: "refresh"
              });
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {t("settings.hoshidicts.design.preview.refresh")}
          </button>
        </div>
      </header>

      <div
        ref={viewportRef}
        className="hoshidicts-popup-preview__viewport"
        data-scale-to-fit={scaleToFit}
      >
        <div className="hoshidicts-popup-preview__canvas" style={canvasStyle}>
          <div className="hoshidicts-popup-preview__stage" style={stageStyle}>
            <iframe
              ref={iframeRef}
              src={PREVIEW_PATH}
              title={t("settings.hoshidicts.design.preview.frameTitle")}
              sandbox="allow-scripts allow-same-origin"
              onLoad={() => {
                setStatus("connecting");
                sendPreferences();
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
