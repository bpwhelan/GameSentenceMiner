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
  const {
    createPopupView,
    createSourceHighlighter,
    setMiningButtonState,
  } = popupApi;
  const {
    canonicalizeAudioTerm,
    createHoshidictsAudioClient,
    createHoshidictsAudioController,
    normalizeLocalHttpBaseUrl,
    normalizeAudioProfile,
  } = audioApi;

  const LOOKUP_REQUEST_TIMEOUT_MS = 4 * 1000;
  const LOOKUP_SCAN_LENGTH = 16;
  const MIN_LOOKUP_SCAN_LENGTH = 1;
  const MAX_LOOKUP_SCAN_LENGTH = 64;
  const LOOKUP_MAX_RESULTS = 32;
  const MIN_LOOKUP_MAX_RESULTS = 1;
  const MAX_LOOKUP_MAX_RESULTS = 256;
  const INITIAL_VISIBLE_RESULTS = 1;
  const DEFAULT_POPUP_HIDE_DELAY_MS = 300;
  const POPUP_TRANSFER_GRACE_MS = 80;
  const DEFAULT_POPUP_WIDTH_PX = 560;
  const DEFAULT_POPUP_HEIGHT_PX = 420;
  const DEFAULT_POPUP_COLUMNS = 1;
  const MIN_POPUP_WIDTH_PX = 280;
  const MAX_POPUP_WIDTH_PX = 1200;
  const MIN_POPUP_HEIGHT_PX = 200;
  const MAX_POPUP_HEIGHT_PX = 900;
  const MIN_POPUP_COLUMNS = 1;
  const MAX_POPUP_COLUMNS = 4;
  const DEFAULT_POPUP_OPACITY_PERCENT = 85;
  const DEFAULT_POPUP_BACKDROP_BLUR_PX = 16;
  const DEFAULT_POPUP_TOOLBAR_POSITION = "top";
  const DEFAULT_POPUP_BUTTONS = Object.freeze({
    addToAnki: true,
    audio: true,
    customDefinition: true,
    viewInAnki: false,
    customLinks: Object.freeze([]),
  });
  const MAX_POPUP_CUSTOM_LINKS = 8;
  const MAX_POPUP_CUSTOM_LINK_LABEL_LENGTH = 64;
  const MAX_POPUP_CUSTOM_LINK_URL_LENGTH = 2048;
  const MAX_CUSTOM_POPUP_CSS_LENGTH = 32 * 1024;
  const MIN_POPUP_OPACITY_PERCENT = 0;
  const MAX_POPUP_OPACITY_PERCENT = 100;
  const MIN_POPUP_BACKDROP_BLUR_PX = 0;
  const MAX_POPUP_BACKDROP_BLUR_PX = 32;
  const DEFAULT_THEME = "default";
  const THEMES = new Set([
    "default",
    "catppuccin-mocha",
    "solarized-dark",
    "dark",
    "synthwave",
    "halloween",
    "forest",
    "aqua",
    "black",
    "luxury",
    "dracula",
    "business",
    "night",
    "coffee",
    "dim",
    "sunset",
    "abyss",
    "girlypop",
    "solarized-light",
    "light",
    "cupcake",
    "bumblebee",
    "emerald",
    "corporate",
    "retro",
    "cyberpunk",
    "valentine",
    "garden",
    "lofi",
    "pastel",
    "fantasy",
    "wireframe",
    "cmyk",
    "autumn",
    "acid",
    "lemonade",
    "winter",
    "nord",
    "caramellatte",
    "silk",
    "high-contrast",
  ]);
  const DEFAULT_ACTIVATION_KEY = "Shift";
  const DEFAULT_SOURCE_HIGHLIGHT_ENABLED = false;
  const DEFAULT_ONLY_SCAN_JAPANESE_TEXT = true;
  const DEFAULT_SHOW_COMPACT_DEFINITION_SUMMARY = false;
  const DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT = 3;
  const MIN_COMPACT_DEFINITION_SUMMARY_COUNT = 1;
  const MAX_COMPACT_DEFINITION_SUMMARY_COUNT = 6;
  const DEFAULT_SHOW_PITCH_ACCENT_FURIGANA = true;
  const DEFAULT_SHOW_PITCH_ACCENT_BADGE = false;
  const DEFAULT_HIDE_POPUP_GRAMMAR_TAGS = true;
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
  const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
  const MAX_LOOKUP_TEXT_BYTES = 4 * 1024;
  const MAX_MEDIA_RESPONSE_BYTES = 6 * 1024 * 1024;
  const MAX_STYLES_RESPONSE_BYTES = 3 * 1024 * 1024;
  const MAX_DICTIONARY_STYLES = 256;
  const MAX_DICTIONARY_STYLE_BYTES = 256 * 1024;
  const MAX_DICTIONARY_STYLES_BYTES = 2 * 1024 * 1024;
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
  const MAX_TRACE_STEPS = 32;
  const MAX_TEXT_LENGTH = 128 * 1024;
  const MAX_MINING_REQUEST_BYTES = 64 * 1024 * 1024;
  const MAX_DUPLICATE_CHECK_REQUEST_BYTES = 64 * 1024 * 1024;
  const MINING_REQUEST_TIMEOUT_MS = 90 * 1000;
  const MAX_LOOKUP_STATS_REQUEST_BYTES = 4 * 1024;
  const MAX_LOOKUP_STATS_TEXT_LENGTH = 256;
  const LOOKUP_STATS_REQUEST_TIMEOUT_MS = 2 * 1000;
  const MAX_STRUCTURED_DEPTH = 24;
  const MAX_STRUCTURED_NODES = 1_048_576;
  const RECONNECT_INITIAL_DELAY_MS = 750;
  const RECONNECT_MAX_DELAY_MS = 12 * 1000;
  const MINING_STATUS_CACHE_MS = 5 * 1000;
  const MAX_VISIBLE_METADATA_TAGS = 12;
  const MAX_DICTIONARY_PRESENTATION_ENTRIES = 256;
  const MAX_DICTIONARY_PRESENTATION_TITLE_LENGTH = 4096;
  const SOURCE_HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const JAPANESE_ONLY_TOKEN_PATTERN =
    /^[\u3005-\u3007\u303b\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u{20000}-\u{2fa1f}]+$/u;
  const TOKEN_BOUNDARY_PATTERN = /[\p{White_Space}\p{Punctuation}\p{Symbol}]/u;
  const HAN_CHARACTER_PATTERN =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
  const KANJI_SEGMENT_PATTERN =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\u3005]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\u3005]+/gu;
  const KANA_PATTERN = /[\u3040-\u30ff\uff66-\uff9f]/u;
  const PITCH_SMALL_KANA = new Set(Array.from(
    "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ"
  ));
  const COMBINING_MARK_PATTERN = /\p{Mark}/u;
  const ALLOWED_STRUCTURED_TAGS = new Set([
    "a",
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
  const MAX_STRUCTURED_DATA_ATTRIBUTES = 64;
  const MAX_STRUCTURED_DATA_KEY_LENGTH = 64;
  const MAX_STRUCTURED_DATA_VALUE_LENGTH = 4096;
  const ALLOWED_MEDIA_TYPES = new Set([
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
  ]);
  const STRUCTURED_STYLE_PROPERTIES = new Map([
    ["background", ["background", "color"]],
    ["backgroundColor", ["background-color", "color"]],
    ["borderColor", ["border-color", "color"]],
    ["borderRadius", ["border-radius", "length-sequence"]],
    ["borderStyle", ["border-style", "border-style"]],
    ["borderWidth", ["border-width", "length-sequence"]],
    ["clipPath", ["clip-path", "clip-path"]],
    ["color", ["color", "color"]],
    ["cursor", ["cursor", "cursor"]],
    ["fontSize", ["font-size", "length"]],
    ["fontStyle", ["font-style", "font-style"]],
    ["fontWeight", ["font-weight", "font-weight"]],
    ["listStyleType", ["list-style-type", "list-style-type"]],
    ["margin", ["margin", "signed-length-sequence"]],
    ["marginBottom", ["margin-bottom", "signed-length"]],
    ["marginLeft", ["margin-left", "signed-length"]],
    ["marginRight", ["margin-right", "signed-length"]],
    ["marginTop", ["margin-top", "signed-length"]],
    ["padding", ["padding", "length-sequence"]],
    ["paddingBottom", ["padding-bottom", "length"]],
    ["paddingLeft", ["padding-left", "length"]],
    ["paddingRight", ["padding-right", "length"]],
    ["paddingTop", ["padding-top", "length"]],
    ["textAlign", ["text-align", "text-align"]],
    ["textDecorationColor", ["text-decoration-color", "color"]],
    ["textDecorationLine", ["text-decoration-line", "text-decoration-line"]],
    ["textDecorationStyle", ["text-decoration-style", "text-decoration-style"]],
    ["textEmphasis", ["text-emphasis", "safe-css-token"]],
    ["textShadow", ["text-shadow", "safe-css-token"]],
    ["verticalAlign", ["vertical-align", "vertical-align"]],
    ["whiteSpace", ["white-space", "white-space"]],
    ["wordBreak", ["word-break", "word-break"]],
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

  function clonePopupButtons(value) {
    return {
      addToAnki: value.addToAnki,
      audio: value.audio,
      customDefinition: value.customDefinition,
      viewInAnki: value.viewInAnki,
      customLinks: value.customLinks.map((link) => ({ ...link })),
    };
  }

  function normalizePopupButtons(value, fallback = DEFAULT_POPUP_BUTTONS) {
    const normalizedFallback = isRecord(fallback)
      ? fallback
      : DEFAULT_POPUP_BUTTONS;
    if (
      !isRecord(value) ||
      typeof value.addToAnki !== "boolean" ||
      typeof value.audio !== "boolean" ||
      typeof value.customDefinition !== "boolean" ||
      typeof value.viewInAnki !== "boolean" ||
      !Array.isArray(value.customLinks) ||
      value.customLinks.length > MAX_POPUP_CUSTOM_LINKS
    ) {
      return clonePopupButtons(normalizedFallback);
    }
    const customLinks = [];
    for (const rawLink of value.customLinks) {
      if (!isRecord(rawLink)) {
        return clonePopupButtons(normalizedFallback);
      }
      const label = typeof rawLink.label === "string" ? rawLink.label.trim() : "";
      const url = typeof rawLink.url === "string" ? rawLink.url.trim() : "";
      if (
        !label ||
        label.length > MAX_POPUP_CUSTOM_LINK_LABEL_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(label) ||
        !url ||
        url.length > MAX_POPUP_CUSTOM_LINK_URL_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(url)
      ) {
        return clonePopupButtons(normalizedFallback);
      }
      try {
        const parsed = new URL(
          url.replaceAll("%w", "word").replaceAll("%s", "sentence")
        );
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          !parsed.hostname ||
          parsed.username ||
          parsed.password
        ) {
          return clonePopupButtons(normalizedFallback);
        }
      } catch {
        return clonePopupButtons(normalizedFallback);
      }
      customLinks.push({ label, url });
    }
    return {
      addToAnki: value.addToAnki,
      audio: value.audio,
      customDefinition: value.customDefinition,
      viewInAnki: value.viewInAnki,
      customLinks,
    };
  }

  function popupButtonsEqual(left, right) {
    return left.addToAnki === right.addToAnki &&
      left.audio === right.audio &&
      left.customDefinition === right.customDefinition &&
      left.viewInAnki === right.viewInAnki &&
      left.customLinks.length === right.customLinks.length &&
      left.customLinks.every((link, index) =>
        link.label === right.customLinks[index]?.label &&
        link.url === right.customLinks[index]?.url
      );
  }

  function expandPopupButtonUrl(template, values = {}) {
    const word = encodeURIComponent(String(values.word || ""));
    const sentence = encodeURIComponent(String(values.sentence || ""));
    return String(template || "")
      .replaceAll("%w", word)
      .replaceAll("%s", sentence);
  }

  function isJapaneseOnlyToken(query) {
    const token = query.split(TOKEN_BOUNDARY_PATTERN, 1)[0];
    return token.length > 0 && JAPANESE_ONLY_TOKEN_PATTERN.test(token);
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

  function normalizeLookupScanLength(value, fallback = LOOKUP_SCAN_LENGTH) {
    return Number.isInteger(value) &&
      value >= MIN_LOOKUP_SCAN_LENGTH &&
      value <= MAX_LOOKUP_SCAN_LENGTH
      ? value
      : fallback;
  }

  function normalizeLookupMaxResults(value, fallback = LOOKUP_MAX_RESULTS) {
    return Number.isInteger(value) &&
      value >= MIN_LOOKUP_MAX_RESULTS &&
      value <= MAX_LOOKUP_MAX_RESULTS
      ? value
      : fallback;
  }

  function normalizeSortFrequencyDictionary(value, fallback = null) {
    if (value === null) {
      return null;
    }
    return typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= MAX_DICTIONARY_PRESENTATION_TITLE_LENGTH
      ? value
      : fallback;
  }

  function normalizeCompactDefinitionSummaryDictionary(value, fallback = null) {
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return fallback;
    }
    const normalized = value.trim();
    return normalized.length > 0 &&
      normalized.length <= MAX_DICTIONARY_PRESENTATION_TITLE_LENGTH
      ? normalized
      : fallback;
  }

  function normalizeCompactDefinitionSummaryCount(
    value,
    fallback = DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT
  ) {
    return Number.isInteger(value) &&
      value >= MIN_COMPACT_DEFINITION_SUMMARY_COUNT &&
      value <= MAX_COMPACT_DEFINITION_SUMMARY_COUNT
      ? value
      : fallback;
  }

  function normalizeSortFrequencyDictionaryOrder(value, fallback = "descending") {
    return value === "ascending" || value === "descending" ? value : fallback;
  }

  function normalizeLookupResults(payload, maxResults = LOOKUP_MAX_RESULTS) {
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.results)) {
      return [];
    }

    const normalizedMaxResults = normalizeLookupMaxResults(maxResults);
    return payload.results.slice(0, normalizedMaxResults).map((rawResult) => {
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
      const glossaries = Array.isArray(rawTerm.glossaries)
        ? rawTerm.glossaries.map((rawGlossary) => {
            const glossary = isRecord(rawGlossary) ? rawGlossary : {};
            return {
              dictionary: boundedString(glossary.dictionary, 4096) || "Dictionary",
              glossary: typeof glossary.glossary === "string" ? glossary.glossary : "",
              definitionTags: boundedString(glossary.definitionTags, 4096),
              termTags: boundedString(glossary.termTags, 4096),
            };
          })
        : [];
      const frequencies = Array.isArray(rawTerm.frequencies)
        ? rawTerm.frequencies.map((rawGroup) => {
            const group = isRecord(rawGroup) ? rawGroup : {};
            return {
              dictionary: boundedString(group.dictionary, 4096) || "Dictionary",
              frequencies: Array.isArray(group.frequencies)
                ? group.frequencies.map((rawFrequency) => {
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
        ? rawTerm.pitches.map((rawGroup) => {
            const group = isRecord(rawGroup) ? rawGroup : {};
            return {
              dictionary: boundedString(group.dictionary, 4096) || "Dictionary",
              pitches: Array.isArray(group.pitches)
                ? group.pitches.map((rawPitch) => {
                      const pitch = isRecord(rawPitch) ? rawPitch : {};
                      return {
                        position: Number.isFinite(pitch.position)
                          ? Math.trunc(pitch.position)
                          : null,
                        pattern: boundedString(pitch.pattern, 4096),
                        nasal: Array.isArray(pitch.nasal)
                          ? pitch.nasal.filter(Number.isFinite)
                              .map(Math.trunc)
                          : [],
                        devoice: Array.isArray(pitch.devoice)
                          ? pitch.devoice.filter(Number.isFinite)
                              .map(Math.trunc)
                          : [],
                      };
                    })
                    .filter((pitch) => pitch.position !== null)
                : [],
              transcriptions: Array.isArray(group.transcriptions)
                ? group.transcriptions.map((value) => boundedString(value, 4096))
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

  function splitPitchAccentMorae(reading) {
    const morae = [];
    for (const character of Array.from(String(reading || "").normalize("NFC"))) {
      const previousIndex = morae.length - 1;
      if (
        previousIndex >= 0 &&
        (PITCH_SMALL_KANA.has(character) || COMBINING_MARK_PATTERN.test(character))
      ) {
        morae[previousIndex] += character;
      } else {
        morae.push(character);
      }
    }
    return morae;
  }

  function buildPitchAccentMorae(reading, position) {
    const morae = splitPitchAccentMorae(reading);
    if (
      morae.length === 0 ||
      !Number.isInteger(position) ||
      position < 0 ||
      position > morae.length
    ) {
      return null;
    }

    const levels = morae.map((_, index) => {
      if (position === 0) {
        return index === 0 ? "low" : "high";
      }
      if (position === 1) {
        return index === 0 ? "high" : "low";
      }
      return index === 0 || index >= position ? "low" : "high";
    });
    const levelAfterWord = position === 0 ? "high" : "low";
    return morae.map((text, index) => {
      const level = levels[index];
      const nextLevel = levels[index + 1] || levelAfterWord;
      return {
        text,
        level,
        transition: level === nextLevel
          ? null
          : level === "low" ? "rise" : "drop",
      };
    });
  }

  function selectPitchAccent(
    pitchGroups,
    preferredDictionary = null,
    moraCount = null
  ) {
    const groups = Array.isArray(pitchGroups) ? pitchGroups : [];
    const maximumPosition = Number.isInteger(moraCount) && moraCount >= 0
      ? moraCount
      : null;
    const preferred = typeof preferredDictionary === "string"
      ? preferredDictionary.trim()
      : "";
    const orderedGroups = preferred
      ? [
          ...groups.filter((group) => group?.dictionary === preferred),
          ...groups.filter((group) => group?.dictionary !== preferred),
        ]
      : groups;
    for (const group of orderedGroups) {
      if (!isRecord(group) || !Array.isArray(group.pitches)) {
        continue;
      }
      for (const pitch of group.pitches) {
        if (
          isRecord(pitch) &&
          Number.isInteger(pitch.position) &&
          pitch.position >= 0 &&
          (maximumPosition === null || pitch.position <= maximumPosition)
        ) {
          return {
            dictionary: boundedString(group.dictionary, 4096),
            pitch,
          };
        }
      }
    }
    return null;
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

  function appendExpressionRuby(
    documentRef,
    parent,
    expression,
    reading,
    onKanjiClick,
    pitchOptions = {}
  ) {
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
    const pitchReading = reading || expression;
    const selectedPitch = pitchOptions.enabled === false
      ? null
      : selectPitchAccent(
          pitchOptions.groups,
          pitchOptions.dictionary,
          splitPitchAccentMorae(pitchReading).length
        );
    const pitchedMorae = selectedPitch
      ? buildPitchAccentMorae(pitchReading, selectedPitch.pitch.position)
      : null;
    if (pitchedMorae) {
      const ruby = documentRef.createElement("ruby");
      ruby.className = "gsm-hoshidicts-pitch-ruby";
      appendText(ruby, expression);

      const rt = documentRef.createElement("rt");
      rt.className = "gsm-hoshidicts-pitch-reading";
      rt.dataset.pitchPosition = String(selectedPitch.pitch.position);
      if (selectedPitch.dictionary) {
        rt.dataset.pitchDictionary = selectedPitch.dictionary;
      }
      rt.title = [
        selectedPitch.dictionary,
        `Pitch accent ${selectedPitch.pitch.position}`,
      ].filter(Boolean).join(" · ");

      const contour = documentRef.createElement("span");
      contour.className = "gsm-hoshidicts-pitch-contour";
      for (const mora of pitchedMorae) {
        const span = documentRef.createElement("span");
        span.className = "gsm-hoshidicts-pitch-mora";
        span.dataset.pitchLevel = mora.level;
        if (mora.transition) {
          span.dataset.pitchTransition = mora.transition;
        }
        span.textContent = mora.text;
        contour.appendChild(span);
      }
      rt.appendChild(contour);
      ruby.appendChild(rt);
      parent.appendChild(ruby);
      return;
    }

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

  function normalizeSignedLengthSequence(value) {
    if (typeof value === "number") {
      return normalizeLengthToken(value, true);
    }
    if (!isSafeCssToken(value)) {
      return null;
    }
    const tokens = value.trim().split(/\s+/u);
    if (tokens.length < 1 || tokens.length > 4) {
      return null;
    }
    const normalized = tokens.map((token) => normalizeLengthToken(token, true));
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
      if (typeof value === "number") {
        return Number.isFinite(value) && Math.abs(value) <= 16
          ? `${value}em`
          : null;
      }
      return normalizeLengthToken(value, true);
    }
    if (kind === "length-sequence") {
      return normalizeLengthSequence(value);
    }
    if (kind === "signed-length-sequence") {
      return normalizeSignedLengthSequence(value);
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
    if (kind === "list-style-type") {
      return isSafeCssToken(value) && value.trim().length <= 64
        ? value.trim()
        : null;
    }
    if (kind === "text-align") {
      return typeof value === "string" &&
        /^(?:start|end|left|right|center|justify|match-parent)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "text-decoration-line") {
      const values = Array.isArray(value) ? value : [value];
      return values.length >= 1 && values.length <= 4 && values.every(
        (item) => typeof item === "string" &&
          /^(?:none|underline|overline|line-through|blink)$/u.test(item)
      ) ? values.join(" ") : null;
    }
    if (kind === "text-decoration-style") {
      return typeof value === "string" &&
        /^(?:solid|double|dotted|dashed|wavy)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "vertical-align") {
      if (
        typeof value === "string" &&
        /^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/u.test(value)
      ) {
        return value;
      }
      return normalizeLengthToken(value, true);
    }
    if (kind === "white-space") {
      return typeof value === "string" &&
        /^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "word-break") {
      return typeof value === "string" &&
        /^(?:normal|break-all|keep-all|break-word)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "cursor") {
      return typeof value === "string" &&
        /^(?:auto|default|pointer|help|text|wait|progress|not-allowed|zoom-in|zoom-out)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "clip-path") {
      return typeof value === "string" &&
        /^(?:circle|ellipse|inset)\([0-9.,%+\-\s]+\)$/u.test(value)
        ? value
        : null;
    }
    if (kind === "safe-css-token") {
      return isSafeCssToken(value) ? value.trim() : null;
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

    const width = Number.isFinite(Number(value.width)) && Number(value.width) > 0
      ? Number(value.width)
      : 100;
    const height = Number.isFinite(Number(value.height)) && Number(value.height) > 0
      ? Number(value.height)
      : 100;
    const preferredWidth = Number.isFinite(Number(value.preferredWidth)) &&
      Number(value.preferredWidth) > 0
      ? Number(value.preferredWidth)
      : null;
    const preferredHeight = Number.isFinite(Number(value.preferredHeight)) &&
      Number(value.preferredHeight) > 0
      ? Number(value.preferredHeight)
      : null;
    const aspectWidth = preferredWidth || width;
    const aspectHeight = preferredHeight || height;
    const usedWidth = preferredWidth || (
      preferredHeight ? preferredHeight * width / height : width
    );
    const units = value.sizeUnits === "em" ? "em" : "px";
    const maximumSize = units === "em" ? 64 : MAX_MEDIA_DISPLAY_SIZE;
    const displayWidth = Math.max(0.1, Math.min(maximumSize, usedWidth));

    const link = documentRef.createElement("a");
    link.className = "gloss-image-link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.dataset.path = path;
    link.dataset.imageLoadState = "not-loaded";
    link.dataset.hasAspectRatio = "true";
    link.dataset.imageRendering = typeof value.imageRendering === "string"
      ? value.imageRendering
      : value.pixelated === true
        ? "pixelated"
        : "auto";
    link.dataset.appearance = typeof value.appearance === "string"
      ? value.appearance
      : "auto";
    link.dataset.background = String(
      typeof value.background === "boolean" ? value.background : true
    );
    link.dataset.collapsed = String(value.collapsed === true);
    link.dataset.collapsible = String(value.collapsible !== false);
    if (typeof value.verticalAlign === "string") {
      link.dataset.verticalAlign = value.verticalAlign;
    }
    if (preferredWidth !== null || preferredHeight !== null || units === "em") {
      link.dataset.sizeUnits = units;
    }

    const container = documentRef.createElement("span");
    container.className = "gloss-image-container";
    container.style.width = `${displayWidth}${units}`;
    container.style.aspectRatio = `${aspectWidth} / ${aspectHeight}`;
    if (typeof value.title === "string" && value.title.length <= 4096) {
      container.title = value.title;
    }
    if (isSafeCssToken(value.border)) {
      container.style.border = value.border;
    }
    const borderRadius = normalizeLengthSequence(value.borderRadius);
    if (borderRadius !== null) {
      container.style.borderRadius = borderRadius;
    }

    const sizer = documentRef.createElement("span");
    sizer.className = "gloss-image-sizer";
    sizer.style.paddingTop = `${Math.min(10_000, aspectHeight / aspectWidth * 100)}%`;
    const background = documentRef.createElement("span");
    background.className = "gloss-image-background";
    const overlay = documentRef.createElement("span");
    overlay.className = "gloss-image-container-overlay";
    const image = documentRef.createElement("img");
    image.className = "gloss-image gsm-hoshidicts-structured-image";
    image.alt = isRecord(value.data) && typeof value.data.alt === "string"
      ? value.data.alt.slice(0, 1024)
      : typeof value.alt === "string"
        ? value.alt.slice(0, 1024)
        : "";
    image.decoding = "async";
    image.draggable = false;
    image.style.width = "100%";
    image.style.height = "100%";
    container.append(sizer, background, overlay, image);
    link.appendChild(container);
    const linkText = documentRef.createElement("span");
    linkText.className = "gloss-image-link-text";
    linkText.textContent = "Image";
    link.appendChild(linkText);
    const onLayoutChange = typeof state.onLayoutChange === "function"
      ? state.onLayoutChange
      : () => {};
    image.addEventListener("load", () => {
      link.dataset.imageLoadState = "loaded";
      onLayoutChange();
    });
    image.addEventListener("error", () => {
      image.hidden = true;
      link.removeAttribute("href");
      link.dataset.imageLoadState = "load-error";
      onLayoutChange();
    });
    parent.appendChild(link);
    let mediaPromise;
    try {
      mediaPromise = Promise.resolve(state.resolveMedia({ path, width, height }));
    } catch (error) {
      mediaPromise = Promise.reject(error);
    }
    mediaPromise.then((url) => {
      if (image.isConnected && typeof url === "string" && url.startsWith("blob:")) {
        image.src = url;
        link.href = url;
        link.dataset.imageLoadState = "loaded";
        background.style.setProperty("--image", `url("${url}")`);
      }
    }).catch(() => {
      image.hidden = true;
      link.dataset.imageLoadState = "load-error";
      onLayoutChange();
    });
  }

  function prioritizeLookupResultsByReading(results, primaryReading) {
    if (!Array.isArray(results) || typeof primaryReading !== "string" || !primaryReading) {
      return results;
    }
    const preferred = [];
    const remaining = [];
    for (const result of results) {
      (result?.term?.reading === primaryReading ? preferred : remaining).push(result);
    }
    return [...preferred, ...remaining];
  }

  function structuredDataAttributeName(rawKey) {
    if (
      typeof rawKey !== "string" ||
      rawKey.length === 0 ||
      rawKey.length > MAX_STRUCTURED_DATA_KEY_LENGTH ||
      !/^[A-Za-z0-9_-]+$/u.test(rawKey)
    ) {
      return null;
    }
    const key = rawKey
      .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
      .replace(/_+/gu, "-")
      .toLowerCase();
    return key && !key.startsWith("-") ? `data-sc-${key}` : null;
  }

  function applyStructuredData(element, data) {
    if (!isRecord(data)) {
      return;
    }
    let count = 0;
    for (const [key, rawValue] of Object.entries(data)) {
      if (count >= MAX_STRUCTURED_DATA_ATTRIBUTES) {
        break;
      }
      if (
        typeof rawValue !== "string" &&
        typeof rawValue !== "number" &&
        typeof rawValue !== "boolean"
      ) {
        continue;
      }
      const attribute = structuredDataAttributeName(key);
      const value = String(rawValue);
      if (
        !attribute ||
        value.length > MAX_STRUCTURED_DATA_VALUE_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(value)
      ) {
        continue;
      }
      element.setAttribute(attribute, value);
      count += 1;
    }
  }

  function parseStructuredLink(href) {
    if (typeof href !== "string" || href.length === 0 || href.length > 4096) {
      return null;
    }
    if (href.startsWith("?")) {
      const params = new Map();
      try {
        for (const part of href.slice(1).split("&")) {
          const separator = part.indexOf("=");
          const rawKey = separator < 0 ? part : part.slice(0, separator);
          const rawValue = separator < 0 ? "" : part.slice(separator + 1);
          const key = decodeURIComponent(rawKey.replace(/\+/gu, " "));
          if (!params.has(key)) {
            params.set(
              key,
              decodeURIComponent(rawValue.replace(/\+/gu, " "))
            );
          }
        }
      } catch {
        return null;
      }
      const query = boundedString(params.get("query"), MAX_LOOKUP_TEXT_BYTES).trim();
      if (!query) {
        return null;
      }
      return {
        internal: true,
        primaryReading: boundedString(
          params.get("primary_reading"),
          MAX_LOOKUP_TEXT_BYTES
        ).trim(),
        query,
      };
    }
    if (/^https?:\/\//iu.test(href)) {
      return { href, internal: false };
    }
    return null;
  }

  function appendStructuredValue(documentRef, parent, value, state, depth) {
    if (state.nodes >= MAX_STRUCTURED_NODES || depth > MAX_STRUCTURED_DEPTH) {
      return;
    }
    if (typeof value === "string") {
      state.nodes += 1;
      parent.appendChild(documentRef.createTextNode(value));
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
    element.classList.add(`gloss-sc-${tag}`);
    state.nodes += 1;
    applyStructuredStyle(element, value.style);
    applyStructuredData(element, value.data);
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
    if (typeof value.title === "string" && value.title.length <= 4096) {
      element.title = value.title;
    }
    if (tag === "details" && value.open === true) {
      element.open = true;
    }
    if (tag === "a") {
      element.classList.add("gloss-link", "gsm-hoshidicts-structured-link");
      const link = parseStructuredLink(value.href);
      if (link?.internal) {
        element.setAttribute("href", "#");
        element.dataset.hoshidictsQuery = link.query;
        if (link.primaryReading) {
          element.dataset.hoshidictsReading = link.primaryReading;
        }
        element.addEventListener("click", (event) => {
          event.preventDefault();
          if (typeof state.onInternalLink === "function") {
            state.onInternalLink({
              anchor: element,
              primaryReading: link.primaryReading,
              query: link.query,
            });
          }
        });
      } else if (link) {
        element.href = link.href;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
        element.dataset.external = "true";
      }
    }
    let contentParent = element;
    if (tag === "a") {
      contentParent = documentRef.createElement("span");
      contentParent.className = "gloss-link-text";
      element.appendChild(contentParent);
    }
    if (
      !STRUCTURED_TAGS_WITHOUT_CONTENT.has(tag) &&
      Object.prototype.hasOwnProperty.call(value, "content")
    ) {
      appendStructuredValue(documentRef, contentParent, value.content, state, depth + 1);
    }
    if (tag === "a" && element.dataset.external === "true") {
      const icon = documentRef.createElement("span");
      icon.className = "gloss-link-external-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "↗";
      element.appendChild(icon);
    }
    if (tag === "table") {
      const container = documentRef.createElement("div");
      container.className = "gloss-sc-table-container";
      container.appendChild(element);
      parent.appendChild(container);
    } else {
      parent.appendChild(element);
    }
  }

  function appendTextOnlyGlossary(documentRef, parent, rawGlossary, options = {}) {
    const value = typeof rawGlossary === "string" ? rawGlossary : "";
    if (!value) {
      return;
    }
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Plain glossary strings are rendered literally, including any HTML-like text.
    }
    if (isRecord(parsed) && parsed.type === "structured-content") {
      parent.classList.add("structured-content");
    }
    appendStructuredValue(
      documentRef,
      parent,
      parsed,
      {
        nodes: 0,
        onInternalLink: options.onInternalLink,
        onLayoutChange: options.onLayoutChange,
        resolveMedia: typeof options.resolveMedia === "function"
          ? ({ path, width, height }) => options.resolveMedia({
              dictionary: options.dictionary,
              generation: options.generation,
              height,
              path,
              width,
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
    if (mediaType === "image/avif") {
      if (
        bytes.length < 20 ||
        String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp"
      ) {
        return false;
      }
      for (let offset = 8; offset + 4 <= Math.min(bytes.length, 128); offset += 4) {
        if (offset === 12) {
          continue;
        }
        const brand = String.fromCharCode(...bytes.slice(offset, offset + 4));
        if (brand === "avif" || brand === "avis") {
          return true;
        }
      }
      return false;
    }
    if (mediaType === "image/svg+xml") {
      const prefix = String.fromCharCode(...bytes.slice(0, Math.min(bytes.length, 4096)))
        .replace(/^\ufeff/u, "");
      const svgOffset = prefix.search(/<svg(?:\s|>)/iu);
      return svgOffset >= 0 && !/<(?:script|iframe|object|embed)(?:\s|>)/iu.test(prefix);
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
    return {
      bytes,
      byteLength,
      dataBase64: encoded,
      height,
      mediaType,
      pixelCount,
      width,
    };
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
      const spaceBelow = Math.max(0, viewport.height - padding - anchorRect.bottom - gap);
      const spaceAbove = Math.max(0, anchorRect.top - gap - padding);
      const placeBelow = spaceBelow >= height ||
        (spaceAbove < height && spaceBelow > spaceAbove);
      top = placeBelow
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
    sourceDepth,
    requireJapaneseText = true,
    scanLength = LOOKUP_SCAN_LENGTH
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
    const normalizedScanLength = normalizeLookupScanLength(scanLength);
    const query = sliceCodePoints(sentence, matchOffset, normalizedScanLength);
    const hoveredToken = caretRange.startContainer.nodeType === windowRef.Node.TEXT_NODE
      ? sliceCodePoints(
          caretRange.startContainer.textContent || "",
          caretRange.startOffset,
          normalizedScanLength
        )
      : query;
    if (!query || (requireJapaneseText && !isJapaneseOnlyToken(hoveredToken))) {
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

  function resolveLookupCandidate(
    windowRef,
    documentRef,
    eventTarget,
    clientX,
    clientY,
    requireJapaneseText = true,
    scanLength = LOOKUP_SCAN_LENGTH
  ) {
    if (!(eventTarget instanceof windowRef.Element)) {
      return null;
    }
    const normalizedScanLength = normalizeLookupScanLength(scanLength);
    const textBox = eventTarget.closest('.text-box[data-selectable="true"]');
    if (textBox) {
      const block = textBox.closest(".text-block-container");
      const boxes = block
        ? Array.from(block.querySelectorAll('.text-box[data-selectable="true"]'))
        : [textBox];
      let sentence = "";
      let matchOffset = 0;
      let hoveredToken = "";
      for (const box of boxes) {
        const boxText = box.textContent || "";
        if (box === textBox) {
          const boxOffset = getUtf16OffsetForPoint(windowRef, box, clientX, clientY);
          matchOffset = sentence.length + boxOffset;
          hoveredToken = sliceCodePoints(boxText, boxOffset, normalizedScanLength);
        }
        sentence += boxText;
      }
      const query = sliceCodePoints(sentence, matchOffset, normalizedScanLength);
      if (!query || (requireJapaneseText && !isJapaneseOnlyToken(hoveredToken))) {
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
    let hoveredToken = "";
    const caretRange = typeof documentRef.caretRangeFromPoint === "function"
      ? documentRef.caretRangeFromPoint(clientX, clientY)
      : null;
    if (caretRange && mainText.contains(caretRange.startContainer)) {
      const prefixRange = documentRef.createRange();
      prefixRange.selectNodeContents(mainText);
      prefixRange.setEnd(caretRange.startContainer, caretRange.startOffset);
      matchOffset = prefixRange.toString().length;
      if (caretRange.startContainer.nodeType === windowRef.Node.TEXT_NODE) {
        hoveredToken = sliceCodePoints(
          caretRange.startContainer.textContent || "",
          caretRange.startOffset,
          normalizedScanLength
        );
      }
    }
    const query = sliceCodePoints(sentence, matchOffset, normalizedScanLength);
    if (!hoveredToken) {
      hoveredToken = query;
    }
    if (!query || (requireJapaneseText && !isJapaneseOnlyToken(hoveredToken))) {
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

  function elementForSelectionBoundary(windowRef, node) {
    if (node instanceof windowRef.Element) {
      return node;
    }
    return node && node.parentElement instanceof windowRef.Element
      ? node.parentElement
      : null;
  }

  function textOffsetWithinElement(documentRef, element, node, offset) {
    try {
      const prefix = documentRef.createRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(node, offset);
      return prefix.toString().length;
    } catch {
      return null;
    }
  }

  function resolveSelectedLookupCandidate(windowRef, documentRef, selection) {
    if (
      !selection ||
      selection.rangeCount !== 1 ||
      selection.isCollapsed
    ) {
      return null;
    }
    const selectedRange = selection.getRangeAt(0);
    if (!selectedRange || selectedRange.collapsed) {
      return null;
    }
    const startElement = elementForSelectionBoundary(
      windowRef,
      selectedRange.startContainer
    );
    const endElement = elementForSelectionBoundary(
      windowRef,
      selectedRange.endContainer
    );
    if (!startElement || !endElement) {
      return null;
    }

    const startBox = startElement.closest('.text-box[data-selectable="true"]');
    const endBox = endElement.closest('.text-box[data-selectable="true"]');
    let anchor;
    let sourceElements;
    let sentence;
    let matchOffset;
    let endOffset;
    let vertical = false;

    if (startBox && endBox) {
      const startBlock = startBox.closest(".text-block-container");
      const endBlock = endBox.closest(".text-block-container");
      if (!startBlock || startBlock !== endBlock) {
        return null;
      }
      sourceElements = Array.from(
        startBlock.querySelectorAll('.text-box[data-selectable="true"]')
      );
      const startIndex = sourceElements.indexOf(startBox);
      const endIndex = sourceElements.indexOf(endBox);
      if (startIndex < 0 || endIndex < startIndex) {
        return null;
      }
      const startLocalOffset = textOffsetWithinElement(
        documentRef,
        startBox,
        selectedRange.startContainer,
        selectedRange.startOffset
      );
      const endLocalOffset = textOffsetWithinElement(
        documentRef,
        endBox,
        selectedRange.endContainer,
        selectedRange.endOffset
      );
      if (startLocalOffset === null || endLocalOffset === null) {
        return null;
      }
      const lengths = sourceElements.map(
        (element) => (element.textContent || "").length
      );
      sentence = sourceElements
        .map((element) => element.textContent || "")
        .join("");
      matchOffset = lengths
        .slice(0, startIndex)
        .reduce((total, length) => total + length, 0) + startLocalOffset;
      endOffset = lengths
        .slice(0, endIndex)
        .reduce((total, length) => total + length, 0) + endLocalOffset;
      anchor = startBox;
      vertical = windowRef
        .getComputedStyle(startBox)
        .writingMode.startsWith("vertical");
    } else {
      const startText = startElement.closest("#text");
      const endText = endElement.closest("#text");
      if (!startText || startText !== endText) {
        return null;
      }
      matchOffset = textOffsetWithinElement(
        documentRef,
        startText,
        selectedRange.startContainer,
        selectedRange.startOffset
      );
      endOffset = textOffsetWithinElement(
        documentRef,
        startText,
        selectedRange.endContainer,
        selectedRange.endOffset
      );
      if (matchOffset === null || endOffset === null) {
        return null;
      }
      anchor = startText;
      sourceElements = [startText];
      sentence = startText.textContent || "";
      vertical = windowRef
        .getComputedStyle(startText)
        .writingMode.startsWith("vertical");
    }

    const query = sentence.slice(matchOffset, endOffset);
    if (
      !query.trim() ||
      query.includes("\u0000") ||
      utf8Length(query) > MAX_LOOKUP_TEXT_BYTES
    ) {
      return null;
    }
    let anchorRange;
    try {
      anchorRange = selectedRange.cloneRange();
    } catch {
      return null;
    }
    return {
      anchor,
      anchorRange,
      exactSelection: true,
      sourceElements,
      sentence,
      matchOffset,
      query,
      sourceDepth: -1,
      vertical,
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

  function createMiningRequestError(message, code = null, status = null) {
    const error = new Error(message);
    if (typeof code === "string" && code) {
      error.code = code;
    }
    if (Number.isInteger(status)) {
      error.status = status;
    }
    return error;
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
          throw createMiningRequestError(
            `GSM returned an invalid response (HTTP ${response.status}).`,
            null,
            response.status
          );
        }
        if (!isRecord(payload)) {
          throw new Error("GSM returned an invalid mining response.");
        }
        if (!response.ok) {
          throw createMiningRequestError(
            typeof payload.error === "string"
              ? payload.error
              : `GSM mining failed (HTTP ${response.status}).`,
            payload.code,
            response.status
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
      async check(payload) {
        const body = JSON.stringify(payload);
        if (utf8Length(body) > MAX_DUPLICATE_CHECK_REQUEST_BYTES) {
          throw createMiningRequestError(
            "Hoshidicts duplicate check is too large.",
            "invalid_note",
            413
          );
        }
        return await request("/api/hoshidicts/mining/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
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
      async browse(payload) {
        const body = JSON.stringify(payload);
        if (utf8Length(body) > MAX_LOOKUP_TEXT_BYTES) {
          throw new Error("Hoshidicts Anki browser request is too large.");
        }
        return await request("/api/hoshidicts/mining/browse", {
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

  function normalizeDictionaryPresentation(value, fallback = []) {
    if (!Array.isArray(value)) {
      return fallback.map((entry) => ({ ...entry }));
    }
    const normalized = [];
    const titles = new Set();
    for (const entry of value.slice(0, MAX_DICTIONARY_PRESENTATION_ENTRIES)) {
      if (!isRecord(entry)) {
        continue;
      }
      const title = boundedString(
        entry.title,
        MAX_DICTIONARY_PRESENTATION_TITLE_LENGTH
      );
      if (
        !title.trim() ||
        titles.has(title) ||
        typeof entry.favorite !== "boolean"
      ) {
        continue;
      }
      titles.add(title);
      const normalizedEntry = {
        title,
        favorite: entry.favorite,
      };
      const displayName = boundedString(
        entry.displayName,
        MAX_DICTIONARY_PRESENTATION_TITLE_LENGTH
      ).trim();
      if (displayName) {
        normalizedEntry.displayName = displayName;
      }
      if (
        entry.frequencyMode === "rank-based" ||
        entry.frequencyMode === "occurrence-based"
      ) {
        normalizedEntry.frequencyMode = entry.frequencyMode;
      }
      normalized.push(normalizedEntry);
    }
    return normalized;
  }

  function normalizeFrequencyDictionaries(value, fallback = []) {
    if (!Array.isArray(value)) {
      return [...fallback];
    }
    const normalized = [];
    const titles = new Set();
    for (const entry of value.slice(0, MAX_DICTIONARY_PRESENTATION_ENTRIES)) {
      const title = boundedString(
        entry,
        MAX_DICTIONARY_PRESENTATION_TITLE_LENGTH
      );
      if (!title.trim() || titles.has(title)) {
        continue;
      }
      titles.add(title);
      normalized.push(title);
    }
    return normalized;
  }

  function normalizeDictionaryTabGroups(value, fallback = []) {
    const groups = Array.isArray(value) ? value : fallback;
    return groups.map((group) => ({
      ...group,
      dictionaries: [...group.dictionaries],
    }));
  }

  function dictionaryPresentationEqual(left, right) {
    return left.length === right.length && left.every((entry, index) => {
      const other = right[index];
      return entry.title === other.title &&
        entry.favorite === other.favorite &&
        entry.displayName === other.displayName &&
        entry.frequencyMode === other.frequencyMode;
    });
  }

  function dictionaryTabGroupsEqual(left, right) {
    return left.length === right.length && left.every((group, index) => {
      const other = right[index];
      return group.id === other.id &&
        group.name === other.name &&
        group.dictionaries.length === other.dictionaries.length &&
        group.dictionaries.every(
          (dictionary, dictionaryIndex) =>
            dictionary === other.dictionaries[dictionaryIndex]
        );
    });
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

  function normalizePopupWidth(value, fallback = DEFAULT_POPUP_WIDTH_PX) {
    return Number.isInteger(value) &&
      value >= MIN_POPUP_WIDTH_PX &&
      value <= MAX_POPUP_WIDTH_PX
      ? value
      : fallback;
  }

  function normalizePopupHeight(value, fallback = DEFAULT_POPUP_HEIGHT_PX) {
    return Number.isInteger(value) &&
      value >= MIN_POPUP_HEIGHT_PX &&
      value <= MAX_POPUP_HEIGHT_PX
      ? value
      : fallback;
  }

  function normalizePopupColumns(value, fallback = DEFAULT_POPUP_COLUMNS) {
    return Number.isInteger(value) &&
      value >= MIN_POPUP_COLUMNS &&
      value <= MAX_POPUP_COLUMNS
      ? value
      : fallback;
  }

  function normalizePopupOpacityPercent(
    value,
    fallback = DEFAULT_POPUP_OPACITY_PERCENT
  ) {
    return Number.isInteger(value) &&
      value >= MIN_POPUP_OPACITY_PERCENT &&
      value <= MAX_POPUP_OPACITY_PERCENT
      ? value
      : fallback;
  }

  function normalizePopupBackdropBlurPx(
    value,
    fallback = DEFAULT_POPUP_BACKDROP_BLUR_PX
  ) {
    return Number.isInteger(value) &&
      value >= MIN_POPUP_BACKDROP_BLUR_PX &&
      value <= MAX_POPUP_BACKDROP_BLUR_PX
      ? value
      : fallback;
  }

  function normalizePopupToolbarPosition(
    value,
    fallback = DEFAULT_POPUP_TOOLBAR_POSITION
  ) {
    return value === "top" || value === "bottom" ? value : fallback;
  }

  function normalizeTheme(value, fallback = DEFAULT_THEME) {
    return THEMES.has(value) ? value : fallback;
  }

  function normalizeCustomPopupCss(value, fallback = "") {
    return typeof value === "string"
      ? value.slice(0, MAX_CUSTOM_POPUP_CSS_LENGTH)
      : fallback;
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
    const checkMiningNotes =
      typeof options.checkMiningNotes === "function"
        ? options.checkMiningNotes
        : null;
    const onMine =
      typeof options.onMine === "function"
        ? options.onMine
        : null;
    const onBrowse =
      typeof options.onBrowse === "function"
        ? options.onBrowse
        : null;
    const onOpenExternalLink =
      typeof options.onOpenExternalLink === "function"
        ? options.onOpenExternalLink
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
      scanLength: normalizeLookupScanLength(options.scanLength),
      maxResults: normalizeLookupMaxResults(options.maxResults),
      sortFrequencyDictionary: normalizeSortFrequencyDictionary(
        options.sortFrequencyDictionary
      ),
      sortFrequencyDictionaryOrder: normalizeSortFrequencyDictionaryOrder(
        options.sortFrequencyDictionaryOrder
      ),
      activationKey: normalizeActivationKey(options.activationKey),
      sourceHighlightEnabled: options.sourceHighlightEnabled === true,
      onlyScanJapaneseText: options.onlyScanJapaneseText === undefined
        ? DEFAULT_ONLY_SCAN_JAPANESE_TEXT
        : options.onlyScanJapaneseText !== false,
      popupHideDelayMs: normalizePopupHideDelay(options.popupHideDelayMs),
      showLookupCounts: options.showLookupCounts !== false,
      averageFrequency: options.averageFrequency === true,
      showFrequencyDictionaryNames:
        options.showFrequencyDictionaryNames !== false,
      showCompactDefinitionSummary:
        options.showCompactDefinitionSummary === true,
      compactDefinitionSummaryCount: normalizeCompactDefinitionSummaryCount(
        options.compactDefinitionSummaryCount
      ),
      hidePopupGrammarTags:
        options.hidePopupGrammarTags === undefined
          ? DEFAULT_HIDE_POPUP_GRAMMAR_TAGS
          : options.hidePopupGrammarTags !== false,
      compactDefinitionSummaryDictionary:
        normalizeCompactDefinitionSummaryDictionary(
          options.compactDefinitionSummaryDictionary
        ),
      showPitchAccentFurigana:
        options.showPitchAccentFurigana === undefined
          ? DEFAULT_SHOW_PITCH_ACCENT_FURIGANA
          : options.showPitchAccentFurigana !== false,
      pitchAccentFuriganaDictionary:
        normalizeCompactDefinitionSummaryDictionary(
          options.pitchAccentFuriganaDictionary
        ),
      showPitchAccentBadge:
        options.showPitchAccentBadge === undefined
          ? DEFAULT_SHOW_PITCH_ACCENT_BADGE
          : options.showPitchAccentBadge === true,
      definitionBlur: normalizeDefinitionBlurPreferences(options.definitionBlur),
      popupNestingMaxDepth: normalizePopupNestingMaxDepth(
        options.popupNestingMaxDepth
      ),
      popupWidthPx: normalizePopupWidth(options.popupWidthPx),
      popupHeightPx: normalizePopupHeight(options.popupHeightPx),
      popupColumns: normalizePopupColumns(options.popupColumns),
      popupOpacityPercent: normalizePopupOpacityPercent(
        options.popupOpacityPercent
      ),
      popupBackdropBlurPx: normalizePopupBackdropBlurPx(
        options.popupBackdropBlurPx
      ),
      popupToolbarPosition: normalizePopupToolbarPosition(
        options.popupToolbarPosition
      ),
      theme: normalizeTheme(options.theme),
      customPopupCss: normalizeCustomPopupCss(options.customPopupCss),
      dictionaryPresentation: normalizeDictionaryPresentation(
        options.dictionaryPresentation
      ),
      frequencyDictionaries: normalizeFrequencyDictionaries(
        options.frequencyDictionaries
      ),
      dictionaryTabGroups: normalizeDictionaryTabGroups(
        options.dictionaryTabGroups
      ),
      popupButtons: normalizePopupButtons(options.popupButtons),
    };
    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let lookupTimeoutTimer = null;
    let hideTimer = null;
    let descendantHideTimer = null;
    let popupTransferTimer = null;
    let pendingHideReason = "pointer-left";
    let pendingPruneDepth = 1;
    let destroyed = false;
    let localShiftPressed = false;
    let globalActivationKeyPressed = options.activationKeyPressed === true;
    let selectionDragActive = false;
    let activeSelectionCandidate = null;
    let pointerInPopup = false;
    let pointerPopupDepth = null;
    let lastPointer = null;
    let requestSequence = 0;
    let stylesRequestSequence = 0;
    let pendingStylesRequest = null;
    let dictionaryStylesGeneration = null;
    let latestRequestId = null;
    let latestCandidate = null;
    let latestCandidateSignature = "";
    let latestTargetDepth = 0;
    let latestGeneration = 0;
    let lookupStatsGeneration = 0;
    let latestRequestMode = "term-first";
    let latestRequestText = "";
    let latestRequestPrimaryReading = "";
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
    const hoveredPopupDepths = new Set();
    const dictionaryStyleElements = [];
    const dictionaryStylesByDictionary = new Map();
    const customPopupStyleElement = documentRef.createElement("style");
    customPopupStyleElement.dataset.hoshidictsCustomPopupStyle = "true";
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

    function applyAppearancePreferences(reposition = true) {
      const rootElement = documentRef.documentElement;
      rootElement.dataset.hoshidictsTheme = preferences.theme;
      rootElement.style.setProperty(
        "--gsm-hoshidicts-popup-width",
        `${preferences.popupWidthPx}px`
      );
      rootElement.style.setProperty(
        "--gsm-hoshidicts-popup-height",
        `${preferences.popupHeightPx}px`
      );
      rootElement.style.setProperty(
        "--gsm-hoshidicts-popup-opacity",
        `${preferences.popupOpacityPercent}%`
      );
      rootElement.style.setProperty(
        "--gsm-hoshidicts-popup-backdrop-filter",
        preferences.popupBackdropBlurPx === 0
          ? "none"
          : `blur(${preferences.popupBackdropBlurPx}px) saturate(1.08)`
      );
      rootElement.style.setProperty(
        "--gsm-hoshidicts-popup-columns",
        String(preferences.popupColumns)
      );
      for (const level of popupLevels) {
        level.popup.style.width = `${preferences.popupWidthPx}px`;
        level.popup.style.height = `${preferences.popupHeightPx}px`;
      }
      if (reposition) {
        positionAllPopups();
      }
    }

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

    function isSelectableGsmTextTarget(target) {
      return target instanceof windowRef.Element && Boolean(
        target.closest('.text-box[data-selectable="true"], #text')
      );
    }

    function activeSelectionIsUnchanged() {
      if (!activeSelectionCandidate?.anchorRange) {
        return false;
      }
      const selection = typeof windowRef.getSelection === "function"
        ? windowRef.getSelection()
        : null;
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        return false;
      }
      const range = selection.getRangeAt(0);
      const anchorRange = activeSelectionCandidate.anchorRange;
      return (
        range.startContainer === anchorRange.startContainer &&
        range.startOffset === anchorRange.startOffset &&
        range.endContainer === anchorRange.endContainer &&
        range.endOffset === anchorRange.endOffset
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
        audioAutoplayBlocked: true,
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
        context.audioAutoplayBlocked = false;
        revealDefinitions(context, "invalid-lookup-count");
        return;
      }
      if (lookupCount < context.preferences.lookupThreshold) {
        context.audioAutoplayBlocked = false;
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
      if (context.hovered) {
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
        !(event.target instanceof windowRef.Element) ||
        !event.target.closest(
          ".gsm-hoshidicts-definitions, " +
          ".gsm-hoshidicts-compact-definition-summary"
        )
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

    function clearPopupTransferTimer() {
      if (popupTransferTimer !== null) {
        clearTimeoutFn(popupTransferTimer);
        popupTransferTimer = null;
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

    function clearDictionaryStyles() {
      pendingStylesRequest = null;
      dictionaryStylesGeneration = null;
      dictionaryStylesByDictionary.clear();
      for (const element of dictionaryStyleElements.splice(0)) {
        element.remove();
      }
    }

    function applyCustomPopupCss() {
      if (!preferences.customPopupCss) {
        customPopupStyleElement.textContent = "";
        customPopupStyleElement.remove();
        return;
      }
      customPopupStyleElement.textContent = [
        "@scope (.gsm-hoshidicts-popup) {",
        preferences.customPopupCss,
        "}",
      ].join("\n");
      documentRef.head.appendChild(customPopupStyleElement);
    }

    function cssAttributeString(value) {
      return `"${value
        .replace(/\\/gu, "\\\\")
        .replace(/"/gu, '\\"')}"`;
    }

    function applyDictionaryStyles(generation, entries) {
      clearDictionaryStyles();
      for (const entry of entries) {
        dictionaryStylesByDictionary.set(entry.dictionary, entry.styles);
        const style = documentRef.createElement("style");
        style.dataset.hoshidictsDictionaryStyle = entry.dictionary;
        style.dataset.hoshidictsGeneration = String(generation);
        style.textContent = [
          `@scope (.gsm-hoshidicts-glossary-content[data-hoshidicts-dictionary=${cssAttributeString(entry.dictionary)}]) {`,
          entry.styles,
          "}",
        ].join("\n");
        documentRef.head.appendChild(style);
        dictionaryStyleElements.push(style);
      }
      applyCustomPopupCss();
      dictionaryStylesGeneration = generation;
      positionPopupAndDescendants(0);
    }

    function requestDictionaryStyles(generation) {
      if (
        destroyed ||
        dictionaryStylesGeneration === generation ||
        pendingStylesRequest?.generation === generation ||
        !socket ||
        socket.readyState !== WebSocketImpl.OPEN
      ) {
        return;
      }
      const requestId = `overlay-styles-${++stylesRequestSequence}`;
      pendingStylesRequest = { generation, requestId };
      socket.send(JSON.stringify({
        type: "hoshidicts_styles",
        requestId,
        generation,
      }));
    }

    function handleDictionaryStylesResponse(payload, serializedLength) {
      const pending = pendingStylesRequest;
      if (!pending || payload.requestId !== pending.requestId) {
        return;
      }
      pendingStylesRequest = null;
      if (
        serializedLength > MAX_STYLES_RESPONSE_BYTES ||
        payload.success !== true ||
        payload.generation !== pending.generation ||
        payload.generation !== activeDictionaryGeneration ||
        !Array.isArray(payload.styles) ||
        payload.styles.length > MAX_DICTIONARY_STYLES
      ) {
        diagnostic("warn", "styles.rejected", {
          generation: payload.generation,
          success: payload.success === true,
        });
        return;
      }
      let totalBytes = 0;
      const entries = [];
      const dictionaries = new Set();
      for (const rawEntry of payload.styles) {
        if (!isRecord(rawEntry)) {
          return;
        }
        const dictionary = boundedString(rawEntry.dictionary, 4096);
        const styles = boundedString(rawEntry.styles, MAX_DICTIONARY_STYLE_BYTES + 1);
        const styleBytes = utf8Length(styles);
        totalBytes += styleBytes;
        if (
          !dictionary ||
          dictionaries.has(dictionary) ||
          styleBytes > MAX_DICTIONARY_STYLE_BYTES ||
          totalBytes > MAX_DICTIONARY_STYLES_BYTES
        ) {
          diagnostic("warn", "styles.invalid-entry", { dictionary });
          return;
        }
        dictionaries.add(dictionary);
        if (styles) {
          entries.push({ dictionary, styles });
        }
      }
      applyDictionaryStyles(pending.generation, entries);
      diagnostic("info", "styles.applied", {
        generation: pending.generation,
        styleCount: entries.length,
      });
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
        requestDictionaryStyles(generation);
        return;
      }
      clearMediaState("dictionary_generation_changed");
      clearDictionaryStyles();
      activeDictionaryGeneration = generation;
      requestDictionaryStyles(generation);
    }

    function cacheMedia(job, url, byteLength, pixelCount, metadata = {}) {
      const existing = mediaCache.get(job.cacheKey);
      if (existing) {
        mediaCacheBytes -= existing.byteLength;
        revokeCachedMedia(existing);
        mediaCache.delete(job.cacheKey);
      }
      const entry = {
        byteLength,
        pixelCount,
        url,
        dataBase64: metadata.dataBase64,
        mediaType: metadata.mediaType,
      };
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

    function resolveMediaJob(job, url, byteLength, pixelCount, metadata = {}) {
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
        cacheMedia(job, url, byteLength, pixelCount, metadata);
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
      latestRequestPrimaryReading = "";
      latestCandidateSignature = "";
      clearLookupTimeout();
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

    function pointInsideRect(clientX, clientY, rect, padding = 0) {
      return Number.isFinite(clientX) && Number.isFinite(clientY) &&
        clientX >= rect.left - padding && clientX <= rect.right + padding &&
        clientY >= rect.top - padding && clientY <= rect.bottom + padding;
    }

    function pointInsidePopupChain(clientX, clientY) {
      const visibleLevels = popupLevels.filter((level) => level.visible);
      const rects = visibleLevels.map((level) => ({
        depth: level.depth,
        rect: level.popup.getBoundingClientRect(),
      }));
      if (rects.some(({ rect }) => pointInsideRect(clientX, clientY, rect))) {
        return true;
      }
      for (let index = 1; index < rects.length; index += 1) {
        const parent = rects[index - 1].rect;
        const child = rects[index].rect;
        const top = Math.max(parent.top, child.top) - 4;
        const bottom = Math.min(parent.bottom, child.bottom) + 4;
        if (top > bottom) {
          continue;
        }
        let left;
        let right;
        if (parent.right <= child.left) {
          left = parent.right;
          right = child.left;
        } else if (child.right <= parent.left) {
          left = child.right;
          right = parent.left;
        } else {
          continue;
        }
        if (
          clientX >= left - 2 && clientX <= right + 2 &&
          clientY >= top && clientY <= bottom
        ) {
          return true;
        }
      }
      return false;
    }

    function targetInsidePopupChain(target) {
      return getPopupDepthForTarget(target) !== null || Boolean(
        target instanceof windowRef.Element &&
        target.closest(".gsm-hoshidicts-audio-menu")
      );
    }

    function schedulePopupTransferCheck(reason) {
      clearPopupTransferTimer();
      popupTransferTimer = setTimeoutFn(() => {
        popupTransferTimer = null;
        if (
          hoveredPopupDepths.size > 0 ||
          targetInsidePopupChain(lastPointer?.target) ||
          pointInsidePopupChain(lastPointer?.clientX, lastPointer?.clientY)
        ) {
          return;
        }
        pointerInPopup = false;
        pointerPopupDepth = null;
        scheduleHide(reason);
      }, POPUP_TRANSFER_GRACE_MS);
    }

    function onPopupPointerEnter(depth) {
      // Popup levels are sibling overlays, so the pointer can only occupy one
      // level at a time. Clear stale ownership in case a removed popup never
      // delivered its matching pointerleave event.
      hoveredPopupDepths.clear();
      hoveredPopupDepths.add(depth);
      pointerInPopup = true;
      pointerPopupDepth = depth;
      clearPopupTransferTimer();
      clearHideTimer();
      if (descendantHideTimer !== null && depth >= pendingPruneDepth) {
        clearDescendantHideTimer();
      }
    }

    function onPopupPointerLeave(depth, event) {
      hoveredPopupDepths.delete(depth);
      if (pointerPopupDepth === depth) {
        pointerPopupDepth = hoveredPopupDepths.size > 0
          ? Math.max(...hoveredPopupDepths)
          : null;
      }
      pointerInPopup = hoveredPopupDepths.size > 0;
      if (targetInsidePopupChain(event?.relatedTarget)) {
        clearPopupTransferTimer();
        clearHideTimer();
        return;
      }
      if (pointerInPopup) {
        return;
      }
      if (popupLevels.filter((level) => level.visible).length > 1) {
        schedulePopupTransferCheck("popup-left");
      } else {
        scheduleHide("popup-left");
      }
    }

    function createPopupLevel(depth) {
      const popup = documentRef.createElement("section");
      popup.id = depth === 0
        ? "gsm-hoshidicts-popup"
        : `gsm-hoshidicts-popup-${depth}`;
      popup.className = "gsm-hoshidicts-popup interactive";
      popup.dataset.hoshidictsDepth = String(depth);
      popup.style.width = `${preferences.popupWidthPx}px`;
      popup.style.height = `${preferences.popupHeightPx}px`;
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-label", "Hoshidicts lookup");
      popup.hidden = true;
      if (depth > 0) {
        popup.style.zIndex = "2147483647";
      }
      const stopPropagation = (event) => event.stopPropagation();
      const pointerEnter = () => onPopupPointerEnter(depth);
      const pointerLeave = (event) => onPopupPointerLeave(depth, event);
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
        miningCheckError: null,
        miningRefreshPromise: null,
        miningStatusGeneration: 0,
        miningItems: [],
        miningFeedback: null,
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
        toolbarPosition: preferences.popupToolbarPosition,
        popupButtons: preferences.popupButtons,
        positionPopup: () => positionPopupAndDescendants(depth),
        onMineClick(button, result, candidate, feedback) {
          void mineResult(button, result, candidate, feedback);
        },
        onBrowseClick(button, result, feedback) {
          void browseResult(button, result, feedback);
        },
        onCustomLinkClick(link, result, candidate, feedback) {
          void openCustomLink(link, result, candidate, feedback);
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
        onResultsRendered({
          audioItems,
          feedback,
          lookupStats,
          miningButtons,
          miningItems,
        }) {
          level.miningCheckError = null;
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
          level.miningItems = miningItems;
          level.miningFeedback = feedback;
          syncAudioRenderedResults(depth, true);
          void startMiningRefresh(level, miningItems, feedback);
        },
        onResultsExpanded({
          appendedMiningButtons,
          appendedMiningItems,
          audioItems,
          feedback,
          miningItems,
        }) {
          const refreshActive = level.miningRefreshPromise !== null;
          const appendedButtons = new Set(appendedMiningButtons);
          const existingButtonVisible = miningItems.some(
            ({ button }) => !appendedButtons.has(button) && !button.hidden
          );
          for (const button of appendedMiningButtons) {
            button.hidden = !(refreshActive && existingButtonVisible);
          }
          level.audioItems = audioItems;
          level.miningItems = miningItems;
          level.miningFeedback = feedback;
          syncAudioRenderedResults(depth, false);
          if (level.miningCheckError) {
            for (const button of appendedMiningButtons) {
              button.hidden = false;
              setMiningButtonState(button, "error", level.miningCheckError);
            }
            return;
          }
          if (!refreshActive) {
            void startMiningRefresh(level, appendedMiningItems, feedback);
          }
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
        {
          autoPlay: autoPlay && !preferredLevel?.definitionBlurContext
            ?.audioAutoplayBlocked
        }
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
        hoveredPopupDepths.delete(index);
        const level = popupLevels[index];
        invalidateDefinitionBlur(level);
        level.lookupStatsRequestGeneration += 1;
        level.lookupStatsPayload = null;
        level.miningCheckError = null;
        level.miningStatusGeneration += 1;
        level.miningItems = [];
        level.miningFeedback = null;
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
        pointerPopupDepth = hoveredPopupDepths.size > 0
          ? Math.max(...hoveredPopupDepths)
          : null;
        pointerInPopup = hoveredPopupDepths.size > 0;
      }
      audioController.dismissPopup();
      syncAudioRenderedResults(null, false);
      diagnostic("debug", "popup.pruned", { depth: startDepth, reason });
    }

    function hide(reason = "hide") {
      selectionDragActive = false;
      activeSelectionCandidate = null;
      clearHideTimer();
      clearDescendantHideTimer();
      clearPopupTransferTimer();
      hoveredPopupDepths.clear();
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
      const popupSize = {
        width: preferences.popupWidthPx,
        height: preferences.popupHeightPx,
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
      level.popup.style.width = `${position.width}px`;
      level.popup.style.height = `${position.height}px`;
      level.popup.style.maxWidth = "none";
      level.popup.style.maxHeight = "none";
      level.popup.style.minHeight = "0";
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
      level.miningItems = [];
      level.miningFeedback = null;
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
      const primaryResult = results[0];
      expandCandidateAnchor(
        candidate,
        primaryResult.matched || primaryResult.term.expression
      );
      const level = ensurePopupLevel(targetDepth);
      const definitionBlurContext = beginDefinitionBlur(level);
      level.lookupStatsRequestGeneration += 1;
      level.lookupStatsPayload = null;
      level.termView = {
        results,
        candidate,
        dictionaryGeneration,
        highlightText: primaryResult.matched || primaryResult.term.expression,
        signature,
        definitionBlurContext,
      };
      const rendered = level.view.renderResults(results, candidate, {
        definitionBlurState: getDefinitionBlurState(definitionBlurContext),
        generation: dictionaryGeneration,
        showLookupCounts: preferences.showLookupCounts && Boolean(onLookup),
        averageFrequency: preferences.averageFrequency,
        showFrequencyDictionaryNames:
          preferences.showFrequencyDictionaryNames,
        showCompactDefinitionSummary:
          preferences.showCompactDefinitionSummary,
        compactDefinitionSummaryCount:
          preferences.compactDefinitionSummaryCount,
        hidePopupGrammarTags: preferences.hidePopupGrammarTags,
        compactDefinitionSummaryDictionary:
          preferences.compactDefinitionSummaryDictionary,
        showPitchAccentFurigana: preferences.showPitchAccentFurigana,
        pitchAccentFuriganaDictionary:
          preferences.pitchAccentFuriganaDictionary,
        showPitchAccentBadge: preferences.showPitchAccentBadge,
        dictionaryPresentation: preferences.dictionaryPresentation,
        dictionaryTabGroups: preferences.dictionaryTabGroups,
        onInternalLink: (link) => openStructuredLink(link, targetDepth),
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
      level.miningItems = rendered.miningItems;
      level.miningFeedback = rendered.feedback;
      showPopup(candidate, targetDepth);
      startDefinitionBlurDeadline(definitionBlurContext);
      recordLookup(primaryResult, definitionBlurContext, level);
      syncAudioRenderedResults(targetDepth, true);
      void startMiningRefresh(level, rendered.miningItems, rendered.feedback);
    }

    function restoreTermView(targetDepth, { autoPlay = true } = {}) {
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
      const selectedTab = level.popup.querySelector(
        '[role="tab"][aria-selected="true"]'
      );
      const selectedDictionaryTab = selectedTab?.dataset.dictionary
        ? { dictionary: selectedTab.dataset.dictionary }
        : selectedTab?.dataset.groupId
          ? { groupId: selectedTab.dataset.groupId }
          : null;
      preparePopupContent("restore_term_results", targetDepth);
      const rendered = level.view.renderResults(results, candidate, {
        definitionBlurState: getDefinitionBlurState(definitionBlurContext),
        generation: dictionaryGeneration,
        showLookupCounts: preferences.showLookupCounts && Boolean(onLookup),
        averageFrequency: preferences.averageFrequency,
        showFrequencyDictionaryNames:
          preferences.showFrequencyDictionaryNames,
        showCompactDefinitionSummary:
          preferences.showCompactDefinitionSummary,
        compactDefinitionSummaryCount:
          preferences.compactDefinitionSummaryCount,
        hidePopupGrammarTags: preferences.hidePopupGrammarTags,
        compactDefinitionSummaryDictionary:
          preferences.compactDefinitionSummaryDictionary,
        showPitchAccentFurigana: preferences.showPitchAccentFurigana,
        pitchAccentFuriganaDictionary:
          preferences.pitchAccentFuriganaDictionary,
        showPitchAccentBadge: preferences.showPitchAccentBadge,
        selectedDictionaryTab,
        dictionaryPresentation: preferences.dictionaryPresentation,
        dictionaryTabGroups: preferences.dictionaryTabGroups,
        onInternalLink: (link) => openStructuredLink(link, targetDepth),
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
      level.miningItems = rendered.miningItems;
      level.miningFeedback = rendered.feedback;
      showPopup(candidate, targetDepth);
      syncAudioRenderedResults(targetDepth, autoPlay);
      void startMiningRefresh(level, rendered.miningItems, rendered.feedback);
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

    function miningResultWithFrequencyModes(result) {
      const frequencyModes = new Map(
        preferences.dictionaryPresentation
          .filter((entry) => typeof entry.frequencyMode === "string")
          .map((entry) => [entry.title, entry.frequencyMode])
      );
      if (frequencyModes.size === 0) {
        return result;
      }
      return {
        ...result,
        term: {
          ...result.term,
          frequencies: result.term.frequencies.map((group) => {
            const frequencyMode = frequencyModes.get(group.dictionary);
            return frequencyMode ? { ...group, frequencyMode } : group;
          }),
        },
      };
    }

    function createMiningBasePayload(item, extra = {}) {
      const payload = {
        result: miningResultWithFrequencyModes(item.result),
        sentence: item.candidate.sentence,
        matchOffset: item.candidate.matchOffset,
        frequencyDictionaries: [...preferences.frequencyDictionaries],
        ...extra,
      };
      const aliases = getMiningDictionaryAliases(item.result);
      if (aliases.length > 0) {
        payload.dictionaryAliases = aliases;
      }
      if (typeof item.candidate.query === "string" && item.candidate.query) {
        payload.searchQuery = item.candidate.query;
      }
      const selection = typeof windowRef.getSelection === "function"
        ? boundedString(windowRef.getSelection()?.toString(), MAX_TEXT_LENGTH)
        : "";
      if (selection) {
        payload.popupSelectionText = selection;
      }
      if (documentRef.title) {
        payload.documentTitle = boundedString(documentRef.title, 4096);
      }
      return payload;
    }

    function getMiningDictionaryAliases(result) {
      const aliases = new Map(
        preferences.dictionaryPresentation
          .filter((entry) => typeof entry.displayName === "string" && entry.displayName)
          .map((entry) => [entry.title, entry.displayName])
      );
      const term = isRecord(result?.term) ? result.term : {};
      const dictionaryGroups = [
        ...(Array.isArray(term.glossaries) ? term.glossaries : []),
        ...(Array.isArray(term.frequencies) ? term.frequencies : []),
        ...(Array.isArray(term.pitches) ? term.pitches : []),
      ];
      const output = [];
      const seen = new Set();
      for (const group of dictionaryGroups) {
        const dictionary = isRecord(group) && typeof group.dictionary === "string"
          ? group.dictionary
          : "";
        const alias = aliases.get(dictionary);
        if (dictionary && alias && alias !== dictionary && !seen.has(dictionary)) {
          seen.add(dictionary);
          output.push({ dictionary, alias });
        }
      }
      return output;
    }

    function getStructuredMediaReferences(result) {
      const glossaries = isRecord(result?.term) && Array.isArray(result.term.glossaries)
        ? result.term.glossaries
        : [];
      const output = [];
      const seen = new Set();
      const visit = (value, dictionary, state) => {
        if (state.nodes >= MAX_STRUCTURED_NODES) {
          return;
        }
        state.nodes += 1;
        if (Array.isArray(value)) {
          for (const item of value) {
            visit(item, dictionary, state);
          }
          return;
        }
        if (!isRecord(value)) {
          return;
        }
        const tag = typeof value.tag === "string" ? value.tag.toLowerCase() : "";
        if (value.type === "image" || tag === "img") {
          const path = normalizeMediaPath(value.path);
          const key = `${dictionary}\u0000${path}`;
          if (path && !seen.has(key)) {
            seen.add(key);
            output.push({ dictionary, path });
          }
        }
        if (Object.prototype.hasOwnProperty.call(value, "content")) {
          visit(value.content, dictionary, state);
        }
      };
      for (const glossary of glossaries) {
        if (!isRecord(glossary) || typeof glossary.dictionary !== "string") {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(glossary.glossary);
        } catch {
          continue;
        }
        visit(parsed, glossary.dictionary, { nodes: 0 });
      }
      return output;
    }

    function getCachedMiningDictionaryMedia(result, generation) {
      if (generation === null || generation !== activeDictionaryGeneration) {
        return [];
      }
      const references = getStructuredMediaReferences(result);
      return references.flatMap(({ dictionary, path }) => {
        const cached = mediaCache.get(mediaCacheKey(generation, dictionary, path));
        return cached && typeof cached.dataBase64 === "string" &&
          typeof cached.mediaType === "string"
          ? [{ dictionary, path, mediaType: cached.mediaType, dataBase64: cached.dataBase64 }]
          : [];
      });
    }

    async function getMiningDictionaryMedia(result, generation, depth, references) {
      await Promise.allSettled(
        references.map(({ dictionary, path }) =>
          resolveMedia({ depth, dictionary, generation, path })
        )
      );
      return getCachedMiningDictionaryMedia(result, generation);
    }

    function getMiningDictionaryStyles(result, generation) {
      if (
        generation === null ||
        generation !== activeDictionaryGeneration ||
        generation !== dictionaryStylesGeneration ||
        dictionaryStylesByDictionary.size === 0
      ) {
        return [];
      }
      const term = isRecord(result) && isRecord(result.term) ? result.term : null;
      const glossaries = term && Array.isArray(term.glossaries)
        ? term.glossaries
        : [];
      const styles = [];
      const seen = new Set();
      for (const glossary of glossaries) {
        const dictionary = isRecord(glossary) && typeof glossary.dictionary === "string"
          ? glossary.dictionary
          : "";
        if (!dictionary || seen.has(dictionary)) {
          continue;
        }
        seen.add(dictionary);
        const stylesheet = dictionaryStylesByDictionary.get(dictionary);
        if (typeof stylesheet === "string" && stylesheet) {
          styles.push({ dictionary, styles: stylesheet });
        }
      }
      return styles;
    }

    function attachDictionaryStylesWithinBudget(payload, styles, byteBudget) {
      if (styles.length === 0 || byteBudget <= 0) {
        return { payload, bytesAdded: 0 };
      }
      const propertyBytes = utf8Length(',"dictionaryStyles":[]');
      const included = [];
      let bytesAdded = 0;
      for (const entry of styles) {
        const entryBytes = utf8Length(JSON.stringify(entry));
        const nextBytes = entryBytes + (included.length === 0 ? propertyBytes : 1);
        if (bytesAdded + nextBytes > byteBudget) {
          continue;
        }
        included.push(entry);
        bytesAdded += nextBytes;
      }
      return included.length === 0
        ? { payload, bytesAdded: 0 }
        : {
            payload: { ...payload, dictionaryStyles: included },
            bytesAdded,
          };
    }

    function attachDictionaryMediaWithinBudget(payload, media, byteBudget) {
      if (media.length === 0 || byteBudget <= 0) {
        return { payload, bytesAdded: 0 };
      }
      const propertyBytes = utf8Length(',"dictionaryMedia":[]');
      const included = [];
      let bytesAdded = 0;
      for (const entry of media) {
        const entryBytes = utf8Length(JSON.stringify(entry));
        const nextBytes = entryBytes + (included.length === 0 ? propertyBytes : 1);
        if (bytesAdded + nextBytes > byteBudget) {
          continue;
        }
        included.push(entry);
        bytesAdded += nextBytes;
      }
      return included.length === 0
        ? { payload, bytesAdded: 0 }
        : { payload: { ...payload, dictionaryMedia: included }, bytesAdded };
    }

    function createDuplicateCheckPayload(level, miningItems) {
      const notes = miningItems.map((item) => createMiningBasePayload(item));
      let remainingBytes = MAX_DUPLICATE_CHECK_REQUEST_BYTES - utf8Length(
        JSON.stringify({ notes })
      );
      const generation = level.termView?.dictionaryGeneration ?? null;
      for (let index = 0; index < notes.length && remainingBytes > 0; index += 1) {
        const media = getCachedMiningDictionaryMedia(
          miningItems[index].result,
          generation
        );
        const mediaAttachment = attachDictionaryMediaWithinBudget(
          notes[index],
          media,
          remainingBytes
        );
        notes[index] = mediaAttachment.payload;
        remainingBytes -= mediaAttachment.bytesAdded;
        const { payload, bytesAdded } = attachDictionaryStylesWithinBudget(
          notes[index],
          getMiningDictionaryStyles(miningItems[index].result, generation),
          remainingBytes
        );
        notes[index] = payload;
        remainingBytes -= bytesAdded;
      }
      return { notes };
    }

    function isLiveMiningRender(level, generation, feedback) {
      return (
        !destroyed &&
        popupLevels[level.depth] === level &&
        generation === level.miningStatusGeneration &&
        level.miningFeedback === feedback &&
        feedback.isConnected
      );
    }

    function isNoteSpecificMiningCheckError(error) {
      return [400, 409, 413, 422].includes(error?.status);
    }

    function applyDuplicateCheckResult(button, duplicateInfo, noteInfo) {
      const duplicateBehavior = ["prevent", "overwrite", "new"].includes(
        duplicateInfo.duplicateBehavior
      )
        ? duplicateInfo.duplicateBehavior
        : duplicateInfo.duplicatePolicy === "allow"
          ? "new"
          : "prevent";
      const message = typeof noteInfo.error === "string"
        ? noteInfo.error
        : "";
      const duplicate = noteInfo.duplicate === true ||
        noteInfo.state === "duplicate";
      if (duplicate) {
        const duplicateState = noteInfo.canAdd === true
          ? duplicateBehavior === "overwrite"
            ? "overwrite"
            : "add-duplicate"
          : "duplicate";
        setMiningButtonState(
          button,
          duplicateState,
          message || (
            duplicateState === "overwrite"
              ? "Overwrite note in Anki"
              : duplicateState === "add-duplicate"
                ? "Add duplicate to Anki"
                : "Note already exists"
          )
        );
      } else if (
        noteInfo.state === "addable" &&
        noteInfo.canAdd === true
      ) {
        setMiningButtonState(button, "ready");
      } else {
        setMiningButtonState(
          button,
          "error",
          message || "Anki cannot add this note."
        );
      }
    }

    async function refreshMiningButtons(level, miningItems, feedback) {
      const generation = ++level.miningStatusGeneration;
      if (!preferences.popupButtons.addToAnki) {
        for (const { button } of miningItems) {
          button.hidden = true;
        }
        return;
      }
      const status = await getCachedMiningStatus();
      if (!isLiveMiningRender(level, generation, feedback)) {
        return;
      }
      if (status && status.available === true && onMine) {
        for (const { button } of miningItems) {
          button.hidden = false;
          setMiningButtonState(
            button,
            "checking",
            miningInFlight ? "Another note is being added" : ""
          );
        }
        if (miningInFlight) {
          return;
        }
        if (!checkMiningNotes) {
          for (const { button } of miningItems) {
            setMiningButtonState(button, "ready");
          }
          return;
        }
        for (let index = 0; index < miningItems.length; index += 1) {
          if (!isLiveMiningRender(level, generation, feedback)) {
            return;
          }
          const miningItem = miningItems[index];
          try {
            const duplicateInfo = await checkMiningNotes(
              createDuplicateCheckPayload(level, [miningItem])
            );
            if (
              !isRecord(duplicateInfo) ||
              duplicateInfo.success !== true ||
              !Array.isArray(duplicateInfo.results) ||
              duplicateInfo.results.length !== 1 ||
              !isRecord(duplicateInfo.results[0])
            ) {
              throw createMiningRequestError(
                isRecord(duplicateInfo) && typeof duplicateInfo.error === "string"
                  ? duplicateInfo.error
                  : "GSM returned an invalid duplicate-check response.",
                isRecord(duplicateInfo) ? duplicateInfo.code : null,
                isRecord(duplicateInfo) ? duplicateInfo.status : null
              );
            }
            if (!isLiveMiningRender(level, generation, feedback)) {
              return;
            }
            applyDuplicateCheckResult(
              miningItem.button,
              duplicateInfo,
              duplicateInfo.results[0]
            );
          } catch (error) {
            if (!isLiveMiningRender(level, generation, feedback)) {
              return;
            }
            const message = error && typeof error.message === "string"
              ? error.message
              : String(error);
            setMiningButtonState(miningItem.button, "error", message);
            if (isNoteSpecificMiningCheckError(error)) {
              continue;
            }
            level.miningCheckError = message;
            for (
              let remaining = index + 1;
              remaining < miningItems.length;
              remaining += 1
            ) {
              setMiningButtonState(miningItems[remaining].button, "error", message);
            }
            return;
          }
        }
        return;
      }
      const reason = status && typeof status.error === "string"
        ? status.error
        : "Set up Anki mining in Hoshidicts Settings.";
      for (const { button } of miningItems) {
        button.hidden = true;
        setMiningButtonState(button, "unavailable", reason);
      }
      // Match Yomitan's quiet unavailable state: dictionary results remain the
      // focus, with no setup warning or inert mining affordance. Errors from a
      // real mining attempt still flow through mineResult below.
      level.view.setFeedback(feedback, "");
    }

    function startMiningRefresh(level, miningItems, feedback) {
      const refresh = refreshMiningButtons(level, miningItems, feedback);
      level.miningRefreshPromise = refresh;
      void refresh.then(
        () => {
          if (level.miningRefreshPromise === refresh) {
            level.miningRefreshPromise = null;
          }
        },
        () => {
          if (level.miningRefreshPromise === refresh) {
            level.miningRefreshPromise = null;
          }
        }
      );
      return refresh;
    }

    async function browseResult(button, result, feedback) {
      if (!onBrowse || button.disabled) {
        return;
      }
      const term = boundedString(result?.term?.expression, 1024).trim();
      if (!term) {
        return;
      }
      const level = popupLevels.find((entry) => entry.popup.contains(button));
      button.disabled = true;
      level?.view.setFeedback(
        feedback,
        "Opening Anki browser\u2026"
      );
      try {
        await onBrowse({ word: term });
        level?.view.setFeedback(
          feedback,
          "Opened in Anki.",
          "success"
        );
      } catch (error) {
        level?.view.setFeedback(
          feedback,
          error && typeof error.message === "string"
            ? error.message
            : String(error),
          "error"
        );
      } finally {
        button.disabled = false;
        if (button.isConnected) {
          positionAllPopups();
        }
      }
    }

    async function openCustomLink(link, result, candidate, feedback) {
      if (!onOpenExternalLink) {
        return;
      }
      const url = expandPopupButtonUrl(link.url, {
        word: boundedString(result?.term?.expression, 1024).trim(),
        sentence: boundedString(candidate?.sentence),
      });
      try {
        await onOpenExternalLink(url);
      } catch (error) {
        const level = popupLevels.find((entry) => entry.popup.contains(feedback));
        level?.view.setFeedback(
          feedback,
          error && typeof error.message === "string"
            ? error.message
            : String(error),
          "error"
        );
      }
    }

    async function mineResult(button, result, candidate, feedback) {
      if (
        !onMine ||
        miningInFlight ||
        !["ready", "add-duplicate", "overwrite", "error"].includes(
          button.dataset.state
        )
      ) {
        return;
      }
      const level = popupLevels.find((entry) => entry.popup.contains(button));
      if (!level) {
        return;
      }
      miningInFlight = true;
      level.view.setFeedback(
        feedback,
        button.dataset.state === "overwrite"
          ? "Overwriting note in Anki…"
          : "Adding note to Anki…"
      );
      const buttons = popupLevels.flatMap((entry) =>
        Array.from(entry.popup.querySelectorAll(".gsm-hoshidicts-mine-button"))
      );
      const previousButtonStates = new Map(buttons.map((current) => [
        current,
        { message: current.title, state: current.dataset.state },
      ]));
      for (const current of buttons) {
        setMiningButtonState(current, current === button ? "mining" : "checking");
      }
      let added = false;
      let duplicateRejected = false;
      try {
        const audioSelection = audioController.getSelection(result);
        const basePayload = createMiningBasePayload(
          { result, candidate },
          audioSelection ? { audioSelection } : {}
        );
        const generation = level.termView?.dictionaryGeneration ?? null;
        const mediaReferences = getStructuredMediaReferences(result);
        const dictionaryMedia = mediaReferences.length === 0
          ? []
          : await getMiningDictionaryMedia(
              result,
              generation,
              level.depth,
              mediaReferences
            );
        const mediaAttachment = attachDictionaryMediaWithinBudget(
          basePayload,
          dictionaryMedia,
          MAX_MINING_REQUEST_BYTES - utf8Length(JSON.stringify(basePayload))
        );
        const { payload: miningPayload } = attachDictionaryStylesWithinBudget(
          mediaAttachment.payload,
          getMiningDictionaryStyles(
            result,
            generation
          ),
          MAX_MINING_REQUEST_BYTES -
            utf8Length(JSON.stringify(mediaAttachment.payload))
        );
        const response = await onMine(miningPayload);
        if (!response || response.success !== true) {
          throw createMiningRequestError(
            response && typeof response.error === "string"
              ? response.error
              : "Could not add the note.",
            response && response.code,
            response && response.status
          );
        }
        added = true;
        const audioOutcome = isRecord(response.audio) ? response.audio : null;
        const audioFailed = audioOutcome &&
          ["unavailable", "failed"].includes(audioOutcome.status);
        const feedbackParts = [
          response.overwritten === true
            ? "Overwritten in Anki."
            : "Added to Anki."
        ];
        if (audioFailed) {
          feedbackParts.push(
            boundedString(audioOutcome.warning, 1024).trim() ||
              "Pronunciation audio could not be added."
          );
        }
        if (
          popupLevels[level.depth] === level &&
          level.miningFeedback === feedback &&
          feedback.isConnected &&
          button.isConnected
        ) {
          setMiningButtonState(button, "success");
          level.view.setFeedback(
            feedback,
            feedbackParts.join(" "),
            audioFailed ? "warning" : "success"
          );
        }
      } catch (error) {
        const message = error && typeof error.message === "string"
          ? error.message
          : String(error);
        const duplicate = error && (
          error.code === "duplicate" || error.status === 409
        );
        duplicateRejected = duplicate === true;
        if (
          popupLevels[level.depth] === level &&
          level.miningFeedback === feedback &&
          feedback.isConnected &&
          button.isConnected
        ) {
          setMiningButtonState(button, duplicate ? "duplicate" : "error", message);
          level.view.setFeedback(
            feedback,
            duplicate ? "Already in Anki." : `Could not add to Anki: ${message}`,
            duplicate ? "info" : "error"
          );
        }
      } finally {
        miningInFlight = false;
        for (const currentLevel of popupLevels) {
          if (
            !currentLevel.visible ||
            !currentLevel.miningFeedback?.isConnected ||
            currentLevel.miningItems.length === 0
          ) {
            continue;
          }
          const hasReplacementButtons = currentLevel.miningItems.some(
            ({ button: current }) => !previousButtonStates.has(current)
          );
          if (
            checkMiningNotes &&
            (added || duplicateRejected || hasReplacementButtons)
          ) {
            void startMiningRefresh(
              currentLevel,
              currentLevel.miningItems,
              currentLevel.miningFeedback
            );
            continue;
          }
          for (const { button: current } of currentLevel.miningItems) {
            if (current === button || !current.isConnected) {
              continue;
            }
            const previous = previousButtonStates.get(current);
            if (previous && typeof previous.state === "string") {
              setMiningButtonState(current, previous.state, previous.message);
            } else {
              setMiningButtonState(current, "ready");
            }
          }
        }
      }
    }

    function recordLookup(result, definitionBlurContext, level) {
      if (!onLookup || !preferences.showLookupCounts) {
        if (definitionBlurContext) {
          definitionBlurContext.audioAutoplayBlocked = false;
        }
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
          if (definitionBlurContext?.audioAutoplayBlocked === false) {
            syncAudioRenderedResults(level.depth, true);
          }
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
          if (definitionBlurContext) {
            definitionBlurContext.audioAutoplayBlocked = false;
          }
          revealDefinitions(definitionBlurContext, "lookup-statistics-error");
          syncAudioRenderedResults(level.depth, true);
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
      resolveMediaJob(job, url, media.byteLength, media.pixelCount, media);
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
      if (!isRecord(payload)) {
        return;
      }
      if (payload.type === "hoshidicts_media_result") {
        if (serialized.length > MAX_MEDIA_RESPONSE_BYTES) {
          diagnostic("warn", "media-response.too-large", {
            bytes: serialized.length,
            maxBytes: MAX_MEDIA_RESPONSE_BYTES,
          });
          cancelMediaRequests("media_response_too_large");
          return;
        }
        handleMediaResponse(payload);
        return;
      }
      if (payload.type === "hoshidicts_styles_result") {
        handleDictionaryStylesResponse(payload, serialized.length);
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
      const requestPrimaryReading = latestRequestPrimaryReading;
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
        clearDictionaryStyles();
        activeDictionaryGeneration = null;
      } else {
        updateDictionaryGeneration(dictionaryGeneration);
      }
      const normalizedResults = normalizeLookupResults(
        payload,
        preferences.maxResults
      );
      const wholeSelectionResults = candidate.exactSelection === true
        ? normalizedResults.filter((result) => result.matched === candidate.query)
        : normalizedResults;
      const results = prioritizeLookupResultsByReading(
        wholeSelectionResults,
        requestPrimaryReading
      );
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
      const normalizedKanji = normalizeKanjiLookup(payload);
      const kanji = normalizedKanji && (
        candidate.exactSelection !== true ||
        (
          Array.from(candidate.query).length === 1 &&
          normalizedKanji.character === candidate.query
        )
      ) ? normalizedKanji : null;
      if (kanji) {
        preparePopupContent("kanji_results", targetDepth);
        const level = ensurePopupLevel(targetDepth);
        const termView = level.termView;
        if (!termView) {
          invalidateDefinitionBlur(level);
        }
        level.audioItems = [];
        level.miningItems = [];
        level.miningFeedback = null;
        level.view.renderKanji(kanji, candidate, {
          dictionaryPresentation: preferences.dictionaryPresentation,
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
          clearDictionaryStyles();
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
      latestRequestPrimaryReading = boundedString(
        candidate.primaryReading,
        MAX_LOOKUP_TEXT_BYTES
      );
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
      const scanLength = candidate.exactSelection === true
        ? Math.max(
            MIN_LOOKUP_SCAN_LENGTH,
            Math.min(MAX_LOOKUP_SCAN_LENGTH, Array.from(text).length)
          )
        : preferences.scanLength;
      socket.send(JSON.stringify({
        type: "hoshidicts_lookup",
        requestId,
        text,
        scanLength,
        maxResults: preferences.maxResults,
        sortFrequencyDictionary: preferences.sortFrequencyDictionary,
        sortFrequencyDictionaryOrder: preferences.sortFrequencyDictionaryOrder,
        ...(latestRequestPrimaryReading
          ? { primaryReading: latestRequestPrimaryReading }
          : {}),
        ...(mode === "kanji" ? { mode: "kanji" } : {}),
      }));
      diagnostic("debug", "lookup.sent", {
        requestId,
        query: text,
        mode,
        scanLength,
        maxResults: preferences.maxResults,
        sortFrequencyDictionary: preferences.sortFrequencyDictionary,
        sortFrequencyDictionaryOrder: preferences.sortFrequencyDictionaryOrder,
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

    function openStructuredLink(link, sourceDepth) {
      const anchor = link?.anchor;
      const query = boundedString(link?.query, MAX_LOOKUP_TEXT_BYTES).trim();
      const targetDepth = sourceDepth + 1;
      if (
        !(anchor instanceof windowRef.Element) ||
        !anchor.isConnected ||
        !query ||
        targetDepth > preferences.popupNestingMaxDepth
      ) {
        return false;
      }
      clearHoveredSource();
      queueLookup({
        anchor,
        sourceElements: [anchor],
        sentence: query,
        matchOffset: 0,
        query,
        primaryReading: boundedString(
          link.primaryReading,
          MAX_LOOKUP_TEXT_BYTES
        ),
        sourceDepth,
        vertical: windowRef.getComputedStyle(anchor).writingMode.startsWith("vertical"),
      }, targetDepth);
      return true;
    }

    function queueLookup(candidate, targetDepth, force = false) {
      let sourceId = candidateSourceIds.get(candidate.anchor);
      if (sourceId === undefined) {
        sourceId = ++candidateSourceSequence;
        candidateSourceIds.set(candidate.anchor, sourceId);
      }
      const signature = [
        targetDepth,
        sourceId,
        candidate.exactSelection === true ? "selection" : "pointer",
        candidate.sentence,
        candidate.matchOffset,
        candidate.query,
      ].join("\u0000");
      clearHideTimer();
      clearDescendantHideTimer();
      if (
        !force &&
        signature === latestCandidateSignature &&
        latestTargetDepth === targetDepth &&
        (latestRequestId !== null || lookupTimeoutTimer !== null)
      ) {
        return;
      }
      if (!force && renderedSignatures.get(targetDepth) === signature) {
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
      sendLookup(candidate, generation, targetDepth, signature);
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
      if (selectionDragActive) {
        return;
      }
      if (activeSelectionCandidate) {
        if (activeSelectionIsUnchanged()) {
          clearHideTimer();
          return;
        }
        activeSelectionCandidate = null;
      }
      if (!pointer || !(pointer.target instanceof windowRef.Element)) {
        return;
      }
      if (pointer.target.closest(".gsm-hoshidicts-audio-menu")) {
        pointerInPopup = true;
        pointerPopupDepth = null;
        clearPopupTransferTimer();
        clearHideTimer();
        return;
      }
      const popupDepth = getPopupDepthForTarget(pointer.target);
      if (popupDepth !== null) {
        hoveredPopupDepths.clear();
        hoveredPopupDepths.add(popupDepth);
        pointerInPopup = true;
        pointerPopupDepth = popupDepth;
        clearPopupTransferTimer();
        clearHideTimer();
        if (descendantHideTimer !== null && popupDepth >= pendingPruneDepth) {
          clearDescendantHideTimer();
        }
      } else if (pointInsidePopupChain(pointer.clientX, pointer.clientY)) {
        hoveredPopupDepths.clear();
        pointerInPopup = true;
        pointerPopupDepth = null;
        clearPopupTransferTimer();
        clearHideTimer();
        return;
      } else {
        hoveredPopupDepths.clear();
        pointerInPopup = false;
        pointerPopupDepth = null;
        clearPopupTransferTimer();
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
      const requireJapaneseText = preferences.onlyScanJapaneseText;

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
          popupDepth,
          requireJapaneseText,
          preferences.scanLength
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
        pointer.clientY,
        requireJapaneseText,
        preferences.scanLength
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

    function onMouseDown(event) {
      if (event.button !== 0 || !(event.target instanceof windowRef.Element)) {
        return;
      }
      if (event.target.closest(".gsm-hoshidicts-popup, .gsm-hoshidicts-audio-menu")) {
        return;
      }
      activeSelectionCandidate = null;
      selectionDragActive = isSelectableGsmTextTarget(event.target);
      if (!selectionDragActive) {
        return;
      }
      clearHoveredSource();
      clearHideTimer();
      clearDescendantHideTimer();
      invalidateLookup();
    }

    function onMouseUp(event) {
      if (event.button !== 0 || !selectionDragActive) {
        return;
      }
      selectionDragActive = false;
      lastPointer = {
        target: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
      };
      const selection = typeof windowRef.getSelection === "function"
        ? windowRef.getSelection()
        : null;
      const candidate = resolveSelectedLookupCandidate(
        windowRef,
        documentRef,
        selection
      );
      if (candidate) {
        activeSelectionCandidate = candidate;
        clearHoveredSource();
        queueLookup(candidate, 0);
        return;
      }
      activeSelectionCandidate = null;
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
          if (activeSelectionCandidate && activeSelectionIsUnchanged()) {
            return;
          }
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
        if (activeSelectionCandidate && activeSelectionIsUnchanged()) {
          return true;
        }
        invalidateLookup();
        scheduleHide("activation-key-released");
      }
      return true;
    }

    function updatePreferences(nextPreferences = {}) {
      const hadHideTimer = hideTimer !== null;
      const previousMode = preferences.lookupMode;
      const previousScanLength = preferences.scanLength;
      const previousMaxResults = preferences.maxResults;
      const previousSortFrequencyDictionary =
        preferences.sortFrequencyDictionary;
      const previousSortFrequencyDictionaryOrder =
        preferences.sortFrequencyDictionaryOrder;
      const definitionBlurWasEnabled = preferences.definitionBlur.enabled;
      const previousActivationKey = preferences.activationKey;
      const previousSourceHighlightEnabled = preferences.sourceHighlightEnabled;
      const previousOnlyScanJapaneseText = preferences.onlyScanJapaneseText;
      const previousShowLookupCounts = preferences.showLookupCounts;
      const previousAverageFrequency = preferences.averageFrequency;
      const previousShowFrequencyDictionaryNames =
        preferences.showFrequencyDictionaryNames;
      const previousShowCompactDefinitionSummary =
        preferences.showCompactDefinitionSummary;
      const previousCompactDefinitionSummaryCount =
        preferences.compactDefinitionSummaryCount;
      const previousHidePopupGrammarTags = preferences.hidePopupGrammarTags;
      const previousCompactDefinitionSummaryDictionary =
        preferences.compactDefinitionSummaryDictionary;
      const previousShowPitchAccentFurigana =
        preferences.showPitchAccentFurigana;
      const previousPitchAccentFuriganaDictionary =
        preferences.pitchAccentFuriganaDictionary;
      const previousShowPitchAccentBadge = preferences.showPitchAccentBadge;
      const previousMaxDepth = preferences.popupNestingMaxDepth;
      const previousPopupWidthPx = preferences.popupWidthPx;
      const previousPopupHeightPx = preferences.popupHeightPx;
      const previousPopupColumns = preferences.popupColumns;
      const previousPopupOpacityPercent = preferences.popupOpacityPercent;
      const previousPopupBackdropBlurPx = preferences.popupBackdropBlurPx;
      const previousPopupToolbarPosition = preferences.popupToolbarPosition;
      const previousTheme = preferences.theme;
      const previousCustomPopupCss = preferences.customPopupCss;
      const previousDictionaryPresentation = preferences.dictionaryPresentation;
      const previousDictionaryTabGroups = preferences.dictionaryTabGroups;
      const previousPopupButtons = preferences.popupButtons;
      preferences = {
        lookupMode: Object.prototype.hasOwnProperty.call(nextPreferences, "lookupMode")
          ? nextPreferences.lookupMode === "hover" ? "hover" : "shift"
          : preferences.lookupMode,
        scanLength: Object.prototype.hasOwnProperty.call(nextPreferences, "scanLength")
          ? normalizeLookupScanLength(nextPreferences.scanLength, preferences.scanLength)
          : preferences.scanLength,
        maxResults: Object.prototype.hasOwnProperty.call(nextPreferences, "maxResults")
          ? normalizeLookupMaxResults(nextPreferences.maxResults, preferences.maxResults)
          : preferences.maxResults,
        sortFrequencyDictionary: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "sortFrequencyDictionary"
        )
          ? normalizeSortFrequencyDictionary(
              nextPreferences.sortFrequencyDictionary,
              preferences.sortFrequencyDictionary
            )
          : preferences.sortFrequencyDictionary,
        sortFrequencyDictionaryOrder: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "sortFrequencyDictionaryOrder"
        )
          ? normalizeSortFrequencyDictionaryOrder(
              nextPreferences.sortFrequencyDictionaryOrder,
              preferences.sortFrequencyDictionaryOrder
            )
          : preferences.sortFrequencyDictionaryOrder,
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
        onlyScanJapaneseText: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "onlyScanJapaneseText"
        )
          ? nextPreferences.onlyScanJapaneseText !== false
          : preferences.onlyScanJapaneseText,
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
        averageFrequency: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "averageFrequency"
        )
          ? nextPreferences.averageFrequency === true
          : preferences.averageFrequency,
        showFrequencyDictionaryNames: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "showFrequencyDictionaryNames"
        )
          ? nextPreferences.showFrequencyDictionaryNames !== false
          : preferences.showFrequencyDictionaryNames,
        showCompactDefinitionSummary: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "showCompactDefinitionSummary"
        )
          ? nextPreferences.showCompactDefinitionSummary === true
          : preferences.showCompactDefinitionSummary,
        compactDefinitionSummaryCount: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "compactDefinitionSummaryCount"
        )
          ? normalizeCompactDefinitionSummaryCount(
              nextPreferences.compactDefinitionSummaryCount,
              preferences.compactDefinitionSummaryCount
            )
          : preferences.compactDefinitionSummaryCount,
        hidePopupGrammarTags: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "hidePopupGrammarTags"
        )
          ? nextPreferences.hidePopupGrammarTags !== false
          : preferences.hidePopupGrammarTags,
        compactDefinitionSummaryDictionary: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "compactDefinitionSummaryDictionary"
        )
          ? normalizeCompactDefinitionSummaryDictionary(
              nextPreferences.compactDefinitionSummaryDictionary,
              preferences.compactDefinitionSummaryDictionary
            )
          : preferences.compactDefinitionSummaryDictionary,
        showPitchAccentFurigana: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "showPitchAccentFurigana"
        )
          ? nextPreferences.showPitchAccentFurigana !== false
          : preferences.showPitchAccentFurigana,
        pitchAccentFuriganaDictionary: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "pitchAccentFuriganaDictionary"
        )
          ? normalizeCompactDefinitionSummaryDictionary(
              nextPreferences.pitchAccentFuriganaDictionary,
              preferences.pitchAccentFuriganaDictionary
            )
          : preferences.pitchAccentFuriganaDictionary,
        showPitchAccentBadge: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "showPitchAccentBadge"
        )
          ? nextPreferences.showPitchAccentBadge === true
          : preferences.showPitchAccentBadge,
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
        popupWidthPx: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupWidthPx"
        )
          ? normalizePopupWidth(nextPreferences.popupWidthPx, preferences.popupWidthPx)
          : preferences.popupWidthPx,
        popupHeightPx: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupHeightPx"
        )
          ? normalizePopupHeight(nextPreferences.popupHeightPx, preferences.popupHeightPx)
          : preferences.popupHeightPx,
        popupColumns: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupColumns"
        )
          ? normalizePopupColumns(nextPreferences.popupColumns, preferences.popupColumns)
          : preferences.popupColumns,
        popupOpacityPercent: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupOpacityPercent"
        )
          ? normalizePopupOpacityPercent(
              nextPreferences.popupOpacityPercent,
              preferences.popupOpacityPercent
            )
          : preferences.popupOpacityPercent,
        popupBackdropBlurPx: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupBackdropBlurPx"
        )
          ? normalizePopupBackdropBlurPx(
              nextPreferences.popupBackdropBlurPx,
              preferences.popupBackdropBlurPx
            )
          : preferences.popupBackdropBlurPx,
        popupToolbarPosition: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupToolbarPosition"
        )
          ? normalizePopupToolbarPosition(
              nextPreferences.popupToolbarPosition,
              preferences.popupToolbarPosition
            )
          : preferences.popupToolbarPosition,
        theme: Object.prototype.hasOwnProperty.call(nextPreferences, "theme")
          ? normalizeTheme(nextPreferences.theme, preferences.theme)
          : preferences.theme,
        customPopupCss: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "customPopupCss"
        )
          ? normalizeCustomPopupCss(
              nextPreferences.customPopupCss,
              preferences.customPopupCss
            )
          : preferences.customPopupCss,
        dictionaryPresentation: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "dictionaryPresentation"
        )
          ? normalizeDictionaryPresentation(nextPreferences.dictionaryPresentation)
          : preferences.dictionaryPresentation,
        frequencyDictionaries: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "frequencyDictionaries"
        )
          ? normalizeFrequencyDictionaries(nextPreferences.frequencyDictionaries)
          : preferences.frequencyDictionaries,
        dictionaryTabGroups: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "dictionaryTabGroups"
        )
          ? normalizeDictionaryTabGroups(nextPreferences.dictionaryTabGroups)
          : preferences.dictionaryTabGroups,
        popupButtons: Object.prototype.hasOwnProperty.call(
          nextPreferences,
          "popupButtons"
        )
          ? normalizePopupButtons(nextPreferences.popupButtons, preferences.popupButtons)
          : preferences.popupButtons,
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
      if (previousPopupToolbarPosition !== preferences.popupToolbarPosition) {
        for (const level of popupLevels) {
          level.view.setToolbarPosition(preferences.popupToolbarPosition);
        }
        positionAllPopups();
      }
      if (
        previousPopupWidthPx !== preferences.popupWidthPx ||
        previousPopupHeightPx !== preferences.popupHeightPx ||
        previousPopupColumns !== preferences.popupColumns ||
        previousPopupOpacityPercent !== preferences.popupOpacityPercent ||
        previousPopupBackdropBlurPx !== preferences.popupBackdropBlurPx ||
        previousTheme !== preferences.theme
      ) {
        applyAppearancePreferences();
      }
      if (previousCustomPopupCss !== preferences.customPopupCss) {
        applyCustomPopupCss();
        positionAllPopups();
      }
      if (
        !dictionaryPresentationEqual(
          previousDictionaryPresentation,
          preferences.dictionaryPresentation
        ) ||
        !dictionaryTabGroupsEqual(
          previousDictionaryTabGroups,
          preferences.dictionaryTabGroups
        ) ||
        previousShowCompactDefinitionSummary !==
          preferences.showCompactDefinitionSummary ||
        previousCompactDefinitionSummaryCount !==
          preferences.compactDefinitionSummaryCount ||
        previousAverageFrequency !== preferences.averageFrequency ||
        previousShowFrequencyDictionaryNames !==
          preferences.showFrequencyDictionaryNames ||
        previousCompactDefinitionSummaryDictionary !==
          preferences.compactDefinitionSummaryDictionary ||
        previousHidePopupGrammarTags !== preferences.hidePopupGrammarTags ||
        previousShowPitchAccentFurigana !==
          preferences.showPitchAccentFurigana ||
        previousPitchAccentFuriganaDictionary !==
          preferences.pitchAccentFuriganaDictionary ||
        previousShowPitchAccentBadge !== preferences.showPitchAccentBadge
      ) {
        const metadataPresentationChanged =
          previousShowCompactDefinitionSummary !==
            preferences.showCompactDefinitionSummary ||
          previousCompactDefinitionSummaryCount !==
            preferences.compactDefinitionSummaryCount ||
          previousAverageFrequency !== preferences.averageFrequency ||
          previousShowFrequencyDictionaryNames !==
            preferences.showFrequencyDictionaryNames ||
          previousCompactDefinitionSummaryDictionary !==
            preferences.compactDefinitionSummaryDictionary ||
          previousHidePopupGrammarTags !== preferences.hidePopupGrammarTags ||
          previousShowPitchAccentFurigana !==
            preferences.showPitchAccentFurigana ||
          previousPitchAccentFuriganaDictionary !==
            preferences.pitchAccentFuriganaDictionary ||
          previousShowPitchAccentBadge !== preferences.showPitchAccentBadge;
        for (const level of popupLevels) {
          if (level.visible && level.termView) {
            restoreTermView(level.depth, {
              autoPlay: !metadataPresentationChanged,
            });
          }
        }
      }
      if (!popupButtonsEqual(previousPopupButtons, preferences.popupButtons)) {
        for (const level of popupLevels) {
          level.view.setPopupButtons(preferences.popupButtons);
        }
        if (previousPopupButtons.audio !== preferences.popupButtons.audio) {
          syncAudioRenderedResults(null, false);
        }
        if (
          previousPopupButtons.addToAnki !== preferences.popupButtons.addToAnki
        ) {
          for (const level of popupLevels) {
            if (
              level.visible &&
              level.miningFeedback &&
              level.miningItems.length > 0
            ) {
              void startMiningRefresh(
                level,
                level.miningItems,
                level.miningFeedback
              );
            }
          }
        }
        positionAllPopups();
      }
      const activationPreferencesChanged =
        previousMode !== preferences.lookupMode ||
        activationKeyChanged ||
        previousOnlyScanJapaneseText !== preferences.onlyScanJapaneseText;
      const lookupRequestPreferencesChanged =
        previousScanLength !== preferences.scanLength ||
        previousMaxResults !== preferences.maxResults ||
        previousSortFrequencyDictionary !==
          preferences.sortFrequencyDictionary ||
        previousSortFrequencyDictionaryOrder !==
          preferences.sortFrequencyDictionaryOrder;
      if (activationPreferencesChanged) {
        activationRequirementLogged = false;
        if (requiresActivationKey() && !isActivationKeyPressed()) {
          invalidateLookup();
          scheduleHide(activationKeyChanged ? "activation-key-changed" : "lookup-mode-changed");
        } else {
          scanPointer(lastPointer, isActivationKeyPressed());
        }
      } else if (lookupRequestPreferencesChanged) {
        if (previousScanLength !== preferences.scanLength && lastPointer) {
          renderedSignatures.clear();
          noticeSignatures.clear();
          invalidateLookup();
          scanPointer(lastPointer, isActivationKeyPressed());
        } else if (!repeatCurrentLookup()) {
          invalidateLookup();
        }
      }
      diagnostic("info", "preferences.updated", preferences);
      const updatedPreferences = {
        ...preferences,
        definitionBlur: { ...preferences.definitionBlur },
        dictionaryPresentation: preferences.dictionaryPresentation.map(
          (entry) => ({ ...entry })
        ),
        frequencyDictionaries: [...preferences.frequencyDictionaries],
        dictionaryTabGroups: preferences.dictionaryTabGroups.map((group) => ({
          ...group,
          dictionaries: [...group.dictionaries],
        })),
        popupButtons: clonePopupButtons(preferences.popupButtons),
      };
      delete updatedPreferences.popupBackdropBlurPx;
      return updatedPreferences;
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
      clearDictionaryStyles();
      customPopupStyleElement.remove();
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
      documentRef.removeEventListener("mousedown", onMouseDown, true);
      documentRef.removeEventListener("mouseup", onMouseUp, true);
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
      delete documentRef.documentElement.dataset.hoshidictsTheme;
      documentRef.documentElement.style.removeProperty(
        "--gsm-hoshidicts-popup-width"
      );
      documentRef.documentElement.style.removeProperty(
        "--gsm-hoshidicts-popup-height"
      );
      documentRef.documentElement.style.removeProperty(
        "--gsm-hoshidicts-popup-opacity"
      );
      documentRef.documentElement.style.removeProperty(
        "--gsm-hoshidicts-popup-backdrop-filter"
      );
      documentRef.documentElement.style.removeProperty(
        "--gsm-hoshidicts-popup-columns"
      );
    }

    documentRef.documentElement.classList.add("gsm-hoshidicts-enabled");
    documentRef.documentElement.dataset.gsmHoshidictsEnabled = "true";
    applyAppearancePreferences(false);
    applyCustomPopupCss();
    ensurePopupLevel(0);
    documentRef.addEventListener("mousemove", onMouseMove, true);
    documentRef.addEventListener("mousedown", onMouseDown, true);
    documentRef.addEventListener("mouseup", onMouseUp, true);
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
      onlyScanJapaneseText: preferences.onlyScanJapaneseText,
      popupHideDelayMs: preferences.popupHideDelayMs,
      showLookupCounts: preferences.showLookupCounts,
      averageFrequency: preferences.averageFrequency,
      showFrequencyDictionaryNames: preferences.showFrequencyDictionaryNames,
      showCompactDefinitionSummary: preferences.showCompactDefinitionSummary,
      compactDefinitionSummaryCount:
        preferences.compactDefinitionSummaryCount,
      hidePopupGrammarTags: preferences.hidePopupGrammarTags,
      compactDefinitionSummaryDictionary:
        preferences.compactDefinitionSummaryDictionary,
      showPitchAccentFurigana: preferences.showPitchAccentFurigana,
      pitchAccentFuriganaDictionary:
        preferences.pitchAccentFuriganaDictionary,
      showPitchAccentBadge: preferences.showPitchAccentBadge,
      popupNestingMaxDepth: preferences.popupNestingMaxDepth,
      popupWidthPx: preferences.popupWidthPx,
      popupHeightPx: preferences.popupHeightPx,
      popupColumns: preferences.popupColumns,
      popupOpacityPercent: preferences.popupOpacityPercent,
      popupBackdropBlurPx: preferences.popupBackdropBlurPx,
      popupToolbarPosition: preferences.popupToolbarPosition,
      theme: preferences.theme,
      scanLength: preferences.scanLength,
      maxResults: preferences.maxResults,
      sortFrequencyDictionary: preferences.sortFrequencyDictionary,
      sortFrequencyDictionaryOrder: preferences.sortFrequencyDictionaryOrder,
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
      getPreferences: () => {
        const {
          popupBackdropBlurPx: _popupBackdropBlurPx,
          ...publicPreferences
        } = preferences;
        return {
          ...publicPreferences,
          definitionBlur: { ...preferences.definitionBlur },
          dictionaryPresentation: preferences.dictionaryPresentation.map(
            (entry) => ({ ...entry })
          ),
          frequencyDictionaries: [...preferences.frequencyDictionaries],
          dictionaryTabGroups: preferences.dictionaryTabGroups.map((group) => ({
            ...group,
            dictionaries: [...group.dictionaries],
          })),
          popupButtons: clonePopupButtons(preferences.popupButtons),
        };
      },
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
    DEFAULT_POPUP_HEIGHT_PX,
    DEFAULT_POPUP_COLUMNS,
    DEFAULT_POPUP_OPACITY_PERCENT,
    DEFAULT_POPUP_BACKDROP_BLUR_PX,
    DEFAULT_POPUP_BUTTONS,
    DEFAULT_POPUP_TOOLBAR_POSITION,
    DEFAULT_POPUP_NESTING_MAX_DEPTH,
    DEFAULT_POPUP_WIDTH_PX,
    DEFAULT_HIDE_POPUP_GRAMMAR_TAGS,
    DEFAULT_SHOW_COMPACT_DEFINITION_SUMMARY,
    DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT,
    DEFAULT_SHOW_PITCH_ACCENT_FURIGANA,
    DEFAULT_SHOW_PITCH_ACCENT_BADGE,
    DEFAULT_SOURCE_HIGHLIGHT_ENABLED,
    DEFAULT_THEME,
    INITIAL_VISIBLE_RESULTS,
    LOOKUP_MAX_RESULTS,
    LOOKUP_REQUEST_TIMEOUT_MS,
    LOOKUP_SCAN_LENGTH,
    MAX_LOOKUP_MAX_RESULTS,
    MAX_LOOKUP_SCAN_LENGTH,
    MAX_POPUP_HIDE_DELAY_MS,
    MAX_POPUP_HEIGHT_PX,
    MAX_POPUP_COLUMNS,
    MAX_POPUP_OPACITY_PERCENT,
    MAX_POPUP_BACKDROP_BLUR_PX,
    MAX_POPUP_WIDTH_PX,
    MAX_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MAX_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MIN_DEFINITION_BLUR_LOOKUP_THRESHOLD,
    MIN_DEFINITION_BLUR_REVEAL_DELAY_MS,
    MIN_POPUP_HEIGHT_PX,
    MIN_POPUP_COLUMNS,
    MIN_LOOKUP_MAX_RESULTS,
    MIN_LOOKUP_SCAN_LENGTH,
    MIN_POPUP_OPACITY_PERCENT,
    MIN_POPUP_BACKDROP_BLUR_PX,
    MIN_POPUP_WIDTH_PX,
    appendExpressionRuby,
    appendTextOnlyGlossary,
    calculatePopupPosition,
    createHoshidictsMiningClient,
    createHoshidictsLookupStatsClient,
    createHoshidictsAudioClient,
    createHoshidictsReader,
    expandPopupButtonUrl,
    normalizeActivationKey,
    normalizeAudioProfile,
    normalizeDefinitionBlurPreferences,
    normalizePopupHideDelay,
    normalizePopupToolbarPosition,
    normalizePopupHeight,
    normalizePopupColumns,
    normalizeKanjiLookup,
    normalizeLookupMaxResults,
    normalizeLookupScanLength,
    normalizePopupNestingMaxDepth,
    normalizePopupWidth,
    normalizeTheme,
    normalizePopupOpacityPercent,
    normalizePopupBackdropBlurPx,
    normalizePopupButtons,
    normalizeLookupResults,
    normalizeSortFrequencyDictionary,
    normalizeSortFrequencyDictionaryOrder,
    normalizeCompactDefinitionSummaryDictionary,
    normalizeCompactDefinitionSummaryCount,
    buildPitchAccentMorae,
    prioritizeLookupResultsByReading,
    resolveGsmApiBaseUrl,
    resolveLookupCandidate,
    resolveGlossaryLookupCandidate,
    segmentFurigana,
    selectPitchAccent,
    setMiningButtonState,
    splitPitchAccentMorae,
  };
}));
