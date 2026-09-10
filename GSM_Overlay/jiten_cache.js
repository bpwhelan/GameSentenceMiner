/**
 * One Jiten request broker for renderer IPC and the bundled Reader.
 * Exact paragraphs retain UTF-16 offsets; only cache misses are batched.
 * Syntax lasts a day; account state uses the lighter lookup-vocabulary API.
 * All caches are bounded and memory-only. No credentials or text are logged.
 */
const { createHash } = require('node:crypto');
const DEFAULT_JITEN_PARSE_URL = 'https://api.jiten.moe/api/reader/parse';
const JAPANESE_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const EMPTY_PAYLOAD = { tokens: [[]], vocabulary: [] };
const READ_TTLS = new Map([['reader/ping', 60_000], ['srs/reader-study-decks', 300_000]]);

function deriveJitenApiBase(parseUrl = DEFAULT_JITEN_PARSE_URL) {
  const url = new URL(parseUrl);
  url.pathname = url.pathname.replace(/\/reader\/parse\/?$/i, '');
  url.search = '';
  return url.href.replace(/\/$/, '');
}
function error(message, statusCode = 503, retryAfterMs = 0) {
  return Object.assign(new Error(message), { statusCode, retryAfterMs });
}
function abortError() {
  return Object.assign(new Error('Jiten request superseded'), { name: 'AbortError', statusCode: 499 });
}
function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
function wordKey(word) { return `${word.wordId}:${word.readingIndex ?? 0}`; }
function mergePayloads(payloads) {
  const vocabulary = new Map();
  const tokens = payloads.map((payload) => {
    for (const word of payload.vocabulary) vocabulary.set(wordKey(word), word);
    return payload.tokens[0];
  });
  return { tokens, vocabulary: [...vocabulary.values()] };
}

class LruCache {
  constructor(maxEntries, maxBytes) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.bytes = 0;
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.delete(key);
    if (entry.expiresAt <= Date.now()) return null;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    return entry.value;
  }
  set(key, value, ttlMs) {
    this.delete(key);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + ttlMs });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}

class JitenParseCache {
  constructor(options = {}) {
    // main.js injects Chromium's session.fetch (HTTP/2 and pooled connections).
    // Requiring an explicit transport keeps tests offline, too.
    this.fetch = options.fetch;
    this.ttlMs = options.ttlMs ?? 86_400_000;
    this.stateTtlMs = options.stateTtlMs ?? 300_000;
    this.batchDelayMs = options.batchDelayMs ?? 120;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.parseIntervalMs = options.parseIntervalMs ?? 2000;
    this.maxBatchCharacters = options.maxBatchCharacters ?? 16_000;
    this.maxBatchParagraphs = options.maxBatchParagraphs ?? 128;
    this.maxPending = options.maxPending ?? 512;
    this.maxPendingCharacters = options.maxPendingCharacters ?? 256_000;
    this.characterBudget = options.characterBudget ?? 60_000;
    this.budgetWindowMs = options.budgetWindowMs ?? 60_000;
    this._entries = new LruCache(options.maxEntries ?? 2000, options.maxBytes ?? 16 * 1024 * 1024);
    this._states = new LruCache(20_000, 4 * 1024 * 1024);
    this._metadata = new LruCache(64, 2 * 1024 * 1024);
    this._uncertainWrites = new LruCache(512, 128 * 1024);
    this._writeReceipts = new Map();
    this._scopes = new Map();
    this._pending = new Map();
    this._sequence = 0;
    this._timer = null;
    this._timerAt = 0;
    this._active = false;
    this._nextRequestAt = 0;
    this._nextParseAt = 0;
    this._charges = [];
    this._disposed = false;
    this._controller = null;
    this._stats = { upstreamRequests: 0, parseRequests: 0, parsedParagraphs: 0, cacheHits: 0, coalesced: 0, skipped: 0, cancelled: 0, cooldowns: 0 };
  }

