/*
 * Page text as the reader reads it, for content.js: the caret and glyph under
 * the pointer, the text a scan reads from there, the sentence around a match
 * or an exact selection, the runs of text word highlighting segments, and the
 * page text a candidate's match covers. content.js creates one scanner as it
 * starts and builds its candidates with it.
 *
 * Copyright (C) 2026 Manhhao
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function () {
  "use strict";

  // `isOurNode(node)` is content.js's test for the reader's own popup host and
  // text-field imposter, which a scan never reads as page text.
  function createPageScanner({ isOurNode }) {
    const { SENTENCE_SCAN_EXTENT, extractSentence } = globalThis.HDSentence;

    // Same character set PR #549 gates lookups on: kana, halfwidth katakana, CJK
    // ideographs (including ext-A and ext-B), and the iteration/repeat marks.
    const JAPANESE_CHARACTER_PATTERN =
      /[々-〇〻぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ\u{20000}-\u{2fa1f}]/u;
    const TOKEN_BOUNDARY_PATTERN = /[\p{White_Space}\p{Punctuation}\p{Symbol}]/u;
    const COLLAPSIBLE_WHITESPACE_PATTERN = /[\t\n\r\f ]/u;
    const SEGMENT_BREAK_PATTERN = /[\n\r]/u;

    // Text in these never belongs to the running prose: script and style hold
    // source, rt/rp hold reading annotations that must not splice into the
    // scanned string, and form controls hold values rather than page text.
    const OPAQUE_TAGS = new Set([
      "audio",
      "canvas",
      "embed",
      "head",
      "iframe",
      "math",
      "noscript",
      "object",
      "option",
      "optgroup",
      "rp",
      "rt",
      "script",
      "select",
      "style",
      "svg",
      "template",
      "textarea",
      "title",
      "video",
    ]);
    const EDITING_TAGS = new Set(["button", "input", "select", "textarea"]);
    const EDITING_SELECTOR = [...EDITING_TAGS, "[contenteditable]"].join(",");
    // A whitespace-only text node with a line break separates blocks in the
    // source ("</p>\n<p>", an overlay's block separator) and ends the sentence.
    const BLOCK_SEPARATOR_PATTERN = /^\s*[\n\r]\s*$/u;
    // So does the edge of the paragraph, list item or table cell the text is laid
    // out in. Flex, grid and positioned boxes are not in this set: an overlay
    // boxes every glyph of one line in its own positioned flex span.
    const BLOCK_DISPLAYS = new Set(["block", "list-item", "table-cell"]);
    const PRESERVED_WHITESPACE = new Set([
      "pre",
      "pre-wrap",
      "pre-line",
      "break-spaces",
    ]);

    function isJapaneseToken(text) {
      const token = text.split(TOKEN_BOUNDARY_PATTERN, 1)[0];
      return JAPANESE_CHARACTER_PATTERN.test(token);
    }

    function computedStyleFor(element, styleCache) {
      let style = styleCache.get(element);
      if (!style) {
        style = window.getComputedStyle(element);
        styleCache.set(element, style);
      }
      return style;
    }

    function isHiddenElement(element, styleCache) {
      const style = computedStyleFor(element, styleCache);
      return style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse";
    }

    function preservesWhitespace(element, styleCache) {
      if (!element) {
        return false;
      }
      const style = computedStyleFor(element, styleCache);
      const collapse = style.whiteSpaceCollapse;
      if (typeof collapse === "string" && collapse) {
        return collapse !== "collapse";
      }
      return PRESERVED_WHITESPACE.has(style.whiteSpace);
    }

    /**
     * Both caret APIs return the nearest caret *boundary*, so a pointer in the
     * right half of a glyph reports the offset after it and the scan would start
     * one character late -- pointing straight at 食 in 食べたかった would look up
     * べたかった. Step back onto the preceding character when the pointer is
     * actually inside its box.
     */
    function alignToCharacter(range, clientX, clientY) {
      const node = range.startContainer;
      const offset = range.startOffset;
      if (!range.collapsed || offset === 0 || node.nodeType !== Node.TEXT_NODE) {
        return range;
      }
      const probe = document.createRange();
      try {
        probe.setStart(node, offset - 1);
        probe.setEnd(node, offset);
      } catch {
        return range;
      }
      for (const rect of probe.getClientRects()) {
        if (
          clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom
        ) {
          range.setStart(node, offset - 1);
          range.collapse(true);
          return range;
        }
      }
      return range;
    }

    function rangeFromCaretPosition(position, clientX, clientY) {
      if (!position) {
        return null;
      }
      const range = document.createRange();
      try {
        range.setStart(position.offsetNode, position.offset);
        range.setEnd(position.offsetNode, position.offset);
      } catch {
        return null;
      }
      return alignToCharacter(range, clientX, clientY);
    }

    function caretRangeAt(clientX, clientY, shadowRoot = null) {
      if (shadowRoot) {
        if (typeof document.caretPositionFromPoint !== "function") {
          return null;
        }
        try {
          return rangeFromCaretPosition(
            document.caretPositionFromPoint(clientX, clientY, {
              shadowRoots: [shadowRoot],
            }),
            clientX,
            clientY
          );
        } catch {
          return null;
        }
      }
      if (typeof document.caretRangeFromPoint === "function") {
        const range = document.caretRangeFromPoint(clientX, clientY);
        return range === null ? null : alignToCharacter(range, clientX, clientY);
      }
      if (typeof document.caretPositionFromPoint === "function") {
        return rangeFromCaretPosition(
          document.caretPositionFromPoint(clientX, clientY),
          clientX,
          clientY
        );
      }
      return null;
    }

    /**
     * The glyph under the pointer as a text range, for a drag the reader selects
     * itself. An overlay boxes each glyph in a span wider than the glyph, and from
     * the box's trailing margin the caret APIs report the boundary after its text;
     * the box still belongs to its last glyph.
     */
    function glyphAtPoint(clientX, clientY) {
      const range = caretRangeAt(clientX, clientY);
      const node = range?.startContainer;
      if (!node || !isScannableTextNode(node, new Map())) return null;
      const text = node.nodeValue || "";
      let offset = range.startOffset;
      if (offset >= text.length) {
        const box = node.parentElement.getBoundingClientRect();
        if (text.length === 0 || clientX < box.left || clientX > box.right
            || clientY < box.top || clientY > box.bottom) return null;
        offset = text.length - 1;
        if (offset > 0 && (text.charCodeAt(offset) & 0xfc00) === 0xdc00) offset -= 1;
      }
      return { node, start: offset, end: offset + (text.codePointAt(offset) > 0xffff ? 2 : 1) };
    }

    function isEditingElement(element) {
      return element?.isContentEditable === true || EDITING_TAGS.has(element?.localName);
    }

    function isScannableElement(element, styleCache) {
      if (!element || element.getRootNode() !== document || isOurNode(element) || isHiddenElement(element, styleCache)) {
        return false;
      }
      for (let current = element; current; current = current.parentElement) {
        if (isEditingElement(current) || OPAQUE_TAGS.has(current.localName)
            || computedStyleFor(current, styleCache).display === "none") {
          return false;
        }
      }
      return true;
    }

    function isScannableTextNode(node, styleCache) {
      return node?.nodeType === Node.TEXT_NODE && isScannableElement(node.parentElement, styleCache);
    }

    function createScanWalker(root, styleCache) {
      return document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
              return isHiddenElement(node.parentElement, styleCache) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            }
            const editing = isEditingElement(node);
            if (
              (!editing && OPAQUE_TAGS.has(node.localName)) ||
              isOurNode(node) ||
              computedStyleFor(node, styleCache).display === "none"
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            if (editing) return hasVisibleContent(node, styleCache) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            // Visible controls and line breaks are boundaries. Every other element
            // is crossed whatever its layout, as Yomitan's layout-unaware scan
            // does: a word boxed one glyph per positioned span is still one word.
            // Hidden wrappers are skipped too, since a descendant may restore
            // visibility.
            return node.localName === "br"
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP;
          },
        }
      );
    }

    /** The nearest ancestor laid out as its own block, or null above the root. */
    function blockAncestor(element, styleCache) {
      for (let current = element; current; current = current.parentElement) {
        if (BLOCK_DISPLAYS.has(computedStyleFor(current, styleCache).display)) return current;
      }
      return null;
    }

    /**
     * The text nodes around `startNode`, in document order, that make up the
     * sentence's source: neighbours up to SENTENCE_SCAN_EXTENT characters each
     * way, cut at a block separator, another block, a line break or a control.
     * They are the candidate's `sourceElements`, so
     * `sourceElements.map(textContent).join("") === sourceText` holds by
     * construction, which is what createSourceHighlighter requires.
     */
    function collectSentenceSources(startNode, root, styleCache) {
      const sources = [startNode];
      const block = blockAncestor(startNode.parentElement, styleCache);
      for (const backward of [true, false]) {
        const walker = createScanWalker(root, styleCache);
        walker.currentNode = startNode;
        let length = 0;
        while (length < SENTENCE_SCAN_EXTENT) {
          const node = backward ? walker.previousNode() : walker.nextNode();
          if (
            !node ||
            node.nodeType !== Node.TEXT_NODE ||
            BLOCK_SEPARATOR_PATTERN.test(node.nodeValue || "") ||
            blockAncestor(node.parentElement, styleCache) !== block ||
            // The walker stops at a control going forward but reaches its text
            // first going backward.
            (backward && isEditingElement(node.parentElement?.closest(EDITING_SELECTOR)))
          ) {
            break;
          }
          if (backward) sources.unshift(node); else sources.push(node);
          length += (node.nodeValue || "").length;
        }
      }
      return sources;
    }

    /**
     * `sourceText` with the segment breaks CSS collapses replaced by spaces, so
     * that only a rendered line break ends the sentence: a paragraph wrapped
     * across source lines is one line on the page.
     */
    function sentenceSource(sources, styleCache) {
      let text = "";
      const append = (node) => {
        const raw = node.nodeValue || "";
        text += preservesWhitespace(node.parentElement, styleCache) ? raw : raw.replace(/[\n\r]/gu, " ");
      };
      for (const source of sources) {
        if (source.nodeType === Node.TEXT_NODE) {
          append(source);
          continue;
        }
        const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) append(walker.currentNode);
      }
      return text;
    }

    /**
     * Completes a candidate with its raw source coordinates and its sentence.
     * `sourceText` is the text of `sourceElements` and `sourceOffset` the match's
     * start in it; the highlighter and rawMatchedText work there. `sentence` and
     * `matchOffset` are Yomitan's sentence around the match, which Anki notes,
     * the Note form and custom links receive. Until the engine answers, the match
     * is the hovered glyph; the reply refines it to the matched word. An exact
     * selection arrives with its own sentence source (selectionSentence).
     */
    function withSentence(candidate, sourceOffset, matchLength, styleCache) {
      candidate.sourceText = candidate.sourceElements.map((source) => source.textContent || "").join("");
      candidate.sourceOffset = sourceOffset;
      candidate.sentenceSource ??= sentenceSource(candidate.sourceElements, styleCache);
      return refineSentence(candidate, matchLength);
    }

    function refineSentence(candidate, matchLength) {
      // An exact selection's match is the selection, where selectionSentence put it.
      const { sentence, matchOffset } = extractSentence(candidate.sentenceSource,
        candidate.selectionOffset ?? candidate.sourceOffset, candidate.selectionLength ?? matchLength);
      candidate.sentence = sentence;
      candidate.matchOffset = matchOffset;
      return candidate;
    }

    /** The selected part of the text node `node`, or null when none of it is selected. */
    function selectedSpan(range, node) {
      if (!range.intersectsNode(node)) return null;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      return end > start ? { start, end } : null;
    }

    /** The first selected character a hover could point at: in text the scan reads, and not whitespace. */
    function firstSelectedGlyph(range, styleCache) {
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
      let node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) walker.currentNode = node;
      else node = walker.nextNode();
      for (; node && range.comparePoint(node, 0) <= 0; node = walker.nextNode()) {
        const selected = selectedSpan(range, node);
        if (!selected || !isScannableTextNode(node, styleCache)) continue;
        const glyph = node.nodeValue.slice(selected.start, selected.end).search(/\S/u);
        if (glyph >= 0) return { node, offset: selected.start + glyph };
      }
      return null;
    }

    /**
     * An exact selection's sentence, read as a hover over its first selected
     * glyph reads one: from the text nodes the scan reads around that glyph, up
     * to the edge of its block. It never takes in the furigana, scripts or
     * hidden text of the element that happens to contain the whole selection. A
     * selection that leaves the block is cut where the block ends.
     * `selectionOffset` and `selectionLength` place the selection in
     * `sentenceSource`.
     */
    function selectionSentence(range, styleCache) {
      const first = firstSelectedGlyph(range, styleCache);
      if (!first) return { sentenceSource: "", selectionOffset: 0, selectionLength: 0 };
      const sources = collectSentenceSources(first.node, document.body, styleCache);
      let start = 0;
      let end = 0;
      let consumed = 0;
      for (const source of sources) {
        if (source === first.node) start = consumed + first.offset;
        const selected = selectedSpan(range, source);
        if (selected) end = consumed + selected.end;
        consumed += source.nodeValue.length;
      }
      return { sentenceSource: sentenceSource(sources, styleCache), selectionOffset: start, selectionLength: end - start };
    }

    function withinSources(sources, node) {
      return sources.some((source) => source === node
        || (source.nodeType === Node.ELEMENT_NODE && source.contains(node)));
    }

    /** `offset` inside `node` expressed in the concatenated text of `sources`. */
    function sourceOffset(sources, node, offset) {
      let consumed = 0;
      for (const source of sources) {
        if (source === node) return consumed + offset;
        if (source.nodeType === Node.ELEMENT_NODE && source.contains(node)) {
          return consumed + rangeOffsetWithin(source, node, offset);
        }
        consumed += (source.textContent || "").length;
      }
      throw new RangeError("node is not inside the candidate sources");
    }

    function pushCollapsedSpace(entries, node, offset, sourceLength, segmentBreak) {
      const previous = entries[entries.length - 1];
      if (previous && previous.collapsed) {
        // A run split across text nodes ("<span>食べ </span><span> ます</span>")
        // is still one collapsed space in the rendered line.
        previous.segmentBreak = previous.segmentBreak || segmentBreak;
        return;
      }
      entries.push({
        collapsed: true,
        node,
        offset,
        segmentBreak,
        sourceLength,
        text: " ",
      });
    }

    /** Appends `node`'s characters from `from` onward; false stops the walk. */
    function appendTextNode(entries, node, from, budget, styleCache) {
      const raw = node.nodeValue || "";
      const preserve = preservesWhitespace(node.parentElement, styleCache);
      let index = from;
      while (index < raw.length && entries.length < budget) {
        const character = String.fromCodePoint(raw.codePointAt(index));
        if (preserve) {
          if (SEGMENT_BREAK_PATTERN.test(character)) {
            return false;
          }
        } else if (COLLAPSIBLE_WHITESPACE_PATTERN.test(character)) {
          let end = index;
          let segmentBreak = false;
          while (
            end < raw.length &&
            COLLAPSIBLE_WHITESPACE_PATTERN.test(raw[end])
          ) {
            segmentBreak = segmentBreak || SEGMENT_BREAK_PATTERN.test(raw[end]);
            end += 1;
          }
          pushCollapsedSpace(entries, node, index, end - index, segmentBreak);
          index = end;
          continue;
        }
        entries.push({
          collapsed: false,
          node,
          offset: index,
          segmentBreak: false,
          sourceLength: character.length,
          text: character,
        });
        index += character.length;
      }
      return true;
    }

    function dropCjkSegmentBreaks(entries) {
      for (let index = entries.length - 1; index >= 1; index -= 1) {
        const entry = entries[index];
        const next = entries[index + 1];
        if (!entry.collapsed || !entry.segmentBreak || !next) {
          continue;
        }
        // CSS drops a segment break between two wide characters instead of
        // turning it into a space, so a source-wrapped 「日本\n語」 renders as
        // 日本語 and has to be scanned that way.
        if (
          JAPANESE_CHARACTER_PATTERN.test(entries[index - 1].text) &&
          JAPANESE_CHARACTER_PATTERN.test(next.text)
        ) {
          entries.splice(index, 1);
        }
      }
    }

    function collectScanEntries(startNode, startOffset, root, scanLength, styleCache) {
      const walker = createScanWalker(root, styleCache);
      walker.currentNode = startNode;

      const entries = [];
      // Collapsing and segment-break removal can only shorten the scan, so
      // over-collect and trim once the string is final.
      const budget = scanLength * 3 + 32;
      let node = startNode;
      let offset = startOffset;
      while (node && node.nodeType === Node.TEXT_NODE && entries.length < budget) {
        if (!appendTextNode(entries, node, offset, budget, styleCache)) {
          break;
        }
        offset = 0;
        node = walker.nextNode();
        // A word never continues into the next block, as Yomitan's kept "\n"
        // ends its match there.
        if (node?.nodeType === Node.TEXT_NODE && BLOCK_SEPARATOR_PATTERN.test(node.nodeValue || "")) {
          break;
        }
      }
      dropCjkSegmentBreaks(entries);
      return entries.slice(0, scanLength);
    }

    function rangeOffsetWithin(container, node, offset) {
      const range = document.createRange();
      range.selectNodeContents(container);
      range.setEnd(node, offset);
      return range.toString().length;
    }

    function textBlockOf(element, styleCache) {
      return blockAncestor(element, styleCache) ?? document.body;
    }

    /** The block whose own text `node` (a text node, or an element's content) is part of. */
    function blockOf(node) {
      return textBlockOf(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement, new Map());
    }

    /** The blocks under `root`, or holding a text node `root`, whose own text includes Japanese. */
    function textBlocks(root) {
      const styleCache = new Map();
      const blocks = new Set();
      const add = (node) => {
        if (JAPANESE_CHARACTER_PATTERN.test(node.nodeValue || "") && isScannableTextNode(node, styleCache)) {
          blocks.add(textBlockOf(node.parentElement, styleCache));
        }
      };
      if (root.nodeType === Node.TEXT_NODE) {
        add(root);
      } else if (root.nodeType === Node.ELEMENT_NODE) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) add(node);
      }
      return blocks;
    }

    /**
     * The runs of `block`'s own text, each a list of text node parts
     * ({ node, start, end }, up to the node's end or its next preserved line
     * break). A run ends where a hovered word ends: at a <br>, a block
     * separator, a nested block, a control or a line break the page preserves.
     * Only the parts are found here, so a long block costs one walk; runEntries()
     * reads a run's characters once it is needed.
     */
    function textRuns(block) {
      const styleCache = new Map();
      const runs = [];
      let parts = [];
      const endRun = () => {
        if (parts.length > 0) runs.push(parts);
        parts = [];
      };
      const walker = createScanWalker(block, styleCache);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType !== Node.TEXT_NODE || BLOCK_SEPARATOR_PATTERN.test(node.nodeValue || "")
            || isEditingElement(node.parentElement.closest(EDITING_SELECTOR))
            || textBlockOf(node.parentElement, styleCache) !== block) {
          endRun();
          continue;
        }
        const text = node.nodeValue || "";
        let start = 0;
        if (preservesWhitespace(node.parentElement, styleCache)) {
          for (const { index } of text.matchAll(/[\n\r]/gu)) {
            if (index > start) parts.push({ node, start, end: index });
            endRun();
            start = index + 1;
          }
        }
        if (start < text.length) parts.push({ node, start, end: text.length });
      }
      endRun();
      return runs;
    }

    /** A run's character entries, collapsed and joined as a scan reads them. */
    function runEntries(parts) {
      const styleCache = new Map();
      const entries = [];
      for (const { node, start } of parts) appendTextNode(entries, node, start, Infinity, styleCache);
      dropCjkSegmentBreaks(entries);
      return entries;
    }

    function hasVisibleContent(element, styleCache) {
      if (computedStyleFor(element, styleCache).display === "none") return false;
      const visible = !isHiddenElement(element, styleCache);
      if (visible && element.getClientRects().length > 0) return true;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && hasVisibleContent(child, styleCache)) return true;
        if (visible && child.nodeType === Node.TEXT_NODE) {
          // A display:contents editor has no box, but its editable text still does.
          const range = document.createRange();
          range.selectNodeContents(child);
          if (range.getClientRects().length > 0) return true;
        }
      }
      return false;
    }

    function candidateStart(candidate) {
      if (candidate.linkAnchor) return { node: candidate.anchor, offset: 0 };
      return candidate.exactSelection === true
        ? { node: candidate.anchorRange.startContainer, offset: candidate.anchorRange.startOffset }
        : candidate.scanEntries[0];
    }

    function candidateSignature(candidate) {
      const first = candidateStart(candidate);
      return `${candidate.exactSelection === true}\u001f${first.offset}\u001f${candidate.matchOffset}\u001f${candidate.query}`;
    }

    function sameAnchorNode(candidate, other) {
      return Boolean(other) &&
        other.anchor === candidate.anchor &&
        candidateStart(other).node === candidateStart(candidate).node;
    }

    /** Returns the last scanned source character covered by the engine match. */
    function matchedScanEnd(candidate, matched) {
      const wanted = typeof matched === "string" ? matched.length : 0;
      if (wanted <= 0 || !Array.isArray(candidate.scanEntries)) return null;
      let consumed = 0;
      let last = null;
      for (const entry of candidate.scanEntries) {
        if (consumed >= wanted) {
          break;
        }
        consumed += entry.text.length;
        last = entry;
      }
      return last;
    }

    function expandCandidateAnchor(candidate, matched) {
      if (candidate.linkAnchor || candidate.exactSelection === true || !candidate.anchorRange) return;
      const first = candidate.scanEntries?.[0];
      const last = matchedScanEnd(candidate, matched);
      if (!first || !last) return;
      // A page can move scanned text while the lookup is pending.
      if (!withinSources(candidate.sourceElements, first.node) || !withinSources(candidate.sourceElements, last.node)) return;
      try {
        // Scanning starts with a one-glyph range. Once lookup identifies the
        // complete match, place the popup against that word like Yomitan/PR 549.
        const range = document.createRange();
        range.setStart(first.node, first.offset);
        range.setEnd(
          last.node,
          Math.min(
            (last.node.nodeValue || "").length,
            last.offset + last.sourceLength
          )
        );
        if (!range.collapsed) candidate.anchorRange = range;
      } catch {
        // Keep the original hovered-glyph range if the page changed meanwhile.
      }
    }

    /**
     * Translates a matched length in scan coordinates into the raw substring of
     * `candidate.sourceText` that covers it. createSourceHighlighter measures the
     * highlight as `matchedText.length` from `candidate.sourceOffset` inside
     * `sourceText`, and `sourceText` still carries the rt text and uncollapsed
     * whitespace the scan dropped -- so the engine's own `matched` string is the
     * wrong length whenever the word crosses ruby or a line wrap.
     */
    function rawMatchedText(candidate, matched) {
      if (candidate.linkAnchor) return candidate.sourceText;
      if (candidate.exactSelection === true) return candidate.rawSelectionText;
      const last = matchedScanEnd(candidate, matched);
      if (!last) {
        return "";
      }
      try {
        const end = sourceOffset(
          candidate.sourceElements,
          last.node,
          Math.min(
            (last.node.nodeValue || "").length,
            last.offset + last.sourceLength
          )
        );
        if (end > candidate.sourceOffset) {
          return candidate.sourceText.slice(candidate.sourceOffset, end);
        }
      } catch {
        // Fall through to the engine's own string.
      }
      return matched;
    }

    /**
     * The match as `candidate.sentence` spells it; the Anki sentence and cloze
     * cut it out by its length. A selection's raw text counts the furigana and
     * hidden text of its anchor, which its sentence leaves out.
     */
    function sentenceMatchedText(candidate, matched) {
      if (candidate.exactSelection !== true) return rawMatchedText(candidate, matched);
      return candidate.sentence.slice(candidate.matchOffset, candidate.matchOffset + candidate.selectionLength);
    }

    return {
      EDITING_SELECTOR, JAPANESE_CHARACTER_PATTERN, OPAQUE_TAGS, blockOf, candidateSignature, candidateStart,
      caretRangeAt, collectScanEntries, collectSentenceSources, computedStyleFor, expandCandidateAnchor, glyphAtPoint,
      hasVisibleContent, isEditingElement, isHiddenElement, isJapaneseToken, isScannableElement, isScannableTextNode,
      rangeOffsetWithin, rawMatchedText, refineSentence, runEntries, sameAnchorNode, selectionSentence,
      sentenceMatchedText, sourceOffset, textBlocks, textRuns, withSentence,
    };
  }

  globalThis.HDContent = { ...globalThis.HDContent, createPageScanner };
}());
