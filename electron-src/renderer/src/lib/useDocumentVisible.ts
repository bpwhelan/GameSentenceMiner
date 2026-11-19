import { useSyncExternalStore } from 'react';
import { isDocumentVisible, NATIVE_VISIBILITY_EVENT } from './visiblePolling';

const subscribe = (changed: () => void) => {
  document.addEventListener('visibilitychange', changed);
  window.addEventListener(NATIVE_VISIBILITY_EVENT, changed);
  return () => {
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener(NATIVE_VISIBILITY_EVENT, changed);
  };
};

/** Visibility is independent of focus: an unfocused reader can still be in use. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, isDocumentVisible, () => true);
}
