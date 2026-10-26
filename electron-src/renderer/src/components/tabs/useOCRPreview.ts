import { useCallback, useEffect, useRef, useState } from "react";
import type { OcrPreviewFrame } from "../../../../shared/ocr_preview";
import { invokeIpc } from "../../lib/ipc";

const documentVisible = () => document.visibilityState !== "hidden";
const LIVE_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 3000;

// Capture timestamps change even when the picture and geometry do not. Keep
// those responses out of React and the SVG/image decoding/painting path.
function sameFrame(previous: OcrPreviewFrame | null, next: OcrPreviewFrame) {
  return previous?.sceneId === next.sceneId && previous.sceneName === next.sceneName &&
    previous.sourceName === next.sourceName && previous.width === next.width &&
    previous.height === next.height && previous.imageData === next.imageData &&
    JSON.stringify(previous.boxes) === JSON.stringify(next.boxes);
}

export function useOCRPreview({
  active,
  paused,
  sceneId,
  sceneName,
  includeBoxes
}: {
  active: boolean;
  paused: boolean;
  sceneId: string;
  sceneName: string;
  includeBoxes: boolean;
}) {
  const [frame, setFrame] = useState<OcrPreviewFrame | null>(null);
  const latestFrame = useRef<OcrPreviewFrame | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const latestUnavailable = useRef(false);
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
    if (!active || !sceneId) return;
    let cancelled = false;
    let pending = false;
    let interval = LIVE_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const updateUnavailable = (value: boolean) => {
      if (latestUnavailable.current !== value) {
        latestUnavailable.current = value;
        setUnavailable(value);
      }
    };
    const capture = async (manual = false) => {
      if (cancelled || pending || !documentVisible()) return;
      pending = true;
      // Live responses that haven't changed must not cause busy-state renders.
      if (manual) setRefreshing(true);
      try {
        const next = await invokeIpc<OcrPreviewFrame | null>("ocr.get-preview", {
          sceneId,
          sceneName,
          includeBoxes
        });
        if (!cancelled && documentVisible()) {
          const valid = next?.sceneId === sceneId && next.sceneName === sceneName;
          if (valid) {
            if (sameFrame(latestFrame.current, next)) {
              interval = Math.min(IDLE_INTERVAL_MS, interval * 2);
            } else {
              interval = LIVE_INTERVAL_MS;
              latestFrame.current = next;
              setFrame(next);
            }
          } else {
            interval = IDLE_INTERVAL_MS;
          }
          updateUnavailable(!valid);
        }
      } catch {
        if (!cancelled && documentVisible()) {
          interval = IDLE_INTERVAL_MS;
          updateUnavailable(true);
        }
      } finally {
        pending = false;
        if (!cancelled) {
          if (manual) setRefreshing(false);
          if (!paused && documentVisible()) timer = setTimeout(() => void capture(), interval);
        }
      }
    };
    refreshNow.current = () => {
      if (pending) return;
      clearTimeout(timer);
      void capture(true);
    };
    const onVisibility = () => {
      clearTimeout(timer);
      interval = LIVE_INTERVAL_MS;
      if (documentVisible() && !paused) void capture();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!paused) void capture();
    return () => {
      cancelled = true;
      refreshNow.current = () => {};
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, paused, sceneId, sceneName, includeBoxes]);

  return {
    frame: frame?.sceneId === sceneId && frame.sceneName === sceneName ? frame : null,
    unavailable,
    refreshing,
    refresh
  };
}
