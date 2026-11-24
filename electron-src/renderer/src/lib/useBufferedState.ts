import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { isDocumentVisible, NATIVE_VISIBILITY_EVENT } from "./visiblePolling";

/** Keep live data current without rendering a panel that nobody can see. */
export function useBufferedState<T>(initial: T, active: boolean) {
  const [state, setState] = useState(initial);
  const latest = useRef(initial);
  const activeRef = useRef(active);
  activeRef.current = active;

  const update = useCallback((action: SetStateAction<T>) => {
    latest.current = typeof action === "function"
      ? (action as (previous: T) => T)(latest.current)
      : action;
    if (activeRef.current && isDocumentVisible()) {
      setState(latest.current);
    }
  }, []);

  useEffect(() => {
    const flush = () => {
      if (activeRef.current && isDocumentVisible()) {
        setState(latest.current);
      }
    };
    flush();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener(NATIVE_VISIBILITY_EVENT, flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener(NATIVE_VISIBILITY_EVENT, flush);
    };
  }, [active]);

  return [state, update] as const;
}
