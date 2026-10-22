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
function setup(t, overrides = {}, controllerOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [], updates = [];
  const library = new GuideLibrary(directory, { fetchJson: async source => { requests.push(source); return source.endsWith('/guide.json') ? manifest : route; }, ...overrides });
  let time = 1000;
  const hud = { update: state => updates.push(state), dispose() { this.disposed = true; }, syncBounds() {} };
  const controller = createVnGuideController({ library, hud, now: () => time, ...controllerOptions });
  const settings = { vnGuideEnabled: true, vnGuideUrl: url, vnGuideMode: 'auto', vnGuideAutoAdvance: true };
  return { controller, library, directory, requests, updates, settings, hud, advance: milliseconds => { time += milliseconds; } };
}

test('completion waits for Next, then continues in guide order and stops at the last route', async t => {
  const selections = [];
  const { controller, settings, library } = setup(t, {}, { onRouteChange: id => selections.push(id) });
  await controller.configure(settings);
  assert.equal(controller.snapshot().nextRoute, null);
  controller.command('jump', 3);
  controller.command('next');
  assert.equal(controller.snapshot().complete, true);
  assert.equal(controller.snapshot().routeId, 'one');
  assert.deepEqual(controller.snapshot().nextRoute, manifest.routes[1]);
  assert.deepEqual(selections, []);
  await controller.command('next');
  assert.equal(controller.snapshot().routeId, 'two');
  assert.equal(controller.snapshot().index, 0);
  assert.equal(controller.snapshot().complete, false);
  assert.equal(library.progress['test-game/one'].index, 4);
  assert.deepEqual(selections, ['two']);
  await controller.configure({ ...settings, vnGuideRoute: selections[0] });
  assert.equal(controller.snapshot().routeId, 'two');
  controller.command('jump', 4);
  assert.equal(controller.snapshot().nextRoute, null);
  await controller.command('next');
  assert.equal(controller.snapshot().routeId, 'two');
  assert.equal(controller.snapshot().complete, true);
  assert.deepEqual(selections, ['two']);
});

test('continuing resumes the next route and keeps the finished route complete after reopening', async t => {
  const { controller, settings, directory } = setup(t);
  await controller.configure({ ...settings, vnGuideRoute: 'two' });
  controller.command('next');
  await controller.configure(settings);
  controller.command('jump', 4);
  await controller.command('next');
  assert.equal(controller.snapshot().routeId, 'two');
  assert.equal(controller.snapshot().index, 2);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  const offline = new GuideLibrary(directory, { fetchJson: async () => { throw new Error('Offline'); } });
  assert.equal((await offline.load(url, 'one')).index, 4);
  assert.equal((await offline.load(url, 'two')).index, 2);
});

test('a failed continuation keeps the completion screen and can be retried', async t => {
  let offline = true;
  const selections = [];
  const { controller, settings } = setup(t, { fetchJson: async source => {
    if (source.endsWith('/route_two.json') && offline) throw new Error('Offline');
    return source.endsWith('/guide.json') ? manifest : route;
  } }, { onRouteChange: id => selections.push(id) });
  await controller.configure(settings);
  controller.command('jump', 4);
  await controller.command('next');
  assert.equal(controller.snapshot().routeId, 'one');
  assert.equal(controller.snapshot().complete, true);
  assert.equal(controller.snapshot().nextRoute.id, 'two');
  assert.match(controller.snapshot().error, /Offline/);
  assert.deepEqual(selections, []);
  offline = false;
  await controller.command('next');
  assert.equal(controller.snapshot().routeId, 'two');
  assert.equal(controller.snapshot().error, '');
  assert.deepEqual(selections, ['two']);
});

test('repeated Next during continuation cannot skip steps, and disabling cancels a late route load', async t => {
  for (const disable of [false, true]) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const selections = [];
    const { controller, settings, requests } = setup(t, { fetchJson: async source => {
      requests.push(source);
      if (source.endsWith('/route_two.json')) return pending;
      return source.endsWith('/guide.json') ? manifest : route;
    } }, { onRouteChange: id => selections.push(id) });
    await controller.configure(settings);
    controller.command('jump', 4);
    const continuation = controller.command('next');
    assert.equal(controller.snapshot().loading, true);
    controller.command('next');
    await new Promise(resolve => setImmediate(resolve));
    if (disable) await controller.configure({ ...settings, vnGuideEnabled: false });
    finish(route);
    await continuation;
    assert.equal(requests.filter(source => source.endsWith('/route_two.json')).length, 1);
    assert.equal(controller.snapshot().loading, false);
    assert.deepEqual(selections, disable ? [] : ['two']);
    assert.equal(controller.snapshot().routeId, disable ? '' : 'two');
    assert.equal(controller.snapshot().index, 0);
  }
});

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

