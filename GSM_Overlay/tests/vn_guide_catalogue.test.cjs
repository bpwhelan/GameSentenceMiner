const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GuideCatalogue, parseCatalogueSource, validateCatalogue, DEFAULT_CATALOGUE_SOURCE } = require('../vn_guide_catalogue');

const catalogue = {
  v1: { slug: 'one', title: 'One', alttitle: '一', has_guide: true },
  'game:two': { slug: '日本語', title: 'Two', has_guide: true, guide_target: { label: 'Windows' } },
  v3: { slug: 'unfinished', title: 'Unfinished', has_guide: false },
};
function directory(t) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-catalogue-'));
  t.after(() => fs.rmSync(result, { recursive: true, force: true }));
  return result;
}

const remoteRoot = 'https://raw.githubusercontent.com/example/My-Guide/feature/guides/';
const treeUrl = 'https://api.github.com/repos/example/My-Guide/git/trees/feature%2Fguides?recursive=1';
const sourceUrl = 'https://github.com/example/My-Guide/tree/feature/guides';
const manifest = (id, title, reviewed = true) => ({ vndb_id: id, title,
  routes: [{ id: 'first', title: 'First route', reviewed }] });
function tree(slugs) {
  return { truncated: false, tree: slugs.flatMap(slug => ['catalog.json', 'guide.json']
    .map(file => ({ path: `${slug}/${file}`, type: 'blob', mode: '100644' }))) };
}
function remoteFiles(files, requests = []) {
  return async url => {
    requests.push(url);
    if (!Object.hasOwn(files, url)) throw Object.assign(new Error('Missing file (HTTP 404).'), { status: 404 });
    if (files[url] instanceof Error) throw files[url];
    return structuredClone(files[url]);
  };
}

test('directory catalogs add new guides and override stale legacy availability on the selected branch', async t => {
  const requests = [];
  const files = {
    [`${remoteRoot}games.json`]: catalogue,
    [treeUrl]: tree(['muv-luv-extra', 'one', 'draft']),
    [`${remoteRoot}muv-luv-extra/catalog.json`]: { vndb_id: 'v93', title: 'Muv-Luv EXTRA', alttitle: 'マブラヴ EXTRA',
      guide_target: { label: 'Original Windows release' }, has_guide: false },
    [`${remoteRoot}muv-luv-extra/guide.json`]: manifest('v93', 'Muv-Luv EXTRA'),
    [`${remoteRoot}one/catalog.json`]: { vndb_id: 'v1', title: 'One revised' },
    [`${remoteRoot}one/guide.json`]: manifest('v1', 'One revised', false),
    [`${remoteRoot}draft/catalog.json`]: { vndb_id: 'v4', title: 'Draft', has_guide: true },
    [`${remoteRoot}draft/guide.json`]: { ...manifest('v4', 'Draft'),
      routes: [{ id: 'first', title: 'Reviewed', reviewed: true }, { id: 'last', title: 'Unreviewed', reviewed: false }] },
  };
  const library = new GuideCatalogue(directory(t), { fetchJson: remoteFiles(files, requests) });
  const result = await library.list(sourceUrl);
  assert.deepEqual(result.guides.map(game => game.slug).sort(), ['muv-luv-extra', '日本語']);
  assert.deepEqual(result.guides.find(game => game.slug === 'muv-luv-extra'), {
    slug: 'muv-luv-extra', title: 'Muv-Luv EXTRA', alttitle: 'マブラヴ EXTRA', target: 'Original Windows release',
    url: `${remoteRoot}muv-luv-extra/`,
  });
  assert.equal(result.warning, '');
  assert.ok(requests.includes(treeUrl));
  assert.ok(requests.every(url => url === treeUrl || url.startsWith(remoteRoot)));
  assert.ok(!requests.some(url => /index\.html|route_/.test(url)), 'listing needs no generated pages or route downloads');
  const before = requests.length;
  await library.list(sourceUrl);
  assert.equal(requests.length, before, 'the complete catalogue is cached together');
});

test('a repository with only per-game catalogs can list and import a new guide before site generation', async t => {
  const root = directory(t);
  const files = {
    [treeUrl]: tree(['new-game']),
    [`${remoteRoot}new-game/catalog.json`]: { vndb_id: 'v93', title: 'New game' },
    [`${remoteRoot}new-game/guide.json`]: manifest('v93', 'New game'),
    [`${remoteRoot}new-game/route_first.json`]: [{ simpleJp: '選ぶ' }],
  };
  const fetchJson = remoteFiles(files);
  const result = await new GuideCatalogue(root, { fetchJson }).list(sourceUrl);
  assert.deepEqual(result.guides.map(game => game.slug), ['new-game']);
  assert.equal(result.warning, '');
  const { GuideLibrary } = require('../vn_guide_library');
  const loaded = await new GuideLibrary(root, { fetchJson }).load(result.guides[0].url);
  assert.equal(loaded.guide.title, 'New game');
  assert.equal(loaded.steps[0].text, '選ぶ');
});

