const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GuideLibrary } = require('../vn_guide_library');
const { createVnGuideController } = require('../vn_guide_controller');

const url = 'https://kanjieater.github.io/VN-Guide/test-game/';
const manifest = { title: 'Test Game', guide_target: { label: 'Original PC version' }, routes: [{ id: 'one', title: 'Route One', reviewed: true }, { id: 'two', title: 'Route Two', reviewed: false }] };
const route = ['大丈夫', 'セーブ1', '進む', 'セーブ1にロード'].map(simpleJp => ({ simpleJp }));
const line = (text, y) => ({ text, bounding_rect: { x1: .4, x3: .6, y1: y, y3: y + .03 } });
const menu = { type: 'word_coordinates', is_final: true, data: [line('大丈夫', .3), line('やめよう', .43)] };
const nextMenu = { ...menu, data: [line('進む', .3), line('戻る', .43)] };
const dialogue = { type: 'word_coordinates', is_final: true, data: [line('新しい会話', .8)] };
function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], updates = [];
  const library = new GuideLibrary(directory, { fetchJson: async source => { requests.push(source); return source.endsWith('/guide.json') ? manifest : route; }, ...overrides });
  let time = 1000;
  const hud = { update: state => updates.push(state), dispose() { this.disposed = true; }, syncBounds() {} };
  const controller = createVnGuideController({ library, hud, now: () => time });
  const settings = { vnGuideEnabled: true, vnGuideUrl: url, vnGuideMode: 'auto', vnGuideAutoAdvance: true };
  return { controller, library, directory, requests, updates, settings, hud, advance: milliseconds => { time += milliseconds; } };
}

test('disabled guides never fetch; cached routes and progress survive restart offline', async t => {
  const { controller, library, directory, requests, settings } = setup(t);
  await controller.configure({ ...settings, vnGuideEnabled: false });
  assert.equal(requests.length, 0);
  await controller.configure(settings);
  controller.command('next');
  assert.equal(requests.length, 2);
  const offline = new GuideLibrary(directory, { fetchJson: async () => { throw new Error('Offline'); } });
  const restored = await offline.load(url);
  assert.equal(restored.index, 2);
  assert.equal(restored.guide.target, 'Original PC version');
  await controller.configure({ ...settings, vnGuideMode: 'always' });
  assert.equal(requests.length, 2);
  assert.equal(controller.snapshot().index, 2);
  assert.equal(library.progress['test-game/one'].index, 2);
  const resumed = createVnGuideController({ library: offline, hud: { update() {} } });
  await resumed.configure(settings);
  assert.deepEqual(resumed.snapshot().saveInstructions, ['セーブ1']);
});

test('a brief save notice becomes a save reminder alongside the detected choice, then clears on advance', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.observe(menu);
  assert.equal(controller.snapshot().visible, true);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().kind, 'choice');
  assert.equal(controller.snapshot().text, '進む');
  assert.equal(controller.snapshot().startIndex, 1);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  assert.equal(controller.snapshot().saveNotice, true);
  assert.equal(controller.snapshot().tentative, true);
  assert.equal(controller.snapshot().visible, true);
  advance(8001);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().saveNotice, false);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().kind, 'load');
  assert.deepEqual(controller.snapshot().saveInstructions, []);
  assert.equal(controller.snapshot().visible, true);
  advance(60000);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, true);
  controller.command('next');
  assert.equal(controller.snapshot().complete, true);
  controller.command('back');
  assert.equal(controller.snapshot().index, 3);
  controller.command('back');
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  controller.command('back');
  assert.equal(controller.snapshot().index, 0);
  controller.command('jump', 0);
  assert.equal(controller.snapshot().text, '大丈夫');
});

