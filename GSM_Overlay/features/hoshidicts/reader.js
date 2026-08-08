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

  if (
    !popupApi ||
    typeof popupApi.createPopupView !== "function" ||
    typeof popupApi.createSourceHighlighter !== "function"
  ) {
    throw new Error("Hoshidicts popup support must load before the reader.");
  }
  if (!audioApi || typeof audioApi.createHoshidictsAudioController !== "function") {
    throw new Error("Hoshidicts audio support must load before the reader.");
  }
  const { createPopupView, createSourceHighlighter, setMiningButtonState } = popupApi;
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
  const DEFAULT_POPUP_NESTING_MAX_DEPTH = 10;
  const MAX_POPUP_HIDE_DELAY_MS = 5 * 1000;
  const DEFAULT_DEFINITION_BLUR_PREFERENCES = Object.freeze({
    enabled: false,
    lookupThreshold: 5,
    revealMode: "timed",
    revealDelayMs: 5 * 1000,
  });
  const MIN_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1;
  const MAX_DEFINITION_BLUR_LOOKUP_THRESHOLD = 1_000_000;
  const MIN_DEFINITION_BLUR_REVEAL_DELAY_MS = 1000;
  const MAX_DEFINITION_BLUR_REVEAL_DELAY_MS = 60 * 60 * 1000;
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
    const normalizedKey = value.trim();
    if (PUNCTUATION_ACTIVATION_KEYS.has(normalizedKey)) {
      return normalizedKey;
    }
    if (/^[a-z]$/iu.test(normalizedKey)) {
      return normalizedKey.toUpperCase();
    }
    if (/^[0-9]$/u.test(normalizedKey)) {
      return normalizedKey;
    }
    const functionKeyMatch = /^f([1-9]|1[0-9]|2[0-4])$/iu.exec(normalizedKey);
    if (functionKeyMatch) {
      return `F${functionKeyMatch[1]}`;
    }
    return NAMED_ACTIVATION_KEYS.get(normalizedKey.toLowerCase()) ?? fallback;
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
    const pendingRecords = new Map();

    async function sendRecord(body) {
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
            headers: {
              "Content-Type": "application/json",
            },
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
    }

    return {
      async record(payload) {
        if (!fetchImpl) {
          throw new Error("GSM lookup statistics are unavailable.");
        }
        if (!isRecord(payload)) {
          throw new Error("A lookup statistics payload is required.");
        }
        const term = typeof payload.term === "string"
          ? payload.term.trim().normalize("NFC")
          : "";
        const reading = typeof payload.reading === "string"
          ? payload.reading.trim().normalize("NFC")
          : "";
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

        // SQLite increments are atomic, but concurrent HTTP requests can still
        // arrive in the opposite order from their lookups. Keep writes for one
        // canonical term ordered so the active popup receives its own count.
        const previous = pendingRecords.get(body);
        const recordPromise = (previous
          ? previous.catch(() => undefined)
          : Promise.resolve()
        ).then(() => sendRecord(body));
        pendingRecords.set(body, recordPromise);
        try {
          return await recordPromise;
        } finally {
          if (pendingRecords.get(body) === recordPromise) {
            pendingRecords.delete(body);
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

  function normalizeDefinitionBlurPreferences(
    value,
    fallback = DEFAULT_DEFINITION_BLUR_PREFERENCES
  ) {
    const source = isRecord(value) ? value : {};
    const baseline = isRecord(fallback)
      ? fallback
      : DEFAULT_DEFINITION_BLUR_PREFERENCES;
    const normalizeInteger = (candidate, minimum, maximum, defaultValue) =>
      Number.isFinite(candidate)
        ? Math.max(minimum, Math.min(maximum, Math.trunc(candidate)))
        : defaultValue;
    return {
      enabled: typeof source.enabled === "boolean"
        ? source.enabled
        : baseline.enabled === true,
      lookupThreshold: normalizeInteger(
        source.lookupThreshold,
        MIN_DEFINITION_BLUR_LOOKUP_THRESHOLD,
        MAX_DEFINITION_BLUR_LOOKUP_THRESHOLD,
        baseline.lookupThreshold
      ),
      revealMode: source.revealMode === "hover" || source.revealMode === "timed"
        ? source.revealMode
        : baseline.revealMode === "hover" ? "hover" : "timed",
      revealDelayMs: normalizeInteger(
        source.revealDelayMs,
        MIN_DEFINITION_BLUR_REVEAL_DELAY_MS,
        MAX_DEFINITION_BLUR_REVEAL_DELAY_MS,
        baseline.revealDelayMs
      ),
    };
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
    const onMine =
      typeof options.onMine === "function"
        ? options.onMine
        : null;
    const onLookup =
      typeof options.onLookup === "function"
        ? options.onLookup
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
      showLookupCounts: options.showLookupCounts !== false,
      definitionBlur: normalizeDefinitionBlurPreferences(options.definitionBlur),
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
    let localShiftPressed = false;
    let globalActivationKeyPressed = options.activationKeyPressed === true;
    let pointerInPopup = false;
    let pointerPopupDepth = null;
    let lastPointer = null;
    let requestSequence = 0;
    let latestRequestId = null;
    let latestCandidate = null;
    let latestCandidateSignature = "";
    let latestTargetDepth = 0;
    let latestGeneration = 0;
    let lookupStatsGeneration = 0;
    let latestRequestMode = "term-first";
    let latestRequestText = "";
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
    let popupVisible = false;
    let noteEditing = false;
    let miningInFlight = false;
    let miningStatusCache = null;
    let miningStatusCacheExpiresAt = 0;
    let miningStatusPromise = null;
    let activationRequirementLogged = false;
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
    const audioController = options.audioController || createHoshidictsAudioController({
      window: windowRef,
      document: documentRef,
      client: options.audioClient || null,
      audioPreferences: options.audioPreferences || options.audioProfile,
      logger,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

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
        target.closest(
          '.text-box[data-selectable="true"], #text, .gsm-hoshidicts-glossary-content'
        )
      );
    }

    function clearDefinitionRevealTimer(context) {
      if (context && context.timer !== null) {
        clearTimeoutFn(context.timer);
        context.timer = null;
      }
    }

    function isActiveDefinitionBlur(context) {
      return Boolean(
        context &&
        context.level.definitionBlurContext === context &&
        context.level.visible &&
        !destroyed
      );
    }

    function getDefinitionBlurState(context) {
      if (!context || context.revealed) {
        return "revealed";
      }
      return context.lookupResolved ? "blurred" : "pending";
    }

    function revealDefinitions(context, reason) {
      if (!isActiveDefinitionBlur(context) || context.revealed) {
        return false;
      }
      context.revealed = true;
      clearDefinitionRevealTimer(context);
      context.level.view.setDefinitionBlurState("revealed");
      diagnostic("debug", "definitions.revealed", {
        depth: context.level.depth,
        reason,
      });
      return true;
    }

    function invalidateDefinitionBlur(level) {
      if (!level) {
        return;
      }
      clearDefinitionRevealTimer(level.definitionBlurContext);
      level.definitionBlurContext = null;
      if (level.view) {
        level.view.setDefinitionBlurState("revealed");
      }
    }

    function beginDefinitionBlur(level) {
      invalidateDefinitionBlur(level);
      if (!preferences.definitionBlur.enabled) {
        return null;
      }
      const context = {
        level,
        preferences: { ...preferences.definitionBlur },
        deadlineReached: false,
        hovered: false,
        lookupResolved: false,
        revealed: false,
        timer: null,
      };
      level.definitionBlurContext = context;
      return context;
    }

    function startDefinitionBlurDeadline(context) {
      if (
        !isActiveDefinitionBlur(context) ||
        context.preferences.revealMode !== "timed"
      ) {
        return;
      }
      context.timer = setTimeoutFn(() => {
        context.timer = null;
        if (!isActiveDefinitionBlur(context)) {
          return;
        }
        context.deadlineReached = true;
        revealDefinitions(context, "timed-deadline");
      }, context.preferences.revealDelayMs);
    }

    function applyDefinitionBlurLookupCount(context, response) {
      if (!isActiveDefinitionBlur(context) || context.revealed) {
        return;
      }
      const lookupCount = isRecord(response) && response.success === true
        ? response.lookupCount
        : null;
      if (!Number.isInteger(lookupCount) || lookupCount < 1) {
        revealDefinitions(context, "invalid-lookup-count");
        return;
      }
      if (lookupCount < context.preferences.lookupThreshold) {
        revealDefinitions(context, "below-threshold");
        return;
      }
      context.lookupResolved = true;
      if (
        context.preferences.revealMode === "timed" &&
        context.deadlineReached
      ) {
        revealDefinitions(context, "timed-deadline-reached");
        return;
      }
      if (context.preferences.revealMode === "hover" && context.hovered) {
        revealDefinitions(context, "definition-hovered");
        return;
      }
      context.level.view.setDefinitionBlurState("blurred");
      diagnostic("debug", "definitions.blurred", {
        depth: context.level.depth,
        lookupCount,
        lookupThreshold: context.preferences.lookupThreshold,
        revealMode: context.preferences.revealMode,
      });
    }

    function onDefinitionPointerOver(depth, event) {
      const context = popupLevels[depth]?.definitionBlurContext;
      if (
        !isActiveDefinitionBlur(context) ||
        context.preferences.revealMode !== "hover" ||
        !(event.target instanceof windowRef.Element) ||
        !event.target.closest(".gsm-hoshidicts-definitions")
      ) {
        return;
      }
      context.hovered = true;
      revealDefinitions(context, "definition-hovered");
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

    function mediaCacheKey(generation, dictionary, path) {
      return JSON.stringify([generation, dictionary, path]);
    }

    function mediaDepthKey(depth, key) {
      return JSON.stringify([depth, key]);
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
      mediaInFlight.delete(job.inFlightKey);
      if (job.active) {
        activeMediaRequestCount = Math.max(0, activeMediaRequestCount - 1);
      }
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }

    function cancelMediaRequests(reason, minimumDepth = 0) {
      const jobs = [...mediaInFlight.values()].filter(
        (job) => job.depth >= minimumDepth
      );
      mediaQueue = mediaQueue.filter((job) => job.depth < minimumDepth);
      for (const job of jobs) {
        rejectMediaJob(job, new Error(reason));
      }
    }

    function clearMediaState(reason) {
      cancelMediaRequests(reason);
      clearMediaCache();
    }

    function releasePopupMediaFromDepth(minimumDepth) {
      for (const [reservationKey, reservation] of popupMediaKeys) {
        if (reservation.depth < minimumDepth) {
          continue;
        }
        popupMediaKeys.delete(reservationKey);
        popupMediaPixels = Math.max(
          0,
          popupMediaPixels - reservation.pixelCount
        );
      }
    }

    function preparePopupContent(reason, targetDepth = 0) {
      cancelMediaRequests(reason, targetDepth);
      releasePopupMediaFromDepth(targetDepth);
      pumpMediaQueue();
    }

    function reservePopupMedia(depth, key, pixelCount) {
      const reservationKey = mediaDepthKey(depth, key);
      if (popupMediaKeys.has(reservationKey)) {
        return true;
      }
      if (
        popupMediaKeys.size >= MAX_POPUP_MEDIA_IMAGES ||
        popupMediaPixels + pixelCount > MAX_POPUP_MEDIA_PIXELS
      ) {
        return false;
      }
      popupMediaKeys.set(reservationKey, { depth, pixelCount });
      popupMediaPixels += pixelCount;
      return true;
    }

    function isPopupMediaBudgetFull() {
      return (
        popupMediaKeys.size >= MAX_POPUP_MEDIA_IMAGES ||
        popupMediaPixels >= MAX_POPUP_MEDIA_PIXELS
      );
    }

    function releasePopupMedia(depth, key) {
      const reservationKey = mediaDepthKey(depth, key);
      const reservation = popupMediaKeys.get(reservationKey);
      if (!reservation) {
        return;
      }
      popupMediaKeys.delete(reservationKey);
      popupMediaPixels = Math.max(0, popupMediaPixels - reservation.pixelCount);
    }

    function updateDictionaryGeneration(generation) {
      if (activeDictionaryGeneration === generation) {
        return;
      }
      clearMediaState("dictionary_generation_changed");
      activeDictionaryGeneration = generation;
    }

    function cacheMedia(job, url, byteLength, pixelCount) {
      const existing = mediaCache.get(job.cacheKey);
      if (existing) {
        mediaCacheBytes -= existing.byteLength;
        revokeCachedMedia(existing);
        mediaCache.delete(job.cacheKey);
      }
      const entry = { byteLength, pixelCount, url };
      mediaCache.set(job.cacheKey, entry);
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
      mediaInFlight.delete(job.inFlightKey);
      activeMediaRequestCount = Math.max(0, activeMediaRequestCount - 1);
      if (mediaCache.get(job.cacheKey)?.url !== url) {
        cacheMedia(job, url, byteLength, pixelCount);
      }
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

    function resolveMedia({ depth, dictionary, generation, path }) {
      const normalizedGeneration = normalizeDictionaryGeneration(generation);
      const normalizedPath = normalizeMediaPath(path);
      if (
        !Number.isSafeInteger(depth) ||
        depth < 0 ||
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
        if (!reservePopupMedia(depth, key, cached.pixelCount)) {
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
      const inFlightKey = mediaDepthKey(depth, key);
      const inFlight = mediaInFlight.get(inFlightKey);
      if (inFlight) {
        return inFlight.promise;
      }
      if (mediaInFlight.size >= MAX_MEDIA_PENDING_REQUESTS) {
        return Promise.reject(new Error("media_queue_full"));
      }
      const job = {
        active: false,
        cacheKey: key,
        depth,
        dictionary,
        generation: normalizedGeneration,
        inFlightKey,
        path: normalizedPath,
        requestId: null,
        settled: false,
        timeoutTimer: null,
      };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      mediaInFlight.set(inFlightKey, job);
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
      const definitionPointerOver = (event) => onDefinitionPointerOver(depth, event);
      popup.addEventListener("pointerdown", stopPropagation);
      popup.addEventListener("click", stopPropagation);
      popup.addEventListener("pointerenter", pointerEnter);
      popup.addEventListener("pointerleave", pointerLeave);
      popup.addEventListener("pointerover", definitionPointerOver);
      documentRef.body.appendChild(popup);
      const level = {
        depth,
        popup,
        view: null,
        visible: false,
        candidate: null,
        termView: null,
        audioItems: [],
        definitionBlurContext: null,
        lookupStatsPayload: null,
        lookupStatsRequestGeneration: 0,
        miningStatusGeneration: 0,
        cleanup() {
          popup.removeEventListener("pointerdown", stopPropagation);
          popup.removeEventListener("click", stopPropagation);
          popup.removeEventListener("pointerenter", pointerEnter);
          popup.removeEventListener("pointerleave", pointerLeave);
          popup.removeEventListener("pointerover", definitionPointerOver);
        },
      };
      level.view = createPopupView({
        window: windowRef,
        document: documentRef,
        popup,
        idPrefix: depth === 0 ? "gsm-hoshidicts" : `gsm-hoshidicts-${depth}`,
        appendExpressionRuby,
        appendTextOnlyGlossary,
        parseTagList,
        initialResultCount: INITIAL_VISIBLE_RESULTS,
        maxMetadataTags: MAX_VISIBLE_METADATA_TAGS,
        sourceHighlighter: chainHighlighter.scope(depth),
        sourceHighlightEnabled: preferences.sourceHighlightEnabled,
        positionPopup: () => positionPopupAndDescendants(depth),
        onMineClick(button, result, candidate, feedback) {
          void mineResult(button, result, candidate, feedback);
        },
        onKanjiClick(character, _result, candidate) {
          requestKanji(character, candidate, depth);
        },
        onAddCustomEntry(entry) {
          return addCustomEntryAndRefresh(entry, depth);
        },
        onNoteEditingChange(editing) {
          noteEditing = editing;
          clearHideTimer();
        },
        onBeforeResultsRendered() {
          pruneFromDepth(depth + 1, "dictionary-tab-changed");
          preparePopupContent("dictionary_tab_changed", depth);
        },
        onResultsRendered({ audioItems, feedback, lookupStats, miningButtons }) {
          for (const button of miningButtons) {
            button.hidden = true;
          }
          if (
            lookupStats &&
            preferences.showLookupCounts &&
            level.lookupStatsPayload
          ) {
            level.view.setLookupStats(lookupStats, level.lookupStatsPayload);
          }
          level.audioItems = audioItems;
          syncAudioRenderedResults(depth, true);
          void refreshMiningButtons(level, miningButtons, feedback);
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

    function syncAudioRenderedResults(preferredDepth = null, autoPlay = false) {
      const visibleLevels = popupLevels.filter(
        (level) => level.visible && level.audioItems.length > 0
      );
      const preferredLevel = Number.isInteger(preferredDepth)
        ? visibleLevels.find((level) => level.depth === preferredDepth)
        : null;
      const orderedLevels = preferredLevel
        ? [preferredLevel, ...visibleLevels.filter((level) => level !== preferredLevel)]
        : visibleLevels;
      audioController.setRenderedResults(
        orderedLevels.flatMap((level) => level.audioItems),
        { autoPlay }
      );
    }

    function pruneFromDepth(depth, reason = "descendants-pruned") {
      const startDepth = Math.max(0, Math.trunc(depth));
      clearDescendantHideTimer();
      preparePopupContent(reason, startDepth);
      if (latestCandidate && latestTargetDepth >= startDepth) {
        invalidateLookup();
      }
      for (let index = popupLevels.length - 1; index >= startDepth; index -= 1) {
        const level = popupLevels[index];
        invalidateDefinitionBlur(level);
        level.lookupStatsRequestGeneration += 1;
        level.lookupStatsPayload = null;
        level.miningStatusGeneration += 1;
        level.candidate = null;
        level.termView = null;
        level.audioItems = [];
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
      audioController.dismissPopup();
      syncAudioRenderedResults(null, false);
      diagnostic("debug", "popup.pruned", { depth: startDepth, reason });
    }

    function hide(reason = "hide") {
      clearHideTimer();
      clearDescendantHideTimer();
      invalidateLookup();
      preparePopupContent("popup_hidden");
      pruneFromDepth(0, reason);
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
      preparePopupContent("lookup_notice", targetDepth);
      const level = ensurePopupLevel(targetDepth);
      invalidateDefinitionBlur(level);
      level.termView = null;
      level.audioItems = [];
      level.view.renderNotice(message, candidate);
      renderedSignatures.set(targetDepth, signature);
      noticeSignatures.set(targetDepth, signature);
      showPopup(candidate, targetDepth);
      syncAudioRenderedResults(null, false);
    }

    function renderTermResults(
      results,
      candidate,
      dictionaryGeneration,
      targetDepth,
      signature
    ) {
      preparePopupContent("lookup_results", targetDepth);
      expandCandidateAnchor(
        candidate,
        results[0].matched || results[0].term.expression
      );
      const level = ensurePopupLevel(targetDepth);
      const definitionBlurContext = beginDefinitionBlur(level);
      level.lookupStatsRequestGeneration += 1;
      level.lookupStatsPayload = null;
      level.termView = {
        results,
        candidate,
        dictionaryGeneration,
        highlightText: results[0].matched || results[0].term.expression,
        signature,
        definitionBlurContext,
      };
      const rendered = level.view.renderResults(results, candidate, {
        definitionBlurState: getDefinitionBlurState(definitionBlurContext),
        generation: dictionaryGeneration,
        showLookupCounts: preferences.showLookupCounts && Boolean(onLookup),
        resolveMedia: dictionaryGeneration === null
          ? null
          : (request) => resolveMedia({ ...request, depth: targetDepth }),
      });
      for (const button of rendered.miningButtons) {
        button.hidden = true;
      }
      renderedSignatures.set(targetDepth, signature);
      noticeSignatures.delete(targetDepth);
      level.audioItems = rendered.audioItems;
      showPopup(candidate, targetDepth);
      startDefinitionBlurDeadline(definitionBlurContext);
      recordLookup(results[0], definitionBlurContext, level);
      syncAudioRenderedResults(targetDepth, true);
      void refreshMiningButtons(level, rendered.miningButtons, rendered.feedback);
    }

    function restoreTermView(targetDepth) {
      const level = popupLevels[targetDepth];
      if (!level || !level.termView) return;
      const {
        results,
        candidate,
        dictionaryGeneration,
        signature,
        definitionBlurContext,
      } = level.termView;
      latestCandidate = candidate;
      latestCandidateSignature = signature;
      latestTargetDepth = targetDepth;
      latestRequestMode = "term-first";
      latestRequestText = candidate.query;
      preparePopupContent("restore_term_results", targetDepth);
      const rendered = level.view.renderResults(results, candidate, {
        definitionBlurState: getDefinitionBlurState(definitionBlurContext),
        generation: dictionaryGeneration,
        showLookupCounts: preferences.showLookupCounts && Boolean(onLookup),
        resolveMedia: dictionaryGeneration === null
          ? null
          : (request) => resolveMedia({ ...request, depth: targetDepth }),
      });
      for (const button of rendered.miningButtons) {
        button.hidden = true;
      }
      if (
        rendered.lookupStats &&
        preferences.showLookupCounts &&
        level.lookupStatsPayload
      ) {
        level.view.setLookupStats(rendered.lookupStats, level.lookupStatsPayload);
      }
      renderedSignatures.set(targetDepth, signature);
      noticeSignatures.delete(targetDepth);
      level.audioItems = rendered.audioItems;
      showPopup(candidate, targetDepth);
      syncAudioRenderedResults(targetDepth, true);
      void refreshMiningButtons(level, rendered.miningButtons, rendered.feedback);
    }

    function requestKanji(character, candidate, targetDepth) {
      const kanji = Array.from(String(character || ""))[0] || "";
      if (!HAN_CHARACTER_PATTERN.test(kanji)) return;
      clearLookupTimeout();
      const signature = renderedSignatures.get(targetDepth) || latestCandidateSignature;
      sendLookup(
        candidate,
        latestGeneration,
        targetDepth,
        signature,
        "kanji",
        kanji
      );
    }

    async function addCustomEntryAndRefresh(entry, targetDepth) {
      if (!onAddCustomEntry) {
        throw new Error("The custom dictionary is unavailable.");
      }
      const response = await onAddCustomEntry(entry);
      repeatCurrentLookup(targetDepth);
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
          setMiningButtonState(
            button,
            miningInFlight ? "checking" : "ready",
            miningInFlight ? "Another note is being added" : ""
          );
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
      // Match Yomitan's quiet unavailable state: dictionary results remain the
      // focus, with no setup warning or inert mining affordance. Errors from a
      // real mining attempt still flow through mineResult below.
      level.view.setFeedback(feedback, "");
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
        level.view.setFeedback(
          feedback,
          feedbackParts.join(" "),
          visibleUnmapped.length > 0 || audioFailed ? "warning" : "success"
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
        const liveButtons = popupLevels.flatMap((entry) =>
          Array.from(
            entry.popup.querySelectorAll(".gsm-hoshidicts-mine-button")
          )
        );
        for (const current of liveButtons) {
          if (current !== button && current.isConnected) {
            setMiningButtonState(current, "ready");
          }
        }
      }
    }

    function recordLookup(result, definitionBlurContext, level) {
      if (!onLookup || !preferences.showLookupCounts) {
        revealDefinitions(definitionBlurContext, "lookup-statistics-unavailable");
        return;
      }
      const term = result.term.expression;
      const reading = result.term.reading;
      const statsGeneration = lookupStatsGeneration;
      const requestGeneration = level.lookupStatsRequestGeneration;
      let lookupInvoked = false;
      void Promise.resolve()
        .then(() => {
          if (
            destroyed ||
            statsGeneration !== lookupStatsGeneration ||
            !preferences.showLookupCounts
          ) {
            return undefined;
          }
          lookupInvoked = true;
          return onLookup({ term, reading });
        })
        .then((response) => {
          if (
            !lookupInvoked ||
            destroyed ||
            statsGeneration !== lookupStatsGeneration ||
            requestGeneration !== level.lookupStatsRequestGeneration ||
            popupLevels[level.depth] !== level ||
            !preferences.showLookupCounts
          ) {
            return;
          }
          applyDefinitionBlurLookupCount(definitionBlurContext, response);
          level.lookupStatsPayload = response;
          const lookupStats = level.popup.querySelector(
            ".gsm-hoshidicts-lookup-stats"
          );
          if (
            lookupStats &&
            lookupStats.isConnected &&
            level.popup.contains(lookupStats)
          ) {
            level.view.setLookupStats(lookupStats, response);
          }
        })
        .catch((error) => {
          if (
            destroyed ||
            statsGeneration !== lookupStatsGeneration ||
            requestGeneration !== level.lookupStatsRequestGeneration ||
            popupLevels[level.depth] !== level ||
            !preferences.showLookupCounts
          ) {
            return;
          }
          revealDefinitions(definitionBlurContext, "lookup-statistics-error");
          diagnostic("warn", "lookup.record-failed", {
            error: boundedString(
              error instanceof Error ? error.message : String(error),
              1024
            ),
          });
        });
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
      const cached = mediaCache.get(job.cacheKey);
      const pixelCount = cached ? cached.pixelCount : metadata.pixelCount;
      const reservationKey = mediaDepthKey(job.depth, job.cacheKey);
      const alreadyReserved = popupMediaKeys.has(reservationKey);
      if (!reservePopupMedia(job.depth, job.cacheKey, pixelCount)) {
        rejectMediaJob(job, new Error("media_pixel_budget_exceeded"));
        cancelMediaRequests("media_pixel_budget_exceeded");
        return;
      }
      if (cached) {
        mediaCache.delete(job.cacheKey);
        mediaCache.set(job.cacheKey, cached);
        resolveMediaJob(
          job,
          cached.url,
          cached.byteLength,
          cached.pixelCount
        );
        if (isPopupMediaBudgetFull()) {
          cancelMediaRequests("media_pixel_budget_exhausted");
        } else {
          pumpMediaQueue();
        }
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
          releasePopupMedia(job.depth, job.cacheKey);
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
      const signature = latestCandidateSignature;
      const targetDepth = latestTargetDepth;
      const requestId = latestRequestId;
      const requestMode = latestRequestMode;
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
        if (requestMode === "kanji" && popupLevels[targetDepth]?.termView) {
          restoreTermView(targetDepth);
          return;
        }
        const message = payload.featureDisabled === true
          ? "Hoshidicts is off. Enable it in Hoshidicts Settings."
          : payload.dictionaryCount === 0
            ? "No Hoshidicts dictionaries are enabled. Open Hoshidicts Settings."
            : `Dictionary lookup failed: ${boundedString(payload.error, 1024) || "try again"}`;
        renderLookupNotice(candidate, message, targetDepth, signature);
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
        renderTermResults(
          results,
          candidate,
          dictionaryGeneration,
          targetDepth,
          signature
        );
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
        return;
      }
      const kanji = normalizeKanjiLookup(payload);
      if (kanji) {
        preparePopupContent("kanji_results", targetDepth);
        const level = ensurePopupLevel(targetDepth);
        const termView = level.termView;
        if (!termView) {
          invalidateDefinitionBlur(level);
        }
        level.audioItems = [];
        level.view.renderKanji(kanji, candidate, {
          onBack: requestMode === "kanji" && termView
            ? () => restoreTermView(targetDepth)
            : null,
          highlightText: requestMode === "kanji" && termView
            ? termView.highlightText
            : kanji.character,
        });
        renderedSignatures.set(targetDepth, signature);
        noticeSignatures.delete(targetDepth);
        showPopup(candidate, targetDepth);
        syncAudioRenderedResults(null, false);
        diagnostic("info", "lookup.kanji-rendered", {
          requestId,
          targetDepth,
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
          targetDepth,
          dictionaryCount: Number.isFinite(payload.dictionaryCount)
            ? Math.trunc(payload.dictionaryCount)
            : null,
          query: candidate.query,
        });
        if (requestMode === "kanji" && popupLevels[targetDepth]?.termView) {
          restoreTermView(targetDepth);
          return;
        }
        latestCandidate = null;
        if (targetDepth > 0) {
          pruneFromDepth(targetDepth, "no-results");
        } else {
          renderLookupNotice(
            candidate,
            "No definitions found. Add one with the Note button.",
            targetDepth,
            signature
          );
        }
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
              latestTargetDepth,
              latestCandidateSignature,
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
          const reconnectLookup = latestCandidate
            ? {
                candidate: latestCandidate,
                mode: latestRequestMode,
                signature: latestCandidateSignature,
                targetDepth: latestTargetDepth,
                text: latestRequestText || latestCandidate.query,
              }
            : null;
          socket = null;
          latestRequestId = null;
          clearLookupTimeout();
          clearMediaState("socket_closed");
          activeDictionaryGeneration = null;
          hide("socket-closed");
          if (
            reconnectLookup &&
            reconnectLookup.targetDepth === 0 &&
            isCandidateAnchorConnected(reconnectLookup.candidate)
          ) {
            latestCandidate = reconnectLookup.candidate;
            latestCandidateSignature = reconnectLookup.signature;
            latestTargetDepth = reconnectLookup.targetDepth;
            latestRequestMode = reconnectLookup.mode;
            latestRequestText = reconnectLookup.text;
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

    function sendLookup(
      candidate,
      generation,
      targetDepth,
      signature,
      mode = "term-first",
      text = candidate.query
    ) {
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
          if (mode === "kanji" && popupLevels[targetDepth]?.termView) {
            restoreTermView(targetDepth);
          } else {
            renderLookupNotice(
              candidate,
              "Dictionary lookup timed out. Check that the overlay service is running.",
              targetDepth,
              signature
            );
          }
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
        text,
        ...(mode === "kanji" ? { mode: "kanji" } : {}),
      }));
      diagnostic("debug", "lookup.sent", {
        requestId,
        query: text,
        mode,
        targetDepth,
        matchOffset: candidate.matchOffset,
      });
    }

    function repeatCurrentLookup(targetDepth = latestTargetDepth) {
      const candidate = popupLevels[targetDepth]?.candidate || latestCandidate;
      if (!isCandidateAnchorConnected(candidate)) {
        return false;
      }
      queueLookup(candidate, targetDepth, true);
      return true;
    }

    function queueLookup(candidate, targetDepth, immediate = false) {
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
        !immediate &&
        signature === latestCandidateSignature &&
        latestTargetDepth === targetDepth &&
        (latestRequestId !== null || debounceTimer !== null)
      ) {
        return;
      }
      if (!immediate && renderedSignatures.get(targetDepth) === signature) {
        invalidateLookup();
        schedulePruneFromDepth(targetDepth + 1, "ancestor-hovered");
        return;
      }
      invalidateLookup();
      if (targetDepth === 0) {
        audioController.beginLookup();
      } else {
        audioController.dismissPopup();
      }
      pruneFromDepth(targetDepth, "candidate-changed");
      latestCandidate = candidate;
      latestTargetDepth = targetDepth;
      latestCandidateSignature = signature;
      const generation = latestGeneration;
      if (immediate) {
        sendLookup(candidate, generation, targetDepth, signature);
        return;
      }
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
      if (pointer.target.closest(".gsm-hoshidicts-audio-menu")) {
        pointerInPopup = true;
        pointerPopupDepth = null;
        clearHideTimer();
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
      if (noteEditing) {
        clearHideTimer();
        return;
      }
      if (requiresActivationKey() && !modifierActive) {
        clearHoveredSource();
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

    function updatePreferences(nextPreferences = {}) {
      const hadHideTimer = hideTimer !== null;
      const previousMode = preferences.lookupMode;
      const definitionBlurWasEnabled = preferences.definitionBlur.enabled;
      const previousActivationKey = preferences.activationKey;
      const previousSourceHighlightEnabled = preferences.sourceHighlightEnabled;
      const previousShowLookupCounts = preferences.showLookupCounts;
      const previousMaxDepth = preferences.popupNestingMaxDepth;
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
        showLookupCounts: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "showLookupCounts"
        )
          ? nextPreferences.showLookupCounts !== false
          : preferences.showLookupCounts,
        definitionBlur: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "definitionBlur"
        )
          ? normalizeDefinitionBlurPreferences(
              nextPreferences.definitionBlur,
              preferences.definitionBlur
            )
          : preferences.definitionBlur,
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
      if (definitionBlurWasEnabled && !preferences.definitionBlur.enabled) {
        for (const level of popupLevels) {
          invalidateDefinitionBlur(level);
        }
      }
      if (previousShowLookupCounts && !preferences.showLookupCounts) {
        lookupStatsGeneration += 1;
        for (const level of popupLevels) {
          level.lookupStatsRequestGeneration += 1;
          level.lookupStatsPayload = null;
          revealDefinitions(level.definitionBlurContext, "lookup-statistics-disabled");
          for (const lookupStats of level.popup.querySelectorAll(
            ".gsm-hoshidicts-lookup-stats"
          )) {
            lookupStats.remove();
          }
        }
        positionAllPopups();
      }
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
        for (const level of popupLevels) {
          level.view.setSourceHighlightEnabled(preferences.sourceHighlightEnabled);
        }
      }
      if (preferences.popupNestingMaxDepth < previousMaxDepth) {
        pruneFromDepth(
          preferences.popupNestingMaxDepth + 1,
          "depth-limit-changed"
        );
      }
      if (previousMode !== preferences.lookupMode || activationKeyChanged) {
        activationRequirementLogged = false;
        if (requiresActivationKey() && !isActivationKeyPressed()) {
          invalidateLookup();
          scheduleHide(activationKeyChanged ? "activation-key-changed" : "lookup-mode-changed");
        } else {
          scanPointer(lastPointer, isActivationKeyPressed());
        }
      }
      diagnostic("info", "preferences.updated", preferences);
      return {
        ...preferences,
        definitionBlur: { ...preferences.definitionBlur },
      };
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
      clearHoveredSource();
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
      requiresShift: requiresActivationKey(),
      activationKey: preferences.activationKey,
      sourceHighlightEnabled: preferences.sourceHighlightEnabled,
      popupHideDelayMs: preferences.popupHideDelayMs,
      showLookupCounts: preferences.showLookupCounts,
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
      getPreferences: () => ({
        ...preferences,
        definitionBlur: { ...preferences.definitionBlur },
      }),
      getAudioPreferences: () => audioController.getPreferences(),
      positionPopup: positionAllPopups,
      setActivationKeyPressed,
      updateAudioPreferences,
      updatePreferences,
    };
  }

  return {
    DEFAULT_DEFINITION_BLUR_PREFERENCES,
    DEFAULT_ACTIVATION_KEY,
    DEFAULT_POPUP_HIDE_DELAY_MS,
    DEFAULT_POPUP_NESTING_MAX_DEPTH,
    DEFAULT_SOURCE_HIGHLIGHT_ENABLED,
    INITIAL_VISIBLE_RESULTS,
    LOOKUP_DEBOUNCE_MS,
    LOOKUP_MAX_RESULTS,
    LOOKUP_REQUEST_TIMEOUT_MS,
    LOOKUP_SCAN_LENGTH,
    MAX_POPUP_HIDE_DELAY_MS,
    MAX_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MAX_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MIN_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MIN_DEFINITION_BLUR_REVEAL_DELAY_MS,
    appendExpressionRuby,
    appendTextOnlyGlossary,
    calculatePopupPosition,
    createHoshidictsMiningClient,
    createHoshidictsLookupStatsClient,
    createHoshidictsAudioClient,
    createHoshidictsReader,
    normalizeActivationKey,
    normalizeAudioProfile,
    normalizeDefinitionBlurPreferences,
    normalizePopupHideDelay,
    normalizeKanjiLookup,
    normalizePopupNestingMaxDepth,
    normalizeLookupResults,
    resolveGsmApiBaseUrl,
    resolveLookupCandidate,
    resolveGlossaryLookupCandidate,
    segmentFurigana,
    setMiningButtonState,
  };
}));
