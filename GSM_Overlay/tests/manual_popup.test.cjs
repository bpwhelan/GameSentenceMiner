const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { between } = require('./helpers/overlay-startup.cjs');

const renderer = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function setup(reader, inactiveBehavior = 'hide-overlay', mode = 'toggle') {
  const dom = new JSDOM('<body class="force-visible"><div class="text-box"></div></body>');
  const listeners = new Map(), closed = [], sent = [];
  const text = dom.window.document.querySelector('.text-box');
  const context = vm.createContext({
    window: dom.window, document: dom.window.document,
    console: { log() {}, warn() {} },
    dictionaryReader: reader, manualMode: true, manualModeType: mode,
    manualModeInactiveBehavior: inactiveBehavior,
    MANUAL_MODE_INACTIVE_BEHAVIOR_HIDE_OVERLAY: 'hide-overlay',
    MANUAL_MODE_INACTIVE_BEHAVIOR_DISABLE_INTERACTION: 'disable-interaction',
    manualHotkeyPressed: true, manualModeActivatedOnce: true, pinned: false,
    yomitanShowing: false, yomitanPopupCount: 0,
    yomitanPopupIds: new Set(), hideOnYomitanClose: false,
    lastPopupCount: 0, lastPopupChangeTime: 0, isMagpieActive: false,
    overlayCaptureAvailable: true, gamepadHandler: null,
    textHover: { reset() {} },
    cancelDeferredManualReveal() {}, clearManualDesktopBackground() {},
    armDeferredManualReveal() {},
    revealManualOverlayContent: () => { text.style.display = ''; },
    restoreOverlayPassThrough: reason => sent.push(['pass-through', reason]),
    hideTextBoxes: () => { text.style.display = 'none'; },
    showTextBoxes: () => { text.style.display = ''; },
    updateGamepadStatusIndicator() {},
    requestJitenReaderGradingSettings() {}, pushJitenGradingConfig() {},
    setTimeout: callback => callback(),
    ipcRenderer: {
      on: (channel, handler) => listeners.set(channel, handler),
      send: (...args) => sent.push(args),
    },
  });
  const popupEvent = (suffix, popupId) => dom.window.dispatchEvent(new dom.window.CustomEvent(
    `${reader === 'hachidori' ? 'gsm-hachidori' : reader}-popup-${suffix}`, { detail: { popupId } },
  ));
  const hidePopup = popupId => popupEvent('hidden', popupId);
  for (const name of ['yomitan', 'hachidori']) {
    dom.window[name === 'hachidori' ? 'gsmHachidoriBridge' : 'gsmYomitanBridge'] = {
      closePopups: async () => {
        closed.push(name);
        if (name === reader) [...context.yomitanPopupIds].forEach(hidePopup);
      },
    };
  }
  vm.runInContext([
    between(renderer, '  function normalizeManualModeInactiveBehavior', '  /**'),
    between(renderer, '  async function closeDictionaryLookups', '  function getGsmDictionaryUrls'),
    between(renderer, '  function handleDictionaryPopupShown', '  const HACHIDORI_EXTERNAL_LINK_RESULT_EVENT'),
    between(renderer, "  ipcRenderer.on('show-overlay-hotkey'", '  // Dedicated AFK hide channel'),
    between(renderer, "  ipcRenderer.on('overlay-capture-state'", "  ipcRenderer.on('gamepad-input-test-active'"),
  ].join('\n'), context);
  popupEvent('shown', 'root');
  popupEvent('shown', 'nested');
  return {
    context, closed, sent, text, document: dom.window.document, hidePopup,
    activate: () => listeners.get('show-overlay-hotkey')({}, true),
    deactivate: async () => {
      listeners.get('show-overlay-hotkey')({}, false);
      // Let the bridge and release-finally callbacks finish.
      await new Promise(resolve => setImmediate(resolve));
    },
    loseCapture: async () => {
      listeners.get('overlay-capture-state')({}, { available: false });
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

for (const reader of ['yomitan', 'hachidori']) {
  test(`${reader} tracks actual root and nested popup lifecycle events`, () => {
    const f = setup(reader);
    assert.equal(f.context.yomitanShowing, true);
    assert.equal(f.context.yomitanPopupCount, 2);
    f.hidePopup('nested');
    assert.equal(f.context.yomitanShowing, true);
    assert.equal(f.context.yomitanPopupCount, 1);
    f.hidePopup('root');
    assert.equal(f.context.yomitanShowing, false);
  });

  for (const behavior of ['hide-overlay', 'disable-interaction']) {
    test(`${reader} toggle-off closes nested popups with ${behavior}`, async () => {
      const f = setup(reader, behavior);
      await f.deactivate();
      assert.deepEqual(f.closed, [reader]);
      assert.equal(f.context.yomitanShowing, false);
      assert.equal(f.context.yomitanPopupCount, 0);
      assert.equal(f.document.body.classList.contains('manual-interaction-suppressed'), true);
      assert.equal(f.text.style.display === 'none', behavior === 'hide-overlay');
      assert.equal(f.document.body.classList.contains('force-visible'), behavior !== 'hide-overlay');
      assert.ok(f.sent.some(([channel]) => channel === 'pass-through'));
    });

    test(`${reader} hold release preserves a visible popup until it closes (${behavior})`, async () => {
      const f = setup(reader, behavior, 'hold');
      await f.deactivate();
      assert.deepEqual(f.closed, []);
      assert.equal(f.context.yomitanShowing, true);
      assert.equal(f.context.hideOnYomitanClose, true);
      f.hidePopup('nested');
      f.hidePopup('root');
      assert.equal(f.context.yomitanShowing, false);
      assert.equal(f.text.style.display === 'none', behavior === 'hide-overlay');
    });
  }

  test(`${reader} toggle-off cancels lookups before popup-shown is reported`, async () => {
    const f = setup(reader);
    f.context.yomitanShowing = false;
    f.context.yomitanPopupIds.clear();
    f.context.yomitanPopupCount = 0;
    await f.deactivate();
    assert.deepEqual(f.closed, [reader]);
    assert.equal(f.text.style.display, 'none');
  });

  test(`${reader} capture loss closes only the selected reader, including pending lookups`, async () => {
    const f = setup(reader);
    f.context.yomitanShowing = false;
    await f.loseCapture();
    assert.deepEqual(f.closed, [reader]);
  });

  test(`${reader} close failure still applies the inactive presentation`, async () => {
    const f = setup(reader);
    f.context.window[reader === 'hachidori' ? 'gsmHachidoriBridge' : 'gsmYomitanBridge'].closePopups =
      async () => { throw new Error('Reader unavailable'); };
    await f.deactivate();
    assert.equal(f.text.style.display, 'none');
    assert.equal(f.document.body.classList.contains('manual-interaction-suppressed'), true);
  });
}

test('Hachidori host-attention events during text selection do not count as visible popups', () => {
  const f = setup('hachidori');
  f.hidePopup('nested');
  f.hidePopup('root');
  f.context.window.dispatchEvent(new f.context.window.CustomEvent('hachidori-popup-shown'));
  assert.equal(f.context.yomitanShowing, false);
  assert.equal(f.context.yomitanPopupCount, 0);
});