test('hotkey mode never auto-reveals save/load; always mode reveals until toggled', async t => {
  const { controller, settings } = setup(t);
  await controller.configure({ ...settings, vnGuideMode: 'hotkey' });
  controller.setAvailable(true);
  controller.command('jump', 1);
  assert.equal(controller.snapshot().visible, false);
  assert.equal(controller.snapshot().saveNotice, false);
  controller.command('toggle');
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().saveNotice, false);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  controller.command('next');
  assert.equal(controller.snapshot().visible, true);
  controller.command('toggle');
  assert.equal(controller.snapshot().visible, false);
  await controller.configure({ ...settings, vnGuideMode: 'always' });
  controller.command('back');
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().saveNotice, false);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('the first save notice waits for capture and closing it cannot dismiss the later choice reminder', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure({ ...settings, vnGuideUrl: `${url}#route=one&step=1` });
  advance(60000);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().saveNotice, true);
  controller.command('hide');
  assert.equal(controller.snapshot().visible, false);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().saveNotice, false);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('a detected choice replaces the notice immediately and invalidation never brings the notice back', async t => {
  const { controller, settings } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.command('next');
  controller.observe({ ...nextMenu, presence_id: 'choice' });
  assert.equal(controller.snapshot().saveNotice, false);
  controller.observe({ type: 'ocr_text_invalidated', presence_id: 'choice' });
  assert.equal(controller.snapshot().visible, false);
  assert.equal(controller.snapshot().saveNotice, false);
  controller.command('toggle');
  assert.equal(controller.snapshot().visible, true);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('manual-only progression retains the save reminder until the choice is advanced', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure({ ...settings, vnGuideAutoAdvance: false });
  controller.setAvailable(true);
  controller.command('next');
  controller.observe(nextMenu);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 2);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  controller.command('next');
  assert.equal(controller.snapshot().index, 3);
  assert.deepEqual(controller.snapshot().saveInstructions, []);
  controller.command('back');
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('capture loss or game switch disarms detection, hides the HUD, and cannot advance later', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true, 'Game A');
  controller.observe(menu);
  controller.setAvailable(false);
  assert.equal(controller.snapshot().visible, false);
  advance(2000);
  controller.observe(dialogue);
  controller.setAvailable(true);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 0);
  controller.observe(menu);
  controller.observe({ type: 'window_state', game: 'Game B' });
  advance(2000);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 0);
});

test('hotkey visibility, including an explicit hide, survives temporary capture interruptions', async t => {
  const { controller, settings } = setup(t);
  await controller.configure({ ...settings, vnGuideMode: 'hotkey' });
  controller.setAvailable(true, 'Game A');
  controller.command('jump', 1);
  controller.command('toggle');
  for (let cycle = 0; cycle < 3; cycle += 1) {
    controller.setAvailable(false);
    assert.equal(controller.snapshot().visible, false);
    controller.setAvailable(true);
    assert.equal(controller.snapshot().visible, true);
    assert.equal(controller.snapshot().index, 2);
    assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  }
  await controller.configure({ ...settings, vnGuideMode: 'always' });
  controller.command('toggle');
  controller.setAvailable(false);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.command('toggle');
  controller.command('hide');
  controller.setAvailable(false);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
});

test('a detected choice returns after capture resumes without using old evidence to advance', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true, 'Game A');
  controller.command('jump', 1);
  controller.observe(nextMenu);
  controller.setAvailable(false);
  advance(30000);
  controller.setAvailable(false);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().rememberedChoice, true);
  assert.equal(controller.snapshot().detected, false);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  controller.observe({ ...dialogue, supplemental: true });
  assert.equal(controller.snapshot().visible, true);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 2);
  assert.equal(controller.snapshot().visible, false);
  controller.observe(nextMenu);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 3);
});

test('backend revalidation can restore a choice after a hide without a second full OCR result', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  const frame = { ...menu, presence_id: 'choice' };
  controller.observe(frame);
  controller.setAvailable(false);
  advance(10000);
  controller.setAvailable(true);
  controller.observe({ type: 'ocr_text_revalidated', presence_id: 'choice', payload: frame });
  assert.equal(controller.snapshot().detected, true);
  assert.equal(controller.snapshot().rememberedChoice, false);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 2);
});

test('unavailable time does not consume a save notice and game changes discard remembered hints', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true, 'Game A');
  controller.command('next');
  advance(3000);
  controller.setAvailable(false);
  advance(30000);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().saveNotice, true);
  advance(4999);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, true);
  advance(2);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.observe(nextMenu);
  controller.setAvailable(false);
  controller.setAvailable(true, 'Game B');
  assert.equal(controller.snapshot().visible, false);
  assert.equal(controller.snapshot().rememberedChoice, false);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 2);
});

