const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(options = {}) {
  const context = vm.createContext({ module: { exports: {} }, window: {}, console: { log() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dictionary_navigation.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gamepad.js'), 'utf8'), context);
  const handler = Object.create(context.module.exports.prototype);
  Object.assign(handler, {
    config: { repeatRate: 150, holdNavigation: 'repeat', horizontalWrap: 'adjacent', ...options },
    currentBlockIndex: 0, currentCursorIndex: 0, currentLineIndex: 0,
    tokenMode: false, lineNavPrefersCharacters: false, tokens: [],
  });
  let confirmations = 0;
  handler.dismissLookupForNavigation = () => {};
  handler.updateVisuals = () => {};
  handler.positionCursorAtCharacter = () => {};
  handler.positionCursorAtToken = () => {};
  handler.autoConfirmSelection = () => confirmations++;
  const block = (text, lineIndex = 0) => {
    const chars = Array.from(text, textContent => ({ textContent, isConnected: true, dataset: { lineIndex: String(lineIndex) } }));
    return { chars, isConnected: true, querySelectorAll: () => chars };
  };
  handler.textBlocks = [block('猫は犬を見る'), block('鳥も見る', 1)];
  handler.refreshCharacters = () => {
    handler.characters = handler.textBlocks[handler.currentBlockIndex].chars;
    handler.lines = [{ indices: handler.characters.map((_, i) => i) }];
  };
  handler.refreshCharacters();
  context.window.GsmJitenHighlight = { getNavigationTokens: () => [
    { lineIndex: 0, text: '猫は犬を見る', start: 0, end: 1, states: ['new'], highlighted: true },
    { lineIndex: 0, text: '猫は犬を見る', start: 2, end: 3, states: ['mature'], highlighted: false },
    { lineIndex: 0, text: '猫は犬を見る', start: 4, end: 6, states: ['new'], highlighted: true },
    { lineIndex: 1, text: '鳥も見る', start: 0, end: 1, states: ['young', 'due'], highlighted: true },
  ] };
  return { handler, context, confirmations: () => confirmations };
}

function setupActivation(options = {}) {
  const fixture = setup({ activationMode: 'modifier', initialPosition: 'first-new', ...options });
  const { handler, context } = fixture;
  Object.assign(handler, {
    isActive: false, virtualMouse: {}, navigationAwayHideToken: 0,
    tokenCacheByBlock: new Map(), pendingTokenizationByBlock: new Map(),
    pendingTokenizationStartedWhileNavigationActive: new Map(),
  });
  context.document = { querySelectorAll: () => handler.textBlocks };
  context.window.dispatchEvent = () => {};
  context.CustomEvent = class {};
  context.setTimeout = () => 1;
  for (const method of ['publishNavigationActiveState', 'rememberCurrentSelectionSnapshot',
    'initializeVirtualMousePosition', 'syncVirtualMouseToCurrentSelection', 'showModeIndicator',
    'syncOverlayFocusState', 'releaseOverlayFocus', 'hideVisuals', 'clearCursorPosition',
    'closeDictionaryPopups']) {
    handler[method] = () => {};
  }
  return fixture;
}

function setupJitenBindings(options = {}) {
  const fixture = setup({
    activationMode: 'toggle', controllerEnabled: true,
    prevJitenWordButton: 'LB', nextJitenWordButton: 'RB', ...options,
  });
  const { handler } = fixture;
  Object.assign(handler, {
    isActive: true, toggleModeActive: true, virtualMouse: {},
    buttonStates: new Map(), gamepads: new Map(), repeatTimers: new Map(),
  });
  handler.updateVirtualMouseCursor = () => {};
  handler.refreshButtonBindings();
  fixture.press = button => {
    handler.onButtonEvent({ device: 'pad', button, pressed: true });
    handler.onButtonEvent({ device: 'pad', button, pressed: false });
  };
  return fixture;
}

function setupJitenReadingOrder(blockLines, options = {}) {
  const fixture = setupJitenBindings(options);
  const { handler, context } = fixture;
  handler.syncVirtualMouseToCurrentSelection = () => {};
  const texts = ['猫は犬を見る', '鳥も空を見る', '魚は海を泳ぐ'];
  handler.textBlocks = blockLines.map(lineIndices => {
    const chars = lineIndices.flatMap(lineIndex => Array.from(texts[lineIndex], (textContent, offset) => ({
      textContent, isConnected: true, dataset: { lineIndex: String(lineIndex) },
      // Deliberately offset the lines: the closest word on screen is not
      // necessarily the next word in the source text.
      getBoundingClientRect: () => ({ left: 500 - lineIndex * 150 + offset * 20,
        top: lineIndex * 40, width: 20, height: 20 }),
    })));
    return { chars, isConnected: true, querySelectorAll: () => chars };
  });
  handler.refreshCharacters = () => {
    handler.characters = handler.textBlocks[handler.currentBlockIndex].chars;
    handler.buildLines();
  };
  handler.currentBlockIndex = blockLines.findIndex(lines => lines.includes(0));
  handler.refreshCharacters();
  handler.currentCursorIndex = handler.characters.findIndex(char => char.dataset.lineIndex === '0');
  context.window.GsmJitenHighlight.getNavigationTokens = () => texts.flatMap((text, lineIndex) => [
    { lineIndex, text, start: 0, end: 1, states: [lineIndex === 1 ? 'young' : 'new'], iPlusOne: lineIndex === 1 },
    { lineIndex, text, start: 2, end: 3, states: ['mature'] },
    { lineIndex, text, start: 4, end: 6, states: ['new'] },
  ]);
  fixture.selection = () => {
    const anchor = handler.getCurrentAnchorCharIndex();
    const lineIndex = handler.characters[anchor].dataset.lineIndex;
    const lineOffset = handler.characters.slice(0, anchor).filter(char => char.dataset.lineIndex === lineIndex).length;
    return [Number(lineIndex), lineOffset];
  };
  return fixture;
}

for (const [layout, blockLines] of [
  ['interleaved blocks', [[0, 2], [1]]],
  ['reordered lines inside a block', [[0, 2, 1]]],
  ['reordered block containers', [[2], [1], [0]]],
]) {
  test(`Jiten word bindings follow source reading order with ${layout}`, () => {
    const { press, selection } = setupJitenReadingOrder(blockLines);
    const next = [];
    for (let i = 0; i < 6; i++) {
      press(5);
      next.push(selection());
    }
    assert.deepEqual(next, [[0, 4], [1, 0], [1, 4], [2, 0], [2, 4], [0, 0]]);
    const previous = [];
    for (let i = 0; i < 6; i++) {
      press(4);
      previous.push(selection());
    }
    assert.deepEqual(previous, [[2, 4], [2, 0], [1, 4], [1, 0], [0, 4], [0, 0]]);
  });
}

test('Jiten jumps from a known token keep reading order and respect the wrap scope', () => {
  const { handler, press, selection } = setupJitenReadingOrder([[0, 2, 1]], { horizontalWrap: 'block' });
  handler.currentCursorIndex = 2;
  press(5);
  assert.deepEqual(selection(), [0, 4]);
  press(5);
  assert.deepEqual(selection(), [1, 0]);
  handler.config.horizontalWrap = 'line';
  press(4);
  assert.deepEqual(selection(), [1, 4]);
  press(5);
  assert.deepEqual(selection(), [1, 0]);
});

test('held Jiten jumps and the first-new starting position use source reading order', () => {
  const { handler, selection } = setupJitenReadingOrder([[2, 0, 1]], {
    holdNavigation: 'new', initialPosition: 'first-new',
  });
  handler.applyPreferredEntryPosition();
  assert.deepEqual(selection(), [0, 0]);
  handler.navigateCursorRight(true);
  assert.deepEqual(selection(), [0, 4]);
  handler.navigateCursorRight(true);
  assert.deepEqual(selection(), [1, 4]);
});

test('Jiten word bindings skip known words, include i+1, and wrap in both directions', () => {
  const { handler, context, press, confirmations } = setupJitenBindings();
  const tokens = context.window.GsmJitenHighlight.getNavigationTokens();
  tokens[3].iPlusOne = true;
  context.window.GsmJitenHighlight.getNavigationTokens = () => tokens;
  const positions = [];
  for (const button of [5, 5, 5, 4, 4]) {
    press(button);
    positions.push([handler.currentBlockIndex, handler.getCurrentAnchorCharIndex()]);
  }
  assert.deepEqual(positions, [[0, 4], [1, 0], [0, 0], [1, 0], [0, 4]]);
  assert.equal(confirmations(), 5);
  assert.equal(handler.config.holdNavigation, 'repeat');
  assert.equal(handler.lineNavPrefersCharacters, true);
});

test('Jiten word bindings are disabled by default and can be cleared after assignment', () => {
  const { handler, press, confirmations } = setupJitenBindings({
    prevJitenWordButton: undefined, nextJitenWordButton: undefined,
  });
  for (const key of ['prevJitenWordButton', 'nextJitenWordButton']) {
    assert.equal(handler.buttonBindings[key].disabled, true);
    handler.config[key] = key === 'prevJitenWordButton' ? 'LB' : 'RB';
  }
  handler.refreshButtonBindings();
  press(5);
  assert.equal(handler.currentCursorIndex, 4);
  handler.config.prevJitenWordButton = 'Disabled';
  handler.config.nextJitenWordButton = -1;
  handler.refreshButtonBindings();
  press(4);
  press(5);
  assert.equal(handler.currentCursorIndex, 4);
  assert.equal(confirmations(), 1);
});

test('Jiten word bindings respect navigation activation and input suppression', () => {
  const { handler, press, confirmations } = setupJitenBindings();
  handler.toggleModeActive = false;
  press(5);
  assert.equal(handler.currentCursorIndex, 0);
  handler.toggleModeActive = true;
  handler.config.inputSuppressed = true;
  press(5);
  assert.equal(handler.currentCursorIndex, 0);
  handler.config.inputSuppressed = false;
  handler.dictionaryPopupVisible = true;
  press(5);
  assert.equal(handler.currentCursorIndex, 4);
  assert.equal(confirmations(), 1);
});

test('Jiten word bindings support modifier combos', () => {
  const { handler, press } = setupJitenBindings({
    activationMode: 'modifier', modifierButton: 'LB', nextJitenWordButton: 'LB + RB',
    prevJitenWordButton: -1,
  });
  press(5);
  assert.equal(handler.currentCursorIndex, 0);
  handler.onButtonEvent({ device: 'pad', button: 4, pressed: true });
  press(5);
  assert.equal(handler.currentCursorIndex, 4);
});

test('Jiten word bindings honor line and block wrapping', () => {
  const { handler, press } = setupJitenBindings({ horizontalWrap: 'block' });
  handler.currentCursorIndex = 4;
  press(5);
  assert.equal(handler.currentBlockIndex, 0);
  assert.equal(handler.currentCursorIndex, 0);
  handler.config.horizontalWrap = 'line';
  handler.lines = [{ indices: [0, 1, 2] }, { indices: [3, 4, 5] }];
  handler.currentCursorIndex = 3;
  press(5);
  assert.equal(handler.currentCursorIndex, 4);
  press(4);
  assert.equal(handler.currentCursorIndex, 4);
});

test('Jiten word bindings stay put for missing, stale, or all-known parse results', () => {
  const { handler, context, press, confirmations } = setupJitenBindings();
  for (const tokens of [[],
    [{ lineIndex: 0, text: '古い文章', start: 0, end: 1, states: ['new'] }],
    [{ lineIndex: 0, text: '猫は犬を見る', start: 2, end: 3, states: ['mature'] }],
  ]) {
    context.window.GsmJitenHighlight.getNavigationTokens = () => tokens;
    press(5);
    press(4);
    assert.equal(handler.currentCursorIndex, 0);
  }
  delete context.window.GsmJitenHighlight;
  press(5);
  assert.equal(handler.currentCursorIndex, 0);
  assert.equal(confirmations(), 0);
});

test('optional keyboard Jiten word bindings use the same navigation', () => {
  const { handler } = setupJitenBindings({
    keyboardPrevJitenWordKey: 'Q', keyboardNextJitenWordKey: 'E',
  });
  handler.pressedKeys = new Set();
  handler.keyboardModifiers = {};
  handler.refreshKeyboardBindings();
  assert.ok(handler.buildKeyboardCaptureAllowlist().includes('KeyE'));
  handler.onKeyboardKeyDown('KeyE');
  assert.equal(handler.currentCursorIndex, 4);
  handler.onKeyboardKeyDown('KeyQ');
  assert.equal(handler.currentCursorIndex, 0);
});

test('repeat acceleration ramps smoothly, is bounded, and leaves the default timing intact', () => {
  const { handler } = setup();
  assert.equal(handler.getNavigationRepeatRate(5000), 150);
  handler.config.holdNavigation = 'accelerate';
  assert.equal(handler.getNavigationRepeatRate(0), 150);
  assert.ok(handler.getNavigationRepeatRate(600) < 150);
  assert.equal(handler.getNavigationRepeatRate(5000), 50);
  handler.config.repeatRate = 25;
  assert.equal(handler.getNavigationRepeatRate(5000), 25);
});

test('line wrapping stays on the current line and skips punctuation at its edges', () => {
  const { handler } = setup({ horizontalWrap: 'line' });
  handler.lines = [{ indices: [0, 1, 2] }, { indices: [3, 4, 5] }];
  handler.characters[2].textContent = '。';
  handler.navigateCursorLeft();
  assert.equal(handler.currentCursorIndex, 1);
  handler.navigateCursorRight();
  assert.equal(handler.currentCursorIndex, 0);
  assert.equal(handler.currentBlockIndex, 0);
});

test('block wrap stays in the block even with multiple blocks', () => {
  const { handler } = setup({ horizontalWrap: 'block' });
  handler.navigateCursorLeft();
  assert.equal(handler.currentCursorIndex, 5);
  handler.navigateCursorRight();
  assert.equal(handler.currentCursorIndex, 0);
  assert.equal(handler.currentBlockIndex, 0);
});

test('the up/down block mode does not change ordinary horizontal edge navigation', () => {
  const { handler } = setup({ verticalNavigation: 'spatial' });
  let allowDirect;
  handler.navigateBlockUp = value => { allowDirect = value; };
  handler.navigateCursorLeft();
  assert.equal(allowDirect, false);
});

test('holding skips to new Jiten words; taps retain ordinary character movement', () => {
  const { handler, confirmations } = setup({ holdNavigation: 'new' });
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 4);
  assert.equal(confirmations(), 1);
  handler.navigateCursorLeft();
  assert.equal(handler.currentCursorIndex, 3);
});

test('highlight jumps cross blocks and wrap; status changes skip equal states', () => {
  const { handler } = setup({ holdNavigation: 'highlighted' });
  handler.currentCursorIndex = 4;
  handler.navigateCursorRight(true);
  assert.equal(handler.currentBlockIndex, 1);
  assert.equal(handler.currentCursorIndex, 0);
  handler.navigateCursorRight(true);
  assert.equal(handler.currentBlockIndex, 0);
  assert.equal(handler.currentCursorIndex, 0);
  handler.config.holdNavigation = 'status-change';
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 2);
});

test('unavailable or stale Jiten data falls back to ordinary movement', () => {
  const { handler, context } = setup({ holdNavigation: 'new' });
  context.window.GsmJitenHighlight.getNavigationTokens = () => [
    { lineIndex: 0, text: '古い文章', start: 0, end: 1, states: ['new'] },
  ];
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 1);
  delete context.window.GsmJitenHighlight;
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 2);
});