test('local roots discover per-game catalogs without games.json and refresh review flags and migrations', async t => {
  const root = directory(t), source = path.join(root, 'Local guides 日本語');
  const game = path.join(source, 'muv-luv-extra');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'catalog.json'), JSON.stringify({ vndb_id: 'v93', title: 'Muv-Luv EXTRA' }));
  fs.writeFileSync(path.join(game, 'guide.json'), JSON.stringify(manifest('v93', 'Muv-Luv EXTRA')));
  const library = new GuideCatalogue(path.join(root, 'cache'));
  let result = await library.list(source);
  assert.equal(result.guides[0].url, `${pathToFileURL(game).href}/`);
  fs.writeFileSync(path.join(source, 'games.json'), JSON.stringify({ v93: { slug: 'muv-luv-extra', title: 'Old name', has_guide: true }, ...catalogue }));
  result = await library.list(path.join(source, 'games.json'), { refresh: true });
  assert.equal(result.guides.length, 3);
  assert.equal(result.guides.find(entry => entry.slug === 'muv-luv-extra').title, 'Muv-Luv EXTRA');
  fs.writeFileSync(path.join(game, 'guide.json'), JSON.stringify(manifest('v93', 'Muv-Luv EXTRA', false)));
  result = await library.list(source, { refresh: true });
  assert.deepEqual(result.guides.map(entry => entry.slug), ['one', '日本語']);
});

test('failed directory discovery or invalid updates preserve the complete cached catalogue', async t => {
  const root = directory(t);
  const files = {
    [`${remoteRoot}games.json`]: catalogue,
    [treeUrl]: tree(['new-game']),
    [`${remoteRoot}new-game/catalog.json`]: { vndb_id: 'v93', title: 'New game' },
    [`${remoteRoot}new-game/guide.json`]: manifest('v93', 'New game'),
  };
  const library = new GuideCatalogue(root, { fetchJson: remoteFiles(files) });
  const initial = await library.list(sourceUrl);
  assert.equal(initial.guides.length, 3);
  files[treeUrl] = new Error('GitHub rate limit');
  let result = await library.list(sourceUrl, { refresh: true });
  assert.deepEqual(result.guides, initial.guides);
  assert.match(result.warning, /rate limit.*cached/i);
  files[treeUrl] = tree(['new-game']);
  files[`${remoteRoot}new-game/guide.json`].vndb_id = 'v999';
  result = await library.list(sourceUrl, { refresh: true });
  assert.deepEqual(result.guides, initial.guides);
  assert.match(result.warning, /cached/i);
  const reopened = new GuideCatalogue(root, { fetchJson: async () => { throw new Error('Offline'); } });
  result = await reopened.list(sourceUrl, { refresh: true });
  assert.deepEqual(result.guides, initial.guides);
  assert.match(result.warning, /Offline.*cached/);
});

test('legacy-only sources still work when GitHub discovery is unavailable, with an explicit warning', async t => {
  const root = directory(t);
  const library = new GuideCatalogue(root, { fetchJson: remoteFiles({
    [`${remoteRoot}games.json`]: catalogue, [treeUrl]: new Error('GitHub rate limit'),
  }) });
  const result = await library.list(sourceUrl);
  assert.equal(result.guides.length, 2);
  assert.match(result.warning, /rate limit/);
  const reopened = new GuideCatalogue(root, { fetchJson: async () => { throw new Error('Offline'); } });
  assert.equal((await reopened.list(sourceUrl, { refresh: true })).guides.length, 2);
  const oldCache = directory(t);
  fs.writeFileSync(path.join(oldCache, 'vn-guide-catalogue-cache.json'), JSON.stringify({ [`${remoteRoot}games.json`]: catalogue }));
  const upgraded = new GuideCatalogue(oldCache, { fetchJson: async () => { throw new Error('Offline'); } });
  assert.equal((await upgraded.list(sourceUrl, { refresh: true })).guides.length, 2);
});

test('truncated trees, unsafe catalog paths, and symlinked manifests cannot produce a complete catalogue', async t => {
  for (const listing of [
    { ...tree(['new-game']), truncated: true },
    tree(['..']),
    { truncated: false, tree: [{ path: 'new-game/catalog.json', type: 'blob', mode: '120000' }] },
    { truncated: false, tree: [{ path: 'new-game/catalog.json', type: 'blob', mode: '100644' },
      { path: 'new-game/guide.json', type: 'blob', mode: '120000' }] },
  ]) {
    const requests = [];
    const library = new GuideCatalogue(directory(t), { fetchJson: remoteFiles({ [treeUrl]: listing }, requests) });
    await assert.rejects(library.list(sourceUrl));
    assert.ok(requests.every(url => url === treeUrl || url === `${remoteRoot}games.json`));
  }
});

