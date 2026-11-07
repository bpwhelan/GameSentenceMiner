const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { parseGuideUrl } = require('./vn_guide');
const { GuideLibrary } = require('./vn_guide_library');

const DEFAULT_CATALOGUE_SOURCE = 'https://github.com/kanjieater/VN-Guide';

function parseCatalogueSource(value) {
  const input = String(value || DEFAULT_CATALOGUE_SOURCE).trim().replace(/^"(.*)"$/, '$1') || DEFAULT_CATALOGUE_SOURCE;
  let url;
  try { url = path.isAbsolute(input) ? pathToFileURL(input) : new URL(input); }
  catch { throw new Error('Use a GitHub repository URL or an absolute path to a catalogue folder containing games.json.'); }
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
  return { baseUrl, indexUrl: `${baseUrl}games.json` };
}

function validateCatalogue(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 2000) {
    throw new Error('This file is not a VN-Guide games.json catalogue.');
  }
  const seen = new Set();
  const guides = [];
  for (const game of Object.values(data)) {
    if (!game || typeof game.slug !== 'string' || !/^[\p{L}\p{N}_-]{1,160}$/u.test(game.slug)
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

class GuideCatalogue {
  constructor(directory, options = {}) {
    // A separate cache prevents catalogue refreshes from evicting saved routes.
    this.library = new GuideLibrary(directory, { ...options, cacheFileName: 'vn-guide-catalogue-cache.json' });
  }

  async list(value = DEFAULT_CATALOGUE_SOURCE, { refresh = false } = {}) {
    const source = parseCatalogueSource(value);
    let guides, warning = '';
    try { guides = await this.library.get(source.indexUrl, validateCatalogue, refresh); }
    catch (error) {
      if (!Object.hasOwn(this.library.cache, source.indexUrl)) throw error;
      guides = validateCatalogue(this.library.cache[source.indexUrl]);
      warning = `Could not refresh the catalogue: ${error.message} Using the cached list.`;
    }
    return { guides: guides.map(game => ({ ...game, url: `${source.baseUrl}${encodeURIComponent(game.slug)}/` })), warning };
  }
}

module.exports = { GuideCatalogue, parseCatalogueSource, validateCatalogue, DEFAULT_CATALOGUE_SOURCE };
