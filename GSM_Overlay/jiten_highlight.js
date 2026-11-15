/**
 * GSM Overlay - Jiten Reader SRS Highlighting (Mirror Approach)
 *
 * With local vocabulary enabled, Rust supplies tokens and states directly.
 * Otherwise we mirror the Jiten Reader extension's parsing: insert
 * text into an off-screen parse container, trigger a parse via synthetic Alt+P,
 * observe the .jiten-word spans it creates, then draw one overlay highlight box
 * per token over the union rect of its character boxes (like gamepad.js).
 */

(function (root) {
  'use strict';

  // GSM diagnostic bridge: renderer console output is not reliably included in
  // the main-process log, so forward compact diagnostic records over IPC.
  function gsmRendererDebug(stage, details = {}) {
    try {
      const message = JSON.stringify({
        stage,
        time: Date.now(),
        ...details,
      });
      window.ipcRenderer?.send?.('gsm-renderer-debug', message);
    } catch {
      // Diagnostics must never interfere with highlighting.
    }
  }

  gsmRendererDebug('module-loaded');

  // SRS/card state classes Jiten can assign to a word.
  const JITEN_STATE_CLASSES = [
    'new',
    'young',
    'mature',
    'mastered',
    'blacklisted',
    'due',
    'redundant',
    'suspended',
    'not-reviewed-today',
  ];
  const JITEN_AUX_CLASSES = ['frequent', 'i-plus-one'];
  const JITEN_STYLEABLE_CLASSES = JITEN_STATE_CLASSES.concat(JITEN_AUX_CLASSES);
  // i+1 is opt-in: only render it when Jiten's explicit setting enables it.
  const DEFAULT_RENDERED_CLASSES = new Set(['new', 'young', 'due', 'frequent', 'not-reviewed-today']);
  const DRAWABLE_EFFECT_TYPES = new Set(['text-colour', 'background', 'underline', 'border', 'shadow']);

  // States that mean the user already knows (or has chosen to ignore) the word.
  // Without Jiten's style config these preserve the legacy behavior: only words
  // worth studying are surfaced. Once style config is available, that config
  // decides which states are visible.
  const KNOWN_STATE_CLASSES = ['mature', 'mastered', 'blacklisted'];

  const LAYER_ID = 'jiten-highlight-layer';
  const SEGMENT_CLASS = 'gsm-jiten-hl';

  let parseContainer = null;
  let parseObserver = null;
  let currentLines = null;
  let currentLineBlocks = null;
  let currentBlocks = [];
  let currentSignature = null;
  let containerBlocks = new Map();
  let pendingParseTimer = null;
  let pendingSignature = null;
  let runningParseTimer = null;
  let runningSignature = null;
  let containerSignature = null;
  let lastParseFinishedAt = 0;
  let parseTimeoutId = null;
  let enabled = true;
  let visible = true;
  const navigationListeners = new Set();
  let lastParsedSignature = null;
  let configuredVisibleClasses = null;
  let localParser = null;
  let localParseGeneration = 0;
  // A frame is not drawable until both tokenization and its Anki lookups finish.
  let highlightGeneration = 0;
  let containerGeneration = 0;
  let highlightsReady = false;
  const LOCAL_STATE_CLASSES = ['new', 'young', 'mature', 'blacklisted', 'due', 'mastered', 'redundant', 'suspended', 'not-reviewed-today'];

  // Mirror Jiten Reader's actual i+1 option. The overlay's local parser used to
  // infer i+1 independently of this setting, so even markIPlus1=false could add
  // the class when exactly one token looked unfamiliar.
  let readerMarkIPlusOneEnabled = false;
  let readerIPlusOneNewStates = new Set([0]);
  let readerIPlusOneMinSentenceLength = 3;
  let readerIPlusOneMaxFrequency = false;

  function applyReaderIPlusOneSettings(settings) {
    if (!settings || typeof settings !== 'object') return;

    const wasEnabled = readerMarkIPlusOneEnabled;
    readerMarkIPlusOneEnabled = settings.markIPlus1 === true || settings.markIPlus1 === 'true';

    if (Array.isArray(settings.newStates)) {
      const nextStates = new Set();
      for (const value of settings.newStates) {
        const index = Number.isInteger(value)
          ? value
          : (typeof value === 'string' ? LOCAL_STATE_CLASSES.indexOf(value.trim().toLowerCase()) : -1);
        if (Number.isInteger(index) && index >= 0 && index < LOCAL_STATE_CLASSES.length) {
          nextStates.add(index);
        }
      }
      readerIPlusOneNewStates = nextStates;
    }

    const minSentenceLength = Number(settings.minSentenceLength);
    readerIPlusOneMinSentenceLength = Number.isFinite(minSentenceLength)
      ? Math.max(1, Math.floor(minSentenceLength))
      : 3;

    const maxFrequency = Number(settings.iPlusOneMaxFrequency);
    readerIPlusOneMaxFrequency = settings.iPlusOneMaxFrequency !== false
      && settings.iPlusOneMaxFrequency !== 'false'
      && Number.isFinite(maxFrequency) && maxFrequency > 0
      ? maxFrequency
      : false;

    gsmRendererDebug('i-plus-one-settings-updated', {
      enabled: readerMarkIPlusOneEnabled,
      newStates: Array.from(readerIPlusOneNewStates),
      minSentenceLength: readerIPlusOneMinSentenceLength,
      maxFrequency: readerIPlusOneMaxFrequency,
    });

    if (!readerMarkIPlusOneEnabled) {
      // Clear stale classes immediately; styles alone must never decide whether
      // the i+1 feature is active.
      if (parseContainer) {
        parseContainer.querySelectorAll('.i-plus-one').forEach(span => span.classList.remove('i-plus-one'));
        mirrorHighlights();
      }
      notifyNavigationTokens();
    } else if (!wasEnabled) {
      // Re-parse the current text so i+1 can be added when the setting is enabled.
      refresh();
    }
  }

  if (root && typeof root.addEventListener === 'function') {
    root.addEventListener('gsm-jiten-reader-settings-updated', event => {
      applyReaderIPlusOneSettings(event?.detail);
    });
    if (root.GsmJitenReaderSettings) {
      applyReaderIPlusOneSettings(root.GsmJitenReaderSettings);
    }
  }

  function getIPlusOneCandidateKeys(alignedTokens) {
    if (!readerMarkIPlusOneEnabled || !Array.isArray(alignedTokens) || !alignedTokens.length) {
      return new Set();
    }

    // Jiten evaluates each sentence independently. Use its sentence text when
    // available; otherwise keep the existing OCR block as the grouping unit.
    const sentenceGroups = new Map();
    for (const item of alignedTokens) {
      const token = item?.token || {};
      const sentence = typeof token.sentence === 'string' && token.sentence.trim()
        ? token.sentence
        : '__gsm_ocr_block__';
      const cardKey = Number.isSafeInteger(token.wordId) && token.wordId > 0
        ? `${token.wordId}/${Number.isInteger(token.readingIndex) ? token.readingIndex : 0}`
        : `${String(token.headword || '').normalize('NFKC').trim()}\u001f${String(token.reading || '').normalize('NFKC').trim()}`;
      if (!sentenceGroups.has(sentence)) sentenceGroups.set(sentence, new Map());
      if (!sentenceGroups.get(sentence).has(cardKey)) sentenceGroups.get(sentence).set(cardKey, token);
    }

    const candidates = new Set();
    for (const [sentence, cards] of sentenceGroups) {
      if (cards.size < readerIPlusOneMinSentenceLength) continue;
      const unknown = [...cards.entries()].filter(([, token]) => {
        const states = Array.isArray(token.knownState) && token.knownState.length
          ? token.knownState
          : [0];
        return states.some(state => readerIPlusOneNewStates.has(state));
      });
      if (unknown.length !== 1) continue;

      const [cardKey, token] = unknown[0];
      if (readerIPlusOneMaxFrequency !== false) {
        const frequency = Number(token.frequencyRank);
        if (!Number.isFinite(frequency) || frequency <= 0 || frequency > readerIPlusOneMaxFrequency) continue;
      }
      candidates.add(`${sentence}\u001e${cardKey}`);
    }
    return candidates;
  }

  function setLocalParser(parser) {
    localParser = typeof parser === 'function' ? parser : null;
    localParseGeneration++;
    clearTimeout(runningParseTimer);
    clearTimeout(parseTimeoutId);
    runningSignature = null;
    lastParsedSignature = null;
    containerSignature = null;
    clearJitenPreferredHeadwords();
    hideAllSegments();
  }

  // GSM_JITEN_SOURCE_SURFACE_ALIGNMENT_V2:
  // Jiten.Parser preprocesses text before computing offsets (for example, ellipsis
  // runs may collapse). Token.start/end therefore are not always indexes into the
  // original OCR text. Use the returned token surface to re-anchor each word to
  // the exact display text; keep unmatched normalized words plain instead of
  // letting one bad offset shift every word that follows.
  function gsmIsPunctuationOnlySurface(surface) {
    return !surface || /^[\p{P}\p{S}\s]+$/u.test(surface);
  }

  function gsmGetLocalTokenSurface(token) {
    for (const key of ['word', 'surface', 'text']) {
      if (typeof token?.[key] === 'string' && token[key].length) return token[key];
    }
    return '';
  }

  function gsmFindLocalSurface(text, surface, from, expectedStart) {
    let bestStart = -1;
    let bestDistance = Infinity;

    // Prefer an exact surface match. The raw offset is only a hint for choosing
    // among repeated occurrences; it is never used directly as a DOM coordinate.
    for (let candidate = text.indexOf(surface, from); candidate !== -1;
         candidate = text.indexOf(surface, candidate + 1)) {
      const distance = Math.abs(candidate - expectedStart);
      if (distance < bestDistance) {
        bestStart = candidate;
        bestDistance = distance;
      }
      if (candidate > expectedStart && candidate - expectedStart > bestDistance) break;
    }
    if (bestStart !== -1) return { start: bestStart, end: bestStart + surface.length };

    // Compatibility-normalized spelling fallback handles equal words represented
    // as fullwidth/halfwidth forms. Vary the source window length because NFKC can
    // change the number of UTF-16 code units. Only use this when no exact match exists.
    const normalizedSurface = surface.normalize('NFKC');
    const minLength = Math.max(1, surface.length - 3);
    const maxLength = Math.min(text.length, surface.length + 3);
    for (let candidate = from; candidate < text.length; candidate++) {
      for (let length = minLength; length <= maxLength && candidate + length <= text.length; length++) {
        if (text.slice(candidate, candidate + length).normalize('NFKC') !== normalizedSurface) continue;
        const distance = Math.abs(candidate - expectedStart);
        if (distance < bestDistance) {
          bestStart = candidate;
          bestDistance = distance;
          // A candidate beginning after expectedStart cannot improve once its
          // distance exceeds the best seen and all later candidates are farther.
        }
      }
      if (candidate > expectedStart && candidate - expectedStart > bestDistance) break;
    }
    if (bestStart === -1) {
      const interruptedMatch = gsmFindPunctuationInterruptedSurface(text, surface, from, expectedStart);
      if (interruptedMatch) return interruptedMatch;
      return null;
    }

    // Recalculate the matching source length, which may differ from surface.length.
    const normalizedSurfaceForLength = normalizedSurface;
    const candidateLengths = [];
    for (let length = minLength; length <= maxLength && bestStart + length <= text.length; length++) {
      if (text.slice(bestStart, bestStart + length).normalize('NFKC') === normalizedSurfaceForLength) {
        candidateLengths.push(length);
      }
    }
    if (!candidateLengths.length) return null;
    candidateLengths.sort((a, b) => Math.abs(a - surface.length) - Math.abs(b - surface.length));
    return { start: bestStart, end: bestStart + candidateLengths[0] };
  }

  // Match a parser-normalized token when expressive punctuation occurs inside its
  // original surface (e.g. Jiten's "擦れて" against displayed "擦れ……て").
  // Only punctuation may be skipped, only between matched token characters, and
  // the bounded gap prevents unrelated text from being swallowed into a word.
  function gsmFindPunctuationInterruptedSurface(text, surface, from, expectedStart) {
    const sourceChars = [];
    const sourceOffsets = [];
    let utf16Offset = 0;
    for (const char of text) {
      sourceChars.push(char);
      sourceOffsets.push(utf16Offset);
      utf16Offset += char.length;
    }

    const tokenChars = Array.from(surface);
    if (tokenChars.length < 2) return null;
    const maxSkippedPunctuation = 8;
    let bestMatch = null;
    let bestDistance = Infinity;

    for (let startIndex = 0; startIndex < sourceChars.length; startIndex++) {
      const startOffset = sourceOffsets[startIndex];
      if (startOffset < from) continue;
      if (sourceChars[startIndex].normalize('NFKC') !== tokenChars[0].normalize('NFKC')) continue;

      let sourceIndex = startIndex + 1;
      let skippedPunctuation = 0;
      let matched = true;
      let lastMatchedIndex = startIndex;

      for (let tokenIndex = 1; tokenIndex < tokenChars.length; tokenIndex++) {
        const expectedChar = tokenChars[tokenIndex].normalize('NFKC');
        while (sourceIndex < sourceChars.length
          && sourceChars[sourceIndex].normalize('NFKC') !== expectedChar) {
          if (!/^\p{P}+$/u.test(sourceChars[sourceIndex])
            || skippedPunctuation >= maxSkippedPunctuation) {
            matched = false;
            break;
          }
          skippedPunctuation++;
          sourceIndex++;
        }
        if (!matched || sourceIndex >= sourceChars.length) {
          matched = false;
          break;
        }
        lastMatchedIndex = sourceIndex;
        sourceIndex++;
      }

      if (!matched || skippedPunctuation === 0) continue;
      const distance = Math.abs(startOffset - expectedStart);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = {
          start: startOffset,
          end: sourceOffsets[lastMatchedIndex] + sourceChars[lastMatchedIndex].length,
        };
      }
    }

    return bestMatch;
  }

  function gsmAlignLocalTokensToSource(text, tokens) {
    const aligned = [];
    let previousSourceEnd = 0;
    let offsetDelta = 0;

    for (const token of tokens) {
      if (!token || typeof token !== 'object') continue;
      const surface = gsmGetLocalTokenSurface(token);
      // Punctuation (including 「 and 」) remains in the source text between word
      // spans. It is deliberately not aligned to normalized punctuation tokens.
      if (gsmIsPunctuationOnlySurface(surface)) continue;

      const rawStart = Number.isInteger(token.start) && token.start >= 0 ? token.start : null;
      const rawEnd = Number.isInteger(token.end) && token.end > (rawStart ?? -1) ? token.end : null;
      const expectedStart = rawStart === null ? previousSourceEnd : rawStart + offsetDelta;
      const match = gsmFindLocalSurface(text, surface, previousSourceEnd, expectedStart);
      if (!match || match.end <= match.start) {
        // A parser-normalized spelling may not exist verbatim in the displayed
        // text. Leave that word unhighlighted; the next exact token can re-anchor.
        continue;
      }

      aligned.push({ token, start: match.start, end: match.end, surface });
      previousSourceEnd = match.end;
      if (rawEnd !== null) offsetDelta = match.end - rawEnd;
    }

    return aligned;
  }

  // Jiten can split mimetic adverbs such as ツンッと or ピタッと into the
  // sound-symbolic stem plus the quotative と. Keep these as one lookup span.
  function gsmMergeMimeticToTokens(tokens) {
    const merged = [];
    for (const item of tokens) {
      const previous = merged[merged.length - 1];
      if (previous && previous.end === item.start && item.surface === 'と'
          && /^[\p{Script=Hiragana}\p{Script=Katakana}]+ッ$/u.test(previous.surface)) {
        previous.end = item.end;
        previous.surface += item.surface;
        previous.token = { ...previous.token, word: previous.surface };
      } else {
        merged.push({ ...item });
      }
    }
    return merged;
  }

  async function parseLocally(blocks) {
    const generation = ++localParseGeneration;
    try {
      const result = await localParser(blocks.map(block => block.text));
      gsmRendererDebug('local-parse-returned', {
        generation,
        currentGeneration: localParseGeneration,
        blockCount: blocks.length,
        tokenCounts: Array.isArray(result?.tokens) ? result.tokens.map(tokens => Array.isArray(tokens) ? tokens.length : null) : null,
        iPlusOneEnabled: readerMarkIPlusOneEnabled,
        iPlusOneNewStates: Array.from(readerIPlusOneNewStates),
        targetTokens: (Array.isArray(result?.tokens) ? result.tokens.flat() : [])
          .filter(token => ['口付けた', '口', '付けた'].includes(token?.word))
          .map(token => ({
            word: token.word,
            headword: token.headword,
            wordId: token.wordId,
            knownState: token.knownState,
          })),
      });
      if (generation !== localParseGeneration || !enabled || !available) {
        gsmRendererDebug('local-parse-discarded', {
          generation,
          currentGeneration: localParseGeneration,
          enabled,
          available,
        });
        return;
      }
      if (!Array.isArray(result?.tokens) || result.tokens.length !== blocks.length) throw new Error('Invalid local parse');
      const paragraphs = parseContainer.querySelectorAll('p[data-line-index]');
      for (let i = 0; i < blocks.length; i++) {
        const p = paragraphs[i];
        const text = blocks[i].text;
        const tokens = result.tokens[i];
        const alignedTokens = gsmMergeMimeticToTokens(gsmAlignLocalTokensToSource(text, tokens));
        const iPlusOneCandidates = getIPlusOneCandidateKeys(alignedTokens);
        p.textContent = '';
        let offset = 0;
        for (const aligned of alignedTokens) {
          const { token, start, end } = aligned;
          if (start < offset || end <= start || end > text.length) continue;
          p.appendChild(document.createTextNode(text.slice(offset, start)));

          const span = document.createElement('span');
          span.className = 'jiten-word ' + (token.knownState || [0]).map(state => LOCAL_STATE_CLASSES[state]).filter(Boolean).join(' ');
          const sentenceKey = typeof token.sentence === 'string' && token.sentence.trim()
            ? token.sentence
            : '__gsm_ocr_block__';
          const cardKey = Number.isSafeInteger(token.wordId) && token.wordId > 0
            ? `${token.wordId}/${Number.isInteger(token.readingIndex) ? token.readingIndex : 0}`
            : `${String(token.headword || '').normalize('NFKC').trim()}\u001f${String(token.reading || '').normalize('NFKC').trim()}`;
          if (iPlusOneCandidates.has(`${sentenceKey}\u001e${cardKey}`)) span.classList.add('i-plus-one');
          if (Number.isSafeInteger(token.wordId) && token.wordId > 0) {
            span.setAttribute('wordId', String(token.wordId));
            span.setAttribute('readingIndex', String(token.readingIndex || 0));
          }
          const jitenHeadword = String(token.headword || '').normalize('NFKC').trim();
          const jitenReading = String(token.reading || '').normalize('NFKC').trim();
          if (jitenHeadword) span.dataset.gsmHeadword = jitenHeadword;
          if (jitenReading) span.dataset.gsmReading = jitenReading;
          if (token.unvoiced === true) span.classList.add('unvoiced'); // GSM_UNVOICED
          span.textContent = text.slice(start, end);
          p.appendChild(span);
          offset = end;
        }
        p.appendChild(document.createTextNode(text.slice(offset)));
      }
    } catch {
      // Keep the OCR text usable if the dictionary/server is unavailable.
      if (generation === localParseGeneration) console.warn('[LocalVocabulary] Local parsing unavailable; check vocabulary sync status.');
    } finally {
      if (generation === localParseGeneration) onParseComplete();
    }
  }

  // Whether Jiten can parse right now. The overlay verifies this via the settings
  // bridge and pushes it in through setAvailable(); optimistic by default so the
  // first lines highlight immediately.
  let available = true;

  // Overlay highlight layer + pooled segment elements, reused across renders so we
  // don't thrash the DOM.
  let overlayLayer = null;
  let overlaySegments = [];
  let repositionRaf = 0;

  function init() {
    if (parseContainer) return;

    parseContainer = document.getElementById('jiten-parse-container');
    if (!parseContainer) {
      parseContainer = document.createElement('div');
      parseContainer.id = 'jiten-parse-container';
      document.body.appendChild(parseContainer);
    }

    ensureOverlayLayer();

    parseObserver = new MutationObserver(onParseContainerMutation);
    parseObserver.observe(parseContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'ajb'],
    });

    // Overlay rects are viewport-space, so they go stale on reflow. Re-mirror on
    // resize from the spans we already parsed; text changes re-enter via requestParse.
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', scheduleReposition);
    }
  }

  function ensureOverlayLayer() {
    if (overlayLayer && overlayLayer.isConnected) return overlayLayer;
    overlayLayer = document.getElementById(LAYER_ID);
    if (!overlayLayer) {
      overlayLayer = document.createElement('div');
      overlayLayer.id = LAYER_ID;
      document.body.appendChild(overlayLayer);
    }
    return overlayLayer;
  }

  function scheduleReposition() {
    if (!enabled || !currentLines) return;
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = 0;
      mirrorHighlights();
    });
  }

  function onParseContainerMutation() {
    if (localParser) return; // Local parsing completes explicitly, including empty results.
    if (!parseContainer) return;
    // An all-unparsed response is still a completed Reader parse. Waiting only
    // for parsed words leaves the queue locked until the watchdog whenever Jiten
    // cannot tokenize a line, delaying an otherwise valid newer frame.
    const jitenWords = parseContainer.querySelectorAll('.jiten-word');
    if (jitenWords.length === 0) return;

    // Debounce: Jiten may parse in batches
    if (parseTimeoutId) clearTimeout(parseTimeoutId);
    parseTimeoutId = setTimeout(() => {
      parseTimeoutId = null;
      onParseComplete();
    }, 200);
  }

  // Apply Anki's display states to Jiten's already-tokenized spans. This changes
  // only CSS classes; Jiten remains responsible for segmentation and word boundaries.
  const ANKI_TO_JITEN_STATE = ['new', 'young', 'mature', 'blacklisted', 'due', 'mastered', 'redundant', 'suspended', 'not-reviewed-today'];
  const JITEN_STATE_CLASS_SET = new Set(JITEN_STATE_CLASSES);

  function visibleWordSpelling(span) {
    const clone = span.cloneNode(true);
    clone.querySelectorAll('rt, rp').forEach(node => node.remove());
    return String(clone.textContent || '').normalize('NFKC').trim();
  }

  const gsmJitenTokenDebugSignatures = new Set();

  // GSM_JITEN_KANJI_GATED_YOMITAN_V5_QUERY_LEMMA:
  // The surface form is used only for the selective kanji heuristic and
  // candidate validation. The actual Yomitan search always uses the
  // whitespace-normalized Jiten dictionary headword (lemma).
  const GSM_YOMITAN_HAN_RE = /\p{Script=Han}/u;
  const GSM_YOMITAN_KATAKANA_ONLY_RE = /^[\p{Script=Katakana}\u30FC\u30FB]+$/u;
  const GSM_YOMITAN_FORM_CACHE = new Map();
  const GSM_YOMITAN_FORM_INFLIGHT = new Map();
  // Keep the final Yomitan-selected form attached to its Jiten span so every
  // later popup-priority publication uses the same resolved expression.
  const GSM_YOMITAN_PREFERRED_HEADWORD_BY_SPAN = new WeakMap();

  function gsmExtractJitenKanjiSequence(value) {
    return Array.from(String(value || '').normalize('NFKC'))
      .filter(character => GSM_YOMITAN_HAN_RE.test(character));
  }

  function gsmIsOrderedKanjiSubsequence(shorter, longer) {
    if (!shorter.length || shorter.length >= longer.length) return false;
    let index = 0;
    for (const character of longer) {
      if (character === shorter[index]) index++;
      if (index === shorter.length) return true;
    }
    return false;
  }

  function gsmSameKanjiSequence(left, right) {
    return left.length === right.length && left.every((character, index) => character === right[index]);
  }

  function gsmShouldQueryYomitanForJitenToken(token) {
    const surfaceKanji = gsmExtractJitenKanjiSequence(token.spelling);
    const headwordKanji = gsmExtractJitenKanjiSequence(token.headword);
    if (!surfaceKanji.length || !headwordKanji.length
        || gsmSameKanjiSequence(surfaceKanji, headwordKanji)) return false;

    const shorter = surfaceKanji.length < headwordKanji.length ? surfaceKanji : headwordKanji;
    const longer = surfaceKanji.length < headwordKanji.length ? headwordKanji : surfaceKanji;

    // Also query when both forms have the same number of kanji but use
    // different characters (悦んでいる -> 悦ぶ vs 喜ぶ).
    const sameLengthDifferentKanji = surfaceKanji.length === headwordKanji.length;
    const eligible = sameLengthDifferentKanji
      || gsmIsOrderedKanjiSubsequence(shorter, longer);
    if (eligible) {
      gsmRendererDebug('yomitan-eligible-token', {
        spelling: token.spelling,
        headword: token.headword,
        reading: token.reading,
        surfaceKanji,
        headwordKanji,
        queryTerm: gsmNormalizeYomitanExpression(token.headword),
      });
    }
    return eligible;
  }

  // Fold whitespace for Jiten/Yomitan identity. In particular, Jiten can
  // expose a lemma as "こみ 上げる" while Yomitan should receive "こみ上げる".
  function gsmNormalizeYomitanExpression(value) {
    return String(value || '').normalize('NFKC').replace(/\p{White_Space}+/gu, '');
  }

  function gsmNormalizeYomitanReading(value) {
    return jitenKatakanaToHiragana(
      String(value || '').normalize('NFKC').replace(/\p{White_Space}+/gu, ''),
    );
  }

  // GSM_JITEN_KANJI_GATED_YOMITAN_V7_QUERY_READING_INDEX:
  // Searching Yomitan with a mixed kana/kanji lemma (e.g. こみ上げる) returns
  // the kana/kanji expression itself, but does not necessarily expose alternate
  // orthographic forms (e.g. 込み上げる). Yomitan indexes both expression and
  // reading; querying the exact hiragana reading finds the orthographic entry.
  // We therefore require direct evidence that this candidate was returned by
  // an exact reading-index match, then retain strict reading/kanji constraints.
  function gsmYomitanSourceMatchesReading(headword, jitenReading) {
    const expected = gsmNormalizeYomitanReading(jitenReading);
    if (!expected) return false;
    const sources = Array.isArray(headword?.sources) ? headword.sources : [];
    return sources.some(source => {
      if (source?.matchSource !== 'reading' || source?.matchType !== 'exact') return false;
      return [source?.originalText, source?.transformedText, source?.deinflectedText]
        .some(value => gsmNormalizeYomitanReading(value) === expected);
    });
  }

  function gsmGetYomitanPreferredForm(dictionaryEntries, jitenSurface, jitenHeadword, jitenReading) {
    const expectedHeadword = gsmNormalizeYomitanExpression(jitenHeadword);
    const expectedReading = gsmNormalizeYomitanReading(jitenReading);
    const surfaceKanji = gsmExtractJitenKanjiSequence(jitenSurface);
    const headwordKanji = gsmExtractJitenKanjiSequence(jitenHeadword);
    if (!expectedHeadword || !expectedReading || !surfaceKanji.length || !headwordKanji.length
        || !Array.isArray(dictionaryEntries)) return null;

    for (const entry of dictionaryEntries) {
      if (entry?.type !== 'term' || !Array.isArray(entry.headwords)) continue;
      for (const candidate of entry.headwords) {
        const expression = String(candidate?.term || '').normalize('NFKC').trim();
        const reading = String(candidate?.reading || '').normalize('NFKC').trim();
        if (!expression || gsmNormalizeYomitanExpression(expression) === expectedHeadword) continue;
        if (gsmNormalizeYomitanReading(reading) !== expectedReading) continue;

        const candidateKanji = gsmExtractJitenKanjiSequence(expression);
        if (!gsmSameKanjiSequence(candidateKanji, surfaceKanji)) continue;
        // The selected Yomitan spelling must use exactly the surface kanji.
        // Its kanji sequence must also be ordered-compatible with Jiten's lemma.
        // Either direction is valid: the surface may omit lemma kanji
        // (押しつける -> 押しつけながら), or preserve kanji that Jiten writes
        // in kana (手をつなぐ -> 手を繋いで).
        const candidateFitsJitenLemma = gsmIsOrderedKanjiSubsequence(candidateKanji, headwordKanji);
        const jitenLemmaFitsCandidate = gsmIsOrderedKanjiSubsequence(headwordKanji, candidateKanji);
        const sameLengthDifferentKanji = candidateKanji.length === headwordKanji.length
          && !gsmSameKanjiSequence(candidateKanji, headwordKanji);
        if (!candidateFitsJitenLemma && !jitenLemmaFitsCandidate && !sameLengthDifferentKanji) continue;
        if (!gsmYomitanSourceMatchesReading(candidate, jitenReading)) continue;

        return {
          expression,
          reading,
          matchedBy: 'exact-reading-index-match-with-surface-kanji',
        };
      }
    }
    return null;
  }

  // Kana-script resolution is stricter than ordinary reading-index matching:
  // accept only the exact requested spelling with Jiten's same lexical reading.
  // This lets us distinguish a true Katakana entry from a Hiragana entry that
  // Yomitan may also return for a Katakana query because kana are equivalent.
  function gsmGetYomitanExactKanaForm(dictionaryEntries, requestedExpression, jitenReading) {
    const expectedExpression = gsmNormalizeYomitanExpression(requestedExpression);
    const expectedReading = gsmNormalizeYomitanReading(jitenReading);
    if (!expectedExpression || !expectedReading || !Array.isArray(dictionaryEntries)) return null;

    for (const entry of dictionaryEntries) {
      if (entry?.type !== 'term' || !Array.isArray(entry.headwords)) continue;
      for (const candidate of entry.headwords) {
        const expression = String(candidate?.term || '').normalize('NFKC').trim();
        const reading = String(candidate?.reading || '').normalize('NFKC').trim();
        if (!expression || !reading) continue;
        if (gsmNormalizeYomitanExpression(expression) !== expectedExpression) continue;
        if (gsmNormalizeYomitanReading(reading) !== expectedReading) continue;
        return {
          expression,
          reading,
          matchedBy: 'exact-kana-expression-and-jiten-reading',
        };
      }
    }
    return null;
  }

  function gsmGetYomitanKanaScriptQueryPlan(token) {
    const spelling = String(token?.spelling || '').normalize('NFKC').trim();
    const reading = String(token?.reading || '').normalize('NFKC').trim();
    if (!GSM_YOMITAN_KATAKANA_ONLY_RE.test(spelling) || !reading) return null;

    const fallbackTerm = gsmNormalizeYomitanReading(reading);
    const primaryTerm = gsmNormalizeYomitanExpression(jitenHiraganaToKatakana(fallbackTerm));
    const jitenHeadword = gsmNormalizeYomitanExpression(token?.headword || '');
    if (!primaryTerm || !fallbackTerm || primaryTerm === fallbackTerm || primaryTerm === jitenHeadword) return null;

    return {
      primaryTerm,
      primaryExpression: primaryTerm,
      fallbackTerm,
      fallbackExpression: fallbackTerm,
    };
  }

  function gsmGetYomitanFormCandidateAudit(dictionaryEntries, jitenSurface, jitenHeadword, jitenReading) {
    const expectedHeadword = gsmNormalizeYomitanExpression(jitenHeadword);
    const expectedReading = gsmNormalizeYomitanReading(jitenReading);
    const surfaceKanji = gsmExtractJitenKanjiSequence(jitenSurface);
    const headwordKanji = gsmExtractJitenKanjiSequence(jitenHeadword);
    const audit = [];
    for (let entryIndex = 0; entryIndex < (dictionaryEntries || []).length && audit.length < 40; entryIndex++) {
      const entry = dictionaryEntries[entryIndex];
      if (entry?.type !== 'term' || !Array.isArray(entry.headwords)) continue;
      for (let headwordIndex = 0; headwordIndex < entry.headwords.length && audit.length < 40; headwordIndex++) {
        const candidate = entry.headwords[headwordIndex];
        const expression = String(candidate?.term || '').normalize('NFKC').trim();
        const reading = String(candidate?.reading || '').normalize('NFKC').trim();
        const candidateKanji = gsmExtractJitenKanjiSequence(expression);
        const readingMatch = gsmNormalizeYomitanReading(reading) === expectedReading;
        const sameSurfaceKanji = gsmSameKanjiSequence(candidateKanji, surfaceKanji);
        const sourceMatchesReading = gsmYomitanSourceMatchesReading(candidate, jitenReading);
        if (!readingMatch && !sameSurfaceKanji && !sourceMatchesReading) continue;
        audit.push({
          entryIndex,
          headwordIndex,
          expression,
          reading,
          readingMatch,
          sameSurfaceKanji,
          candidateKanjiSubsequenceOfJitenHeadword: gsmIsOrderedKanjiSubsequence(candidateKanji, headwordKanji),
          jitenHeadwordKanjiSubsequenceOfCandidate: gsmIsOrderedKanjiSubsequence(headwordKanji, candidateKanji),
          kanjiSequenceCompatible: gsmIsOrderedKanjiSubsequence(candidateKanji, headwordKanji)
            || gsmIsOrderedKanjiSubsequence(headwordKanji, candidateKanji),
          differsFromJitenLemma: gsmNormalizeYomitanExpression(expression) !== expectedHeadword,
          sourceMatchesReading,
          sources: (candidate?.sources || []).slice(0, 3).map(source => ({
            originalText: String(source?.originalText || ''),
            transformedText: String(source?.transformedText || ''),
            deinflectedText: String(source?.deinflectedText || ''),
            matchType: String(source?.matchType || ''),
            matchSource: String(source?.matchSource || ''),
          })),
        });
      }
    }
    return audit;
  }

  function gsmGetYomitanDictionaryEntries(response) {
    const rows = Array.isArray(response) ? response : [response];
    const row = rows.find(item => item && Array.isArray(item.dictionaryEntries))
      || rows.find(item => item && Array.isArray(item?.results?.[0]?.dictionaryEntries));
    if (!row) return null;
    if (Array.isArray(row.dictionaryEntries)) return row.dictionaryEntries;
    return row.results[0].dictionaryEntries;
  }

  async function gsmRequestYomitanTermEntries(term, queryType = 'normalized-jiten-reading') {
    const bridge = window.gsmYomitanBridge;
    if (!bridge || typeof bridge.termEntries !== 'function') {
      gsmRendererDebug('yomitan-bridge-unavailable', { term, hasBridge: !!bridge,
        hasTermEntries: typeof bridge?.termEntries === 'function' });
      return { ok: false, dictionaryEntries: null };
    }
    try {
      gsmRendererDebug('yomitan-bridge-request-sent', {
        term, queryType,
        transport: 'window.gsmYomitanBridge.termEntries',
      });
      const response = await bridge.termEntries(term, { timeoutMs: 8000 });
      const dictionaryEntries = gsmGetYomitanDictionaryEntries(response);
      gsmRendererDebug('yomitan-bridge-response', {
        term,
        responseType: Array.isArray(response) ? 'array' : typeof response,
        dictionaryEntryCount: dictionaryEntries?.length ?? null,
        forms: (dictionaryEntries || []).slice(0, 8).map(entry => ({
          type: entry?.type,
          headwords: (entry?.headwords || []).slice(0, 12).map(headword => ({
            term: String(headword?.term || ''), reading: String(headword?.reading || ''),
            sources: (headword?.sources || []).slice(0, 4).map(source => ({
              originalText: String(source?.originalText || ''),
              transformedText: String(source?.transformedText || ''),
              deinflectedText: String(source?.deinflectedText || ''),
              matchType: String(source?.matchType || ''),
              matchSource: String(source?.matchSource || ''),
            })),
          })),
        })),
      });
      return { ok: Array.isArray(dictionaryEntries), dictionaryEntries };
    } catch (error) {
      gsmRendererDebug('yomitan-bridge-error', { term, error: String(error?.message || error).slice(0, 500) });
      return { ok: false, dictionaryEntries: null };
    }
  }

  function gsmStoreYomitanFormCache(key, value) {
    GSM_YOMITAN_FORM_CACHE.delete(key);
    GSM_YOMITAN_FORM_CACHE.set(key, value);
    while (GSM_YOMITAN_FORM_CACHE.size > 1200) {
      GSM_YOMITAN_FORM_CACHE.delete(GSM_YOMITAN_FORM_CACHE.keys().next().value);
    }
  }

  async function gsmResolveYomitanAlternateSpellings(tokens) {
    const pending = new Map();
    const fallbackPending = new Map();

    const addToGroup = (groups, term, item) => {
      const existing = groups.get(term);
      if (existing) existing.push(item);
      else groups.set(term, [item]);
    };

    const storePreferred = (item, preferred) => {
      gsmStoreYomitanFormCache(item.cacheKey, preferred);
      if (preferred) {
        item.token.yomitanHeadword = preferred.expression;
        item.token.yomitanReading = preferred.reading;
      }
    };

    for (const token of tokens) {
      token.yomitanHeadword = '';
      token.yomitanReading = '';
      if (!token.reading) continue;

      // Katakana-only tokens whose Jiten lemma is written in Hiragana need a
      // two-step dictionary check: exact Katakana spelling first, then Jiten's
      // original Hiragana reading. Other eligible tokens keep the existing
      // kanji/reading-index alternate-spelling resolver.
      const kanaPlan = gsmGetYomitanKanaScriptQueryPlan(token);
      if (!kanaPlan && !gsmShouldQueryYomitanForJitenToken(token)) continue;

      const queryTerm = kanaPlan
        ? kanaPlan.primaryTerm
        : gsmNormalizeYomitanReading(token.reading);
      if (!queryTerm) continue;
      const cacheKey = JSON.stringify([
        token.spelling,
        gsmNormalizeYomitanExpression(token.headword),
        gsmNormalizeYomitanReading(token.reading),
        kanaPlan ? 'kana-script-primary-then-hiragana-v1' : 'kanji-reading-index-v2-orthographic-variants',
      ]);
      if (GSM_YOMITAN_FORM_CACHE.has(cacheKey)) {
        const cached = GSM_YOMITAN_FORM_CACHE.get(cacheKey);
        if (cached) {
          token.yomitanHeadword = cached.expression;
          token.yomitanReading = cached.reading;
        }
        gsmRendererDebug('yomitan-form-cache-hit', {
          spelling: token.spelling,
          jitenHeadword: token.headword,
          queryTerm,
          queryMode: kanaPlan ? 'katakana-then-hiragana' : 'kanji-reading-index',
          matched: !!cached,
        });
        continue;
      }

      addToGroup(pending, queryTerm, {
        token,
        cacheKey,
        queryTerm,
        queryMode: kanaPlan ? 'kana-script' : 'kanji-alternate',
        kanaPlan,
      });
    }

    if (!pending.size) return;
    const groups = [...pending.entries()].slice(0, 40);
    gsmRendererDebug('yomitan-resolver-batch', {
      distinctQueries: pending.size,
      queriedTerms: groups.map(([term]) => term),
      kanaScriptQueries: groups.flatMap(([, items]) => items
        .filter(item => item.kanaPlan)
        .map(item => ({ spelling: item.token.spelling, primary: item.kanaPlan.primaryTerm,
          fallback: item.kanaPlan.fallbackTerm }))),
    });

    // Stage 1: query the Katakana spelling (or the existing Jiten reading query
    // for kanji tokens). If an exact Katakana entry is absent, queue a Hiragana
    // fallback query; do not choose based on Anki card availability.
    for (let offset = 0; offset < groups.length; offset += 4) {
      await Promise.all(groups.slice(offset, offset + 4).map(async ([term, items]) => {
        let request = GSM_YOMITAN_FORM_INFLIGHT.get(term);
        if (!request) {
          const queryType = items.some(item => item.kanaPlan)
            ? 'katakana-script-primary' : 'normalized-jiten-reading';
          request = gsmRequestYomitanTermEntries(term, queryType);
          GSM_YOMITAN_FORM_INFLIGHT.set(term, request);
        }
        let result;
        try { result = await request; }
        finally { if (GSM_YOMITAN_FORM_INFLIGHT.get(term) === request) GSM_YOMITAN_FORM_INFLIGHT.delete(term); }

        for (const item of items) {
          if (item.kanaPlan) {
            const primaryMatch = result?.ok && Array.isArray(result.dictionaryEntries)
              ? gsmGetYomitanExactKanaForm(
                  result.dictionaryEntries, item.kanaPlan.primaryExpression, item.token.reading,
                )
              : null;
            gsmRendererDebug('yomitan-kana-script-primary-result', {
              spelling: item.token.spelling,
              jitenHeadword: item.token.headword,
              primaryQuery: item.kanaPlan.primaryTerm,
              matched: !!primaryMatch,
              preferred: primaryMatch,
              dictionaryEntryCount: result?.dictionaryEntries?.length ?? null,
            });
            if (primaryMatch) {
              storePreferred(item, primaryMatch);
            } else {
              addToGroup(fallbackPending, item.kanaPlan.fallbackTerm, item);
            }
            continue;
          }

          if (!result?.ok || !Array.isArray(result.dictionaryEntries)) continue; // Never cache bridge failures.
          const preferred = gsmGetYomitanPreferredForm(
            result.dictionaryEntries, item.token.spelling, item.token.headword, item.token.reading,
          );
          gsmRendererDebug('yomitan-form-match-result', {
            spelling: item.token.spelling,
            jitenHeadword: item.token.headword,
            queryType: 'normalized-jiten-reading',
            jitenHeadwordNormalized: gsmNormalizeYomitanExpression(item.token.headword),
            jitenReading: item.token.reading,
            queryTerm: item.queryTerm,
            dictionaryEntryCount: result.dictionaryEntries.length,
            surfaceKanji: gsmExtractJitenKanjiSequence(item.token.spelling),
            headwordKanji: gsmExtractJitenKanjiSequence(item.token.headword),
            preferred,
            candidateAudit: preferred ? undefined : gsmGetYomitanFormCandidateAudit(
              result.dictionaryEntries, item.token.spelling, item.token.headword, item.token.reading,
            ),
          });
          storePreferred(item, preferred);
        }
      }));
    }

    if (!fallbackPending.size) return;
    const fallbackGroups = [...fallbackPending.entries()].slice(0, 40);
    gsmRendererDebug('yomitan-kana-script-fallback-batch', {
      distinctHiraganaQueries: fallbackPending.size,
      queriedTerms: fallbackGroups.map(([term]) => term),
    });

    // Stage 2: use Jiten's original Hiragana reading only when the exact
    // Katakana expression did not resolve in Yomitan.
    for (let offset = 0; offset < fallbackGroups.length; offset += 4) {
      await Promise.all(fallbackGroups.slice(offset, offset + 4).map(async ([term, items]) => {
        let request = GSM_YOMITAN_FORM_INFLIGHT.get(term);
        if (!request) {
          request = gsmRequestYomitanTermEntries(term, 'hiragana-script-fallback');
          GSM_YOMITAN_FORM_INFLIGHT.set(term, request);
        }
        let result;
        try { result = await request; }
        finally { if (GSM_YOMITAN_FORM_INFLIGHT.get(term) === request) GSM_YOMITAN_FORM_INFLIGHT.delete(term); }
        if (!result?.ok || !Array.isArray(result.dictionaryEntries)) return; // Do not cache transport failures.

        for (const item of items) {
          const preferred = gsmGetYomitanExactKanaForm(
            result.dictionaryEntries, item.kanaPlan.fallbackExpression, item.token.reading,
          );
          gsmRendererDebug('yomitan-kana-script-fallback-result', {
            spelling: item.token.spelling,
            jitenHeadword: item.token.headword,
            primaryQuery: item.kanaPlan.primaryTerm,
            fallbackQuery: item.kanaPlan.fallbackTerm,
            matched: !!preferred,
            preferred,
            dictionaryEntryCount: result.dictionaryEntries.length,
          });
          storePreferred(item, preferred);
        }
      }));
    }
  }

  function jitenLookupTokensForSpans(spans) {
    return spans.map(span => ({
      spelling: visibleWordSpelling(span),
      headword: String(span.dataset?.gsmHeadword || '').normalize('NFKC').trim(),
      reading: String(span.dataset?.gsmReading || '').normalize('NFKC').trim(),
      yomitanHeadword: '',
      yomitanReading: '',
    }));
  }

  function applyAnkiStatesToSpans(spans, statesByIndex) {
    if (!Array.isArray(statesByIndex) || statesByIndex.length !== spans.length) return;
    for (let index = 0; index < spans.length; index++) {
      const state = statesByIndex[index];
      if (!Array.isArray(state)) continue; // No exact Anki lookup-key match: keep Jiten's state.
      const span = spans[index];
      for (const name of JITEN_STATE_CLASSES) span.classList.remove(name);
      for (const stateIndex of state) {
        const name = Number.isInteger(stateIndex) ? ANKI_TO_JITEN_STATE[stateIndex] : null;
        if (name && JITEN_STATE_CLASS_SET.has(name)) span.classList.add(name);
      }
      // The Anki override uses state 6 for the special unvoiced-tag marker.
      if (state.includes(6)) span.classList.add('unvoiced');
      else span.classList.remove('unvoiced');
    }
  }

  async function applyAnkiStatesToJitenWords(expectedGeneration = highlightGeneration) {
    if (!parseContainer || !window.ipcRenderer?.invoke) {
      gsmRendererDebug('anki-states-skipped', {
        hasParseContainer: !!parseContainer,
        hasInvoke: typeof window.ipcRenderer?.invoke === 'function',
      });
      return false;
    }
    const spans = Array.from(parseContainer.querySelectorAll('.jiten-word'));
    if (!spans.length) return expectedGeneration === highlightGeneration;
    const lookupTokens = jitenLookupTokensForSpans(spans);
    const visibleSpellings = lookupTokens.map(token => token.spelling);
    const parsedText = String(parseContainer.textContent || '').normalize('NFKC');
    if (parsedText.includes('徐々に')) {
      const signature = JSON.stringify(lookupTokens);
      if (!gsmJitenTokenDebugSignatures.has(signature)) {
        if (gsmJitenTokenDebugSignatures.size >= 20) gsmJitenTokenDebugSignatures.delete(gsmJitenTokenDebugSignatures.values().next().value);
        gsmJitenTokenDebugSignatures.add(signature);
        console.log('[AnkiStates] Jiten tokenization for 徐々に:', JSON.stringify({
          adjacentTokens: lookupTokens.filter((token, index) => token.spelling.includes('徐々')
            || lookupTokens[index - 1]?.spelling.includes('徐々') || lookupTokens[index + 1]?.spelling.includes('徐々')),
          phrasePresentInParse: parsedText.includes('徐々に'),
        }));
      }
    }
    // The headword travels with each token. Do not deduplicate by surface form:
    // identical visible text can have different contextual Jiten headwords.
    if (!lookupTokens.some(token => token.spelling && token.headword)) {
      return expectedGeneration === highlightGeneration;
    }

    let statesByIndex;
    try {
      // This lookup is deliberately gated: ordinary tokens never invoke Yomitan.
      // Yomitan returns alternate headwords only when the exact Jiten headword
      // and reading are present in the same grouped dictionary entry.
      await gsmResolveYomitanAlternateSpellings(lookupTokens);
      if (expectedGeneration !== highlightGeneration) return false;

      // Feed the exact same verified Yomitan expression used by the Anki
      // lookup into the existing Yomitan popup-priority feature.
      // The WeakMap keeps this preference available when mirrorHighlights()
      // republishes OCR attributes after the asynchronous lookup completes.
      let resolvedPopupPriorityCount = 0;
      for (let index = 0; index < spans.length; index++) {
        const span = spans[index];
        const resolvedHeadword = String(lookupTokens[index]?.yomitanHeadword || '')
          .normalize('NFKC').trim();
        GSM_YOMITAN_PREFERRED_HEADWORD_BY_SPAN.delete(span);
        if (resolvedHeadword) {
          GSM_YOMITAN_PREFERRED_HEADWORD_BY_SPAN.set(span, resolvedHeadword);
          resolvedPopupPriorityCount++;
        }
      }
      // Always republish: if a previous lookup had a Yomitan alternative but
      // this pass does not, the OCR boxes must fall back to the current Jiten key.
      publishJitenPreferredHeadwords(parseContainer.querySelectorAll('p[data-line-index]'));
      gsmRendererDebug('yomitan-popup-priority-updated', {
        resolvedTokenCount: resolvedPopupPriorityCount,
        tokens: lookupTokens.filter(token => token.yomitanHeadword).map(token => ({
          spelling: token.spelling,
          jitenHeadword: token.headword,
          preferredHeadword: token.yomitanHeadword,
        })),
      });

      statesByIndex = await window.ipcRenderer.invoke('gsm-anki-display-states', {
        tokens: lookupTokens, debugText: parseContainer.textContent || '',
      });
    } catch (error) {
      gsmRendererDebug('anki-states-error', {
        message: String(error?.message || error).slice(0, 500),
        tokenCount: lookupTokens.length,
      });
      console.warn('[AnkiStates] Could not apply states to Jiten spans:', error?.message || error);
      return false;
    }
    if (expectedGeneration !== highlightGeneration) return false;
    if (!Array.isArray(statesByIndex) || statesByIndex.length !== spans.length) {
      gsmRendererDebug('anki-states-invalid-response', {
        responseType: Array.isArray(statesByIndex) ? 'array' : typeof statesByIndex,
        responseLength: Array.isArray(statesByIndex) ? statesByIndex.length : null,
        tokenCount: lookupTokens.length,
      });
      return false;
    }
    gsmRendererDebug('anki-states-returned', {
      tokenCount: lookupTokens.length,
      targetResults: lookupTokens
        .map((token, index) => ({ ...token, state: statesByIndex[index] ?? null }))
        .filter(token => /口|付け|使い/.test(token.spelling)),
    });
    applyAnkiStatesToSpans(spans, statesByIndex);
    const tagsApplied = await applyTagMatchesToSpans(spans, lookupTokens, expectedGeneration); // GSM_TAGRULES
    if (expectedGeneration !== highlightGeneration || !tagsApplied) return false;
    return true;
  }

  function onParseComplete() {
    gsmRendererDebug('parse-complete', {
      signature: containerSignature,
      spanCount: parseContainer?.querySelectorAll('.jiten-word').length || 0,
      targetSpans: Array.from(parseContainer?.querySelectorAll('.jiten-word') || [])
        .map(span => ({
          spelling: visibleWordSpelling(span),
          classes: Array.from(span.classList),
        }))
        .filter(item => /口|付け/.test(item.spelling)),
    });
    clearTimeout(runningParseTimer);
    runningParseTimer = null;
    lastParsedSignature = containerSignature;
    lastParseFinishedAt = Date.now();
    runningSignature = null;
    restoreOverlayElements(); // defensive; requestParse normally restores synchronously

    // Do not expose partially initialized Jiten results. The overlay is revealed
    // only after this exact frame's Anki states and enabled tag rules have loaded.
    const generation = containerGeneration;
    if (generation !== highlightGeneration || containerSignature !== currentSignature) {
      highlightsReady = false;
      hideAllSegments();
      schedulePendingParse();
      return;
    }
    // This is a fresh parse generation. Drop any preference left on reused
    // Jiten span nodes before publishing the provisional Jiten headwords. The
    // resolver below will replace them with verified Yomitan forms where needed.
    for (const span of parseContainer.querySelectorAll('.jiten-word')) {
      GSM_YOMITAN_PREFERRED_HEADWORD_BY_SPAN.delete(span);
    }
    // Publish before the Anki lookup so Yomitan can use the contextual Jiten
    // headword immediately; the resolved form is republished after the lookup.
    publishJitenPreferredHeadwords(parseContainer.querySelectorAll('p[data-line-index]'));
    void applyAnkiStatesToJitenWords(generation).then(success => {
      if (generation !== highlightGeneration || containerSignature !== currentSignature) return;
      highlightsReady = success === true;
      if (highlightsReady) {
        mirrorHighlights();
        notifyNavigationTokens();
      } else {
        hideAllSegments();
      }
    }).finally(() => {
      schedulePendingParse();
    });
  }

  // Temporarily hide overlay text elements so Jiten only parses our container.
  function hideOverlayElements() {
    const containers = document.querySelectorAll('.text-block-container, #boxes, #main-box');
    containers.forEach(el => {
      el.dataset.gsmWasDisplay = el.style.display || '';
      el.style.display = 'none';
    });
  }

  function restoreOverlayElements() {
    const containers = document.querySelectorAll('[data-gsm-was-display]');
    containers.forEach(el => {
      el.style.display = el.dataset.gsmWasDisplay || '';
      delete el.dataset.gsmWasDisplay;
    });
  }

  // Request Jiten to parse the detected blocks. Never hides/delays the visible OCR
  // text — it only draws SRS highlights on top, asynchronously. The real text
  // boxes are hidden ONLY across the synchronous parse trigger (no paint happens
  // in between) so Jiten's whole-page Alt+P parse excludes them.
  function requestParse(lines, lineBlocks) {
    if (!enabled || !available) return Promise.resolve();
    if (!parseContainer) init();
    if (!Array.isArray(lines) || lines.length === 0) {
      clearJitenPreferredHeadwords();
      return Promise.resolve();
    }

    // Keep the grouping when refreshing the same frame without new detection.
    if (lineBlocks === undefined && lines === currentLines) lineBlocks = currentLineBlocks;
    currentLineBlocks = lineBlocks ? new Map(lineBlocks) : null;
    currentBlocks = buildParseBlocks(lines, currentLineBlocks);
    const signature = signatureForBlocks(currentBlocks);
    currentLines = lines;
    currentSignature = signature;
    // Remove stale metadata immediately when OCR text/layout changes. A same-text
    // refresh republishes it below; a new parse republishes it on completion.
    clearJitenPreferredHeadwords();
    if (signature === lastParsedSignature && Date.now() - lastParseFinishedAt < 300_000) {
      // Text unchanged, just re-draw over the (possibly re-laid-out) boxes.
      publishJitenPreferredHeadwords(parseContainer.querySelectorAll('p[data-line-index]'));
      mirrorHighlights();
      notifyNavigationTokens();
      void applyAnkiStatesToJitenWords().finally(() => {
        mirrorHighlights();
        notifyNavigationTokens();
      });
      return Promise.resolve();
    }

    hideAllSegments();
    // Only the newest frame waits behind an active Reader parse. Never replace
    // its DOM while the extension is still writing results into that DOM.
    schedulePendingParse();
    return Promise.resolve();
  }

  function buildParseBlocks(lines, lineBlocks) {
    const blocks = new Map();
    lines.forEach((line, lineIndex) => {
      // Unmapped lines remain independent, including callers without detection.
      const key = lineBlocks?.get(lineIndex) ?? Symbol();
      let block = blocks.get(key);
      if (!block) {
        block = { text: '', lineRanges: [] };
        blocks.set(key, block);
      }
      const text = line?.text || '';
      const start = block.text.length;
      // Match block_detection.getBlockRawText: concatenate in OCR order without
      // adding separators or normalizing text (the broker caches exact text).
      block.text += text;
      block.lineRanges.push({ lineIndex, start, end: block.text.length });
    });
    return Array.from(blocks.values());
  }

  function signatureForBlocks(blocks) {
    // Include membership/offsets so regrouping unchanged lines cannot reuse the
    // wrong paragraph ranges. Renumbering identical blocks needs no new parse.
    return JSON.stringify(blocks);
  }

  function schedulePendingParse() {
    if (!enabled || !available || !currentLines || runningSignature) return;
    const signature = currentSignature;
    if (pendingParseTimer && pendingSignature === signature) return;
    clearTimeout(pendingParseTimer);
    pendingParseTimer = null;
    if (signature === lastParsedSignature && Date.now() - lastParseFinishedAt < 300_000) return;
    pendingSignature = signature;
    // Coalesce requests made in the same renderer turn, but do not duplicate the
    // broker's upstream throttle here. The broker already owns request pacing,
    // batching, caching, and duplicate suppression; delaying at this layer also
    // delayed cache hits and made highlights feel arbitrarily slow.
    pendingParseTimer = setTimeout(() => {
      pendingParseTimer = null;
      startParse();
    }, 0);
  }

  function startParse() {
    gsmRendererDebug('start-parse', {
      enabled,
      available,
      hasLines: !!currentLines,
      hasLocalParser: typeof localParser === 'function',
      blockCount: currentBlocks.length,
      signature: currentSignature,
    });
    if (!enabled || !available || !currentLines) return;
    containerSignature = currentSignature;
    containerGeneration = highlightGeneration;
    clearJitenPreferredHeadwords();
    parseContainer.innerHTML = '';
    containerBlocks = new Map();
    // Japanese script detection also excludes English with wide punctuation.
    const containsJapanese = (text) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
    if (!currentBlocks.some((block) => containsJapanese(block.text))) {
      lastParsedSignature = containerSignature;
      lastParseFinishedAt = Date.now();
      highlightsReady = containerGeneration === highlightGeneration;
      notifyNavigationTokens();
      return;
    }
    runningSignature = containerSignature;
    // Empty parses and extension failures may produce no word mutations. This
    // timeout releases the next frame without repeatedly retrying the same one.
    if (!localParser) runningParseTimer = setTimeout(onParseComplete, 30_000);

    // One Reader paragraph per detected block. Keep every line in a Japanese
    // block, including punctuation/Latin-only lines that affect its cache key.
    for (const block of currentBlocks) {
      if (!containsJapanese(block.text)) continue;
      const p = document.createElement('p');
      const firstLineIndex = block.lineRanges[0].lineIndex;
      p.dataset.lineIndex = String(firstLineIndex);
      p.textContent = block.text;
      containerBlocks.set(firstLineIndex, block);
      parseContainer.appendChild(p);
    }
    if (localParser) {
      void parseLocally(currentBlocks.filter(block => containsJapanese(block.text)));
      return;
    }

    // Make parse container renderable (move on-screen temporarily for Jiten).
    parseContainer.style.left = '0';
    parseContainer.style.top = '0';
    parseContainer.style.width = 'auto';
    parseContainer.style.height = 'auto';
    parseContainer.style.opacity = '0.01'; // near-invisible but renderable

    hideOverlayElements();
    try {
      triggerJitenParse();
    } finally {
      restoreOverlayElements();
      resetParseContainerPosition();
    }

    // Highlights are drawn later by the mutation observer (onParseComplete).
  }

  function resetParseContainerPosition() {
    if (!parseContainer) return;
    parseContainer.style.left = '-99999px';
    parseContainer.style.top = '-99999px';
    parseContainer.style.width = '1px';
    parseContainer.style.height = '1px';
    parseContainer.style.opacity = '0';
  }

  function triggerJitenParse() {
    const opts = {
      key: 'p',
      code: 'KeyP',
      keyCode: 80,
      which: 80,
      altKey: true,
      bubbles: true,
      cancelable: true,
    };
    window.dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', opts));
    }, 50);
  }

  // Read Jiten-parsed spans and draw one overlay box per token over the union
  // rect of its .text-box glyphs.
  // ---- GSM_JITENBOUNDS ----------------------------------------------------------------
  // Keep Yomitan's lookup range aligned with Jiten's token boundaries.
  // Unwrapped characters such as punctuation remain one-character words.
  // GSM_HOVERSTART: mirror the saved lookup start mode for the bundled Yomitan scanner.
  async function refreshHoverStartMode() {
    if (!window.ipcRenderer?.invoke) return;
    try {
      const result = await window.ipcRenderer.invoke('gsm-jiten-hover-get');
      const mode = result && result.hoverStart === 'cursor' ? 'cursor' : 'word';
      if (document.documentElement.getAttribute('data-gsm-hover-start') !== mode) {
        document.documentElement.setAttribute('data-gsm-hover-start', mode);
      }
    } catch { /* keep the last mode */ }
  }
  if (typeof window !== 'undefined') {
    setTimeout(() => { void refreshHoverStartMode(); }, 1000);
    setInterval(() => { void refreshHoverStartMode(); }, 3000);
  }

  let wordBoundsKey = '';

  function clearJitenWordBoundaries() {
    wordBoundsKey = '';
    for (const el of document.querySelectorAll('[data-gsm-ws],[data-gsm-we],[data-gsm-bounds]')) {
      el.removeAttribute('data-gsm-ws');
      el.removeAttribute('data-gsm-we');
      el.removeAttribute('data-gsm-bounds');
    }
  }

  // GSM_JITEN_HEADWORD_PRIORITY: expose Jiten's contextual dictionary headword
  // on every OCR glyph belonging to that token. Yomitan reads the attribute at
  // the hovered glyph and uses it only as a result-ordering preference.
  function clearJitenPreferredHeadwords() {
    for (const box of document.querySelectorAll('[data-gsm-jiten-headword], [data-gsm-jiten-reading], [data-gsm-jiten-new]')) {
      box.removeAttribute('data-gsm-jiten-headword');
      box.removeAttribute('data-gsm-jiten-reading');
      box.removeAttribute('data-gsm-jiten-new');
    }
    // The popup may still be open while a new OCR/Jiten parse is replacing its
    // source text. Do not let a detached token's old state affect that popup.
    window.__gsmLastHoveredJitenWordBox = null;
  }

  // Keep this script identical to GSM_JITEN_KANA_ONLY_RE in main.js so
  // Yomitan's preferred entry follows the same spelling-vs-reading choice as
  // the Anki lookup. Kana-only surface forms use Jiten's reading; mixed/kanji
  // surface forms use Jiten's dictionary headword. Jiten readings are often
  // returned in katakana, so convert them to the script used by the visible
  // kana-only spelling before asking Yomitan to promote the matching entry.
  const GSM_JITEN_KANA_ONLY_RE = /^(?=[\p{Script=Hiragana}\p{Script=Katakana}\u30FC\u30FB\p{P}]*[\p{Script=Hiragana}\p{Script=Katakana}])[\p{Script=Hiragana}\p{Script=Katakana}\u30FC\u30FB\p{P}]+$/u;
  const GSM_JITEN_HIRAGANA_RE = /\p{Script=Hiragana}/u;
  const GSM_JITEN_KATAKANA_RE = /\p{Script=Katakana}/u;

  function jitenKatakanaToHiragana(value) {
    return Array.from(value, character => {
      const codePoint = character.codePointAt(0);
      if (codePoint >= 0x30A1 && codePoint <= 0x30F6) {
        return String.fromCodePoint(codePoint - 0x60);
      }
      if (codePoint === 0x30FD) return 'ゝ';
      if (codePoint === 0x30FE) return 'ゞ';
      if (codePoint === 0x30F7) return 'わ\u3099';
      if (codePoint === 0x30F8) return 'ゐ\u3099';
      if (codePoint === 0x30F9) return 'ゑ\u3099';
      if (codePoint === 0x30FA) return 'を\u3099';
      return character;
    }).join('');
  }

  function jitenHiraganaToKatakana(value) {
    return Array.from(value, character => {
      const codePoint = character.codePointAt(0);
      if (codePoint >= 0x3041 && codePoint <= 0x3096) {
        return String.fromCodePoint(codePoint + 0x60);
      }
      if (codePoint === 0x309D) return 'ヽ';
      if (codePoint === 0x309E) return 'ヾ';
      return character;
    }).join('');
  }

  function getJitenPreferredLookupKey(span) {
    // A verified Yomitan alternative is the final canonical expression.
    // Prefer it over Jiten's original lemma so the popup and Anki agree.
    const resolvedYomitanHeadword = String(
      GSM_YOMITAN_PREFERRED_HEADWORD_BY_SPAN.get(span) || '',
    ).normalize('NFKC').trim();
    if (resolvedYomitanHeadword) return resolvedYomitanHeadword;

    const surface = String(span?.textContent || '').normalize('NFKC').trim();
    const headword = String(span?.dataset?.gsmHeadword || '').normalize('NFKC').trim();
    const reading = String(span?.dataset?.gsmReading || '').normalize('NFKC').trim();
    const kanaOnlySurface = !!surface && GSM_JITEN_KANA_ONLY_RE.test(surface);
    if (!kanaOnlySurface || !reading) return headword;

    const surfaceHasHiragana = GSM_JITEN_HIRAGANA_RE.test(surface);
    const surfaceHasKatakana = GSM_JITEN_KATAKANA_RE.test(surface);
    if (surfaceHasHiragana && !surfaceHasKatakana) {
      return jitenKatakanaToHiragana(reading);
    }
    if (surfaceHasKatakana && !surfaceHasHiragana) {
      return jitenHiraganaToKatakana(reading);
    }
    return reading;
  }

  function publishJitenPreferredHeadwords(paragraphs) {
    try {
      clearJitenPreferredHeadwords();
      for (const p of paragraphs) {
        for (const [span, range] of computeJitenSpanRanges(p)) {
          const preferredHeadword = getJitenPreferredLookupKey(span);
          if (!preferredHeadword) continue;
          for (const piece of getLineRangesForSpan(p, range)) {
            for (const box of getTextBoxesForRange(piece.lineIndex, piece.start, piece.end)) {
              box.setAttribute('data-gsm-jiten-headword', preferredHeadword);
              const preferredReading = String(span.dataset?.gsmReading || '').normalize('NFKC').trim();
              if (preferredReading) box.setAttribute('data-gsm-jiten-reading', preferredReading);
              else box.removeAttribute('data-gsm-jiten-reading');
              if (span.classList.contains('new')) box.setAttribute('data-gsm-jiten-new', '1');
              else box.removeAttribute('data-gsm-jiten-new');
            }
          }
        }
      }
    } catch (error) {
      clearJitenPreferredHeadwords();
      console.debug('[JitenHighlight] Could not publish preferred headwords for Yomitan:', error);
    }
  }

  function publishJitenWordBoundaries(paragraphs) {
    try {
      let tokenCount = 0;
      for (const p of paragraphs) tokenCount += p.querySelectorAll('.jiten-word').length;
      const key = containerSignature + '|' + tokenCount;
      if (key === wordBoundsKey && document.querySelector('[data-gsm-bounds]')) return;
      clearJitenWordBoundaries();
      for (const p of paragraphs) {
        const block = containerBlocks.get(Number(p.dataset.lineIndex));
        if (!block) continue;
        for (const lineRange of block.lineRanges) {
          for (const box of getTextBoxesForRange(lineRange.lineIndex, 0, 1e9)) {
            box.setAttribute('data-gsm-ws', '1');
            box.setAttribute('data-gsm-we', '1');
            const container = box.closest('.text-block-container');
            if (container) container.setAttribute('data-gsm-bounds', '1');
          }
        }
        for (const range of computeJitenSpanRanges(p).values()) {
          const boxes = [];
          for (const piece of getLineRangesForSpan(p, range)) {
            boxes.push(...getTextBoxesForRange(piece.lineIndex, piece.start, piece.end));
          }
          if (boxes.length === 0) continue;
          for (const box of boxes) {
            box.removeAttribute('data-gsm-ws');
            box.removeAttribute('data-gsm-we');
          }
          boxes[0].setAttribute('data-gsm-ws', '1');
          boxes[boxes.length - 1].setAttribute('data-gsm-we', '1');
        }
      }
      wordBoundsKey = key;
    } catch (error) {
      clearJitenWordBoundaries();
    }
  }

  function mirrorHighlights() {
    if (!visible || !enabled || !available || !highlightsReady || !parseContainer || !currentLines || containerSignature !== currentSignature) {
      hideAllSegments();
      return;
    }

    // Reset container position after parse
    resetParseContainerPosition();

    const paragraphs = parseContainer.querySelectorAll('p[data-line-index]');
    if (paragraphs.length === 0) {
      hideAllSegments();
      clearJitenPreferredHeadwords();
      return;
    }

    publishJitenPreferredHeadwords(paragraphs);

    // Collect a flat list of { rect, classes } highlight segments. A token may
    // produce more than one rect if its glyph boxes wrap across visual lines.
    const segments = [];
    for (const p of paragraphs) {
      // Map each .jiten-word span from block offsets back to its source lines.
      const spanRanges = computeJitenSpanRanges(p);
      if (spanRanges.size === 0) continue;

      for (const [span, range] of spanRanges) {
        const classes = getSegmentClassesForSpan(span);
        if (!classes) continue;

        for (const { lineIndex, start, end } of getLineRangesForSpan(p, range)) {
          const boxes = getTextBoxesForRange(lineIndex, start, end);
          for (const rect of getTokenRunRects(boxes)) {
            segments.push({ rect, classes });
          }
        }
      }
    }

    renderOverlaySegments(segments);
    publishJitenWordBoundaries(paragraphs); // GSM_JITENBOUNDS

    if (segments.length > 0) {
      console.log('[JitenHighlight] Drew', segments.length, 'token highlight(s) from Jiten Reader');
    }
  }

  // Walk a paragraph's base text (skipping <rt> furigana) and return a Map of each
  // .jiten-word span -> {start, len}. Characters Jiten leaves unwrapped (punctuation,
  // spaces) still advance the offset, keeping ranges aligned with the text boxes.
  function computeJitenSpanRanges(p) {
    const ranges = new Map();
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        let parent = node.parentElement;
        while (parent && parent !== p) {
          if (parent.tagName === 'RT') return NodeFilter.FILTER_REJECT;
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (len === 0) continue;

      // Find the nearest enclosing .jiten-word ancestor, if any.
      let span = node.parentElement;
      while (
        span && span !== p
        && !(span.classList && span.classList.contains('jiten-word'))
      ) {
        span = span.parentElement;
      }

      if (span && span !== p && span.classList && span.classList.contains('jiten-word')) {
        const existing = ranges.get(span);
        if (existing) {
          existing.len += len;
        } else {
          ranges.set(span, { start: offset, len });
        }
      }

      offset += len;
    }

    return ranges;
  }

  function getLineRangesForSpan(p, range) {
    const block = containerBlocks.get(Number(p.dataset.lineIndex));
    if (!block) return [];
    const end = range.start + range.len;
    return block.lineRanges
      .filter(line => range.start < line.end && end > line.start)
      .map(line => ({
        lineIndex: line.lineIndex,
        start: Math.max(range.start, line.start) - line.start,
        end: Math.min(end, line.end) - line.start,
      }));
  }

  // Build the CSS class list for a token's overlay highlight, or null if the span
  // carries no highlightable state.
  // ---- GSM_TAGRULES: user-defined Anki tag styles ---------------------------------------
  let tagRules = [];
  let tagRulesRevision = -1;
  let tagStyleElement = null;
  let dailyReviewMarkerStyle = {
    color: '#d6a13a', style: 'dotted', thickness: 2, position: 'overline', opacity: 0.3, enabled: true,
  };
  const TAG_CLASS_RE = /^anki-tag-(\d+)$/;

  function tagIndexesOnSpan(cl) {
    const indexes = [];
    for (const name of cl) {
      const match = TAG_CLASS_RE.exec(name);
      if (match) indexes.push(Number(match[1]));
    }
    return indexes;
  }

  function tagRuleCss(rule, index) {
    if (!rule || !rule.enabled || !/^#[0-9a-f]{6}$/i.test(rule.color)) return '';
    const selector = '.gsm-jiten-hl.gsm-tag-' + index;
    if (rule.position === 'background') {
      const r = parseInt(rule.color.slice(1, 3), 16);
      const g = parseInt(rule.color.slice(3, 5), 16);
      const b = parseInt(rule.color.slice(5, 7), 16);
      return selector + '{background-color:rgba(' + r + ',' + g + ',' + b + ',' + rule.opacity + ') !important;}';
    }
    const side = rule.position === 'overline' ? 'top' : 'bottom';
    return selector + '{border-' + side + ':' + rule.thickness + 'px ' + rule.style + ' ' + rule.color + ' !important;}';
  }

  function applyTagRulesToStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    if (!tagStyleElement || !tagStyleElement.isConnected) {
      tagStyleElement = document.getElementById('gsm-anki-tag-style') || document.createElement('style');
      tagStyleElement.id = 'gsm-anki-tag-style';
      document.head.appendChild(tagStyleElement);
    }
    // Emitted in reverse so that, for the same property, the rule listed first wins.
    tagStyleElement.textContent = tagRules.map(tagRuleCss).filter(Boolean).reverse().join('\n');
  }

  async function applyTagMatchesToSpans(spans, tokens, expectedGeneration = highlightGeneration) {
    if (expectedGeneration !== highlightGeneration) return false;
    for (const span of spans) {
      for (const name of [...span.classList]) if (TAG_CLASS_RE.test(name)) span.classList.remove(name);
    }
    if (!tagRules.some(rule => rule.enabled)) return true;
    if (!window.ipcRenderer?.invoke) return false;

    // Blacklisted spans must not enter the Anki tag lookup at all. The state
    // pass runs immediately before this function, so this also catches Jiten's
    // own blacklisted state in addition to GSM's local popup blacklist.
    const eligibleIndices = [];
    const eligibleTokens = [];
    for (let index = 0; index < spans.length; index++) {
      if (spans[index].classList.contains('blacklisted')) continue;
      eligibleIndices.push(index);
      eligibleTokens.push(tokens[index]);
    }
    if (!eligibleTokens.length) return true;

    let matchesByIndex;
    try {
      matchesByIndex = await window.ipcRenderer.invoke('gsm-anki-tag-matches', { tokens: eligibleTokens });
    } catch { return false; }
    if (expectedGeneration !== highlightGeneration) return false;
    if (!Array.isArray(matchesByIndex) || matchesByIndex.length !== eligibleIndices.length) return false;
    for (let resultIndex = 0; resultIndex < eligibleIndices.length; resultIndex++) {
      const spanIndex = eligibleIndices[resultIndex];
      const list = matchesByIndex[resultIndex];
      if (!Array.isArray(list)) continue;
      for (const tagIndex of list) {
        if (Number.isInteger(tagIndex) && tagIndex >= 0 && tagIndex < 64) {
          spans[spanIndex].classList.add('anki-tag-' + tagIndex);
        }
      }
    }
    return true;
  }

  function applyDailyReviewMarkerStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    let style = document.getElementById('gsm-not-reviewed-today-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'gsm-not-reviewed-today-style';
      document.head.appendChild(style);
    }
    const rule = dailyReviewMarkerStyle || {};
    if (rule.enabled === false || !/^#[0-9a-f]{6}$/i.test(String(rule.color || ''))) {
      style.textContent = '';
      return;
    }
    const color = String(rule.color);
    const thickness = Math.min(8, Math.max(1, Number(rule.thickness) || 2));
    const position = ['underline', 'overline', 'background'].includes(rule.position) ? rule.position : 'overline';
    const selector = '.gsm-jiten-hl.gsm-jiten-hl--not-reviewed-today';
    if (position === 'background') {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      const opacity = Math.min(1, Math.max(0.05, Number(rule.opacity) || 0.3));
      style.textContent = selector + '{background-color:rgba(' + r + ',' + g + ',' + b + ',' + opacity + ') !important;}';
    } else {
      const side = position === 'overline' ? 'top' : 'bottom';
      const lineStyle = ['solid', 'dashed', 'dotted', 'double'].includes(rule.style) ? rule.style : 'dotted';
      style.textContent = selector + '{border-' + side + ':' + thickness + 'px ' + lineStyle + ' ' + color + ' !important;}';
    }
  }

  async function refreshTagRules(force) {
    if (!window.ipcRenderer?.invoke) return;
    let payload;
    try { payload = await window.ipcRenderer.invoke('gsm-anki-tag-styles'); } catch { return; }
    if (!payload || !Array.isArray(payload.rules)) return;
    if (!force && payload.revision === tagRulesRevision) return;
    tagRulesRevision = payload.revision;
    tagRules = payload.rules;
    if (payload.dailyReviewMarker && typeof payload.dailyReviewMarker === 'object') {
      dailyReviewMarkerStyle = payload.dailyReviewMarker;
    }
    applyTagRulesToStyle();
    applyDailyReviewMarkerStyle();
    if (parseContainer && highlightsReady) {
      void refreshVisibleStates();
    }
  }

  if (typeof window !== 'undefined') {
    setTimeout(() => { void refreshTagRules(true); }, 1500);
    setInterval(() => { void refreshTagRules(false); }, 3000);
  }

  function getSegmentClassesForSpan(span, ignoreUnvoiced) {
    const cl = span.classList;
    // GSM_ANKISTATES_FIXED_V2: Anki state 6 also marks unvoiced notes.
    const unvoiced = !ignoreUnvoiced && cl.contains('unvoiced'); // GSM_UNVOICED (legacy marker, no longer set by Anki states)
    const tagIndexes = ignoreUnvoiced ? [] : tagIndexesOnSpan(cl); // GSM_TAGRULES
    if (cl.contains('unparsed') || cl.contains('misparsed')) return null;

    if (!configuredVisibleClasses && !unvoiced && !tagIndexes.length && !cl.contains('not-reviewed-today')) {
      // Preserve legacy behavior until the Jiten settings bridge supplies the
      // user's style config.
      for (const s of KNOWN_STATE_CLASSES) {
        if (cl.contains(s)) return null;
      }
    }

    const classes = [SEGMENT_CLASS];
    let hasVisibleClass = false;
    for (const s of JITEN_STATE_CLASSES) {
      if (!cl.contains(s) || (s !== 'not-reviewed-today' && !shouldRenderClass(s)) || (unvoiced && s === 'redundant')) continue;
      classes.push(SEGMENT_CLASS + '--' + s);
      hasVisibleClass = true;
    }
    if (cl.contains('frequent') && shouldRenderClass('frequent')) {
      classes.push(SEGMENT_CLASS + '--frequent');
      hasVisibleClass = true;
    }
    if (cl.contains('i-plus-one') && shouldRenderClass('i-plus-one')) {
      classes.push(SEGMENT_CLASS + '--iplus1');
      hasVisibleClass = true;
    }

    if (unvoiced) {
      classes.push(SEGMENT_CLASS + '--unvoiced');
      hasVisibleClass = true;
    }
    for (const index of tagIndexes) { // GSM_TAGRULES
      classes.push('gsm-tag-' + index);
      hasVisibleClass = true;
    }

    return hasVisibleClass ? classes : null;
  }

  function shouldRenderClass(className) {
    if (configuredVisibleClasses) {
      return configuredVisibleClasses.has(className);
    }
    return DEFAULT_RENDERED_CLASSES.has(className);
  }

  function hasDrawableEffects(stateStyle) {
    const effects = stateStyle && Array.isArray(stateStyle.effects) ? stateStyle.effects : [];
    for (const effect of effects) {
      if (!effect || typeof effect !== 'object') continue;
      if (!DRAWABLE_EFFECT_TYPES.has(effect.type)) continue;
      if (effect.type === 'background' && !(Number(effect.opacity) > 0)) continue;
      if (effect.type === 'border' && !(Number(effect.width) > 0)) continue;
      if (effect.type === 'shadow') {
        const blurValue = Number(effect.blur);
        const offsetXValue = Number(effect.offsetX);
        const offsetYValue = Number(effect.offsetY);
        const blur = Number.isFinite(blurValue) ? blurValue : 0;
        const offsetX = Number.isFinite(offsetXValue) ? offsetXValue : 0;
        const offsetY = Number.isFinite(offsetYValue) ? offsetYValue : 0;
        if (!(blur > 0 || offsetX !== 0 || offsetY !== 0)) continue;
      }
      return true;
    }
    return false;
  }

  function getVisibleClassesFromStyleConfig(config) {
    if (!config || typeof config !== 'object' || !config.states || typeof config.states !== 'object') {
      return null;
    }

    const visible = new Set();
    for (const className of JITEN_STYLEABLE_CLASSES) {
      if (hasDrawableEffects(config.states[className])) {
        visible.add(className);
      }
    }
    return visible;
  }

  function setStyleConfig(config) {
    configuredVisibleClasses = getVisibleClassesFromStyleConfig(config);
    if (enabled && parseContainer && currentLines) {
      mirrorHighlights();
    }
  }

  function getTextBoxesForRange(lineIndex, start, end) {
    let boxes;
    const containers = document.querySelectorAll('.text-block-container');
    for (const container of containers) {
      const found = container.querySelectorAll(`.text-box[data-line-index="${lineIndex}"]`);
      if (found.length > 0) {
        boxes = found;
        break;
      }
    }
    if (!boxes || boxes.length === 0) {
      boxes = document.querySelectorAll(`.text-box[data-line-index="${lineIndex}"]`);
    }

    // Reader offsets refer to the authoritative line text, while the rendered
    // boxes still contain the OCR text. Those strings can differ when OCR drops
    // punctuation or whitespace (for example, a missing opening 「). Align the
    // visible characters instead of assuming the two strings share every index.
    const targetCharacters = [];
    let textOffset = 0;
    for (const char of currentLines[lineIndex]?.text || '') {
      const charStart = textOffset;
      textOffset += char.length;
      if (!/\s/u.test(char)) {
        targetCharacters.push({ char, start: charStart, end: textOffset });
      }
    }

    const boxCharacters = [];
    for (const box of boxes) {
      for (const char of Array.from(box.textContent || '')) {
        if (!/\s/u.test(char)) boxCharacters.push({ char, box });
      }
    }
    if (!targetCharacters.length || !boxCharacters.length) return [];

    // Fast path for the usual case where OCR and authoritative text already
    // contain the same visible characters (whitespace differences do not matter).
    let targetToBox;
    const directMatch = targetCharacters.length === boxCharacters.length
      && targetCharacters.every((entry, index) => entry.char === boxCharacters[index].char);
    if (directMatch) {
      targetToBox = boxCharacters.map(entry => entry.box);
    } else {
      // Levenshtein alignment preserves later matches when OCR omitted or added
      // a character. Substitutions still reuse the corresponding OCR box, while
      // inserted authoritative characters simply have no box of their own.
      const targetLength = targetCharacters.length;
      const boxLength = boxCharacters.length;
      const costs = Array.from({ length: targetLength + 1 }, () => new Uint32Array(boxLength + 1));
      for (let i = 0; i <= targetLength; i++) costs[i][0] = i;
      for (let j = 0; j <= boxLength; j++) costs[0][j] = j;

      for (let i = 1; i <= targetLength; i++) {
        for (let j = 1; j <= boxLength; j++) {
          const substitutionCost = targetCharacters[i - 1].char === boxCharacters[j - 1].char ? 0 : 1;
          costs[i][j] = Math.min(
            costs[i - 1][j] + 1,
            costs[i][j - 1] + 1,
            costs[i - 1][j - 1] + substitutionCost
          );
        }
      }

      targetToBox = new Array(targetLength).fill(null);
      let i = targetLength;
      let j = boxLength;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
          const substitutionCost = targetCharacters[i - 1].char === boxCharacters[j - 1].char ? 0 : 1;
          if (costs[i][j] === costs[i - 1][j - 1] + substitutionCost) {
            targetToBox[i - 1] = boxCharacters[j - 1].box;
            i--;
            j--;
            continue;
          }
        }
        if (i > 0 && costs[i][j] === costs[i - 1][j] + 1) {
          i--;
          continue;
        }
        if (j > 0 && costs[i][j] === costs[i][j - 1] + 1) {
          j--;
          continue;
        }
        break;
      }
    }

    const matched = [];
    const seen = new Set();
    for (let index = 0; index < targetCharacters.length; index++) {
      const character = targetCharacters[index];
      if (character.start >= end || character.end <= start) continue;
      const box = targetToBox[index];
      if (box && !seen.has(box)) {
        seen.add(box);
        matched.push(box);
      }
    }
    return matched;
  }

  // Group a token's character boxes into one union rect per visual run (row for
  // horizontal text, column for vertical). Almost always a single rect; splits only
  // when a token wraps. Mirrors gamepad.js getTokenLineRects.
  function getTokenRunRects(boxes) {
    const rects = [];
    for (const box of boxes) {
      if (!box || !box.isConnected) continue;
      const r = box.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) continue;
      rects.push(r);
    }
    if (rects.length === 0) return [];

    // Decide orientation from the aggregate spread of the boxes.
    let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    for (const r of rects) {
      if (r.left < minL) minL = r.left;
      if (r.top < minT) minT = r.top;
      if (r.right > maxR) maxR = r.right;
      if (r.bottom > maxB) maxB = r.bottom;
    }
    const horizontal = (maxR - minL) >= (maxB - minT);

    const runs = [];
    let cur = null;
    for (const r of rects) {
      if (!cur) {
        cur = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        continue;
      }
      // Same run while the cross-axis position stays within the glyph extent;
      // a jump means the token wrapped onto a new row/column.
      const sameRun = horizontal
        ? Math.abs(r.top - cur.top) <= Math.min(r.height, cur.bottom - cur.top) * 0.6
        : Math.abs(r.left - cur.left) <= Math.min(r.width, cur.right - cur.left) * 0.6;
      if (sameRun) {
        if (r.left < cur.left) cur.left = r.left;
        if (r.top < cur.top) cur.top = r.top;
        if (r.right > cur.right) cur.right = r.right;
        if (r.bottom > cur.bottom) cur.bottom = r.bottom;
      } else {
        runs.push(cur);
        cur = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
    }
    if (cur) runs.push(cur);

    return runs.map(run => ({
      left: run.left,
      top: run.top,
      width: run.right - run.left,
      height: run.bottom - run.top,
    }));
  }

  function ensureSegmentCount(count) {
    const layer = ensureOverlayLayer();
    while (overlaySegments.length < count) {
      const el = document.createElement('div');
      el.className = SEGMENT_CLASS;
      el.style.display = 'none';
      layer.appendChild(el);
      overlaySegments.push(el);
    }
  }

  function renderOverlaySegments(segments) {
    ensureSegmentCount(segments.length);

    let i = 0;
    for (; i < segments.length; i++) {
      const el = overlaySegments[i];
      const { rect, classes } = segments[i];
      el.className = classes.join(' ');
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.style.display = 'block';
    }
    // Hide any leftover pooled segments from a previous, larger render.
    for (; i < overlaySegments.length; i++) {
      overlaySegments[i].style.display = 'none';
    }
    window.GSMWindowOcclusion?.refresh(overlayLayer);
  }

  function hideAllSegments() {
    clearJitenWordBoundaries(); // GSM_JITENBOUNDS
    for (const el of overlaySegments) {
      el.style.display = 'none';
    }
  }

  // Manual-mode visibility must not discard the parse used by gamepad navigation
  // or cancel a pending local parse. Content invalidation still clears it below.
  function setVisible(value) {
    visible = !!value;
    mirrorHighlights();
  }

  function subscribeNavigationTokens(listener) {
    navigationListeners.add(listener);
    return () => navigationListeners.delete(listener);
  }

  function notifyNavigationTokens() {
    for (const listener of navigationListeners) listener();
  }

  function isParsePending() {
    return enabled && available && (!highlightsReady || !currentLines || currentSignature !== lastParsedSignature);
  }

  function clearAllHighlights() {
    highlightGeneration++;
    highlightsReady = false;
    if (localParser) {
      localParseGeneration++;
      runningSignature = null;
    }
    clearJitenPreferredHeadwords();
    hideAllSegments();
    clearTimeout(pendingParseTimer);
    pendingParseTimer = null;
    currentLines = null;
    currentLineBlocks = null;
    currentBlocks = [];
    currentSignature = null;
  }

  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) {
      clearAllHighlights();
      lastParsedSignature = null;
      notifyNavigationTokens();
    }
  }

  // Set whether Jiten can parse right now (driven by the overlay's settings-bridge
  // verification). False stops triggering parses; true resumes on the next line/refresh.
  function setAvailable(value) {
    available = !!value;
    // Drop the dedup signature so resuming forces a fresh parse, not stale spans.
    if (!available) {
      clearAllHighlights();
      lastParsedSignature = null;
      notifyNavigationTokens();
    }
  }

  function refresh(lines) {
    lastParsedSignature = null;
    const target = (Array.isArray(lines) && lines.length) ? lines : currentLines;
    if (target && enabled && available) {
      requestParse(target);
    }
  }

  // Refresh only the SRS classes on the words that are already tokenized in the
  // hidden parse container. Popup grades/mines change card state, not the text or
  // segmentation, so reparsing every visible OCR line is unnecessary and slow.
  function refreshVisibleStates() {
    if (!parseContainer || !enabled || !available) return Promise.resolve();
    const generation = highlightGeneration;
    highlightsReady = false;
    hideAllSegments();
    return applyAnkiStatesToJitenWords(generation).then(success => {
      if (generation !== highlightGeneration) return;
      highlightsReady = success === true;
      if (highlightsReady) {
        mirrorHighlights();
        notifyNavigationTokens();
      } else {
        hideAllSegments();
      }
    });
  }

  // Reflect a word's new SRS state on existing highlights (e.g. after grading from
  // the Yomitan popup): rewrite the state classes on matching .jiten-word spans and
  // redraw, so a now-known word loses the highlight and a changed state recolors.
  function applyCardState(wordId, readingIndex, stateClasses) {
    if (!parseContainer) return;
    if (wordId === undefined || wordId === null || readingIndex === undefined || readingIndex === null) return;
    const classes = (Array.isArray(stateClasses) ? stateClasses : [stateClasses])
      .filter((c) => typeof c === 'string' && c.length > 0);

    // Attribute names are case-insensitive in HTML; ajb.js writes wordId/readingIndex.
    const selector = `.jiten-word[wordId="${wordId}"][readingIndex="${readingIndex}"]`;
    let spans;
    try {
      spans = parseContainer.querySelectorAll(selector);
    } catch (_) {
      return;
    }
    if (!spans || spans.length === 0) return;

    for (const span of spans) {
      const keep = Array.from(span.classList).filter((c) => !JITEN_STATE_CLASSES.includes(c));
      span.className = keep.concat(classes).join(' ');
    }

    // Force a redraw even though the underlying text is unchanged.
    mirrorHighlights();
  }

  // Read the Reader's existing parse without issuing requests. Include hidden
  // states too, so navigation can distinguish a known word from an unparsed one.
  function getNavigationTokens() {
    if (!enabled || !available || !highlightsReady || !parseContainer || !currentLines ||
        containerSignature !== currentSignature) return [];
    const tokens = [];
    for (const p of parseContainer.querySelectorAll('p[data-line-index]')) {
      for (const [span, range] of computeJitenSpanRanges(p)) {
        if (span.classList.contains('unparsed') || span.classList.contains('misparsed')) continue;
        const states = JITEN_STATE_CLASSES.filter(state => span.classList.contains(state));
        if (!states.length) continue;
        for (const { lineIndex, start, end } of getLineRangesForSpan(p, range)) {
          tokens.push({
            lineIndex, text: currentLines[lineIndex].text, start, end,
            states, highlighted: getSegmentClassesForSpan(span, true) !== null,
            iPlusOne: span.classList.contains('i-plus-one'),
          });
        }
      }
    }
    return tokens;
  }

  // GSM_UNVOICED and GSM_ANKI_DAILY_REVIEW: separate, always-visible markers.
  function installUnvoicedStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    if (!document.getElementById('gsm-unvoiced-style')) {
      const style = document.createElement('style');
      style.id = 'gsm-unvoiced-style';
      style.textContent = '.gsm-jiten-hl.gsm-jiten-hl--unvoiced{'
        + 'border-bottom:3px dashed #1e90ff !important;box-shadow:none !important;'
        + 'filter:drop-shadow(0 0 2px rgba(30,144,255,.9));}';
      document.head.appendChild(style);
    }
    applyDailyReviewMarkerStyle();
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    installUnvoicedStyle();
  }


  const api = {
    setLocalParser,
    mergeMimeticToTokens: gsmMergeMimeticToTokens,
    setVisible,
    subscribeNavigationTokens,
    isParsePending,
    getNavigationTokens,
    init,
    requestParse,
    mirrorHighlights,
    reposition: mirrorHighlights,
    clearJitenHighlighting: clearAllHighlights,
    setEnabled,
    setAvailable,
    setStyleConfig,
    refresh,
    refreshVisibleStates,
    applyCardState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) root.GsmJitenHighlight = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
