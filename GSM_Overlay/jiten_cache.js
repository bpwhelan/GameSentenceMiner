/**
 * GSM Overlay - Jiten parse cache & local proxy server.
 *
 * Unifies all calls to Jiten's reader/parse endpoint into a single
 * in-process cache. Both the overlay renderer (via IPC) and the
 * Jiten Reader extension (via webRequest redirect to a local proxy)
 * share the same cache, eliminating duplicate API calls for identical
 * text within the cache TTL window.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TTL_MS = 10_000;
const MAX_ENTRIES = 100;
const DEFAULT_JITEN_PARSE_URL = 'https://api.jiten.moe/api/reader/parse';
const PROXY_PATH = '/__gsm_jiten_proxy__/reader/parse';

class JitenParseCache {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
    this.maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : MAX_ENTRIES;
    this._entries = new Map(); // key -> { payload, expiresAt }
    this._inflight = new Map(); // key -> Promise
    this._listeners = new Set();
  }

  _key(text) {
    return typeof text === 'string' ? text : JSON.stringify(text);
  }

  _prune(now = Date.now()) {
    for (const [k, v] of this._entries) {
      if (!v || v.expiresAt <= now) this._entries.delete(k);
    }
    while (this._entries.size > this.maxEntries) {
      const oldest = this._entries.keys().next().value;
      if (!oldest) break;
      this._entries.delete(oldest);
    }
  }

  getCached(text) {
    const key = this._key(text);
    const entry = this._entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this._entries.delete(key);
      return null;
    }
    return entry.payload;
  }

  set(text, payload) {
    const key = this._key(text);
    this._entries.set(key, { payload, expiresAt: Date.now() + this.ttlMs });
    this._prune();
    for (const cb of this._listeners) {
      try { cb(key, payload); } catch (_) { /* ignore */ }
    }
  }

  onSet(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  /**
   * Fetch via cache. Coalesces duplicate in-flight requests.
   */
  async parse({ text, apiKey, endpoint, timeout }) {
    const normalizedText = String(text || '');
    if (!normalizedText) {
      throw new Error('Jiten cache: text is required');
    }
    const cached = this.getCached(normalizedText);
    if (cached) return cached;

    const key = this._key(normalizedText);
    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }

    const promise = this._doFetch({ text: normalizedText, apiKey, endpoint, timeout })
      .then((payload) => {
        this.set(normalizedText, payload);
        return payload;
      })
      .finally(() => {
        this._inflight.delete(key);
      });
    this._inflight.set(key, promise);
    return promise;
  }

  _doFetch({ text, apiKey, endpoint, timeout }) {
    const url = String(endpoint || DEFAULT_JITEN_PARSE_URL);
    const safeTimeout = Math.max(400, Math.min(20_000, Number(timeout) || 4000));
    const body = JSON.stringify({ text: [text] });

    return new Promise((resolve, reject) => {
      let parsed;
      try { parsed = new URL(url); } catch (e) { reject(e); return; }
      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.request({
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'X-Api-Key': String(apiKey || ''),
          'X-Client-Name': 'GameSentenceMiner',
          'X-Client-Component': 'GSM-Overlay-Cache',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: safeTimeout,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
          } else {
            const err = new Error(`Jiten HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.responseBody = raw;
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Jiten request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  clear() {
    this._entries.clear();
    this._inflight.clear();
  }
}

/**
 * Start a tiny local HTTP server that serves cached Jiten parse responses.
 * The Jiten Reader extension can be redirected to this server via Electron's
 * webRequest API so its calls also benefit from cache deduplication.
 *
 * @returns {Promise<{port: number, server: http.Server, proxyUrl: string, proxyPath: string}>}
 */
function startProxyServer(cache, options = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url.startsWith(PROXY_PATH)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body;
          try { body = JSON.parse(raw); } catch (_) { body = { text: [] }; }
          const texts = Array.isArray(body.text) ? body.text : [];
          const apiKey = req.headers['x-api-key'] || '';
          // The Jiten Reader extension batches up to ~80KB of paragraphs
          // per parse call. We dedupe per individual paragraph text, then
          // reassemble. If any single paragraph cannot be served from cache,
          // we fall through to a single real upstream call for the whole batch
          // to preserve correct ordering & batching semantics.
          const allCached = texts.every((t) => cache.getCached(String(t)) !== null);
          if (allCached && texts.length > 0) {
            const merged = mergeCachedPayloads(texts.map((t) => cache.getCached(String(t))));
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(merged));
            return;
          }
          // Forward upstream as a single request; cache each paragraph result.
          const upstreamUrl = options.upstreamUrl || DEFAULT_JITEN_PARSE_URL;
          const payload = await cache._doFetch({
            text: texts.length === 1 ? texts[0] : JSON.stringify(texts),
            apiKey,
            endpoint: upstreamUrl,
            timeout: 6000,
          }).catch(async () => {
            // Fall back to a raw-body forward for multi-paragraph batches.
            return forwardRaw(upstreamUrl, raw, apiKey, 6000);
          });
          // For single-text requests we know which key to cache against.
          if (texts.length === 1 && payload && !cache.getCached(String(texts[0]))) {
            cache.set(String(texts[0]), payload);
          } else if (texts.length > 1 && payload && Array.isArray(payload.tokens)) {
            splitBatchAndCache(cache, texts, payload);
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err && err.message || err) }));
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        port,
        proxyUrl: `http://127.0.0.1:${port}${PROXY_PATH}`,
        proxyPath: PROXY_PATH,
      });
    });
  });
}

