const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PopupNavigation } = require('../popup_navigation.js');
const { currentResult } = require('../integrations/hachidori/popup.js');

function setup() {
  const button = name => ({ name, isConnected: true, disabled: false, clicks: 0,
    classList: { add() {}, remove() {} }, click() { this.clicks++; } });
  const audio = button('audio'), mine = button('mine'), good = button('good');
  let buttons = [audio], index = 0;
  const controller = new PopupNavigation({
    revision: () => index, entryIndex: () => index,
    moveEntry: offset => { index += offset; }, firstEntry: () => { index = 0; },
    buttons: scope => scope === 'grading' ? [good] : buttons,
    isAvailable: button => button.isConnected && !button.disabled,
    preferred: buttons => buttons.find(button => button.name === 'mine') || buttons[0],
  });
  return { controller, audio, mine, good, setButtons: value => { buttons = value; } };
}

test('delayed mining availability replaces a provisional default without overriding deliberate selection', () => {
  const h = setup();
  h.controller.control('reset-action-selection');
  assert.equal(h.controller.selected, h.audio);
  h.setButtons([h.audio, h.mine]);
  h.controller.refresh();
  assert.equal(h.controller.selected, h.mine);
  h.controller.control('select-action', { direction: -1 });
  h.controller.refresh();
  assert.equal(h.controller.selected, h.audio);
});

test('confirm on a disabled selected action does not invoke a different action', () => {
  const h = setup(); h.setButtons([h.audio, h.mine]);
  h.controller.control('reset-action-selection');
  h.mine.disabled = true;
  assert.equal(h.controller.control('confirm-action'), false);
  assert.equal(h.audio.clicks, 0);
  assert.equal(h.mine.clicks, 0);
});

test('moving above entry zero selects grading; moving down returns to entry zero', () => {
  const h = setup(); h.setButtons([h.audio, h.mine]);
  h.controller.control('previous-entry');
  assert.equal(h.controller.selected, h.good);
  h.controller.control('confirm-action');
  assert.equal(h.good.clicks, 1);
  h.controller.control('next-entry');
  assert.equal(h.controller.selected, h.mine);
  h.controller.destroy();
  assert.equal(h.controller.selected, null);
});

test('Hachidori selection follows rendered dictionary tabs rather than unfiltered lookup indices', () => {
  const first = { term: { expression: '猫' } }, second = { term: { expression: '犬' } };
  assert.equal(currentResult({ view: { currentEntryIndex: () => 0 },
    activeTermRender: { results: [first, second] }, entryAudio: [{ result: second }] }), second);
});