test('punctuation-insensitive choices show the original guide text and retain alternatives until the menu disappears', async t => {
  const guideText = '意識が―もう――';
  const { controller, settings, advance } = setup(t, {
    fetchJson: async source => source.endsWith('/guide.json') ? manifest
      : [guideText, '進む'].map(simpleJp => ({ simpleJp })),
  });
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe({ ...menu, line_id: 'choice', data: [line('意識が──もう──', .3), line('忘れたくない！', .43)] });
  assert.equal(controller.snapshot().detected, true);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().text, guideText);
  advance(1500);
  controller.observe({ ...menu, line_id: 'rescan', data: [line('忘れたくない…', .43)] });
  assert.equal(controller.snapshot().index, 0, 'an alternative with different punctuation still belongs to the current menu');
  controller.observe({ ...dialogue, line_id: 'dialogue' });
  assert.equal(controller.snapshot().index, 1);
});

test('choice confirmations keep upcoming save reminders for their detected menu', async t => {
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
  assert.equal(controller.snapshot().saveNotice, false);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  assert.equal(controller.snapshot().tentative, true);
  assert.equal(controller.snapshot().visible, true);
  advance(8001);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().saveNotice, false);
  assert.equal(controller.snapshot().loggedChoice, null);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().kind, 'load');
  assert.deepEqual(controller.snapshot().saveInstructions, []);
  assert.equal(controller.snapshot().visible, true);
  advance(60000);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.command('next');
  assert.equal(controller.snapshot().index, 3, 'Right reveals the pending load without confirming it');
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

test('hiding a choice only dismisses that choice and the next detected choice reopens the card', async t => {
  for (const action of ['toggle', 'hide']) {
    const { controller, settings, advance } = setup(t);
    await controller.configure(settings);
    controller.setAvailable(true);
    controller.observe(menu);
    controller.command(action);
    assert.equal(controller.snapshot().visible, false);
    controller.observe(menu);
    controller.observe({ type: 'ocr_text_invalidated' });
    controller.observe(menu);
    assert.equal(controller.snapshot().visible, false, 'rescanning the dismissed menu must not reopen it');
    advance(1500);
    controller.observe(dialogue);
    controller.observe(nextMenu);
    assert.equal(controller.snapshot().index, 2);
    assert.equal(controller.snapshot().visible, true, `${action} must not suppress the next choice`);
  }
});

test('hiding a preview before detection does not suppress the upcoming choice', async t => {
  for (const action of ['toggle', 'hide']) {
    const { controller, settings } = setup(t);
    await controller.configure(settings);
    controller.setAvailable(true);
    controller.command('toggle');
    controller.command(action);
    assert.equal(controller.snapshot().visible, false);
    controller.observe(menu);
    assert.equal(controller.snapshot().visible, true);
  }
});