  _scope({ apiKey, endpoint = DEFAULT_JITEN_PARSE_URL }) {
    const key = String(apiKey || '').trim();
    if (!key) throw error('Jiten API key is missing', 401);
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('Invalid Jiten endpoint', 400);
    url.hash = '';
    const id = createHash('sha256').update(`${url.href}\0${key}`).digest('hex');
    let scope = this._scopes.get(id);
    if (!scope) {
      // Bound credential contexts without evicting auth/cooldown latches.
      if (this._scopes.size >= 32) throw error('Too many Jiten account contexts', 429);
      scope = { id, apiKey: key, endpoint: url.href, blockedUntil: 0, failure: null, failures: 0, version: 0 };
      this._scopes.set(id, scope);
    }
    return scope;
  }
  _check(scope) {
    if (this._disposed) throw error('Jiten broker is closed');
    if (scope.blockedUntil > Date.now()) throw error(scope.failure.message, scope.failure.statusCode, scope.blockedUntil - Date.now());
  }
  getCached(text, options = {}) {
    const scope = this._scope(options);
    const payload = this._entries.get(`${scope.id}:${text}`);
    return payload ? structuredClone(payload) : null;
  }
  async parse(args) {
    if (typeof args.text !== 'string') throw error('Jiten text must be a string', 400);
    return this.parseMany({ ...args, texts: [args.text] });
  }

  async parseMany({ texts, signal, ...options }) {
    const scope = this._scope(options);
    if (this._disposed) throw error('Jiten broker is closed');
    if (signal?.aborted) throw abortError();
    if (!Array.isArray(texts) || texts.length > 2048 || texts.some((text) => typeof text !== 'string')) throw error('Jiten texts must be an array of strings (at most 2048)', 400);
    // Never silently truncate or normalize text; either changes token offsets.
    if (texts.some((text) => text.length > this.maxBatchCharacters) || texts.reduce((sum, text) => sum + text.length, 0) > this.maxPendingCharacters) throw error('Jiten text exceeds the local request budget', 413);
    const acquired = [];
    let release;
    try {
      const promises = texts.map((text) => {
        if (!JAPANESE_TEXT.test(text)) { this._stats.skipped++; return Promise.resolve(EMPTY_PAYLOAD); }
        const key = `${scope.id}:${text}`;
        const cached = this._entries.get(key);
        if (cached) { this._stats.cacheHits++; return Promise.resolve(cached); }
        this._check(scope);
        const item = this._item(`parse:${key}`, 'parse', scope, text);
        item.users++;
        acquired.push(item);
        return item.promise;
      });
      release = this._lease(acquired);
      const payloads = await this._withSignal(Promise.all(promises), signal, release);
      const merged = structuredClone(mergePayloads(payloads));
      if (merged.vocabulary.length) {
        for (const word of merged.vocabulary) {
          const lastKnown = this._states.get(`${scope.id}:${wordKey(word)}`);
          if (lastKnown) {
            word.knownState = lastKnown.knownState;
            word.studyDeckIds = lastKnown.studyDeckIds;
          }
        }
        const words = merged.vocabulary.map((word) => [word.wordId, word.readingIndex ?? 0]);
        try {
          const states = await this.lookupVocabulary({ ...options, words, signal });
          merged.vocabulary.forEach((word, i) => {
            word.knownState = states.result[i];
            word.studyDeckIds = states.decks[i];
          });
        } catch (err) {
          // Cached readings stay usable offline; a failed lookup must not
          // silently turn previously known vocabulary into "new" words.
          if (signal?.aborted || this._disposed) throw err;
        }
      }
      return merged;
    } finally { (release || this._lease(acquired))(); }
  }