test('manual advancement and imported URL positions are saved per route', async t => {
  const { controller, settings } = setup(t);
  await controller.configure({ ...settings, vnGuideUrl: `${url}#view=guide&route=one&step=2` });
  assert.equal(controller.snapshot().index, 2);
  controller.command('next');
  await controller.configure({ ...settings, vnGuideRoute: 'two' });
  assert.equal(controller.snapshot().index, 0);
  controller.command('next');
  await controller.configure(settings);
  assert.equal(controller.snapshot().index, 3);
  await controller.configure({ ...settings, vnGuideRoute: 'two' });
  assert.equal(controller.snapshot().index, 2);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('choosing a different route does not reuse the URL step from the original route', async t => {
  const { library } = setup(t);
  const loaded = await library.load(`${url}#route=one&step=3`, 'two');
  assert.equal(loaded.index, 0);
});

test('tentative next choices without saves still appear briefly', async t => {
  const { controller, settings, advance } = setup(t, { fetchJson: async source => source.endsWith('/guide.json') ? manifest : [{ simpleJp: '大丈夫' }, { simpleJp: '進む' }] });
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe(menu);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().visible, true);
  advance(6001);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.command('back');
  assert.equal(controller.snapshot().index, 0);
});

test('guide refresh detects changed content and avoids resuming at a different instruction', async t => {
  let steps = route;
  const { controller, settings } = setup(t, { fetchJson: async source => source.endsWith('/guide.json') ? manifest : steps });
  await controller.configure(settings);
  controller.command('next');
  steps = [{ simpleJp: '追加された選択肢' }, ...route];
  await controller.command('refresh');
  assert.equal(controller.snapshot().index, 0);
  assert.equal(controller.snapshot().changed, true);
  controller.command('jump', 2);
  assert.equal(controller.snapshot().changed, false);
});

test('failed explicit refresh keeps the imported route usable', async t => {
  let offline = false;
  const { controller, settings } = setup(t, { fetchJson: async source => {
    if (offline) throw new Error('Offline');
    return source.endsWith('/guide.json') ? manifest : route;
  } });
  await controller.configure(settings);
  controller.command('next');
  offline = true;
  await controller.command('refresh');
  assert.equal(controller.snapshot().error, 'Offline');
  assert.equal(controller.snapshot().index, 2);
  assert.equal(controller.snapshot().kind, 'choice');
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('late downloads cannot revive a disabled or disposed helper', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { controller, settings, hud } = setup(t, { fetchJson: async source => source.endsWith('/guide.json') ? pending : route });
  const loading = controller.configure(settings);
  await controller.configure({ ...settings, vnGuideEnabled: false });
  resolve(manifest);
  await loading;
  assert.equal(controller.snapshot().enabled, false);
  assert.equal(controller.snapshot().total, 0);
  controller.dispose();
  assert.equal(hud.disposed, true);
  controller.command('next');
  assert.equal(controller.snapshot().visible, false);
});

test('concurrent imports share requests and malformed routes are never cached', async t => {
  const { library, requests } = setup(t);
  await Promise.all([library.load(url), library.load(url)]);
  assert.equal(requests.length, 2);
  library.fetchJson = async () => [{ broken: true }];
  await assert.rejects(library.get('invalid-test-route', require('../vn_guide').validateRoute));
  assert.equal(library.cache['invalid-test-route'], undefined);
});

test('catch-up shows the detected choice and its save reminder, persists, and Back restores the original position', async t => {
  const { controller, settings, library, directory, advance } = setup(t, {
    fetchJson: async source => source.endsWith('/guide.json') ? manifest
      : ['大丈夫', '待つ', 'セーブ1', '進む', 'セーブ1にロード'].map(simpleJp => ({ simpleJp })),
  });
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().index, 3);
  assert.equal(controller.snapshot().detected, true);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().tentative, true);
  assert.equal(controller.snapshot().recoveredFrom, 0);
  assert.equal(controller.snapshot().saveNotice, false, 'an already detected choice must show its save reminder immediately');
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  assert.equal(library.progress['test-game/one'].index, 3);
  const offline = new GuideLibrary(directory, { fetchJson: async () => { throw new Error('Offline'); } });
  assert.equal((await offline.load(url)).index, 3);
  controller.setAvailable(false);
  advance(10000);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().recoveredFrom, 0);
  controller.command('back');
  assert.equal(controller.snapshot().index, 0);
  assert.equal(controller.snapshot().recoveredFrom, null);
  assert.equal(library.progress['test-game/one'].index, 0);
});

test('manual-only progression disables catch-up and a capture interruption needs a fresh menu to recover', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure({ ...settings, vnGuideAutoAdvance: false });
  controller.setAvailable(true);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().index, 0);
  await controller.configure(settings);
  controller.observe(menu);
  controller.setAvailable(false);
  advance(1500);
  controller.observe(nextMenu);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().index, 0);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().index, 2);
});