test('hotkey previews hide after two fresh lines, ignoring duplicate, stale and supplemental OCR', async t => {
  for (const mode of ['auto', 'hotkey']) {
    const { controller, settings, updates } = setup(t);
    await controller.configure({ ...settings, vnGuideMode: mode });
    controller.setAvailable(true);
    controller.observe({ ...dialogue, line_id: 'initial', presence_id: 'initial' });
    controller.command('toggle');
    controller.observe({ ...dialogue, line_id: 'initial', presence_id: 'rescan' });
    controller.observe({ ...dialogue, is_final: false, data: [line('処理中', .8)] });
    controller.observe({ ...dialogue, supplemental: true, data: [line('追加の文字', .8)] });
    controller.observe({ type: 'overlay_clear' });
    controller.observe({ type: 'ocr_text_invalidated', presence_id: 'initial' });
    controller.observe({ type: 'ocr_text_revalidated', presence_id: 'initial', payload: { ...dialogue, presence_id: 'initial' } });
    assert.equal(controller.snapshot().visible, true);
    const first = { ...dialogue, line_id: 'first', data: [line('一つ目の会話', .8)] };
    controller.observe(first);
    controller.observe({ ...first, data: [line('一つ目の会話。', .8)] });
    assert.equal(controller.snapshot().visible, true, 'a revision of the same line is not another advance');
    controller.observe({ ...dialogue, line_id: 'second', data: [line('二つ目の会話', .8)] });
    assert.equal(controller.snapshot().visible, false);
    assert.equal(updates.at(-1).visible, false, 'the HUD must receive the automatic hide');
    assert.equal(controller.snapshot().index, 0, 'hiding must not advance the guide');
    controller.observe(menu);
    assert.equal(controller.snapshot().visible, mode === 'auto');
    controller.command('toggle');
    assert.equal(controller.snapshot().visible, mode !== 'auto');
  }
});

test('a manual preview becomes a timed confirmation on advance, then returns at the next choice', async t => {
  const { controller, settings, advance, updates } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.command('toggle');
  controller.observe(menu);
  controller.observe({ ...menu, presence_id: 'rescan' });
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 2);
  assert.equal(controller.snapshot().visible, true);
  controller.observe({ ...dialogue, data: [line('もう一つの会話', .8)] });
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  advance(4001);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  assert.equal(updates.at(-1).visible, false);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().visible, true);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('preview activity pauses without capture and hiding does not depend on automatic progression', async t => {
  const { controller, settings } = setup(t);
  await controller.configure({ ...settings, vnGuideAutoAdvance: false });
  controller.setAvailable(true, 'Game A');
  controller.command('toggle');
  controller.observe(dialogue);
  controller.setAvailable(false);
  controller.observe({ ...dialogue, data: [line('見えない会話', .8)] });
  controller.setAvailable(true);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().visible, true);
  controller.observe({ ...dialogue, data: [line('次の会話', .8)] });
  assert.equal(controller.snapshot().visible, false);
  assert.equal(controller.snapshot().index, 0);
  controller.observe(menu);
  assert.equal(controller.snapshot().visible, true);
});

test('plaintext game lines hide previews without a lookup scan and final OCR does not count a line twice', async t => {
  const { controller, settings } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe({ type: 'game_text', text: '今の会話' });
  controller.command('toggle');
  controller.observe({ type: 'game_text', text: '今の会話' });
  controller.observe({ type: 'game_text', text: '一つ目' });
  controller.observe({ type: 'game_text', text: '一つ目の会話' });
  controller.observe({ ...dialogue, line_id: 'first', latest_text: '一つ目の会話', data: [line('一つ目の会話', .8)] });
  assert.equal(controller.snapshot().visible, true);
  controller.observe({ type: 'game_text', text: '二つ目の会話' });
  assert.equal(controller.snapshot().visible, false);
  assert.equal(controller.snapshot().index, 0);
});

test('Always mode keeps the current step visible as game lines advance', async t => {
  const { controller, settings } = setup(t);
  await controller.configure({ ...settings, vnGuideMode: 'always' });
  controller.setAvailable(true);
  controller.command('toggle');
  controller.command('toggle');
  for (const text of ['一つ目の会話', '二つ目の会話', '三つ目の会話']) controller.observe({ type: 'game_text', text });
  assert.equal(controller.snapshot().visible, true);
});

test('plain-text appearance can change live without reloading the guide or changing visibility and progress', async t => {
  const { controller, settings, requests, updates } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe(menu);
  assert.equal(controller.snapshot().displayStyle, 'card');
  await controller.configure({ ...settings, vnGuideDisplayStyle: 'text' });
  assert.equal(controller.snapshot().displayStyle, 'text');
  assert.equal(updates.at(-1).displayStyle, 'text');
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().index, 0);
  assert.equal(requests.length, 2);
  await controller.configure({ ...settings, vnGuideDisplayStyle: 'unsupported' });
  assert.equal(controller.snapshot().displayStyle, 'card');
  controller.command('toggle');
  await controller.configure({ ...settings, vnGuideDisplayStyle: 'text' });
  assert.equal(controller.snapshot().visible, false);
});

