const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { parseGuideUrl, validateGuide } = require('./vn_guide');
const { GuideLibrary, fetchGuideJson } = require('./vn_guide_library');

const DEFAULT_CATALOGUE_SOURCE = 'https://github.com/kanjieater/VN-Guide';
const safeSlug = value => typeof value === 'string' && /^[\p{L}\p{N}_-]{1,160}$/u.test(value);
const missingFile = error => error?.status === 404 || error?.code === 'ENOENT';
const snapshotKey = source => `${source.baseUrl}#catalogue-v2`;

function parseCatalogueSource(value) {
  const input = String(value || DEFAULT_CATALOGUE_SOURCE).trim().replace(/^"(.*)"$/, '$1') || DEFAULT_CATALOGUE_SOURCE;
  let url;
  try { url = path.isAbsolute(input) ? pathToFileURL(input) : new URL(input); }
  catch { throw new Error('Use a GitHub repository URL or an absolute path to a guide catalogue folder.'); }
  if (url.protocol === 'file:' && path.basename(fileURLToPath(url)) === 'games.json') {
    url = pathToFileURL(path.dirname(fileURLToPath(url)));
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/games\.json$/, '').replace(/\/+$/, '');
  if (url.hostname === 'github.com' && url.pathname.split('/').length === 3) url.pathname += '/tree/main';
  url.pathname += '/__catalogue__/';
  // Reuse the guide URL restrictions and canonicalize every entry to this root.
  const baseUrl = new URL('../', parseGuideUrl(url.href).baseUrl).href;
  const source = { baseUrl, indexUrl: `${baseUrl}games.json` };
  if (baseUrl.startsWith('file:')) return { ...source, directory: fileURLToPath(baseUrl) };
  const [owner, repo, ...ref] = new URL(baseUrl).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  return { ...source, treeUrl: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref.join('/'))}?recursive=1` };
}

function validateCatalogue(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 2000) {
    throw new Error('This file is not a VN-Guide games.json catalogue.');
  }
  const seen = new Set();
  const guides = [];
  for (const game of Object.values(data)) {
    if (!game || !safeSlug(game.slug)
      || seen.has(game.slug) || typeof game.title !== 'string' || !game.title.trim()
      || typeof game.has_guide !== 'boolean') throw new Error('The catalogue contains an invalid or duplicate game.');
    seen.add(game.slug);
    if (!game.has_guide) continue;
    guides.push({ slug: game.slug, title: game.title.slice(0, 300),
      alttitle: typeof game.alttitle === 'string' ? game.alttitle.slice(0, 300) : '',
      target: typeof game.guide_target?.label === 'string' ? game.guide_target.label.slice(0, 300) : '' });
  }
  return guides;
}

function validateSnapshot(data) {
  if (data?.version !== 2 || typeof data.warning !== 'string') throw new Error('Invalid cached guide catalogue.');
  return { guides: validateCatalogue(data.games), warning: data.warning };
}

function validateGameCatalogue(metadata, data, slug) {
  const id = metadata?.vndb_id;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || typeof id !== 'string' || !/^(?:v[0-9]+|game:[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(id)
    || (metadata.slug != null && metadata.slug !== slug) || data?.vndb_id !== id) {
    throw new Error(`Invalid catalogue or mismatched guide in ${slug}.`);
  }
  const guide = validateGuide(data);
  const target = metadata.guide_target ?? data.guide_target;
  // Cache only picker metadata, not arbitrary extra data from every game file.
  const entry = { slug,
    title: typeof metadata.title === 'string' ? metadata.title.slice(0, 300) : metadata.title ?? guide.title,
    alttitle: typeof metadata.alttitle === 'string' ? metadata.alttitle.slice(0, 300) : '',
    guide_target: { label: typeof target?.label === 'string' ? target.label.slice(0, 300) : '' },
    has_guide: guide.routes.every(route => route.reviewed) };
  validateCatalogue({ [id]: entry });
  return [id, entry];
}

function cataloguesInTree(data) {
  if (!data || !Array.isArray(data.tree) || typeof data.truncated !== 'boolean') {
    throw new Error('GitHub returned an invalid guide directory listing.');
  }
  if (data.truncated) throw new Error('GitHub returned an incomplete guide directory listing.');
  const files = new Map(data.tree.map(entry => [entry?.path, entry]));
  const slugs = [];
  for (const [filename, entry] of files) {
    if (typeof filename !== 'string') continue;
    const parts = filename.split('/');
    if (parts.length !== 2 || parts[1] !== 'catalog.json' || parts[0].startsWith('.') && parts[0] !== '..') continue;
    const manifest = files.get(`${parts[0]}/guide.json`);
    if (!safeSlug(parts[0]) || [entry, manifest].some(file => file?.type !== 'blob' || !['100644', '100755'].includes(file.mode))) {
      throw new Error('The catalogue contains an unsafe folder or a missing guide manifest.');
    }
    slugs.push(parts[0]);
  }
  return slugs.sort();
}

async function localCatalogues(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const slugs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let catalog;
    try { catalog = await fs.lstat(path.join(directory, entry.name, 'catalog.json')); }
    catch (error) { if (missingFile(error)) continue; throw error; }
    if (!safeSlug(entry.name) || !catalog.isFile() || !(await fs.lstat(path.join(directory, entry.name, 'guide.json'))).isFile()) {
      throw new Error('The catalogue contains an unsafe folder or a missing guide manifest.');
    }
    slugs.push(entry.name);
  }
  return slugs.sort();
}

async function mapCatalogues(slugs, read) {
  if (slugs.length > 2000) throw new Error('The guide catalogue contains too many games.');
  const entries = new Array(slugs.length);
  let next = 0;
  // Bound concurrent downloads even for a large repository.
  await Promise.all(Array.from({ length: Math.min(6, slugs.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= slugs.length) return;
      entries[index] = await read(slugs[index]);
    }
  }));
  return entries;
}

class GuideCatalogue {
  constructor(directory, options = {}) {
    this.fetchJson = options.fetchJson || fetchGuideJson;
    // A separate cache prevents catalogue refreshes from evicting saved routes.
    // Store the merged snapshot atomically so a failed refresh cannot erase
    // directory-only guides or leave stale review flags from a partial update.
    this.library = new GuideLibrary(directory, { ...options, cacheFileName: 'vn-guide-catalogue-cache.json',
      fetchJson: url => this.loadCatalogue(parseCatalogueSource(url)) });
  }

  async loadCatalogue(source) {
    let legacy;
    try {
      legacy = await this.fetchJson(source.indexUrl);
      validateCatalogue(legacy);
    } catch (error) { if (!missingFile(error)) throw error; }
    try {
      const slugs = source.directory ? await localCatalogues(source.directory)
        : cataloguesInTree(await this.fetchJson(source.treeUrl));
      if (!legacy && !slugs.length) throw new Error('No guide catalogues were found in this source.');
      const entries = await mapCatalogues(slugs, async slug => {
        const base = `${source.baseUrl}${encodeURIComponent(slug)}/`;
        const [metadata, guide] = await Promise.all(['catalog.json', 'guide.json'].map(file => this.fetchJson(`${base}${file}`)));
        return validateGameCatalogue(metadata, guide, slug);
      });
      const games = { ...legacy };
      const ids = new Set();
      for (const [id, game] of entries) {
        if (ids.has(id) || games[id] && games[id].slug !== game.slug) throw new Error('The catalogue contains a duplicate game identifier.');
        ids.add(id);
        games[id] = game;
      }
      validateCatalogue(games);
      return { version: 2, games, warning: '' };
    } catch (error) {
      if (!legacy || Object.hasOwn(this.library.cache, snapshotKey(source))) throw error;
      return { version: 2, games: legacy,
        warning: `Could not load all guide folders: ${error.message} Showing only the older catalogue entries.` };
    }
  }

  async list(value = DEFAULT_CATALOGUE_SOURCE, { refresh = false } = {}) {
    const source = parseCatalogueSource(value);
    const key = snapshotKey(source);
    let result;
    try { result = await this.library.get(key, validateSnapshot, refresh); }
    catch (error) {
      for (const [cacheKey, validate] of [[key, validateSnapshot], [source.indexUrl, games => ({ guides: validateCatalogue(games) })]]) {
        if (!Object.hasOwn(this.library.cache, cacheKey)) continue;
        try { result = validate(this.library.cache[cacheKey]); break; } catch {}
      }
      if (!result) throw error;
      result.warning = `Could not refresh the catalogue: ${error.message} Using the cached list.`;
    }
    return { guides: result.guides.map(game => ({ ...game, url: `${source.baseUrl}${encodeURIComponent(game.slug)}/` })), warning: result.warning };
  }
}

module.exports = { GuideCatalogue, parseCatalogueSource, validateCatalogue, DEFAULT_CATALOGUE_SOURCE };
