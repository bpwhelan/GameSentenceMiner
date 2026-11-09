// Network adapters for the Rust vocabulary store. Parsing itself never fetches.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deriveJitenApiBase, DEFAULT_JITEN_PARSE_URL } = require('./jiten_cache');

// GSM_UNVOICED: tag whose notes get the blue dashed underline.
const UNVOICED_TAG = 'unvoiced';
const YOMITAN_PREFIX_REMAINDER_RE = /^(さ|は|も|が|を|に|と|で|へ|の|ね|よ|ぞ|ぜ|な|ぅ|って|だけ|まで|から|より|こそ|しか|でも|ってば|なんて)$/u;

function yomitanParticlePrefixMatch(requested, headword, sources) {
  const term = String(headword?.term || '').normalize('NFKC');
  if (!term || term === requested) return false;
  return sources.some(source => {
    if (!source || typeof source !== 'object') return false;
    const original = String(source.originalText || '').normalize('NFKC');
    return original === term && requested.startsWith(original)
      && YOMITAN_PREFIX_REMAINDER_RE.test(requested.slice(original.length));
  });
}

function yomitanMatchedPrefixCandidate(requested, headword, sources) {
  const term = String(headword?.term || '').normalize('NFKC').trim();
  if (!term || term === requested || !requested.startsWith(term)) return false;
  return sources.some(source => source && typeof source === 'object'
    && String(source.originalText || '').normalize('NFKC') === requested);
}

function yomitanInflectedPrefixCandidate(requested, headword, sources, entry) {
  const term = String(headword?.term || '').normalize('NFKC').trim();
  if (!term || term === requested || !requested.startsWith(term)) return false;
  const hasInflection = Array.isArray(entry?.inflectionRuleChainCandidates)
    && entry.inflectionRuleChainCandidates.length > 0;
  return hasInflection && sources.some(source => source && typeof source === 'object'
    && String(source.originalText || '').normalize('NFKC') === term);
}

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