test('the overlay delivers plaintext activity to the guide while manual mode hides lookup windows', async t => {
  const { controller, settings } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.command('toggle');
  const context = require('node:vm').createContext({
    vnGuideController: controller, mainWindow: { isDestroyed: () => false, webContents: { send() {} } },
    canUseOverlayCapture: () => true, sendOffsetHelperData() {}, lastWebsocketData: null,
  });
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  require('node:vm').runInContext(source.match(/^function publishOverlaySocketData\([\s\S]*?^}/m)[0], context);
  context.publishOverlaySocketData('ws1', '一つ目の会話');
  assert.equal(controller.snapshot().visible, true);
  context.publishOverlaySocketData('ws1', '二つ目の会話');
  assert.equal(controller.snapshot().visible, false);
  assert.equal(controller.snapshot().index, 0);
});

test('both socket feeds reveal a choice, including OCR with unrelated hooked text', async t => {
  const { controller, settings } = setup(t, {
    fetchJson: async source => source.endsWith('/guide.json') ? manifest
      : ['わたしは首を横に振る', '進む'].map(simpleJp => ({ simpleJp })),
  });
  await controller.configure(settings);
  const context = require('node:vm').createContext({
    vnGuideController: controller, mainWindow: null, canUseOverlayCapture: () => true,
    sendOffsetHelperData() {}, lastWebsocketData: null,
  });
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  require('node:vm').runInContext(source.match(/^function publishOverlaySocketData\([\s\S]*?^}/m)[0], context);
  context.publishOverlaySocketData('ws1', 'わたしは首を横に振る');
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().detected, true);
  context.publishOverlaySocketData('ws1', 'きゅうっと胸が締め付けられる。');
  assert.equal(controller.snapshot().visible, false);
  context.publishOverlaySocketData('ws2', JSON.stringify({
    ...menu, data: [line('わたしは首を横に振ろ', .78), line('わたしはこくりと頷いた', .58)],
    line_id: 'old-hook', latest_text: 'きゅうっと胸が締め付けられる。',
  }));
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().detected, true);
  assert.equal(controller.snapshot().text, 'わたしは首を横に振る', 'keep the original guide spelling');
  assert.equal(controller.snapshot().index, 0);
});

test('text-detected choices reopen a dismissed preview and respect an explicitly hidden choice', async t => {
  const { controller, settings } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.command('toggle');
  controller.command('hide');
  controller.observe({ type: 'game_text', text: '大丈夫' });
  assert.equal(controller.snapshot().visible, true);
  controller.command('hide');
  controller.observe({ type: 'game_text', text: '大丈夫' });
  controller.observe(menu);
  assert.equal(controller.snapshot().visible, false);
  controller.command('next');
  controller.observe({ type: 'game_text', text: '次の会話' });
  controller.observe({ type: 'game_text', text: '進む' });
  assert.equal(controller.snapshot().visible, true);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  controller.setAvailable(false);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().rememberedChoice, true);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 2, 'capture interruptions discard text progression evidence too');
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
  controller.command('jump', 1);
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
  controller.command('jump', 1);
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

test('advancing logs the previous choice for four seconds without revealing the next step', async t => {
  const { controller, settings, advance } = setup(t, { fetchJson: async source => source.endsWith('/guide.json') ? manifest : [{ simpleJp: '大丈夫' }, { simpleJp: '進む' }] });
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe(menu);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  advance(3999);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, true);
  advance(2);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().loggedChoice, null);
  assert.equal(controller.snapshot().text, '進む');
  controller.command('back');
  assert.equal(controller.snapshot().index, 0);
});

test('a logged choice hides upcoming ending labels and route completion after its timeout', async t => {
  for (const steps of [['大丈夫', 'Bad End「雫」 (ED4)'], ['大丈夫']]) {
    const { controller, settings, advance, updates } = setup(t, {
      fetchJson: async source => source.endsWith('/guide.json') ? manifest : steps.map(simpleJp => ({ simpleJp })),
    });
    await controller.configure(settings);
    controller.setAvailable(true);
    controller.observe(menu);
    advance(1500);
    controller.observe(dialogue);
    assert.equal(controller.snapshot().loggedChoice, '大丈夫');
    assert.equal(controller.snapshot().visible, true);
    advance(4001);
    controller.setAvailable(true);
    assert.equal(controller.snapshot().visible, false);
    assert.equal(updates.at(-1).visible, false);
    advance(60000);
    controller.setAvailable(true);
    assert.equal(controller.snapshot().visible, false);
  }
});

