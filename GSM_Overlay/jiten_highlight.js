/**
 * GSM Overlay - Jiten Reader SRS Highlighting (Mirror Approach)
 *
 * We mirror the Jiten Reader extension's own parsing to get SRS states: insert
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
  let parseGeneration = 0;
  let parseTimeoutId = null;
  let enabled = true;
  let lastParsedSignature = null;
  let configuredVisibleClasses = null;

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
    if (!parseContainer) return;
    const jitenWords = parseContainer.querySelectorAll('.jiten-word:not(.unparsed)');
    if (jitenWords.length === 0) return;

    // Debounce: Jiten may parse in batches
    if (parseTimeoutId) clearTimeout(parseTimeoutId);
    parseTimeoutId = setTimeout(() => {
      parseTimeoutId = null;
      onParseComplete();
    }, 200);
  }

  function onParseComplete() {
    restoreOverlayElements(); // defensive; requestParse normally restores synchronously
    mirrorHighlights();
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

  // Request Jiten to parse the current lines. Never hides/delays the visible OCR
  // text — it only draws SRS highlights on top, asynchronously. The real text
  // boxes are hidden ONLY across the synchronous parse trigger (no paint happens
  // in between) so Jiten's whole-page Alt+P parse excludes them.
  function requestParse(lines) {
    if (!enabled || !available) return Promise.resolve();
    if (!parseContainer) init();
    if (!Array.isArray(lines) || lines.length === 0) return Promise.resolve();

    const signature = lines.map(l => (l && l.text) || '').join('\n');
    if (signature === lastParsedSignature) {
      // Text unchanged, just re-draw over the (possibly re-laid-out) boxes.
      currentLines = lines;
      mirrorHighlights();
      return Promise.resolve();
    }

    console.log('[JitenHighlight] Requesting parse for', lines.length, 'lines');

    currentLines = lines;
    parseGeneration++;
    const gen = parseGeneration;

    // Clear old content and insert fresh text
    parseContainer.innerHTML = '';
    for (let i = 0; i < lines.length; i++) {
      const text = (lines[i] && lines[i].text) || '';
      if (!text) continue;
      const p = document.createElement('p');
      p.dataset.lineIndex = String(i);
      p.textContent = text;
      parseContainer.appendChild(p);
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
    return Promise.resolve();
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
  function mirrorHighlights() {
    if (!parseContainer || !currentLines) {
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

    lastParsedSignature = currentLines.map(l => (l && l.text) || '').join('\n');

    // Collect a flat list of { rect, classes } highlight segments. A token may
    // produce more than one rect if its glyph boxes wrap across visual lines.
    const segments = [];
    for (const p of paragraphs) {
      const lineIdx = parseInt(p.dataset.lineIndex, 10);
      if (!Number.isFinite(lineIdx)) continue;

      // Map each .jiten-word span to its char range within the line.
      const spanRanges = computeJitenSpanRanges(p);
      if (spanRanges.size === 0) continue;

      for (const [span, range] of spanRanges) {
        const classes = getSegmentClassesForSpan(span);
        if (!classes) continue;

        const boxes = getTextBoxesForRange(lineIdx, range.start, range.start + range.len);
        if (boxes.length === 0) continue;

        const rects = getTokenRunRects(boxes);
        for (const rect of rects) {
          segments.push({ rect, classes });
        }
      }
    }

    renderOverlaySegments(segments);

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

  // Build the CSS class list for a token's overlay highlight, or null if the span
  // carries no highlightable state.
  function getSegmentClassesForSpan(span) {
    const cl = span.classList;
    if (cl.contains('unparsed') || cl.contains('misparsed')) return null;

    if (!configuredVisibleClasses) {
      // Preserve legacy behavior until the Jiten settings bridge supplies the
      // user's style config.
      for (const s of KNOWN_STATE_CLASSES) {
        if (cl.contains(s)) return null;
      }
    }

    const classes = [SEGMENT_CLASS];
    let hasVisibleClass = false;
    for (const s of JITEN_STATE_CLASSES) {
      if (!cl.contains(s) || !shouldRenderClass(s)) continue;
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

    // Keep only visible-text boxes (skip \n separators/empties) so offsets align.
    const visibleBoxes = Array.from(boxes).filter(box => {
      const text = (box.textContent || '').replace(/\s/g, '');
      return text.length > 0;
    });

    return visibleBoxes.slice(start, end);
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
  }

  function hideAllSegments() {
    for (const el of overlaySegments) {
      el.style.display = 'none';
    }
  }

  function clearAllHighlights() {
    hideAllSegments();
  }

  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) {
      hideAllSegments();
      lastParsedSignature = null;
    }
  }

  // Set whether Jiten can parse right now (driven by the overlay's settings-bridge
  // verification). False stops triggering parses; true resumes on the next line/refresh.
  function setAvailable(value) {
    available = !!value;
    // Drop the dedup signature so resuming forces a fresh parse, not stale spans.
    if (!available) lastParsedSignature = null;
  }

  function refresh(lines) {
    lastParsedSignature = null;
    const target = (Array.isArray(lines) && lines.length) ? lines : currentLines;
    if (target && enabled && available) {
      requestParse(target);
    }
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
    lastParsedSignature = null;
    mirrorHighlights();
  }

  const api = {
    init,
    requestParse,
    mirrorHighlights,
    reposition: mirrorHighlights,
    clearJitenHighlighting: clearAllHighlights,
    setEnabled,
    setAvailable,
    setStyleConfig,
    refresh,
    applyCardState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) root.GsmJitenHighlight = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
