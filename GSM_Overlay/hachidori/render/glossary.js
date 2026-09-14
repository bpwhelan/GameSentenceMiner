/*
 * Structured-content, furigana, and dictionary-style rendering for the
 * Hachidori popup.
 *
 * Ported from GameSentenceMiner PR #549
 * (GSM_Overlay/features/hoshidicts/reader.js). Structured content follows
 * Yomitan's structured-content schema; the furigana segmentation and
 * pitch-accent ruby are adapted from Hoshi Reader:
 * https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup
 *
 * Copyright (C) 2026 Manhhao
 * Copyright (C) 2023-2026 Yomitan Authors
 * Copyright (C) 2021-2022 Yomichan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.HDGlossary = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MAX_TEXT_LENGTH = 128 * 1024;
  const MAX_LOOKUP_TEXT_BYTES = 4 * 1024;
  const MAX_MEDIA_DISPLAY_SIZE = 1024;
  const MAX_STRUCTURED_DEPTH = 24;
  const MAX_STRUCTURED_NODES = 1_048_576;
  const MAX_STRUCTURED_DATA_ATTRIBUTES = 64;
  const MAX_STRUCTURED_DATA_KEY_LENGTH = 64;
  const MAX_STRUCTURED_DATA_VALUE_LENGTH = 4096;
  const MAX_DICTIONARY_STYLE_BYTES = 256 * 1024;
  const MAX_DICTIONARY_STYLES_BYTES = 2 * 1024 * 1024;
  // These compatibility aliases are typed at each use site. Even a page's
  // @property registration must not turn their values into resource URLs.
  const DICTIONARY_STYLE_VARIABLES = new Set([
    "--text-color", "--background-color", "--fg", "--canvas", "--font-size-no-units",
  ]);
  const DICTIONARY_STYLE_GROUPS = new Set([
    "CSSMediaRule", "CSSSupportsRule", "CSSContainerRule",
  ]);
  const DICTIONARY_FONT_FAMILIES = new Set([
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "fangsong",
    "inherit", "initial", "unset", "revert", "revert-layer",
  ]);
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

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function boundedString(value, maxLength = MAX_TEXT_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
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
          onKanjiClick(character, button);
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
      // One column per furigana segment, so each reading sits over the text it
      // reads. Kana segments get a column too, keeping the contour unbroken.
      let segments = segmentFurigana(expression, reading).map((segment) => ({
        text: segment.text,
        moraCount: splitPitchAccentMorae(segment.reading || segment.text).length,
      }));
      if (
        segments.reduce((total, segment) => total + segment.moraCount, 0) !==
        pitchedMorae.length
      ) {
        segments = [{ text: expression, moraCount: pitchedMorae.length }];
      }
      const title = [
        selectedPitch.dictionary,
        `Pitch accent ${selectedPitch.pitch.position}`,
      ].filter(Boolean).join(" · ");
      let moraIndex = 0;
      for (const segment of segments) {
        const ruby = documentRef.createElement("ruby");
        ruby.className = "gsm-hoshidicts-pitch-ruby";
        const base = documentRef.createElement("span");
        base.className = "gsm-hoshidicts-pitch-base";
        appendText(base, segment.text);
        ruby.appendChild(base);

        const rt = documentRef.createElement("rt");
        rt.className = "gsm-hoshidicts-pitch-reading";
        rt.dataset.pitchPosition = String(selectedPitch.pitch.position);
        if (selectedPitch.dictionary) {
          rt.dataset.pitchDictionary = selectedPitch.dictionary;
        }
        rt.title = title;

        const contour = documentRef.createElement("span");
        contour.className = "gsm-hoshidicts-pitch-contour";
        for (const mora of pitchedMorae.slice(moraIndex, moraIndex + segment.moraCount)) {
          const span = documentRef.createElement("span");
          span.className = "gsm-hoshidicts-pitch-mora";
          span.dataset.pitchLevel = mora.level;
          if (mora.transition) {
            span.dataset.pitchTransition = mora.transition;
          }
          span.textContent = mora.text;
          contour.appendChild(span);
        }
        moraIndex += segment.moraCount;
        rt.appendChild(contour);
        ruby.appendChild(rt);
        parent.appendChild(ruby);
      }
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

  function normalizeLengthSequence(value, allowNegative = false) {
    if (typeof value === "number") {
      return normalizeLengthToken(value, allowNegative);
    }
    if (!isSafeCssToken(value)) {
      return null;
    }
    const tokens = value.trim().split(/\s+/u);
    if (tokens.length < 1 || tokens.length > 4) {
      return null;
    }
    const normalized = tokens.map((token) => normalizeLengthToken(token, allowNegative));
    return normalized.every((token) => token !== null) ? normalized.join(" ") : null;
  }

  // Value kinds that are one pattern match against a string. The rest need
  // their own handling and stay spelled out below.
  const STRUCTURED_STYLE_PATTERNS = new Map([
    ["border-style", /^(?:none|hidden|dotted|dashed|solid|double)$/u],
    ["clip-path", /^(?:circle|ellipse|inset)\([0-9.,%+\-\s]+\)$/u],
    [
      "cursor",
      /^(?:auto|default|pointer|help|text|wait|progress|not-allowed|zoom-in|zoom-out)$/u,
    ],
    ["font-style", /^(?:normal|italic)$/u],
    ["text-align", /^(?:start|end|left|right|center|justify|match-parent)$/u],
    ["text-decoration-style", /^(?:solid|double|dotted|dashed|wavy)$/u],
    ["white-space", /^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/u],
    ["word-break", /^(?:normal|break-all|keep-all|break-word)$/u],
  ]);

  function normalizeStructuredStyleValue(kind, value) {
    const pattern = STRUCTURED_STYLE_PATTERNS.get(kind);
    if (pattern) {
      return typeof value === "string" && pattern.test(value) ? value : null;
    }
    if (kind === "color") {
      return normalizeColor(value);
    }
    if (kind === "length") {
      return normalizeLengthToken(value);
    }
    if (kind === "signed-length") {
      // A bare number here means em, not the px normalizeLengthToken assumes.
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
      return normalizeLengthSequence(value, true);
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
    if (kind === "text-decoration-line") {
      const values = Array.isArray(value) ? value : [value];
      return values.length >= 1 && values.length <= 4 && values.every(
        (item) => typeof item === "string" &&
          /^(?:none|underline|overline|line-through|blink)$/u.test(item)
      ) ? values.join(" ") : null;
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

  // hd_media_result carries a data: URL; PR #549 resolved media to blob: URLs
  // from its own object-URL cache. Either way the bytes came from this
  // extension. The character class stops the URL escaping the CSS url("…")
  // context appendStructuredImage interpolates it into.
  function isRenderableMediaUrl(url) {
    return typeof url === "string" && /^(?:blob|data):[^"'()\s\\]+$/u.test(url);
  }

  function appendStructuredImage(documentRef, parent, value, state) {
    const path = normalizeMediaPath(value.path);
    if (!path) return;
    // The Anki exporter shares structured parsing, but writes inert portable
    // image markup instead of installing a popup's asynchronous preview owner.
    if (typeof state.appendImage === "function") {
      state.appendImage(documentRef, parent, value, { dictionary: state.dictionary, path });
      return;
    }
    if (typeof state.resolveMedia !== "function") {
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
    let usedWidth = preferredWidth || (
      preferredHeight ? preferredHeight * width / height : width
    );
    if (preferredWidth === null && preferredHeight !== null && (!Number.isFinite(usedWidth) || usedWidth === 0)) {
      // The product can overflow/underflow even when the final width fits.
      // Keep valid original results; try the other groupings only on failure.
      usedWidth = preferredHeight * (width / height);
      if (!Number.isFinite(usedWidth) || usedWidth === 0) {
        usedWidth = (preferredHeight / height) * width;
      }
    }
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
    // One sizing rule owns the ratio; raw CSS aspect-ratio bypasses this cap.
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
    const ownsView = typeof state.isCurrent === "function" ? state.isCurrent : () => true;
    const isCurrent = () => image.isConnected && ownsView();
    const ownsDisplayedImage = state.isImageCurrent
      || (() => image.isConnected && (state.isCurrentLink || ownsView)());
    let imageContext = state.imageContext || {};
    let appliedSources = imageContext.popupImageSources ?? null;
    let attempt = 0;
    let supplier = null;
    let sourceLabel = null;
    function updateSourceLabel() {
      if (!supplier || supplier === state.dictionary) {
        if (!sourceLabel) return false;
        sourceLabel.remove();
        sourceLabel = null;
        return true;
      }
      const name = imageContext.dictionaryPresentation?.find(entry => entry.title === supplier)?.displayName || supplier;
      const text = `Image: ${name}`;
      if (sourceLabel?.textContent === text && sourceLabel.dataset.dictionary === supplier) return false;
      if (!sourceLabel) {
        sourceLabel = documentRef.createElement("span");
        sourceLabel.className = "gloss-image-source";
        if (state.imageSourceLabelHost) state.imageSourceLabelHost.appendChild(sourceLabel);
        else link.after(sourceLabel);
      }
      sourceLabel.textContent = text;
      sourceLabel.dataset.dictionary = supplier;
      sourceLabel.title = supplier;
      return true;
    }
    let previewHovered = false;
    let previewFocused = false;
    const showPreview = () => {
      if (!isCurrent()) return;
      state.requestImagePreview?.(link, image);
    };
    const hidePreview = () => {
      state.hideImagePreview?.(link);
    };
    const hideUnownedPreview = () => {
      if (!previewHovered && !previewFocused) hidePreview();
    };
    link.addEventListener("mouseenter", () => {
      previewHovered = true;
      showPreview();
    });
    link.addEventListener("mouseleave", () => {
      previewHovered = false;
      hideUnownedPreview();
    });
    link.addEventListener("focus", () => {
      previewFocused = true;
      showPreview();
    });
    link.addEventListener("blur", () => {
      previewFocused = false;
      link.removeAttribute("tabindex");
      hideUnownedPreview();
    });
    const failImage = () => {
      if (!isCurrent()) return;
      hidePreview();
      image.hidden = true;
      link.removeAttribute("href");
      background.style.removeProperty("--image");
      link.dataset.imageLoadState = "load-error";
      link.setAttribute("role", "img");
      linkText.textContent = image.alt ? `${image.alt}: Image failed to load` : "Image failed to load";
      link.setAttribute("aria-label", linkText.textContent);
      supplier = null;
      updateSourceLabel();
      state.onImageError?.();
      onLayoutChange();
    };
    parent.appendChild(link);
    let onLoad = null;
    let onError = null;
    function loadImage(refresh = false) {
      const currentAttempt = ++attempt;
      const ownsAttempt = () => attempt === currentAttempt && ownsView();
      const canPublish = () => image.isConnected && ownsAttempt();
      if (onLoad) image.removeEventListener("load", onLoad);
      if (onError) image.removeEventListener("error", onError);
      onLoad = () => {
        if (!canPublish() || image.hidden) return;
        link.dataset.imageLoadState = "loaded";
        onLayoutChange();
        state.refreshImagePreview?.(link, image);
      };
      const failAttempt = () => { if (canPublish()) failImage(); };
      onError = () => { if (!image.hidden) failAttempt(); };
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      if (refresh) {
        const retainedFocus = link.getRootNode().activeElement === link;
        state.onImageStart?.();
        image.hidden = true;
        image.removeAttribute("src");
        // Keep a deliberately focused control keyboard-focusable while its
        // old URL is unavailable. The successful href restores native focus.
        if (retainedFocus) link.tabIndex = 0;
        link.removeAttribute("href");
        link.removeAttribute("role");
        link.removeAttribute("aria-label");
        linkText.textContent = "Image";
        background.style.removeProperty("--image");
        link.dataset.imageLoadState = "not-loaded";
        supplier = null;
        updateSourceLabel();
        state.refreshImagePreview?.(link, image);
        // Chrome 128 can drop focus when href is removed even though tabindex
        // was installed first. Restore it synchronously so the popup's
        // focusout microtask sees the refreshed control, not a false departure.
        if (retainedFocus && link.getRootNode().activeElement !== link) {
          link.tabIndex = 0;
          link.focus({ preventScroll: true });
        }
      }
      let resolvedSupplier = state.dictionary;
      let mediaPromise;
      try {
        mediaPromise = Promise.resolve(state.resolveMedia({ path, width, height, isCurrent: ownsAttempt,
          onResolvedSource(title) { if (ownsAttempt()) resolvedSupplier = title; },
        }));
      } catch (error) {
        mediaPromise = Promise.reject(error);
      }
      mediaPromise.then((url) => {
        if (!canPublish()) return;
        if (!isRenderableMediaUrl(url)) throw new Error("dictionary image is unavailable");
        image.hidden = false;
        image.src = url;
        link.href = url;
        link.removeAttribute("tabindex");
        link.dataset.imageLoadState = "loaded";
        background.style.setProperty("--image", `url("${url}")`);
        supplier = resolvedSupplier;
        // The image's load/error callback positions its new label too.
        updateSourceLabel();
      }).catch(failAttempt);
    }
    state.onImageCreated?.({
      isCurrent: ownsDisplayedImage,
      updatePresentation(context) {
        imageContext = context;
        if (appliedSources === (context.popupImageSources ?? null) || !ownsView()) return updateSourceLabel();
        appliedSources = context.popupImageSources ?? null;
        loadImage(true);
        return true;
      },
    });
    loadImage();
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
    const url = globalThis.HDExternalLinks.normaliseExternalUrl(href);
    return url ? { href: url, internal: false } : null;
  }

  function ownsStructuredLink(element, state) {
    const isCurrent = state.isCurrentLink || state.isCurrent;
    return element.isConnected && (typeof isCurrent !== "function" || isCurrent());
  }

  function appendStructuredValue(documentRef, parent, value, state, depth) {
    if (state.nodes >= MAX_STRUCTURED_NODES || depth > MAX_STRUCTURED_DEPTH) {
      throw new RangeError("Structured content exceeds its node or depth limit");
    }
    // Bound traversal work, including containers and values that render no DOM.
    state.nodes += 1;
    if (typeof value === "string") {
      parent.appendChild(documentRef.createTextNode(value));
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      parent.appendChild(documentRef.createTextNode(String(value)));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        appendStructuredValue(documentRef, parent, child, state, depth + 1);
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
      appendStructuredImage(documentRef, parent, value, state);
      return;
    }

    const element = documentRef.createElement(tag);
    element.classList.add(`gloss-sc-${tag}`);
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
          if (event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          if (ownsStructuredLink(element, state) && typeof state.onInternalLink === "function") {
            state.onInternalLink({
              anchor: element,
              focusChild: event.detail === 0,
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
        const activate = (event) => {
          if (event.defaultPrevented || event.button !== (event.type === "auxclick" ? 1 : 0)) return;
          event.preventDefault();
          event.stopPropagation();
          if (!ownsStructuredLink(element, state)) return;
          if (typeof state.onExternalLink === "function") {
            state.onExternalLink({
              url: link.href,
              active: event.shiftKey || !(event.button === 1 || event.ctrlKey || event.metaKey),
            });
          }
        };
        element.addEventListener("click", activate);
        element.addEventListener("auxclick", activate);
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
    // `glossary` is the whole glossary array of one term-bank row, and each of
    // its elements is a separate sense. appendStructuredValue concatenates an
    // array into its parent, which is right for a structured-content `content`
    // run but would run two senses together here ("to eatto live on ..."), so
    // the top level is split into one item each, as Yomitan does.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) {
      return;
    }
    if (items.some((item) => isRecord(item) && item.type === "structured-content")) {
      parent.classList.add("structured-content");
    }
    const state = {
      nodes: 0,
      dictionary: options.dictionary,
      appendImage: options.appendImage,
      imageContext: options.imageContext,
      onImageCreated: options.onImageCreated,
      isCurrent: options.isCurrent,
      isCurrentLink: options.isCurrentLink,
      onExternalLink: options.onExternalLink,
      onInternalLink: options.onInternalLink,
      onLayoutChange: options.onLayoutChange,
      requestImagePreview: options.requestImagePreview,
      refreshImagePreview: options.refreshImagePreview,
      hideImagePreview: options.hideImagePreview,
      resolveMedia: typeof options.resolveMedia === "function"
        ? ({ path, width, height, isCurrent, onResolvedSource }) => options.resolveMedia({
            dictionary: options.dictionary,
            generation: options.generation,
            height,
            isCurrent,
            onResolvedSource,
            path,
            width,
          })
        : null,
    };
    if (items.length === 1) {
      appendStructuredValue(documentRef, parent, items[0], state, 0);
      return;
    }
    const list = documentRef.createElement("ul");
    list.className = "gloss-list";
    for (const item of items) {
      const listItem = documentRef.createElement("li");
      listItem.className = "gloss-item";
      appendStructuredValue(documentRef, listItem, item, state, 0);
      list.appendChild(listItem);
    }
    parent.appendChild(list);
  }

  function utf8Length(value) {
    return typeof TextEncoder === "function"
      ? new TextEncoder().encode(value).length
      : value.length;
  }

  function isSafeDictionaryStyle(style) {
    const declarations = style.cssText;
    // Check the whole browser-serialized block: var() shorthands enumerate as
    // empty longhands until substitution. Residual escapes can disguise both
    // function names and variable delimiters; drop that cosmetic rule rather
    // than reinterpret CSS tokens. Do not strip comment-like text in strings.
    if (declarations.includes("\\")
      || /\b(?:url|src|image-set|paint|attr)\s*\(/iu.test(declarations)
      || /(?<![\w\P{ASCII}-])--[\w\P{ASCII}-]+\(/u.test(declarations)) return false;
    for (const property of style) {
      // Named fonts can activate an outer page's @font-face without a URL here.
      // CSSOM expands non-variable font shorthands into font-family as well.
      if (property === "font-family" && !style.getPropertyValue(property).split(",")
        .every((family) => DICTIONARY_FONT_FAMILIES.has(family.trim().toLowerCase()))) return false;
    }
    return true;
  }

  function typeDictionaryStyleVariables(style, prefix) {
    const declarations = style.cssText;
    if (!declarations.includes("--")) return;
    const suffixes = [];
    // CSSOM has already balanced the declaration block, and residual escapes
    // were rejected. Keep strings/comments opaque while pairing parentheses.
    // Aliases are typed at each var(); the dictionary's own names are renamed
    // wherever they appear, in declarations and references alike.
    style.cssText = declarations.replace(
      /"[^"]*"|'[^']*'|\/\*[\s\S]*?\*\/|\bvar\(\s*(--[\w\P{ASCII}-]+)|(?<![\w\P{ASCII}-])--[\w\P{ASCII}-]+|[()]/giu,
      (token, variable) => {
        const name = variable ?? (token.startsWith("--") ? token : null);
        if (name && !DICTIONARY_STYLE_VARIABLES.has(name)) {
          if (variable) suffixes.push("");
          return token.replace(name, prefix + name.slice(2));
        }
        if (variable) {
          const numeric = variable === "--font-size-no-units";
          suffixes.push(numeric ? " * 1)" : " 100%, transparent)");
          return (numeric ? "calc(" : "color-mix(in srgb, ") + token;
        }
        if (token === "(") suffixes.push("");
        return token === ")" ? token + suffixes.pop() : token;
      },
    );
  }

  function filterDictionaryStyleRules(parent, prefix) {
    for (let index = parent.cssRules.length - 1; index >= 0; index -= 1) {
      const rule = parent.cssRules[index];
      const kind = rule.constructor.name;
      if (kind === "CSSStyleRule" || kind === "CSSNestedDeclarations") {
        if (!isSafeDictionaryStyle(rule.style)) {
          parent.deleteRule(index);
          continue;
        }
        typeDictionaryStyleVariables(rule.style, prefix);
      } else if (!DICTIONARY_STYLE_GROUPS.has(kind)) {
        // Global definitions (@font-face, @property, keyframes, imports, etc.)
        // are not glossary-local even when written inside an @scope block.
        parent.deleteRule(index);
        continue;
      }
      if (rule.cssRules) filterDictionaryStyleRules(rule, prefix);
    }
  }

  // Replaces whatever styles a previous generation installed in `host` rather
  // than tracking the elements outside, so a caller can re-apply at any time.
  // `host` is the shadow root (or document head) the popup lives in.
  function applyDictionaryStyles(documentRef, host, generation, entries) {
    for (const element of host.querySelectorAll(
      "style[data-hoshidicts-dictionary-style]"
    )) {
      element.remove();
    }
    const applied = [];
    const dictionaries = new Set();
    let totalBytes = 0;
    // Other custom properties belong to the dictionary. They are renamed under
    // a prefix the page cannot read through the closed shadow root, so neither
    // an inherited page value nor an @property registration can reach them.
    const prefix = `--hd${Array.from(
      documentRef.defaultView.crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}-`;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isRecord(entry)) {
        continue;
      }
      const dictionary = boundedString(entry.dictionary, 4096);
      const entryStyles = boundedString(entry.styles, MAX_DICTIONARY_STYLE_BYTES + 1);
      const styleBytes = utf8Length(entryStyles);
      // Keep the existing stylesheet transport bounds. Containment is enforced
      // by parsed scoping and the trusted card's paint boundary, not its size.
      if (
        !dictionary ||
        !entryStyles ||
        dictionaries.has(dictionary) ||
        styleBytes > MAX_DICTIONARY_STYLE_BYTES ||
        totalBytes + styleBytes > MAX_DICTIONARY_STYLES_BYTES
      ) {
        continue;
      }
      dictionaries.add(dictionary);
      totalBytes += styleBytes;
      // Detached parsing cannot fetch resources. Only browser-serialized rules
      // enter the controlled scope; raw closing braces must never reach it.
      const sheet = new documentRef.defaultView.CSSStyleSheet();
      sheet.replaceSync(entryStyles);
      filterDictionaryStyleRules(sheet, prefix);
      const style = documentRef.createElement("style");
      style.dataset.hoshidictsDictionaryStyle = dictionary;
      style.dataset.hoshidictsGeneration = String(generation);
      style.textContent = [
        `@scope (.gsm-hoshidicts-glossary-content[data-hoshidicts-dictionary=${documentRef.defaultView.CSS.escape(dictionary)}]) {`,
        ...[...sheet.cssRules].map((rule) => rule.cssText),
        "}",
      ].join("\n");
      host.appendChild(style);
      applied.push(style);
    }
    return applied;
  }

  return {
    appendExpressionRuby,
    appendStructuredImage,
    appendStructuredValue,
    appendTextOnlyGlossary,
    applyDictionaryStyles,
    applyStructuredData,
    applyStructuredStyle,
    boundedString,
    buildPitchAccentMorae,
    createFuriganaSegment,
    getFuriganaKanaSegments,
    isRecord,
    isSafeCssToken,
    normalizeColor,
    normalizeLengthSequence,
    normalizeLengthToken,
    normalizeMediaPath,
    normalizeStructuredStyleValue,
    parseStructuredLink,
    parseTagList,
    segmentFurigana,
    segmentizeFurigana,
    selectPitchAccent,
    splitPitchAccentMorae,
    structuredDataAttributeName,
    toHiragana,
  };
}));