test('preferred positions use navigable units and first-new falls back to the start', () => {
  const { handler, context } = setup({ initialPosition: 'middle' });
  handler.applyPreferredEntryPosition();
  assert.equal(handler.currentCursorIndex, 3);
  handler.config.initialPosition = 'first-new';
  handler.applyPreferredEntryPosition();
  assert.equal(handler.currentCursorIndex, 0);
  context.window.GsmJitenHighlight.getNavigationTokens = () => [];
  handler.currentCursorIndex = 5;
  handler.applyPreferredEntryPosition();
  assert.equal(handler.currentCursorIndex, 0);
});

test('first-new resumes the moved cursor through repeated navigation activations', () => {
  const { handler } = setupActivation({ holdNavigation: 'new' });
  handler.currentCursorIndex = 5;
  handler.activateNavigation();
  assert.equal(handler.currentCursorIndex, 0);
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 4);
  handler.navigateCursorRight();
  for (const expectedIndex of [5, 4, 3]) {
    handler.deactivateNavigation();
    handler.deactivateNavigation();
    handler.activateNavigation();
    assert.equal(handler.currentBlockIndex, 0);
    assert.equal(handler.currentCursorIndex, expectedIndex);
    handler.navigateCursorLeft();
  }
});

test('first-new restores the exact character after an inactive redraw and late tokens', () => {
  const { handler } = setupActivation({ holdNavigation: 'new' });
  handler.tokenMode = true;
  handler.activateNavigation();
  handler.navigateCursorRight(true);
  handler.deactivateNavigation();
  handler.textBlocks[0] = {
    ...handler.textBlocks[0],
    chars: handler.characters.map(char => ({ ...char })),
    querySelectorAll() { return this.chars; },
  };
  handler.currentCursorIndex = 0;
  handler.lineNavPrefersCharacters = false;
  handler.tokens = [{ word: '猫は犬を見る', start: 0, end: 6 }];
  handler.activateNavigation();
  assert.equal(handler.getCurrentAnchorCharIndex(), 4);
  assert.equal(handler.characters[handler.getCurrentAnchorCharIndex()].textContent, '見');
});