function ankiWords(cards, { wordField, readingField }, dueIds, reviewedTodayIds = new Set()) {
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
    // This is kept outside knownState: the Rust vocabulary store deliberately
    // limits its SRS state IDs to 0..7. The marker is applied only by an Anki
    // display override in the main process.
    // The daily marker is only for young review cards, not mature reviews or relearning.
    const notReviewedToday = card.type === 2 && card.queue === 2 && card.interval < 21
      && !dueIds.has(card.cardId) && !reviewedTodayIds.has(card.cardId);
    const key = JSON.stringify([spelling, reading]);
    const previous = words.get(key);
    const replace = !previous || tier > previous.knownState[0]
      || (tier === previous.knownState[0] && previous.knownState.includes(7) && !knownState.includes(7));
    if (replace) {
      words.set(key, {
        spelling,
        reading,
        knownState: knownState.slice(),
        notReviewedToday: tier === 1 && notReviewedToday,
      });
    } else {
      if (previous.knownState[0] === 1 && tier === 1 && notReviewedToday) previous.notReviewedToday = true;
      if (tier === previous.knownState[0] && knownState.includes(4)
          && !previous.knownState.includes(7) && !previous.knownState.includes(4)) previous.knownState.push(4);
    }
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

// Apply the configured collection/deck filter to every independent Anki search.
// Anki combines adjacent search terms with AND, so the scope and feature query
// remain separate parenthesized expressions.
function ankiScopedQuery(scope, query) {
  const normalizedScope = String(scope || '').trim();
  const normalizedQuery = String(query || '').trim();
  if (!normalizedScope) return normalizedQuery;
  if (!normalizedQuery) return `(${normalizedScope})`;
  return `(${normalizedScope}) ${normalizedQuery}`;
}

function settings(config) {
  const base = deriveJitenApiBase(config.endpoint || DEFAULT_JITEN_PARSE_URL);
  const anki = { url: config.ankiUrl || 'http://127.0.0.1:8765', query: config.ankiQuery || '',
    apiKey: String(config.ankiApiKey || '').trim(),
    wordField: config.wordField || 'Expression', readingField: config.readingField || '' };
  return { base, anki,
    jitenSource: sourceId('jiten', [base, String(config.apiKey || '').trim()]),
    ankiSource: sourceId('anki', [anki.url, config.profile || '', anki.query, anki.wordField, anki.readingField, anki.apiKey]),
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
    this.cardIndex = new Map();  // cardId -> { note, spelling, reading } (light index used by tag refreshes).
    this.cardIndexConfigKey = ''; // Active Anki search/field scope used to build cardIndex.
    this.ankiPopupCardSnapshot = new Map(); // Temporary full-sync snapshot: spelling -> compact popup card records.
    this.ankiPopupCardSnapshotConfigKey = '';
    this.ankiPopupCardCacheComplete = false; // True only after a complete Anki collection snapshot is cached.
    this.ankiPopupCardCacheConfigKey = '';
    this.ankiPopupStateOverrides = new Map(); // spelling -> { state, cards, revision, notReviewedToday }.
    this.ankiPopupStateRevision = 0;
    this.ankiNotReviewedTodayWords = new Set(); // display-only daily marker; never persisted as an SRS state ID.
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
  indexCards(cards, wordField, readingField, configKey, dueIds = new Set(), reviewedTodayIds = new Set()) {
    const index = new Map();
    const popupCards = new Map();
    for (const card of cards) {
      if (!Number.isSafeInteger(card?.cardId)) continue;
      const field = card?.fields?.[wordField];
      const readingFieldValue = readingField ? card?.fields?.[readingField] : null;
      const spelling = field ? normalizePopupSpelling(field.value) : '';
      const reading = readingFieldValue ? normalizePopupReading(readingFieldValue.value) : '';
      const note = Number.isSafeInteger(card.note) ? card.note : card.cardId;
      index.set(card.cardId, { note, spelling, reading });
      if (!spelling || !Number.isInteger(card.type) || !Number.isInteger(card.queue)
          || !Number.isFinite(card.interval)) continue;
      const entries = popupCards.get(spelling) || [];
      entries.push({
        cardId: card.cardId,
        note,
        reading,
        type: card.type,
        queue: card.queue,
        interval: card.interval,
        due: dueIds instanceof Set && dueIds.has(card.cardId),
        reviewedToday: reviewedTodayIds instanceof Set && reviewedTodayIds.has(card.cardId),
      });
      popupCards.set(spelling, entries);
    }
    this.cardIndex = index;
    this.cardIndexConfigKey = configKey || '';
    this.ankiPopupCardSnapshot = popupCards;
    this.ankiPopupCardSnapshotConfigKey = configKey || '';
  }
  ankiInvoker(url, signal, apiKey = '') {
    return async (action, params = {}) => {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const headers = { 'Content-Type': 'application/json', 'Connection': 'close' };
          const token = String(apiKey || '').trim();
          if (token) headers.Authorization = `Bearer ${token}`;
          const response = await this.json(url, { signal, method: 'POST',
            headers,
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

  // V1 is used only for native scheduling preview/answering. Legacy v6 remains
  // responsible for card lookup and the rest of GSM's existing Anki integration.
  ankiV1Invoker(anki, signal) {
    const base = String(anki?.url || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    const endpoint = /\/api\/v1$/i.test(base) ? base : `${base}/api/v1`;
    let sequence = 0;
    return async (method, params = {}) => {
      const id = `gsm-${Date.now()}-${++sequence}`;
      const headers = { 'Content-Type': 'application/json', 'Connection': 'close' };
      const apiKey = String(anki?.apiKey || anki?.api_key || '').trim();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const payload = await this.json(endpoint, {
        signal, method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      if (payload?.error) {
        const detail = payload.error.message || payload.error.code || 'unknown API error';
        throw new Error(`AnkiConnect V1 ${method}: ${String(detail).slice(0, 180)}`);
      }
      if (!payload || payload.jsonrpc !== '2.0' || payload.id !== id || !Object.hasOwn(payload, 'result')) {
        throw new Error(`AnkiConnect V1 ${method} returned an invalid JSON-RPC response`);
      }
      return payload.result;
    };
  }

  // Use the persisted collection snapshot for popup display. The actual grade
  // still performs a live lookup immediately before writing so a duplicate added
  // outside GSM since the last sync cannot be silently rated.
  findCachedPopupAnkiCards(config, { term, reading } = {}) {
    const spelling = normalizePopupSpelling(term);
    const expectedReading = normalizePopupReading(reading);
    if (!spelling || spelling.length > 256) return null;
    const anki = settings(config || {}).anki;
    const wordField = String(anki.wordField || 'Expression').trim();
    const readingField = String(anki.readingField || '').trim();
    if (!wordField || !this.ankiPopupCardCacheComplete
        || this.ankiPopupCardCacheConfigKey !== this.ankiCardIndexKey(anki)) return null;
    const entry = this.ankiStateMap instanceof Map ? this.ankiStateMap.get(spelling) : null;
    // A complete snapshot can represent a missing word as an empty result.
    const cards = Array.isArray(entry?.cards) ? entry.cards : [];
    const matchedCards = cards.filter(card => !readingField || !expectedReading || card.reading === expectedReading);
    return { anki, spelling, expectedReading, matchedCards, wordField, readingField, fromCache: true };
  }

  async findPopupAnkiCards(config, { term, reading } = {}, signal) {
    const spelling = normalizePopupSpelling(term);
    const expectedReading = normalizePopupReading(reading);
    if (!spelling) throw new Error('The selected Yomitan entry has no headword');
    if (spelling.length > 256) throw new Error('The selected headword is too long');
    const anki = settings(config || {}).anki;
    const wordField = String(anki.wordField || 'Expression').trim();
    const readingField = String(anki.readingField || '').trim();
    if (!wordField) throw new Error('The Anki word field is not configured');
    const invoke = this.ankiInvoker(anki.url || 'http://127.0.0.1:8765', signal, anki.apiKey);
    const query = ankiScopedQuery(anki.query, ankiFieldContainsQuery(wordField, spelling));
    const ids = await invoke('findCards', { query });
    if (!Array.isArray(ids) || ids.length > 20_000 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('Anki returned an invalid or excessively large matching-card list');
    }
    const cards = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const result = await invoke('cardsInfo', { cards: batch });
      if (!Array.isArray(result) || result.length !== batch.length
          || new Set(result.map(card => card?.cardId)).size !== batch.length
          || result.some(card => !batch.includes(card?.cardId))) {
        throw new Error('Anki returned incomplete card details while matching the selected word');
      }
      cards.push(...result);
    }
    const matchedCards = cards.filter(card => {
      const value = card?.fields?.[wordField];
      if (!value || normalizePopupSpelling(value.value) !== spelling) return false;
      if (readingField && expectedReading) {
        const readingValue = card?.fields?.[readingField];
        if (!readingValue || normalizePopupReading(readingValue.value) !== expectedReading) return false;
      }
      return true;
    });
    return { anki, spelling, expectedReading, matchedCards, wordField, readingField };
  }

  popupCardEligibility(card, dueNow = card?.due === true, reviewedToday = card?.reviewedToday === true) {
    if (card?.queue === -1) return { eligible: false, reason: 'suspended', message: 'suspended' };
    if (card?.queue === -2 || card?.queue === -3) return { eligible: false, reason: 'buried', message: 'buried' };
    if (card?.queue === 4) return { eligible: false, reason: 'preview', message: 'filtered preview' };
    if (card?.type === 2 && card?.queue === 2) {
      if (!Number.isFinite(card.interval)) return { eligible: false, reason: 'unknown-state', message: 'review state unavailable' };
      // Mature cards are normally hidden from the grader, but an overdue mature
      // card is actionable and must be allowed to be reviewed. Due takes priority.
      if (card.interval >= 21 && dueNow !== true) return { eligible: false, reason: 'mature', message: 'mature' };
      // Young reviews can be graded early while being read, but only once per
      // Anki scheduler day. A completed review removes both the daily marker and
      // the popup rating controls until the next scheduler day.
      if (card.interval < 21 && dueNow !== true && reviewedToday === true) {
        return { eligible: false, reason: 'reviewed-today', message: 'reviewed today' };
      }
      return { eligible: true, kind: 'review' };
    }
    // A review that was answered Again becomes a relearning card. Keep those
    // eligible so the same word can be rated again when it appears in another sentence.
    if (card?.type === 3 && (card?.queue === 1 || card?.queue === 3)) {
      return { eligible: true, kind: 'relearning' };
    }
    if (card?.type === 0 || card?.queue === 0) return { eligible: false, reason: 'new', message: 'new' };
    if (card?.type === 1) return { eligible: false, reason: 'learning', message: 'learning' };
    return { eligible: false, reason: 'ineligible', message: 'not eligible' };
  }

  async popupGradeStatus(config, args = {}) {
    const controller = new AbortController();
    try {
      const localFlag = this.popupGradingFlag(args?.term);
      if (localFlag) {
        const reason = localFlag.flag === 'blacklist' ? 'blacklist' : 'never-forget';
        return { eligible: false, reason, matchedCards: 0,
          localFlag: { flag: localFlag.flag, spelling: localFlag.spelling },
          message: reason === 'blacklist' ? 'blacklisted' : 'never forget' };
      }

      // Mirror the exact fallback used by ankiOverride(): when the loaded Anki
      // display-state map has no entry for any spelling/reading candidate, the
      // renderer marks the word as `new` ([0]). Trust that existing visual-state
      // decision and return it immediately; do not resolve cards or ask the V1
      // scheduler for a preview. This also covers words absent from the Anki
      // collection, which have no explicit map entry at all.
      const cachedSpelling = normalizePopupSpelling(args?.term);
      const displayCandidates = this.ankiKeyCandidates(cachedSpelling);
      const plain = plainReading(args?.reading);
      const stateForDisplayKey = candidate => {
        const override = this.ankiPopupStateOverrides instanceof Map
          ? this.ankiPopupStateOverrides.get(candidate) : null;
        const overrideState = Array.isArray(override?.state) ? override.state
          : (Array.isArray(override) ? override : null);
        if (overrideState) return overrideState;
        const cached = this.ankiStateMap instanceof Map ? this.ankiStateMap.get(candidate) : null;
        return Array.isArray(cached) ? cached : cached?.state;
      };
      let displayState = null;
      for (const candidate of displayCandidates) {
        const candidateState = stateForDisplayKey(candidate);
        if (Array.isArray(candidateState)) { displayState = candidateState; break; }
      }
      if (!displayState && plain) {
        const readingState = stateForDisplayKey(plain);
        if (Array.isArray(readingState)) displayState = readingState;
      }
      const hasDisplayStateCache = this.ankiStateMap instanceof Map;
      const cachedNew = (Array.isArray(displayState) && displayState[0] === 0)
        || (hasDisplayStateCache && !displayState);
      if (cachedNew) {
        return { eligible: false, reason: 'new', matchedCards: 0, message: 'new', lookupSource: 'display-cache' };
      }

      const resolved = this.findCachedPopupAnkiCards(config, args)
        || await this.findPopupAnkiCards(config, args, controller.signal);
      const count = resolved.matchedCards.length;
      if (count === 0) {
        return { eligible: false, reason: 'no-match', matchedCards: 0,
          message: `No exact Anki card matches \"${resolved.spelling}\" in the configured search scope.` };
      }
      if (count > 1) {
        return { eligible: false, reason: 'multiple', matchedCards: count,
          message: `${count} Anki cards match \"${resolved.spelling}\". Grading is disabled because the popup must identify exactly one card. Narrow the Anki search or set a reading field.` };
      }
      const card = resolved.matchedCards[0];
      const invoke = resolved.fromCache ? null : this.ankiInvoker(
        resolved.anki.url || 'http://127.0.0.1:8765', controller.signal, resolved.anki.apiKey,
      );
      // Cached cards carry both the due and reviewed-today bits. For a live
      // fallback, resolve both before deciding eligibility so a young card that
      // was already reviewed today never receives another rating preview.
      let dueNow = resolved.fromCache ? card.due === true : null;
      let reviewedToday = resolved.fromCache ? card.reviewedToday === true : false;
      if (!resolved.fromCache && card.type === 2 && card.queue === 2
          && Number.isFinite(card.interval)) {
        const [dueIds, reviewedTodayIds] = await Promise.all([
          invoke('findCards', {
            query: ankiScopedQuery(resolved.anki.query, `cid:${card.cardId} is:due`),
          }),
          card.interval < 21
            ? invoke('findCards', {
              query: ankiScopedQuery(resolved.anki.query, `cid:${card.cardId} prop:rated=0`),
            })
            : Promise.resolve([]),
        ]);
        dueNow = Array.isArray(dueIds) && dueIds.includes(card.cardId);
        reviewedToday = Array.isArray(reviewedTodayIds) && reviewedTodayIds.includes(card.cardId);
      }
      const eligibility = this.popupCardEligibility(card, dueNow === true, reviewedToday);
      if (!eligibility.eligible) {
        return { eligible: false, reason: eligibility.reason, matchedCards: 1, message: eligibility.message };
      }
      const v1 = this.ankiV1Invoker(resolved.anki, controller.signal);
      // All legacy card searches and cardsInfo calls are avoided on the cached path.
      const prediction = await v1('scheduling.predict', { cardId: String(card.cardId) });
      if (typeof prediction?.stateToken !== 'string' || !Array.isArray(prediction.answers)) {
        throw new Error('AnkiConnect V1 did not return scheduling predictions for this card');
      }
      const intervals = {};
      const ratings = ['again', 'hard', 'good', 'easy'];
      for (const rating of ratings) {
        const answer = prediction.answers.find(item => item?.rating === rating);
        if (answer && typeof answer.label === 'string') intervals[rating] = answer.label;
      }
      if (!ratings.every(rating => intervals[rating])) {
        throw new Error('AnkiConnect V1 returned incomplete Again/Hard/Good/Easy scheduling predictions');
      }
      const intervalDays = Number.isFinite(card.interval) ? card.interval : 0;
      const young = eligibility.kind === 'review' && intervalDays < 21;
      return {
        eligible: true,
        reason: '',
        matchedCards: 1,
        cardKind: eligibility.kind,
        dueNow,
        reviewedToday,
        notReviewedToday: young && !dueNow && !reviewedToday,
        young,
        intervals,
        lookupSource: resolved.fromCache ? 'display-cache' : 'live',
        statusLabel: eligibility.kind === 'relearning' ? 'relearning' : (dueNow ? 'due' : 'young'),
      };
    } finally {
      controller.abort();
    }
  }
  // One findCards per active tag, intersected with the configured Anki query.
  // Only cards missing from the scoped display index (for example, recently added
  // cards) need cardsInfo. A tag keeps its previous set if its refresh fails.
  async refreshTagSets(config, invokeArg) {
    const tags = this.activeTags();
    if (!tags.length) return;
    const wordField = config.wordField || 'Expression';
    const invoke = invokeArg || this.ankiInvoker(config.url || 'http://127.0.0.1:8765', this.controller.signal, config.apiKey);
    for (const tag of tags) {
      const status = { notes: 0, words: 0, missingField: 0, error: '', at: Date.now() };
      try {
        const ids = await invoke('findCards', { query: ankiScopedQuery(config.query, `tag:${tag}`) });
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
      if (![1, 2].includes(saved?.version) || saved.key !== this.displayCacheKey(config)) return false;
      if (!Array.isArray(saved.states) || saved.states.length > 250_000) return false;
      const map = new Map();
      for (const entry of saved.states) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0]) continue;
        const raw = entry[1];
        const rawState = Array.isArray(raw) ? raw : raw?.state;
        if (!Array.isArray(rawState)) continue;
        const state = rawState.filter(n => Number.isInteger(n) && n >= 0 && n <= 7);
        if (!state.length) continue;
        if (saved.version === 1 || Array.isArray(raw)) {
          // Migrate the old visual-only cache in memory. A popup card lookup
          // falls back to Anki until the next full collection snapshot.
          map.set(entry[0], state);
          continue;
        }
        const cards = Array.isArray(raw.cards) ? raw.cards.filter(card => (
          Number.isSafeInteger(card?.cardId) && card.cardId > 0
          && Number.isInteger(card.type) && Number.isInteger(card.queue)
          && Number.isFinite(card.interval)
          && typeof card.reading === 'string'
          && typeof card.due === 'boolean'
          && typeof card.reviewedToday === 'boolean'
        )).map(card => ({
          cardId: card.cardId,
          note: Number.isSafeInteger(card.note) ? card.note : card.cardId,
          reading: normalizePopupReading(card.reading),
          type: card.type,
          queue: card.queue,
          interval: card.interval,
          due: card.due,
          reviewedToday: card.reviewedToday,
        })) : [];
        const hasUnreviewedYoungNonDueCard = cards.length === 0 || cards.some(card => (
          card.type === 2 && card.queue === 2 && card.interval < 21
          && !card.due && !card.reviewedToday
        ));
        map.set(entry[0], {
          state, cards,
          notReviewedToday: raw.notReviewedToday === true && state[0] === 1 && hasUnreviewedYoungNonDueCard,
        });
      }
      if (!map.size) return false;
      this.ankiStateMap = map;
      this.ankiNotReviewedTodayWords = new Set([...map].filter(([, value]) => (
        value?.state?.[0] === 1 && value.notReviewedToday === true
      )).map(([word]) => word));
      this.ankiPopupCardCacheComplete = saved.version === 2 && saved.popupCardsComplete === true;
      this.ankiPopupCardCacheConfigKey = this.ankiPopupCardCacheComplete
        ? this.ankiCardIndexKey(settings(config).anki) : '';
      this.ankiStatesAt = Number.isFinite(saved.at) ? saved.at : 0;
      this.tagSets = new Map();
      for (const [tag, words] of Object.entries(saved.tags && typeof saved.tags === 'object' ? saved.tags : {})) {
        if (!Array.isArray(words)) continue;
        this.tagSets.set(tag, new Set(words.filter(word => typeof word === 'string' && word)));
      }
      // Rebuild the lightweight lookup from the richer per-word records.
      this.cardIndex = new Map();
      for (const [spelling, value] of map) {
        for (const card of Array.isArray(value?.cards) ? value.cards : []) {
          this.cardIndex.set(card.cardId, { note: card.note, spelling, reading: card.reading });
        }
      }
      this.cardIndexConfigKey = this.ankiCardIndexKey(settings(config).anki);
      this.displayCache.loadedAt = Date.now();
      return true;
    } catch { return false; }
  }
  saveDisplayCache(config) {
    const target = this.displayCache.path;
    if (!target || !(this.ankiStateMap instanceof Map) || !this.ankiStateMap.size) return;
    const payload = JSON.stringify({ version: 2, key: this.displayCacheKey(config), at: Date.now(),
      popupCardsComplete: this.ankiPopupCardCacheComplete === true,
      states: [...this.ankiStateMap],
      notReviewedToday: [...(this.ankiNotReviewedTodayWords instanceof Set ? this.ankiNotReviewedTodayWords : [])],
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
            const headers = { 'Content-Type': 'application/json', 'Connection': 'close' /* GSM_ANKICLOSE */ };
            const apiKey = String(config.ankiApiKey || '').trim();
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            response = await this.json(url, { signal, method: 'POST', headers,
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
      const unvoicedQuery = ankiScopedQuery(config.ankiQuery, `tag:${UNVOICED_TAG}`);
      try {
        ids = await invoke('findNotes', { query: unvoicedQuery });
        if (!Array.isArray(ids) || ids.length > 100_000 || ids.some(id => !Number.isSafeInteger(id))) {
          throw new Error('Anki returned an invalid note list');
        }
      } catch (error) {
        findNotesError = String(error?.message || error).slice(0, 120);
        ids = null;
      }
      if (!ids || ids.length === 0) {
        const cardIds = await invoke('findCards', { query: unvoicedQuery });
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
      const headers = { 'Content-Type': 'application/json', 'Connection': 'close' /* GSM_ANKICLOSE */ };
      const token = String(config.apiKey || '').trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await this.json(config.url, { signal, method: 'POST', headers,
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
    const [ids, due, reviewedToday] = await Promise.all([
      invoke('findCards', { query: ankiScopedQuery(config.query, '') }),
      invoke('findCards', { query: ankiScopedQuery(config.query, 'is:due') }),
      invoke('findCards', { query: ankiScopedQuery(config.query, 'prop:rated=0') }),
    ]);
    if (!Array.isArray(ids) || !Array.isArray(due) || !Array.isArray(reviewedToday) || ids.length > 250_000
        || [...ids, ...due, ...reviewedToday].some(id => !Number.isSafeInteger(id))) throw new Error('Anki returned an invalid card list');
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
    this.indexCards(cards, config.wordField || 'Expression', config.readingField || '', this.ankiCardIndexKey(config), new Set(due), new Set(reviewedToday));
    try { await this.refreshTagSets(config, invoke); } catch { /* per-tag errors are recorded; states still load */ }
    return ankiWords(cards, config, new Set(due), new Set(reviewedToday));
  }
  // GSM_ANKISTATES_FIXED_V2: read Anki directly for display states, without enabling Sudachi parsing.
  async syncAnkiStates(config) {
    const targetedRevisionAtStart = this.ankiPopupStateRevision || 0;
    const anki = settings(config).anki;
    const words = await this.readAnki(anki, this.controller.signal);
    const map = new Map();
    for (const word of words) {
      const spelling = String(word.spelling || '').normalize('NFKC').trim();
      if (!spelling) continue;
      const state = Array.isArray(word.knownState) && word.knownState.length ? word.knownState : [0];
      const daily = state[0] === 1 && word.notReviewedToday === true;
      const previous = map.get(spelling);
      if (!previous || state[0] > previous.state[0]
          || (state[0] === previous.state[0] && previous.state.includes(7) && !state.includes(7))) {
        map.set(spelling, { state: state.slice(), notReviewedToday: daily });
      } else if (state[0] === previous.state[0]) {
        previous.notReviewedToday = previous.notReviewedToday || daily;
        if (state.includes(4) && !previous.state.includes(7) && !previous.state.includes(4)) previous.state.push(4);
      }
    }
    // Do not let a collection snapshot that began before a popup review overwrite
    // the newer targeted result. A snapshot started after the mutation is allowed
    // to supersede that temporary override normally.
    if (!(this.ankiPopupStateOverrides instanceof Map)) this.ankiPopupStateOverrides = new Map();
    for (const [spelling, override] of [...this.ankiPopupStateOverrides]) {
      const revision = Number.isSafeInteger(override?.revision) ? override.revision : 0;
      const state = Array.isArray(override?.state) ? override.state : (Array.isArray(override) ? override : null);
      if (revision > targetedRevisionAtStart && state) {
        map.set(spelling, {
          state: state.slice(),
          cards: Array.isArray(override.cards) ? override.cards : [],
          notReviewedToday: state[0] === 1 && override.notReviewedToday === true,
        });
      } else {
        this.ankiPopupStateOverrides.delete(spelling);
      }
    }
    const currentConfigKey = this.ankiCardIndexKey(anki);
    const snapshotMatchesConfig = this.ankiPopupCardSnapshotConfigKey === currentConfigKey;
    const notReviewedToday = new Set();
    for (const [spelling, value] of map) {
      const state = Array.isArray(value) ? value : value?.state;
      if (!Array.isArray(state) || !state.length) { map.delete(spelling); continue; }
      const snapshotCards = snapshotMatchesConfig ? this.ankiPopupCardSnapshot.get(spelling) : null;
      const cards = Array.isArray(value?.cards) ? value.cards : (snapshotCards || []);
      const daily = state[0] === 1 && value?.notReviewedToday === true;
      if (daily) notReviewedToday.add(spelling);
      map.set(spelling, { state: state.slice(), cards, notReviewedToday: daily });
    }
    this.ankiStateMap = map;
    this.ankiPopupCardCacheComplete = snapshotMatchesConfig;
    this.ankiPopupCardCacheConfigKey = snapshotMatchesConfig ? currentConfigKey : '';
    this.ankiNotReviewedTodayWords = notReviewedToday;
    this.ankiStatesError = '';
    this.saveDisplayCache(config); // GSM_TAGRULES / young-only daily marker / popup card metadata.
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
  popupGradingFlag(spelling, resolutionCandidates = []) {
    // Keep the saved spelling untouched; callers may supply headwords from
    // Yomitan's existing resolution pipeline when checking a surface form.
    const candidates = [
      ...this.ankiKeyCandidates(normalizePopupSpelling(spelling)),
      ...(Array.isArray(resolutionCandidates) ? resolutionCandidates.flatMap(value =>
        this.ankiKeyCandidates(normalizePopupSpelling(value))) : []),
    ];
    for (const candidate of candidates) {
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
      // The saved key may be an Anki lemma candidate (for example the stem of
      // a Yomitan する-verb), so remove the matching active flag from every
      // normalized candidate rather than only the literal popup spelling.
      for (const candidate of this.ankiKeyCandidates(normalized)) {
        const existing = this.popupGradingFlags.get(candidate);
        if (existing?.flag === flag) this.popupGradingFlags.delete(candidate);
      }
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
  async gradePopupWord(config, { term, reading, ease, elapsedMs = 0 } = {}) {
    const rating = Number(ease);
    if (!Number.isInteger(rating) || rating < 1 || rating > 4) throw new Error('Invalid Anki rating');
    const controller = new AbortController();
    try {
      const localFlag = this.popupGradingFlag(term);
      if (localFlag) throw new Error(`${localFlag.flag === 'blacklist' ? 'Blacklisted' : 'Never Forget'} words cannot be rated here. Nothing was rated.`);
      const resolved = await this.findPopupAnkiCards(config, { term, reading }, controller.signal);
      if (resolved.matchedCards.length === 0) {
        throw new Error(`No exact Anki card match for \"${resolved.spelling}\".`);
      }
      if (resolved.matchedCards.length > 1) {
        throw new Error(`${resolved.matchedCards.length} Anki cards match \"${resolved.spelling}\". Nothing was rated; popup grading requires exactly one matching card. Narrow the Anki search or set a reading field.`);
      }
      const card = resolved.matchedCards[0];
      // Recheck due/reviewed-today state immediately before writing. This
      // closes the race where an old popup button survives after the card was
      // reviewed elsewhere or the background cache refresh has not completed.
      let dueNow = false;
      let reviewedToday = false;
      if (card.type === 2 && card.queue === 2
          && Number.isFinite(card.interval)) {
        const invoke = this.ankiInvoker(
          resolved.anki.url || 'http://127.0.0.1:8765', controller.signal, resolved.anki.apiKey,
        );
        const [dueIds, reviewedTodayIds] = await Promise.all([
          invoke('findCards', {
            query: ankiScopedQuery(resolved.anki.query, `cid:${card.cardId} is:due`),
          }),
          card.interval < 21
            ? invoke('findCards', {
              query: ankiScopedQuery(resolved.anki.query, `cid:${card.cardId} prop:rated=0`),
            })
            : Promise.resolve([]),
        ]);
        dueNow = Array.isArray(dueIds) && dueIds.includes(card.cardId);
        reviewedToday = Array.isArray(reviewedTodayIds) && reviewedTodayIds.includes(card.cardId);
      }
      const eligibility = this.popupCardEligibility(card, dueNow, reviewedToday);
      if (!eligibility.eligible) throw new Error(`${eligibility.message} Nothing was rated.`);

      // Recalculate immediately before writing so the token cannot be stale from
      // the preview shown while the popup was open.
      const v1 = this.ankiV1Invoker(resolved.anki, controller.signal);
      const prediction = await v1('scheduling.predict', { cardId: String(card.cardId) });
      if (typeof prediction?.stateToken !== 'string') throw new Error('AnkiConnect V1 did not return a fresh scheduling token');
      const ratingName = ['', 'again', 'hard', 'good', 'easy'][rating];
      const predictedAnswer = prediction.answers?.find(item => item?.rating === ratingName);
      if (!predictedAnswer || typeof predictedAnswer.label !== 'string') {
        throw new Error(`AnkiConnect V1 did not provide a ${ratingName} scheduling state`);
      }
      const elapsed = Number.isSafeInteger(elapsedMs) && elapsedMs > 0 ? Math.min(elapsedMs, 600_000) : 0;
      // A write is never retried: a lost response may occur after Anki committed it.
      const result = await v1('scheduling.answer', {
        cardId: String(card.cardId),
        rating: ratingName,
        stateToken: prediction.stateToken,
        elapsedMs: elapsed,
      });
      if (!result || String(result.cardId) !== String(card.cardId)) {
        throw new Error('AnkiConnect V1 returned an unexpected answer result. Check the card in Anki before clicking again.');
      }
      if (!(this.cardIndex instanceof Map)) this.cardIndex = new Map();
      this.cardIndex.set(card.cardId, {
        note: Number.isSafeInteger(card.note) ? card.note : card.cardId,
        spelling: resolved.spelling,
        reading: resolved.readingField && card.fields?.[resolved.readingField]?.value
          ? normalizePopupReading(card.fields[resolved.readingField].value) : '',
      });
      this.cardIndexConfigKey = this.ankiCardIndexKey(resolved.anki);
      return {
        term: resolved.spelling,
        reading: resolved.expectedReading,
        ease: rating,
        matchedCards: 1,
        eligibleCards: 1,
        gradedCards: 1,
        skippedCards: 0,
        schedulingMethod: 'anki-connect-v1-native',
        nextInterval: predictedAnswer.label,
        elapsedMs: elapsed,
        reviewId: result.reviewId || null,
        matchedCardIds: [card.cardId],
        gradedCardIds: [card.cardId],
        usedCardIndex: false,
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

    const query = ankiScopedQuery(anki.query, ankiFieldContainsQuery(wordField, spelling));

    const controller = new AbortController();
    const invoke = this.ankiInvoker(anki.url || 'http://127.0.0.1:8765', controller.signal, anki.apiKey);
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
        const cachedWord = this.ankiStateMap instanceof Map ? this.ankiStateMap.get(spelling) : null;
        for (const cachedCard of Array.isArray(cachedWord?.cards) ? cachedWord.cards : []) {
          if (Number.isSafeInteger(cachedCard?.cardId) && cachedCard.cardId > 0) unique.add(cachedCard.cardId);
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

      // Caller-supplied IDs may come from outside the active deck/search scope.
      // Intersect them with that scope before reading or refreshing their state.
      if (knownIds.length > 0 && String(anki.query || '').trim()) {
        const scopedIds = await invoke('findCards', {
          query: ankiScopedQuery(anki.query, cardIdSearch(knownIds)),
        });
        if (!Array.isArray(scopedIds) || scopedIds.length > 20_000
            || scopedIds.some(id => !Number.isSafeInteger(id))) {
          throw new Error('Anki returned an invalid scoped card-ID list');
        }
        knownIds = scopedIds;
      }

      if (knownIds.length > 0) {
        // Fetch details and due status for the already-scoped IDs concurrently.
        const [cards, due, reviewedToday] = await Promise.all([
          getCardDetails(knownIds),
          invoke('findCards', { query: ankiScopedQuery(anki.query, `${cardIdSearch(knownIds)} is:due`) }),
          invoke('findCards', { query: ankiScopedQuery(anki.query, `${cardIdSearch(knownIds)} prop:rated=0`) }),
        ]);
        exactCards = cards.filter(card => (
          card?.fields?.[wordField]
          && normalizePopupSpelling(card.fields[wordField].value) === spelling
        ));
        dueIds = new Set(Array.isArray(due) ? due : []);
        var reviewedTodayIds = new Set(Array.isArray(reviewedToday) ? reviewedToday : []);
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
            const [cards, due, reviewedToday] = await Promise.all([
              getCardDetails(ids),
              invoke('findCards', { query: ankiScopedQuery(anki.query, `${cardIdSearch(ids)} is:due`) }),
              invoke('findCards', { query: ankiScopedQuery(anki.query, `${cardIdSearch(ids)} prop:rated=0`) }),
            ]);
            exactCards = cards.filter(card => (
              card?.fields?.[wordField]
              && normalizePopupSpelling(card.fields[wordField].value) === spelling
            ));
            dueIds = new Set(Array.isArray(due) ? due : []);
            var reviewedTodayIds = new Set(Array.isArray(reviewedToday) ? reviewedToday : []);
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
      let notReviewedToday = false;
      const popupCardRecords = [];
      for (const card of exactCards) {
        if (!Number.isSafeInteger(card?.cardId) || !Number.isInteger(card.type)
            || !Number.isInteger(card.queue) || !Number.isFinite(card.interval)) {
          throw new Error('Anki returned incomplete scheduling data for the targeted card');
        }
        const tier = card.type === 0 ? 0 : card.type === 2 && card.interval >= 21 ? 2 : 1;
        const state = [tier];
        if (card.queue === -1) state.push(7);
        else if (dueIds.has(card.cardId) && tier !== 0) state.push(4);
        const cardNotReviewedToday = tier === 1 && card.type === 2 && card.queue === 2
          && card.interval < 21 && !dueIds.has(card.cardId)
          && !(reviewedTodayIds instanceof Set && reviewedTodayIds.has(card.cardId));

        if (!mergedState || tier > mergedState[0]
            || (tier === mergedState[0] && mergedState.includes(7) && !state.includes(7))) {
          mergedState = state.slice();
          notReviewedToday = cardNotReviewedToday;
        } else if (tier === mergedState[0]) {
          notReviewedToday = notReviewedToday || cardNotReviewedToday;
          if (state.includes(4) && !mergedState.includes(7) && !mergedState.includes(4)) mergedState.push(4);
        }

        if (!(this.cardIndex instanceof Map)) this.cardIndex = new Map();
        const readingValue = readingField ? card?.fields?.[readingField]?.value : '';
        const normalizedCardReading = readingValue ? normalizePopupReading(readingValue) : '';
        this.cardIndex.set(card.cardId, {
          note: Number.isSafeInteger(card.note) ? card.note : card.cardId,
          spelling,
          reading: normalizedCardReading,
        });
        popupCardRecords.push({
          cardId: card.cardId,
          note: Number.isSafeInteger(card.note) ? card.note : card.cardId,
          reading: normalizedCardReading,
          type: card.type,
          queue: card.queue,
          interval: card.interval,
          due: dueIds.has(card.cardId),
          reviewedToday: reviewedTodayIds instanceof Set && reviewedTodayIds.has(card.cardId),
        });
      }
      this.cardIndexConfigKey = this.ankiCardIndexKey(anki);

      const targetedState = (mergedState || [0]).slice();
      if (!(this.ankiPopupStateOverrides instanceof Map)) this.ankiPopupStateOverrides = new Map();
      const revision = (this.ankiPopupStateRevision || 0) + 1;
      this.ankiPopupStateRevision = revision;
      this.ankiPopupStateOverrides.set(spelling, {
        state: targetedState.slice(),
        cards: popupCardRecords,
        revision,
        notReviewedToday,
      });
      if (this.ankiStateMap instanceof Map) {
        this.ankiStateMap.set(spelling, { state: targetedState.slice(), cards: popupCardRecords, notReviewedToday });
      }
      if (!(this.ankiNotReviewedTodayWords instanceof Set)) this.ankiNotReviewedTodayWords = new Set();
      if (notReviewedToday) this.ankiNotReviewedTodayWords.add(spelling);
      else this.ankiNotReviewedTodayWords.delete(spelling);
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
  // Resolution candidates arrive in Yomitan/Jiten relevance order. Select the
  // first usable Anki entry so a secondary dictionary form cannot override the
  // preferred lookup result.
  firstAnkiResolutionMatch(candidates) {
    if (!Array.isArray(candidates)) return null;
    for (const candidate of candidates) {
      if (this.hasAnkiSpelling(candidate)) return candidate;
    }
    return null;
  }
  ankiOverride(spelling, reading) {
    const popupFlag = this.popupGradingFlag(spelling);
    if (popupFlag) return popupFlag.flag === 'blacklist' ? [3] : [5];
    const key = String(spelling || '').normalize('NFKC').trim();
    const decorate = (state, matchedKey = key) => {
      const result = Array.isArray(state) ? state.slice() : [0];
      // State 8 exists only in this renderer-facing array. It is never stored in
      // knownState or sent to Rust, whose persisted state IDs are restricted 0..7.
      if (result[0] === 1 && this.ankiNotReviewedTodayWords instanceof Set
          && this.ankiNotReviewedTodayWords.has(matchedKey) && !result.includes(8)) result.push(8);
      return result;
    };
    // A targeted mutation can arrive before the initial collection snapshot. Apply
    // that one word's Anki state while leaving all other words on their Jiten state.
    if (this.ankiPopupStateOverrides instanceof Map) {
      for (const candidate of this.ankiKeyCandidates(key)) {
        const targeted = this.ankiPopupStateOverrides.get(candidate);
        const targetedState = Array.isArray(targeted?.state) ? targeted.state : targeted;
        if (Array.isArray(targetedState) && targetedState.length) return decorate(targetedState, candidate);
      }
    }
    if (!(this.ankiStateMap instanceof Map)) return null; // Keep Jiten states until Anki loaded successfully.
    let state = null;
    let matchedKey = key;
    const stateFromEntry = entry => Array.isArray(entry) ? entry
      : (Array.isArray(entry?.state) ? entry.state : null);
    for (const candidate of this.ankiKeyCandidates(key)) {
      state = candidate ? stateFromEntry(this.ankiStateMap.get(candidate)) : null;
      if (state) { matchedKey = candidate; break; }
    }
    const plain = plainReading(reading);
    if (!state && plain) { state = stateFromEntry(this.ankiStateMap.get(plain)); if (state) matchedKey = plain; }
    // GSM_TAGRULES: tag styling is delivered separately (gsm-anki-tag-matches).
    return state ? decorate(state, matchedKey) : [0];
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

module.exports = { LocalVocabulary, VocabularyConnection, jitenWords, ankiWords, sourceId,
  yomitanParticlePrefixMatch, yomitanMatchedPrefixCandidate, yomitanInflectedPrefixCandidate };