test('catalogue defaults to kanjieater and accepts fork roots, branch URLs, and index files', () => {
  assert.equal(DEFAULT_CATALOGUE_SOURCE, 'https://github.com/kanjieater/VN-Guide');
  assert.equal(parseCatalogueSource('').indexUrl, 'https://raw.githubusercontent.com/kanjieater/VN-Guide/main/games.json');
  for (const source of [
    'https://github.com/example/My-Guide',
    'https://example.github.io/My-Guide/',
    'https://github.com/example/My-Guide/blob/main/games.json',
    'https://raw.githubusercontent.com/example/My-Guide/main/',
  ]) assert.equal(parseCatalogueSource(source).indexUrl, 'https://raw.githubusercontent.com/example/My-Guide/main/games.json');
  assert.equal(parseCatalogueSource('https://github.com/example/My-Guide/tree/feature/guides').indexUrl,
    'https://raw.githubusercontent.com/example/My-Guide/feature/guides/games.json');
  for (const source of ['https://evil.test/games.json', 'http://github.com/example/My-Guide', './relative',
    'https://user:pass@github.com/example/My-Guide', 'https://github.com/example/My-Guide/tree/main/%2foutside']) {
    assert.throws(() => parseCatalogueSource(source));
  }
});

test('catalogue validates the upstream format, excludes unfinished guides, and rejects duplicate or unsafe folders', () => {
  assert.deepEqual(validateCatalogue(catalogue).map(game => game.slug), ['one', '日本語']);
  for (const data of [null, [], { bad: { title: 'Missing slug', has_guide: true } },
    { bad: { slug: '../outside', title: 'Bad', has_guide: true } },
    { ...catalogue, duplicate: catalogue.v1 },
    { bad: { slug: 'one', title: 'Bad', has_guide: 'true' } }]) assert.throws(() => validateCatalogue(data));
});

test('remote catalogues resolve every guide inside the selected source and keep caches separate from imported routes', async t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'vn-guide-cache.json'), '{"keep":"existing routes"}');
  const requests = [];
  const library = new GuideCatalogue(root, { fetchJson: async url => {
    requests.push(url); return url.startsWith('https://api.github.com/') ? tree([]) : catalogue;
  } });
  const result = await library.list('https://github.com/example/My-Guide/tree/other');
  assert.deepEqual(requests, ['https://raw.githubusercontent.com/example/My-Guide/other/games.json',
    'https://api.github.com/repos/example/My-Guide/git/trees/other?recursive=1']);
  assert.equal(result.guides.length, 2);
  assert.equal(result.guides[0].url, 'https://raw.githubusercontent.com/example/My-Guide/other/one/');
  assert.equal(result.guides[1].url, `https://raw.githubusercontent.com/example/My-Guide/other/${encodeURIComponent('日本語')}/`);
  assert.equal(fs.readFileSync(path.join(root, 'vn-guide-cache.json'), 'utf8'), '{"keep":"existing routes"}');
  let offline = false;
  const reopened = new GuideCatalogue(root, { fetchJson: async () => { offline = true; throw new Error('Offline'); } });
  const cached = await reopened.list('https://github.com/example/My-Guide/tree/other', { refresh: true });
  assert.equal(offline, true);
  assert.equal(cached.guides.length, 2);
  assert.match(cached.warning, /Offline/);
  await assert.rejects(reopened.list('https://github.com/another/Guide'), /Offline/);
});

test('local catalogue directories and games.json paths list local guides using the same format', async t => {
  const root = directory(t);
  const source = path.join(root, 'Local guides 日本語');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'games.json'), JSON.stringify(catalogue));
  const library = new GuideCatalogue(path.join(root, 'cache'));
  const expected = pathToFileURL(path.join(source, 'games.json')).href;
  for (const input of [source, path.join(source, 'games.json'), pathToFileURL(source).href]) {
    assert.equal(parseCatalogueSource(input).indexUrl, expected);
    const result = await library.list(input);
    assert.equal(result.guides[0].url, `${pathToFileURL(path.join(source, 'one')).href}/`);
  }
  fs.writeFileSync(path.join(source, 'games.json'), JSON.stringify({ bad: { ...catalogue.v1, slug: '../outside' } }));
  const cached = await library.list(source, { refresh: true });
  assert.match(cached.warning, /invalid/i);
  assert.equal(cached.guides.length, 2);
});
