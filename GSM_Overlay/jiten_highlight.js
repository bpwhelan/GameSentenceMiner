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
  ];
  const JITEN_AUX_CLASSES = ['frequent', 'i-plus-one'];
  const JITEN_STYLEABLE_CLASSES = JITEN_STATE_CLASSES.concat(JITEN_AUX_CLASSES);
  const DEFAULT_RENDERED_CLASSES = new Set(['new', 'young', 'due', 'frequent', 'i-plus-one']);
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
  const LOCAL_STATE_CLASSES = ['new', 'young', 'mature', 'blacklisted', 'due', 'mastered', 'redundant', 'suspended'];

  function setLocalParser(parser) {
    localParser = typeof parser === 'function' ? parser : null;
    localParseGeneration++;
    clearTimeout(runningParseTimer);
    clearTimeout(parseTimeoutId);
    runningSignature = null;
    lastParsedSignature = null;
    containerSignature = null;
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
    if (bestStart === -1) return null;

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

  async function parseLocally(blocks) {
    const generation = ++localParseGeneration;
    try {
      const result = await localParser(blocks.map(block => block.text));
      if (generation !== localParseGeneration || !enabled || !available) return;
      if (!Array.isArray(result?.tokens) || result.tokens.length !== blocks.length) throw new Error('Invalid local parse');
      const paragraphs = parseContainer.querySelectorAll('p[data-line-index]');
      for (let i = 0; i < blocks.length; i++) {
        const p = paragraphs[i];
        const text = blocks[i].text;
        const tokens = result.tokens[i];
        const alignedTokens = gsmAlignLocalTokensToSource(text, tokens);
        const unknown = new Set(alignedTokens
          .filter(({ token }) => !(token.knownState || []).some(state => [2, 3, 5, 6].includes(state)))
          .map(({ token }) => token.headword));
        p.textContent = '';
        let offset = 0;
        for (const aligned of alignedTokens) {
          const { token, start, end } = aligned;
          if (start < offset || end <= start || end > text.length) continue;
          p.appendChild(document.createTextNode(text.slice(offset, start)));

          const span = document.createElement('span');
          span.className = 'jiten-word ' + (token.knownState || [0]).map(state => LOCAL_STATE_CLASSES[state]).filter(Boolean).join(' ');
          if (unknown.size === 1 && unknown.has(token.headword)) span.classList.add('i-plus-one');
          if (Number.isSafeInteger(token.wordId) && token.wordId > 0) {
            span.setAttribute('wordId', String(token.wordId));
            span.setAttribute('readingIndex', String(token.readingIndex || 0));
          }
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
  const ANKI_TO_JITEN_STATE = ['new', 'young', 'mature', 'blacklisted', 'due', 'mastered', 'redundant', 'suspended'];
  const JITEN_STATE_CLASS_SET = new Set(JITEN_STATE_CLASSES);

  function visibleWordSpelling(span) {
    const clone = span.cloneNode(true);
    clone.querySelectorAll('rt, rp').forEach(node => node.remove());
    return String(clone.textContent || '').normalize('NFKC').trim();
  }

  const gsmYomitanRendererInflight = new Map();
  let gsmYomitanRendererLastWarningAt = 0;

  function applyAnkiStateMapToSpans(spans, statesBySpelling) {
    if (!statesBySpelling || typeof statesBySpelling !== 'object') return;
    for (const span of spans) {
      const spelling = visibleWordSpelling(span);
      if (!Object.prototype.hasOwnProperty.call(statesBySpelling, spelling)) continue;
      const state = statesBySpelling[spelling];
      if (!Array.isArray(state)) continue;
      for (const name of JITEN_STATE_CLASSES) span.classList.remove(name);
      for (const index of state) {
        const name = Number.isInteger(index) ? ANKI_TO_JITEN_STATE[index] : null;
        if (name && JITEN_STATE_CLASS_SET.has(name)) span.classList.add(name);
      }
      // The Anki override uses state 6 for the special unvoiced-tag marker.
      if (state.includes(6)) span.classList.add('unvoiced');
      else span.classList.remove('unvoiced');
    }
  }

  async function resolveYomitanDeconjugations(spellings, spans) {
    const bridge = window.gsmYomitanBridge;
    if (!bridge || typeof bridge.termEntries !== 'function' || !window.ipcRenderer?.invoke) return;
    let needed;
    try {
      needed = await window.ipcRenderer.invoke('gsm-anki-deconj-needed', { spellings });
    } catch (error) {
      if (Date.now() - gsmYomitanRendererLastWarningAt > 60_000) {
        gsmYomitanRendererLastWarningAt = Date.now();
        console.warn('[AnkiStates] Could not prepare Yomitan deconjugation lookup:', error?.message || error);
      }
      return;
    }
    if (!Array.isArray(needed) || !needed.length) return;

    const startLookup = word => {
      const existing = gsmYomitanRendererInflight.get(word);
      if (existing) return existing;
      const promise = (async () => {
        try {
          // This uses GSM's embedded Yomitan extension bridge, not the optional
          // standalone HTTP API at 127.0.0.1:19633.
          const response = await bridge.termEntries(word, { timeoutMs: 8000 });
          await window.ipcRenderer.invoke('gsm-anki-cache-yomitan-responses', {
            responses: [{ word, response }],
          });
        } catch (error) {
          if (Date.now() - gsmYomitanRendererLastWarningAt > 60_000) {
            gsmYomitanRendererLastWarningAt = Date.now();
            console.warn('[AnkiStates] Embedded Yomitan deconjugation lookup unavailable:',
              String(error?.message || error).slice(0, 240));
          }
        } finally {
          gsmYomitanRendererInflight.delete(word);
        }
      })();
      gsmYomitanRendererInflight.set(word, promise);
      return promise;
    };
    // Start only four requests at a time so a long line cannot flood the bridge.
    for (let i = 0; i < needed.length; i += 4) {
      await Promise.allSettled(needed.slice(i, i + 4).map(startLookup));
    }
    try {
      const refreshed = await window.ipcRenderer.invoke('gsm-anki-display-states', { spellings });
      applyAnkiStateMapToSpans(spans, refreshed);
      await applyTagMatchesToSpans(spans, spellings); // GSM_TAGRULES
      mirrorHighlights();
      notifyNavigationTokens();
    } catch (error) {
      if (Date.now() - gsmYomitanRendererLastWarningAt > 60_000) {
        gsmYomitanRendererLastWarningAt = Date.now();
        console.warn('[AnkiStates] Could not refresh states after Yomitan lookup:', error?.message || error);
      }
    }
  }

  async function applyAnkiStatesToJitenWords() {
    if (!parseContainer || !window.ipcRenderer?.invoke) return;
    const spans = Array.from(parseContainer.querySelectorAll('.jiten-word'));
    if (!spans.length) return;
    const spellings = [...new Set(spans.map(visibleWordSpelling).filter(Boolean))];
    if (!spellings.length) return;
    let statesBySpelling;
    try {
      statesBySpelling = await window.ipcRenderer.invoke('gsm-anki-display-states', { spellings });
    } catch (error) {
      console.warn('[AnkiStates] Could not apply states to Jiten spans:', error?.message || error);
      return;
    }
    applyAnkiStateMapToSpans(spans, statesBySpelling);
    await applyTagMatchesToSpans(spans, spellings); // GSM_TAGRULES
    // Launch deconjugation after exact/cached statuses have been applied. The
    // initial line draw never waits for Yomitan or the disk cache.
    void resolveYomitanDeconjugations(spellings, spans);
  }

  function onParseComplete() {
    clearTimeout(runningParseTimer);
    runningParseTimer = null;
    lastParsedSignature = containerSignature;
    lastParseFinishedAt = Date.now();
    runningSignature = null;
    restoreOverlayElements(); // defensive; requestParse normally restores synchronously
    // Never block the initial line draw on Anki/Yomitan lookups. State colours
    // are refreshed asynchronously once cached/API results arrive.
    mirrorHighlights();
    notifyNavigationTokens();
    void applyAnkiStatesToJitenWords().finally(() => {
      mirrorHighlights();
      notifyNavigationTokens();
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
    if (!Array.isArray(lines) || lines.length === 0) return Promise.resolve();

    // Keep the grouping when refreshing the same frame without new detection.
    if (lineBlocks === undefined && lines === currentLines) lineBlocks = currentLineBlocks;
    currentLineBlocks = lineBlocks ? new Map(lineBlocks) : null;
    currentBlocks = buildParseBlocks(lines, currentLineBlocks);
    const signature = signatureForBlocks(currentBlocks);
    currentLines = lines;
    currentSignature = signature;
    if (signature === lastParsedSignature && Date.now() - lastParseFinishedAt < 300_000) {
      // Text unchanged, just re-draw over the (possibly re-laid-out) boxes.
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
    if (!enabled || !available || !currentLines) return;
    containerSignature = currentSignature;
    parseContainer.innerHTML = '';
    containerBlocks = new Map();
    // Japanese script detection also excludes English with wide punctuation.
    const containsJapanese = (text) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
    if (!currentBlocks.some((block) => containsJapanese(block.text))) {
      lastParsedSignature = containerSignature;
      lastParseFinishedAt = Date.now();
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
    if (!visible || !enabled || !available || !parseContainer || !currentLines || containerSignature !== currentSignature) {
      hideAllSegments();
      return;
    }

    // Reset container position after parse
    resetParseContainerPosition();

    const paragraphs = parseContainer.querySelectorAll('p[data-line-index]');
    if (paragraphs.length === 0) {
      hideAllSegments();
      return;
    }

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

  async function applyTagMatchesToSpans(spans, spellings) {
    for (const span of spans) {
      for (const name of [...span.classList]) if (TAG_CLASS_RE.test(name)) span.classList.remove(name);
    }
    if (!window.ipcRenderer?.invoke || !tagRules.some(rule => rule.enabled)) return;
    let matches;
    try { matches = await window.ipcRenderer.invoke('gsm-anki-tag-matches', { spellings }); } catch { return; }
    for (const span of spans) {
      const spelling = visibleWordSpelling(span);
      const list = matches && Object.prototype.hasOwnProperty.call(matches, spelling) ? matches[spelling] : null;
      if (!Array.isArray(list)) continue;
      for (const index of list) {
        if (Number.isInteger(index) && index >= 0 && index < 64) span.classList.add('anki-tag-' + index);
      }
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
    applyTagRulesToStyle();
    if (parseContainer) {
      void applyAnkiStatesToJitenWords().finally(() => { mirrorHighlights(); notifyNavigationTokens(); });
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

    if (!configuredVisibleClasses && !unvoiced && !tagIndexes.length) {
      // Preserve legacy behavior until the Jiten settings bridge supplies the
      // user's style config.
      for (const s of KNOWN_STATE_CLASSES) {
        if (cl.contains(s)) return null;
      }
    }

    const classes = [SEGMENT_CLASS];
    let hasVisibleClass = false;
    for (const s of JITEN_STATE_CLASSES) {
      if (!cl.contains(s) || !shouldRenderClass(s) || (unvoiced && s === 'redundant')) continue;
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

    // The renderer has one box per visible code point; Reader offsets count
    // UTF-16 code units, including whitespace that has no visible glyph box.
    const visibleBoxes = Array.from(boxes).filter(box => {
      const text = (box.textContent || '').replace(/\s/g, '');
      return text.length > 0;
    });

    const matched = [];
    let offset = 0;
    let boxIndex = 0;
    for (const char of currentLines[lineIndex]?.text || '') {
      const charStart = offset;
      offset += char.length;
      if (/\s/u.test(char)) continue;
      const box = visibleBoxes[boxIndex++];
      if (box && charStart < end && offset > start) matched.push(box);
      if (offset >= end) break;
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
    return enabled && available && (!currentLines || currentSignature !== lastParsedSignature);
  }

  function clearAllHighlights() {
    if (localParser) {
      localParseGeneration++;
      runningSignature = null;
    }
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
    return applyAnkiStatesToJitenWords().finally(() => {
      mirrorHighlights();
      notifyNavigationTokens();
    });
  }

  // Reflect a word's new SRS state on existing highlights (e.g. after grading from
  // the Yomitan popup): rewrite the state classes on matching .jiten-word spans and
  // redraw, so a now-known word loses its highlight and a changed state recolors.
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
    if (!enabled || !available || !parseContainer || !currentLines ||
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

  // GSM_UNVOICED: keep the tag's underline style without the temporary debug panel.
  function installUnvoicedStyle() {
    if (typeof document === 'undefined' || !document.head || document.getElementById('gsm-unvoiced-style')) return;
    const style = document.createElement('style');
    style.id = 'gsm-unvoiced-style';
    style.textContent = '.gsm-jiten-hl.gsm-jiten-hl--unvoiced{'
      + 'border-bottom:3px dashed #1e90ff !important;box-shadow:none !important;'
      + 'filter:drop-shadow(0 0 2px rgba(30,144,255,.9));}';
    document.head.appendChild(style);
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    installUnvoicedStyle();
  }

  const api = {
    setLocalParser,
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
