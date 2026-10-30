// Network adapters for the Rust vocabulary store. Parsing itself never fetches.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deriveJitenApiBase, DEFAULT_JITEN_PARSE_URL } = require('./jiten_cache');

// GSM_UNVOICED: tag whose notes get the blue dashed underline.
const UNVOICED_TAG = 'unvoiced';

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

// GSM_ANKISTATES_FIXED_V2: normalize common Jiten furigana forms to kana.
function plainReading(reading) {
  return String(reading || '').replace(/([\u4e00-\u9fff\u3005]+)\[([^\]]*)\]/g, '$2')
    .replace(/[\s\[\]]/g, '').normalize('NFKC');
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

// GSM_ANKI_POPUP_GRADING_V1: normalize Yomitan headwords/readings against Anki fields.
function normalizePopupSpelling(value) {
  return fieldText(value).normalize('NFKC').trim();
}

function normalizePopupReading(value) {
  return plainReading(fieldText(value))
    .replace(/[\u30a1-\u30f6]/g, char => String.fromCodePoint(char.codePointAt(0) - 0x60))
    .replace(/\s+/g, '')
    .normalize('NFKC');
}

function escapeAnkiSearchValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/([*_()])/g, '\\$1')
    .replace(/:/g, '\\:')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ankiFieldContainsQuery(fieldName, value) {
  const field = String(fieldName || '').trim();
  const escaped = escapeAnkiSearchValue(value);
  const expression = `${field}:*${escaped}*`;
  // Anki requires the whole field search to be quoted when either the field
  // name or search value contains whitespace.
  return /\s/u.test(expression) ? `"${expression}"` : expression;
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
  constructor({ request, fetch, unvoicedCachePath = '' }) {
    this.request = request;
    this.fetch = fetch;
    this.unvoicedCachePath = unvoicedCachePath;
    this.syncs = new Map();
    this.errors = new Map();
    this.revisions = new Map();
    this.controller = new AbortController();
    this.unvoiced = { words: new Set(), status: { tag: UNVOICED_TAG, notes: 0, words: 0, missingField: 0, error: 'not synced yet', at: 0 } };
    // GSM_TAGRULES: the old unvoiced-only disk cache is obsolete; one unified cache is used instead.
    this.tagRules = [];          // validated rules, same order as the config file
    this.tagSets = new Map();    // tag -> Set(spelling)
    this.tagStatus = new Map();  // tag -> { notes, words, missingField, error, at }
    this.cardIndex = new Map();  // cardId -> { note, spelling, reading } (light index; no card payloads kept)
    this.cardIndexConfigKey = ''; // Active Anki search/field scope used to build cardIndex.
    this.ankiPopupStateOverrides = new Map(); // spelling -> { state, revision }; targeted mutations outrank older snapshots.
    this.ankiPopupStateRevision = 0;
    // GSM_ANKI_POPUP_GRADING_V1: local-only Blacklist / Never Forget flags.
    this.popupGradingFlagsPath = '';
    this.popupGradingFlags = new Map(); // normalized spelling -> { spelling, reading, flag, updatedAt }
    this.displayCache = { path: '', savedAt: 0, loadedAt: 0 };
  }
  loadUnvoicedCache() {
    if (!this.unvoicedCachePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.unvoicedCachePath, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.words) || saved.words.length > 100_000) return;
      const words = new Set(saved.words.filter(word => typeof word === 'string' && word.trim()).map(word => word.normalize('NFKC').trim()));
      this.unvoiced = { words, status: { tag: UNVOICED_TAG, notes: Number.isSafeInteger(saved.notes) ? saved.notes : 0,
        words: words.size, missingField: Number.isSafeInteger(saved.missingField) ? saved.missingField : 0,
        error: '', at: Number.isFinite(saved.at) ? saved.at : 0, source: 'disk-cache' } };
    } catch { /* First run or invalid cache: wait for Anki refresh. */ }
  }
  saveUnvoicedCache(words, status) {
    if (!this.unvoicedCachePath) return;
    const payload = JSON.stringify({ version: 1, at: status.at, notes: status.notes, missingField: status.missingField, words: [...words] });
    fs.mkdir(path.dirname(this.unvoicedCachePath), { recursive: true }, error => {
      if (error) return;
      fs.writeFile(this.unvoicedCachePath, payload, 'utf8', () => {});
    });
  }
  // ---- GSM_TAGRULES ---------------------------------------------------------------
  setTagRules(rules) {
    this.tagRules = Array.isArray(rules) ? rules : [];
    const active = new Set(this.activeTags());
    for (const tag of [...this.tagSets.keys()]) {
      if (!active.has(tag)) { this.tagSets.delete(tag); this.tagStatus.delete(tag); }
    }
  }
  activeTags() { return [...new Set(this.tagRules.filter(rule => rule.enabled).map(rule => rule.tag))]; }
  tagRuleIndexes(spelling) {
    const keys = this.ankiKeyCandidates(spelling);
    const result = [];
    this.tagRules.forEach((rule, index) => {
      if (rule.enabled && keys.some(key => this.tagSets.get(rule.tag)?.has(key))) result.push(index);
    });
    return result;
  }
  // GSM_SURUSTEM: Jiten lists suru-verbs as "反省する" while Anki often holds the noun "反省".
  // Keys to try, exact first. The stem must be 2+ characters (愛する is not matched to 愛).
  ankiKeyCandidates(spelling) {
    const key = String(spelling || '').normalize('NFKC').trim();
    const keys = [key];
    if (key.length >= 4 && key.endsWith('する')) keys.push(key.slice(0, -2));
    return keys;
  }
  hasTaggedSpelling(spelling) {
    for (const key of this.ankiKeyCandidates(spelling)) {
      for (const set of this.tagSets.values()) if (set.has(key)) return true;
    }
    return false;
  }
  ankiCardIndexKey(anki) {
    const config = anki || {};
    return JSON.stringify([
      config.url || 'http://127.0.0.1:8765',
      config.query || '',
      config.wordField || 'Expression',
      config.readingField || '',
    ]);
  }
  indexCards(cards, wordField, readingField, configKey) {
    const index = new Map();
    for (const card of cards) {
      if (!Number.isSafeInteger(card?.cardId)) continue;
      const field = card?.fields?.[wordField];
      const reading = readingField ? card?.fields?.[readingField] : null;
      index.set(card.cardId, {
        note: Number.isSafeInteger(card.note) ? card.note : card.cardId,
        spelling: field ? normalizePopupSpelling(field.value) : '',
        reading: reading ? normalizePopupReading(reading.value) : '',
      });
    }
    this.cardIndex = index;
    this.cardIndexConfigKey = configKey || '';
  }
  ankiInvoker(url, signal) {
    return async (action, params = {}) => {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await this.json(url, { signal, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
            body: JSON.stringify({ action, version: 6, params }) });
          if (!response || response.error || !Object.hasOwn(response, 'result')) {
            const apiError = new Error(`Anki ${action} failed: ${response?.error ? String(response.error).slice(0, 140) : 'invalid response'}`);
            apiError.noRetry = true;
            throw apiError;
          }
          return response.result;
        } catch (error) {
          lastError = error;
          const text = `${error?.code || ''} ${error?.message || ''}`;
          if (error?.noRetry || signal.aborted || !/ECONNRESET|EPIPE|socket hang up/i.test(text) || attempt === 3) break;
          await new Promise(resolve => setTimeout(resolve, 350 * attempt));
        }
      }
      throw new Error(`Anki ${action}: ${String(lastError?.message || lastError)}`.slice(0, 200));
    };
  }
  // One findCards per active tag; card IDs are resolved through the light card index.
  // Only cards missing from the index (outside the display query, or added since the
  // last full pass) are fetched. A tag keeps its previous set if its refresh fails.
  async refreshTagSets(config, invokeArg) {
    const tags = this.activeTags();
    if (!tags.length) return;
    const wordField = config.wordField || 'Expression';
    const invoke = invokeArg || this.ankiInvoker(config.url || 'http://127.0.0.1:8765', this.controller.signal);
    for (const tag of tags) {
      const status = { notes: 0, words: 0, missingField: 0, error: '', at: Date.now() };
      try {
        const ids = await invoke('findCards', { query: `tag:${tag}` });
        if (!Array.isArray(ids) || ids.length > 250_000 || ids.some(id => !Number.isSafeInteger(id))) {
          throw new Error('Anki returned an invalid card list');
        }
        const missing = ids.filter(id => !this.cardIndex.has(id));
        const fetched = new Map();
        for (let offset = 0; offset < missing.length; offset += 50) {
          const result = await invoke('cardsInfo', { cards: missing.slice(offset, offset + 50) });
          if (!Array.isArray(result)) throw new Error('Anki returned invalid cardsInfo data');
          for (const card of result) {
            if (!Number.isSafeInteger(card?.cardId)) continue;
            const field = card?.fields?.[wordField];
            fetched.set(card.cardId, { note: Number.isSafeInteger(card.note) ? card.note : card.cardId,
              spelling: field ? fieldText(field.value) : '' });
          }
        }
        const notes = new Map();
        for (const id of ids) {
          const entry = this.cardIndex.get(id) || fetched.get(id);
          if (!entry) throw new Error('A tagged card could not be resolved');
          if (!notes.has(entry.note)) notes.set(entry.note, entry.spelling);
        }
        const words = new Set();
        for (const spelling of notes.values()) {
          const text = String(spelling || '').normalize('NFKC').trim();
          if (text) words.add(text); else status.missingField++;
        }
        status.notes = notes.size;
        status.words = words.size;
        this.tagSets.set(tag, words);
      } catch (error) {
        status.error = String(error?.message || error).slice(0, 200);
        status.words = this.tagSets.get(tag)?.size ?? 0;
      }
      this.tagStatus.set(tag, status);
    }
  }
  async syncTagRulesOnly(config) {
    const anki = settings(config).anki;
    await this.refreshTagSets(anki);
    this.saveDisplayCache(config);
  }
  displayCacheKey(config) {
    const anki = settings(config).anki;
    return createHash('sha256').update(JSON.stringify([anki.url, anki.wordField, anki.readingField, anki.query])).digest('hex').slice(0, 16);
  }
  loadDisplayCache(config, cachePath) {
    this.displayCache.path = cachePath;
    try {
      const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (saved?.version !== 1 || saved.key !== this.displayCacheKey(config)) return false;
      if (!Array.isArray(saved.states) || saved.states.length > 250_000) return false;
      const map = new Map();
      for (const entry of saved.states) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0] || !Array.isArray(entry[1])) continue;
        const state = entry[1].filter(n => Number.isInteger(n) && n >= 0 && n <= 7);
        if (state.length) map.set(entry[0], state);
      }
      if (!map.size) return false;
      this.ankiStateMap = map;
      this.ankiStatesAt = Number.isFinite(saved.at) ? saved.at : 0;
      this.tagSets = new Map();
      for (const [tag, words] of Object.entries(saved.tags && typeof saved.tags === 'object' ? saved.tags : {})) {
        if (!Array.isArray(words)) continue;
        this.tagSets.set(tag, new Set(words.filter(word => typeof word === 'string' && word)));
      }
      this.displayCache.loadedAt = Date.now();
      return true;
    } catch { return false; }
  }
  saveDisplayCache(config) {
    const target = this.displayCache.path;
    if (!target || !(this.ankiStateMap instanceof Map) || !this.ankiStateMap.size) return;
    const payload = JSON.stringify({ version: 1, key: this.displayCacheKey(config), at: Date.now(),
      states: [...this.ankiStateMap],
      tags: Object.fromEntries([...this.tagSets].map(([tag, set]) => [tag, [...set]])) });
    const temp = `${target}.tmp`;
    fs.mkdir(path.dirname(target), { recursive: true }, (mkdirError) => {
      if (mkdirError) return;
      fs.writeFile(temp, payload, 'utf8', (writeError) => {
        if (writeError) return;
        fs.rename(temp, target, (renameError) => { if (!renameError) this.displayCache.savedAt = Date.now(); });
      });
    });
  }
  updateUnvoicedFromCardIds(cards, taggedCardIds, wordField) {
    // findCards can search by tag even when cardsInfo omits tags. Match those
    // IDs against the card details already fetched for the display-state pass.
    const cardsById = new Map(cards.map(card => [card?.cardId, card]));
    const taggedNotes = new Map();
    for (const cardId of taggedCardIds) {
      const card = cardsById.get(cardId);
      // If the display-state query was supposed to cover the full collection
      // but a tagged ID is absent, do not replace a good cache with partial data.
      if (!card || !Number.isSafeInteger(card.note)) return { ...this.unvoiced.status };
      if (taggedNotes.has(card.note)) continue;
      const field = card?.fields?.[wordField];
      taggedNotes.set(card.note, field ? fieldText(field.value) : '');
    }
    const words = new Set();
    let missingField = 0;
    for (const spelling of taggedNotes.values()) {
      if (spelling) words.add(spelling);
      else missingField++;
    }
    const status = { tag: UNVOICED_TAG, notes: taggedNotes.size, words: words.size,
      missingField, error: '', at: Date.now(), source: 'findCards' };
    this.unvoiced = { words, status };
    this.saveUnvoicedCache(words, status);
    return status;
  }
  // GSM_UNVOICED: if the display-state pass already resolved the tag IDs,
  // no separate notesInfo pass is needed.
  async syncUnvoiced(config) {
    if (!String(config.ankiQuery || '').trim() && this.unvoiced?.status?.source === 'findCards'
        && !this.unvoiced.status.error) {
      return { ...this.unvoiced.status };
    }
    const url = config.ankiUrl || 'http://127.0.0.1:8765';
    const wordField = config.wordField || 'Expression';
    const status = { tag: UNVOICED_TAG, notes: 0, words: 0, missingField: 0, error: '', at: Date.now() };
    try {
      const signal = this.controller.signal;
      const invoke = async (action, params = {}) => {
        let response;
        let lastError;
        // AnkiConnect can reset the local HTTP socket on larger or transient
        // requests. Retry only transport resets; never replay an API-level error.
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            response = await this.json(url, { signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'Connection': 'close' /* GSM_ANKICLOSE */ },
              body: JSON.stringify({ action, version: 6, params }) });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            const detail = `${error?.code || ''} ${error?.message || error}`;
            if (signal.aborted || !/ECONNRESET|EPIPE|socket hang up/i.test(detail) || attempt === 3) break;
            await new Promise(resolve => setTimeout(resolve, 350 * attempt));
          }
        }
        if (lastError) {
          const batchSize = Array.isArray(params.notes) ? params.notes.length
            : Array.isArray(params.cards) ? params.cards.length : null;
          throw new Error(`Anki ${action}${batchSize === null ? '' : ` (${batchSize} items)`} request failed: ${String(lastError?.message || lastError).slice(0, 120)}`);
        }
        if (!response || response.error || !Object.hasOwn(response, 'result')) {
          const detail = response?.error ? String(response.error).slice(0, 140) : 'invalid response';
          throw new Error(`Anki ${action} failed: ${detail}`);
        }
        return response.result;
      };
      // Prefer findNotes, but some AnkiConnect setups can return an empty note
      // list even when the same search visibly matches cards in Browse. Fall back
      // to finding cards and resolving their unique note IDs through cardsInfo.
      let ids = null;
      let findNotesError = '';
      try {
        ids = await invoke('findNotes', { query: `tag:${UNVOICED_TAG}` });
        if (!Array.isArray(ids) || ids.length > 100_000 || ids.some(id => !Number.isSafeInteger(id))) {
          throw new Error('Anki returned an invalid note list');
        }
      } catch (error) {
        findNotesError = String(error?.message || error).slice(0, 120);
        ids = null;
      }
      if (!ids || ids.length === 0) {
        const cardIds = await invoke('findCards', { query: `tag:${UNVOICED_TAG}` });
        if (!Array.isArray(cardIds) || cardIds.length > 250_000 || cardIds.some(id => !Number.isSafeInteger(id))) {
          throw new Error(`findNotes returned no notes${findNotesError ? ` (${findNotesError})` : ''}; findCards returned an invalid card list`);
        }
        const uniqueNotes = new Set();
        for (let offset = 0; offset < cardIds.length; offset += 50) {
          const cards = await invoke('cardsInfo', { cards: cardIds.slice(offset, offset + 50) });
          if (!Array.isArray(cards)) throw new Error('Anki returned invalid cardsInfo data while resolving unvoiced tags');
          for (const card of cards) if (Number.isSafeInteger(card?.note)) uniqueNotes.add(card.note);
        }
        ids = [...uniqueNotes];
        if (!ids.length && cardIds.length) throw new Error('findCards found tagged cards, but cardsInfo did not return note IDs');
      }
      const words = new Set();
      for (let offset = 0; offset < ids.length; offset += 10) {
        const notes = await invoke('notesInfo', { notes: ids.slice(offset, offset + 10) });
        if (!Array.isArray(notes)) throw new Error('Anki returned invalid note data');
        for (const note of notes) {
          status.notes++;
          const field = note?.fields?.[wordField];
          if (!field) { status.missingField++; continue; }
          const spelling = fieldText(field.value);
          if (spelling) words.add(spelling);
        }
      }
      status.words = words.size;
      status.source = 'notesInfo';
      this.unvoiced = { words, status };
      this.saveUnvoicedCache(words, status);
    } catch (error) {
      // Keep the last good word list; just report why the refresh failed.
      status.error = String(error?.message || error).slice(0, 200);
      status.words = this.unvoiced.words.size;
      this.unvoiced = { words: this.unvoiced.words, status };
    }
    return status;
  }
  // Flags tokens in a Rust parse result: headword match, or (for words of 3+
  // characters, e.g. expressions Sudachi splits) any token overlapping the word's
  // occurrence in the block text.
  markUnvoiced(texts, result) {
    const words = this.unvoiced.words;
    if (!words.size || !Array.isArray(result?.tokens)) return 0;
    const phrases = [...words].filter(word => [...word].length >= 3);
    let marked = 0;
    result.tokens.forEach((tokens, i) => {
      if (!Array.isArray(tokens)) return;
      const text = String(texts?.[i] ?? '');
      const ranges = [];
      for (const phrase of phrases) {
        for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + phrase.length)) {
          ranges.push([at, at + phrase.length]);
        }
      }
      for (const token of tokens) {
        if (!token || typeof token !== 'object') continue;
        if (words.has(token.headword) || ranges.some(([s, e]) => token.start < e && token.end > s)) {
          token.unvoiced = true;
          marked++;
        }
      }
    });
    return marked;
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
    const invokeOnce = async (action, params = {}) => { // GSM_ANKIRETRY
      const response = await this.json(config.url, { signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'Connection': 'close' /* GSM_ANKICLOSE */ },
        body: JSON.stringify({ action, version: 6, params }) });
      if (!response || response.error || !Object.hasOwn(response, 'result')) throw new Error(`Anki ${action} failed`);
      return response.result;
    };
    const invoke = async (action, params = {}) => {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { return await invokeOnce(action, params); }
        catch (error) {
          lastError = error;
          const text = `${error?.code || ''} ${error?.message || ''}`;
          if (signal.aborted || !/ECONNRESET|EPIPE|socket hang up/i.test(text)) break;
          await new Promise(resolve => setTimeout(resolve, 400 * attempt));
        }
      }
      const where = action === 'cardsInfo' ? ` (${params.cards?.length || 0} cards)` : '';
      throw new Error(`Anki ${action}${where}: ${String(lastError?.message || lastError)}`.slice(0, 200));
    };
    // The collection search and due search are independent AnkiConnect calls.
    const [ids, due] = await Promise.all([
      invoke('findCards', { query: config.query }),
      invoke('findCards', { query: `${config.query ? `(${config.query}) ` : ''}is:due` }),
    ]);
    if (!Array.isArray(ids) || !Array.isArray(due) || ids.length > 250_000
        || [...ids, ...due].some(id => !Number.isSafeInteger(id))) throw new Error('Anki returned an invalid card list');
    // Keep cardsInfo payloads modest: AnkiConnect may reset the connection on
    // large responses. A small bounded worker pool still reduces total latency.
    const cardBatchSize = 100;
    const batches = [];
    for (let offset = 0; offset < ids.length; offset += cardBatchSize) {
      batches.push(ids.slice(offset, offset + cardBatchSize));
    }
    const cardResults = new Array(batches.length);
    let nextBatch = 0;
    const fetchCardBatches = async () => {
      while (true) {
        const index = nextBatch++;
        if (index >= batches.length) return;
        const batch = batches[index];
        const result = await invoke('cardsInfo', { cards: batch });
      if (!Array.isArray(result) || result.length !== batch.length
          || new Set(result.map(c => c.cardId)).size !== batch.length || result.some(c => !batch.includes(c.cardId))) {
        throw new Error('Anki returned an incomplete card batch');
      }
        cardResults[index] = result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(1, batches.length) }, fetchCardBatches));
    const cards = cardResults.flat();
    // GSM_TAGRULES: keep a light cardId -> {note, spelling} index; every configured tag is
    // resolved from it with one findCards request each (no second cardsInfo pass).
    this.indexCards(cards, config.wordField || 'Expression', config.readingField || '', this.ankiCardIndexKey(config));
    try { await this.refreshTagSets(config, invoke); } catch { /* per-tag errors are recorded; states still load */ }
    return ankiWords(cards, config, new Set(due));
  }
  // GSM_ANKISTATES_FIXED_V2: read Anki directly for display states, without enabling Sudachi parsing.
  async syncAnkiStates(config) {
    const targetedRevisionAtStart = this.ankiPopupStateRevision || 0;
    const words = await this.readAnki(settings(config).anki, this.controller.signal);
    const map = new Map();
    for (const word of words) {
      const spelling = String(word.spelling || '').normalize('NFKC').trim();
      if (!spelling) continue;
      const previous = map.get(spelling);
      const state = word.knownState || [0];
      if (!previous || state[0] > previous[0]
          || (state[0] === previous[0] && previous.includes(7) && !state.includes(7))) map.set(spelling, state.slice());
      else if (state[0] === previous[0] && state.includes(4) && !previous.includes(7) && !previous.includes(4)) previous.push(4);
    }
    // Do not let a collection snapshot that began before a popup review overwrite
    // the newer targeted result. A snapshot started after the mutation is allowed
    // to supersede that temporary override normally.
    if (!(this.ankiPopupStateOverrides instanceof Map)) this.ankiPopupStateOverrides = new Map();
    for (const [spelling, override] of [...this.ankiPopupStateOverrides]) {
      const revision = Number.isSafeInteger(override?.revision) ? override.revision : 0;
      const state = Array.isArray(override?.state) ? override.state : (Array.isArray(override) ? override : null);
      if (revision > targetedRevisionAtStart && state) {
        map.set(spelling, state.slice());
      } else {
        this.ankiPopupStateOverrides.delete(spelling);
      }
    }
    this.ankiStateMap = map;
    this.ankiStatesError = '';
    this.saveDisplayCache(config); // GSM_TAGRULES
    return map.size;
  }
  // GSM_ANKI_POPUP_GRADING_V1: these flags are stored in GSM's data directory,
  // not sent to Jiten and not written into Anki note fields or tags.
  loadPopupGradingFlags(filePath = this.popupGradingFlagsPath) {
    if (filePath) this.popupGradingFlagsPath = filePath;
    if (!this.popupGradingFlagsPath) return 0;
    try {
      const saved = JSON.parse(fs.readFileSync(this.popupGradingFlagsPath, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.flags) || saved.flags.length > 100_000) return 0;
      const flags = new Map();
      for (const item of saved.flags) {
        const spelling = normalizePopupSpelling(item?.spelling);
        const flag = item?.flag;
        if (!spelling || !['blacklist', 'neverForget'].includes(flag)) continue;
        flags.set(spelling, {
          spelling,
          reading: normalizePopupReading(item?.reading || ''),
          flag,
          updatedAt: Number.isFinite(item?.updatedAt) ? item.updatedAt : 0,
        });
      }
      this.popupGradingFlags = flags;
    } catch { /* First run or a missing/invalid optional file. */ }
    return this.popupGradingFlags.size;
  }
  savePopupGradingFlags() {
    if (!this.popupGradingFlagsPath) throw new Error('GSM popup grading flag path is not configured');
    const payload = JSON.stringify({
      version: 1,
      flags: [...this.popupGradingFlags.values()],
    }, null, 2) + '\n';
    fs.mkdirSync(path.dirname(this.popupGradingFlagsPath), { recursive: true });
    const temp = `${this.popupGradingFlagsPath}.tmp`;
    fs.writeFileSync(temp, payload, 'utf8');
    fs.renameSync(temp, this.popupGradingFlagsPath);
  }
  popupGradingFlag(spelling) {
    for (const candidate of this.ankiKeyCandidates(normalizePopupSpelling(spelling))) {
      const flag = this.popupGradingFlags.get(candidate);
      if (flag) return flag;
    }
    return null;
  }
  setPopupGradingFlag(spelling, reading, flag, action = 'add') {
    const normalized = normalizePopupSpelling(spelling);
    if (!normalized) throw new Error('A word is required for a local flag');
    if (normalized.length > 256) throw new Error('The selected word is too long');
    if (!['blacklist', 'neverForget'].includes(flag)) throw new Error('Unknown local flag');
    if (!['add', 'remove'].includes(action)) throw new Error('Unknown local flag action');
    if (action === 'remove') {
      this.popupGradingFlags.delete(normalized);
    } else {
      this.popupGradingFlags.set(normalized, {
        spelling: normalized,
        reading: normalizePopupReading(reading),
        flag,
        updatedAt: Date.now(),
      });
    }
    this.savePopupGradingFlags();
    return { spelling: normalized, reading: normalizePopupReading(reading), flag, action };
  }
  async gradePopupWord(config, { term, reading, ease } = {}) {
    const spelling = normalizePopupSpelling(term);
    const rating = Number(ease);
    if (!spelling) throw new Error('The selected Yomitan entry has no headword');
    if (spelling.length > 256) throw new Error('The selected headword is too long');
    if (!Number.isInteger(rating) || rating < 1 || rating > 4) throw new Error('Invalid Anki rating');

    const anki = settings(config || {}).anki;
    const wordField = String(anki.wordField || 'Expression').trim();
    const readingField = String(anki.readingField || '').trim();
    if (!wordField) throw new Error('The Anki word field is not configured');

    const expectedReading = normalizePopupReading(reading);
    let matches = [];
    let usedCardIndex = false;

    // The regular Anki snapshot already contains the exact card IDs and field
    // values for the active search scope. Use it first so a popup grade can go
    // straight to answerCards instead of repeating findCards + cardsInfo.
    if (this.cardIndex instanceof Map
        && this.cardIndex.size > 0
        && this.cardIndexConfigKey === this.ankiCardIndexKey(anki)) {
      for (const [cardId, entry] of this.cardIndex) {
        if (entry?.spelling !== spelling) continue;
        if (readingField && expectedReading && entry.reading !== expectedReading) continue;
        matches.push(cardId);
      }
      usedCardIndex = matches.length > 0;
    }

    const controller = new AbortController();
    const invoke = this.ankiInvoker(anki.url || 'http://127.0.0.1:8765', controller.signal);
    try {
      // If the cache is cold, stale, or the word was just added, fall back to
      // Anki's live search and validate the configured fields exactly as before.
      if (!matches.length) {
        const searchParts = [];
        const scope = String(anki.query || '').trim();
        if (scope) searchParts.push(`(${scope})`);
        searchParts.push(ankiFieldContainsQuery(wordField, spelling));
        const query = searchParts.join(' ');
        const ids = await invoke('findCards', { query });
        if (!Array.isArray(ids) || ids.length > 20_000 || ids.some(id => !Number.isSafeInteger(id))) {
          throw new Error('Anki returned an invalid or excessively large matching-card list');
        }
        if (!ids.length) {
          throw new Error(`No Anki cards were found for "${spelling}" in field "${wordField}". Check the active Anki search and word-field settings.`);
        }

        matches = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100);
          const cards = await invoke('cardsInfo', { cards: batch });
          if (!Array.isArray(cards) || cards.length !== batch.length
              || new Set(cards.map(card => card?.cardId)).size !== batch.length
              || cards.some(card => !batch.includes(card?.cardId))) {
            throw new Error('Anki returned incomplete card details while matching the selected word');
          }
          for (const card of cards) {
            const cardSpelling = card?.fields?.[wordField]
              ? normalizePopupSpelling(card.fields[wordField].value) : '';
            if (cardSpelling !== spelling) continue;
            if (readingField && expectedReading) {
              const cardReading = card?.fields?.[readingField]
                ? normalizePopupReading(card.fields[readingField].value) : '';
              if (cardReading !== expectedReading) continue;
            }
            matches.push(card.cardId);
          }
        }
      }

      if (!matches.length) {
        const readingHint = readingField && expectedReading ? ` and reading "${reading}" in field "${readingField}"` : '';
        throw new Error(`No exact Anki card match for "${spelling}"${readingHint}.`);
      }
      if (matches.length > 100) {
        throw new Error(`This headword matches ${matches.length} Anki cards. Narrow the GSM Anki search before grading it (maximum 100 cards per click).`);
      }

      const answers = matches.map(cardId => ({ cardId, ease: rating }));
      const result = await invoke('answerCards', { answers });
      if (!Array.isArray(result) || result.length !== answers.length || result.some(value => value !== true)) {
        throw new Error('Anki did not confirm that every matching card was graded');
      }
      return {
        term: spelling,
        reading: expectedReading,
        ease: rating,
        matchedCards: matches.length,
        matchedCardIds: matches.slice(),
        usedCardIndex,
      };
    } finally {
      controller.abort();
    }
  }
  // GSM_ANKI_POPUP_TARGETED_REFRESH_V1: refresh one headword without scanning the collection.
  // The display-state map is keyed by spelling (not reading), so all exact cards
  // for this spelling are aggregated just as syncAnkiStates() aggregates them.
  async refreshAnkiStateForPopupWord(config, { term, reading, cardIds } = {}) {
    const spelling = normalizePopupSpelling(term);
    if (!spelling) throw new Error('A Yomitan headword is required for a targeted Anki refresh');
    if (spelling.length > 256) throw new Error('The Yomitan headword is too long');

    const anki = settings(config || {}).anki;
    const wordField = String(anki.wordField || 'Expression').trim();
    const readingField = String(anki.readingField || '').trim();
    if (!wordField) throw new Error('The Anki word field is not configured');

    const searchParts = [];
    const scope = String(anki.query || '').trim();
    if (scope) searchParts.push(`(${scope})`);
    searchParts.push(ankiFieldContainsQuery(wordField, spelling));
    const query = searchParts.join(' ');

    const controller = new AbortController();
    const invoke = this.ankiInvoker(anki.url || 'http://127.0.0.1:8765', controller.signal);
    try {
      // A review has already resolved the exact card IDs. Widen them from the
      // current in-memory index to include other readings of the same spelling,
      // preserving syncAnkiStates()' spelling-level aggregation semantics.
      let knownIds = [];
      if (Array.isArray(cardIds)) {
        const valid = cardIds.filter(id => Number.isSafeInteger(id) && id > 0);
        const unique = new Set(valid);
        if (this.cardIndex instanceof Map
            && this.cardIndexConfigKey === this.ankiCardIndexKey(anki)) {
          for (const [id, entry] of this.cardIndex) {
            if (entry?.spelling === spelling) unique.add(id);
          }
        }
        knownIds = [...unique];
        if (knownIds.length > 20_000) throw new Error('Too many cards share this spelling for a targeted refresh');
      }

      let exactCards = [];
      let dueIds = new Set();

      const getCardDetails = async (ids) => {
        const cards = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100);
          const result = await invoke('cardsInfo', { cards: batch });
          if (!Array.isArray(result) || result.length !== batch.length
              || new Set(result.map(card => card?.cardId)).size !== batch.length
              || result.some(card => !batch.includes(card?.cardId))) {
            throw new Error('Anki returned incomplete targeted card details');
          }
          cards.push(...result);
        }
        return cards;
      };
      const cardIdSearch = ids => `cid:${ids.join(',')}`;

      if (knownIds.length > 0) {
        // Just two local AnkiConnect requests, made concurrently. No headword
        // search is needed after answerCards has already identified the cards.
        const [cards, due] = await Promise.all([
          getCardDetails(knownIds),
          invoke('findCards', { query: `${cardIdSearch(knownIds)} is:due` }),
        ]);
        exactCards = cards.filter(card => (
          card?.fields?.[wordField]
          && normalizePopupSpelling(card.fields[wordField].value) === spelling
        ));
        dueIds = new Set(Array.isArray(due) ? due : []);
      } else {
        // New mined words do not have cached card IDs, so resolve their scoped
        // Anki search once, then use cid:... for the due check instead of
        // repeating the potentially broad field search.
        for (let attempt = 0; attempt < 3; attempt++) {
          const ids = await invoke('findCards', { query });
          if (!Array.isArray(ids) || ids.length > 20_000 || ids.some(id => !Number.isSafeInteger(id))) {
            throw new Error('Anki returned an invalid targeted card list');
          }
          if (!ids.length) {
            exactCards = [];
          } else {
            const [cards, due] = await Promise.all([
              getCardDetails(ids),
              invoke('findCards', { query: `${cardIdSearch(ids)} is:due` }),
            ]);
            exactCards = cards.filter(card => (
              card?.fields?.[wordField]
              && normalizePopupSpelling(card.fields[wordField].value) === spelling
            ));
            dueIds = new Set(Array.isArray(due) ? due : []);
          }
          if (exactCards.length > 0) break;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
        }
      }

      if (exactCards.length === 0) {
        return {
          updated: false,
          term: spelling,
          reading: normalizePopupReading(reading),
          matchedCards: 0,
          error: `Anki has not returned an exact card match for "${spelling}" yet.`,
        };
      }

      let mergedState = null;
      for (const card of exactCards) {
        if (!Number.isSafeInteger(card?.cardId) || !Number.isInteger(card.type)
            || !Number.isInteger(card.queue) || !Number.isFinite(card.interval)) {
          throw new Error('Anki returned incomplete scheduling data for the targeted card');
        }
        const tier = card.type === 0 ? 0 : card.type === 2 && card.interval >= 21 ? 2 : 1;
        const state = [tier];
        if (card.queue === -1) state.push(7);
        else if (dueIds.has(card.cardId) && tier !== 0) state.push(4);

        if (!mergedState || tier > mergedState[0]
            || (tier === mergedState[0] && mergedState.includes(7) && !state.includes(7))) {
          mergedState = state;
        } else if (tier === mergedState[0] && state.includes(4)
            && !mergedState.includes(7) && !mergedState.includes(4)) {
          mergedState.push(4);
        }

        if (!(this.cardIndex instanceof Map)) this.cardIndex = new Map();
        const readingValue = readingField ? card?.fields?.[readingField]?.value : '';
        this.cardIndex.set(card.cardId, {
          note: Number.isSafeInteger(card.note) ? card.note : card.cardId,
          spelling,
          reading: readingValue ? normalizePopupReading(readingValue) : '',
        });
      }
      this.cardIndexConfigKey = this.ankiCardIndexKey(anki);

      const targetedState = (mergedState || [0]).slice();
      if (!(this.ankiPopupStateOverrides instanceof Map)) this.ankiPopupStateOverrides = new Map();
      const revision = (this.ankiPopupStateRevision || 0) + 1;
      this.ankiPopupStateRevision = revision;
      this.ankiPopupStateOverrides.set(spelling, { state: targetedState.slice(), revision });
      if (this.ankiStateMap instanceof Map) this.ankiStateMap.set(spelling, targetedState.slice());
      this.ankiStatesAt = Date.now();
      this.ankiStatesError = '';
      this.ankiStatesSource = 'anki-targeted';
      this.saveDisplayCache(config || {});

      return {
        updated: true,
        term: spelling,
        reading: normalizePopupReading(reading),
        state: targetedState,
        matchedCards: exactCards.length,
        usedCardIds: knownIds.length > 0,
      };
    } finally {
      controller.abort();
    }
  }

  hasAnkiSpelling(spelling) {
    const key = String(spelling || '').normalize('NFKC').trim();
    return (this.ankiStateMap instanceof Map && this.ankiKeyCandidates(key).some(k => this.ankiStateMap.has(k)))
      || (this.ankiPopupStateOverrides instanceof Map && this.ankiKeyCandidates(key).some(k => this.ankiPopupStateOverrides.has(k)))
      || !!this.popupGradingFlag(key) || this.hasTaggedSpelling(key); // GSM_TAGRULES / GSM_ANKI_POPUP_GRADING_V1
  }
  ankiOverride(spelling, reading) {
    const popupFlag = this.popupGradingFlag(spelling);
    if (popupFlag) return popupFlag.flag === 'blacklist' ? [3] : [5];
    const key = String(spelling || '').normalize('NFKC').trim();
    // A targeted mutation can arrive before the initial collection snapshot. Apply
    // that one word's Anki state while leaving all other words on their Jiten state.
    if (this.ankiPopupStateOverrides instanceof Map) {
      for (const candidate of this.ankiKeyCandidates(key)) {
        const targeted = this.ankiPopupStateOverrides.get(candidate);
        const targetedState = Array.isArray(targeted?.state) ? targeted.state : targeted;
        if (Array.isArray(targetedState) && targetedState.length) return targetedState.slice();
      }
    }
    if (!(this.ankiStateMap instanceof Map)) return null; // Keep Jiten states until Anki loaded successfully.
    let state = null;
    for (const candidate of this.ankiKeyCandidates(key)) {
      state = candidate ? this.ankiStateMap.get(candidate) : null;
      if (state) break;
    }
    const plain = plainReading(reading);
    if (!state && plain) state = this.ankiStateMap.get(plain);
    // GSM_TAGRULES: tag styling is delivered separately (gsm-anki-tag-matches) and never encoded in the state.
    return state ? state.slice() : [0];
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