test('Always mode retains the logged choice until the next detected menu or explicit navigation', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure({ ...settings, vnGuideMode: 'always' });
  controller.setAvailable(true);
  controller.observe(menu);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  advance(60000);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  controller.observe(nextMenu);
  assert.equal(controller.snapshot().loggedChoice, null);
  assert.equal(controller.snapshot().detected, true);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().loggedChoice, '進む');
  controller.command('back');
  assert.equal(controller.snapshot().loggedChoice, null);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('manual Next shows the next instruction without a logged confirmation', async t => {
  for (const mode of ['auto', 'always', 'hotkey']) {
    const { controller, settings } = setup(t);
    await controller.configure({ ...settings, vnGuideMode: mode, vnGuideAutoAdvance: false });
    controller.setAvailable(true);
    controller.command('next');
    assert.equal(controller.snapshot().index, 2);
    assert.equal(controller.snapshot().text, '進む');
    assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
    assert.equal(controller.snapshot().saveNotice, false);
    assert.equal(controller.snapshot().loggedChoice, null);
    assert.equal(controller.snapshot().visible, true);
    controller.command('next');
    assert.equal(controller.snapshot().index, 3);
    assert.equal(controller.snapshot().text, 'セーブ1にロード');
    assert.equal(controller.snapshot().loggedChoice, null);
    assert.equal(controller.snapshot().visible, true);
  }
});

test('Right after automatic progress reveals the pending choice without consuming it or saving again', async t => {
  for (const mode of ['auto', 'always', 'hotkey']) {
    for (const delay of [0, 5000]) {
      const { controller, settings, advance, library } = setup(t);
      await controller.configure({ ...settings, vnGuideMode: mode });
      controller.setAvailable(true);
      controller.command('toggle');
      controller.observe(menu);
      advance(1500);
      controller.observe(dialogue);
      assert.equal(controller.snapshot().loggedChoice, '大丈夫');
      advance(delay);
      controller.setAvailable(true);
      const saved = [];
      library.save = (_loaded, index) => saved.push(index);
      controller.command('next');
      assert.equal(controller.snapshot().index, 2);
      assert.equal(controller.snapshot().text, '進む');
      assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
      assert.equal(controller.snapshot().loggedChoice, null);
      assert.equal(controller.snapshot().visible, true);
      assert.equal(controller.snapshot().saveNotice, false);
      assert.deepEqual(saved, [], 'revealing the instruction must not write progress');
      controller.command('next');
      assert.equal(controller.snapshot().index, 3, 'a second Right manually confirms the revealed choice');
      assert.equal(controller.snapshot().loggedChoice, null);
      assert.deepEqual(saved, [3]);
    }
  }
});

test('Left on a confirmation undoes automatic progress and reveals the original choice and save reminder', async t => {
  const { controller, settings, advance, library } = setup(t, {
    fetchJson: async source => source.endsWith('/guide.json') ? manifest
      : ['セーブ1', '大丈夫', '進む'].map(simpleJp => ({ simpleJp })),
  });
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe(menu);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().index, 2);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  controller.command('back');
  assert.equal(controller.snapshot().index, 1);
  assert.equal(controller.snapshot().text, '大丈夫');
  assert.equal(controller.snapshot().loggedChoice, null);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().saveNotice, false);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  assert.equal(library.progress['test-game/one'].index, 1);
});

test('Right on the last automatic confirmation reveals completion before continuing routes', async t => {
  const { controller, settings, advance, requests } = setup(t, {
    fetchJson: async source => {
      requests.push(source);
      return source.endsWith('/guide.json') ? manifest : [{ simpleJp: '大丈夫' }];
    },
  });
  await controller.configure(settings);
  controller.setAvailable(true);
  controller.observe(menu);
  advance(1500);
  controller.observe(dialogue);
  assert.equal(controller.snapshot().complete, true);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  const requestCount = requests.length;
  await controller.command('next');
  assert.equal(controller.snapshot().routeId, 'one');
  assert.equal(controller.snapshot().index, 1);
  assert.equal(controller.snapshot().complete, true);
  assert.equal(controller.snapshot().loggedChoice, null);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(requests.length, requestCount);
  await controller.command('next');
  assert.equal(controller.snapshot().routeId, 'two');
  assert.equal(controller.snapshot().index, 0);
});

