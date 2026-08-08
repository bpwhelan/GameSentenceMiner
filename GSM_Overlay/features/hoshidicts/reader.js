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
  const { createPopupView, setMiningButtonState } = popupApi;

  const LOOKUP_DEBOUNCE_MS = 20;
  const LOOKUP_REQUEST_TIMEOUT_MS = 4 * 1000;
  const LOOKUP_SCAN_LENGTH = 10;
  const LOOKUP_MAX_RESULTS = 16;
  const INITIAL_VISIBLE_RESULTS = 6;
  const DEFAULT_POPUP_HIDE_DELAY_MS = 300;
  const MAX_POPUP_HIDE_DELAY_MS = 5 * 1000;
  const MAX_RESPONSE_BYTES = 256 * 1024;
  const MAX_GLOSSARIES = 64;
  const MAX_TRACE_STEPS = 32;
  const MAX_METADATA_GROUPS = 64;
  const MAX_METADATA_VALUES = 64;
  const MAX_TEXT_LENGTH = 128 * 1024;
  const MAX_MINING_REQUEST_BYTES = 256 * 1024;
  const MINING_REQUEST_TIMEOUT_MS = 10 * 1000;
  const MAX_LOOKUP_STATS_REQUEST_BYTES = 4 * 1024;
  const MAX_LOOKUP_STATS_TEXT_LENGTH = 256;
  const LOOKUP_STATS_REQUEST_TIMEOUT_MS = 2 * 1000;
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

  function createHoshidictsLookupStatsClient(options = {}) {
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
        : LOOKUP_STATS_REQUEST_TIMEOUT_MS;

    return {
      async record(payload) {
        if (!fetchImpl) {
          throw new Error("GSM lookup statistics are unavailable.");
        }
        if (!isRecord(payload)) {
          throw new Error("A lookup statistics payload is required.");
        }
        const term = typeof payload.term === "string" ? payload.term : "";
        const reading = typeof payload.reading === "string" ? payload.reading : "";
        if (
          term.length === 0 ||
          term.length > MAX_LOOKUP_STATS_TEXT_LENGTH ||
          reading.length > MAX_LOOKUP_STATS_TEXT_LENGTH
        ) {
          throw new Error("The lookup statistics payload is invalid.");
        }
        const body = JSON.stringify({ term, reading });
        if (utf8Length(body) > MAX_LOOKUP_STATS_REQUEST_BYTES) {
          throw new Error("The lookup statistics payload is too large.");
        }
        const controller =
          typeof AbortController === "function" ? new AbortController() : null;
        const timeoutId = controller
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null;
        try {
          const response = await fetchImpl(
            `${baseUrl}/api/hoshidicts/lookup-stats`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              signal: controller ? controller.signal : undefined,
            }
          );
          let responsePayload;
          try {
            responsePayload = await response.json();
          } catch {
            throw new Error("GSM returned an invalid lookup statistics response.");
          }
          if (!response.ok || !isRecord(responsePayload) || responsePayload.success !== true) {
            throw new Error("GSM could not record the lookup.");
          }
          return responsePayload;
        } catch (error) {
          if (error && error.name === "AbortError") {
            throw new Error("GSM lookup statistics request timed out.");
          }
          throw error;
        } finally {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
        }
      },
    };
  }

  function normalizePopupHideDelay(value, fallback = DEFAULT_POPUP_HIDE_DELAY_MS) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(0, Math.min(MAX_POPUP_HIDE_DELAY_MS, Math.trunc(value)));
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
    const onMine =
      typeof options.onMine === "function"
        ? options.onMine
        : null;
    const onLookup =
      typeof options.onLookup === "function"
        ? options.onLookup
        : null;
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
    };
    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let debounceTimer = null;
    let lookupTimeoutTimer = null;
    let hideTimer = null;
    let pendingHideReason = "pointer-left";
    let destroyed = false;
    let shiftPressed = false;
    let pointerInPopup = false;
    let lastPointer = null;
    let requestSequence = 0;
    let latestRequestId = null;
    let latestCandidate = null;
    let latestGeneration = 0;
    let lastCandidateSignature = "";
    let popupVisible = false;
    let popupAnchor = null;
    let popupVertical = false;
    let miningInFlight = false;
    let miningStatusGeneration = 0;
    let miningStatusCache = null;
    let miningStatusCacheExpiresAt = 0;
    let miningStatusPromise = null;
    let shiftRequirementLogged = false;
    let candidateMissLogged = false;

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
        target.closest('.text-box[data-selectable="true"], #text')
      );
    }

    const popup = documentRef.createElement("section");
    popup.id = "gsm-hoshidicts-popup";
    popup.className = "gsm-hoshidicts-popup interactive";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Hoshidicts lookup");
    popup.hidden = true;
    popup.addEventListener("pointerdown", (event) => event.stopPropagation());
    popup.addEventListener("click", (event) => event.stopPropagation());
    documentRef.body.appendChild(popup);
    documentRef.documentElement.classList.add("gsm-hoshidicts-enabled");
    documentRef.documentElement.dataset.gsmHoshidictsEnabled = "true";
    const popupView = createPopupView({
      window: windowRef,
      document: documentRef,
      popup,
      appendExpressionRuby,
      appendTextOnlyGlossary,
      parseTagList,
      initialResultCount: INITIAL_VISIBLE_RESULTS,
      maxMetadataTags: MAX_VISIBLE_METADATA_TAGS,
      highlightName: SOURCE_HIGHLIGHT_NAME,
      positionPopup,
      onMineClick(button, result, candidate, feedback) {
        void mineResult(button, result, candidate, feedback);
      },
    });

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
      lastCandidateSignature = "";
      clearLookupTimeout();
      if (debounceTimer !== null) {
        clearTimeoutFn(debounceTimer);
        debounceTimer = null;
      }
    }

    function dismissPopup(reason) {
      clearHideTimer();
      miningStatusGeneration += 1;
      popupAnchor = null;
      popupView.clear();
      popup.hidden = true;
      publishPopupState(false);
      diagnostic("debug", "popup.hidden", { reason });
    }

    function hide(reason = "hide") {
      invalidateLookup();
      dismissPopup(reason);
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

    function positionPopup() {
      if (!popupVisible || !popupAnchor || !popupAnchor.isConnected) {
        if (popupVisible) {
          hide("anchor-removed");
        }
        return;
      }
      const anchorRect = popupAnchor.getBoundingClientRect();
      const measuredRect = popup.getBoundingClientRect();
      const popupSize = {
        width: measuredRect.width || Math.min(420, windowRef.innerWidth - 12),
        height: measuredRect.height || Math.min(420, windowRef.innerHeight * 0.6),
      };
      const position = calculatePopupPosition(
        anchorRect,
        popupSize,
        { width: windowRef.innerWidth, height: windowRef.innerHeight },
        { vertical: popupVertical }
      );
      popup.style.left = `${position.left}px`;
      popup.style.top = `${position.top}px`;
      popup.style.maxWidth = `${position.width}px`;
      popup.style.maxHeight = `${position.height}px`;
    }

    function showPopup(candidate) {
      clearHideTimer();
      popupAnchor = candidate.anchor;
      popupVertical = candidate.vertical;
      popup.hidden = false;
      popup.scrollTop = 0;
      publishPopupState(true);
      positionPopup();
    }

    function renderLookupNotice(candidate, message) {
      popupView.renderNotice(message);
      showPopup(candidate);
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

    async function refreshMiningButtons(buttons, feedback) {
      const generation = ++miningStatusGeneration;
      const status = await getCachedMiningStatus();
      if (destroyed || generation !== miningStatusGeneration || !feedback.isConnected) {
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
        popupView.setFeedback(
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
      popupView.setFeedback(feedback, `Anki mining unavailable: ${reason}`, "warning");
    }

    async function mineResult(button, result, candidate, feedback) {
      if (
        !onMine ||
        miningInFlight ||
        !["ready", "error"].includes(button.dataset.state)
      ) {
        return;
      }
      miningInFlight = true;
      popupView.setFeedback(feedback, "Adding note to Anki…");
      const buttons = Array.from(
        popup.querySelectorAll(".gsm-hoshidicts-mine-button")
      );
      for (const current of buttons) {
        setMiningButtonState(
          current,
          current === button ? "mining" : "checking"
        );
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
        popupView.setFeedback(
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
        popupView.setFeedback(
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

    function recordLookup(result) {
      if (!onLookup) {
        return;
      }
      const term = result.term.expression;
      const reading = result.term.reading;
      void Promise.resolve()
        .then(() => onLookup({ term, reading }))
        .catch((error) => {
          diagnostic("warn", "lookup.record-failed", {
            error: boundedString(
              error instanceof Error ? error.message : String(error),
              1024
            ),
          });
        });
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
      const requestId = latestRequestId;
      latestRequestId = null;
      if (!candidate) {
        diagnostic("warn", "lookup.missing-candidate", { requestId });
        hide("lookup-error");
        return;
      }
      if (payload.success !== true) {
        diagnostic("warn", "lookup.failed", {
          requestId,
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
        renderLookupNotice(candidate, message);
        return;
      }
      const results = normalizeLookupResults(payload);
      if (results.length === 0) {
        diagnostic("info", "lookup.empty", {
          requestId,
          dictionaryCount: Number.isFinite(payload.dictionaryCount)
            ? Math.trunc(payload.dictionaryCount)
            : null,
          query: candidate.query,
        });
        hide("no-results");
        return;
      }
      const rendered = popupView.renderResults(results, candidate);
      showPopup(candidate);
      recordLookup(results[0]);
      void refreshMiningButtons(rendered.miningButtons, rendered.feedback);
      diagnostic("info", "lookup.rendered", {
        requestId,
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
            sendLookup(latestCandidate, latestGeneration);
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
          latestRequestId = null;
          clearLookupTimeout();
          if (popupVisible) {
            dismissPopup("socket-closed");
          }
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

    function sendLookup(candidate, generation) {
      if (destroyed || generation !== latestGeneration) {
        return;
      }
      latestCandidate = candidate;
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
            "Dictionary lookup timed out. Check that the overlay service is running."
          );
          diagnostic("warn", "lookup.timed-out", {
            requestId,
            query: candidate.query,
          });
        }, lookupTimeoutMs);
      }
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
        diagnostic("debug", "lookup.waiting-for-socket", {
          query: candidate.query,
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
        query: candidate.query,
        matchOffset: candidate.matchOffset,
      });
    }

    function queueLookup(candidate) {
      const signature = [
        candidate.sentence,
        candidate.matchOffset,
        candidate.query,
      ].join("\u0000");
      clearHideTimer();
      if (signature === lastCandidateSignature) {
        return;
      }
      invalidateLookup();
      if (popupVisible) {
        dismissPopup("candidate-changed");
      }
      lastCandidateSignature = signature;
      latestCandidate = candidate;
      const generation = latestGeneration;
      debounceTimer = setTimeoutFn(() => {
        debounceTimer = null;
        sendLookup(candidate, generation);
      }, LOOKUP_DEBOUNCE_MS);
    }

    function scanPointer(pointer, modifierActive) {
      if (!pointer || !(pointer.target instanceof windowRef.Element)) {
        return;
      }
      if (popup.contains(pointer.target)) {
        pointerInPopup = true;
        clearHideTimer();
        return;
      }
      pointerInPopup = false;
      if (requiresShift() && !modifierActive) {
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
      const candidate = resolveLookupCandidate(
        windowRef,
        documentRef,
        pointer.target,
        pointer.clientX,
        pointer.clientY
      );
      if (candidate) {
        candidateMissLogged = false;
        queueLookup(candidate);
        return;
      }
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

    function onPopupPointerEnter() {
      pointerInPopup = true;
      clearHideTimer();
    }

    function onPopupPointerLeave() {
      pointerInPopup = false;
      scheduleHide("popup-left");
    }

    function updatePreferences(nextPreferences = {}) {
      const hadHideTimer = hideTimer !== null;
      const previousMode = preferences.lookupMode;
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
      };
      if (hadHideTimer) {
        clearHideTimer();
        scheduleHide(pendingHideReason);
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
      invalidateLookup();
      scheduleHide("window-blurred");
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
        socket.close();
        socket = null;
      }
      documentRef.removeEventListener("mousemove", onMouseMove, true);
      documentRef.removeEventListener("keydown", onKeyDown, true);
      documentRef.removeEventListener("keyup", onKeyUp, true);
      popup.removeEventListener("pointerenter", onPopupPointerEnter);
      popup.removeEventListener("pointerleave", onPopupPointerLeave);
      windowRef.removeEventListener("resize", positionPopup);
      windowRef.removeEventListener("scroll", positionPopup, true);
      windowRef.removeEventListener("blur", onWindowBlur);
      popup.remove();
      documentRef.documentElement.classList.remove("gsm-hoshidicts-enabled");
      delete documentRef.documentElement.dataset.gsmHoshidictsEnabled;
    }

    documentRef.addEventListener("mousemove", onMouseMove, true);
    documentRef.addEventListener("keydown", onKeyDown, true);
    documentRef.addEventListener("keyup", onKeyUp, true);
    popup.addEventListener("pointerenter", onPopupPointerEnter);
    popup.addEventListener("pointerleave", onPopupPointerLeave);
    windowRef.addEventListener("resize", positionPopup);
    windowRef.addEventListener("scroll", positionPopup, true);
    windowRef.addEventListener("blur", onWindowBlur);
    diagnostic("info", "reader.initialized", {
      serverUrl,
      requiresShift: requiresShift(),
      popupHideDelayMs: preferences.popupHideDelayMs,
      scanLength: LOOKUP_SCAN_LENGTH,
    });
    connect();

    return {
      destroy,
      hide,
      isVisible: () => popupVisible,
      getPopupElement: () => popup,
      getPreferences: () => ({ ...preferences }),
      positionPopup,
      updatePreferences,
    };
  }

  return {
    DEFAULT_POPUP_HIDE_DELAY_MS,
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
    createHoshidictsLookupStatsClient,
    createHoshidictsReader,
    normalizePopupHideDelay,
    normalizeLookupResults,
    resolveGsmApiBaseUrl,
    resolveLookupCandidate,
    segmentFurigana,
    setMiningButtonState,
  };
}));
