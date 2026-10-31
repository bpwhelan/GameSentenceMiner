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
  const library = new GuideCatalogue(root, { fetchJson: async url => { requests.push(url); return catalogue; } });
  const result = await library.list('https://github.com/example/My-Guide/tree/other');
  assert.deepEqual(requests, ['https://raw.githubusercontent.com/example/My-Guide/other/games.json']);
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
