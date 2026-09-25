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
  function addLevel() {
    const popup = document.createElement('div');
    popup.innerHTML = '<button class="audio">Audio</button><div class="actions"><button data-action="add" disabled>Mine</button></div>';
    root.append(popup);
    const audio = popup.querySelector('.audio'), mine = popup.querySelector('[data-action="add"]');
    for (const [index, button] of [audio, mine].entries()) {
      button.getClientRects = () => button.closest('[hidden]') ? [] : [{ left: index * 30, top: 0 }];
      button.getBoundingClientRect = () => ({ left: index * 30, top: 0 });
    }
    const level = { popup, lookupToken: 1, view: { currentEntryIndex: () => 0, scrollElement: popup },
      entryAudio: [{ button: audio }], entryMining: [{ actions: popup.querySelector('.actions') }] };
    levels.push(level);
    return { level, audio, mine };
  }
  const first = addLevel();
  const navigation = create({ state: () => ({ levels }) }, { window, document });
  navigation.refresh();
  navigation.control('reset-action-selection');
  t.after(() => { navigation.destroy(); window.close(); });
  return { ...first, navigation, addLevel, selected: () => root.querySelector('.gsm-controller-selected') };
}

for (const audioState of ['playing', 'no-result']) {
  test(`mining readiness updates the default while audio is ${audioState}, without another popup event`, async t => {
    const h = setup(t);
    h.audio.setAttribute('aria-busy', String(audioState === 'playing'));
    h.audio.dataset.state = audioState === 'playing' ? 'playing' : 'error';
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
