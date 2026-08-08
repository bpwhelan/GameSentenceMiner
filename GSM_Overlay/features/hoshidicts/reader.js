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
  const audioApi = root && root.GSMHoshidictsAudio;
  const api = factory(popupApi, audioApi);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsReader = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function (popupApi, audioApi) {
  "use strict";

  if (!popupApi || typeof popupApi.createPopupView !== "function") {
    throw new Error("Hoshidicts popup support must load before the reader.");
  }
  if (!audioApi || typeof audioApi.createHoshidictsAudioController !== "function") {
    throw new Error("Hoshidicts audio support must load before the reader.");
  }
  const { createPopupView, setMiningButtonState } = popupApi;
  const {
    canonicalizeAudioTerm,
    createHoshidictsAudioClient,
    createHoshidictsAudioController,
    normalizeLocalHttpBaseUrl,
    normalizeAudioProfile,
  } = audioApi;

  const LOOKUP_DEBOUNCE_MS = 20;
  const LOOKUP_REQUEST_TIMEOUT_MS = 4 * 1000;
  const LOOKUP_SCAN_LENGTH = 10;
  const LOOKUP_MAX_RESULTS = 16;
  const INITIAL_VISIBLE_RESULTS = 6;
  const DEFAULT_POPUP_HIDE_DELAY_MS = 300;
  const DEFAULT_ACTIVATION_KEY = "Shift";
  const DEFAULT_SOURCE_HIGHLIGHT_ENABLED = false;
  const MAX_POPUP_HIDE_DELAY_MS = 5 * 1000;
  const MAX_RESPONSE_BYTES = 256 * 1024;
  const MAX_MEDIA_RESPONSE_BYTES = 6 * 1024 * 1024;
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
  const MAX_MEDIA_DIMENSION = 4096;
  const MAX_MEDIA_PIXELS = 16 * 1024 * 1024;
  const MAX_MEDIA_CACHE_BYTES = 16 * 1024 * 1024;
  const MAX_MEDIA_CACHE_ENTRIES = 64;
  const MAX_MEDIA_CONCURRENT_REQUESTS = 4;
  const MAX_MEDIA_PENDING_REQUESTS = 128;
  const MAX_POPUP_MEDIA_IMAGES = 128;
  const MAX_POPUP_MEDIA_PIXELS = 32 * 1024 * 1024;
  const MEDIA_REQUEST_TIMEOUT_MS = 4 * 1000;
  const MAX_MEDIA_DISPLAY_SIZE = 1024;
  const MAX_GLOSSARIES = 64;
  const MAX_TRACE_STEPS = 32;
  const MAX_METADATA_GROUPS = 64;
  const MAX_METADATA_VALUES = 64;
  const MAX_TEXT_LENGTH = 128 * 1024;
  const MAX_MINING_REQUEST_BYTES = 256 * 1024;
  const MINING_REQUEST_TIMEOUT_MS = 90 * 1000;
  const MAX_STRUCTURED_DEPTH = 24;
  const MAX_STRUCTURED_NODES = 4096;
  const RECONNECT_INITIAL_DELAY_MS = 750;
  const RECONNECT_MAX_DELAY_MS = 12 * 1000;
  const MINING_STATUS_CACHE_MS = 5 * 1000;
  const MAX_VISIBLE_METADATA_TAGS = 12;
  const SOURCE_HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const JAPANESE_TEXT_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
  const HAN_CHARACTER_PATTERN =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
  const KANJI_SEGMENT_PATTERN =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\u3005]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\u3005]+/gu;
  const KANA_PATTERN = /[\u3040-\u30ff\uff66-\uff9f]/u;
  const ALLOWED_STRUCTURED_TAGS = new Set([
    "br",
    "code",
    "details",
    "div",
    "em",
    "img",
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
    "summary",
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
    "audio",
    "button",
    "canvas",
    "iframe",
    "input",
    "script",
    "source",
    "style",
    "svg",
    "video",
  ]);
  const STRUCTURED_TAGS_WITHOUT_CONTENT = new Set(["br", "img"]);
  const ALLOWED_MEDIA_TYPES = new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  const STRUCTURED_STYLE_PROPERTIES = new Map([
    ["background", ["background", "color"]],
    ["borderColor", ["border-color", "color"]],
    ["borderRadius", ["border-radius", "length-sequence"]],
    ["borderStyle", ["border-style", "border-style"]],
    ["borderWidth", ["border-width", "length-sequence"]],
    ["color", ["color", "color"]],
    ["fontSize", ["font-size", "length"]],
    ["fontStyle", ["font-style", "font-style"]],
    ["fontWeight", ["font-weight", "font-weight"]],
    ["marginBottom", ["margin-bottom", "signed-length"]],
    ["marginTop", ["margin-top", "signed-length"]],
    ["padding", ["padding", "length-sequence"]],
    ["paddingLeft", ["padding-left", "length"]],
  ]);
  const NAMED_ACTIVATION_KEYS = new Map([
    ["ctrl", "Ctrl"],
    ["alt", "Alt"],
    ["shift", "Shift"],
    ["cmd", "Cmd"],
    ["space", "Space"],
    ["return", "Return"],
    ["escape", "Escape"],
    ["backspace", "Backspace"],
    ["delete", "Delete"],
    ["tab", "Tab"],
    ["up", "Up"],
    ["down", "Down"],
    ["left", "Left"],
    ["right", "Right"],
    ["home", "Home"],
    ["end", "End"],
    ["pageup", "PageUp"],
    ["pagedown", "PageDown"],
    ["insert", "Insert"],
  ]);
  const PUNCTUATION_ACTIVATION_KEYS = new Set([
    "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`",
  ]);

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function boundedString(value, maxLength = MAX_TEXT_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function normalizeActivationKey(value, fallback = DEFAULT_ACTIVATION_KEY) {
    if (typeof value !== "string") {
      return fallback;
    }
    const token = value.trim();
    if (PUNCTUATION_ACTIVATION_KEYS.has(token)) {
      return token;
    }
    if (/^[a-z]$/iu.test(token)) {
      return token.toUpperCase();
    }
    if (/^[0-9]$/u.test(token)) {
      return token;
    }
    const functionKeyMatch = /^f([1-9]|1[0-9]|2[0-4])$/iu.exec(token);
    if (functionKeyMatch) {
      return `F${functionKeyMatch[1]}`;
    }
    return NAMED_ACTIVATION_KEYS.get(token.toLowerCase()) ?? fallback;
  }

  function normalizeLookupResults(payload) {
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.results)) {
      return [];
    }

    let glossaryCount = 0;
    return payload.results.slice(0, LOOKUP_MAX_RESULTS).map((rawResult) => {
      const result = isRecord(rawResult) ? rawResult : {};
      const rawTerm = isRecord(result.term) ? result.term : {};
      const canonicalTerm = canonicalizeAudioTerm(rawTerm);
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
                          ? frequency.value
                          : null,
                        displayValue: typeof frequency.displayValue === "string"
                          ? frequency.displayValue.slice(0, 4096)
                          : null,
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
          expression: canonicalTerm.expression,
          reading: canonicalTerm.reading,
          rules: boundedString(rawTerm.rules, 4096),
          score: Number.isFinite(rawTerm.score) ? Math.trunc(rawTerm.score) : 0,
          glossaries,
          frequencies,
          pitches,
        },
      };
    }).filter((result) => result.term.expression.length > 0);
  }

  function normalizeKanjiLookup(payload) {
    if (!isRecord(payload) || payload.success !== true || !isRecord(payload.kanji)) {
      return null;
    }
    const character = Array.from(boundedString(payload.kanji.character, 16))[0] || "";
    if (!HAN_CHARACTER_PATTERN.test(character)) {
      return null;
    }
    const entries = Array.isArray(payload.kanji.entries)
      ? payload.kanji.entries.slice(0, 64).map((rawEntry) => {
          const entry = isRecord(rawEntry) ? rawEntry : {};
          const readings = (value) => parseTagList(boundedString(value, 4096));
          return {
            dictionary: boundedString(entry.dictionary, 4096) || "Dictionary",
            onyomi: readings(entry.onyomi),
            kunyomi: readings(entry.kunyomi),
            tags: readings(entry.tags),
            definitions: Array.isArray(entry.definitions)
              ? entry.definitions.slice(0, 64)
                  .map((value) => boundedString(value))
                  .filter(Boolean)
              : [],
            stats: Array.isArray(entry.stats)
              ? entry.stats.slice(0, 128).map((rawStat) => {
                  const stat = isRecord(rawStat) ? rawStat : {};
                  return {
                    name: boundedString(stat.name, 4096),
                    value: boundedString(stat.value, 4096),
                  };
                }).filter((stat) => stat.name && stat.value)
                .sort((left, right) => left.name.localeCompare(right.name))
              : [],
          };
        })
      : [];
    return entries.length > 0 ? { character, entries } : null;
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

  function appendExpressionRuby(documentRef, parent, expression, reading, onKanjiClick) {
    const appendText = (target, text) => {
      for (const character of Array.from(text)) {
        if (!HAN_CHARACTER_PATTERN.test(character) || typeof onKanjiClick !== "function") {
          target.appendChild(documentRef.createTextNode(character));
          continue;
        }
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className = "gsm-hoshidicts-kanji-link";
        button.textContent = character;
        button.setAttribute("aria-label", `Look up kanji ${character}`);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onKanjiClick(character);
        });
        target.appendChild(button);
      }
    };
    for (const segment of segmentFurigana(expression, reading)) {
      if (!segment.reading) {
        appendText(parent, segment.text);
        continue;
      }
      const ruby = documentRef.createElement("ruby");
      appendText(ruby, segment.text);
      const rt = documentRef.createElement("rt");
      rt.textContent = segment.reading;
      ruby.appendChild(rt);
      parent.appendChild(ruby);
    }
  }

  function parseTagList(value) {
    return String(value || "").split(/\s+/u).filter(Boolean);
  }

  function isSafeCssToken(value) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 128 &&
      !/[\u0000-\u001f\u007f;{}]/u.test(value) &&
      !/(?:url|expression|var)\s*\(/iu.test(value)
    );
  }

  function normalizeColor(value) {
    if (!isSafeCssToken(value)) {
      return null;
    }
    const trimmed = value.trim();
    if (
      /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(trimmed) ||
      /^(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s/]+\)$/iu.test(trimmed) ||
      /^(?:[a-z]+|currentColor|transparent)$/iu.test(trimmed)
    ) {
      return trimmed;
    }
    return null;
  }

  function normalizeLengthToken(value, allowNegative = false) {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > 256 || (!allowNegative && value < 0)) {
        return null;
      }
      return `${value}px`;
    }
    if (!isSafeCssToken(value)) {
      return null;
    }
    const trimmed = value.trim();
    const match = /^(-?(?:0|[0-9]+(?:\.[0-9]+)?))(px|em|rem|%)?$/u.exec(trimmed);
    if (!match) {
      return null;
    }
    const amount = Number(match[1]);
    const unit = match[2] || (amount === 0 ? "" : "px");
    const limit = unit === "em" || unit === "rem"
      ? 16
      : unit === "%"
        ? 100
        : 256;
    if (!Number.isFinite(amount) || Math.abs(amount) > limit || (!allowNegative && amount < 0)) {
      return null;
    }
    return `${match[1]}${unit}`;
  }

  function normalizeLengthSequence(value) {
    if (typeof value === "number") {
      return normalizeLengthToken(value);
    }
    if (!isSafeCssToken(value)) {
      return null;
    }
    const tokens = value.trim().split(/\s+/u);
    if (tokens.length < 1 || tokens.length > 4) {
      return null;
    }
    const normalized = tokens.map((token) => normalizeLengthToken(token));
    return normalized.every((token) => token !== null) ? normalized.join(" ") : null;
  }

  function normalizeStructuredStyleValue(kind, value) {
    if (kind === "color") {
      return normalizeColor(value);
    }
    if (kind === "length") {
      return normalizeLengthToken(value);
    }
    if (kind === "signed-length") {
      return normalizeLengthToken(value, true);
    }
    if (kind === "length-sequence") {
      return normalizeLengthSequence(value);
    }
    if (kind === "border-style") {
      return typeof value === "string" &&
        /^(?:none|hidden|dotted|dashed|solid|double)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "font-style") {
      return typeof value === "string" && /^(?:normal|italic)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "font-weight") {
      if (
        typeof value === "string" &&
        /^(?:normal|bold|bolder|lighter|[1-9]00)$/u.test(value)
      ) {
        return value;
      }
      if (Number.isInteger(value) && value >= 100 && value <= 900 && value % 100 === 0) {
        return String(value);
      }
    }
    return null;
  }

  function applyStructuredStyle(element, rawStyle) {
    if (!isRecord(rawStyle)) {
      return;
    }
    for (const [property, value] of Object.entries(rawStyle)) {
      const definition = STRUCTURED_STYLE_PROPERTIES.get(property);
      if (!definition) {
        continue;
      }
      const [cssProperty, kind] = definition;
      const normalized = normalizeStructuredStyleValue(kind, value);
      if (normalized !== null) {
        element.style.setProperty(cssProperty, normalized);
      }
    }
  }

  function normalizeMediaPath(value) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 4096 ||
      /[\\\u0000-\u001f\u007f]/u.test(value) ||
      value.startsWith("/") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    ) {
      return null;
    }
    const components = value.split("/");
    return components.some((component) => !component || component === "." || component === "..")
      ? null
      : value;
  }

  function appendStructuredImage(documentRef, parent, value, state) {
    const path = normalizeMediaPath(value.path);
    if (!path || typeof state.resolveMedia !== "function") {
      return;
    }
    const image = documentRef.createElement("img");
    image.className = "gsm-hoshidicts-structured-image";
    image.alt = isRecord(value.data) && typeof value.data.alt === "string"
      ? value.data.alt.slice(0, 1024)
      : typeof value.alt === "string"
        ? value.alt.slice(0, 1024)
        : "";
    image.decoding = "async";
    image.draggable = false;
    const units = typeof value.sizeUnits === "string" ? value.sizeUnits : "px";
    if (units === "px") {
      for (const property of ["width", "height"]) {
        const size = Number(value[property]);
        if (Number.isFinite(size) && size > 0) {
          image.style.setProperty(
            property,
            `${Math.max(1, Math.min(MAX_MEDIA_DISPLAY_SIZE, Math.round(size)))}px`
          );
        }
      }
    }
    const onLayoutChange = typeof state.onLayoutChange === "function"
      ? state.onLayoutChange
      : () => {};
    image.addEventListener("load", onLayoutChange);
    image.addEventListener("error", () => {
      image.hidden = true;
      onLayoutChange();
    });
    parent.appendChild(image);
    let mediaPromise;
    try {
      mediaPromise = Promise.resolve(state.resolveMedia({ path }));
    } catch (error) {
      mediaPromise = Promise.reject(error);
    }
    mediaPromise.then((url) => {
      if (image.isConnected && typeof url === "string" && url.startsWith("blob:")) {
        image.src = url;
      }
    }).catch(() => {
      image.hidden = true;
      onLayoutChange();
    });
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

    if (value.type === "structured-content") {
      appendStructuredValue(documentRef, parent, value.content, state, depth + 1);
      return;
    }
    if (value.type === "text") {
      appendStructuredValue(
        documentRef,
        parent,
        Object.prototype.hasOwnProperty.call(value, "text") ? value.text : value.content,
        state,
        depth + 1
      );
      return;
    }
    if (value.type === "image") {
      value = { ...value, tag: "img" };
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

    if (tag === "img") {
      state.nodes += 1;
      appendStructuredImage(documentRef, parent, value, state);
      return;
    }

    const element = documentRef.createElement(tag);
    state.nodes += 1;
    applyStructuredStyle(element, value.style);
    if (
      isRecord(value.data) &&
      typeof value.data.id === "string" &&
      value.data.id.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(value.data.id)
    ) {
      element.dataset.scId = value.data.id;
    }
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
    if (tag === "details" && typeof state.onLayoutChange === "function") {
      element.addEventListener("toggle", state.onLayoutChange);
    }
    if (
      !STRUCTURED_TAGS_WITHOUT_CONTENT.has(tag) &&
      Object.prototype.hasOwnProperty.call(value, "content")
    ) {
      appendStructuredValue(documentRef, element, value.content, state, depth + 1);
    }
    parent.appendChild(element);
  }

  function appendTextOnlyGlossary(documentRef, parent, rawGlossary, options = {}) {
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
      {
        nodes: 0,
        onLayoutChange: options.onLayoutChange,
        resolveMedia: typeof options.resolveMedia === "function"
          ? ({ path }) => options.resolveMedia({
              dictionary: options.dictionary,
              generation: options.generation,
              path,
            })
          : null,
      },
      0
    );
  }

  function normalizeDictionaryGeneration(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function mediaTypeMatchesSignature(mediaType, bytes) {
    if (!(bytes instanceof Uint8Array)) {
      return false;
    }
    if (mediaType === "image/jpeg") {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mediaType === "image/png") {
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      return bytes.length >= signature.length && signature.every(
        (value, index) => bytes[index] === value
      );
    }
    if (mediaType === "image/gif") {
      if (bytes.length < 6) {
        return false;
      }
      const header = String.fromCharCode(...bytes.slice(0, 6));
      return header === "GIF87a" || header === "GIF89a";
    }
    return mediaType === "image/webp" &&
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  }

  function validateMediaPayloadMetadata(payload) {
    const mediaType = typeof payload.mediaType === "string"
      ? payload.mediaType.toLowerCase()
      : "";
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      throw new Error("unsupported_media_type");
    }
    const byteLength = Number(payload.byteLength);
    const width = Number(payload.width);
    const height = Number(payload.height);
    const encoded = payload.dataBase64;
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > MAX_MEDIA_BYTES ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      width > MAX_MEDIA_DIMENSION ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      height > MAX_MEDIA_DIMENSION ||
      width * height > MAX_MEDIA_PIXELS ||
      typeof encoded !== "string" ||
      encoded.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
    ) {
      throw new Error("invalid_media_payload");
    }
    return { byteLength, encoded, height, mediaType, pixelCount: width * height, width };
  }

  function decodeMediaPayload(windowRef, metadata) {
    const { byteLength, encoded, height, mediaType, pixelCount, width } = metadata;
    let decoded;
    try {
      decoded = windowRef.atob(encoded);
    } catch {
      throw new Error("invalid_media_payload");
    }
    if (decoded.length !== byteLength) {
      throw new Error("invalid_media_payload");
    }
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    if (!mediaTypeMatchesSignature(mediaType, bytes)) {
      throw new Error("invalid_media_signature");
    }
    return { bytes, byteLength, height, mediaType, pixelCount, width };
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
    const apiToken = boundedString(options.apiToken, 64).trim();
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
      if (!/^[a-f0-9]{64}$/.test(apiToken)) {
        throw new Error("GSM mining authentication is unavailable.");
      }
      const controller =
        typeof AbortController === "function" ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers: {
            ...(isRecord(init.headers) ? init.headers : {}),
            "Authorization": `Bearer ${apiToken}`,
          },
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
    const onAddCustomEntry =
      typeof options.onAddCustomEntry === "function"
        ? options.onAddCustomEntry
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
    const mediaRequestTimeoutMs =
      Number.isFinite(options.mediaRequestTimeoutMs) && options.mediaRequestTimeoutMs > 0
        ? Math.trunc(options.mediaRequestTimeoutMs)
        : MEDIA_REQUEST_TIMEOUT_MS;
    const mediaCacheMaxEntries =
      Number.isInteger(options.mediaCacheMaxEntries) && options.mediaCacheMaxEntries > 0
        ? options.mediaCacheMaxEntries
        : MAX_MEDIA_CACHE_ENTRIES;
    const mediaCacheMaxBytes =
      Number.isInteger(options.mediaCacheMaxBytes) && options.mediaCacheMaxBytes > 0
        ? options.mediaCacheMaxBytes
        : MAX_MEDIA_CACHE_BYTES;
    const BlobImpl = options.Blob || windowRef.Blob;
    const createObjectURL = typeof options.createObjectURL === "function"
      ? options.createObjectURL
      : windowRef.URL && typeof windowRef.URL.createObjectURL === "function"
        ? windowRef.URL.createObjectURL.bind(windowRef.URL)
        : null;
    const revokeObjectURL = typeof options.revokeObjectURL === "function"
      ? options.revokeObjectURL
      : windowRef.URL && typeof windowRef.URL.revokeObjectURL === "function"
        ? windowRef.URL.revokeObjectURL.bind(windowRef.URL)
        : () => {};

    let preferences = {
      lookupMode: options.lookupMode === "hover" ? "hover" : "shift",
      activationKey: normalizeActivationKey(options.activationKey),
      sourceHighlightEnabled: options.sourceHighlightEnabled === true,
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
    let localShiftPressed = false;
    let globalActivationKeyPressed = options.activationKeyPressed === true;
    let pointerInPopup = false;
    let lastPointer = null;
    let requestSequence = 0;
    let latestRequestId = null;
    let latestCandidate = null;
    let latestGeneration = 0;
    let latestRequestMode = "term-first";
    let latestRequestText = "";
    let cachedTermView = null;
    let activeDictionaryGeneration = null;
    let mediaRequestSequence = 0;
    let activeMediaRequestCount = 0;
    let mediaCacheBytes = 0;
    let popupMediaPixels = 0;
    const mediaCache = new Map();
    const mediaInFlight = new Map();
    const mediaPendingByRequestId = new Map();
    const popupMediaKeys = new Map();
    let mediaQueue = [];
    let lastCandidateSignature = "";
    let popupVisible = false;
    let popupAnchor = null;
    let popupVertical = false;
    let noteEditing = false;
    let miningInFlight = false;
    let miningStatusGeneration = 0;
    let miningStatusCache = null;
    let miningStatusCacheExpiresAt = 0;
    let miningStatusPromise = null;
    let activationRequirementLogged = false;
    let candidateMissLogged = false;
    let audioController = null;

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

    function requiresActivationKey() {
      return preferences.lookupMode === "shift";
    }

    function isActivationKeyPressed(mouseShiftPressed = false) {
      return (
        globalActivationKeyPressed ||
        (
          preferences.activationKey === DEFAULT_ACTIVATION_KEY &&
          (localShiftPressed || mouseShiftPressed)
        )
      );
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
      sourceHighlightEnabled: preferences.sourceHighlightEnabled,
      positionPopup,
      onMineClick(button, result, candidate, feedback) {
        void mineResult(button, result, candidate, feedback);
      },
      onKanjiClick(character, _result, candidate) {
        requestKanji(character, candidate);
      },
      onAddCustomEntry(entry) {
        return addCustomEntryAndRefresh(entry);
      },
      onNoteEditingChange(editing) {
        noteEditing = editing;
        clearHideTimer();
      },
      onResultsRendered({ audioItems, feedback, miningButtons }) {
        for (const button of miningButtons) {
          button.hidden = true;
        }
        audioController.setRenderedResults(audioItems);
        void refreshMiningButtons(miningButtons, feedback);
      },
    });
    audioController = options.audioController || createHoshidictsAudioController({
      window: windowRef,
      document: documentRef,
      client: options.audioClient || null,
      audioPreferences: options.audioPreferences || options.audioProfile,
      logger,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
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

    function mediaCacheKey(generation, dictionary, path) {
      return JSON.stringify([generation, dictionary, path]);
    }

    function revokeCachedMedia(entry) {
      try {
        revokeObjectURL(entry.url);
      } catch {
        // Blob URL cleanup is best-effort across Electron versions.
      }
    }

    function clearMediaCache() {
      for (const entry of mediaCache.values()) {
        revokeCachedMedia(entry);
      }
      mediaCache.clear();
      mediaCacheBytes = 0;
    }

    function rejectMediaJob(job, error) {
      if (job.settled) {
        return;
      }
      job.settled = true;
      if (job.timeoutTimer !== null) {
        clearTimeoutFn(job.timeoutTimer);
        job.timeoutTimer = null;
      }
      if (job.requestId !== null) {
        mediaPendingByRequestId.delete(job.requestId);
      }
      mediaInFlight.delete(job.key);
      if (job.active) {
        activeMediaRequestCount = Math.max(0, activeMediaRequestCount - 1);
      }
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }

    function cancelMediaRequests(reason) {
      const jobs = [...mediaInFlight.values()];
      mediaQueue = [];
      for (const job of jobs) {
        rejectMediaJob(job, new Error(reason));
      }
      mediaPendingByRequestId.clear();
      activeMediaRequestCount = 0;
    }

    function clearMediaState(reason) {
      cancelMediaRequests(reason);
      clearMediaCache();
    }

    function resetPopupMediaBudget() {
      popupMediaKeys.clear();
      popupMediaPixels = 0;
    }

    function preparePopupContent(reason) {
      cancelMediaRequests(reason);
      resetPopupMediaBudget();
    }

    function reservePopupMedia(key, pixelCount) {
      if (popupMediaKeys.has(key)) {
        return true;
      }
      if (
        popupMediaKeys.size >= MAX_POPUP_MEDIA_IMAGES ||
        popupMediaPixels + pixelCount > MAX_POPUP_MEDIA_PIXELS
      ) {
        return false;
      }
      popupMediaKeys.set(key, pixelCount);
      popupMediaPixels += pixelCount;
      return true;
    }

    function isPopupMediaBudgetFull() {
      return (
        popupMediaKeys.size >= MAX_POPUP_MEDIA_IMAGES ||
        popupMediaPixels >= MAX_POPUP_MEDIA_PIXELS
      );
    }

    function releasePopupMedia(key) {
      const pixelCount = popupMediaKeys.get(key);
      if (pixelCount === undefined) {
        return;
      }
      popupMediaKeys.delete(key);
      popupMediaPixels = Math.max(0, popupMediaPixels - pixelCount);
    }

    function updateDictionaryGeneration(generation) {
      if (activeDictionaryGeneration === generation) {
        return;
      }
      clearMediaState("dictionary_generation_changed");
      activeDictionaryGeneration = generation;
    }

    function cacheMedia(job, url, byteLength, pixelCount) {
      const existing = mediaCache.get(job.key);
      if (existing) {
        mediaCacheBytes -= existing.byteLength;
        revokeCachedMedia(existing);
        mediaCache.delete(job.key);
      }
      const entry = { byteLength, pixelCount, url };
      mediaCache.set(job.key, entry);
      mediaCacheBytes += byteLength;
      while (
        mediaCache.size > mediaCacheMaxEntries ||
        mediaCacheBytes > mediaCacheMaxBytes
      ) {
        const oldestKey = mediaCache.keys().next().value;
        const oldest = mediaCache.get(oldestKey);
        mediaCache.delete(oldestKey);
        mediaCacheBytes -= oldest.byteLength;
        revokeCachedMedia(oldest);
      }
    }

    function resolveMediaJob(job, url, byteLength, pixelCount) {
      if (job.settled) {
        return;
      }
      job.settled = true;
      if (job.timeoutTimer !== null) {
        clearTimeoutFn(job.timeoutTimer);
        job.timeoutTimer = null;
      }
      mediaPendingByRequestId.delete(job.requestId);
      mediaInFlight.delete(job.key);
      activeMediaRequestCount = Math.max(0, activeMediaRequestCount - 1);
      cacheMedia(job, url, byteLength, pixelCount);
      job.resolve(url);
    }

    function pumpMediaQueue() {
      while (
        mediaQueue.length > 0 &&
        activeMediaRequestCount < MAX_MEDIA_CONCURRENT_REQUESTS
      ) {
        const job = mediaQueue.shift();
        if (
          destroyed ||
          job.generation !== activeDictionaryGeneration ||
          !socket ||
          socket.readyState !== WebSocketImpl.OPEN
        ) {
          rejectMediaJob(job, new Error("media_unavailable"));
          continue;
        }
        job.active = true;
        activeMediaRequestCount += 1;
        job.requestId = `overlay-media-${++mediaRequestSequence}`;
        mediaPendingByRequestId.set(job.requestId, job);
        job.timeoutTimer = setTimeoutFn(() => {
          rejectMediaJob(job, new Error("media_request_timed_out"));
          pumpMediaQueue();
        }, mediaRequestTimeoutMs);
        try {
          socket.send(JSON.stringify({
            type: "hoshidicts_media",
            requestId: job.requestId,
            generation: job.generation,
            dictionary: job.dictionary,
            path: job.path,
          }));
        } catch {
          rejectMediaJob(job, new Error("media_send_failed"));
        }
      }
    }

    function resolveMedia({ dictionary, generation, path }) {
      const normalizedGeneration = normalizeDictionaryGeneration(generation);
      const normalizedPath = normalizeMediaPath(path);
      if (
        normalizedGeneration === null ||
        normalizedGeneration !== activeDictionaryGeneration ||
        typeof dictionary !== "string" ||
        dictionary.length < 1 ||
        dictionary.length > 1024 ||
        /[\u0000-\u001f\u007f]/u.test(dictionary) ||
        !normalizedPath ||
        !BlobImpl ||
        !createObjectURL
      ) {
        return Promise.reject(new Error("invalid_media_reference"));
      }
      const key = mediaCacheKey(normalizedGeneration, dictionary, normalizedPath);
      const cached = mediaCache.get(key);
      if (cached) {
        if (!reservePopupMedia(key, cached.pixelCount)) {
          cancelMediaRequests("media_pixel_budget_exceeded");
          return Promise.reject(new Error("media_pixel_budget_exceeded"));
        }
        mediaCache.delete(key);
        mediaCache.set(key, cached);
        if (isPopupMediaBudgetFull()) {
          cancelMediaRequests("media_pixel_budget_exhausted");
        }
        return Promise.resolve(cached.url);
      }
      if (isPopupMediaBudgetFull()) {
        return Promise.reject(new Error("media_pixel_budget_exhausted"));
      }
      const inFlight = mediaInFlight.get(key);
      if (inFlight) {
        return inFlight.promise;
      }
      if (mediaInFlight.size >= MAX_MEDIA_PENDING_REQUESTS) {
        return Promise.reject(new Error("media_queue_full"));
      }
      const job = {
        active: false,
        dictionary,
        generation: normalizedGeneration,
        key,
        path: normalizedPath,
        requestId: null,
        settled: false,
        timeoutTimer: null,
      };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      mediaInFlight.set(key, job);
      mediaQueue.push(job);
      pumpMediaQueue();
      return job.promise;
    }

    function invalidateLookup() {
      latestGeneration += 1;
      latestRequestId = null;
      latestCandidate = null;
      latestRequestMode = "term-first";
      latestRequestText = "";
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
      cachedTermView = null;
      popupAnchor = null;
      audioController.dismissPopup();
      preparePopupContent("popup_dismissed");
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
      if (noteEditing || pointerInPopup || !popupVisible) {
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
      preparePopupContent("lookup_notice");
      popupView.renderNotice(message, candidate);
      showPopup(candidate);
    }

    function renderTermResults(results, candidate, dictionaryGeneration) {
      preparePopupContent("lookup_results");
      cachedTermView = {
        results,
        candidate,
        dictionaryGeneration,
        highlightText: results[0].matched || results[0].term.expression,
      };
      const rendered = popupView.renderResults(results, candidate, {
        generation: dictionaryGeneration,
        resolveMedia: dictionaryGeneration === null ? null : resolveMedia,
      });
      for (const button of rendered.miningButtons) {
        button.hidden = true;
      }
      showPopup(candidate);
      audioController.setRenderedResults(rendered.audioItems);
      void refreshMiningButtons(rendered.miningButtons, rendered.feedback);
    }

    function restoreTermView() {
      if (!cachedTermView) return;
      const { results, candidate, dictionaryGeneration } = cachedTermView;
      latestCandidate = candidate;
      latestRequestMode = "term-first";
      latestRequestText = candidate.query;
      preparePopupContent("restore_term_results");
      const rendered = popupView.renderResults(results, candidate, {
        generation: dictionaryGeneration,
        resolveMedia: dictionaryGeneration === null ? null : resolveMedia,
      });
      for (const button of rendered.miningButtons) {
        button.hidden = true;
      }
      showPopup(candidate);
      audioController.setRenderedResults(rendered.audioItems);
      void refreshMiningButtons(rendered.miningButtons, rendered.feedback);
    }

    function requestKanji(character, candidate) {
      const kanji = Array.from(String(character || ""))[0] || "";
      if (!HAN_CHARACTER_PATTERN.test(kanji)) return;
      clearLookupTimeout();
      sendLookup(candidate, latestGeneration, "kanji", kanji);
    }

    async function addCustomEntryAndRefresh(entry) {
      if (!onAddCustomEntry) {
        throw new Error("The custom dictionary is unavailable.");
      }
      const response = await onAddCustomEntry(entry);
      repeatCurrentLookup();
      return response;
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
          setMiningButtonState(
            button,
            miningInFlight ? "checking" : "ready",
            miningInFlight ? "Another note is being added" : ""
          );
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
      // Match Yomitan's quiet unavailable state: dictionary results remain the
      // focus, with no setup warning or inert mining affordance. Errors from a
      // real mining attempt still flow through mineResult below.
      popupView.setFeedback(feedback, "");
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
        const audioSelection = audioController.getSelection(result);
        const response = await onMine({
          result,
          sentence: candidate.sentence,
          matchOffset: candidate.matchOffset,
          ...(audioSelection ? { audioSelection } : {}),
        });
        if (!response || response.success !== true) {
          throw new Error(
            response && typeof response.error === "string"
              ? response.error
              : "Could not add the note."
          );
        }
        setMiningButtonState(button, "success");
        const audioOutcome = isRecord(response.audio) ? response.audio : null;
        const audioFailed = audioOutcome &&
          ["unavailable", "failed"].includes(audioOutcome.status);
        const unmapped = Array.isArray(response.unmappedFields)
          ? response.unmappedFields.filter((field) => typeof field === "string")
          : [];
        const visibleUnmapped = audioFailed
          ? unmapped.filter((field) => field !== "audio")
          : unmapped;
        const feedbackParts = ["Added to Anki."];
        if (visibleUnmapped.length > 0) {
          feedbackParts.push(
            `Optional fields not filled: ${visibleUnmapped.join(", ")}.`
          );
        }
        if (audioFailed) {
          feedbackParts.push(
            boundedString(audioOutcome.warning, 1024).trim() ||
              "Pronunciation audio could not be added."
          );
        }
        popupView.setFeedback(
          feedback,
          feedbackParts.join(" "),
          visibleUnmapped.length > 0 || audioFailed ? "warning" : "success"
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
        const liveButtons = Array.from(
          popup.querySelectorAll(".gsm-hoshidicts-mine-button")
        );
        for (const current of liveButtons) {
          if (current !== button && current.isConnected) {
            setMiningButtonState(current, "ready");
          }
        }
      }
    }

    function handleMediaResponse(payload) {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
      const job = mediaPendingByRequestId.get(requestId);
      if (!job) {
        return;
      }
      const matchesRequest =
        payload.generation === job.generation &&
        payload.dictionary === job.dictionary &&
        payload.path === job.path;
      if (!matchesRequest) {
        rejectMediaJob(job, new Error("invalid_media_response"));
        pumpMediaQueue();
        return;
      }
      if (payload.success !== true) {
        const invalidateMediaState =
          payload.staleGeneration === true || payload.featureDisabled === true;
        rejectMediaJob(
          job,
          new Error(payload.staleGeneration === true
            ? "stale_generation"
            : payload.featureDisabled === true
              ? "feature_disabled"
            : boundedString(payload.error, 256) || "media_lookup_failed")
        );
        if (invalidateMediaState) {
          clearMediaState(
            payload.staleGeneration === true ? "stale_generation" : "feature_disabled"
          );
          activeDictionaryGeneration = null;
        } else {
          pumpMediaQueue();
        }
        return;
      }
      let metadata;
      try {
        metadata = validateMediaPayloadMetadata(payload);
      } catch (error) {
        rejectMediaJob(job, error);
        pumpMediaQueue();
        return;
      }
      const alreadyReserved = popupMediaKeys.has(job.key);
      if (!reservePopupMedia(job.key, metadata.pixelCount)) {
        rejectMediaJob(job, new Error("media_pixel_budget_exceeded"));
        cancelMediaRequests("media_pixel_budget_exceeded");
        return;
      }
      let media;
      let url;
      try {
        media = decodeMediaPayload(windowRef, metadata);
        const blob = new BlobImpl([media.bytes], { type: media.mediaType });
        url = createObjectURL(blob);
        if (typeof url !== "string" || !url.startsWith("blob:")) {
          throw new Error("invalid_blob_url");
        }
      } catch (error) {
        if (!alreadyReserved) {
          releasePopupMedia(job.key);
        }
        rejectMediaJob(job, error);
        pumpMediaQueue();
        return;
      }
      resolveMediaJob(job, url, media.byteLength, media.pixelCount);
      if (isPopupMediaBudgetFull()) {
        cancelMediaRequests("media_pixel_budget_exhausted");
      } else {
        pumpMediaQueue();
      }
    }

    function handleLookupResponse(rawData) {
      const serialized = typeof rawData === "string"
        ? rawData
        : rawData instanceof windowRef.ArrayBuffer
          ? new windowRef.TextDecoder().decode(rawData)
          : String(rawData);
      if (serialized.length > MAX_MEDIA_RESPONSE_BYTES) {
        diagnostic("warn", "response.too-large", {
          bytes: serialized.length,
          maxBytes: MAX_MEDIA_RESPONSE_BYTES,
        });
        cancelMediaRequests("media_response_too_large");
        return;
      }
      let payload;
      try {
        payload = JSON.parse(serialized);
      } catch {
        diagnostic("warn", "response.invalid-json", { bytes: serialized.length });
        return;
      }
      if (!isRecord(payload)) {
        return;
      }
      if (payload.type === "hoshidicts_media_result") {
        handleMediaResponse(payload);
        return;
      }
      if (serialized.length > MAX_RESPONSE_BYTES) {
        diagnostic("warn", "lookup-response.too-large", {
          bytes: serialized.length,
          maxBytes: MAX_RESPONSE_BYTES,
        });
        return;
      }
      if (payload.type !== "hoshidicts_lookup_result") {
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
      const requestMode = latestRequestMode;
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
        if (requestMode === "kanji" && cachedTermView) {
          restoreTermView();
          return;
        }
        const message = payload.featureDisabled === true
          ? "Hoshidicts is off. Enable it in Hoshidicts Settings."
          : payload.dictionaryCount === 0
            ? "No Hoshidicts dictionaries are enabled. Open Hoshidicts Settings."
            : `Dictionary lookup failed: ${boundedString(payload.error, 1024) || "try again"}`;
        renderLookupNotice(candidate, message);
        return;
      }
      const dictionaryGeneration = normalizeDictionaryGeneration(payload.generation);
      if (dictionaryGeneration === null) {
        diagnostic("warn", "lookup.media-generation-unavailable", { requestId });
        clearMediaState("dictionary_generation_unavailable");
        activeDictionaryGeneration = null;
      } else {
        updateDictionaryGeneration(dictionaryGeneration);
      }
      const results = normalizeLookupResults(payload);
      if (results.length > 0) {
        renderTermResults(results, candidate, dictionaryGeneration);
        diagnostic("info", "lookup.rendered", {
          requestId,
          dictionaryCount: Number.isFinite(payload.dictionaryCount)
            ? Math.trunc(payload.dictionaryCount)
            : null,
          resultCount: results.length,
          query: candidate.query,
          firstExpression: results[0].term.expression,
        });
        return;
      }
      const kanji = normalizeKanjiLookup(payload);
      if (kanji) {
        preparePopupContent("kanji_results");
        audioController.setRenderedResults([]);
        popupView.renderKanji(kanji, candidate, {
          onBack: requestMode === "kanji" && cachedTermView ? restoreTermView : null,
          highlightText: requestMode === "kanji" && cachedTermView
            ? cachedTermView.highlightText
            : kanji.character,
        });
        showPopup(candidate);
        diagnostic("info", "lookup.kanji-rendered", {
          requestId,
          dictionaryCount: Number.isFinite(payload.dictionaryCount)
            ? Math.trunc(payload.dictionaryCount)
            : null,
          entryCount: kanji.entries.length,
          character: kanji.character,
          mode: requestMode,
        });
        return;
      }
      if (results.length === 0) {
        diagnostic("info", "lookup.empty", {
          requestId,
          dictionaryCount: Number.isFinite(payload.dictionaryCount)
            ? Math.trunc(payload.dictionaryCount)
            : null,
          query: candidate.query,
        });
        if (requestMode === "kanji" && cachedTermView) {
          restoreTermView();
          return;
        }
        renderLookupNotice(
          candidate,
          "No definitions found. Add one with the Note button."
        );
        return;
      }
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
              latestRequestMode,
              latestRequestText || latestCandidate.query
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
          latestRequestId = null;
          clearLookupTimeout();
          clearMediaState("socket_closed");
          activeDictionaryGeneration = null;
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

    function sendLookup(candidate, generation, mode = "term-first", text = candidate.query) {
      if (destroyed || generation !== latestGeneration) {
        return;
      }
      latestCandidate = candidate;
      latestRequestMode = mode;
      latestRequestText = text;
      if (lookupTimeoutTimer === null) {
        lookupTimeoutTimer = setTimeoutFn(() => {
          lookupTimeoutTimer = null;
          if (generation !== latestGeneration) {
            return;
          }
          const requestId = latestRequestId;
          latestRequestId = null;
          if (mode === "kanji" && cachedTermView) {
            restoreTermView();
          } else {
            renderLookupNotice(
              candidate,
              "Dictionary lookup timed out. Check that the overlay service is running."
            );
          }
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
        text,
        ...(mode === "kanji" ? { mode: "kanji" } : {}),
      }));
      diagnostic("debug", "lookup.sent", {
        requestId,
        query: text,
        mode,
        matchOffset: candidate.matchOffset,
      });
    }

    function repeatCurrentLookup() {
      const candidate = latestCandidate;
      if (!candidate || !candidate.anchor || !candidate.anchor.isConnected) {
        return false;
      }
      queueLookup(candidate, true);
      return true;
    }

    function queueLookup(candidate, immediate = false) {
      const signature = [
        candidate.sentence,
        candidate.matchOffset,
        candidate.query,
      ].join("\u0000");
      clearHideTimer();
      if (!immediate && signature === lastCandidateSignature) {
        return;
      }
      invalidateLookup();
      audioController.beginLookup();
      if (!immediate && popupVisible) {
        dismissPopup("candidate-changed");
      }
      lastCandidateSignature = signature;
      latestCandidate = candidate;
      const generation = latestGeneration;
      if (immediate) {
        sendLookup(candidate, generation);
        return;
      }
      debounceTimer = setTimeoutFn(() => {
        debounceTimer = null;
        sendLookup(candidate, generation);
      }, LOOKUP_DEBOUNCE_MS);
    }

    function scanPointer(pointer, modifierActive) {
      if (!pointer || !(pointer.target instanceof windowRef.Element)) {
        return;
      }
      if (noteEditing) {
        pointerInPopup = popup.contains(pointer.target);
        clearHideTimer();
        return;
      }
      if (
        popup.contains(pointer.target) ||
        pointer.target.closest(".gsm-hoshidicts-audio-menu")
      ) {
        pointerInPopup = true;
        clearHideTimer();
        return;
      }
      pointerInPopup = false;
      if (requiresActivationKey() && !modifierActive) {
        if (!activationRequirementLogged && isReadableHoverTarget(pointer.target)) {
          activationRequirementLogged = true;
          diagnostic("info", "hover.activation-key-required", {
            activationKey: preferences.activationKey,
            message: `Hold ${preferences.activationKey} while hovering readable text to run a lookup.`,
          });
        }
        invalidateLookup();
        scheduleHide("activation-key-not-held");
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
      scanPointer(lastPointer, isActivationKeyPressed(event.shiftKey));
    }

    function onKeyDown(event) {
      if (
        preferences.activationKey !== DEFAULT_ACTIVATION_KEY ||
        event.key !== DEFAULT_ACTIVATION_KEY
      ) {
        return;
      }
      const wasPressed = localShiftPressed;
      localShiftPressed = true;
      if (!wasPressed && requiresActivationKey()) {
        scanPointer(lastPointer, true);
      }
    }

    function onKeyUp(event) {
      if (
        preferences.activationKey === DEFAULT_ACTIVATION_KEY &&
        event.key === DEFAULT_ACTIVATION_KEY
      ) {
        localShiftPressed = false;
        if (requiresActivationKey() && !globalActivationKeyPressed) {
          if (!pointerInPopup && !noteEditing) {
            invalidateLookup();
          }
          scheduleHide("activation-key-released");
        }
      }
    }

    function setActivationKeyPressed(active) {
      const nextPressed = active === true;
      if (globalActivationKeyPressed === nextPressed) {
        return false;
      }
      globalActivationKeyPressed = nextPressed;
      if (!requiresActivationKey()) {
        return true;
      }
      if (nextPressed) {
        scanPointer(lastPointer, true);
      } else {
        localShiftPressed = false;
        invalidateLookup();
        scheduleHide("activation-key-released");
      }
      return true;
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
      const previousActivationKey = preferences.activationKey;
      const previousSourceHighlightEnabled = preferences.sourceHighlightEnabled;
      preferences = {
        lookupMode: Object.prototype.hasOwnProperty.call(nextPreferences, "lookupMode")
          ? nextPreferences.lookupMode === "hover" ? "hover" : "shift"
          : preferences.lookupMode,
        activationKey: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "activationKey"
        )
          ? normalizeActivationKey(nextPreferences.activationKey)
          : preferences.activationKey,
        sourceHighlightEnabled: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "sourceHighlightEnabled"
        )
          ? nextPreferences.sourceHighlightEnabled === true
          : preferences.sourceHighlightEnabled,
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
      const activationKeyChanged = previousActivationKey !== preferences.activationKey;
      if (activationKeyChanged) {
        localShiftPressed = false;
        globalActivationKeyPressed = false;
      }
      if (previousSourceHighlightEnabled !== preferences.sourceHighlightEnabled) {
        popupView.setSourceHighlightEnabled(preferences.sourceHighlightEnabled);
      }
      if (previousMode !== preferences.lookupMode || activationKeyChanged) {
        activationRequirementLogged = false;
        if (requiresActivationKey() && !isActivationKeyPressed()) {
          invalidateLookup();
          scheduleHide(activationKeyChanged ? "activation-key-changed" : "lookup-mode-changed");
        } else {
          scanPointer(lastPointer, true);
        }
      }
      diagnostic("info", "preferences.updated", preferences);
      return { ...preferences };
    }

    function updateAudioPreferences(nextPreferences = {}) {
      const normalized = audioController.updatePreferences(nextPreferences);
      diagnostic("info", "audio-preferences.updated", {
        enabled: normalized.enabled,
        autoPlay: normalized.autoPlay,
        volume: normalized.volume,
        sourceCount: normalized.sources.length,
      });
      return normalized;
    }

    function onWindowBlur() {
      localShiftPressed = false;
      if (noteEditing) {
        clearHideTimer();
        return;
      }
      if (!globalActivationKeyPressed) {
        invalidateLookup();
        scheduleHide("window-blurred");
      }
    }

    function destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      localShiftPressed = false;
      globalActivationKeyPressed = false;
      diagnostic("info", "reader.destroyed");
      hide("destroy");
      audioController.destroy();
      clearMediaState("reader_destroyed");
      activeDictionaryGeneration = null;
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
      requiresShift: requiresActivationKey(),
      activationKey: preferences.activationKey,
      sourceHighlightEnabled: preferences.sourceHighlightEnabled,
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
      getAudioPreferences: () => audioController.getPreferences(),
      positionPopup,
      setActivationKeyPressed,
      updateAudioPreferences,
      updatePreferences,
    };
  }

  return {
    DEFAULT_ACTIVATION_KEY,
    DEFAULT_POPUP_HIDE_DELAY_MS,
    DEFAULT_SOURCE_HIGHLIGHT_ENABLED,
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
    createHoshidictsAudioClient,
    createHoshidictsReader,
    normalizeActivationKey,
    normalizeAudioProfile,
    normalizePopupHideDelay,
    normalizeKanjiLookup,
    normalizeLookupResults,
    resolveGsmApiBaseUrl,
    resolveLookupCandidate,
    segmentFurigana,
    setMiningButtonState,
  };
}));
