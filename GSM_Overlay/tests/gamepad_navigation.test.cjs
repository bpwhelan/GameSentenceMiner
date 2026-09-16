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
