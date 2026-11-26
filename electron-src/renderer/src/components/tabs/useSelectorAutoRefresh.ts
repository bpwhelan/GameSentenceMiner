import { useEffect, useState } from "react";
import { getChromeStoreBoolean, setChromeStoreBoolean } from "../../lib/chrome_store";

const preference = "ocr.selector.autoRefresh";
const changed = "gsm-ocr-selector-auto-refresh";

function setAutoRefresh(enabled: boolean) {
  setChromeStoreBoolean(preference, enabled);
  window.dispatchEvent(new CustomEvent(changed, { detail: enabled }));
}

export function useSelectorAutoRefresh() {
  const [enabled, setEnabled] = useState(() => getChromeStoreBoolean(preference, false));
  useEffect(() => {
    const update = (event: Event) => setEnabled((event as CustomEvent<boolean>).detail);
    window.addEventListener(changed, update);
    return () => window.removeEventListener(changed, update);
  }, []);
  return [enabled, setAutoRefresh] as const;
}
