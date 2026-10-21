const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuickActions, normalizeActions, DEFAULT_ACTIONS } = require('../quick_actions');

function setup(options = {}) {
  const calls = [];
  const panel = new QuickActions({
    runAction: async action => { calls.push(action); return { paused: action === 'toggle-intake', canReplay: true }; },
    explain: options => calls.push(options), translate: () => calls.push('translation'),
    toggleFurigana: () => calls.push('furigana'), ...options,
  });
  return { panel, calls };
}

test('saved shortcuts preserve order, remove invalid/duplicate entries, and allow an empty panel', () => {
  assert.deepEqual(normalizeActions(['grammar', 'pause-input', 'grammar', 'mute', null]), ['grammar', 'pause-input']);
  assert.deepEqual(normalizeActions([]), []);
  assert.deepEqual(normalizeActions(null), DEFAULT_ACTIONS);
});

test('grid navigation wraps predictably, including an incomplete final row', async () => {
  const { panel } = setup();
  await panel.open();
  assert.equal(panel.selected, 0);
  panel.navigate('Right'); assert.equal(panel.selected, 1);
  panel.navigate('Down'); assert.equal(panel.selected, 3);
  panel.navigate('Right'); assert.equal(panel.selected, 2);
  panel.navigate('Down'); assert.equal(panel.selected, 0);
  panel.view = 'translate'; panel.selected = 6;
  panel.navigate('Right'); assert.equal(panel.selected, 6);
  panel.navigate('Up'); assert.equal(panel.selected, 4);
  panel.navigate('Down'); assert.equal(panel.selected, 6);
});

test('intake state comes from the backend and duplicate confirms cannot toggle twice', async () => {
  let finish;
  const { panel, calls } = setup();
  await panel.open();
  panel.runAction = action => { calls.push(action); return new Promise(resolve => { finish = resolve; }); };
  const first = panel.confirm();
  await panel.confirm();
  assert.deepEqual(calls, ['state', 'toggle-intake']);
  assert.equal(panel.paused, false);
  finish({ paused: true, canReplay: true }); await first;
  assert.equal(panel.items()[0].label, 'Resume text input');
  panel.close();
  assert.equal(panel.paused, true);
});

test('translation menu exposes all Text Feed modes and a saved controller-friendly custom question', async () => {
  const { panel, calls } = setup();
  await panel.open(); panel.selected = 3; await panel.confirm();
  assert.equal(panel.view, 'translate');
  assert.deepEqual(panel.items().map(item => item.id), ['translation', 'sentence', 'grammar', 'vocabulary', 'nuance', 'context', 'custom']);
  panel.configure({ question: 'Why is this particle used?' });
  panel.selected = 6; await panel.confirm();
  assert.deepEqual(calls.at(-1), { mode: 'custom', question: 'Why is this particle used?' });
  panel.showResult('An explanation'); panel.back();
  assert.equal(panel.view, 'translate'); panel.back();
  assert.equal(panel.view, 'actions'); panel.back(); assert.equal(panel.isOpen, false);
});

test('failure stays visible and closing cancels a pending analysis display', async () => {
  const { panel } = setup({ runAction: async () => { throw new Error('Backend disconnected'); } });
  await panel.open(); assert.match(panel.status, /Backend disconnected/);
  panel.view = 'translate'; panel.selected = 1; await panel.confirm();
  panel.close(); panel.showResult('Late response'); assert.equal(panel.isOpen, false);
});
