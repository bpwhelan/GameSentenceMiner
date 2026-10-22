const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GuideLibrary } = require('../vn_guide_library');
const { createVnGuideController } = require('../vn_guide_controller');

const url = 'https://kanjieater.github.io/VN-Guide/test-game/';
const manifest = { title: 'Test Game', routes: [{ id: 'one', title: 'Route One' }] };
const route = ['First choice', 'Second choice'].map(simpleJp => ({ simpleJp }));
const settings = { vnGuideEnabled: true, vnGuideUrl: url, vnGuideMode: 'always' };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-updates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = 1000;
  let data = { manifest, route };
  const requests = [];
  const fetchJson = async source => {
    requests.push(source);
    if (data instanceof Error) throw data;
    return source.endsWith('/guide.json') ? data.manifest : data.route;
  };
  const library = new GuideLibrary(directory, { fetchJson, now: () => time });
  const controller = createVnGuideController({ library, now: () => time, hud: { update() {}, dispose() {} } });
  t.after(() => controller.dispose());
  await controller.configure(settings);
  await settle();
  return { directory, library, controller, requests, fetchJson, now: () => time,
    change: next => { data = next; }, advance: () => { time += 60 * 60 * 1000; } };
}

test('new imports avoid duplicate downloads; hourly checks announce updates without moving live progress', async t => {
  const { controller, library, requests, change, advance } = await setup(t);
  assert.equal(requests.length, 2);
  controller.command('next');
  change({ manifest, route: [{ simpleJp: 'New choice' }, ...route] });
  advance();
  controller.setAvailable(true);
  controller.setAvailable(true);
  await settle();
  assert.equal(requests.length, 4);
  assert.equal(controller.snapshot().updateAvailable, true);
  assert.equal(controller.snapshot().index, 1);
  assert.equal(controller.snapshot().text, 'Second choice');
  assert.equal(library.progress['test-game/one'].index, 1);
  await controller.command('refresh');
  assert.equal(controller.snapshot().error, '');
  assert.equal(controller.snapshot().text, 'New choice');
  assert.equal(controller.snapshot().changed, true);
  assert.equal(controller.snapshot().updateAvailable, false);
});

test('cached guides check upstream on reopening and keep saved progress until the update is applied', async t => {
  const { directory, controller, change, fetchJson, now, requests } = await setup(t);
  controller.command('next');
  change({ manifest: { ...manifest, title: 'Revised title' }, route });
  const reopened = createVnGuideController({
    library: new GuideLibrary(directory, { fetchJson, now }), now, hud: { update() {}, dispose() {} },
  });
  t.after(() => reopened.dispose());
  await reopened.configure(settings);
  await settle();
  assert.equal(requests.length, 4);
  assert.equal(reopened.snapshot().updateAvailable, true);
  assert.equal(reopened.snapshot().index, 1);
  assert.equal(reopened.snapshot().title, 'Test Game');
  await reopened.command('refresh');
  assert.equal(reopened.snapshot().title, 'Revised title');
  assert.equal(reopened.snapshot().index, 1);
  assert.equal(reopened.snapshot().changed, false);
});

test('manual checks report unchanged guides and offline checks preserve navigation and retry hourly', async t => {
  const { controller, requests, change, advance } = await setup(t);
  await controller.command('check-updates');
  assert.equal(requests.length, 4);
  assert.equal(controller.snapshot().updateAvailable, false);
  assert.equal(controller.snapshot().lastCheckedAt, 1000);
  change(new Error('Offline'));
  advance();
  controller.setAvailable(false);
  await settle();
  assert.match(controller.snapshot().updateError, /Offline/);
  assert.equal(controller.snapshot().error, '');
  controller.command('next');
  assert.equal(controller.snapshot().index, 1);
  const attempts = requests.length;
  controller.setAvailable(false);
  await settle();
  assert.equal(requests.length, attempts);
  change({ manifest, route });
  advance();
  controller.setAvailable(false);
  await settle();
  assert.equal(controller.snapshot().updateError, '');
});

test('invalid updates leave the whole cached guide intact', async t => {
  const { library, controller, change } = await setup(t);
  const before = fs.readFileSync(library.cacheFile, 'utf8');
  change({ manifest: { ...manifest, title: 'Unusable update' }, route: [{ broken: true }] });
  await controller.command('check-updates');
  assert.ok(controller.snapshot().updateError);
  assert.equal(fs.readFileSync(library.cacheFile, 'utf8'), before);
  assert.equal(controller.snapshot().text, 'First choice');
});

test('late update checks cannot publish into a disabled helper', async t => {
  const { controller, library } = await setup(t);
  let finish;
  library.fetchJson = source => source.endsWith('/guide.json')
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([{ simpleJp: 'New choice' }]);
  const check = controller.command('check-updates');
  assert.equal(controller.snapshot().checkingUpdates, true);
  await controller.configure({ ...settings, vnGuideEnabled: false });
  finish(manifest);
  await check;
  assert.equal(controller.snapshot().enabled, false);
  assert.equal(controller.snapshot().updateAvailable, false);
  assert.equal(controller.snapshot().checkingUpdates, false);
});

test('reopening a guide cannot forget an update found soon after its first import', async t => {
  const { controller, change } = await setup(t);
  change({ manifest, route: [...route, { simpleJp: 'Added choice' }] });
  await controller.command('check-updates');
  assert.equal(controller.snapshot().updateAvailable, true);
  await controller.configure({ ...settings, vnGuideEnabled: false });
  await controller.configure(settings);
  await settle();
  assert.equal(controller.snapshot().updateAvailable, true);
  assert.equal(controller.snapshot().total, 2);
});