test('first-new remembers the character anchor when deactivated in token mode', () => {
  const { handler } = setupActivation();
  handler.tokenMode = true;
  handler.tokens = [
    { word: '猫は', start: 0, end: 2 },
    { word: '犬を', start: 2, end: 4 },
    { word: '見る', start: 4, end: 6 },
  ];
  handler.activateNavigation();
  handler.navigateCursorRight();
  assert.equal(handler.currentCursorIndex, 1);
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  handler.deactivateNavigation();
  handler.activateNavigation();
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
});

test('first-new keeps the saved cursor when no unknown words remain', () => {
  const { handler, context } = setupActivation({ holdNavigation: 'new' });
  handler.activateNavigation();
  handler.navigateCursorRight(true);
  handler.deactivateNavigation();
  context.window.GsmJitenHighlight.getNavigationTokens = () => [];
  handler.activateNavigation();
  assert.equal(handler.currentCursorIndex, 4);
});

test('first-new selects the first unknown word again when the text changes', () => {
  const { handler, context } = setupActivation({ holdNavigation: 'new' });
  handler.activateNavigation();
  handler.navigateCursorRight(true);
  handler.deactivateNavigation();
  handler.textBlocks[0].chars[0].textContent = '虎';
  context.window.GsmJitenHighlight.getNavigationTokens = () => [
    { lineIndex: 0, text: '虎は犬を見る', start: 2, end: 3, states: ['new'] },
  ];
  handler.activateNavigation();
  assert.equal(handler.currentCursorIndex, 2);
});

