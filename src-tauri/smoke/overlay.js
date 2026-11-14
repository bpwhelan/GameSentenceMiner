(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, message) => { if (!ok) throw Error(message); };
  for (let i = 0; i < 100 && !display?.physicalBounds?.width; i++) await wait(50);
  check(display?.physicalBounds?.width > 0, 'Missing initial overlay display');
  const nativeDispatch = window.__GSM_DESKTOP_DISPATCH__;
  const dispatch = (channel, value) => nativeDispatch(channel, [value]);
  let hachidoriShown = false;
  window.addEventListener('gsm-hachidori-popup-shown', () => { hachidoriShown = true; });
  window.addEventListener('gsm-hachidori-popup-hidden', () => { hachidoriShown = false; });
  const receive = value => handleOverlayWebSocketData(JSON.stringify(value));
  const render = () => receive({ type: 'word_coordinates', line_id: 'native-smoke', data: [{
    text: '食べる', bounding_rect: { x1: 0.25, y1: 0.4, x3: 0.4, y3: 0.46 },
    words: [{ text: '食べる', bounding_rect: { x1: 0.25, y1: 0.4, x3: 0.4, y3: 0.46 } }],
  }] });
  window.__gsmSmokeOverlay = {
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
      await receive({ ...state, occlusion_rects: [] });
      check(getComputedStyle(box).visibility !== 'hidden', 'Uncovered lookup text was not restored');
      window.GSMLiveStatsWidget.applySettings({ showLiveStats: true, liveStatsPositionMode: 'active-window' });
      const stats = document.getElementById('gsm-live-stats');
      check(stats, 'Stats widget was not created');
      const before = stats.getBoundingClientRect();
      await receive({ ...state, occlusion_rects: [], target_client_rect: { left: -1800, top: -1000, right: -100, bottom: -100 } });
      const after = stats.getBoundingClientRect();
      check(before.x !== after.x || before.y !== after.y, 'Stats did not follow target window');
      return true;
    },
    async lookup(reader) {
      // A fixed native sample drives the real forwarding/scanning path while the
      // user's physical mouse continues moving independently on the desktop.
      window.__GSM_DESKTOP_DISPATCH__ = (channel, args) => {
        if (channel !== 'text-hover-pointer') nativeDispatch(channel, args);
      };
      try {
      for (let i = 0; i < 100 && dictionaryReader !== reader; i++) await wait(50);
      check(dictionaryReader === reader, `Wrong overlay dictionary reader: ${dictionaryReader}`);
      await render();
      const box = document.querySelector('.text-box');
      check(box, 'No text to look up');
      const range = document.createRange();
      range.selectNodeContents(box);
      const rect = range.getBoundingClientRect();
      const x = rect.left + 2, y = rect.top + rect.height / 2;
      for (let i = 0; i < 150; i++) {
        dispatch('text-hover-pointer', { x: x + i % 2, y, buttons: 0, shiftKey: true });
        await wait(100);
        // Hachidori's zero-size host contains a closed shadow root. Its bridge
        // announces the actual popup after lookup; host geometry is always zero.
        if (reader === 'hachidori' && hachidoriShown) return true;
        const popup = reader === 'yomitan' ? document.querySelector('iframe.yomitan-popup') : null;
        if (popup && popup.getBoundingClientRect().width > 0 && getComputedStyle(popup).visibility !== 'hidden') return true;
      }
      throw Error(`No ${reader} popup after hovering production overlay text (hit=${document.elementFromPoint(x,y)?.className}, visibility=${document.visibilityState}, capture=${overlayCaptureAvailable}, manual=${manualHotkeyPressed}, popup=${yomitanShowing}, rect=${JSON.stringify(rect.toJSON())})`);
      } finally { window.__GSM_DESKTOP_DISPATCH__ = nativeDispatch; }
    },
  };
  return true;
})()
