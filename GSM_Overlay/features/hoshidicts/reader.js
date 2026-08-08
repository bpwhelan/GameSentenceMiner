/*
 * Hoshidicts reader for the GSM overlay.
 *
 * Popup structure and furigana segmentation are adapted from Hoshi Reader:
 * https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup
 *
 * Copyright (C) 2026 Manhhao
 * Copyright (C) 2023-2026 Yomitan Authors
 * Copyright (C) 2021-2022 Yomichan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const popupApi = root && root.GSMHoshidictsPopup;
  const api = factory(popupApi);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsReader = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function (popupApi) {
  "use strict";

  if (!popupApi || typeof popupApi.createPopupView !== "function") {
    throw new Error("Hoshidicts popup support must load before the reader.");
  }
  const { createPopupView, createSourceHighlighter, setMiningButtonState } = popupApi;

  const LOOKUP_DEBOUNCE_MS = 20;
  const LOOKUP_REQUEST_TIMEOUT_MS = 4 * 1000;
  const LOOKUP_SCAN_LENGTH = 10;
  const LOOKUP_MAX_RESULTS = 16;
  const INITIAL_VISIBLE_RESULTS = 6;
  const DEFAULT_POPUP_HIDE_DELAY_MS = 300;
  const DEFAULT_POPUP_NESTING_MAX_DEPTH = 10;
  const MAX_POPUP_HIDE_DELAY_MS = 5 * 1000;
  const MAX_RESPONSE_BYTES = 256 * 1024;
  const MAX_GLOSSARIES = 64;
  const MAX_TRACE_STEPS = 32;
  const MAX_METADATA_GROUPS = 64;
  const MAX_METADATA_VALUES = 64;
  const MAX_TEXT_LENGTH = 128 * 1024;
  const MAX_MINING_REQUEST_BYTES = 256 * 1024;
  const MINING_REQUEST_TIMEOUT_MS = 10 * 1000;
  const MAX_STRUCTURED_DEPTH = 24;
  const MAX_STRUCTURED_NODES = 4096;
  const RECONNECT_INITIAL_DELAY_MS = 750;
  const RECONNECT_MAX_DELAY_MS = 12 * 1000;
  const MINING_STATUS_CACHE_MS = 5 * 1000;
  const MAX_VISIBLE_METADATA_TAGS = 12;
  const SOURCE_HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const JAPANESE_TEXT_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const KANJI_SEGMENT_PATTERN =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]+/gu;
  const KANA_PATTERN = /[\u3040-\u30ff\uff66-\uff9f]/u;
  const ALLOWED_STRUCTURED_TAGS = new Set([
    "br",
    "code",
    "div",
    "em",
    "li",
    "ol",
    "p",
    "rp",
    "rt",
    "ruby",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ]);
  const IGNORED_STRUCTURED_TAGS = new Set([
    "a",
    "audio",
    "button",
    "canvas",
    "iframe",
    "img",
    "input",
    "script",
    "source",
    "style",
    "svg",
    "video",
  ]);

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function boundedString(value, maxLength = MAX_TEXT_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function normalizeLookupResults(payload) {
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.results)) {
      return [];
    }

    let glossaryCount = 0;
    return payload.results.slice(0, LOOKUP_MAX_RESULTS).map((rawResult) => {
      const result = isRecord(rawResult) ? rawResult : {};
      const rawTerm = isRecord(result.term) ? result.term : {};
      const trace = Array.isArray(result.trace)
        ? result.trace.slice(0, MAX_TRACE_STEPS).map((rawStep) => {
            const step = isRecord(rawStep) ? rawStep : {};
            return {
              name: boundedString(step.name, 1024),
              description: boundedString(step.description, 4096),
            };
          }).filter((step) => step.name.length > 0)
        : [];
      const remainingGlossaries = Math.max(0, MAX_GLOSSARIES - glossaryCount);
      const glossaries = Array.isArray(rawTerm.glossaries)
        ? rawTerm.glossaries.slice(0, remainingGlossaries).map((rawGlossary) => {
            const glossary = isRecord(rawGlossary) ? rawGlossary : {};
            return {
              dictionary: boundedString(glossary.dictionary, 4096) || "Dictionary",
              glossary: boundedString(glossary.glossary),
              definitionTags: boundedString(glossary.definitionTags, 4096),
              termTags: boundedString(glossary.termTags, 4096),
            };
          })
        : [];
      glossaryCount += glossaries.length;
      const frequencies = Array.isArray(rawTerm.frequencies)
        ? rawTerm.frequencies.slice(0, MAX_METADATA_GROUPS).map((rawGroup) => {
            const group = isRecord(rawGroup) ? rawGroup : {};
            return {
              dictionary: boundedString(group.dictionary, 4096) || "Dictionary",
              frequencies: Array.isArray(group.frequencies)
                ? group.frequencies.slice(0, MAX_METADATA_VALUES)
                    .map((rawFrequency) => {
                      const frequency = isRecord(rawFrequency) ? rawFrequency : {};
                      return {
                        value: Number.isFinite(frequency.value)
                          ? Math.trunc(frequency.value)
                          : null,
                        displayValue: boundedString(frequency.displayValue, 4096),
                      };
                    })
                    .filter((frequency) => frequency.value !== null)
                : [],
            };
          })
        : [];
      const pitches = Array.isArray(rawTerm.pitches)
        ? rawTerm.pitches.slice(0, MAX_METADATA_GROUPS).map((rawGroup) => {
            const group = isRecord(rawGroup) ? rawGroup : {};
            return {
              dictionary: boundedString(group.dictionary, 4096) || "Dictionary",
              pitches: Array.isArray(group.pitches)
                ? group.pitches.slice(0, MAX_METADATA_VALUES)
                    .map((rawPitch) => {
                      const pitch = isRecord(rawPitch) ? rawPitch : {};
                      return {
                        position: Number.isFinite(pitch.position)
                          ? Math.trunc(pitch.position)
                          : null,
                        pattern: boundedString(pitch.pattern, 4096),
                        nasal: Array.isArray(pitch.nasal)
                          ? pitch.nasal.slice(0, MAX_METADATA_VALUES)
                              .filter(Number.isFinite)
                              .map(Math.trunc)
                          : [],
                        devoice: Array.isArray(pitch.devoice)
                          ? pitch.devoice.slice(0, MAX_METADATA_VALUES)
                              .filter(Number.isFinite)
                              .map(Math.trunc)
                          : [],
                      };
                    })
                    .filter((pitch) => pitch.position !== null)
                : [],
              transcriptions: Array.isArray(group.transcriptions)
                ? group.transcriptions.slice(0, MAX_METADATA_VALUES)
                    .map((value) => boundedString(value, 4096))
                : [],
            };
          })
        : [];

      return {
        matched: boundedString(result.matched, 4096),
        deinflected: boundedString(result.deinflected, 4096),
        trace,
        preprocessorSteps: Number.isFinite(result.preprocessorSteps)
          ? Math.trunc(result.preprocessorSteps)
          : 0,
        term: {
          expression: boundedString(rawTerm.expression, 4096),
          reading: boundedString(rawTerm.reading, 4096),
          rules: boundedString(rawTerm.rules, 4096),
          score: Number.isFinite(rawTerm.score) ? Math.trunc(rawTerm.score) : 0,
          glossaries,
          frequencies,
          pitches,
        },
      };
    }).filter((result) => result.term.expression.length > 0);
  }

  function toHiragana(text) {
    return String(text || "").replace(
      /[\u30a1-\u30f6]/gu,
      (character) => String.fromCharCode(character.charCodeAt(0) - 0x60)
    );
  }

  function createFuriganaSegment(text, reading) {
    return { text, reading };
  }

  function getFuriganaKanaSegments(text, reading) {
    const newSegments = [];
    let start = 0;
    let state = reading[0] === text[0];
    for (let index = 1; index < text.length; index += 1) {
      const nextState = reading[index] === text[index];
      if (state === nextState) {
        continue;
      }
      newSegments.push(
        createFuriganaSegment(
          text.substring(start, index),
          state ? "" : reading.substring(start, index)
        )
      );
      state = nextState;
      start = index;
    }
    newSegments.push(
      createFuriganaSegment(
        text.substring(start),
        state ? "" : reading.substring(start)
      )
    );
    return newSegments;
  }

  function segmentizeFurigana(reading, normalizedReading, groups, groupStart) {
    const groupCount = groups.length - groupStart;
    if (groupCount <= 0) {
      return reading.length === 0 ? [] : null;
    }

    const group = groups[groupStart];
    if (group.isKana) {
      if (
        group.normalizedText !== null &&
        normalizedReading.startsWith(group.normalizedText)
      ) {
        const segments = segmentizeFurigana(
          reading.substring(group.text.length),
          normalizedReading.substring(group.text.length),
          groups,
          groupStart + 1
        );
        if (segments !== null) {
          if (reading.startsWith(group.text)) {
            segments.unshift(createFuriganaSegment(group.text, ""));
          } else {
            segments.unshift(...getFuriganaKanaSegments(group.text, reading));
          }
          return segments;
        }
      }
      return null;
    }

    let result = null;
    for (let index = reading.length; index >= group.text.length; index -= 1) {
      const segments = segmentizeFurigana(
        reading.substring(index),
        normalizedReading.substring(index),
        groups,
        groupStart + 1
      );
      if (segments !== null) {
        if (result !== null) {
          return null;
        }
        segments.unshift(
          createFuriganaSegment(group.text, reading.substring(0, index))
        );
        result = segments;
      }
      if (groupCount === 1) {
        break;
      }
    }
    return result;
  }

  function segmentFurigana(expression, reading) {
    if (!reading || reading === expression) {
      return [{ text: expression, reading: "" }];
    }

    const groups = [];
    const matches = String(expression).match(KANJI_SEGMENT_PATTERN) || [];
    for (const text of matches) {
      const isKana = KANA_PATTERN.test(text[0]);
      groups.push({
        isKana,
        text,
        normalizedText: isKana ? toHiragana(text) : null,
      });
    }

    const segments = segmentizeFurigana(
      reading,
      toHiragana(reading),
      groups,
      0
    );
    return segments === null
      ? [{ text: expression, reading }]
      : segments;
  }

  function appendExpressionRuby(documentRef, parent, expression, reading) {
    for (const segment of segmentFurigana(expression, reading)) {
      if (!segment.reading) {
        parent.appendChild(documentRef.createTextNode(segment.text));
        continue;
      }
      const ruby = documentRef.createElement("ruby");
      ruby.appendChild(documentRef.createTextNode(segment.text));
      const rt = documentRef.createElement("rt");
      rt.textContent = segment.reading;
      ruby.appendChild(rt);
      parent.appendChild(ruby);
    }
  }

  function parseTagList(value) {
    return String(value || "").split(/\s+/u).filter(Boolean);
  }

  function appendStructuredValue(documentRef, parent, value, state, depth) {
    if (state.nodes >= MAX_STRUCTURED_NODES || depth > MAX_STRUCTURED_DEPTH) {
      return;
    }
    if (typeof value === "string") {
      state.nodes += 1;
      parent.appendChild(documentRef.createTextNode(value.slice(0, MAX_TEXT_LENGTH)));
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      state.nodes += 1;
      parent.appendChild(documentRef.createTextNode(String(value)));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        appendStructuredValue(documentRef, parent, child, state, depth + 1);
        if (state.nodes >= MAX_STRUCTURED_NODES) {
          break;
        }
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    const tag = typeof value.tag === "string" ? value.tag.toLowerCase() : "";
    if (IGNORED_STRUCTURED_TAGS.has(tag)) {
      return;
    }
    if (!ALLOWED_STRUCTURED_TAGS.has(tag)) {
      if (Object.prototype.hasOwnProperty.call(value, "content")) {
        appendStructuredValue(documentRef, parent, value.content, state, depth + 1);
      }
      return;
    }

    const element = documentRef.createElement(tag);
    state.nodes += 1;
    if (
      typeof value.lang === "string" &&
      /^[A-Za-z0-9-]{1,35}$/u.test(value.lang)
    ) {
      element.setAttribute("lang", value.lang);
    }
    if (tag === "td" || tag === "th") {
      for (const [property, attribute] of [
        ["colSpan", "colspan"],
        ["rowSpan", "rowspan"],
      ]) {
        const span = Number(value[property]);
        if (Number.isInteger(span) && span >= 1 && span <= 32) {
          element.setAttribute(attribute, String(span));
        }
      }
    }
    if (tag !== "br" && Object.prototype.hasOwnProperty.call(value, "content")) {
      appendStructuredValue(documentRef, element, value.content, state, depth + 1);
    }
    parent.appendChild(element);
  }

  function appendTextOnlyGlossary(documentRef, parent, rawGlossary) {
    const value = boundedString(rawGlossary);
    if (!value) {
      return;
    }
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Plain glossary strings are rendered literally, including any HTML-like text.
    }
    appendStructuredValue(
      documentRef,
      parent,
      parsed,
      { nodes: 0 },
      0
    );
  }

  function calculatePopupPosition(anchorRect, popupSize, viewport, options = {}) {
    const gap = Number.isFinite(options.gap) ? options.gap : 4;
    const padding = Number.isFinite(options.padding) ? options.padding : 6;
    const width = Math.min(
      Math.max(1, popupSize.width),
      Math.max(1, viewport.width - padding * 2)
    );
    const height = Math.min(
      Math.max(1, popupSize.height),
      Math.max(1, viewport.height - padding * 2)
    );
    const clamp = (value, minimum, maximum) =>
      Math.max(minimum, Math.min(value, maximum));

    let left;
    let top;
    if (options.vertical) {
      const spaceRight = viewport.width - anchorRect.right - gap;
      const spaceLeft = anchorRect.left - gap;
      left = spaceRight >= width || spaceRight >= spaceLeft
        ? anchorRect.right + gap
        : anchorRect.left - gap - width;
      top = anchorRect.top;
    } else {
      const spaceBelow = viewport.height - anchorRect.bottom - gap;
      const spaceAbove = anchorRect.top - gap;
      top = spaceBelow >= height || spaceBelow >= spaceAbove
        ? anchorRect.bottom + gap
        : anchorRect.top - gap - height;
      left = anchorRect.left;
    }

    return {
      left: Math.round(clamp(left, padding, viewport.width - width - padding)),
      top: Math.round(clamp(top, padding, viewport.height - height - padding)),
      width,
      height,
    };
  }

  function getUtf16OffsetForPoint(windowRef, element, clientX, clientY) {
    const text = element.textContent || "";
    const characters = Array.from(text);
    if (characters.length <= 1) {
      return 0;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return 0;
    }
    const vertical = windowRef.getComputedStyle(element).writingMode.startsWith("vertical");
    const ratio = vertical
      ? (clientY - rect.top) / rect.height
      : (clientX - rect.left) / rect.width;
    const characterIndex = Math.max(
      0,
      Math.min(characters.length - 1, Math.floor(ratio * characters.length))
    );
    return characters.slice(0, characterIndex).join("").length;
  }

  function sliceCodePoints(text, utf16Offset, count) {
    return Array.from(text.slice(utf16Offset)).slice(0, count).join("");
  }

  function createTextRangeForOffsets(documentRef, root, startOffset, endOffset) {
    const showText = documentRef.defaultView && documentRef.defaultView.NodeFilter
      ? documentRef.defaultView.NodeFilter.SHOW_TEXT
      : 4;
    const walker = documentRef.createTreeWalker(root, showText);
    const boundaries = [];
    let consumed = 0;
    let node = walker.nextNode();
    while (node) {
      const length = (node.nodeValue || "").length;
      boundaries.push({ node, start: consumed, end: consumed + length });
      consumed += length;
      node = walker.nextNode();
    }
    function findBoundary(offset) {
      for (const boundary of boundaries) {
        if (offset <= boundary.end) {
          return {
            node: boundary.node,
            offset: Math.max(0, Math.min(
              (boundary.node.nodeValue || "").length,
              offset - boundary.start
            )),
          };
        }
      }
      const last = boundaries.at(-1);
      return last
        ? { node: last.node, offset: (last.node.nodeValue || "").length }
        : null;
    }
    const start = findBoundary(Math.max(0, startOffset));
    const end = findBoundary(Math.max(startOffset, endOffset));
    if (!start || !end) {
      return null;
    }
    try {
      const range = documentRef.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    } catch {
      return null;
    }
  }

  function resolveGlossaryLookupCandidate(
    windowRef,
    documentRef,
    eventTarget,
    clientX,
    clientY,
    sourceDepth
  ) {
    if (!(eventTarget instanceof windowRef.Element)) {
      return null;
    }
    const glossary = eventTarget.closest(".gsm-hoshidicts-glossary-content");
    if (!glossary) {
      return null;
    }
    const sentence = glossary.textContent || "";
    const caretRange = typeof documentRef.caretRangeFromPoint === "function"
      ? documentRef.caretRangeFromPoint(clientX, clientY)
      : null;
    if (!caretRange || !glossary.contains(caretRange.startContainer)) {
      return null;
    }
    let matchOffset;
    try {
      const prefixRange = documentRef.createRange();
      prefixRange.selectNodeContents(glossary);
      prefixRange.setEnd(caretRange.startContainer, caretRange.startOffset);
      matchOffset = prefixRange.toString().length;
    } catch {
      return null;
    }
    const query = sliceCodePoints(sentence, matchOffset, LOOKUP_SCAN_LENGTH);
    if (!query || !JAPANESE_TEXT_PATTERN.test(query)) {
      return null;
    }
    const firstCodePointLength = Array.from(query)[0].length;
    return {
      anchor: glossary,
      anchorRange: createTextRangeForOffsets(
        documentRef,
        glossary,
        matchOffset,
        matchOffset + firstCodePointLength
      ),
      sourceElements: [glossary],
      sentence,
      matchOffset,
      query,
      sourceDepth,
      vertical: windowRef.getComputedStyle(glossary).writingMode.startsWith("vertical"),
    };
  }

  function resolveLookupCandidate(windowRef, documentRef, eventTarget, clientX, clientY) {
    if (!(eventTarget instanceof windowRef.Element)) {
      return null;
    }
    const textBox = eventTarget.closest('.text-box[data-selectable="true"]');
    if (textBox) {
      const block = textBox.closest(".text-block-container");
      const boxes = block
        ? Array.from(block.querySelectorAll('.text-box[data-selectable="true"]'))
        : [textBox];
      let sentence = "";
      let matchOffset = 0;
      for (const box of boxes) {
        const boxText = box.textContent || "";
        if (box === textBox) {
          matchOffset = sentence.length +
            getUtf16OffsetForPoint(windowRef, box, clientX, clientY);
        }
        sentence += boxText;
      }
      const query = sliceCodePoints(sentence, matchOffset, LOOKUP_SCAN_LENGTH);
      if (!query || !JAPANESE_TEXT_PATTERN.test(query)) {
        return null;
      }
      return {
        anchor: textBox,
        sourceElements: boxes,
        sentence,
        matchOffset,
        query,
        sourceDepth: -1,
        vertical: windowRef.getComputedStyle(textBox).writingMode.startsWith("vertical"),
      };
    }

    const mainText = eventTarget.closest("#text");
    if (!mainText) {
      return null;
    }
    const sentence = mainText.textContent || "";
    let matchOffset = 0;
    const caretRange = typeof documentRef.caretRangeFromPoint === "function"
      ? documentRef.caretRangeFromPoint(clientX, clientY)
      : null;
    if (caretRange && mainText.contains(caretRange.startContainer)) {
      const prefixRange = documentRef.createRange();
      prefixRange.selectNodeContents(mainText);
      prefixRange.setEnd(caretRange.startContainer, caretRange.startOffset);
      matchOffset = prefixRange.toString().length;
    }
    const query = sliceCodePoints(sentence, matchOffset, LOOKUP_SCAN_LENGTH);
    if (!query || !JAPANESE_TEXT_PATTERN.test(query)) {
      return null;
    }
    return {
      anchor: mainText,
      sourceElements: [mainText],
      sentence,
      matchOffset,
      query,
      sourceDepth: -1,
      vertical: false,
    };
  }

  function normalizeLocalHttpBaseUrl(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    try {
      const url = new URL(value);
      if (url.protocol === "ws:") {
        url.protocol = "http:";
      } else if (url.protocol === "wss:") {
        url.protocol = "https:";
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password
      ) {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }

  function resolveGsmApiBaseUrl(settings = {}) {
    const source = isRecord(settings) ? settings : {};
    for (const candidate of [
      source.texthookerUrl,
      source.weburl1,
      source.weburl2,
    ]) {
      const resolved = normalizeLocalHttpBaseUrl(candidate);
      if (resolved) {
        return resolved;
      }
    }
    return "http://127.0.0.1:7275";
  }

  function utf8Length(value) {
    return typeof TextEncoder === "function"
      ? new TextEncoder().encode(value).length
      : value.length;
  }

  function createHoshidictsMiningClient(options = {}) {
    const baseUrl =
      normalizeLocalHttpBaseUrl(options.baseUrl) ||
      "http://127.0.0.1:7275";
    const fetchImpl =
      typeof options.fetch === "function"
        ? options.fetch
        : typeof fetch === "function"
          ? fetch.bind(globalThis)
          : null;
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.trunc(options.timeoutMs)
        : MINING_REQUEST_TIMEOUT_MS;

    async function request(path, init = {}) {
      if (!fetchImpl) {
        throw new Error("GSM mining is unavailable.");
      }
      const controller =
        typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          signal: controller ? controller.signal : undefined,
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error(`GSM returned an invalid response (HTTP ${response.status}).`);
        }
        if (!isRecord(payload)) {
          throw new Error("GSM returned an invalid mining response.");
        }
        if (!response.ok) {
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `GSM mining failed (HTTP ${response.status}).`
          );
        }
        return payload;
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw new Error("GSM mining request timed out.");
        }
        throw error;
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    return {
      async getStatus() {
        return await request("/api/hoshidicts/mining/status");
      },
      async mine(payload) {
        const body = JSON.stringify(payload);
        if (utf8Length(body) > MAX_MINING_REQUEST_BYTES) {
          throw new Error("Hoshidicts mining request is too large.");
        }
        return await request("/api/hoshidicts/mine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      },
    };
  }

  function normalizePopupHideDelay(value, fallback = DEFAULT_POPUP_HIDE_DELAY_MS) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(0, Math.min(MAX_POPUP_HIDE_DELAY_MS, Math.trunc(value)));
  }

  function normalizePopupNestingMaxDepth(
    value,
    fallback = DEFAULT_POPUP_NESTING_MAX_DEPTH
  ) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  function createHoshidictsReader(options = {}) {
    const windowRef = options.window || window;
    const documentRef = options.document || document;
    const WebSocketImpl = options.WebSocket || windowRef.WebSocket;
    const setTimeoutFn = options.setTimeout || windowRef.setTimeout.bind(windowRef);
    const clearTimeoutFn = options.clearTimeout || windowRef.clearTimeout.bind(windowRef);
    const onPopupStateChange =
      typeof options.onPopupStateChange === "function"
        ? options.onPopupStateChange
        : () => {};
    const getMiningStatus =
      typeof options.getMiningStatus === "function"
        ? options.getMiningStatus
        : async () => ({ available: false });
    const onMine = typeof options.onMine === "function" ? options.onMine : null;
    const logger = options.logger || console;
    const serverUrl = String(options.serverUrl || "ws://127.0.0.1:7276");
    const lookupTimeoutMs =
      Number.isFinite(options.lookupTimeoutMs) && options.lookupTimeoutMs > 0
        ? Math.trunc(options.lookupTimeoutMs)
        : LOOKUP_REQUEST_TIMEOUT_MS;
    const reconnectInitialDelayMs =
      Number.isFinite(options.reconnectInitialDelayMs) && options.reconnectInitialDelayMs > 0
        ? Math.trunc(options.reconnectInitialDelayMs)
        : RECONNECT_INITIAL_DELAY_MS;
    const reconnectMaxDelayMs =
      Number.isFinite(options.reconnectMaxDelayMs) &&
      options.reconnectMaxDelayMs >= reconnectInitialDelayMs
        ? Math.trunc(options.reconnectMaxDelayMs)
        : RECONNECT_MAX_DELAY_MS;

    let preferences = {
      lookupMode: options.lookupMode === "hover" ? "hover" : "shift",
      popupHideDelayMs: normalizePopupHideDelay(options.popupHideDelayMs),
      popupNestingMaxDepth: normalizePopupNestingMaxDepth(
        options.popupNestingMaxDepth
      ),
    };
    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let debounceTimer = null;
    let lookupTimeoutTimer = null;
    let hideTimer = null;
    let descendantHideTimer = null;
    let pendingHideReason = "pointer-left";
    let pendingPruneDepth = 1;
    let destroyed = false;
    let shiftPressed = false;
    let pointerInPopup = false;
    let pointerPopupDepth = null;
    let lastPointer = null;
    let requestSequence = 0;
    let latestRequestId = null;
    let latestCandidate = null;
    let latestCandidateSignature = "";
    let latestTargetDepth = 0;
    let latestGeneration = 0;
    let popupVisible = false;
    let miningInFlight = false;
    let miningStatusCache = null;
    let miningStatusCacheExpiresAt = 0;
    let miningStatusPromise = null;
    let shiftRequirementLogged = false;
    let candidateMissLogged = false;
    let candidateSourceSequence = 0;
    let lastHoveredSource = null;
    let lastHoveredTargetDepth = null;
    const popupLevels = [];
    const renderedSignatures = new Map();
    const noticeSignatures = new Map();
    const candidateSourceIds = new WeakMap();
    const chainHighlighter = createSourceHighlighter(
      windowRef,
      documentRef,
      SOURCE_HIGHLIGHT_NAME
    );

    function diagnostic(level, event, details = {}) {
      const sink = typeof logger[level] === "function"
        ? logger[level]
        : typeof logger.log === "function"
          ? logger.log
          : null;
      if (!sink) {
        return;
      }
      let suffix = "";
      try {
        if (isRecord(details) && Object.keys(details).length > 0) {
          suffix = ` ${JSON.stringify(details)}`;
        }
      } catch {
        suffix = "";
      }
      sink.call(logger, `[HoshidictsReader] ${event}${suffix}`);
    }

    function requiresShift() {
      return preferences.lookupMode === "shift";
    }

    function isReadableHoverTarget(target) {
      return target instanceof windowRef.Element && Boolean(
        target.closest(
          '.text-box[data-selectable="true"], #text, .gsm-hoshidicts-glossary-content'
        )
      );
    }

    function publishPopupState(visible) {
      if (popupVisible === visible) {
        return;
      }
      popupVisible = visible;
      onPopupStateChange(visible);
    }

    function clearHideTimer() {
      if (hideTimer !== null) {
        clearTimeoutFn(hideTimer);
        hideTimer = null;
      }
    }

    function clearDescendantHideTimer() {
      if (descendantHideTimer !== null) {
        clearTimeoutFn(descendantHideTimer);
        descendantHideTimer = null;
      }
    }

    function clearLookupTimeout() {
      if (lookupTimeoutTimer !== null) {
        clearTimeoutFn(lookupTimeoutTimer);
        lookupTimeoutTimer = null;
      }
    }

    function invalidateLookup() {
      latestGeneration += 1;
      latestRequestId = null;
      latestCandidate = null;
      latestCandidateSignature = "";
      clearLookupTimeout();
      if (debounceTimer !== null) {
        clearTimeoutFn(debounceTimer);
        debounceTimer = null;
      }
    }

    function getPopupDepthForTarget(target) {
      if (!(target instanceof windowRef.Element)) {
        return null;
      }
      const popup = target.closest(".gsm-hoshidicts-popup[data-hoshidicts-depth]");
      if (!popup) {
        return null;
      }
      const depth = Number.parseInt(popup.dataset.hoshidictsDepth || "", 10);
      return Number.isInteger(depth) && popupLevels[depth]?.popup === popup
        ? depth
        : null;
    }

    function onPopupPointerEnter(depth) {
      pointerInPopup = true;
      pointerPopupDepth = depth;
      clearHideTimer();
      if (descendantHideTimer !== null && depth >= pendingPruneDepth) {
        clearDescendantHideTimer();
      }
    }

    function onPopupPointerLeave(depth) {
      if (pointerPopupDepth === depth) {
        pointerPopupDepth = null;
      }
      pointerInPopup = false;
      scheduleHide("popup-left");
    }

    function createPopupLevel(depth) {
      const popup = documentRef.createElement("section");
      popup.id = depth === 0
        ? "gsm-hoshidicts-popup"
        : `gsm-hoshidicts-popup-${depth}`;
      popup.className = "gsm-hoshidicts-popup interactive";
      popup.dataset.hoshidictsDepth = String(depth);
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-label", "Hoshidicts lookup");
      popup.hidden = true;
      if (depth > 0) {
        popup.style.zIndex = "2147483647";
      }
      const stopPropagation = (event) => event.stopPropagation();
      const pointerEnter = () => onPopupPointerEnter(depth);
      const pointerLeave = () => onPopupPointerLeave(depth);
      popup.addEventListener("pointerdown", stopPropagation);
      popup.addEventListener("click", stopPropagation);
      popup.addEventListener("pointerenter", pointerEnter);
      popup.addEventListener("pointerleave", pointerLeave);
      documentRef.body.appendChild(popup);
      const level = {
        depth,
        popup,
        view: null,
        visible: false,
        candidate: null,
        miningStatusGeneration: 0,
        cleanup() {
          popup.removeEventListener("pointerdown", stopPropagation);
          popup.removeEventListener("click", stopPropagation);
          popup.removeEventListener("pointerenter", pointerEnter);
          popup.removeEventListener("pointerleave", pointerLeave);
        },
      };
      level.view = createPopupView({
        window: windowRef,
        document: documentRef,
        popup,
        appendExpressionRuby,
        appendTextOnlyGlossary,
        parseTagList,
        initialResultCount: INITIAL_VISIBLE_RESULTS,
        maxMetadataTags: MAX_VISIBLE_METADATA_TAGS,
        sourceHighlighter: chainHighlighter.scope(depth),
        positionPopup: () => positionPopupAndDescendants(depth),
        onMineClick(button, result, candidate, feedback) {
          void mineResult(button, result, candidate, feedback);
        },
      });
      return level;
    }

    function ensurePopupLevel(depth) {
      while (popupLevels.length <= depth) {
        popupLevels.push(createPopupLevel(popupLevels.length));
      }
      return popupLevels[depth];
    }

    function pruneFromDepth(depth, reason = "descendants-pruned") {
      const startDepth = Math.max(0, Math.trunc(depth));
      clearDescendantHideTimer();
      if (latestCandidate && latestTargetDepth >= startDepth) {
        invalidateLookup();
      }
      for (let index = popupLevels.length - 1; index >= startDepth; index -= 1) {
        const level = popupLevels[index];
        level.miningStatusGeneration += 1;
        level.candidate = null;
        level.view.clear();
        level.popup.hidden = true;
        level.visible = false;
        renderedSignatures.delete(index);
        noticeSignatures.delete(index);
        if (index > 0) {
          level.cleanup();
          level.popup.remove();
        }
      }
      if (startDepth === 0) {
        popupLevels.length = Math.min(1, popupLevels.length);
        publishPopupState(false);
      } else if (popupLevels.length > startDepth) {
        popupLevels.length = startDepth;
      }
      if (pointerPopupDepth !== null && pointerPopupDepth >= startDepth) {
        pointerPopupDepth = null;
        pointerInPopup = false;
      }
      diagnostic("debug", "popup.pruned", { depth: startDepth, reason });
    }

    function hide(reason = "hide") {
      clearHideTimer();
      clearDescendantHideTimer();
      invalidateLookup();
      pruneFromDepth(0, reason);
      return true;
    }

    function scheduleHide(reason = "pointer-left") {
      pendingHideReason = reason;
      clearHideTimer();
      if (pointerInPopup || !popupVisible) {
        return;
      }
      if (preferences.popupHideDelayMs === 0) {
        hide(reason);
        return;
      }
      hideTimer = setTimeoutFn(() => {
        hideTimer = null;
        if (!pointerInPopup) {
          hide(reason);
        }
      }, preferences.popupHideDelayMs);
    }

    function schedulePruneFromDepth(depth, reason = "ancestor-hovered") {
      if (popupLevels.length <= depth) {
        return;
      }
      pendingPruneDepth = depth;
      clearDescendantHideTimer();
      if (preferences.popupHideDelayMs === 0) {
        pruneFromDepth(depth, reason);
        return;
      }
      descendantHideTimer = setTimeoutFn(() => {
        descendantHideTimer = null;
        if (pointerPopupDepth === null || pointerPopupDepth < depth) {
          pruneFromDepth(depth, reason);
        }
      }, preferences.popupHideDelayMs);
    }

    function isCandidateAnchorConnected(candidate) {
      if (!candidate || !candidate.anchor || !candidate.anchor.isConnected) {
        return false;
      }
      return !candidate.anchorRange || candidate.anchorRange.startContainer.isConnected;
    }

    function getCandidateAnchorRect(candidate) {
      if (
        candidate.anchorRange &&
        typeof candidate.anchorRange.getBoundingClientRect === "function"
      ) {
        try {
          const rangeRect = candidate.anchorRange.getBoundingClientRect();
          if (rangeRect && Number.isFinite(rangeRect.left)) {
            return rangeRect;
          }
        } catch {
          // Fall back to the containing definition element.
        }
      }
      return candidate.anchor.getBoundingClientRect();
    }

    function calculateChildPosition(anchorRect, popupSize, parentRect) {
      const padding = 6;
      const gap = 6;
      const viewport = { width: windowRef.innerWidth, height: windowRef.innerHeight };
      const width = Math.min(
        Math.max(1, popupSize.width),
        Math.max(1, viewport.width - padding * 2)
      );
      const height = Math.min(
        Math.max(1, popupSize.height),
        Math.max(1, viewport.height - padding * 2)
      );
      const spaceRight = viewport.width - parentRect.right - gap;
      const spaceLeft = parentRect.left - gap;
      const preferredLeft = spaceRight >= width || spaceRight >= spaceLeft
        ? parentRect.right + gap
        : parentRect.left - gap - width;
      const clamp = (value, minimum, maximum) =>
        Math.max(minimum, Math.min(value, maximum));
      return {
        left: Math.round(clamp(preferredLeft, padding, viewport.width - width - padding)),
        top: Math.round(clamp(anchorRect.top, padding, viewport.height - height - padding)),
        width,
        height,
      };
    }

    function positionPopup(depth = 0) {
      const level = popupLevels[depth];
      if (!level || !level.visible) {
        return;
      }
      if (!isCandidateAnchorConnected(level.candidate)) {
        if (depth === 0) {
          hide("anchor-removed");
        } else {
          pruneFromDepth(depth, "anchor-removed");
        }
        return;
      }
      const anchorRect = getCandidateAnchorRect(level.candidate);
      const measuredRect = level.popup.getBoundingClientRect();
      const popupSize = {
        width: measuredRect.width || Math.min(420, windowRef.innerWidth - 12),
        height: measuredRect.height || Math.min(420, windowRef.innerHeight * 0.6),
      };
      const parentLevel = depth > 0 ? popupLevels[depth - 1] : null;
      const position = parentLevel && parentLevel.visible
        ? calculateChildPosition(
            anchorRect,
            popupSize,
            parentLevel.popup.getBoundingClientRect()
          )
        : calculatePopupPosition(
            anchorRect,
            popupSize,
            { width: windowRef.innerWidth, height: windowRef.innerHeight },
            { vertical: level.candidate.vertical }
          );
      level.popup.style.left = `${position.left}px`;
      level.popup.style.top = `${position.top}px`;
      level.popup.style.maxWidth = `${position.width}px`;
      level.popup.style.maxHeight = `${position.height}px`;
    }

    function positionPopupAndDescendants(startDepth = 0) {
      for (let depth = startDepth; depth < popupLevels.length; depth += 1) {
        positionPopup(depth);
      }
    }

    function positionAllPopups() {
      positionPopupAndDescendants(0);
    }

    function showPopup(candidate, targetDepth) {
      clearHideTimer();
      const level = ensurePopupLevel(targetDepth);
      level.candidate = candidate;
      level.popup.hidden = false;
      level.popup.scrollTop = 0;
      level.visible = true;
      publishPopupState(true);
      positionPopup(targetDepth);
      return level;
    }

    function renderLookupNotice(candidate, message, targetDepth, signature) {
      const level = ensurePopupLevel(targetDepth);
      level.view.renderNotice(message);
      renderedSignatures.set(targetDepth, signature);
      noticeSignatures.set(targetDepth, signature);
      showPopup(candidate, targetDepth);
    }

    async function getCachedMiningStatus() {
      const now = Date.now();
      if (miningStatusCache && now < miningStatusCacheExpiresAt) {
        return miningStatusCache;
      }
      if (miningStatusPromise) {
        return await miningStatusPromise;
      }
      try {
        miningStatusPromise = Promise.resolve(getMiningStatus());
      } catch (error) {
        miningStatusPromise = Promise.reject(error);
      }
      try {
        miningStatusCache = await miningStatusPromise;
      } catch (error) {
        miningStatusCache = {
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        miningStatusPromise = null;
      }
      miningStatusCacheExpiresAt = Date.now() + MINING_STATUS_CACHE_MS;
      return miningStatusCache;
    }

    async function refreshMiningButtons(level, buttons, feedback) {
      const generation = ++level.miningStatusGeneration;
      const status = await getCachedMiningStatus();
      if (
        destroyed ||
        generation !== level.miningStatusGeneration ||
        !feedback.isConnected
      ) {
        return;
      }
      if (status && status.available === true && onMine) {
        for (const button of buttons) {
          button.hidden = false;
          setMiningButtonState(button, "ready");
        }
        const unmapped = Array.isArray(status.unmappedFields)
          ? status.unmappedFields.filter((field) => typeof field === "string")
          : [];
        level.view.setFeedback(
          feedback,
          unmapped.length > 0
            ? `Optional Anki fields not mapped: ${unmapped.join(", ")}.`
            : "",
          "warning"
        );
        return;
      }
      const reason = status && typeof status.error === "string"
        ? status.error
        : "Set up Anki mining in Hoshidicts Settings.";
      for (const button of buttons) {
        button.hidden = true;
        setMiningButtonState(button, "unavailable", reason);
      }
      level.view.setFeedback(
        feedback,
        `Anki mining unavailable: ${reason}`,
        "warning"
      );
    }

    async function mineResult(button, result, candidate, feedback) {
      if (
        !onMine ||
        miningInFlight ||
        !["ready", "error"].includes(button.dataset.state)
      ) {
        return;
      }
      const level = popupLevels.find((entry) => entry.popup.contains(button));
      if (!level) {
        return;
      }
      miningInFlight = true;
      level.view.setFeedback(feedback, "Adding note to Anki…");
      const buttons = popupLevels.flatMap((entry) =>
        Array.from(entry.popup.querySelectorAll(".gsm-hoshidicts-mine-button"))
      );
      for (const current of buttons) {
        setMiningButtonState(current, current === button ? "mining" : "checking");
      }
      try {
        const response = await onMine({
          result,
          sentence: candidate.sentence,
          matchOffset: candidate.matchOffset,
        });
        if (!response || response.success !== true) {
          throw new Error(
            response && typeof response.error === "string"
              ? response.error
              : "Could not add the note."
          );
        }
        setMiningButtonState(button, "success");
        const unmapped = Array.isArray(response.unmappedFields)
          ? response.unmappedFields.filter((field) => typeof field === "string")
          : [];
        level.view.setFeedback(
          feedback,
          unmapped.length > 0
            ? `Added to Anki. Optional fields not filled: ${unmapped.join(", ")}.`
            : "Added to Anki.",
          unmapped.length > 0 ? "warning" : "success"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const duplicate = /already exists|duplicate/iu.test(message);
        setMiningButtonState(button, duplicate ? "duplicate" : "error", message);
        level.view.setFeedback(
          feedback,
          duplicate ? "Already in Anki." : `Could not add to Anki: ${message}`,
          duplicate ? "info" : "error"
        );
      } finally {
        miningInFlight = false;
        for (const current of buttons) {
          if (current !== button && current.isConnected) {
            setMiningButtonState(current, "ready");
          }
        }
      }
    }

    function expandCandidateAnchor(candidate, matchedText) {
      if (!candidate.anchorRange || candidate.sourceElements.length !== 1) {
        return;
      }
      candidate.anchorRange = createTextRangeForOffsets(
        documentRef,
        candidate.sourceElements[0],
        candidate.matchOffset,
        candidate.matchOffset + matchedText.length
      ) || candidate.anchorRange;
    }

    function handleLookupResponse(rawData) {
      const serialized = typeof rawData === "string"
        ? rawData
        : rawData instanceof windowRef.ArrayBuffer
          ? new windowRef.TextDecoder().decode(rawData)
          : String(rawData);
      if (serialized.length > MAX_RESPONSE_BYTES) {
        diagnostic("warn", "response.too-large", {
          bytes: serialized.length,
          maxBytes: MAX_RESPONSE_BYTES,
        });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(serialized);
      } catch {
        diagnostic("warn", "response.invalid-json", { bytes: serialized.length });
        return;
      }
      if (!isRecord(payload) || payload.type !== "hoshidicts_lookup_result") {
        return;
      }
      if (payload.requestId !== latestRequestId) {
        diagnostic("debug", "response.stale", {
          requestId: boundedString(payload.requestId, 256),
          expectedRequestId: boundedString(latestRequestId, 256),
        });
        return;
      }
      clearLookupTimeout();
      const candidate = latestCandidate;
      const signature = latestCandidateSignature;
      const targetDepth = latestTargetDepth;
      const requestId = latestRequestId;
      latestRequestId = null;
      if (!candidate || !isCandidateAnchorConnected(candidate)) {
        diagnostic("warn", "lookup.missing-candidate", { requestId, targetDepth });
        pruneFromDepth(targetDepth, "lookup-error");
        return;
      }
      if (targetDepth > preferences.popupNestingMaxDepth) {
        pruneFromDepth(targetDepth, "depth-limit-changed");
        return;
      }
      if (payload.success !== true) {
        diagnostic("warn", "lookup.failed", {
          requestId,
          targetDepth,
          dictionaryCount: Number.isFinite(payload.dictionaryCount)
            ? Math.trunc(payload.dictionaryCount)
            : null,
          featureDisabled: payload.featureDisabled === true,
          error: boundedString(payload.error, 4096) || "unknown lookup error",
        });
        const message = payload.featureDisabled === true
          ? "Hoshidicts is off. Enable it in Hoshidicts Settings."
          : payload.dictionaryCount === 0
            ? "No Hoshidicts dictionaries are enabled. Open Hoshidicts Settings."
            : `Dictionary lookup failed: ${boundedString(payload.error, 1024) || "try again"}`;
        renderLookupNotice(candidate, message, targetDepth, signature);
        return;
      }
      const results = normalizeLookupResults(payload);
      if (results.length === 0) {
        diagnostic("info", "lookup.empty", {
          requestId,
          targetDepth,
          dictionaryCount: Number.isFinite(payload.dictionaryCount)
            ? Math.trunc(payload.dictionaryCount)
            : null,
          query: candidate.query,
        });
        latestCandidate = null;
        pruneFromDepth(targetDepth, "no-results");
        return;
      }
      expandCandidateAnchor(
        candidate,
        results[0].matched || results[0].term.expression
      );
      const level = ensurePopupLevel(targetDepth);
      const rendered = level.view.renderResults(results, candidate);
      renderedSignatures.set(targetDepth, signature);
      noticeSignatures.delete(targetDepth);
      showPopup(candidate, targetDepth);
      void refreshMiningButtons(level, rendered.miningButtons, rendered.feedback);
      diagnostic("info", "lookup.rendered", {
        requestId,
        targetDepth,
        dictionaryCount: Number.isFinite(payload.dictionaryCount)
          ? Math.trunc(payload.dictionaryCount)
          : null,
        resultCount: results.length,
        query: candidate.query,
        firstExpression: results[0].term.expression,
      });
    }

    function scheduleReconnect() {
      if (destroyed || reconnectTimer !== null) {
        return;
      }
      const delay = Math.min(
        reconnectMaxDelayMs,
        reconnectInitialDelayMs * (2 ** Math.min(reconnectAttempt, 10))
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      diagnostic("debug", "socket.reconnect-scheduled", { delay });
    }

    function connect() {
      if (
        destroyed ||
        !WebSocketImpl ||
        (socket && (
          socket.readyState === WebSocketImpl.OPEN ||
          socket.readyState === WebSocketImpl.CONNECTING
        ))
      ) {
        return;
      }
      try {
        diagnostic("debug", "socket.connecting", { serverUrl });
        const nextSocket = new WebSocketImpl(serverUrl);
        socket = nextSocket;
        nextSocket.addEventListener("open", () => {
          if (socket !== nextSocket) {
            return;
          }
          reconnectAttempt = 0;
          nextSocket.send(JSON.stringify({
            type: "configure_features",
            features: ["hoshidicts"],
          }));
          diagnostic("info", "socket.open", { serverUrl });
          if (latestCandidate && latestRequestId === null) {
            sendLookup(
              latestCandidate,
              latestGeneration,
              latestTargetDepth,
              latestCandidateSignature
            );
          }
        });
        nextSocket.addEventListener("message", (event) => {
          if (socket === nextSocket) {
            handleLookupResponse(event.data);
          }
        });
        nextSocket.addEventListener("close", (event) => {
          if (socket !== nextSocket) {
            return;
          }
          socket = null;
          hide("socket-closed");
          diagnostic("warn", "socket.closed", {
            serverUrl,
            code: Number.isFinite(event && event.code) ? Math.trunc(event.code) : null,
            reason: boundedString(event && event.reason, 1024),
          });
          scheduleReconnect();
        });
        nextSocket.addEventListener("error", () => {
          if (socket === nextSocket) {
            diagnostic("warn", "socket.error", { serverUrl });
          }
        });
      } catch (error) {
        diagnostic("warn", "socket.connect-failed", {
          serverUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleReconnect();
      }
    }

    function sendLookup(candidate, generation, targetDepth, signature) {
      if (
        destroyed ||
        generation !== latestGeneration ||
        targetDepth > preferences.popupNestingMaxDepth ||
        !isCandidateAnchorConnected(candidate)
      ) {
        return;
      }
      latestCandidate = candidate;
      latestTargetDepth = targetDepth;
      latestCandidateSignature = signature;
      if (lookupTimeoutTimer === null) {
        lookupTimeoutTimer = setTimeoutFn(() => {
          lookupTimeoutTimer = null;
          if (generation !== latestGeneration) {
            return;
          }
          const requestId = latestRequestId;
          latestRequestId = null;
          renderLookupNotice(
            candidate,
            "Dictionary lookup timed out. Check that the overlay service is running.",
            targetDepth,
            signature
          );
          diagnostic("warn", "lookup.timed-out", {
            requestId,
            targetDepth,
            query: candidate.query,
          });
        }, lookupTimeoutMs);
      }
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
        diagnostic("debug", "lookup.waiting-for-socket", {
          query: candidate.query,
          targetDepth,
          socketState: socket ? socket.readyState : null,
        });
        connect();
        return;
      }
      const requestId = `overlay-lookup-${++requestSequence}`;
      latestRequestId = requestId;
      socket.send(JSON.stringify({
        type: "hoshidicts_lookup",
        requestId,
        text: candidate.query,
      }));
      diagnostic("debug", "lookup.sent", {
        requestId,
        targetDepth,
        query: candidate.query,
        matchOffset: candidate.matchOffset,
      });
    }

    function queueLookup(candidate, targetDepth) {
      let sourceId = candidateSourceIds.get(candidate.anchor);
      if (sourceId === undefined) {
        sourceId = ++candidateSourceSequence;
        candidateSourceIds.set(candidate.anchor, sourceId);
      }
      const signature = [
        targetDepth,
        sourceId,
        candidate.sentence,
        candidate.matchOffset,
        candidate.query,
      ].join("\u0000");
      clearHideTimer();
      clearDescendantHideTimer();
      if (
        signature === latestCandidateSignature &&
        latestTargetDepth === targetDepth &&
        (latestRequestId !== null || debounceTimer !== null)
      ) {
        return;
      }
      if (renderedSignatures.get(targetDepth) === signature) {
        invalidateLookup();
        schedulePruneFromDepth(targetDepth + 1, "ancestor-hovered");
        return;
      }
      invalidateLookup();
      pruneFromDepth(targetDepth, "candidate-changed");
      latestCandidate = candidate;
      latestTargetDepth = targetDepth;
      latestCandidateSignature = signature;
      const generation = latestGeneration;
      debounceTimer = setTimeoutFn(() => {
        debounceTimer = null;
        sendLookup(candidate, generation, targetDepth, signature);
      }, LOOKUP_DEBOUNCE_MS);
    }

    function clearHoveredSource() {
      lastHoveredSource = null;
      lastHoveredTargetDepth = null;
    }

    function queueHoveredLookup(candidate, targetDepth) {
      const enteredSource =
        lastHoveredSource !== candidate.anchor ||
        lastHoveredTargetDepth !== targetDepth;
      lastHoveredSource = candidate.anchor;
      lastHoveredTargetDepth = targetDepth;
      if (
        enteredSource &&
        noticeSignatures.has(targetDepth) &&
        noticeSignatures.get(targetDepth) === renderedSignatures.get(targetDepth)
      ) {
        renderedSignatures.delete(targetDepth);
      }
      queueLookup(candidate, targetDepth);
    }

    function scanPointer(pointer, modifierActive) {
      if (!pointer || !(pointer.target instanceof windowRef.Element)) {
        return;
      }
      const popupDepth = getPopupDepthForTarget(pointer.target);
      pointerInPopup = popupDepth !== null;
      pointerPopupDepth = popupDepth;
      if (popupDepth !== null) {
        clearHideTimer();
        if (descendantHideTimer !== null && popupDepth >= pendingPruneDepth) {
          clearDescendantHideTimer();
        }
      }
      if (requiresShift() && !modifierActive) {
        clearHoveredSource();
        if (!shiftRequirementLogged && isReadableHoverTarget(pointer.target)) {
          shiftRequirementLogged = true;
          diagnostic("info", "hover.shift-required", {
            message: "Hold Shift while hovering readable text to run a lookup.",
          });
        }
        invalidateLookup();
        scheduleHide("shift-not-held");
        return;
      }

      if (popupDepth !== null) {
        const targetDepth = popupDepth + 1;
        if (targetDepth > preferences.popupNestingMaxDepth) {
          clearHoveredSource();
          invalidateLookup();
          schedulePruneFromDepth(targetDepth, "depth-limit");
          return;
        }
        const candidate = resolveGlossaryLookupCandidate(
          windowRef,
          documentRef,
          pointer.target,
          pointer.clientX,
          pointer.clientY,
          popupDepth
        );
        if (candidate) {
          candidateMissLogged = false;
          queueHoveredLookup(candidate, targetDepth);
        } else {
          clearHoveredSource();
          invalidateLookup();
          schedulePruneFromDepth(targetDepth, "ancestor-hovered");
        }
        return;
      }

      const candidate = resolveLookupCandidate(
        windowRef,
        documentRef,
        pointer.target,
        pointer.clientX,
        pointer.clientY
      );
      if (candidate) {
        candidateMissLogged = false;
        queueHoveredLookup(candidate, 0);
        return;
      }
      clearHoveredSource();
      if (!candidateMissLogged) {
        candidateMissLogged = true;
        diagnostic("debug", "hover.no-candidate", {
          target: boundedString(pointer.target.id || pointer.target.className, 256),
        });
      }
      invalidateLookup();
      scheduleHide("pointer-left-text");
    }

    function onMouseMove(event) {
      lastPointer = {
        target: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
      };
      scanPointer(lastPointer, shiftPressed || event.shiftKey);
    }

    function onKeyDown(event) {
      if (event.key !== "Shift") {
        return;
      }
      const wasPressed = shiftPressed;
      shiftPressed = true;
      if (!wasPressed && requiresShift()) {
        scanPointer(lastPointer, true);
      }
    }

    function onKeyUp(event) {
      if (event.key === "Shift") {
        shiftPressed = false;
        if (requiresShift()) {
          invalidateLookup();
          scheduleHide("shift-released");
        }
      }
    }

    function updatePreferences(nextPreferences = {}) {
      const hadHideTimer = hideTimer !== null;
      const previousMode = preferences.lookupMode;
      const previousMaxDepth = preferences.popupNestingMaxDepth;
      preferences = {
        lookupMode: Object.prototype.hasOwnProperty.call(nextPreferences, "lookupMode")
          ? nextPreferences.lookupMode === "hover" ? "hover" : "shift"
          : preferences.lookupMode,
        popupHideDelayMs: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupHideDelayMs"
        )
          ? normalizePopupHideDelay(
              nextPreferences.popupHideDelayMs,
              preferences.popupHideDelayMs
            )
          : preferences.popupHideDelayMs,
        popupNestingMaxDepth: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupNestingMaxDepth"
        )
          ? normalizePopupNestingMaxDepth(
              nextPreferences.popupNestingMaxDepth,
              preferences.popupNestingMaxDepth
            )
          : preferences.popupNestingMaxDepth,
      };
      if (hadHideTimer) {
        clearHideTimer();
        scheduleHide(pendingHideReason);
      }
      if (preferences.popupNestingMaxDepth < previousMaxDepth) {
        pruneFromDepth(
          preferences.popupNestingMaxDepth + 1,
          "depth-limit-changed"
        );
      }
      if (previousMode !== preferences.lookupMode) {
        shiftRequirementLogged = false;
        if (requiresShift() && !shiftPressed) {
          invalidateLookup();
          scheduleHide("lookup-mode-changed");
        } else {
          scanPointer(lastPointer, true);
        }
      }
      diagnostic("info", "preferences.updated", preferences);
      return { ...preferences };
    }

    function onWindowBlur() {
      shiftPressed = false;
      clearHoveredSource();
      hide("window-blurred");
    }

    function destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      diagnostic("info", "reader.destroyed");
      hide("destroy");
      if (reconnectTimer !== null) {
        clearTimeoutFn(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        const currentSocket = socket;
        socket = null;
        currentSocket.close();
      }
      documentRef.removeEventListener("mousemove", onMouseMove, true);
      documentRef.removeEventListener("keydown", onKeyDown, true);
      documentRef.removeEventListener("keyup", onKeyUp, true);
      windowRef.removeEventListener("resize", positionAllPopups);
      windowRef.removeEventListener("scroll", positionAllPopups, true);
      windowRef.removeEventListener("blur", onWindowBlur);
      for (const level of popupLevels) {
        level.cleanup();
        level.popup.remove();
      }
      popupLevels.length = 0;
      chainHighlighter.clearAll();
      documentRef.documentElement.classList.remove("gsm-hoshidicts-enabled");
      delete documentRef.documentElement.dataset.gsmHoshidictsEnabled;
    }

    documentRef.documentElement.classList.add("gsm-hoshidicts-enabled");
    documentRef.documentElement.dataset.gsmHoshidictsEnabled = "true";
    ensurePopupLevel(0);
    documentRef.addEventListener("mousemove", onMouseMove, true);
    documentRef.addEventListener("keydown", onKeyDown, true);
    documentRef.addEventListener("keyup", onKeyUp, true);
    windowRef.addEventListener("resize", positionAllPopups);
    windowRef.addEventListener("scroll", positionAllPopups, true);
    windowRef.addEventListener("blur", onWindowBlur);
    diagnostic("info", "reader.initialized", {
      serverUrl,
      requiresShift: requiresShift(),
      popupHideDelayMs: preferences.popupHideDelayMs,
      popupNestingMaxDepth: preferences.popupNestingMaxDepth,
      scanLength: LOOKUP_SCAN_LENGTH,
    });
    connect();

    return {
      destroy,
      hide,
      isVisible: () => popupVisible,
      getPopupElement: () => popupLevels[0]?.popup || null,
      getPopupElements: () => popupLevels
        .filter((level) => level.visible)
        .map((level) => level.popup),
      getPreferences: () => ({ ...preferences }),
      positionPopup: positionAllPopups,
      updatePreferences,
    };
  }

  return {
    DEFAULT_POPUP_HIDE_DELAY_MS,
    DEFAULT_POPUP_NESTING_MAX_DEPTH,
    INITIAL_VISIBLE_RESULTS,
    LOOKUP_DEBOUNCE_MS,
    LOOKUP_MAX_RESULTS,
    LOOKUP_REQUEST_TIMEOUT_MS,
    LOOKUP_SCAN_LENGTH,
    MAX_POPUP_HIDE_DELAY_MS,
    appendExpressionRuby,
    appendTextOnlyGlossary,
    calculatePopupPosition,
    createHoshidictsMiningClient,
    createHoshidictsReader,
    normalizePopupHideDelay,
    normalizePopupNestingMaxDepth,
    normalizeLookupResults,
    resolveGsmApiBaseUrl,
    resolveLookupCandidate,
    resolveGlossaryLookupCandidate,
    segmentFurigana,
    setMiningButtonState,
  };
}));
