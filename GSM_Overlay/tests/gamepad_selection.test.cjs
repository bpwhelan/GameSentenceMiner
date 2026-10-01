const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(blockSpecs, config = {}) {
  const context = vm.createContext({ module: { exports: {} }, window: {}, console: { log() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gamepad.js'), 'utf8'), context);
  const handler = Object.create(context.module.exports.prototype);
  const events = { confirmations: 0, dismissals: 0, positions: [], cursorChanges: [], blockChanges: [] };
  Object.assign(handler, {
    config: {
      horizontalWrap: 'adjacent', verticalNavigation: 'lines', holdNavigation: 'repeat', initialPosition: 'start',
      onCursorChange: event => events.cursorChanges.push(event),
      onBlockChange: event => events.blockChanges.push(event),
      ...config,
    },
    currentBlockIndex: 0, currentCursorIndex: 0, currentLineIndex: 0,
    tokenMode: false, lineNavPrefersCharacters: false, tokens: [],
    dismissLookupForNavigation: () => events.dismissals++,
    autoConfirmSelection: () => events.confirmations++,
    updateVisuals() {}, syncVirtualMouseToCurrentSelection() {},
    positionCursorAtCharacter: () => events.positions.push('character'),
    positionCursorAtToken: () => events.positions.push('token'),
  });
  handler.textBlocks = blockSpecs.map(lines => {
    const chars = lines.flatMap(({ text, y }, lineIndex) => Array.from(text, (textContent, column) => ({
      textContent, isConnected: true, dataset: { lineIndex: String(lineIndex) },
      getBoundingClientRect: () => ({ left: column * 20, top: y, width: 20, height: 20 }),
    })));
    return { isConnected: true, chars, textContent: chars.map(char => char.textContent).join(''), querySelectorAll: () => chars };
  });
  handler.refreshCharacters = () => {
    handler.characters = handler.textBlocks[handler.currentBlockIndex].chars;
    handler.buildLines();
  };
  handler.refreshCharacters();
  return { handler, events };
}

test('horizontal edges cross blocks even when source lines are visually reordered', () => {
  const { handler, events } = setup([
    [{ text: '猫', y: 40 }, { text: '犬', y: 0 }],
    [{ text: '鳥', y: 80 }],
  ], { verticalNavigation: 'spatial' });
  handler.navigateCursorLeft();
  assert.equal(handler.currentBlockIndex, 1);
  assert.equal(handler.currentCursorIndex, 0);
  assert.equal(events.confirmations, 1);
  assert.equal(events.dismissals, 1);
});

for (const direction of [-1, 1]) {
  test(`ordinary block transitions skip empty blocks in direction ${direction}`, () => {
    const { handler, events } = setup([
      [{ text: '猫', y: 0 }], [], [{ text: '鳥', y: 80 }], [],
    ]);
    if (direction < 0) handler.navigateBlockUp();
    else handler.navigateBlockDown();
    assert.equal(handler.currentBlockIndex, 2);
    assert.equal(handler.characters[handler.currentCursorIndex].textContent, '鳥');
    assert.equal(events.blockChanges.length, 1);
    assert.equal(events.confirmations, 1);
  });
}

test('wrapping a single navigable character does not repeat lookup or callbacks', () => {
  const { handler, events } = setup([[{ text: '猫。', y: 0 }]], { horizontalWrap: 'block' });
  handler.navigateCursorRight();
  handler.navigateCursorLeft();
  handler.navigateBlockUp();
  handler.navigateBlockDown();
  assert.equal(handler.currentCursorIndex, 0);
  assert.equal(events.confirmations, 0);
  assert.equal(events.dismissals, 0);
  assert.equal(events.cursorChanges.length, 0);
});

test('unsupported token text keeps character anchors, positioning, and callback data', () => {
  const { handler, events } = setup([[{ text: 'abcd', y: 0 }]], { horizontalWrap: 'block' });
  handler.tokenMode = true;
  handler.tokens = [{ word: 'abcd', start: 0, end: 4 }];
  handler.currentBlockSupportsTokenization = () => false;
  handler.lineNavPrefersCharacters = true;
  handler.currentCursorIndex = 1;
  handler.navigateCursorRight();
  assert.equal(handler.currentCursorIndex, 2);
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  assert.deepEqual(events.positions, ['character']);
  assert.equal(events.cursorChanges[0].isToken, false);
  assert.equal(events.cursorChanges[0].character.textContent, 'c');
});

test('vertical movement visits a line covered by a token anchored on the previous line', () => {
  const { handler, events } = setup([[
    { text: '猫犬', y: 0 }, { text: '鳥魚', y: 40 }, { text: '舟', y: 80 },
  ]]);
  handler.tokenMode = true;
  handler.tokens = [{ word: '猫犬鳥魚', start: 0, end: 4 }, { word: '舟', start: 4, end: 5 }];
  handler.currentBlockSupportsTokenization = () => true;
  handler.navigateBlockDown();
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  assert.equal(handler.currentLineIndex, 1);
  handler.navigateBlockDown();
  assert.equal(handler.getCurrentAnchorCharIndex(), 4);
  assert.equal(handler.currentLineIndex, 2);
  handler.navigateBlockUp();
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  assert.equal(handler.currentLineIndex, 1);
  assert.equal(events.confirmations, 3);
});

test('vertical wrapping reaches a continuation line even when one token spans the entire block', () => {
  const { handler } = setup([[{ text: '猫犬', y: 0 }, { text: '鳥魚', y: 40 }]]);
  handler.tokenMode = true;
  handler.tokens = [{ word: '猫犬鳥魚', start: 0, end: 4 }];
  handler.currentBlockSupportsTokenization = () => true;
  handler.navigateBlockUp();
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  assert.equal(handler.currentLineIndex, 1);
  handler.navigateBlockDown();
  assert.equal(handler.getCurrentAnchorCharIndex(), 0);
  assert.equal(handler.currentLineIndex, 0);
});

test('entering a block preserves a newly queued first-new position after dismissing the old lookup', () => {
  const { handler } = setup([[{ text: '猫', y: 0 }], [{ text: '鳥', y: 40 }]], {
    verticalNavigation: 'blocks', initialPosition: 'first-new',
  });
  handler.dismissLookupForNavigation = () => { handler.pendingJitenEntryPosition = null; };
  handler.applyPreferredEntryPosition = () => {
    handler.pendingJitenEntryPosition = { blockIndex: handler.currentBlockIndex, charIndex: 0 };
  };
  handler.navigateBlockDown();
  assert.equal(handler.pendingJitenEntryPosition?.blockIndex, 1);
});

test('analog selection callbacks report the active character override instead of the configured token mode', () => {
  const { handler, events } = setup([[{ text: '猫犬鳥魚', y: 0 }]]);
  handler.tokenMode = true;
  handler.tokens = [{ word: '猫犬鳥魚', start: 0, end: 4 }];
  handler.lineNavPrefersCharacters = true;
  handler.virtualMouse = { initialized: true, x: 30, y: 10 };
  handler.isNavigationActive = () => true;
  handler.ensureCurrentBlockConnected = () => true;
  handler.getBlockIndexForElement = () => 0;
  handler.getCharacterIndexFromPoint = () => 1;
  handler.getCurrentSelectionAnchorKey = () => '0:1';
  handler.syncSelectionFromVirtualMouse(handler.textBlocks[0]);
  assert.equal(events.cursorChanges[0].isToken, false);
  assert.equal(events.cursorChanges[0].character.textContent, '犬');
});

for (const lineIndex of [undefined, '', 'invalid']) {
  test(`line grouping retains every glyph when metadata is ${JSON.stringify(lineIndex)}`, () => {
    const { handler } = setup([[{ text: '猫犬', y: 0 }, { text: '鳥魚', y: 40 }]], { horizontalWrap: 'line' });
    handler.characters[2].dataset.lineIndex = lineIndex;
    handler.buildLines();
    assert.equal(handler.getLineIndexForCharIndex(2), 1);
    assert.equal(handler.lines.length, 2);
    handler.currentCursorIndex = 2;
    handler.navigateCursorLeft();
    assert.equal(handler.currentCursorIndex, 3);
  });
}

test('reapplying the configured token mode preserves an exact character override', () => {
  const { handler } = setup([[{ text: '猫犬鳥魚', y: 0 }]]);
  handler.tokenMode = true;
  handler.tokens = [{ word: '猫犬', start: 0, end: 2 }, { word: '鳥魚', start: 2, end: 4 }];
  handler.lineNavPrefersCharacters = true;
  handler.currentCursorIndex = 3;
  handler.prefetchTokenizationForAllBlocks = () => {};
  handler.setTokenMode(true);
  handler.setTokenMode(true);
  assert.equal(handler.currentCursorIndex, 3);
  assert.equal(handler.lineNavPrefersCharacters, true);
});

test('changing token mode clears character overrides and translates the anchor exactly once', () => {
  const { handler } = setup([[{ text: '猫犬鳥魚', y: 0 }]]);
  handler.tokens = [{ word: '猫犬', start: 0, end: 2 }, { word: '鳥魚', start: 2, end: 4 }];
  handler.lineNavPrefersCharacters = true;
  handler.currentCursorIndex = 3;
  handler.prefetchTokenizationForAllBlocks = () => {};
  handler.setTokenMode(true);
  assert.equal(handler.currentCursorIndex, 1);
  assert.equal(handler.lineNavPrefersCharacters, false);
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
  handler.setTokenMode(false);
  assert.equal(handler.currentCursorIndex, 2);
  assert.equal(handler.getCurrentAnchorCharIndex(), 2);
});

test('enabling token mode on unsupported text preserves its character cursor', () => {
  const { handler } = setup([[{ text: 'abcd', y: 0 }]]);
  handler.tokens = [{ word: 'abcd', start: 0, end: 4 }];
  handler.currentBlockSupportsTokenization = () => false;
  handler.currentCursorIndex = 3;
  handler.prefetchTokenizationForAllBlocks = () => {};
  handler.setTokenMode(true);
  assert.equal(handler.currentCursorIndex, 3);
  assert.equal(handler.getCurrentAnchorCharIndex(), 3);
});
