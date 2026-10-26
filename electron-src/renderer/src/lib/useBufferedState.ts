import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

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
    if (activeRef.current && document.visibilityState !== "hidden") {
      setState(latest.current);
    }
  }, []);

  useEffect(() => {
    const flush = () => {
      if (activeRef.current && document.visibilityState !== "hidden") {
        setState(latest.current);
      }
    };
    flush();
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [active]);

  return [state, update] as const;
}