test('manual Next without automatic advancement still uses the ordinary preview lifetime', async t => {
  for (const mode of ['auto', 'hotkey']) {
    const { controller, settings, advance } = setup(t);
    await controller.configure({ ...settings, vnGuideMode: mode, vnGuideAutoAdvance: false });
    controller.setAvailable(true);
    controller.command('next');
    advance(10000);
    controller.setAvailable(true);
    assert.equal(controller.snapshot().visible, true, 'manual navigation is not a timed confirmation');
    controller.observe(dialogue);
    controller.observe({ type: 'game_text', text: '別の会話' });
    assert.equal(controller.snapshot().visible, false, 'manual previews hide after two fresh lines');
  }
});

test('confirmation time pauses without capture and a different game clears it', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true, 'Game A');
  controller.observe(menu);
  advance(1500);
  controller.observe(dialogue);
  advance(2000);
  controller.setAvailable(false);
  advance(30000);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  advance(2001);
  controller.setAvailable(true);
  assert.equal(controller.snapshot().visible, false);
  controller.setAvailable(true, 'Game B');
  assert.equal(controller.snapshot().loggedChoice, null);
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

test('the backend new-line clear sequence advances and persists each choice without catch-up', async t => {
  const { controller, settings, library, directory, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true, 'Game A');
  const send = message => controller.observe(JSON.stringify(message));
  send({ type: 'overlay_clear', line_id: 'choice-1' });
  send({ ...menu, line_id: 'choice-1', presence_id: 'choice-1' });
  assert.equal(controller.snapshot().detected, true);
  advance(200);
  send({ type: 'overlay_clear', line_id: 'dialogue-1' });
  assert.equal(controller.snapshot().visible, false);
  send({ ...dialogue, line_id: 'dialogue-1', presence_id: 'dialogue-1' });
  assert.equal(controller.snapshot().index, 2);
  assert.equal(controller.snapshot().recoveredFrom, null);
  assert.equal(controller.snapshot().saveNotice, false, 'the confirmation must not show upcoming instructions');
  assert.equal(controller.snapshot().loggedChoice, '大丈夫');
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
  assert.equal(library.progress['test-game/one'].index, 2);
  send({ type: 'overlay_clear', line_id: 'choice-2' });
  send({ ...nextMenu, line_id: 'choice-2', presence_id: 'choice-2' });
  assert.equal(controller.snapshot().detected, true);
  assert.equal(controller.snapshot().saveNotice, false);
  advance(200);
  send({ type: 'overlay_clear', line_id: 'dialogue-2' });
  send({ ...dialogue, line_id: 'dialogue-2', presence_id: 'dialogue-2' });
  assert.equal(controller.snapshot().index, 3);
  assert.equal(controller.snapshot().kind, 'load');
  assert.equal(controller.snapshot().recoveredFrom, null);
  send({ type: 'overlay_clear', line_id: 'dialogue-3' });
  send({ ...dialogue, line_id: 'dialogue-3' });
  assert.equal(controller.snapshot().index, 3, 'load instructions still require manual confirmation');
  const offline = new GuideLibrary(directory, { fetchJson: async () => { throw new Error('Offline'); } });
  assert.equal((await offline.load(url)).index, 3);
  controller.command('back');
  assert.equal(controller.snapshot().index, 2);
  assert.deepEqual(controller.snapshot().saveInstructions, ['セーブ1']);
});

test('a capture interruption during a new-line scan cannot use the previous menu to advance', async t => {
  const { controller, settings, advance } = setup(t);
  await controller.configure(settings);
  controller.setAvailable(true, 'Game A');
  controller.observe({ ...menu, line_id: 'choice' });
  controller.observe({ type: 'overlay_clear', line_id: 'dialogue' });
  controller.setAvailable(false);
  advance(1500);
  controller.setAvailable(true);
  controller.observe({ ...dialogue, line_id: 'dialogue' });
  assert.equal(controller.snapshot().index, 0);
});
