import { useCallback, useEffect, useRef, useState } from "react";
import type { OcrPreviewFrame } from "../../../../shared/ocr_preview";
import { invokeIpc } from "../../lib/ipc";
import { isDocumentVisible, NATIVE_VISIBILITY_EVENT } from "../../lib/visiblePolling";

const LIVE_INTERVAL_MS = 1000;
const BACKGROUND_INTERVAL_MS = 15_000;

// Capture timestamps change even when the picture and geometry do not. Keep
// those responses out of React and the SVG/image decoding/painting path.
function sameFrame(previous: OcrPreviewFrame | null, next: OcrPreviewFrame) {
  return previous?.sceneId === next.sceneId && previous.sceneName === next.sceneName &&
    previous.sourceName === next.sourceName && previous.width === next.width &&
    previous.height === next.height && previous.sourceSize?.[0] === next.sourceSize?.[0] &&
    previous.sourceSize?.[1] === next.sourceSize?.[1] && previous.imageData === next.imageData &&
    JSON.stringify(previous.boxes) === JSON.stringify(next.boxes);
}

export function useOCRPreview({
  active,
  sceneId,
  sceneName,
  includeBoxes,
  retainFrameWhileInactive = false,
  refreshMode = "focus-aware"
}: {
  active: boolean;
  sceneId: string;
  sceneName: string;
  includeBoxes: boolean;
  retainFrameWhileInactive?: boolean;
  refreshMode?: "manual" | "live" | "focus-aware";
}) {
  const [frame, setFrame] = useState<OcrPreviewFrame | null>(null);
  const latestFrame = useRef<OcrPreviewFrame | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const latestUnavailable = useRef(false);
  const inFlight = useRef(false);
  const boxesRequested = useRef(includeBoxes);
  boxesRequested.current = includeBoxes;
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshNow.current(), []);
  useEffect(() => {
    setFrame(null);
    latestFrame.current = null;
    setUnavailable(false);
    latestUnavailable.current = false;
  }, [sceneId, sceneName]);

  useEffect(() => {
    setRefreshing(false);
    if (!active || !sceneId) {
      if (!retainFrameWhileInactive || !sceneId) {
        latestFrame.current = null;
        setFrame(null);
      }
      latestUnavailable.current = false;
      setUnavailable(false);
      return;
    }
    let cancelled = false;
    let focused = document.hasFocus();
    const automatic = refreshMode !== "manual";
    const interval = () => refreshMode === "focus-aware" && !(focused && isDocumentVisible())
      ? BACKGROUND_INTERVAL_MS
      : LIVE_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay = interval()) => {
      clearTimeout(timer);
      if (!automatic) return;
      timer = setTimeout(() => void capture(), delay);
    };
    const updateUnavailable = (value: boolean) => {
      if (latestUnavailable.current !== value) {
        latestUnavailable.current = value;
        setUnavailable(value);
      }
    };
    const capture = async (manual = false) => {
      if (cancelled) return;
      if (inFlight.current) { schedule(); return; }
      inFlight.current = true;
      const started = performance.now();
      // Live responses that haven't changed must not cause busy-state renders.
      if (manual) setRefreshing(true);
      try {
        const next = await invokeIpc<OcrPreviewFrame | null>("ocr.get-preview", {
          sceneId,
          sceneName,
          includeBoxes: boxesRequested.current
        });
        if (!cancelled) {
          const valid = next?.sceneId === sceneId && next.sceneName === sceneName;
          if (valid && !sameFrame(latestFrame.current, next)) {
            latestFrame.current = next;
            setFrame(next);
          }
          updateUnavailable(!valid);
        }
      } catch {
        if (!cancelled) {
          updateUnavailable(true);
        }
      } finally {
        inFlight.current = false;
        if (!cancelled) {
          if (manual) setRefreshing(false);
          const remaining = interval() - (performance.now() - started);
          schedule(remaining > 0 ? remaining : interval());
        }
      }
    };
    refreshNow.current = () => {
      if (inFlight.current) return;
      clearTimeout(timer);
      void capture(true);
    };
    const changeFocus = (next: boolean) => {
      if (refreshMode !== "focus-aware" || focused === next) return;
      focused = next;
      clearTimeout(timer);
      if (automatic && !inFlight.current && next) void capture();
      else schedule();
    };
    const onFocus = () => changeFocus(isDocumentVisible());
    const onBlur = () => changeFocus(false);
    const onVisibility = () => changeFocus(document.hasFocus() && isDocumentVisible());
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(NATIVE_VISIBILITY_EVENT, onVisibility);
    if (automatic) void capture();
    return () => {
      cancelled = true;
      refreshNow.current = () => {};
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(NATIVE_VISIBILITY_EVENT, onVisibility);
    };
  }, [active, sceneId, sceneName, refreshMode, retainFrameWhileInactive]);

  return {
    frame: frame?.sceneId === sceneId && frame.sceneName === sceneName ? frame : null,
    unavailable,
    refreshing,
    refresh
  };
}
