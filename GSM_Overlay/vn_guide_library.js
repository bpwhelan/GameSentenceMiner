const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseGuideUrl, validateGuide, validateRoute } = require('./vn_guide');

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const fingerprintSteps = steps => createHash('sha256').update(JSON.stringify(steps)).digest('hex');

async function fetchGuideJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error', credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`VN-Guide could not be downloaded (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) throw new Error('The guide file is too large.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('VN-Guide returned an invalid JSON file.'); }
}

function readStore(file) {
  try {
    if (fs.statSync(file).size > 16 * MAX_JSON_BYTES) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function writeStore(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

class GuideLibrary {
  constructor(directory, { fetchJson = fetchGuideJson, now = Date.now } = {}) {
    this.fetchJson = fetchJson;
    this.now = now;
    this.fetchedAt = new Map();
    this.cacheFile = path.join(directory, 'vn-guide-cache.json');
    this.progressFile = path.join(directory, 'vn-guide-progress.json');
    this.cache = readStore(this.cacheFile);
    this.progress = readStore(this.progressFile);
    this.pending = new Map();
  }
  async get(url, validate, refresh = false) {
    if (!refresh && Object.hasOwn(this.cache, url)) {
      try { return validate(this.cache[url]); } catch { delete this.cache[url]; }
    }
    if (!this.pending.has(url)) {
      this.pending.set(url, this.fetchJson(url).then(data => {
        validate(data);
        this.cache[url] = data;
        // A bounded, local cache avoids repeatedly downloading routes and keeps
        // imported guides usable offline. Update checks leave this cache intact
        // until the user applies the update by refreshing the guide.
        const keys = Object.keys(this.cache);
        for (const key of keys.slice(0, Math.max(0, keys.length - 80))) delete this.cache[key];
        writeStore(this.cacheFile, this.cache);
        this.fetchedAt.set(url, this.now());
        return data;
      }).finally(() => this.pending.delete(url)));
    }
    return validate(await this.pending.get(url));
  }
  async load(url, requestedRoute = '', refresh = false) {
    const source = parseGuideUrl(url);
    const guide = await this.get(`${source.baseUrl}guide.json`, validateGuide, refresh);
    const routeId = requestedRoute || source.routeId || guide.routes[0].id;
    const route = guide.routes.find(item => item.id === routeId);
    if (!route) throw new Error('That route is not in this guide. Clear the route selection and load again.');
    const steps = await this.get(`${source.baseUrl}route_${encodeURIComponent(routeId)}.json`, validateRoute, refresh);
    const key = `${source.slug}/${routeId}`;
    const fingerprint = fingerprintSteps(steps);
    const saved = this.progress[key];
    const changed = !!saved && saved.fingerprint !== fingerprint;
    const initialIndex = !requestedRoute || requestedRoute === source.routeId ? source.step ?? 0 : 0;
    const candidate = saved && !changed ? saved.index : changed ? 0 : initialIndex;
    const index = Number.isInteger(candidate) && candidate >= 0 && candidate <= steps.length ? candidate : 0;
    return { source, guide, route, steps, key, fingerprint, index, changed };
  }
  async checkForUpdates(loaded, { force = false } = {}) {
    const guideUrl = `${loaded.source.baseUrl}guide.json`;
    const routeUrl = `${loaded.source.baseUrl}route_${encodeURIComponent(loaded.route.id)}.json`;
    // A freshly downloaded import already is an update check. Disk caches have
    // no in-memory timestamp, so reopening a guide always revalidates upstream.
    if (!force && [guideUrl, routeUrl].every(url => this.fetchedAt.has(url)
      && this.now() - this.fetchedAt.get(url) < UPDATE_INTERVAL_MS)) {
      return { guide: loaded.guide, fingerprint: loaded.fingerprint };
    }
    // The cached import may now be older than the checked content. Do not let
    // a later reopen report that cache as current using its download timestamp.
    this.fetchedAt.delete(guideUrl);
    this.fetchedAt.delete(routeUrl);
    const guide = validateGuide(await this.fetchJson(guideUrl));
    const steps = validateRoute(await this.fetchJson(routeUrl));
    return { guide, fingerprint: fingerprintSteps(steps) };
  }
  save(loaded, index) {
    this.progress[loaded.key] = { index, fingerprint: loaded.fingerprint };
    writeStore(this.progressFile, this.progress);
  }
}

module.exports = { GuideLibrary, fetchGuideJson, UPDATE_INTERVAL_MS };