  _item(key, kind, scope, value) {
    let item = this._pending.get(key);
    if (item) { this._stats.coalesced++; return item; }
    if (this._pending.size >= this.maxPending) throw error('Jiten queue is full', 429, 2000);
    if (kind === 'parse') {
      let characters = value.length;
      for (const pending of this._pending.values()) if (pending.kind === 'parse') characters += pending.value.length;
      if (characters > this.maxPendingCharacters) throw error('Jiten queue text budget is full', 429, 2000);
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Admission can fail before the caller attaches Promise.all.
    promise.catch(() => {});
    item = { key, kind, scope, value, promise, resolve, reject, users: 0, running: false, readyAt: Date.now() + this.batchDelayMs };
    this._pending.set(key, item);
    this._schedule();
    return item;
  }
  _lease(items) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const item of items) {
        item.users--;
        if (item.users === 0 && !item.running && this._pending.get(item.key) === item) {
          this._pending.delete(item.key);
          item.reject(abortError());
          this._stats.cancelled++;
        }
      }
    };
  }
  async _withSignal(promise, signal, onAbort) {
    if (!signal) return promise;
    let listener;
    try {
      return await Promise.race([promise, new Promise((_resolve, reject) => {
        listener = () => { onAbort(); reject(abortError()); };
        if (signal.aborted) listener();
        else signal.addEventListener('abort', listener, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', listener); }
  }

  async lookupVocabulary({ words, signal, force = false, ...options }) {
    const scope = this._scope(options);
    if (this._disposed) throw error('Jiten broker is closed');
    if (signal?.aborted) throw abortError();
    if (!Array.isArray(words) || words.length > 2048 || words.some((word) => !Array.isArray(word) || word.length !== 2 || !word.every(Number.isInteger))) throw error('Invalid Jiten vocabulary references', 400);
    const acquired = [];
    let release;
    try {
      const promises = words.map((word) => {
        const key = `${scope.id}:${word[0]}:${word[1]}`;
        const cached = !force && this._states.get(key);
        if (cached && cached.refreshAt > Date.now()) return Promise.resolve(cached);
        this._check(scope);
        const item = this._item(`state:${key}`, 'state', scope, word);
        item.users++;
        acquired.push(item);
        return item.promise;
      });
      release = this._lease(acquired);
      const states = await this._withSignal(Promise.all(promises), signal, release);
      return structuredClone({ result: states.map((state) => state.knownState), decks: states.map((state) => state.studyDeckIds) });
    } finally { (release || this._lease(acquired))(); }
  }

  async request({ requestId, signal, ...args }) {
    const isWrite = args.action !== 'reader/parse' && args.action !== 'reader/lookup-vocabulary' && !READ_TTLS.has(args.action);
    if (!requestId || !isWrite) return this._request({ ...args, signal });
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw error('Invalid Jiten request ID', 400);
    const scope = this._scope(args);
    if (this._disposed) throw error('Jiten broker is closed');
    if (signal?.aborted) throw abortError();
    const key = `${scope.id}:${requestId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([args.action, args.method || 'POST', args.body])).digest('hex');
    for (const [id, receipt] of this._writeReceipts) if (receipt.expiresAt <= Date.now()) this._writeReceipts.delete(id);
    let receipt = this._writeReceipts.get(key);
    if (receipt && receipt.fingerprint !== fingerprint) throw error('Jiten request ID reused for another operation', 409);
    if (!receipt) {
      if (this._writeReceipts.size >= 512) throw error('Jiten write receipt capacity reached', 429, 300_000);
      receipt = { fingerprint, expiresAt: Infinity };
      // Chromium does not reliably propagate renderer cancellation through a
      // protocol handler. Preserve the logical operation and replay its receipt.
      receipt.promise = this._request(args).then(result => {
        if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw error('Jiten write completed but its receipt is too large; refresh state', 409);
        return result;
      }).finally(() => { receipt.expiresAt = Date.now() + 300_000; });
      this._writeReceipts.set(key, receipt);
    }
    return structuredClone(await this._withSignal(receipt.promise, signal, () => {}));
  }

  async _request({ action, body, method = 'POST', signal, ...options }) {
    if (action === 'reader/parse') return this.parseMany({ ...options, texts: body?.text, signal });
    if (action === 'reader/lookup-vocabulary') return this.lookupVocabulary({ ...options, words: body?.words, signal });
    if (typeof action !== 'string' || !/^[a-z0-9/-]+$/i.test(action)) throw error('Invalid Jiten action', 400);
    const scope = this._scope(options);
    if (signal?.aborted) throw abortError();
    const ttl = READ_TTLS.get(action);
    const key = `${scope.id}:${method}:${action}:${JSON.stringify(body ?? null)}`;
    const writeKey = createHash('sha256').update(key).digest('hex');
    if (!ttl && this._uncertainWrites.get(writeKey)) throw error('Previous Jiten write may have completed; refresh state before trying again', 409);
    const cached = ttl && this._metadata.get(key);
    if (cached) return structuredClone(cached);
    this._check(scope);
    const item = this._item(ttl ? `read:${key}` : `write:${++this._sequence}`, 'request', scope, { action, body, method, ttl, key });
    item.users++;
    const release = this._lease([item]);
    try { return structuredClone(await this._withSignal(item.promise, signal, () => {
      // Reader's deadline includes queue time and may expire after dispatch.
      // Its retry must not submit the same grade a second time.
      if (!ttl && item.running) this._uncertainWrites.set(writeKey, true, 120_000);
      release();
    })); }
    finally { release(); }
  }

  _schedule(delay = this.batchDelayMs) {
    if (this._active || this._disposed || this._pending.size === 0) return;
    const wait = Math.max(0, Math.min(delay, 60_000));
    const at = Date.now() + wait;
    if (this._timer && this._timerAt <= at) return;
    clearTimeout(this._timer);
    this._timerAt = at;
    this._timer = setTimeout(() => { this._timer = null; void this._drain(); }, wait);
  }
  async _drain() {
    if (this._active || this._disposed) return;
    const now = Date.now();
    const waiting = [];
    for (const item of this._pending.values()) {
      if (item.running) continue;
      try { this._check(item.scope); } catch (err) {
        this._pending.delete(item.key);
        item.reject(err);
        continue;
      }
      waiting.push(item);
    }
    // Explicit actions and lighter state lookups take priority over OCR work.
    const first = waiting.find((item) => item.kind !== 'parse') || waiting[0];
    if (!first) return;
    let readyAt = Math.max(first.readyAt, this._nextRequestAt, first.kind === 'parse' ? this._nextParseAt : 0);
    const batch = [];
    let characters = 0;
    for (const item of waiting) {
      if (item.kind !== first.kind || item.scope !== first.scope) continue;
      if (first.kind === 'request' && batch.length) break;
      if (batch.length >= this.maxBatchParagraphs) break;
      if (first.kind === 'parse' && characters + item.value.length > this.maxBatchCharacters) break;
      batch.push(item);
      if (first.kind === 'parse') characters += item.value.length;
    }
    this._charges = this._charges.filter((charge) => charge.at + this.budgetWindowMs > now);
    const charge = Math.max(2000, characters);
    if (first.kind === 'parse') {
      let total = this._charges.reduce((sum, item) => sum + item.amount, charge);
      for (const item of this._charges) {
        if (total <= this.characterBudget) break;
        readyAt = Math.max(readyAt, item.at + this.budgetWindowMs);
        total -= item.amount;
      }
    }
    if (readyAt > now) { this._schedule(readyAt - now); return; }
    this._active = true;
    batch.forEach((item) => { item.running = true; });
    this._nextRequestAt = now + this.minIntervalMs;
    if (first.kind === 'parse') {
      this._nextParseAt = now + this.parseIntervalMs;
      this._charges.push({ at: now, amount: charge });
      this._stats.parseRequests++;
      this._stats.parsedParagraphs += batch.length;
    }
    const version = first.scope.version;
    try {
      let results;
      if (first.kind === 'parse') {
        const payload = await this._fetch(first.scope, 'reader/parse', { text: batch.map((item) => item.value) });
        results = this._splitParse(batch, payload);
        results.forEach((result, i) => {
          this._entries.set(`${first.scope.id}:${batch[i].value}`, result, this.ttlMs);
          if (version === first.scope.version) for (const word of result.vocabulary) this._rememberState(first.scope, wordKey(word), word);
        });
      } else if (first.kind === 'state') {
        const payload = await this._fetch(first.scope, 'reader/lookup-vocabulary', { words: batch.map((item) => item.value) });
        if (!Array.isArray(payload.result) || payload.result.length !== batch.length || !payload.result.every(Array.isArray) || (payload.decks !== undefined && (!Array.isArray(payload.decks) || payload.decks.length !== batch.length || !payload.decks.every(Array.isArray)))) throw error('Invalid Jiten vocabulary response', 502);
        results = batch.map((_item, i) => ({ knownState: payload.result[i], studyDeckIds: payload.decks?.[i] || [] }));
        if (version === first.scope.version) results.forEach((state, i) => this._rememberState(first.scope, batch[i].value.join(':'), state));
      } else {
        const { action, body, method, ttl, key } = first.value;
        const payload = await this._fetch(first.scope, action, body, method);
        if (ttl) this._metadata.set(key, payload, ttl);
        else this.invalidateState(first.scope, body);
        results = [payload];
      }
      first.scope.failures = 0;
      batch.forEach((item, i) => item.resolve(results[i]));
    } catch (err) {
      if (!this._disposed) this._block(first.scope, err);
      batch.forEach((item) => item.reject(err));
    } finally {
      batch.forEach((item) => { if (this._pending.get(item.key) === item) this._pending.delete(item.key); });
      this._active = false;
      this._schedule(0);
    }
  }

  _splitParse(batch, payload) {
    if (!payload || !Array.isArray(payload.tokens) || payload.tokens.length !== batch.length || !payload.tokens.every(Array.isArray) || !Array.isArray(payload.vocabulary)) throw error('Invalid Jiten parse response', 502);
    const vocabulary = new Map();
    for (const word of payload.vocabulary) {
      if (!word || !Number.isInteger(word.wordId) || !Number.isInteger(word.readingIndex ?? 0)) throw error('Invalid Jiten vocabulary', 502);
      vocabulary.set(wordKey(word), word);
    }
    // Validate all rows before committing any cache entries.
    return batch.map((item, i) => {
      const used = new Map();
      for (const token of payload.tokens[i]) {
        if (!token || !Number.isInteger(token.start) || !Number.isInteger(token.length) || token.start < 0 || token.length < 0 || token.start + token.length > item.value.length || (token.end !== undefined && token.end !== token.start + token.length) || !vocabulary.has(wordKey(token))) throw error('Invalid Jiten token offsets or vocabulary reference', 502);
        used.set(wordKey(token), vocabulary.get(wordKey(token)));
      }
      return { tokens: [payload.tokens[i]], vocabulary: [...used.values()] };
    });
  }
  _rememberState(scope, key, word) {
    this._states.set(`${scope.id}:${key}`, {
      knownState: word.knownState || [0], studyDeckIds: word.studyDeckIds || [],
      refreshAt: Date.now() + this.stateTtlMs,
    }, Math.max(this.ttlMs, this.stateTtlMs));
  }
  invalidateState(scopeOrOptions, body) {
    const scope = scopeOrOptions.id ? scopeOrOptions : this._scope(scopeOrOptions);
    scope.version++;
    const prefix = `${scope.id}:`;
    if (Number.isInteger(body?.wordId)) this._states.delete(`${prefix}${body.wordId}:${body.readingIndex ?? 0}`);
    else for (const key of this._states.entries.keys()) if (key.startsWith(prefix)) this._states.delete(key);
    for (const key of this._metadata.entries.keys()) if (key.startsWith(prefix)) this._metadata.delete(key);
  }
  _block(scope, err) {
    const status = err.statusCode || 503;
    const duration = [401, 403].includes(status) ? Infinity : Math.max(err.retryAfterMs || 0, status === 429 ? 60_000 : Math.min(300_000, 15_000 * 2 ** Math.min(scope.failures, 5)));
    scope.failures++;
    scope.failure = { message: `Jiten requests paused (HTTP ${status})`, statusCode: status };
    scope.blockedUntil = Date.now() + duration;
    this._stats.cooldowns++;
  }

  async _fetch(scope, action, body, method = 'POST') {
    if (typeof this.fetch !== 'function') throw error('Jiten transport is not initialized');
    const url = action === 'reader/parse' ? scope.endpoint : `${deriveJitenApiBase(scope.endpoint)}/${action}`;
    this._controller = new AbortController();
    // Queue time is outside the transport deadline. Short renderer timeouts
    // must not repeatedly abort and resend work still running on the server.
    const timer = setTimeout(() => this._controller?.abort(), 30_000);
    this._stats.upstreamRequests++;
    try {
      const response = await this.fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Api-Key': scope.apiKey, 'X-Client-Name': 'GameSentenceMiner', 'X-Client-Component': 'GSM-Overlay-Broker' },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
        signal: this._controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw error(`Jiten HTTP ${response.status}`, response.status, retryAfterMs(response.headers.get('retry-after')));
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let bytes = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw error('Jiten response too large', 502); }
          chunks.push(Buffer.from(value));
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const payload = raw ? JSON.parse(raw) : { ok: true };
      if (this._disposed) throw error('Jiten broker is closed');
      if (!payload || typeof payload !== 'object' || payload.error_message) throw error('Jiten API returned an error', 502);
      return payload;
    } finally { clearTimeout(timer); this._controller = null; }
  }
  getStats() {
    return { ...this._stats, pending: this._pending.size, cachedParagraphs: this._entries.entries.size, cacheBytes: this._entries.bytes };
  }
  dispose() {
    this._disposed = true;
    clearTimeout(this._timer);
    this._timer = null;
    this._controller?.abort();
    for (const item of this._pending.values()) item.reject(error('Jiten broker is closed'));
    this._pending.clear();
    this._entries.clear();
    this._states.clear();
    this._metadata.clear();
    this._uncertainWrites.clear();
    this._writeReceipts.clear();
    this._scopes.clear();
  }
}

module.exports = { JitenParseCache, DEFAULT_JITEN_PARSE_URL, deriveJitenApiBase, retryAfterMs };
