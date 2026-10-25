const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { PopupNavigation } = require('../popup_navigation.js');
const { create } = require('../integrations/hachidori/popup.js');

function setup(t) {
  const dom = new JSDOM('<hachidori-host></hachidori-host>');
  const { window } = dom, { document } = window;
  window.GsmPopupNavigation = PopupNavigation;
  const root = document.querySelector('hachidori-host').attachShadow({ mode: 'open' });
  const levels = [];
  const reads = { bounds: 0, visibility: 0, entry: 0 };
  function addLevel() {
    const popup = document.createElement('div');
    popup.innerHTML = '<button class="audio">Audio</button><div class="actions"><button data-action="add" disabled>Mine</button></div>';
    root.append(popup);
    const audio = popup.querySelector('.audio'), mine = popup.querySelector('[data-action="add"]');
    for (const [index, button] of [audio, mine].entries()) {
      button.getClientRects = () => { reads.visibility++; return button.closest('[hidden]') ? [] : [{ left: index * 30, top: 0 }]; };
      button.getBoundingClientRect = () => { reads.bounds++; return { left: index * 30, top: 0 }; };
    }
    const level = { popup, lookupToken: 1, view: { currentEntryIndex: () => { reads.entry++; return 0; }, scrollElement: popup },
      entryAudio: [{ button: audio }], entryMining: [{ actions: popup.querySelector('.actions') }] };
    levels.push(level);
    return { level, audio, mine };
  }
  const first = addLevel();
  const navigation = create({ state: () => ({ levels }) }, { window, document });
  navigation.refresh();
  navigation.control('reset-action-selection');
  t.after(() => { navigation.destroy(); window.close(); });
  return { ...first, navigation, addLevel, reads, document,
    resetReads: () => { reads.bounds = reads.visibility = reads.entry = 0; },
    selected: () => root.querySelector('.gsm-controller-selected') };
}

test('definition rendering does not remeasure controller actions or rescan entries', async t => {
  const h = setup(t);
  const definitions = h.document.createElement('div');
  h.level.popup.append(definitions);
  await Promise.resolve();
  h.resetReads();
  // Dictionary glossaries fill asynchronously, including expandable/hidden content.
  for (let i = 0; i < 4; i++) {
    definitions.innerHTML = '<div hidden><button disabled>Dictionary content</button></div>';
    definitions.firstChild.hidden = false;
    await Promise.resolve();
  }
  assert.deepEqual(h.reads, { bounds: 0, visibility: 0, entry: 0 });
  assert.equal(h.selected(), h.audio);
});

test('default action readiness does not sort button geometry; explicit navigation does', async t => {
  const h = setup(t);
  await Promise.resolve();
  h.resetReads();
  h.mine.disabled = false;
  await Promise.resolve();
  assert.equal(h.selected(), h.mine);
  assert.equal(h.reads.bounds, 0);
  h.navigation.control('select-action', { direction: -1 });
  assert.equal(h.selected(), h.audio);
  assert.equal(h.reads.bounds, 2, 'Read each available button position once when ordering actions');
});

test('revealing an action ancestor still refreshes controller readiness', async t => {
  const h = setup(t);
  h.mine.parentElement.hidden = true;
  h.mine.disabled = false;
  await Promise.resolve();
  assert.equal(h.selected(), h.audio);
  h.mine.parentElement.hidden = false;
  await Promise.resolve();
  assert.equal(h.selected(), h.mine);
});

for (const audioState of ['playing', 'no-result', 'error']) {
  test(`mining readiness updates the default while audio is ${audioState}, without another popup event`, async t => {
    const h = setup(t);
    h.audio.setAttribute('aria-busy', String(audioState === 'playing'));
    // Missing audio is idle in 0.3.0; older releases retain an error state.
    if (audioState !== 'no-result') h.audio.dataset.state = audioState;
    assert.equal(h.selected(), h.audio);
    h.mine.disabled = false;
    await Promise.resolve();
    assert.equal(h.selected(), h.mine);
  });
}

test('mining readiness replaces an audio default that has become hidden', async t => {
  const h = setup(t);
  h.audio.hidden = true;
  h.mine.disabled = false;
  await Promise.resolve();
  assert.equal(h.selected(), h.mine);
});

test('readiness changes preserve a deliberate audio selection and a busy confirmed mining action', async t => {
  const h = setup(t);
  h.mine.disabled = false;
  h.navigation.refresh();
  h.navigation.control('select-action', { direction: -1 });
  assert.equal(h.selected(), h.audio);
  h.mine.disabled = true;
  await Promise.resolve();
  h.mine.disabled = false;
  await Promise.resolve();
  assert.equal(h.selected(), h.audio);

  let mined = 0, played = 0;
  h.mine.addEventListener('click', () => { mined++; h.mine.disabled = true; });
  h.audio.addEventListener('click', () => { played++; });
  h.navigation.control('reset-action-selection');
  assert.equal(h.navigation.control('confirm-action'), true);
  await Promise.resolve();
  assert.equal(h.selected(), h.mine);
  assert.equal(h.navigation.control('confirm-action'), false);
  assert.equal(mined, 1);
  assert.equal(played, 0);
});

test('readiness tracking follows nested popups and their restored parent, then stops on destroy', async t => {
  const h = setup(t);
  const child = h.addLevel();
  h.navigation.refresh();
  child.mine.disabled = false;
  await Promise.resolve();
  assert.equal(h.selected(), child.mine);
  child.level.retired = true;
  child.level.popup.remove();
  h.navigation.refresh();
  h.mine.disabled = false;
  await Promise.resolve();
  assert.equal(h.selected(), h.mine);
  h.navigation.destroy();
  h.mine.disabled = true;
  await Promise.resolve();
  assert.equal(h.selected(), null);
});
