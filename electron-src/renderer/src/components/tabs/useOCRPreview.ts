import { useEffect, useState } from "react";
import type { OcrPreviewFrame } from "../../../../shared/ocr_preview";
import { invokeIpc } from "../../lib/ipc";

const documentVisible = () => document.visibilityState !== "hidden";

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
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setFrame(null);
    setUnavailable(false);
  }, [sceneId, sceneName]);

  useEffect(() => {
    if (!active || paused || !sceneId) return;
    let cancelled = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (cancelled || pending || !documentVisible()) return;
      pending = true;
      try {
        const next = await invokeIpc<OcrPreviewFrame | null>("ocr.get-preview", {
          sceneId,
          sceneName,
          includeBoxes
        });
        if (!cancelled && documentVisible()) {
          const valid = next?.sceneId === sceneId && next.sceneName === sceneName;
          if (valid) setFrame(next);
          setUnavailable(!valid);
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        pending = false;
        if (!cancelled && documentVisible()) timer = setTimeout(refresh, 750);
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (documentVisible()) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, paused, sceneId, sceneName, includeBoxes]);

  return {
    frame: frame?.sceneId === sceneId && frame.sceneName === sceneName ? frame : null,
    unavailable
  };
}