test('first-new applies to a different block selected while navigation was inactive', () => {
  const { handler, context } = setupActivation({ holdNavigation: 'new' });
  handler.activateNavigation();
  handler.navigateCursorRight(true);
  handler.deactivateNavigation();
  handler.currentBlockIndex = 1;
  context.window.GsmJitenHighlight.getNavigationTokens = () => [
    { lineIndex: 1, text: '鳥も見る', start: 2, end: 4, states: ['new'] },
  ];
  handler.activateNavigation();
  assert.equal(handler.currentBlockIndex, 1);
  assert.equal(handler.currentCursorIndex, 2);
});

test('sentence holds skip closing quotes and punctuation, and respect line scope', () => {
  const { handler } = setup({ holdNavigation: 'sentence', horizontalWrap: 'block' });
  handler.characters = Array.from('「猫だ。」犬だ！鳥？', textContent => ({ textContent, isConnected: true }));
  handler.lines = [{ indices: handler.characters.map((_, i) => i) }];
  handler.currentCursorIndex = 1;
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 5);
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 8);
  handler.navigateCursorLeft(true);
  assert.equal(handler.currentCursorIndex, 5);
  handler.config.horizontalWrap = 'line';
  handler.lines = [{ indices: [0, 1, 2, 3, 4, 5, 6, 7] }, { indices: [8, 9] }];
  handler.navigateCursorRight(true);
  assert.equal(handler.currentCursorIndex, 1);
});

