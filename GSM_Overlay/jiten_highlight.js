/**
 * GSM Overlay - Jiten Reader SRS Highlighting (Mirror Approach)
 *
 * Leverages the Jiten Reader extension's own parsing to get SRS states.
 * The extension's content script (ajb.js) runs on the overlay page via
 * the TriggerParser (matches <all_urls>). We:
 *
 *   1. Insert text into a visible parse container (hidden overlay elements)
 *   2. Trigger Jiten Reader to parse via synthetic Alt+P keypress
 *   3. Observe the container for .jiten-word spans Jiten creates
 *   4. Draw one overlay highlight box per token spanning its character boxes
 *
 * During parse, overlay text elements are temporarily set to display:none
 * so Jiten's ParagraphReader only processes our parse container.
 *
 * Highlighting model (mirrors gamepad.js token highlights):
 *   Rather than adding CSS classes to each per-character .text-box (which makes
 *   every glyph look individually highlighted), we draw absolutely-positioned
 *   overlay <div>s over the union bounding rect of each token's character
 *   boxes. One token -> one continuous highlight, just like the gamepad's
 *   cursor/segment highlights. See renderOverlaySegments / getTokenRunRects.
 *
 * Jiten Reader classes:
 *   new, young, mature, mastered, blacklisted, due  (SRS states)
 *   i-plus-one  (sentence with exactly one unknown)
 *   frequent    (high-frequency word)
 */

(function (root) {
  'use strict';

  // All SRS states Jiten can assign to a word.
  const JITEN_STATE_CLASSES = ['new', 'young', 'mature', 'mastered', 'blacklisted', 'due'];

  // States that mean the user already knows (or has chosen to ignore) the word.
  // These get NO highlight — only words worth studying are surfaced.
  const KNOWN_STATE_CLASSES = ['mature', 'mastered', 'blacklisted'];

  const LAYER_ID = 'jiten-highlight-layer';
  const SEGMENT_CLASS = 'gsm-jiten-hl';

  let parseContainer = null;
  let parseObserver = null;
  let currentLines = null;
  let parseGeneration = 0;
  let pendingParseResolve = null;
  let parseTimeoutId = null;
  let enabled = true;
  let lastParsedSignature = null;

  // Overlay highlight layer + pooled segment elements (reused across renders,
  // hidden when not needed) so we don't thrash the DOM every frame.
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

    // Overlay rects are computed in viewport space, so they go stale whenever
    // the page reflows. Re-mirror (cheaply) on resize using the spans we
    // already parsed. Live text changes re-enter through requestParse.
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
    // Restore overlay elements visibility
    restoreOverlayElements();
    // Draw the token highlights
    mirrorHighlights();
    if (pendingParseResolve) {
      pendingParseResolve();
      pendingParseResolve = null;
    }
  }

  /**
   * Temporarily hide overlay text elements so Jiten only parses our container.
   */
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

  /**
   * Request Jiten Reader to parse the current lines.
   */
  function requestParse(lines) {
    if (!enabled) return Promise.resolve();
    if (!parseContainer) init();
    if (!Array.isArray(lines) || lines.length === 0) return Promise.resolve();

    const signature = lines.map(l => (l && l.text) || '').join('\n');
    if (signature === lastParsedSignature) {
      // Text unchanged, just re-draw over the (possibly re-laid-out) boxes.
      currentLines = lines;
      mirrorHighlights();
      return Promise.resolve();
    }

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

    // Make parse container visible (move on-screen temporarily for Jiten)
    parseContainer.style.left = '0';
    parseContainer.style.top = '0';
    parseContainer.style.width = 'auto';
    parseContainer.style.height = 'auto';
    parseContainer.style.opacity = '0.01'; // near-invisible but renderable

    // Hide overlay text so Jiten only parses our container
    hideOverlayElements();

    // Trigger Jiten Reader parse
    triggerJitenParse();

    return new Promise((resolve) => {
      pendingParseResolve = resolve;
      // Safety timeout
      setTimeout(() => {
        if (parseGeneration === gen && pendingParseResolve === resolve) {
          pendingParseResolve = null;
          restoreOverlayElements();
          resetParseContainerPosition();
          mirrorHighlights();
          resolve();
        }
      }, 4000);
    });
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

  /**
   * Read Jiten-parsed spans and draw one overlay highlight box per token,
   * positioned over the union bounding rect of the token's .text-box glyphs.
   */
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

      // Map each .jiten-word span to its character range within the line.
      // Offsets are counted over EVERY base-text character in document order —
      // including punctuation/whitespace that Jiten leaves outside any
      // .jiten-word span — so ranges stay aligned with the per-character text
      // boxes (which include those characters). Counting only span lengths
      // would drift left by one position per skipped punctuation mark.
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

  /**
   * Walk a paragraph's base text (excluding <rt> furigana readings) in document
   * order and return a Map of each .jiten-word span -> {start, len} giving its
   * character range within the line.
   *
   * Characters that are NOT wrapped in a .jiten-word (punctuation like 、「」,
   * spaces, etc. that Jiten skips) still advance the running offset, keeping the
   * ranges aligned with the per-character overlay text boxes.
   */
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

  /**
   * Build the CSS class list for a token's overlay highlight from a Jiten span,
   * or null if the span carries no highlightable state.
   */
  function getSegmentClassesForSpan(span) {
    const cl = span.classList;
    if (cl.contains('unparsed') || cl.contains('misparsed')) return null;

    // Known/ignored words get no highlight at all, regardless of other flags.
    for (const s of KNOWN_STATE_CLASSES) {
      if (cl.contains(s)) return null;
    }

    let state = null;
    for (const s of JITEN_STATE_CLASSES) {
      if (cl.contains(s)) { state = s; break; }
    }
    const frequent = cl.contains('frequent');
    const iplusone = cl.contains('i-plus-one');
    if (!state && !frequent && !iplusone) return null;

    const classes = [SEGMENT_CLASS];
    if (state) classes.push(SEGMENT_CLASS + '--' + state);
    if (frequent) classes.push(SEGMENT_CLASS + '--frequent');
    if (iplusone) classes.push(SEGMENT_CLASS + '--iplus1');
    return classes;
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

    // Filter to only visible-text boxes (skip synthetic \n separators and empty boxes)
    // so character offsets from Jiten's parse of line.text align with DOM order.
    const visibleBoxes = Array.from(boxes).filter(box => {
      const text = (box.textContent || '').replace(/\s/g, '');
      return text.length > 0;
    });

    return visibleBoxes.slice(start, end);
  }

  /**
   * Group a token's character boxes into one union rect per visual run (row for
   * horizontal text, column for vertical text). Almost always a single rect;
   * splitting only kicks in if a token wraps across lines. Mirrors the
   * per-line union logic in gamepad.js getTokenLineRects.
   */
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

  function refresh() {
    lastParsedSignature = null;
    if (currentLines && enabled) {
      requestParse(currentLines);
    }
  }

  const api = {
    init,
    requestParse,
    mirrorHighlights,
    reposition: mirrorHighlights,
    clearJitenHighlighting: clearAllHighlights,
    setEnabled,
    refresh,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) root.GsmJitenHighlight = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
