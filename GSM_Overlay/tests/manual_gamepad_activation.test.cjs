const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { between } = require('./helpers/overlay-startup.cjs');

function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  t.after(() => window.close());
  window.console.log = () => {};
  window.document.elementFromPoint = () => null;
  let now = 10000, nextId = 0;
  const timers = new Map();
  window.Date.now = () => now;
  window.setTimeout = (fn, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  window.requestAnimationFrame = fn => window.setTimeout(fn, 0);
  window.cancelAnimationFrame = window.clearTimeout;
  const tick = duration => {
    const end = now + duration;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  for (const file of ['dictionary_navigation.js', 'gamepad.js', 'jiten_highlight.js']) {
    window.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  }
  const block = window.document.createElement('div');
  block.className = 'text-block-container';
  for (const [index, glyph] of Array.from('猫は犬を見る').entries()) {
    const box = window.document.createElement('span');
    box.className = 'text-box';
    box.dataset.lineIndex = '0';
    box.textContent = glyph;
    box.getBoundingClientRect = () => ({ left: index * 20, top: 40, right: index * 20 + 20,
      bottom: 60, width: 20, height: 20 });
    box.getClientRects = () => [box, block].some(el => el.style.display === 'none')
      ? [] : [box.getBoundingClientRect()];
    block.appendChild(box);
  }
  block.getBoundingClientRect = () => ({ left: 0, top: 40, right: 120, bottom: 60, width: 120, height: 20 });
  window.document.body.appendChild(block);

  // Exercise the production hide/reveal functions, including freeze-frame gating.
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  window.eval(`
    const furiganaLayer = null;
    const updateFuriganaVisibilityState = () => {};
    const ipcRenderer = { send() {} };
    let manualHotkeyPressed = false;
    let gamepadHandler;
    ${between(html, '  function hideTextBoxes()', '  let resizeMode = false;')}
    window.manualFixture = {
      setHandler: handler => { gamepadHandler = handler; },
      isReady: () => manualHotkeyPressed && !pendingManualRevealForBackground,
      hide: () => { manualHotkeyPressed = false; hideTextBoxes(); },
      reveal: (deferred = false) => {
        manualHotkeyPressed = true;
        if (deferred) armDeferredManualReveal();
        else revealManualOverlayContent();
      },
      finishReveal: finishDeferredManualReveal,
    };
  `);
  const lookups = [], modes = [];
  const handler = new window.GamepadHandler({
    connectToServer: false, keyboardEnabled: false, focusOverlayOnEntry: false,
    initialPosition: 'first-new', isOverlayReady: window.manualFixture.isReady,
    onModeChange: data => modes.push(data.active), ...options,
  });
  window.manualFixture.setHandler(handler);
  handler.requestTokenizationForBlock = () => {};
  handler.triggerDictionaryLookup = info => lookups.push(info.targetChar.textContent);
  // Geometry comes from the boxes above; visual effects are covered by the Electron smoke test.
  handler.updateVisuals = () => {};
  handler.showModeIndicator = () => {};
  handler.updateVirtualMouseCursor = () => {};
  t.after(() => handler.destroy());
  const api = window.GsmJitenHighlight;
  const flush = async () => { await Promise.resolve(); tick(0); };
  const startParse = async () => {
    api.requestParse([{ text: block.textContent }]);
    await flush();
  };
  const finishParse = async (markup = '<span class="jiten-word mature">猫</span>は<span class="jiten-word new">犬</span>を見る') => {
    window.document.querySelector('#jiten-parse-container p').innerHTML = markup;
    await Promise.resolve();
    tick(200);
    await flush();
  };
  return { window, handler, api, block, lookups, modes, tick, flush, startParse, finishParse,
    manual: window.manualFixture };
}

for (const activationMode of ['modifier', 'toggle']) {
  test(`manual ${activationMode} activation selects and confirms the first unknown after reveal`, async t => {
    const { handler, lookups, modes, manual, startParse, finishParse, flush } = setup(t, { activationMode });
    await startParse();
    await finishParse();
    manual.hide();
    await flush();
    handler.onButtonEvent({ device: 'pad', button: activationMode === 'modifier' ? 4 : 8, pressed: true });
    assert.deepEqual(modes, [true]);
    assert.deepEqual(lookups, []);
    manual.reveal();
    await flush();
    assert.equal(handler.getCurrentAnchorCharIndex(), 2);
    assert.deepEqual(lookups, ['犬']);
    handler.refreshOnTextChange();
    assert.deepEqual(lookups, ['犬'], 'ordinary redraws must not repeat activation lookup');
  });
}

test('visible but inactive manual mode waits for activation and the frozen frame reveal', async t => {
  const { handler, manual, lookups, flush } = setup(t, { initialPosition: 'start' });
  handler.activateNavigation();
  assert.deepEqual(lookups, []);
  manual.reveal(true);
  await flush();
  assert.deepEqual(lookups, []);
  manual.finishReveal();
  await flush();
  assert.deepEqual(lookups, ['猫']);
});

test('an empty activation completes when its first OCR text arrives', async t => {
  const { handler, manual, block, window, lookups, flush } = setup(t, { initialPosition: 'middle' });
  block.remove();
  handler.activateNavigation();
  manual.reveal();
  await flush();
  assert.deepEqual(lookups, []);
  window.document.body.appendChild(block);
  handler.handleOverlayTextRenderComplete({ focusLatestLine: true });
  await flush();
  assert.equal(handler.currentCursorIndex, 3);
  assert.deepEqual(lookups, ['を']);
});

test('late Jiten results finish first-new positioning and lookup once', async t => {
  const { handler, manual, lookups, startParse, finishParse, flush } = setup(t);
  await startParse();
  manual.hide();
  handler.activateNavigation();
  manual.reveal();
  await flush();
  assert.deepEqual(lookups, ['猫'], 'character navigation is usable while Jiten is pending');
  await finishParse();
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  assert.deepEqual(lookups, ['猫', '犬']);
});

for (const action of ['move', 'confirm', 'deactivate', 'replace text']) {
  test(`late Jiten results do not override ${action}`, async t => {
    const { handler, manual, lookups, block, startParse, finishParse, flush } = setup(t);
    await startParse();
    handler.activateNavigation();
    manual.reveal();
    await flush();
    if (action === 'move') {
      handler.navigateCursorRight();
      handler.navigateCursorLeft(); // Returning to the same anchor still cancels the pending jump.
    } else if (action === 'confirm') handler.confirmSelection();
    else if (action === 'deactivate') handler.deactivateNavigation();
    else {
      block.firstChild.textContent = '鳥';
      handler.handleOverlayTextRenderComplete();
    }
    const before = lookups.slice();
    await finishParse();
    assert.equal(handler.getCurrentAnchorCharIndex(), 0);
    assert.deepEqual(lookups, before);
  });
}

test('releasing activation before reveal cancels the pending lookup', async t => {
  const { handler, manual, lookups, flush } = setup(t);
  manual.hide();
  handler.activateNavigation();
  handler.deactivateNavigation();
  manual.reveal();
  await flush();
  assert.deepEqual(lookups, []);
});

test('auto-confirm disabled still positions at the first unknown on first activation', async t => {
  const { handler, manual, lookups, startParse, finishParse, flush } = setup(t, { autoConfirmSelection: false });
  await startParse();
  await finishParse();
  manual.hide();
  handler.activateNavigation();
  manual.reveal();
  await flush();
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  assert.deepEqual(lookups, []);
});

test('manual reactivation resumes the moved cursor after hiding or an interrupted entry', async t => {
  const { handler, manual, lookups, startParse, finishParse, flush } = setup(t);
  await startParse();
  await finishParse();
  manual.hide();
  handler.activateNavigation();
  manual.reveal();
  await flush();
  handler.navigateCursorRight();
  assert.equal(handler.getCurrentAnchorCharIndex(), 3);
  for (const interruptEntry of [false, true]) {
    handler.deactivateNavigation();
    manual.hide();
    await flush();
    if (interruptEntry) {
      handler.activateNavigation();
      handler.deactivateNavigation();
    }
    handler.activateNavigation();
    manual.reveal();
    await flush();
    assert.equal(handler.getCurrentAnchorCharIndex(), 3);
    assert.equal(lookups.at(-1), 'を');
  }
});

test('tokenization arriving after manual reveal maps the original character before confirming', async t => {
  const { handler, manual, lookups, flush } = setup(t, { tokenMode: true, initialPosition: 'middle' });
  manual.hide();
  handler.activateNavigation();
  manual.reveal();
  await flush();
  assert.deepEqual(lookups, ['を']);
  handler.pendingTokenizationByBlock.set(0, '猫は犬を見る');
  handler.pendingTokenizationStartedWhileNavigationActive.set(0, false);
  handler.onTokensReceived({ blockIndex: 0, text: '猫は犬を見る', tokens: [
    { word: '猫は', start: 0, end: 2 },
    { word: '犬を', start: 2, end: 4 },
    { word: '見る', start: 4, end: 6 },
  ] });
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  assert.deepEqual(lookups, ['を', '犬']);
  handler.pendingTokenizationStartedWhileNavigationActive.set(0, true);
  handler.onTokensReceived({ blockIndex: 0, text: '猫は犬を見る', tokens: handler.tokens });
  assert.deepEqual(lookups, ['を', '犬'], 'later active redraws must not reopen the popup');
});

test('a local parse can finish while hidden without drawing highlights or losing its navigation states', async t => {
  const { api, manual, handler, lookups, flush, startParse, window } = setup(t);
  let resolveParse;
  api.setLocalParser(() => new Promise(resolve => { resolveParse = resolve; }));
  await startParse();
  manual.hide();
  resolveParse({ tokens: [[
    { word: '猫', headword: '猫', start: 0, end: 1, knownState: [2] },
    { word: '犬', headword: '犬', start: 2, end: 3, knownState: [0] },
  ]] });
  await flush();
  assert.equal(api.getNavigationTokens().length, 2);
  assert.equal([...window.document.querySelectorAll('.gsm-jiten-hl')]
    .filter(el => el.style.display !== 'none').length, 0);
  handler.activateNavigation();
  manual.reveal();
  await flush();
  assert.deepEqual(lookups, ['犬']);
  assert.equal([...window.document.querySelectorAll('.gsm-jiten-hl')]
    .filter(el => el.style.display !== 'none').length, 1);
});

test('a completed all-known parse leaves the fallback selection usable', async t => {
  const { handler, manual, lookups, startParse, finishParse, flush } = setup(t);
  await startParse();
  handler.activateNavigation();
  manual.reveal();
  await flush();
  await finishParse('<span class="jiten-word mature">猫は犬を見る</span>');
  assert.equal(handler.getCurrentAnchorCharIndex(), 0);
  assert.deepEqual(lookups, ['猫']);
});