test('direct block navigation bypasses lines and nearest entry preserves the outgoing point', () => {
  const { handler } = setup({ verticalNavigation: 'blocks', initialPosition: 'nearest' });
  handler.findAdjacentLineUnit = () => assert.fail('should bypass individual lines');
  handler.getNavigationUnitCenter = () => ({ x: 120, y: 80 });
  handler.findClosestNavigableUnitToPoint = (x, y) => {
    assert.deepEqual([x, y], [120, 80]);
    return 2;
  };
  handler.navigateBlockDown();
  assert.equal(handler.currentBlockIndex, 1);
  assert.equal(handler.currentCursorIndex, 2);
});

test('spatial hopping uses screen geometry rather than DOM order; no candidate stays put', () => {
  const { handler } = setup({ verticalNavigation: 'spatial' });
  handler.textBlocks.push({ isConnected: true });
  handler.blockHasSelectableCharacters = () => true;
  handler.getBlockBoundingRect = block => [
    { left: 100, top: 100, width: 40, height: 20 },
    { left: 500, top: 150, width: 40, height: 20 },
    { left: 100, top: 180, width: 40, height: 20 },
  ][handler.textBlocks.indexOf(block)];
  assert.equal(handler.findDirectionalBlockIndex(1), 2);
  assert.equal(handler.findDirectionalBlockIndex(-1), 0);
});

