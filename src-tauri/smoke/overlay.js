(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, message) => { if (!ok) throw Error(message); };
  for (let i = 0; i < 100 && !display?.physicalBounds?.width; i++) await wait(50);
  check(display?.physicalBounds?.width > 0, 'Missing initial overlay display');
  const nativeDispatch = window.__GSM_DESKTOP_DISPATCH__;
  const dispatch = (channel, value) => nativeDispatch(channel, [value]);
  let hachidoriShown = false;
  let lookupPoint;
  window.addEventListener('gsm-hachidori-popup-shown', () => { hachidoriShown = true; });
  window.addEventListener('gsm-hachidori-popup-hidden', () => { hachidoriShown = false; });
  const receive = value => handleOverlayWebSocketData(JSON.stringify(value));
  const render = () => receive({ type: 'word_coordinates', line_id: 'native-smoke', data: [{
    text: '食べる', bounding_rect: { x1: 0.25, y1: 0.4, x3: 0.4, y3: 0.46 },
    words: [{ text: '食べる', bounding_rect: { x1: 0.25, y1: 0.4, x3: 0.4, y3: 0.46 } }],
  }] });
  window.__gsmSmokeOverlay = {
    async waitForManualState(active) {
      for (let i = 0; i < 120; i++) {
        if (manualHotkeyPressed === active) return true;
        await wait(25);
      }
      throw Error(`The configured shortcut did not set manual activation to ${active}`);
    },
    startHybridLookup() {
      // Exercise key-up arriving before the popup-shown IPC, even on a fast machine.
      const send = ipcRenderer.send;
      ipcRenderer.send = (channel, ...args) => {
        if (channel !== 'yomitan-event' || args[0] !== true) send.call(ipcRenderer, channel, ...args);
      };
      let checked = false;
      const visible = window.isManualLookupVisible;
      window.isManualLookupVisible = () => { checked = true; return visible(); };
      // Keep the simulated cursor at the lookup word through key-up.
      window.__GSM_DESKTOP_DISPATCH__ = (channel, args) => {
        if (channel !== 'text-hover-pointer') nativeDispatch(channel, args);
      };
      this.finishHybridLookup = async () => {
        try {
          for (let i = 0; i < 120 && !checked; i++) await wait(25);
          check(checked, 'Key-up never checked the visible lookup');
          dispatch('text-hover-pointer', { ...lookupPoint, buttons: 0, shiftKey: false });
          await wait(350);
          check(manualHotkeyPressed, 'Hybrid deactivated after key-up with a visible lookup');
          check(isManualLookupVisible(), 'The lookup closed after key-up');
          const box = document.querySelector('.text-box');
          check(box?.getBoundingClientRect().width > 0, 'The OCR hit target disappeared after key-up');
          const style = getComputedStyle(box);
          check(style.pointerEvents === 'auto', `OCR hit target ignores the pointer after key-up: ${style.pointerEvents}`);
          check(style.color === 'rgba(255, 255, 255, 0)' && style.backgroundColor === 'rgba(15, 15, 15, 0)',
            'Push to Show painted OCR text over the game');
          if (dictionaryReader === 'yomitan') check(getVisibleYomitanPopupFrames().length > 0, 'Yomitan frame is hidden');
          await closeDictionaryLookups('hybrid-smoke');
          await this.waitForManualState(false);
          check(!yomitanShowing && getComputedStyle(box).display === 'none', 'Last popup close left the overlay active');
          return true;
        } finally {
          ipcRenderer.send = send;
          window.isManualLookupVisible = visible;
          window.__GSM_DESKTOP_DISPATCH__ = nativeDispatch;
        }
      };
      return true;
    },
    async geometry() {
      dispatch('show-overlay-hotkey', true);
      // Negative desktop origins and non-unit DPI exercise physical -> viewport mapping.
      dispatch('display-info', { ...display, physicalBounds: { x: -2560, y: -1440, width: 2560, height: 1440 } });
      await render();
      const box = document.querySelector('.text-box');
      check(box, 'OCR text was not rendered');
      const bounds = box.getBoundingClientRect();
      check(bounds.width > 0 && bounds.height > 0, 'OCR text has no hit area');
      const state = { type: 'window_state', data: 'active', target_hwnd: 1,
        target_client_rect: { left: -2300, top: -1200, right: -500, bottom: -200 },
        occlusion_rects: [{ left: -2560, top: -1440, right: 0, bottom: 0 }] };
      await receive(state);
      check(getComputedStyle(box).visibility === 'hidden', 'Covered lookup text remains visible');
      dispatch('settings-updated', { hideCoveredText: false });
      check(getComputedStyle(box).visibility !== 'hidden', 'Disabling the cover mask did not restore lookup text');
      dispatch('settings-updated', { hideCoveredText: true });
      check(getComputedStyle(box).visibility === 'hidden', 'Re-enabling the cover mask missed cached bounds');
      await receive({ ...state, occlusion_rects: [] });
      check(getComputedStyle(box).visibility !== 'hidden', 'Uncovered lookup text was not restored');
      window.GSMLiveStatsWidget.applySettings({ showLiveStats: true, liveStatsPositionMode: 'active-window' });
      const stats = document.getElementById('gsm-live-stats');
      check(stats, 'Stats widget was not created');
      const before = stats.getBoundingClientRect();
      await receive({ ...state, occlusion_rects: [], target_client_rect: { left: -1800, top: -1000, right: -100, bottom: -100 } });
      const after = stats.getBoundingClientRect();
      check(before.x !== after.x || before.y !== after.y, 'Stats did not follow target window');
      dispatch('show-overlay-hotkey', false);
      return true;
    },
    async lookup(reader, { shiftKey = true, stationary = false } = {}) {
      // A fixed native sample drives the real forwarding/scanning path while the
      // user's physical mouse continues moving independently on the desktop.
      const previousDispatch = window.__GSM_DESKTOP_DISPATCH__;
      window.__GSM_DESKTOP_DISPATCH__ = (channel, args) => {
        if (channel !== 'text-hover-pointer') nativeDispatch(channel, args);
      };
      const shownEvent = reader === 'yomitan' ? 'yomitan-popup-shown' : 'gsm-hachidori-popup-shown';
      let shownAt;
      const onShown = () => { shownAt ??= performance.now(); };
      try {
        for (let i = 0; i < 100 && dictionaryReader !== reader; i++) await wait(50);
        check(dictionaryReader === reader, `Wrong overlay dictionary reader: ${dictionaryReader}`);
        if (reader === 'hachidori') await window.gsmHachidoriBridge.closePopups();
        await wait(100);
        hachidoriShown = false;
        textHover.reset();
        await render();
        const box = document.querySelector('.text-box');
        check(box, 'No text to look up');
        const range = document.createRange();
        // Aim inside the first character even if the fixture word wraps.
        const first = document.createTreeWalker(box, NodeFilter.SHOW_TEXT).nextNode();
        check(first?.textContent.startsWith('食'), 'Missing first character of the overlay fixture');
        range.setStart(first, 0);
        range.setEnd(first, 1);
        const rect = range.getBoundingClientRect();
        const x = rect.left + rect.width / 4, y = rect.top + rect.height / 2;
        lookupPoint = {x, y};
        window.addEventListener(shownEvent, onShown);
        const hoveredAt = performance.now();
        for (let i = 0; i < 150; i++) {
          dispatch('text-hover-pointer', { x: stationary ? x : x + i % 2, y, buttons: 0, shiftKey });
          await wait(100);
          // Hachidori's zero-size host contains a closed shadow root. Its bridge
          // announces the actual popup after lookup; host geometry is always zero.
          // An initializing Yomitan frame can have width before it has a hit area.
          // Use the same visibility signal and geometry that key-up will inspect.
          const visible = reader === 'hachidori' ? hachidoriShown : getVisibleYomitanPopupFrames().length > 0;
          if (shownAt !== undefined && visible) {
            if (shownAt - hoveredAt > 1000) {
              const marks = performance.getEntriesByType('mark')
                .filter(entry => entry.startTime >= hoveredAt)
                .map(entry => [entry.name, Math.round(entry.startTime - hoveredAt)]);
              console.warn('Slow hover performance marks (ms)', JSON.stringify(marks));
            }
            return Math.round(shownAt - hoveredAt);
          }
        }
        throw Error(`No ${reader} popup after hovering production overlay text (hit=${document.elementFromPoint(x,y)?.className}, visibility=${document.visibilityState}, capture=${overlayCaptureAvailable}, manual=${manualHotkeyPressed}, popup=${yomitanShowing}, rect=${JSON.stringify(rect.toJSON())})`);
      } finally {
        window.removeEventListener(shownEvent, onShown);
        window.__GSM_DESKTOP_DISPATCH__ = previousDispatch;
      }
    },
  };
  return true;
})()
