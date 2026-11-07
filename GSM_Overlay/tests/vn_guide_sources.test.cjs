const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseGuideUrl } = require('../vn_guide');
const { GuideLibrary, fetchGuideJson } = require('../vn_guide_library');

const manifest = { title: 'Test Game', routes: [{ id: 'one', title: 'Route One' }, { id: 'two', title: 'Route Two' }] };
const route = ['First choice', 'Second choice'].map(simpleJp => ({ simpleJp }));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-sources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const game = path.join(directory, 'My guides 日本語', 'test-game');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'guide.json'), JSON.stringify(manifest));
  for (const id of ['one', 'two']) fs.writeFileSync(path.join(game, `route_${id}.json`), JSON.stringify(route));
  return { directory, game, library: new GuideLibrary(path.join(directory, 'cache')) };
}

test('fork pages, GitHub folders, and raw files resolve to the fork and selected branch', () => {
  for (const url of [
    'https://example-user.github.io/My-Guide/test-game/#route=two&step=1',
    'https://github.com/example-user/My-Guide/tree/main/test-game/#route=two&step=1',
    'https://github.com/example-user/My-Guide/blob/main/test-game/route_two.json#step=1',
    'https://raw.githubusercontent.com/example-user/My-Guide/main/test-game/guide.json#route=two&step=1',
  ]) {
    const source = parseGuideUrl(url);
    assert.equal(source.slug, 'test-game');
    assert.equal(source.routeId, 'two');
    assert.equal(source.step, 1);
    assert.equal(source.baseUrl, 'https://raw.githubusercontent.com/example-user/My-Guide/main/test-game/');
  }
  for (const host of ['https://github.com/example-user/My-Guide/tree', 'https://raw.githubusercontent.com/example-user/My-Guide']) {
    assert.equal(parseGuideUrl(`${host}/feature/new-guide/test-game/guide.json`).baseUrl,
      'https://raw.githubusercontent.com/example-user/My-Guide/feature/new-guide/test-game/');
  }
});

test('local game folders, manifest files, and file URLs use the same source', t => {
  const { game } = fixture(t);
  const baseUrl = `${pathToFileURL(game).href}/`;
  for (const input of [game, `${game}${path.sep}`, `"${game}"`, path.join(game, 'guide.json'), baseUrl, `${baseUrl}guide.json`]) {
    assert.equal(parseGuideUrl(input).baseUrl, baseUrl);
  }
  const source = parseGuideUrl(`${baseUrl}route_two.json#step=1`);
  assert.equal(source.routeId, 'two');
  assert.equal(source.step, 1);
});

test('unsupported remote sources and paths cannot redirect guide reads', () => {
  for (const url of [
    'http://example-user.github.io/VN-Guide/game/',
    'https://github.com.evil.test/user/VN-Guide/tree/main/game/',
    'https://example-user.github.io/VN-Guide/',
    'https://example-user.github.io/VN-Guide/game/extra/guide.json',
    'https://user:pass@github.com/user/VN-Guide/tree/main/game/',
    'https://raw.githubusercontent.com/user/VN-Guide/main/game/%2fguide.json',
    'https://raw.githubusercontent.com/user/VN-Guide/main/game/%ZZ',
    'https://github.com/user/VN-Guide/tree/main/game/#route=../outside',
    './relative/game',
  ]) assert.throws(() => parseGuideUrl(url), url);
});

test('local guides support caching, route selection, saved progress, update checks, and refresh', async t => {
  const { directory, game, library } = fixture(t);
  let loaded = await library.load(game, 'two');
  assert.equal(loaded.route.id, 'two');
  assert.equal(loaded.steps[0].text, 'First choice');
  library.save(loaded, 1);
  loaded = await new GuideLibrary(path.join(directory, 'cache')).load(path.join(game, 'guide.json'), 'two');
  assert.equal(loaded.index, 1);
  fs.writeFileSync(path.join(game, 'route_two.json'), JSON.stringify([{ simpleJp: 'New choice' }, ...route]));
  const latest = await library.checkForUpdates(loaded, { force: true });
  assert.notEqual(latest.fingerprint, loaded.fingerprint);
  assert.equal((await library.load(game, 'two')).steps.length, 2, 'updates wait for reload');
  loaded = await library.load(game, 'two', true);
  assert.equal(loaded.changed, true);
  assert.equal(loaded.index, 0);
  assert.equal(loaded.steps[0].text, 'New choice');
});

test('local files enforce existing manifest, route, JSON, and size requirements', async t => {
  const { game, library } = fixture(t);
  fs.writeFileSync(path.join(game, 'route_one.json'), JSON.stringify([{ text: 'Wrong format' }]));
  await assert.rejects(library.load(game), /Japanese instruction/);
  fs.writeFileSync(path.join(game, 'guide.json'), JSON.stringify({ title: 'Bad', routes: [{ id: '../outside', title: 'Bad' }] }));
  await assert.rejects(library.load(game, '', true), /invalid or duplicate route/);
  fs.writeFileSync(path.join(game, 'guide.json'), '<html>Not a guide</html>');
  await assert.rejects(library.load(game, '', true), /invalid JSON/);
  fs.writeFileSync(path.join(game, 'guide.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(fetchGuideJson(pathToFileURL(path.join(game, 'guide.json')).href), /too large/);
  await assert.rejects(library.load(path.join(game, 'missing')), /guide.json/);
});

test('forks, branches, and local copies keep independent progress while official progress stays compatible', async t => {
  const { directory, game } = fixture(t);
  const requests = [];
  const library = new GuideLibrary(path.join(directory, 'cache'), { fetchJson: async url => {
    requests.push(url);
    return url.endsWith('/guide.json') ? manifest : route;
  } });
  const urls = [
    'https://kanjieater.github.io/VN-Guide/test-game/',
    'https://example-user.github.io/VN-Guide/test-game/',
    'https://github.com/example-user/VN-Guide/tree/other/test-game/',
    game,
  ];
  const keys = new Set();
  for (const url of urls) {
    const loaded = await library.load(url);
    assert.equal(loaded.index, 0);
    keys.add(loaded.key);
    library.save(loaded, 1);
  }
  assert.equal(keys.size, urls.length);
  assert.equal(library.progress['test-game/one'].index, 1);
  assert.ok(requests.includes('https://raw.githubusercontent.com/example-user/VN-Guide/main/test-game/guide.json'));
  assert.ok(requests.includes('https://raw.githubusercontent.com/example-user/VN-Guide/other/test-game/route_one.json'));
  const alias = await library.load('https://raw.githubusercontent.com/example-user/VN-Guide/main/test-game/guide.json');
  assert.equal(alias.index, 1);
});
