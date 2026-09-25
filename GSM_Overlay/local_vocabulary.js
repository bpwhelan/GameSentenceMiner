// Network adapters for the Rust vocabulary store. Parsing itself never fetches.
const { createHash } = require('node:crypto');
const { deriveJitenApiBase, DEFAULT_JITEN_PARSE_URL } = require('./jiten_cache');

function sourceId(kind, values) {
  return `${kind}:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function jitenWords(payload) {
  // The backup serializer uses PascalCase for its envelope and compact keys for
  // cards. Accept the API's camelCase envelope too, but never accept a partial export.
  const cards = payload?.cards ?? payload?.Cards;
  const count = payload?.totalCards ?? payload?.TotalCards;
  if (!Array.isArray(cards) || count !== cards.length || cards.length > 250_000) {
    throw new Error('Jiten returned an incomplete vocabulary export');
  }
  return cards.map(card => {
    if (!Number.isSafeInteger(card.w) || card.w <= 0 || !Number.isInteger(card.r) || card.r < 0 || card.r > 255
        || !Number.isInteger(card.s) || card.s < 0 || card.s > 6 || typeof card.t !== 'string' || !card.t.trim()
        || (card.k != null && typeof card.k !== 'string') || !Number.isFinite(card.du)
        || (card.lr != null && !Number.isFinite(card.lr))) {
      throw new Error('Jiten export is missing word text or contains unsupported card data');
    }
    let knownState;
    let dueAt = null;
    if (card.s === 4) knownState = [3]; // FSRS.Blacklisted != KnownState.Blacklisted
    else if (card.s === 5) knownState = [5];
    else if (card.s === 0) knownState = [0];
    else {
      knownState = card.lr == null ? [] : [(card.du - card.lr) / 86400 >= 21 ? 2 : 1];
      if (card.s === 6) knownState.push(7);
      else { dueAt = card.lr == null ? 0 : Math.floor(card.du); if (!knownState.length) knownState.push(4); }
    }
    return { spelling: card.t.trim(), reading: card.k || '', wordId: card.w, readingIndex: card.r, knownState, dueAt };
  });
}

function fieldText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/<(script|style|rt)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/\[sound:[^\]]*\]/g, '').replace(/\[[^\]]*\]/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
      if (name[0] !== '#') return entities[name.toLowerCase()];
      const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }).normalize('NFKC').trim();
}

function ankiWords(cards, { wordField, readingField }, dueIds) {
  const words = new Map();
  let fieldsFound = 0;
  for (const card of cards) {
    if (!card || !Number.isSafeInteger(card.cardId) || !Number.isInteger(card.type)
        || !Number.isInteger(card.queue) || !Number.isFinite(card.interval) || !card.fields) {
      throw new Error('Anki returned incomplete card data');
    }
    if (!card.fields[wordField]) continue; // Other note types need not have this field.
    fieldsFound++;
    const spelling = fieldText(card.fields[wordField].value);
    const reading = readingField ? fieldText(card.fields[readingField]?.value)
      .replace(/[\u30a1-\u30f6]/g, char => String.fromCodePoint(char.codePointAt(0) - 0x60)) : '';
    if (!spelling) continue;
    const tier = card.type === 0 ? 0 : card.type === 2 && card.interval >= 21 ? 2 : 1;
    const knownState = [tier];
    if (card.queue === -1) knownState.push(7);
    else if (dueIds.has(card.cardId) && tier !== 0) knownState.push(4);
    const key = JSON.stringify([spelling, reading]);
    const previous = words.get(key);
    if (!previous || tier > previous.knownState[0]
        || (tier === previous.knownState[0] && previous.knownState.includes(7) && !knownState.includes(7))) {
      words.set(key, { spelling, reading, knownState });
    } else if (tier === previous.knownState[0] && knownState.includes(4) && !previous.knownState.includes(7)
        && !previous.knownState.includes(4)) previous.knownState.push(4);
  }
  if (cards.length && !fieldsFound) throw new Error(`Anki word field "${wordField}" was not found in the selected cards`);
  return [...words.values()];
}

function settings(config) {
  const base = deriveJitenApiBase(config.endpoint || DEFAULT_JITEN_PARSE_URL);
  const anki = { url: config.ankiUrl || 'http://127.0.0.1:8765', query: config.ankiQuery || '',
    wordField: config.wordField || 'Expression', readingField: config.readingField || '' };
  return { base, anki,
    jitenSource: sourceId('jiten', [base, String(config.apiKey || '').trim()]),
    ankiSource: sourceId('anki', [anki.url, config.profile || '', anki.query, anki.wordField, anki.readingField]),
  };
}

class LocalVocabulary {
  constructor({ request, fetch }) {
    this.request = request;
    this.fetch = fetch;
    this.syncs = new Map();
    this.errors = new Map();
    this.revisions = new Map();
    this.controller = new AbortController();
  }
  cancel() {
    this.controller.abort();
    this.controller = new AbortController();
    this.syncs.clear();
  }
  sources(config) {
    const scope = settings(config);
    const sources = [];
    if (config.source !== 'anki' && String(config.apiKey || '').trim()) sources.push(scope.jitenSource);
    if (['anki', 'both'].includes(config.source)) sources.push(scope.ankiSource);
    return sources;
  }
  async parse(texts, config) {
    return this.request({ action: 'parse', texts, sources: this.sources(config) });
  }
  async status(config) {
    const sources = this.sources(config);
    const status = await this.request({ action: 'status', sources });
    return { ...status, errors: sources.map(source => this.errors.get(source)).filter(Boolean) };
  }
  async json(url, init = {}) {
    const response = await this.fetch(url, { ...init, redirect: 'error',
      signal: AbortSignal.any([init.signal || this.controller.signal, AbortSignal.timeout(120_000)]),
      maxResponseBytes: 64 * 1024 * 1024 });
    if (!response.ok) throw new Error(`Vocabulary sync failed (HTTP ${response.status})`);
    return response.json();
  }
  async sync(config) {
    const scope = settings(config);
    const tasks = [];
    if (config.source !== 'anki' && String(config.apiKey || '').trim()) {
      tasks.push(this.syncSource(scope.jitenSource, async signal => jitenWords(await this.json(
        `${scope.base}/user/vocabulary/export?includeWordText=true`,
        { signal, headers: { 'X-Api-Key': String(config.apiKey).trim() } }))));
    }
    if (['anki', 'both'].includes(config.source)) {
      tasks.push(this.syncSource(scope.ankiSource, signal => this.readAnki(scope.anki, signal)));
    }
    if (!tasks.length) throw new Error('Set a Jiten API key or select Anki as your vocabulary source');
    const results = await Promise.allSettled(tasks);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) throw new Error(failed.map(r => r.reason.message).join('; '));
    return this.status(config);
  }
  async syncSource(source, read) {
    if (this.syncs.has(source)) return this.syncs.get(source);
    const revision = this.revisions.get(source) || 0;
    const signal = this.controller.signal;
    const sync = (async () => {
      try {
        const words = await read(signal);
        signal.throwIfAborted();
        if ((this.revisions.get(source) || 0) !== revision) throw new Error('Vocabulary changed during sync; retrying on the next refresh');
        const result = await this.request({ action: 'replace', source, words });
        this.errors.delete(source);
        return result;
      } catch (error) {
        // Transport errors may embed endpoints/credentials. Keep a safe, useful
        // status here; callers can retry without losing the last good snapshot.
        this.errors.set(source, 'Vocabulary refresh failed; the previous local snapshot is still available.');
        throw error;
      } finally { if (this.syncs.get(source) === sync) this.syncs.delete(source); }
    })();
    this.syncs.set(source, sync);
    return sync;
  }
  async readAnki(config, signal) {
    const invoke = async (action, params = {}) => {
      const response = await this.json(config.url, { signal, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params }) });
      if (!response || response.error || !Object.hasOwn(response, 'result')) throw new Error(`Anki ${action} failed`);
      return response.result;
    };
    const ids = await invoke('findCards', { query: config.query });
    const due = await invoke('findCards', { query: `${config.query ? `(${config.query}) ` : ''}is:due` });
    if (!Array.isArray(ids) || !Array.isArray(due) || ids.length > 250_000
        || [...ids, ...due].some(id => !Number.isSafeInteger(id))) throw new Error('Anki returned an invalid card list');
    const cards = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const result = await invoke('cardsInfo', { cards: batch });
      if (!Array.isArray(result) || result.length !== batch.length
          || new Set(result.map(c => c.cardId)).size !== batch.length || result.some(c => !batch.includes(c.cardId))) {
        throw new Error('Anki returned an incomplete card batch');
      }
      cards.push(...result);
    }
    return ankiWords(cards, config, new Set(due));
  }
  async updateJitenStates(args, words) {
    const source = settings(args).jitenSource;
    this.revisions.set(source, (this.revisions.get(source) || 0) + 1);
    return this.request({ action: 'update_states', source, words });
  }
}

// A separate connection leases Sudachi while local mode is enabled. A reconnect
// rejects outstanding work; it never replays a mutation or imports half a list.
class VocabularyConnection {
  constructor({ WebSocket, ensureServer, getPort }) {
    Object.assign(this, { WebSocket, ensureServer, getPort });
    this.pending = new Map(); this.sequence = 0; this.socket = null; this.connecting = null;
    this.generation = 0;
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === this.WebSocket.OPEN && this.ready) return this.socket;
    const generation = this.generation;
    this.connecting = (async () => {
      await this.ensureServer();
      if (generation !== this.generation) throw new Error('Local vocabulary connection closed');
      return new Promise((resolve, reject) => {
        const socket = new this.WebSocket(`ws://127.0.0.1:${this.getPort()}`, { maxPayload: 32 * 1024 * 1024 });
        this.socket = socket;
        this.ready = false;
        const timer = setTimeout(() => { reject(new Error('Input server connection timed out')); socket.terminate(); }, 10_000);
        socket.on('open', () => {
          socket.send(JSON.stringify({ type: 'configure_features', features: ['sudachi'] }));
        });
        socket.on('message', data => {
          let message; try { message = JSON.parse(String(data)); } catch { return; }
          if (message.type === 'service_info') {
            clearTimeout(timer);
            if (message.vocabularyProtocol !== 1) {
              reject(new Error('The Rust input server needs to be rebuilt or updated for local vocabulary'));
              socket.close();
            } else { this.ready = true; resolve(socket); }
            return;
          }
          if (message.type !== 'local_vocabulary') return;
          const pending = this.pending.get(message.requestId);
          if (!pending) return;
          this.pending.delete(message.requestId); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
        });
        socket.on('error', () => { clearTimeout(timer); reject(new Error('Input server is unavailable')); });
        socket.on('close', () => {
          clearTimeout(timer); reject(new Error('Input server disconnected'));
          if (this.socket === socket) { this.socket = null; this.ready = false; }
          for (const [id, pending] of this.pending) {
            if (pending.socket !== socket) continue;
            clearTimeout(pending.timer); pending.reject(new Error('Input server disconnected')); this.pending.delete(id);
          }
        });
      });
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async request(request) {
    const generation = this.generation;
    const socket = await this.connect();
    if (generation !== this.generation) throw new Error('Local vocabulary connection closed');
    if (this.pending.size >= 32) throw new Error('Too many local vocabulary requests');
    const requestId = `vocabulary-${++this.sequence}`;
    const message = JSON.stringify({ type: 'local_vocabulary', requestId, request });
    if (Buffer.byteLength(message) > 32 * 1024 * 1024) throw new Error('Vocabulary request is too large');
    return new Promise((resolve, reject) => {
      // First use may download Sudachi's verified dictionary.
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Local vocabulary request timed out; check the Rust server version and dictionary download')); }, 180_000);
      this.pending.set(requestId, { resolve, reject, timer, socket });
      socket.send(message, error => {
        if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('Input server send failed')); }
      });
    });
  }
  close() { this.generation++; this.socket?.close(); this.socket = null; this.ready = false; }
}

module.exports = { LocalVocabulary, VocabularyConnection, jitenWords, ankiWords, sourceId };