test('late tokenizer results preserve an exact Jiten target even when word boundaries differ', () => {
  const { handler } = setup({ holdNavigation: 'new' });
  handler.navigateCursorRight(true);
  handler.tokenMode = true;
  handler.isNavigationActive = () => true;
  handler.getBlockText = () => '猫は犬を見る';
  handler.tokenCacheByBlock = new Map();
  handler.pendingTokenizationByBlock = new Map();
  handler.pendingTokenizationStartedWhileNavigationActive = new Map([[0, true]]);
  handler.updateModeIndicatorText = () => {};
  handler.syncSelectionFromVirtualMouse = () => false;
  handler.onTokensReceived({ blockIndex: 0, text: '猫は犬を見る', tokens: [
    { word: '猫は犬を見る', start: 0, end: 6 },
  ] });
  assert.equal(handler.currentCursorIndex, 4);
  assert.equal(handler.getCurrentAnchorCharIndex(), 4);
});

test('the D-pad sends an ordinary tap, a held jump after the delay, and stops on release', () => {
  const { handler, context } = setup({ holdNavigation: 'new', dpadRight: 15, repeatDelay: 400 });
  const timers = new Map();
  let sequence = 0;
  context.setTimeout = (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; };
  context.clearTimeout = id => timers.delete(id);
  handler.repeatTimers = new Map();
  handler.buttonStates = new Map([['pad', { 15: true }]]);
  handler.hideVirtualMouseCursorForDpadNavigation = () => {};
  handler.shouldProcessNavigation = () => true;
  handler.closeDictionaryPopups = () => {};
  handler.handleDPadNavigation(15, 'pad');
  assert.equal(handler.currentCursorIndex, 1);
  const [id, timer] = [...timers][0];
  assert.equal(timer.delay, 400);
  timers.delete(id);
  timer.callback();
  assert.equal(handler.currentCursorIndex, 4);
  assert.equal(timers.size, 1);
  handler.buttonStates.get('pad')[15] = false;
  handler.onButtonUp(15, 'pad');
  assert.equal(timers.size, 0);
  assert.equal(handler.repeatTimers.size, 0);
});

test('left-stick curve keeps gentle tilts precise and makes full tilt faster', () => {
  const { handler } = setup();
  const move = (tilt, curved) => {
    handler.config.analogAcceleration = curved;
    handler.virtualMouse = { x: 0, y: 0, initialized: true, lastUpdateTime: 0 };
    let distance;
    handler.setVirtualMousePosition = x => { distance = x; };
    handler.processLeftStickAsVirtualMouse({ left_x: tilt, left_y: 0 });
    return distance;
  };
  assert.ok(move(0.3, true) < move(0.3, false));
  assert.equal(move(1, true), 2 * move(1, false));
  assert.equal(move(0.1, true), undefined);
});