function forwardRaw(url, rawBody, apiKey, timeout) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(e); return; }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'X-Api-Key': String(apiKey || ''),
        'Content-Length': Buffer.byteLength(rawBody),
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`Upstream HTTP ${res.statusCode}: ${raw}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Upstream request timed out')));
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

/**
 * Merge multiple cached single-paragraph payloads into a multi-paragraph
 * Jiten parse response. The Jiten parse response format groups tokens by
 * paragraph index in `tokens` (array of arrays) and a single deduped
 * `vocabulary` array.
 */
function mergeCachedPayloads(payloads) {
  const tokens = [];
  const vocabulary = [];
  const vocabSeen = new Set();
  for (const p of payloads) {
    if (!p) {
      tokens.push([]);
      continue;
    }
    const pTokenGroups = Array.isArray(p.tokens) ? p.tokens : [];
    // Each cached payload is for a single paragraph: tokens[0] is the row.
    tokens.push(Array.isArray(pTokenGroups[0]) ? pTokenGroups[0] : []);
    const vocab = Array.isArray(p.vocabulary) ? p.vocabulary : [];
    for (const v of vocab) {
      if (!v) continue;
      const key = `${v.wordId}:${v.readingIndex || 0}`;
      if (vocabSeen.has(key)) continue;
      vocabSeen.add(key);
      vocabulary.push(v);
    }
  }
  return { tokens, vocabulary };
}

/**
 * Given a multi-paragraph upstream response, split per-paragraph data
 * back out and cache each paragraph independently for future hits.
 */
function splitBatchAndCache(cache, texts, payload) {
  const tokenGroups = Array.isArray(payload.tokens) ? payload.tokens : [];
  const vocabulary = Array.isArray(payload.vocabulary) ? payload.vocabulary : [];
  // Build a lookup for quick vocabulary filtering per paragraph.
  const vocabByKey = new Map();
  for (const v of vocabulary) {
    if (!v) continue;
    const key = `${v.wordId}:${v.readingIndex || 0}`;
    vocabByKey.set(key, v);
  }
  texts.forEach((text, i) => {
    const tokensForParagraph = Array.isArray(tokenGroups[i]) ? tokenGroups[i] : [];
    const usedVocab = [];
    const seen = new Set();
    for (const tok of tokensForParagraph) {
      if (!tok) continue;
      const key = `${tok.wordId}:${tok.readingIndex || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = vocabByKey.get(key);
      if (v) usedVocab.push(v);
    }
    const perParagraph = {
      tokens: [tokensForParagraph],
      vocabulary: usedVocab,
    };
    cache.set(String(text), perParagraph);
  });
}

module.exports = {
  JitenParseCache,
  startProxyServer,
  DEFAULT_JITEN_PARSE_URL,
  PROXY_PATH,
};
