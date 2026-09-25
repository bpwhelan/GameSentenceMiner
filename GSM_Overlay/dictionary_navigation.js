/* Reader adapters isolate popup transport/DOM differences from GamepadHandler. */
(() => {
  const popupActions = new Set(['scroll', 'select-action', 'reset-action-selection',
    'confirm-action', 'clear-action-selection', 'next-entry', 'previous-entry']);
  const readers = new Map();
  const post = (target, message) => { try { target?.postMessage(message, '*'); } catch { /* Retired frame. */ } };

  function subscription(window, prefix, shown, hidden) {
    window.addEventListener(`${prefix}-popup-shown`, shown);
    window.addEventListener(`${prefix}-popup-hidden`, hidden);
    return () => {
      window.removeEventListener(`${prefix}-popup-shown`, shown);
      window.removeEventListener(`${prefix}-popup-hidden`, hidden);
    };
  }

  readers.set('yomitan', ({ window, document }) => {
    const frames = () => Array.from(document.querySelectorAll('iframe.yomitan-popup'));
    const visible = frame => {
      const style = window.getComputedStyle?.(frame) || frame.style;
      return style?.display !== 'none' && style?.visibility !== 'hidden'
        && (typeof frame.getClientRects !== 'function' || frame.getClientRects().length > 0);
    };
    const top = () => frames().filter(visible).slice(-1);
    return {
      targetAttribute: 'data-gsm-yomitan-lookup-target',
      subscribe: (shown, hidden) => subscription(window, 'yomitan', shown, hidden),
      control(action, params = {}) {
        const message = { ...params, type: 'gsm-yomitan-control', action };
        post(window, message);
        const targets = action === 'lookup-point' ? [] : popupActions.has(action) ? top() : frames();
        targets.forEach(frame => post(frame.contentWindow, message));
      },
      canConfirm: () => top().length > 0,
      mine() { top().forEach(frame => post(frame.contentWindow, { type: 'gsm-trigger-anki-add', cardFormatIndex: 0 })); },
      setNavigationActive(active) {
        const message = { type: 'gsm-gamepad-navigation-active', active };
        post(window, message);
        frames().forEach(frame => post(frame.contentWindow, message));
      },
    };
  });

  readers.set('hachidori', ({ window }) => {
    const control = (action, body = {}) => {
      const bridge = window.gsmHachidoriBridge;
      if (!bridge) return;
      void bridge.control(action, body).catch(error => {
        window.console?.warn('[Hachidori] Controller command failed:', action, error);
      });
    };
    return {
      targetAttribute: 'data-gsm-hachidori-lookup-target',
      subscribe(shown, hidden) {
        let changed = false, disposed = false;
        const stop = subscription(window, 'gsm-hachidori', event => { changed = true; shown(event); },
          event => { changed = true; hidden(event); });
        // A settings reload can create the handler while a mouse-opened popup already exists.
        if (typeof window.gsmHachidoriBridge?.state === 'function') {
          void window.gsmHachidoriBridge.state().then(state => {
            if (!disposed && !changed) for (const detail of state.popups || []) shown({ detail });
          }).catch(() => {});
        }
        return () => { disposed = true; stop(); };
      },
      control,
      canConfirm: () => Boolean(window.gsmHachidoriBridge),
      mine: () => control('mine'),
      setNavigationActive: active => control('navigation-active', { active }),
    };
  });

  function createDictionaryNavigation(reader = 'yomitan', environment = { window, document }) {
    const factory = readers.get(reader);
    if (!factory) throw new Error(`Unsupported dictionary reader: ${reader}`);
    return factory(environment);
  }
  const api = { createDictionaryNavigation, registerReader: (name, factory) => readers.set(name, factory) };
  if (typeof window !== 'undefined') window.GsmDictionaryNavigation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
