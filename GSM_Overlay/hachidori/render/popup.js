/*
 * Hoshidicts popup view.
 *
 * Keeps rendering and source highlighting out of the content script's pointer
 * and messaging state machine. Ported from GameSentenceMiner PR #549
 * (GSM_Overlay/features/hoshidicts/popup.js) with its Anki mining and audio
 * surfaces removed. Popup structure is adapted from Hoshi Reader:
 * https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup
 *
 * Copyright (C) 2026 Manhhao
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.HDPopup = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DEFAULT_INITIAL_RESULT_COUNT = 1;
  const DEFAULT_MAX_METADATA_TAGS = 12;
  const METADATA_OPTION_KEYS = ["averageFrequency", "showFrequencyDictionaryNames", "showPitchAccentFurigana",
    "pitchAccentFuriganaDictionary", "showPitchAccentBadge", "hidePopupGrammarTags"];

  function metadataOptions(context) {
    return Object.fromEntries(METADATA_OPTION_KEYS.map(key => [key, context[key]]));
  }

  function frequencyModes(context) {
    return context.averageFrequency === true
      ? JSON.stringify((context.dictionaryPresentation || []).map(({ title, frequencyMode }) => [title, frequencyMode]))
      : "";
  }
  const DEFAULT_HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  // Adopted sheets follow ordinary dictionary styles, even ones appended later.
  // Shadow DOM provides the scope; wrapping user rules would change their CSS.
  function createCustomPopupStyle(shadow) {
    let current = "";
    let sheet;
    const detach = () => { shadow.adoptedStyleSheets = shadow.adoptedStyleSheets.filter(value => value !== sheet); };
    return {
      update(css) {
        if (css === current) return false;
        if (css) {
          sheet ??= new shadow.ownerDocument.defaultView.CSSStyleSheet();
          sheet.replaceSync(css);
          if (!current) shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
        } else detach();
        current = css;
        return true;
      },
      destroy() { if (current) detach(); },
    };
  }
  // Both the live reader and Settings preview use the same palette and sizing
  // boundary. Colour edits touch styles only, not result projection or layout.
  function createPopupAppearance(host) {
    const document = host.ownerDocument;
    const window = document.defaultView;
    let current = {};
    let highlightSheet;

    function refreshHighlight() {
      const primary = window.getComputedStyle(host).getPropertyValue("--hoshidicts-palette-primary").trim();
      // The preview's linked palette is asynchronous; its load event retries.
      if (!primary) return;
      if (!highlightSheet) {
        highlightSheet = new window.CSSStyleSheet();
        highlightSheet.insertRule(`::highlight(${DEFAULT_HIGHLIGHT_NAME}) {}`, 0);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, highlightSheet];
      }
      const mix = `color-mix(in srgb, ${primary} ${current.popupTheme === "high-contrast" ? 56 : 34}%, transparent)`;
      highlightSheet.cssRules[0].style.setProperty("background-color", mix);
    }

    const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    function applyTheme(theme = current.popupTheme) {
      let resolvedTheme = theme;
      if (resolvedTheme === "auto") resolvedTheme = colorScheme?.matches ? "dark" : "light";
      host.dataset.hoshidictsTheme = resolvedTheme;
    }
    const colorSchemeChanged = () => {
      if (current.popupTheme !== "auto") return;
      applyTheme();
      refreshHighlight();
    };
    colorScheme?.addEventListener("change", colorSchemeChanged);

    return {
      update(options) {
        const themeChanged = current.popupTheme !== options.popupTheme;
        if (themeChanged) applyTheme(options.popupTheme);
        // Only CSS hides the button: it stays bound, so autoplay and keybinds still play.
        if (options.showPopupAudioButton === false) host.dataset.hoshidictsAudioButton = "hidden";
        else delete host.dataset.hoshidictsAudioButton;
        for (const [key, variable, unit] of [
          ["popupOpacityPercent", "opacity", "%"], ["popupWidthPx", "width", "px"], ["popupHeightPx", "height", "px"],
          ["popupScalePercent", "scale", "%"],
        ]) {
          if (current[key] !== options[key]) host.style.setProperty(`--gsm-hoshidicts-popup-${variable}`, `${options[key]}${unit}`);
        }
        current = { popupTheme: options.popupTheme, popupWidthPx: options.popupWidthPx,
          popupHeightPx: options.popupHeightPx, popupOpacityPercent: options.popupOpacityPercent,
          popupScalePercent: options.popupScalePercent };
        if (themeChanged) refreshHighlight();
      },
      refreshHighlight,
      destroy() {
        colorScheme?.removeEventListener("change", colorSchemeChanged);
        if (highlightSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== highlightSheet);
      },
    };
  }
  const MASONRY_GAP_PX = 8;
  const DEFINITION_BLUR_STATES = new Set(["pending", "blurred"]);
  const DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT = 3;
  const MIN_COMPACT_DEFINITION_SUMMARY_COUNT = 1;
  const MAX_COMPACT_DEFINITION_SUMMARY_COUNT = 6;
  const COMPACT_DEFINITION_MAX_CHARACTERS = 240;
  const COMPACT_DEFINITION_MAX_NODES = 512;
  const COMPACT_DEFINITION_LETTER = /[A-Za-zぁ-ゟァ-ヿ㐀-鿿Ａ-Ｚａ-ｚ]/u;
  const COMPACT_DEFINITION_JAPANESE = /[ぁ-ゟァ-ヿ㐀-鿿]/u;
  const COMPACT_DEFINITION_BLOCK_TAGS = new Set([
    "article",
    "blockquote",
    "dd",
    "div",
    "dt",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "p",
    "section",
    "td",
    "th",
    "tr",
  ]);
  const COMPACT_DEFINITION_IGNORED_TAGS = new Set([
    "audio",
    "button",
    "canvas",
    "iframe",
    "img",
    "input",
    "rp",
    "rt",
    "script",
    "source",
    "style",
    "svg",
    "video",
  ]);
  const DICTIONARY_DISPLAY_ALIASES = new Map([
    ["Jitendex.org", "Jitendex"],
  ]);
  const DICTIONARY_DECORATION_PATTERN =
    /\s+(?:\[([^\]]+)\]|\(([^()]*)\))\s*$/u;
  const DICTIONARY_DATE_DECORATION_PATTERN =
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/u;
  const DICTIONARY_VERSION_DECORATION_PATTERN =
    /^(?:(?:version|ver(?:sion)?|v|revision|rev|release)\s*[:#.-]?\s*)?v?\d+(?:\.\d+)+(?:[-+][0-9a-z.-]+)?$/iu;
  const DICTIONARY_LABELED_REVISION_PATTERN =
    /^(?:version|ver(?:sion)?|v|revision|rev|release)\s*[:#.-]?\s*v?\d+(?:\.\d+)*(?:[-+][0-9a-z.-]+)?$/iu;

  const DEINFLECTION_STRINGS = new Map([
    ["en", {
      steps: "Deinflection steps",
      summary: (matched, deinflected) => `Why this matched: ${matched} became ${deinflected}`,
    }],
    ["ja", {
      steps: "活用解除の手順",
      summary: (matched, deinflected) => `一致した理由: ${matched} から ${deinflected} に戻しました`,
    }],
    ["uk", {
      steps: "Кроки відновлення словникової форми",
      summary: (matched, deinflected) => `Чому це збіглося: ${matched} перетворено на ${deinflected}`,
    }],
  ]);
  const DEINFLECTION_TEXT_MAX_BYTES = 4096;
  const DEINFLECTION_STEP_MAX_COUNT = 31;
  const DEINFLECTION_OMITTED_MARKER = "…";
  const RENDER_DIAGNOSTIC_TEXT_MAX_BYTES = 512;

  function utf8Length(value) {
    return typeof TextEncoder === "function"
      ? new TextEncoder().encode(value).length
      : unescape(encodeURIComponent(value)).length;
  }

  function truncateUtf8(value, maxBytes = DEINFLECTION_TEXT_MAX_BYTES) {
    if (utf8Length(value) <= maxBytes) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const end = value.charCodeAt(middle - 1) >= 0xD800 && value.charCodeAt(middle - 1) <= 0xDBFF
        ? middle - 1
        : middle;
      if (utf8Length(value.slice(0, end)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    const end = value.charCodeAt(low - 1) >= 0xD800 && value.charCodeAt(low - 1) <= 0xDBFF
      ? low - 1
      : low;
    return value.slice(0, end);
  }

  function diagnosticText(value, fallback = "unknown") {
    return typeof value === "string" && value
      ? truncateUtf8(value, RENDER_DIAGNOSTIC_TEXT_MAX_BYTES)
      : fallback;
  }

  function dictionaryStableId(title, presentation) {
    const dictionary = Array.isArray(presentation)
      ? presentation.find((entry) => entry?.title === title)
      : null;
    return diagnosticText(dictionary?.id);
  }

  function structuredContentRenderError(error, {
    definitionIndex,
    dictionary,
    dictionaryId,
    resultIndex,
    term,
  }) {
    if (error?.code !== "structured-content-limit") return error;
    const title = diagnosticText(dictionary);
    const id = diagnosticText(dictionaryId);
    const expression = diagnosticText(term?.expression, "");
    const reading = diagnosticText(term?.reading, "");
    const entry = `entry ${resultIndex + 1}, definition ${definitionIndex + 1}`;
    const word = expression
      ? `, term ${JSON.stringify(expression)}${reading ? `, reading ${JSON.stringify(reading)}` : ""}`
      : "";
    const message = `Dictionary ${JSON.stringify(title)} (stable ID ${JSON.stringify(id)}) could not render ${entry}${word}: ${error.message}`;
    const contextual = new RangeError(message, { cause: error });
    contextual.code = "dictionary-structured-content-limit";
    contextual.definitionIndex = definitionIndex;
    contextual.dictionaryId = id;
    contextual.dictionaryTitle = title;
    contextual.entryIndex = resultIndex;
    contextual.originalStack = error.stack;
    contextual.termExpression = expression;
    contextual.termReading = reading;
    contextual.userDetail = message;
    contextual.userTitle = "Dictionary content could not be rendered.";
    return contextual;
  }

  function deinflectionSteps(result) {
    return Array.isArray(result.trace)
      ? result.trace.filter((step) => typeof step?.name === "string" && step.name.length > 0)
      : [];
  }

  function buildDeinflectionDisclosure(documentRef, result, locale) {
    const { matched, deinflected } = result;
    if (typeof matched !== "string" || !matched
        || typeof deinflected !== "string" || !deinflected || matched === deinflected) return null;
    const allSteps = deinflectionSteps(result);
    const steps = allSteps.slice(0, DEINFLECTION_STEP_MAX_COUNT);
    if (steps.length === 0) return null;

    const strings = DEINFLECTION_STRINGS.get(locale.toLowerCase().split("-")[0])
      ?? DEINFLECTION_STRINGS.get("en");
    const details = documentRef.createElement("details");
    details.className = "gsm-hoshidicts-deinflection";
    const summary = documentRef.createElement("summary");
    summary.setAttribute("aria-label", strings.summary(
      truncateUtf8(matched), truncateUtf8(deinflected),
    ));
    const path = documentRef.createElement("span");
    path.className = "gsm-hoshidicts-deinflection-path";
    for (const [index, endpoint] of [matched, deinflected].entries()) {
      if (index > 0) {
        const arrow = documentRef.createElement("span");
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = " → ";
        path.appendChild(arrow);
      }
      const value = documentRef.createElement("span");
      value.className = "gsm-hoshidicts-deinflection-endpoint";
      value.textContent = truncateUtf8(endpoint);
      path.appendChild(value);
    }
    summary.appendChild(path);
    const list = documentRef.createElement("ol");
    list.className = "gsm-hoshidicts-deinflection-steps";
    list.setAttribute("aria-label", strings.steps);
    for (const step of steps) {
      const item = documentRef.createElement("li");
      const name = documentRef.createElement("span");
      name.className = "gsm-hoshidicts-deinflection-step-name";
      name.textContent = truncateUtf8(step.name);
      item.appendChild(name);
      if (typeof step.description === "string" && step.description) {
        const description = documentRef.createElement("span");
        description.className = "gsm-hoshidicts-deinflection-step-description";
        description.textContent = truncateUtf8(step.description);
        item.appendChild(description);
      }
      list.appendChild(item);
    }
    if (steps.length < allSteps.length) {
      const omitted = documentRef.createElement("li");
      omitted.textContent = DEINFLECTION_OMITTED_MARKER;
      list.appendChild(omitted);
    }
    details.append(summary, list);
    return details;
  }

  function isDictionaryDecoration(value) {
    const decoration = String(value || "").trim();
    return DICTIONARY_DATE_DECORATION_PATTERN.test(decoration) ||
      DICTIONARY_VERSION_DECORATION_PATTERN.test(decoration) ||
      DICTIONARY_LABELED_REVISION_PATTERN.test(decoration);
  }

  function cleanDictionaryDisplayName(value) {
    const canonicalName = String(value || "").trim();
    let displayName = canonicalName;
    while (displayName) {
      const suffix = DICTIONARY_DECORATION_PATTERN.exec(displayName);
      const decoration = suffix && (suffix[1] ?? suffix[2]);
      if (!suffix || !isDictionaryDecoration(decoration)) {
        break;
      }
      displayName = displayName.slice(0, suffix.index).trimEnd();
    }
    displayName = DICTIONARY_DISPLAY_ALIASES.get(displayName) || displayName;
    return displayName || canonicalName;
  }

  function createDictionaryDisplayNames(dictionaries, presentation = []) {
    const aliases = new Map();
    for (const entry of presentation) {
      const title = typeof entry?.title === "string" ? entry.title : "";
      const displayName = typeof entry?.displayName === "string"
        ? entry.displayName.trim()
        : "";
      if (title && displayName && !aliases.has(title)) {
        aliases.set(title, displayName);
      }
    }
    const uniqueDictionaries = [...new Set(dictionaries)];
    const cleanedNames = new Map();
    const counts = new Map();
    for (const dictionary of uniqueDictionaries) {
      const cleanedName = cleanDictionaryDisplayName(dictionary);
      cleanedNames.set(dictionary, cleanedName);
      const preferredName = aliases.get(dictionary) || cleanedName;
      counts.set(preferredName, (counts.get(preferredName) || 0) + 1);
    }
    const candidates = new Map();
    const candidateCounts = new Map();
    for (const dictionary of uniqueDictionaries) {
      const alias = aliases.get(dictionary);
      const cleanedName = cleanedNames.get(dictionary);
      const preferredName = alias || cleanedName;
      const candidate = counts.get(preferredName) === 1
        ? preferredName
        : alias
          ? `${alias} (${cleanedName})`
          : dictionary;
      candidates.set(dictionary, candidate);
      candidateCounts.set(candidate, (candidateCounts.get(candidate) || 0) + 1);
    }
    const displayNames = new Map();
    const usedNames = new Set();
    for (const dictionary of uniqueDictionaries) {
      const alias = aliases.get(dictionary);
      let displayName = candidates.get(dictionary);
      if (candidateCounts.get(displayName) > 1 && alias) {
        displayName = `${alias} (${dictionary})`;
      }
      if (usedNames.has(displayName)) {
        const baseName = `${displayName} — ${dictionary}`;
        displayName = baseName;
        let suffix = 2;
        while (usedNames.has(displayName)) {
          displayName = `${baseName} ${suffix}`;
          suffix += 1;
        }
      }
      usedNames.add(displayName);
      displayNames.set(dictionary, displayName);
    }
    return displayNames;
  }

  function createTag(documentRef, text, description, kind) {
    const tag = documentRef.createElement("span");
    tag.className = `gsm-hoshidicts-tag gsm-hoshidicts-tag-${kind}`;
    tag.textContent = text;
    if (description) {
      tag.title = description;
    }
    return tag;
  }

  function formatCompactFrequencyNumber(value) {
    const absoluteValue = Math.abs(value);
    const units = [
      { minimum: 1_000_000_000, suffix: "b" },
      { minimum: 1_000_000, suffix: "m" },
      { minimum: 1_000, suffix: "k" },
    ];
    const unit = units.find(({ minimum }) => absoluteValue >= minimum);
    if (!unit) {
      return String(value);
    }
    const roundedValue = Math.round((value / unit.minimum) * 10) / 10;
    return `${roundedValue}${unit.suffix}`;
  }

  const JITEN_KANA_FREQUENCY_MARKER = "㋕";

  function isKanaFrequency(frequency) {
    return typeof frequency.displayValue === "string"
      && frequency.displayValue.trim().endsWith(JITEN_KANA_FREQUENCY_MARKER);
  }

  function formatCompactFrequencyValue(frequency) {
    return `${formatCompactFrequencyNumber(frequency.value)}${
      isKanaFrequency(frequency) ? JITEN_KANA_FREQUENCY_MARKER : ""
    }`;
  }

  function formatFrequencyValue(frequency) {
    if (typeof frequency.displayValue === "string") {
      const displayValue = frequency.displayValue.trim();
      if (!displayValue) {
        return null;
      }
      const numericText = isKanaFrequency(frequency)
        ? displayValue.slice(0, -JITEN_KANA_FREQUENCY_MARKER.length)
        : displayValue;
      const numericDisplayValue = Number(numericText.replaceAll(",", ""));
      if (!Number.isFinite(numericDisplayValue) || numericDisplayValue !== frequency.value) {
        return displayValue;
      }
      if (isKanaFrequency(frequency)) {
        return formatCompactFrequencyValue(frequency);
      }
    }
    return formatCompactFrequencyNumber(frequency.value);
  }

  function frequencyNumberForAverage(frequency) {
    return Number.isFinite(frequency.value) && frequency.value > 0
      ? frequency.value
      : null;
  }

  function createFrequencyTag(
    documentRef,
    group,
    dictionaryDisplayName,
    frequencies,
    showDictionaryName = false
  ) {
    const tag = createTag(documentRef, "", group.dictionary, "frequency");
    tag.dataset.dictionary = group.dictionary;

    if (showDictionaryName) {
      const source = documentRef.createElement("span");
      source.className = "gsm-hoshidicts-frequency-source";
      source.textContent = dictionaryDisplayName;
      tag.appendChild(source);
    }

    const body = documentRef.createElement("span");
    body.className = "gsm-hoshidicts-frequency-body";
    tag.appendChild(body);

    const values = documentRef.createElement("span");
    values.className = "gsm-hoshidicts-frequency-values";
    body.appendChild(values);
    const frequencyLabels = [];
    frequencies.forEach(({ display, frequency }, index) => {
      if (index > 0) {
        values.append(" · ");
      }
      const value = documentRef.createElement("span");
      value.className = "gsm-hoshidicts-frequency-value";
      value.dataset.frequency = String(frequency.value);
      value.textContent = display;
      let detail = String(frequency.value);
      if (isKanaFrequency(frequency)) {
        detail = `Kana frequency: ${frequency.value}`;
      } else if (typeof frequency.displayValue === "string" && frequency.displayValue !== detail) {
        detail = `${frequency.value} (${frequency.displayValue})`;
      }
      value.title = detail;
      frequencyLabels.push(detail);
      values.appendChild(value);
    });

    tag.setAttribute(
      "aria-label",
      `${group.dictionary}: ${frequencyLabels.join(", ")}`
    );
    return tag;
  }

  function createFrequencyTags(
    documentRef,
    result,
    dictionaryPresentation,
    maximumTags,
    averageFrequency = false,
    showFrequencyDictionaryNames = false
  ) {
    if (averageFrequency) {
      const modes = new Map(dictionaryPresentation.map(({ title, frequencyMode }) => [title, frequencyMode]));
      const aggregates = new Map();
      const seen = new Set();
      for (const group of result.term.frequencies) {
        if (seen.has(group.dictionary)) continue;
        for (const frequency of group.frequencies) {
          const value = frequencyNumberForAverage(frequency);
          if (value !== null) {
            const mode = modes.get(group.dictionary);
            const label = mode === "rank-based"
              ? { accessible: "Rank average", display: "Avg rank" }
              : mode === "occurrence-based"
                ? { accessible: "Occurrence average", display: "Avg count" }
                : { accessible: "Frequency average (unspecified)", display: "Avg frequency" };
            const aggregate = aggregates.get(label.accessible)
              || { count: 0, reciprocalSum: 0, display: label.display };
            aggregate.count += 1;
            aggregate.reciprocalSum += 1 / value;
            aggregates.set(label.accessible, aggregate);
            seen.add(group.dictionary);
            break;
          }
        }
      }
      return Array.from(aggregates, ([label, { count, reciprocalSum, display }]) => {
        const value = Math.floor(count / reciprocalSum);
        return createFrequencyTag(
          documentRef,
          { dictionary: label },
          display,
          [{ display: formatCompactFrequencyNumber(value), frequency: { value, displayValue: null } }],
          // These labels identify units, not a source dictionary.
          true
        );
      });
    }
    const tags = [];
    const seen = new Set();
    const dictionaryDisplayNames = createDictionaryDisplayNames(
      result.term.frequencies.map(({ dictionary }) => dictionary),
      dictionaryPresentation
    );
    for (const group of result.term.frequencies) {
      const frequencies = [];
      const seenFrequencies = new Set();
      for (const frequency of group.frequencies) {
        const originalDisplay = formatFrequencyValue(frequency);
        if (originalDisplay === null) {
          continue;
        }
        const display = showFrequencyDictionaryNames ? originalDisplay : formatCompactFrequencyValue(frequency);
        const key = JSON.stringify([frequency.value, originalDisplay]);
        if (!seenFrequencies.has(key)) {
          seenFrequencies.add(key);
          frequencies.push({ display, frequency });
        }
      }
      frequencies.sort((left, right) =>
        Number(isKanaFrequency(right.frequency))
        - Number(isKanaFrequency(left.frequency))
      );
      const key = JSON.stringify([
        group.dictionary,
        frequencies.map(({ display, frequency }) => [frequency.value, display]),
      ]);
      if (
        frequencies.length > 0 &&
        !seen.has(key) &&
        tags.length < maximumTags
      ) {
        seen.add(key);
        tags.push(createFrequencyTag(
          documentRef,
          group,
          dictionaryDisplayNames.get(group.dictionary) || group.dictionary,
          frequencies,
          showFrequencyDictionaryNames
        ));
      }
    }
    return tags;
  }

  function createPitchTag(
    documentRef,
    group,
    dictionaryDisplayName,
    pitch,
    reading,
    buildPitchAccentMorae
  ) {
    const positionText = [`[${pitch.position}]`, pitch.pattern].filter(Boolean).join(" ");
    const bodyText = reading ? `${reading} ${positionText}` : positionText;
    const tag = createPronunciationTag(documentRef, group, dictionaryDisplayName, bodyText, "pitch");
    const morae = buildPitchAccentMorae(reading, pitch.position);
    if (morae === null) return tag;
    // The same contour the header furigana draws, so every dictionary's
    // accent reads as a graph; the text stays in the title and aria-label.
    const contour = documentRef.createElement("span");
    contour.className = "gsm-hoshidicts-pitch-contour";
    for (const mora of morae) {
      const span = documentRef.createElement("span");
      span.className = "gsm-hoshidicts-pitch-mora";
      span.dataset.pitchLevel = mora.level;
      if (mora.transition) span.dataset.pitchTransition = mora.transition;
      span.textContent = mora.text;
      contour.appendChild(span);
    }
    const position = documentRef.createElement("span");
    position.className = "gsm-hoshidicts-pitch-position";
    position.textContent = positionText;
    tag.firstChild.replaceChildren(contour, position);
    return tag;
  }

  function updatePronunciationLabel(tag, dictionaryDisplayName) {
    const dictionary = tag.dataset.dictionary;
    const source = dictionaryDisplayName !== dictionary && !dictionaryDisplayName.endsWith(` (${dictionary})`)
      ? `${dictionaryDisplayName} (${dictionary})` : dictionary;
    const label = `${source}: ${tag.dataset.pronunciation}`;
    if (tag.title === label) return false;
    tag.title = label;
    tag.setAttribute("aria-label", label);
    return true;
  }

  function createPronunciationTag(documentRef, group, dictionaryDisplayName, bodyText, kind) {
    const tag = createTag(documentRef, "", "", kind);
    tag.dataset.dictionary = group.dictionary;
    tag.dataset.pronunciation = bodyText;

    const body = documentRef.createElement("span");
    body.className = `gsm-hoshidicts-${kind}-body`;
    body.textContent = bodyText;
    tag.appendChild(body);
    updatePronunciationLabel(tag, dictionaryDisplayName);
    return tag;
  }

  function formatLookupCount(label, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return `${label} ${value} ${value === 1 ? "time" : "times"}`;
  }

  function intersectHighlightRect(rect, clip) {
    const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
    const top = Math.max(rect.top, clip.top), bottom = Math.min(rect.bottom, clip.bottom);
    return right > left && bottom > top ? { left, right, top, bottom } : null;
  }

  function subtractHighlightRect(rect, cover) {
    const overlap = intersectHighlightRect(rect, cover);
    if (!overlap) return [rect];
    return [
      { ...rect, bottom: overlap.top }, { ...rect, top: overlap.bottom },
      { left: rect.left, right: overlap.left, top: overlap.top, bottom: overlap.bottom },
      { left: overlap.right, right: rect.right, top: overlap.top, bottom: overlap.bottom },
    ].filter(piece => piece.right > piece.left && piece.bottom > piece.top);
  }

  // Range.getClientRects() also includes fully selected inline element boxes.
  // Text-node subranges avoid painting their padding or tinting text twice.
  function highlightTextFragments(documentRef, match) {
    const fragments = [];
    for (const range of match.ranges) {
      const root = range.commonAncestorContainer;
      const walker = documentRef.createTreeWalker(root, 4);
      let node = root.nodeType === 3 ? root : walker.nextNode();
      while (node) {
        if (range.intersectsNode(node)) {
          const start = node === range.startContainer ? range.startOffset : 0;
          const end = node === range.endContainer ? range.endOffset : node.length;
          if (end > start) {
            const fragment = documentRef.createRange();
            fragment.setStart(node, start);
            fragment.setEnd(node, end);
            fragments.push(fragment);
          }
        }
        node = walker.nextNode();
      }
    }
    return fragments;
  }

  function createHighlightFallback(windowRef, documentRef, root) {
    const layer = documentRef.createElement("div");
    layer.className = "gsm-hoshidicts-source-highlight-layer";
    layer.setAttribute("aria-hidden", "true");
    root.appendChild(layer);
    const owners = new Map();
    let frame = null;
    let resizeTargets = new Set();
    let geometryTargets = new Map();
    let motionTargets = new Map();
    let coverTargets = new Set();
    let layoutRoots = new Set();
    let pageOccluders = null;
    let stylesheetState = null;
    let stylesheetTimer = null;
    let polledStyles = false;
    let watchedSheets = new Set();
    const styleMedia = new Map();
    let coverMotion = new WeakSet();
    const animationWatches = new Map();
    const motionRoots = new Set();
    const motionStarts = ["animationstart", "transitionrun"];
    const motionEnds = ["animationend", "animationcancel", "transitionend", "transitioncancel"];
    const motionEvents = [...motionStarts, ...motionEnds, "pointerover", "pointerout", "focusin", "focusout"];
    const resize = typeof windowRef.ResizeObserver === "function" ? new windowRef.ResizeObserver(schedule) : null;
    const affectsGeometry = change => !layer.contains(change.target)
      && (change.type === "attributes" || change.type === "characterData"
        || [...change.addedNodes, ...change.removedNodes].some(node => node !== layer));
    const geometry = new windowRef.MutationObserver(changes => { if (layoutMutations(changes)) schedule(); });
    windowRef.addEventListener("scroll", schedule, true);
    root.addEventListener("scroll", schedule, true);
    windowRef.addEventListener("resize", layoutChanged);

    function schedule() {
      if (frame === null) frame = windowRef.requestAnimationFrame(paint);
    }

    function layoutChanged() {
      pageOccluders = null;
      schedule();
    }

    function stylesheetRules(sheet) {
      try { return sheet.cssRules; }
      catch (error) {
        if (error.name !== "SecurityError") throw error;
        // Cross-origin rules are unreadable and cannot be edited by page CSSOM
        // either. Their load events still refresh effective styles.
        return [];
      }
    }

    function stylesheetSnapshot() {
      const seen = new Set();
      const snapshot = [];
      function sheetState(sheet) {
        // Object references retain shared-sheet identity without serializing
        // each rule into a nested array and copying all CSS through JSON.
        snapshot.push(sheet, sheet.disabled, sheet.media?.mediaText);
        if (seen.has(sheet)) return;
        seen.add(sheet);
        for (const rule of stylesheetRules(sheet)) {
          snapshot.push(rule.cssText);
          if (rule.styleSheet) sheetState(rule.styleSheet);
        }
        snapshot.push(null);
      }
      for (const tree of layoutRoots) {
        if (tree === root && root instanceof windowRef.ShadowRoot) continue;
        snapshot.push(tree);
        for (const sheet of [...(tree.styleSheets || []), ...(tree.adoptedStyleSheets || [])]) sheetState(sheet);
      }
      watchedSheets = seen;
      return snapshot;
    }

    function refreshStyleMedia() {
      // These common preference changes also cover unreadable page CSS.
      const queries = new Set(["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)"]);
      function collect(rules) {
        for (const rule of rules) {
          if (rule.media?.mediaText) queries.add(rule.media.mediaText);
          const nested = rule.cssRules;
          if (nested?.length) collect(nested);
        }
      }
      for (const sheet of watchedSheets) {
        if (sheet.media?.mediaText) queries.add(sheet.media.mediaText);
        collect(stylesheetRules(sheet));
      }
      for (const [query, media] of styleMedia) {
        if (!queries.has(query)) { media.removeEventListener("change", layoutChanged); styleMedia.delete(query); }
      }
      for (const query of queries) {
        if (styleMedia.has(query)) continue;
        const media = windowRef.matchMedia(query);
        media.addEventListener("change", layoutChanged);
        styleMedia.set(query, media);
      }
    }

    function checkLayoutState() {
      const next = stylesheetSnapshot();
      if (next.length !== stylesheetState.length || next.some((value, index) => value !== stylesheetState[index])) {
        stylesheetState = next;
        polledStyles = true;
        layoutChanged();
      }
      refreshAnimations(readAnimations());
    }

    function stylesheetLoaded(event) {
      if (event.target.localName === "style"
          || (event.target.localName === "link" && event.target.relList.contains("stylesheet"))) layoutChanged();
    }

    function changesCoverMembership(change) {
      // Our shadow contents are excluded from the page catalogue. Their layout
      // still matters, but cannot add a page header or change its selectors.
      if (root instanceof windowRef.ShadowRoot && change.target.getRootNode() === root) return false;
      const element = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      if (change.type === "attributes" || element?.localName === "style") return true;
      // Text can change :dir() beneath automatic-direction elements even when
      // both old and new values are non-empty.
      if (element?.closest('[dir="auto" i], bdi')) return true;
      if (change.type === "characterData") {
        return change.target.nodeType === 3 && (change.oldValue === "") !== (change.target.data === "");
      }
      const added = [...change.addedNodes], removed = [...change.removedNodes];
      if ([...added, ...removed].some(node => node.nodeType === 1)) return true;
      const hasText = nodes => nodes.some(node => node.nodeType === 3 && node.data !== "");
      // Non-empty text replacement leaves :empty/:has membership unchanged.
      return hasText(added) !== hasText(removed);
    }

    function layoutMutations(changes) {
      const relevant = changes.filter(affectsGeometry);
      if (relevant.some(changesCoverMembership)) pageOccluders = null;
      return relevant.length > 0;
    }

    function isCoverPosition(position) {
      return position === "fixed" || position === "sticky";
    }

    function isPageElement(element) {
      return element !== root.host && !layer.contains(element) && !element.closest(".gsm-hoshidicts-popup");
    }

    function isPageCover(element, style) {
      return isCoverPosition(style.position) || element.localName === "dialog" || element.hasAttribute("popover");
    }

    function isCoverMotion(animation, frames = animation.effect.getKeyframes()) {
      return (animation.playState === "running" || animation.playState === "paused")
        && frames.some(keyframe => isCoverPosition(keyframe.position));
    }

    function isRunningMotion(animation) {
      return animation.playState === "running" && animation.playbackRate !== 0;
    }

    function isMotionTarget(target) {
      for (const [element, subtree] of motionTargets) {
        if (element === target || (subtree && element.contains(target))) return true;
      }
      return false;
    }

    function readAnimations() {
      const animations = new Set();
      for (const tree of motionRoots) for (const animation of tree.getAnimations()) animations.add(animation);
      return [...animations].filter(animation => motionRoots.has(animation.effect.target.getRootNode()))
        .map(animation => ({ animation, effect: animation.effect, target: animation.effect.target,
          frames: animation.effect.getKeyframes() }));
    }

    function unwatchAnimation(animation, record) {
      animation.removeEventListener("finish", record.listener);
      animation.removeEventListener("cancel", record.listener);
      animationWatches.delete(animation);
    }

    function refreshAnimations(animations, discovering = false) {
      const current = new Set();
      for (const { animation, effect, target, frames } of animations) {
        const cover = isPageElement(target) && frames.some(keyframe => isCoverPosition(keyframe.position));
        if (!cover && !isMotionTarget(target)) continue;
        current.add(animation);
        let record = animationWatches.get(animation);
        const structure = JSON.stringify([frames, effect.getTiming()]);
        // Running frames already follow time. Paused/seeking/zero-rate effects
        // need a wake when their time, timing or keyframes change without events.
        const state = JSON.stringify([animation.playState, animation.playbackRate,
          isRunningMotion(animation) ? null : animation.currentTime]);
        const changed = !record || record.target !== target || record.effect !== effect
          || record.structure !== structure || record.state !== state;
        const membership = (record?.cover ?? false) !== cover || (cover && (!record || record.target !== target
          || record.effect !== effect || record.structure !== structure));
        if (!record) {
          record = { listener() {
            if (isPageElement(record.target) && coverMotionChanged(record.target, true)) layoutChanged();
            else schedule();
          } };
          animation.addEventListener("finish", record.listener);
          animation.addEventListener("cancel", record.listener);
          animationWatches.set(animation, record);
        }
        Object.assign(record, { target, effect, cover, structure, state });
        if (changed && !discovering) {
          if (membership) layoutChanged();
          else schedule();
        }
      }
      for (const [animation, record] of animationWatches) {
        if (current.has(animation)) continue;
        unwatchAnimation(animation, record);
        if (!discovering) {
          if (record.cover && coverMotion.has(record.target)) layoutChanged();
          else schedule();
        }
      }
    }

    function coverMotionChanged(target, ended) {
      const tracked = coverMotion.has(target);
      const active = target.getAnimations().some(animation => isCoverMotion(animation));
      if (active) {
        coverMotion.add(target);
        return !tracked;
      }
      if (tracked) {
        coverMotion.delete(target);
        return true;
      }
      return ended && isPageCover(target, windowRef.getComputedStyle(target)) !== (pageOccluders?.includes(target) ?? false);
    }

    function sourceMotion(event) {
      const target = event.target;
      const ended = motionEnds.includes(event.type);
      // A currently static element may become a cover halfway through motion.
      // Track only effects with cover-position keyframes, not every animation
      // on the page. Keep paused effects until they finish or are cancelled.
      if ((ended || motionStarts.includes(event.type)) && isPageElement(target) && coverMotionChanged(target, ended)) {
        layoutChanged();
        return;
      }
      for (const [target, subtree] of motionTargets) {
        if (target === event.target || (subtree && target.contains(event.target))
            || (event.relatedTarget !== undefined && target instanceof windowRef.Element
              && target.contains(event.target) !== target.contains(event.relatedTarget))) {
          if (ended) schedule();
          else layoutChanged();
          return;
        }
      }
    }

    function unwatchMotion(target) {
      for (const type of motionEvents) target.removeEventListener(type, sourceMotion, true);
      target.removeEventListener("load", stylesheetLoaded, true);
      motionRoots.delete(target);
    }

    function reconcileTargets() {
      motionTargets = new Map(geometryTargets);
      for (const target of coverTargets) if (!motionTargets.has(target)) motionTargets.set(target, false);
      const nextResizeTargets = new Set([...motionTargets.keys()].filter(target => target instanceof windowRef.Element));
      for (const target of nextResizeTargets) if (!resizeTargets.has(target)) resize?.observe(target);
      for (const target of resizeTargets) if (!nextResizeTargets.has(target)) resize?.unobserve(target);
      resizeTargets = nextResizeTargets;
    }

    function observeGeometry(targets) {
      geometry.disconnect();
      const nextMotionRoots = new Set();
      for (const target of targets.keys()) {
        if (target === documentRef || target instanceof windowRef.ShadowRoot) {
          nextMotionRoots.add(target);
        }
      }
      // A sibling can move the source inside a fixed-size ancestor without
      // resizing any observed source. Layout notifications therefore span its
      // containing trees; native range observers remain source-scoped.
      const nextLayoutRoots = new Set(nextMotionRoots);
      if (root instanceof windowRef.ShadowRoot) nextLayoutRoots.add(root);
      if (layoutRoots.size !== nextLayoutRoots.size || [...layoutRoots].some(target => !nextLayoutRoots.has(target))) {
        pageOccluders = null;
      }
      layoutRoots = nextLayoutRoots;
      for (const target of layoutRoots) {
        geometry.observe(target, { attributes: true, characterData: true, characterDataOldValue: true, childList: true, subtree: true });
      }
      for (const target of motionRoots) {
        if (!nextMotionRoots.has(target)) unwatchMotion(target);
      }
      for (const target of nextMotionRoots) {
        if (!motionRoots.has(target)) {
          for (const type of motionEvents) target.addEventListener(type, sourceMotion, true);
          target.addEventListener("load", stylesheetLoaded, true);
          motionRoots.add(target);
        }
      }
      geometryTargets = targets;
      reconcileTargets();
    }

    function clipBounds(element, cache) {
      if (cache.has(element)) return cache.get(element);
      const style = windowRef.getComputedStyle(element);
      const clips = value => value && value !== "visible";
      const clipX = clips(style.overflowX), clipY = clips(style.overflowY);
      let bounds = null;
      if (clipX || clipY) {
        const rect = element.getBoundingClientRect();
        const sx = element.offsetWidth ? rect.width / element.offsetWidth : 1;
        const sy = element.offsetHeight ? rect.height / element.offsetHeight : 1;
        const left = rect.left + element.clientLeft * sx, top = rect.top + element.clientTop * sy;
        bounds = { left: clipX ? left : -Infinity, right: clipX ? left + element.clientWidth * sx : Infinity,
          top: clipY ? top : -Infinity, bottom: clipY ? top + element.clientHeight * sy : Infinity };
      }
      const result = { bounds, style, invisible: style.opacity === "0" || style.contentVisibility === "hidden",
        hiddenText: style.visibility === "hidden" || style.visibility === "collapse" };
      cache.set(element, result);
      return result;
    }

    function visibleClip(source, cache, cover = false) {
      let clip = { left: 0, top: 0, right: windowRef.innerWidth, bottom: windowRef.innerHeight };
      // Overflow clips contents, not a cover's own painted border. Fixed boxes
      // also escape intermediate scrollports before their containing block.
      let clipping = !cover || clipBounds(source, cache).style.position !== "fixed";
      const containingBlock = !clipping && source.offsetParent;
      for (let ancestor = source; ancestor && clip; ancestor = ancestor.parentElement || ancestor.getRootNode().host) {
        const { bounds, invisible, hiddenText } = clipBounds(ancestor, cache);
        if (invisible || (ancestor === source && hiddenText)) return null;
        if (ancestor === containingBlock) clipping = true;
        if (bounds && clipping && (!cover || ancestor !== source)) clip = intersectHighlightRect(clip, bounds);
      }
      return clip;
    }

    function pageCovers(cache) {
      if (pageOccluders === null) {
        pageOccluders = [];
        coverMotion = new WeakSet();
        // Reuse one animation-list/keyframe read for discovery and listeners.
        // Programmatic effects need listeners on Animation itself, not the DOM.
        const animations = readAnimations();
        for (const { animation, target, frames } of animations) {
          if (isPageElement(target) && isCoverMotion(animation, frames)) coverMotion.add(target);
        }
        for (const tree of layoutRoots) {
          if (tree === root && tree instanceof windowRef.ShadowRoot) continue;
          for (const element of tree.querySelectorAll("*")) {
            if (!isPageElement(element)) continue;
            const style = windowRef.getComputedStyle(element);
            if (isPageCover(element, style) || coverMotion.has(element)) pageOccluders.push(element);
          }
        }
        coverTargets = new Set();
        for (const element of pageOccluders) {
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode().host) {
            coverTargets.add(ancestor);
          }
        }
        reconcileTargets();
        refreshAnimations(animations, true);
        // CSSOM has no mutation event in the content-script world. A bounded
        // fallback-only poll reads stylesheet text, never page geometry, and
        // only a changed snapshot requests discovery/paint. Snapshot before
        // starting the timer so early CSSOM edits cannot become its baseline.
        if (!polledStyles) stylesheetState = stylesheetSnapshot();
        polledStyles = false;
        refreshStyleMedia();
        stylesheetTimer ??= windowRef.setInterval(checkLayoutState, 250);
      }
      return pageOccluders.flatMap(element => {
        if (!isPageCover(element, clipBounds(element, cache).style)) return [];
        const clip = visibleClip(element, cache, true);
        const rect = clip && intersectHighlightRect(element.getBoundingClientRect(), clip);
        return rect ? [{ element, rect, tree: element.getRootNode(),
          pointerEvents: clipBounds(element, cache).style.pointerEvents }] : [];
      });
    }

    function coveredByPage(source, rect, cover) {
      let localSource = source;
      while (localSource && localSource.getRootNode() !== cover.tree) localSource = localSource.getRootNode().host;
      if (!localSource || cover.element.contains(localSource)) return false;
      const overlap = intersectHighlightRect(rect, cover.rect);
      if (!overlap) return false;
      const stack = cover.tree.elementsFromPoint((overlap.left + overlap.right) / 2, (overlap.top + overlap.bottom) / 2);
      const coverIndex = stack.findIndex(element => cover.element.contains(element));
      const sourceIndex = stack.findIndex(element => element.contains(localSource) || localSource.contains(element));
      // Hit-testing cannot order pointer-transparent paint. Conservatively omit
      // that intersection rather than tint an overlay above the page's text.
      return coverIndex < 0 ? cover.pointerEvents === "none" : sourceIndex < 0 || coverIndex < sourceIndex;
    }

    function fragmentRects(fragment, cache, popups, page) {
      const source = fragment.startContainer.parentElement;
      const clip = visibleClip(source, cache);
      if (!clip) return [];
      let rects;
      try { rects = [...fragment.getClientRects()].map(rect => intersectHighlightRect(rect, clip)).filter(Boolean); }
      catch { return []; } // No exact geometry: never substitute a whole paragraph.
      const popup = source.closest(".gsm-hoshidicts-popup");
      const ownerIndex = popups.findIndex(entry => entry.popup === popup);
      const covers = popups.slice(ownerIndex + 1).map(entry => entry.rect);
      const toolbar = popup?.querySelector(".gsm-hoshidicts-result-chrome");
      if (toolbar && !toolbar.contains(source)) covers.push(toolbar.getBoundingClientRect());
      for (const cover of covers) rects = rects.flatMap(rect => subtractHighlightRect(rect, cover));
      for (const cover of page) rects = rects.flatMap(rect => coveredByPage(source, rect, cover)
        ? subtractHighlightRect(rect, cover.rect) : [rect]);
      return rects;
    }

    function paint() {
      frame = null;
      const cache = new Map();
      const popups = [...root.querySelectorAll(".gsm-hoshidicts-popup")].filter(popup => !popup.hidden)
        .map(popup => ({ popup, rect: popup.getBoundingClientRect() }));
      const page = pageCovers(cache);
      // Read all owners before writing any paint rectangles.
      const plans = [...owners.values()].map(owner => ({ owner,
        rects: owner.fragments.flatMap(fragment => fragmentRects(fragment, cache, popups, page)) }));
      const moving = [...motionTargets].some(([target, subtree]) => target instanceof windowRef.Element
        && target.getAnimations({ subtree }).some(isRunningMotion));
      if (root.lastChild !== layer) root.appendChild(layer);
      for (const { owner, rects } of plans) {
        while (owner.group.children.length > rects.length) owner.group.lastChild.remove();
        rects.forEach((rect, index) => {
          let mark = owner.group.children[index];
          if (!mark) {
            mark = documentRef.createElement("span");
            mark.className = "gsm-hoshidicts-source-match";
            owner.group.appendChild(mark);
          }
          Object.assign(mark.style, { left: `${rect.left}px`, top: `${rect.top}px`,
            width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
        });
      }
      // Transforms do not notify ResizeObserver, and CSS motion has no DOM
      // mutations between frames. Stay live only while a source or cover moves.
      if (moving) schedule();
    }

    return {
      schedule,
      update(records) {
        let dirty = layoutMutations(geometry.takeRecords());
        const current = new Set(records);
        for (const [record, owner] of owners) {
          if (!current.has(record)) { owner.group.remove(); owners.delete(record); }
        }
        const targets = new Map();
        for (const record of records) {
          let owner = owners.get(record);
          if (!owner) {
            owner = { group: documentRef.createElement("div") };
            layer.appendChild(owner.group);
            owners.set(record, owner);
          }
          if (owner.match !== record.match) {
            owner.match = record.match;
            owner.fragments = highlightTextFragments(documentRef, record.match);
            dirty = true;
          }
          for (const [target, subtree] of record.observedTargets) targets.set(target, targets.get(target) || subtree);
        }
        observeGeometry(targets);
        if (dirty) schedule();
      },
      destroy() {
        if (frame !== null) windowRef.cancelAnimationFrame(frame);
        if (stylesheetTimer !== null) windowRef.clearInterval(stylesheetTimer);
        for (const media of styleMedia.values()) media.removeEventListener("change", layoutChanged);
        for (const [animation, record] of animationWatches) unwatchAnimation(animation, record);
        resize?.disconnect();
        geometry.disconnect();
        for (const target of motionRoots) unwatchMotion(target);
        windowRef.removeEventListener("scroll", schedule, true);
        root.removeEventListener("scroll", schedule, true);
        windowRef.removeEventListener("resize", layoutChanged);
        layer.remove();
      },
    };
  }

  function createSourceHighlighter(windowRef, documentRef, highlightName, fallbackRoot = documentRef.body) {
    const matches = new Map();
    let fallback = null;
    let publishedHighlight = null;
    // Publication is the only part of this that the document paints, so a caller
    // that must not appear in a picture of the page suspends exactly that.
    let suspended = 0;

    function clearRenderedHighlight() {
      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      if (publishedHighlight && highlights?.get(highlightName) === publishedHighlight) {
        highlights.delete(highlightName);
      }
      publishedHighlight = null;
    }

    // Each source's text when its candidate was first painted. A pointer scan's
    // sources are the text nodes around the match, so the match is located
    // through this snapshot and only the sources it covers have to be unchanged;
    // text edited elsewhere in those nodes leaves the highlight in place.
    const sourceSnapshots = new WeakMap();

    function createMatchRanges(candidate, matchedText) {
      const matchLength = typeof matchedText === "string" ? matchedText.length : 0;
      if (matchLength <= 0 || !Array.isArray(candidate.sourceElements)) {
        return null;
      }
      const startOffset = Math.max(0, candidate.sourceOffset);
      const endOffset = Math.min(candidate.sourceText.length, startOffset + matchLength);
      if (endOffset <= startOffset) {
        return null;
      }

      // Sources are elements or, for a pointer scan, the sentence's own text nodes.
      const sourceElements = candidate.sourceElements;
      if (sourceElements.some((element) => !(element instanceof windowRef.Node))) {
        return null;
      }
      let snapshot = sourceSnapshots.get(candidate);
      if (!snapshot) {
        snapshot = sourceElements.map((element) => element.textContent || "");
        if (snapshot.join("") !== candidate.sourceText) {
          return null;
        }
        sourceSnapshots.set(candidate, snapshot);
      }
      const showText = windowRef.NodeFilter ? windowRef.NodeFilter.SHOW_TEXT : 4;
      const ranges = [];
      let elementStart = 0;
      for (const [index, element] of sourceElements.entries()) {
        const elementEnd = elementStart + snapshot[index].length;
        if (elementEnd <= startOffset || elementStart >= endOffset) {
          elementStart = elementEnd;
          continue;
        }
        if (!element.isConnected || (element.textContent || "") !== snapshot[index]) {
          return null;
        }
        const textNodes = [];
        if (element.nodeType === 3) {
          textNodes.push(element);
        } else {
          const walker = documentRef.createTreeWalker(element, showText);
          let node = walker.nextNode();
          while (node) {
            textNodes.push(node);
            node = walker.nextNode();
          }
        }

        function findBoundary(offset, preferFollowingNode) {
          let consumed = 0;
          for (let index = 0; index < textNodes.length; index += 1) {
            const textNode = textNodes[index];
            const length = (textNode.nodeValue || "").length;
            const nodeEnd = consumed + length;
            if (
              offset < nodeEnd ||
              (
                offset === nodeEnd &&
                (!preferFollowingNode || index === textNodes.length - 1)
              )
            ) {
              return {
                node: textNode,
                offset: Math.max(0, Math.min(length, offset - consumed)),
              };
            }
            consumed = nodeEnd;
          }
          return null;
        }

        const localStart = Math.max(0, startOffset - elementStart);
        const localEnd = Math.min(elementEnd, endOffset) - elementStart;
        const start = findBoundary(localStart, true);
        const end = findBoundary(localEnd, false);
        if (start && end) {
          try {
            const range = documentRef.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            ranges.push(range);
          } catch {
            // Without an exact range this source fragment stays unpainted.
          }
        }
        elementStart = elementEnd;
      }
      return { ranges };
    }

    function render() {
      clearRenderedHighlight();
      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      const HighlightImpl = windowRef.Highlight;
      const canUseRanges = Boolean(
        highlights && typeof highlights.set === "function" && HighlightImpl
      );
      const ranges = [];
      for (const { match } of matches.values()) {
        ranges.push(...match.ranges);
      }
      if (canUseRanges && ranges.length > 0 && suspended === 0) {
        try {
          const next = new HighlightImpl(...ranges);
          highlights.set(highlightName, next);
          publishedHighlight = next;
        } catch {
          // The same exact ranges supply owned fallback paint when unavailable.
        }
      }
      if (!publishedHighlight && matches.size > 0) {
        fallback ??= createHighlightFallback(windowRef, documentRef, fallbackRoot);
        fallback.update([...matches.values()]);
      } else {
        fallback?.destroy();
        fallback = null;
      }
    }

    function observeSource(record) {
      record.observer.disconnect();
      const targets = new Map();
      for (const source of record.candidate.sourceElements) {
        targets.set(source, true);
        // Direct ancestor child lists detect a removed/moved source without
        // observing unrelated page subtrees. Cross an owned shadow root too.
        for (let parent = source.parentNode; parent; parent = parent.parentNode || parent.host) {
          if (!targets.has(parent)) targets.set(parent, false);
        }
      }
      for (const [target, subtree] of targets) {
        record.observer.observe(target, { childList: true, characterData: subtree, subtree });
      }
      record.observedTargets = targets;
    }

    function sourceChanged(record, changes) {
      return record.candidate.sourceElements.some(source => !source.isConnected
        || changes.some(change => source.contains(change.target)
          || [...change.addedNodes, ...change.removedNodes].some(node => record.observedTargets.has(node))));
    }

    function refreshSource(key, record) {
      if (matches.get(key) !== record) return;
      const match = createMatchRanges(record.candidate, record.matchedText);
      if (!match) {
        clearFor(key);
        return;
      }
      record.match = match;
      observeSource(record);
      render();
    }

    function applyFor(key, candidate, matchedText) {
      const previous = matches.get(key);
      if (previous?.candidate === candidate && previous.matchedText === matchedText) return;
      const match = createMatchRanges(candidate, matchedText);
      previous?.observer.disconnect();
      if (!match) {
        clearFor(key);
        return;
      }
      const record = { candidate, matchedText, match };
      record.observer = new windowRef.MutationObserver(changes => {
        if (sourceChanged(record, changes)) refreshSource(key, record);
      });
      matches.set(key, record);
      observeSource(record);
      render();
    }

    function clearFor(key) {
      matches.get(key)?.observer.disconnect();
      if (matches.delete(key)) {
        render();
      }
    }

    return {
      apply(candidate, matchedText) {
        applyFor("default", candidate, matchedText);
      },
      clear() {
        clearFor("default");
      },
      refresh() { fallback?.schedule(); },
      // Nothing is published, and nothing that arrives meanwhile is published
      // either, until every suspension is released; the ranges are kept, so
      // releasing repaints exactly what was there.
      suspend() {
        suspended += 1;
        clearRenderedHighlight();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          suspended -= 1;
          if (suspended === 0) render();
        };
      },
      scope(key) {
        return {
          apply(candidate, matchedText) {
            applyFor(key, candidate, matchedText);
          },
          clear() {
            clearFor(key);
          },
          refresh() { fallback?.schedule(); },
        };
      },
      clearAll() {
        for (const record of matches.values()) record.observer.disconnect();
        matches.clear();
        clearRenderedHighlight();
        fallback?.destroy();
        fallback = null;
      },
    };
  }

  function collectGlossaryDictionaries(results) {
    const dictionaries = [];
    const seen = new Set();
    for (const result of results) {
      for (const glossary of result.term.glossaries) {
        if (!seen.has(glossary.dictionary)) {
          seen.add(glossary.dictionary);
          dictionaries.push(glossary.dictionary);
        }
      }
    }
    return dictionaries;
  }

  function normaliseDictionaryTab(value) {
    if (typeof value?.dictionary === "string") return { dictionary: value.dictionary };
    if (typeof value?.groupId === "string") return { groupId: value.groupId };
    return value?.favourites === true ? { favourites: true } : null;
  }

  function dictionaryTabKey(selection) {
    if (typeof selection?.dictionary === "string") return `dictionary:${selection.dictionary}`;
    if (typeof selection?.groupId === "string") return `group:${selection.groupId}`;
    return selection?.favourites === true ? "favourites" : "all";
  }

  function sameTabMembers(left, right, dictionaries) {
    return dictionaries.every(dictionary => (left.size === 0 || left.has(dictionary))
      === (right.size === 0 || right.has(dictionary)));
  }

  function updateLabel(element, label) {
    if (element.textContent === label) return false;
    element.textContent = label;
    return true;
  }

  function createDictionaryTabs(dictionaries, renderContext) {
    const presentation = Array.isArray(renderContext.dictionaryPresentation)
      ? renderContext.dictionaryPresentation : [];
    const groups = Array.isArray(renderContext.dictionaryTabGroups)
      ? renderContext.dictionaryTabGroups : [];
    const dictionaryDisplayNames = createDictionaryDisplayNames(dictionaries, presentation);
    const available = new Set(dictionaries);
    const grouped = new Set(groups.flatMap(({ dictionaries: members }) =>
      Array.isArray(members) ? members : []));
    const availableGroups = groups.flatMap((group) => {
      const members = Array.isArray(group.dictionaries)
        ? group.dictionaries.filter((title) => available.has(title)) : [];
      return members.length > 0 ? [{ ...group, dictionaries: members }] : [];
    });
    const favourites = presentation
      .filter(({ favorite, title }) =>
        favorite === true && available.has(title) && !grouped.has(title))
      .map(({ title }) => title);
    const usedLabels = new Set();
    function tab(label, title, selection, members, qualifier) {
      let uniqueLabel = label;
      let suffix = 1;
      while (usedLabels.has(uniqueLabel)) {
        uniqueLabel = `${label} (${qualifier}${suffix === 1 ? "" : ` ${suffix}`})`;
        suffix += 1;
      }
      usedLabels.add(uniqueLabel);
      return {
        key: dictionaryTabKey(selection), label: uniqueLabel, title,
        ...selection, dictionaries: new Set(members),
      };
    }
    const dictionaryTab = (dictionary) => tab(
      dictionaryDisplayNames.get(dictionary) || dictionary,
      dictionary, { dictionary }, [dictionary], "dictionary",
    );
    // A clicked-kanji group compares its members side by side: every member
    // with an entry is its own tab in group order, instead of the reader's
    // group and favourite tabs.
    if (Array.isArray(renderContext.dictionaryTabScope)) {
      const tabs = [
        tab("All", "All dictionaries", null, [], "tab"),
        ...renderContext.dictionaryTabScope.filter((title) => available.has(title)).map(dictionaryTab),
      ];
      return { tabs, dictionaryDisplayNames };
    }
    const tabs = [
      tab("All", "All dictionaries", null, [], "tab"),
      ...availableGroups.map((group) => tab(
        group.name, `Tab group: ${group.name}`,
        { groupId: group.id }, group.dictionaries, "group",
      )),
      ...favourites.map(dictionaryTab),
    ];
    return { tabs, dictionaryDisplayNames };
  }

  // A native kanji entry as one structured-content glossary, so a clicked-kanji
  // group can lay it out beside its term dictionaries' cards.
  function kanjiEntryGlossary(entry) {
    const tokens = (value) => Array.isArray(value) ? value : String(value || "").split(/\s+/u).filter(Boolean);
    const tags = tokens(entry.tags);
    const readings = [["On", tokens(entry.onyomi)], ["Kun", tokens(entry.kunyomi)]]
      .filter(([, values]) => values.length > 0)
      .map(([label, values]) => ({ tag: "div", data: { content: "reading" },
        content: [{ tag: "strong", content: label }, ` ${values.join(" · ")}`] }));
    const definitions = Array.isArray(entry.definitions) ? entry.definitions : [];
    const stats = Array.isArray(entry.stats) ? entry.stats : [];
    return JSON.stringify([{ type: "structured-content", content: [
      ...(tags.length > 0 ? [{ tag: "div", data: { content: "tags" }, content: tags.join(" ") }] : []),
      ...readings,
      ...(definitions.length > 0 ? [{ tag: "ol", content: definitions.map((content) => ({ tag: "li", content })) }] : []),
      ...(stats.length > 0 ? [{ tag: "details", content: [{ tag: "summary", content: "Details" },
        { tag: "table", content: stats.map((stat) => ({ tag: "tr", content: [
          { tag: "th", content: String(stat.name) }, { tag: "td", content: String(stat.value) }] })) }] }] : []),
    ] }]);
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function parseCompactDefinitionValue(rawGlossary) {
    if (typeof rawGlossary !== "string" || !rawGlossary) {
      return null;
    }
    try {
      return JSON.parse(rawGlossary);
    } catch {
      return rawGlossary;
    }
  }

  function getCompactDefinitionMarker(value) {
    return isRecord(value?.data) && typeof value.data.content === "string"
      ? value.data.content.trim().toLowerCase()
      : "";
  }

  // Sanseido-style dictionaries (三省堂国語辞典, 新明解国語辞典 and their
  // bilingual conversions) name sections with data.name instead of markers.
  function getCompactDefinitionName(value) {
    return isRecord(value?.data) && typeof value.data.name === "string" ? value.data.name : "";
  }

  function isIgnoredCompactDefinitionSection(value) {
    // ルビG is Sanseido furigana, left out like rt.
    if (getCompactDefinitionName(value) === "ルビG") return true;
    const marker = getCompactDefinitionMarker(value);
    return marker && marker !== "glossary" && (
      marker.startsWith("part-of-speech") ||
      marker === "redirect-glossary" ||
      marker === "source" || marker.startsWith("source-") ||
      marker === "attribution" || marker.startsWith("attribution-") ||
      marker === "example" || marker === "examples" ||
      marker.startsWith("example-") ||
      marker === "form" || marker === "forms" ||
      marker.startsWith("forms-")
    );
  }

  function* compactDefinitionItemsFromText(parts) {
    const textRun = `[^\\s\\u2022]{1,${COMPACT_DEFINITION_MAX_CHARACTERS + 1}}`;
    const firstText = new RegExp(textRun, "gu");
    const nextText = new RegExp(`\\u2022|${textRun}`, "gu");
    const buffer = { text: "", characters: 0 };
    let pendingSpace = false;
    for (const text of parts) {
      let index = 0;
      while (index < text.length) {
        const matcher = buffer.characters > 0 ? nextText : firstText;
        matcher.lastIndex = index;
        const match = matcher.exec(text);
        if (!match) {
          pendingSpace = buffer.characters > 0;
          break;
        }
        pendingSpace ||= buffer.characters > 0 && match.index > index;
        index = matcher.lastIndex;
        if (match[0] === "\u2022") {
          yield buffer.text;
          buffer.text = "";
          buffer.characters = 0;
          pendingSpace = false;
          continue;
        }
        if (pendingSpace) {
          buffer.text += " ";
          buffer.characters += 1;
        }
        pendingSpace = false;
        if (buffer.characters <= COMPACT_DEFINITION_MAX_CHARACTERS) {
          appendCompactDefinitionText(buffer, match[0]);
        }
        // One extra normalized point proves truncation. Earlier accepted items
        // are at most 240 points, so this cannot falsely match a seen duplicate.
        if (buffer.characters > COMPACT_DEFINITION_MAX_CHARACTERS) {
          yield buffer.text;
          return;
        }
      }
    }
    if (buffer.characters > 0) yield buffer.text;
  }

  function appendCompactDefinitionText(buffer, text) {
    // The native matcher already bounds this run to 241 points. Count internal
    // surrogate pairs without building a point array unless truncation needs it.
    const characters = text.length - (text.match(/[\ud800-\udbff][\udc00-\udfff]/g)?.length || 0);
    const previous = buffer.text.charCodeAt(buffer.text.length - 1);
    const first = text.charCodeAt(0);
    const joined = previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff ? 1 : 0;
    const available = COMPACT_DEFINITION_MAX_CHARACTERS + 1 - buffer.characters + joined;
    buffer.text += characters > available ? Array.from(text).slice(0, available).join("") : text;
    buffer.characters += Math.min(characters, available) - joined;
  }

  // Typed wrappers select their payload before incidental tags, as in the full
  // renderer. Discovery, collection and leading-image selection share this rule.
  function compactDefinitionTag(value) {
    if (value.type === "text" || value.type === "structured-content") return "";
    if (value.type === "image") return "img";
    return typeof value.tag === "string" ? value.tag.toLowerCase() : "";
  }

  function compactDefinitionContent(value) {
    return value.type === "text" && Object.hasOwn(value, "text") ? value.text : value.content;
  }

  function isCompactDefinitionBlock(value) {
    return isRecord(value) && COMPACT_DEFINITION_BLOCK_TAGS.has(compactDefinitionTag(value));
  }

  // The compact walkers use explicit frames like the glossary renderer, so
  // nesting depth is never a failure condition; the node budget bounds the work.
  function* collectCompactDefinitionText(root, state) {
    const stack = [{ kind: "value", value: root }];
    // Enclosing arrays, outermost first. A child's first text decides its
    // block separator, so empty inline children never need a block check.
    const arrays = [];
    const separators = () => {
      let count = 0;
      for (let index = arrays.length - 1; index >= 0 && !arrays[index].childHasText; index -= 1) {
        const array = arrays[index];
        array.childIsBlock = isCompactDefinitionBlock(array.value[array.index - 1]);
        if (array.hasText && (array.previousWasBlock || array.childIsBlock)) count += 1;
        array.childHasText = true;
      }
      return count;
    };
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame.kind === "array") {
        if (frame.childHasText) {
          frame.hasText = true;
          frame.previousWasBlock = frame.childIsBlock;
        }
        if (frame.index < frame.value.length && state.nodes < COMPACT_DEFINITION_MAX_NODES) {
          frame.childHasText = false;
          stack.push(frame, { kind: "value", value: frame.value[frame.index] });
          frame.index += 1;
        } else {
          arrays.pop();
        }
        continue;
      }
      if (state.nodes >= COMPACT_DEFINITION_MAX_NODES) continue;
      state.nodes += 1;
      const { value } = frame;
      let text = "";
      if (typeof value === "string" || typeof value === "number" ||
          typeof value === "boolean") {
        text = String(value);
      } else if (Array.isArray(value)) {
        const array = { kind: "array", value, index: 0,
          hasText: false, previousWasBlock: false, childHasText: false, childIsBlock: false };
        arrays.push(array);
        stack.push(array);
        continue;
      } else {
        if (!isRecord(value) || isIgnoredCompactDefinitionSection(value)) continue;
        const tag = compactDefinitionTag(value);
        if (COMPACT_DEFINITION_IGNORED_TAGS.has(tag)) continue;
        if (tag !== "br") {
          const content = compactDefinitionContent(value);
          if (content !== undefined) stack.push({ kind: "value", value: content });
          continue;
        }
        text = " ";
      }
      if (!text) continue;
      for (let count = separators(); count > 0; count -= 1) yield " ";
      yield text;
    }
  }

  function findCompactDefinitionNodes(root, predicate, state) {
    const matches = [];
    const stack = [{ kind: "value", value: root }];
    while (stack.length > 0 && state.nodes < COMPACT_DEFINITION_MAX_NODES) {
      const frame = stack.pop();
      if (frame.kind === "array") {
        if (frame.index < frame.value.length) {
          stack.push(frame, { kind: "value", value: frame.value[frame.index] });
          frame.index += 1;
        }
        continue;
      }
      state.nodes += 1;
      const { value } = frame;
      if (Array.isArray(value)) {
        stack.push({ kind: "array", value, index: 0 });
        continue;
      }
      if (!isRecord(value) || isIgnoredCompactDefinitionSection(value)) continue;
      const tag = compactDefinitionTag(value);
      if (tag === "br" || COMPACT_DEFINITION_IGNORED_TAGS.has(tag)) continue;
      if (predicate(value, tag)) {
        matches.push(value);
        continue;
      }
      const content = compactDefinitionContent(value);
      if (content !== undefined) stack.push({ kind: "value", value: content });
    }
    return matches;
  }

  function isCompactDefinitionList(_value, tag) {
    return tag === "ul" || tag === "ol";
  }

  /** Block nodes with no block descendants: the smallest sense-sized chunks. */
  function findCompactDefinitionLeafBlocks(root, state = { nodes: 0 }) {
    return findCompactDefinitionNodes(
      root,
      (value, tag) => COMPACT_DEFINITION_BLOCK_TAGS.has(tag) && findCompactDefinitionNodes(
        value.content,
        (_child, childTag) => COMPACT_DEFINITION_BLOCK_TAGS.has(childTag),
        { nodes: 0 }
      ).length === 0,
      state
    );
  }

  function* compactDefinitionItemsFromNodes(nodes) {
    let found = false;
    let inspected = 0;
    for (const node of nodes) {
      if (inspected >= COMPACT_DEFINITION_MAX_NODES) break;
      inspected += 1;
      for (const item of compactDefinitionItemsFromText(collectCompactDefinitionText(node, { nodes: 0 }))) {
        found = true;
        yield item;
      }
    }
    // The first nonempty semantic list owns the preview, even if deduplication
    // leaves fewer snippets than requested. Empty lists still fall through.
    return found;
  }

  function compactDefinitionItemsFromList(list) {
    const rawChildren = Array.isArray(list.content)
      ? list.content
      : [list.content];
    const children = rawChildren.slice(0, COMPACT_DEFINITION_MAX_NODES);
    const listItems = [];
    for (const child of children) {
      if (isRecord(child) && compactDefinitionTag(child) === "li") {
        listItems.push(child);
      }
    }
    return compactDefinitionItemsFromNodes(
      listItems.length > 0 ? listItems : children
    );
  }

  function* compactDefinitionItemsFromMarkedNode(node) {
    const tag = compactDefinitionTag(node);
    if (tag === "ul" || tag === "ol") {
      yield* compactDefinitionItemsFromList(node);
      return;
    }
    const content = compactDefinitionContent(node);
    const nestedLists = findCompactDefinitionNodes(
      content,
      isCompactDefinitionList,
      { nodes: 0 }
    );
    if (nestedLists.length > 0) {
      for (const list of nestedLists) yield* compactDefinitionItemsFromList(list);
      return;
    }
    const leafBlocks = findCompactDefinitionLeafBlocks(content);
    yield* leafBlocks.length > 0
      ? compactDefinitionItemsFromNodes(leafBlocks)
      : compactDefinitionItemsFromNodes([node]);
  }

  // Sanseido index entries list sub-headwords as bare links, not definitions.
  function isCompactDefinitionLinkOnly(sense) {
    const node = isRecord(sense) && sense.type === "structured-content" ? sense.content : sense;
    // The raw tag test spares ordinary senses a tag normalization.
    return isRecord(node) && /^a$/i.test(node.tag) && compactDefinitionTag(node) === "a";
  }

  function isCompactDefinitionSense(value) {
    const name = getCompactDefinitionName(value);
    return name === "語義" || name === "語釈";
  }

  // Bilingual Sanseido conversions write a 語釈 as English, a bare " " child,
  // then the original Japanese. English-only and monolingual glosses have no
  // such child, and a bare space between English nodes is followed by ASCII
  // letters, so only a space that opens Japanese text ends the English half.
  function compactDefinitionEnglishHalf(gloss) {
    const parts = Array.isArray(gloss.content) ? gloss.content : [gloss.content];
    const separator = parts.lastIndexOf(" ");
    if (separator < 0) return parts;
    let rest = "";
    for (const text of collectCompactDefinitionText(parts.slice(separator + 1), { nodes: 0 })) {
      rest += text;
      if (rest.length > 64) break;
    }
    const lead = COMPACT_DEFINITION_LETTER.exec(rest)?.[0];
    return lead && !/[A-Za-z]/.test(lead) && COMPACT_DEFINITION_JAPANESE.test(rest)
      ? parts.slice(0, separator)
      : parts;
  }

  function* compactDefinitionFallbackNodes(parsed) {
    // Top-level glossary-array entries are separate senses, unlike inline
    // content arrays. Expand blocks within each sense without dropping siblings.
    const discovery = { nodes: 0 };
    for (const sense of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isCompactDefinitionLinkOnly(sense)) continue;
      const leafBlocks = findCompactDefinitionLeafBlocks(sense, discovery);
      if (leafBlocks.length > 0) yield* leafBlocks;
      else yield sense;
    }
  }

  function* extractCompactDefinitionItems(parsed) {
    if (parsed === null) return;

    // One discovery pass finds marked glossary sections and Sanseido senses.
    const marked = findCompactDefinitionNodes(
      parsed,
      (value) => getCompactDefinitionMarker(value) === "glossary" || isCompactDefinitionSense(value),
      { nodes: 0 }
    );
    const glossaryNodes = marked.filter((node) => getCompactDefinitionMarker(node) === "glossary");
    if (glossaryNodes.length > 0) {
      for (const node of glossaryNodes) yield* compactDefinitionItemsFromMarkedNode(node);
      return;
    }

    // A Sanseido 語義 sense holds its number, labels, 語釈 gloss and examples;
    // 副義 sub-senses nest their own 語釈. A sense without one is a ⇨ reference.
    if (marked.length > 0) {
      for (const sense of marked) {
        const glosses = getCompactDefinitionName(sense) === "語釈"
          ? [sense]
          : findCompactDefinitionNodes(
            compactDefinitionContent(sense),
            (value) => getCompactDefinitionName(value) === "語釈",
            { nodes: 0 }
          );
        yield* compactDefinitionItemsFromNodes(glosses.map(compactDefinitionEnglishHalf));
      }
      return;
    }

    const semanticLists = findCompactDefinitionNodes(
      parsed,
      isCompactDefinitionList,
      { nodes: 0 }
    );
    for (const list of semanticLists) {
      if (yield* compactDefinitionItemsFromList(list)) return;
    }

    yield* compactDefinitionItemsFromNodes(compactDefinitionFallbackNodes(parsed));
  }

  // null means no visible content; false means text or another non-image lead.
  // Stop at that first meaningful token, not at an image later in a definition.
  function leadingCompactDefinitionImage(root, state) {
    const stack = [{ kind: "value", value: root }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame.kind === "array") {
        if (frame.index < frame.value.length) {
          stack.push(frame, { kind: "value", value: frame.value[frame.index] });
          frame.index += 1;
        }
        continue;
      }
      if (state.nodes >= COMPACT_DEFINITION_MAX_NODES) return false;
      state.nodes += 1;
      const { value } = frame;
      if (Array.isArray(value)) {
        stack.push({ kind: "array", value, index: 0 });
        continue;
      }
      if (!isRecord(value)) {
        if (value != null && /\S/u.test(String(value))) return false;
        continue;
      }
      if (isIgnoredCompactDefinitionSection(value)) continue;
      const tag = compactDefinitionTag(value);
      if (tag === "img") return value;
      if (tag === "br" || COMPACT_DEFINITION_IGNORED_TAGS.has(tag)) continue;
      stack.push({ kind: "value", value: compactDefinitionContent(value) });
    }
    return null;
  }

  function extractCompactDefinitionSummary(
    glossaries,
    preferredDictionary = null,
    maximumItems = DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT
  ) {
    const itemLimit = Number.isInteger(maximumItems) &&
      maximumItems >= MIN_COMPACT_DEFINITION_SUMMARY_COUNT &&
      maximumItems <= MAX_COMPACT_DEFINITION_SUMMARY_COUNT
      ? maximumItems
      : DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT;
    const byDictionary = new Map();
    for (const glossary of Array.isArray(glossaries) ? glossaries : []) {
      if (!byDictionary.has(glossary.dictionary)) {
        byDictionary.set(glossary.dictionary, []);
      }
      byDictionary.get(glossary.dictionary).push(glossary.glossary);
    }
    const dictionaries = [...byDictionary.keys()];
    if (preferredDictionary !== null && byDictionary.has(preferredDictionary)) {
      dictionaries.splice(dictionaries.indexOf(preferredDictionary), 1);
      dictionaries.unshift(preferredDictionary);
    }
    for (const dictionary of dictionaries) {
      const rawGlossaries = byDictionary.get(dictionary);
      const items = [];
      const seen = new Set();
      let characterCount = 0;
      let leading = null;
      for (const rawGlossary of rawGlossaries) {
        const parsed = parseCompactDefinitionValue(rawGlossary);
        if (leading === null) leading = leadingCompactDefinitionImage(parsed, { nodes: 0 });
        for (const item of extractCompactDefinitionItems(parsed)) {
          if (!item || seen.has(item)) continue;
          const remaining = COMPACT_DEFINITION_MAX_CHARACTERS - characterCount;
          const codePoints = [];
          for (const character of item) {
            codePoints.push(character);
            if (codePoints.length > remaining) break;
          }
          const bounded = codePoints.length <= remaining
            ? item
            : remaining === 1
              ? "\u2026"
              : `${codePoints.slice(0, remaining - 1).join("")}\u2026`;
          items.push(bounded);
          seen.add(item);
          characterCount += Math.min(codePoints.length, remaining);
          if (bounded !== item || items.length >= itemLimit || characterCount >= COMPACT_DEFINITION_MAX_CHARACTERS) break;
        }
        if (
          items.length >= itemLimit ||
          characterCount >= COMPACT_DEFINITION_MAX_CHARACTERS
        ) {
          break;
        }
      }
      if (items.length > 0) return { dictionary, items, image: leading || null };
    }
    return null;
  }

  // A popup that cancels browser zoom measures its own lengths in unzoomed
  // pixels; page geometry (client rects, the viewport) converts into them.
  function scaleRect(rect, factor) {
    return { left: rect.left * factor, top: rect.top * factor, right: rect.right * factor,
      bottom: rect.bottom * factor, width: rect.width * factor, height: rect.height * factor };
  }

  function popupCoordinateScale(pageZoom, scalePercent) {
    return pageZoom * 100 / scalePercent;
  }

  // Roots prefer the space above the word; nested panes prefer below it, as
  // Yomitan places a child. Either falls back to the side that fits, then to
  // the roomier side.
  function calculatePopupPosition(anchorRect, popupSize, viewport, { gap = 4, padding = 6, vertical = false, preferBelow = false } = {}) {
    const width = Math.min(popupSize.width, Math.max(1, viewport.width - padding * 2));
    const height = Math.min(popupSize.height, Math.max(1, viewport.height - padding * 2));
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(value, maximum));
    let left;
    let top;
    let placement;
    if (vertical) {
      const spaceRight = viewport.width - anchorRect.right - gap;
      const spaceLeft = anchorRect.left - gap;
      left = spaceRight >= width || spaceRight >= spaceLeft
        ? anchorRect.right + gap
        : anchorRect.left - gap - width;
      top = anchorRect.top;
      placement = "beside";
    } else {
      const spaceBelow = Math.max(0, viewport.height - padding - anchorRect.bottom - gap);
      const spaceAbove = Math.max(0, anchorRect.top - gap - padding);
      const preferred = (space, other) => space >= height || (other < height && space >= other);
      const placeAbove = preferBelow ? !preferred(spaceBelow, spaceAbove) : preferred(spaceAbove, spaceBelow);
      top = placeAbove ? anchorRect.top - gap - height : anchorRect.bottom + gap;
      left = anchorRect.left;
      placement = placeAbove ? "above" : "below";
    }
    return {
      height,
      left: clamp(Math.round(left), padding, viewport.width - width - padding),
      placement,
      top: clamp(Math.round(top), padding, viewport.height - height - padding),
      width,
    };
  }

  function createPopupView(options) {
    const documentRef = options.document;
    const windowRef = options.window;
    const popup = options.popup;
    const getPageZoom = options.getPageZoom ?? (() => 1);
    const getCoordinateScale = () => popupCoordinateScale(getPageZoom(), options.getPopupScalePercent?.() ?? 100);
    const contentScroll = documentRef.createElement("div");
    contentScroll.className = "gsm-hoshidicts-content-scroll";
    const resizeHandle = options.onResizeStart ? documentRef.createElement("div") : null;
    if (resizeHandle) {
      resizeHandle.className = "gsm-hoshidicts-resize-handle";
      resizeHandle.title = "Resize popup";
      resizeHandle.addEventListener("pointerdown", options.onResizeStart);
      resizeHandle.addEventListener("pointermove", options.onResizeMove);
      for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
        resizeHandle.addEventListener(event, options.onResizeEnd);
      }
      popup.appendChild(resizeHandle);
    }
    const appendExpressionRuby = options.appendExpressionRuby;
    const buildPitchAccentMorae = options.buildPitchAccentMorae;
    const appendTextOnlyGlossary = options.appendTextOnlyGlossary;
    const appendStructuredImage = options.appendStructuredImage;
    const parseTagList = options.parseTagList;
    const positionPopup = () => {
      options.positionPopup();
      sourceHighlighter.refresh();
    };
    // LookupKanji carries onyomi/kunyomi/tags as space-separated strings, but a
    // caller that already normalized them hands over arrays. Accept both.
    const tokenList = (value) =>
      Array.isArray(value) ? value : parseTagList(value);
    const getPopupColumns = typeof options.getPopupColumns === "function"
      ? options.getPopupColumns
      : () => 1;
    const onKanjiClick = typeof options.onKanjiClick === "function"
      ? options.onKanjiClick
      : () => {};
    const onAddCustomEntry = typeof options.onAddCustomEntry === "function"
      ? options.onAddCustomEntry
      : async () => {};
    const onNoteEditingChange = typeof options.onNoteEditingChange === "function"
      ? options.onNoteEditingChange
      : () => {};
    const onBeforeResultsRendered =
      typeof options.onBeforeResultsRendered === "function"
        ? options.onBeforeResultsRendered
        : () => {};
    const onResultsRendered = typeof options.onResultsRendered === "function"
      ? options.onResultsRendered
      : () => {};
    const onResultsExpanded = typeof options.onResultsExpanded === "function"
      ? options.onResultsExpanded
      : () => {};
    const idPrefix = typeof options.idPrefix === "string" && options.idPrefix
      ? options.idPrefix
      : "gsm-hoshidicts";
    const initialResultCount = Number.isInteger(options.initialResultCount)
      ? Math.max(1, options.initialResultCount)
      : DEFAULT_INITIAL_RESULT_COUNT;
    const maxMetadataTags = Number.isInteger(options.maxMetadataTags)
      ? Math.max(1, options.maxMetadataTags)
      : DEFAULT_MAX_METADATA_TAGS;
    const popupRoot = popup.getRootNode();
    const sourceHighlighter = options.sourceHighlighter || createSourceHighlighter(
      windowRef,
      documentRef,
      options.highlightName || DEFAULT_HIGHLIGHT_NAME,
      popupRoot instanceof windowRef.ShadowRoot ? popupRoot : documentRef.body
    );
    let definitionBlurState = "revealed";
    let sourceHighlightEnabled = options.sourceHighlightEnabled === true;
    let currentSourceHighlight = null;
    let toolbarPosition = options.toolbarPosition === "bottom" ? "bottom" : "top";
    let currentToolbar = null;
    let currentFeedback = null;
    let currentLookupFailure = null;
    let customButtons = Array.isArray(options.customButtons)
      ? options.customButtons
      : (options.customLinks || []).map((link, index) => ({
        id: `legacy-link-${index + 1}`,
        type: "link",
        ...link,
      }));
    let currentNoteControls = null;
    let renderRevision = 0;
    let currentResultPanel = null;
    let captureTermView = null;
    let pendingScrollRestoration = null;
    let currentPresentationUpdate = null;
    let pendingPresentation = null;
    let imagePreview = null;
    const renderedImages = new Set();
    let masonryFrame = null;
    const masonryObserver = typeof windowRef.ResizeObserver === "function"
      ? new windowRef.ResizeObserver(() => scheduleMasonry())
      : null;
    popup.dataset.toolbarPosition = toolbarPosition;

    function hideImagePreview(owner = null) {
      if (!imagePreview || (owner && imagePreview.owner !== owner)) return;
      imagePreview.element?.remove();
      imagePreview = null;
    }

    function positionImagePreview(anchorRect = imagePreview.image.getBoundingClientRect()) {
      const preview = imagePreview.element;
      const zoom = getCoordinateScale();
      preview.firstElementChild.style.maxWidth = `${Math.max(1, windowRef.innerWidth * zoom - 16)}px`;
      preview.firstElementChild.style.maxHeight = `${Math.max(1, windowRef.innerHeight * zoom - 16)}px`;
      const position = calculatePopupPosition(scaleRect(anchorRect, zoom), scaleRect(preview.getBoundingClientRect(), zoom), {
        width: windowRef.innerWidth * zoom, height: windowRef.innerHeight * zoom,
      }, { gap: 8, padding: 8, vertical: true });
      preview.style.left = `${position.left}px`;
      preview.style.top = `${position.top}px`;
    }

    function refreshImagePreview(link, image) {
      // Image completion resumes only the most recent interaction. It must
      // not steal another image's focus or revive a dismissed pending preview.
      if (imagePreview?.owner !== link) return;
      const source = image.currentSrc || image.src;
      if (image.hidden || !source) {
        imagePreview.element?.remove();
        imagePreview.element = null;
        imagePreview.source = null;
        return;
      }
      if (imagePreview.source === source) return;
      imagePreview.element?.remove();
      const preview = documentRef.createElement("div");
      preview.className = "gsm-hoshidicts-image-hover-preview";
      preview.setAttribute("aria-hidden", "true");
      preview.dataset.appearance = link.dataset.appearance;
      preview.dataset.imageRendering = link.dataset.imageRendering;
      const expanded = documentRef.createElement("img");
      expanded.src = source;
      expanded.alt = image.alt;
      expanded.decoding = "async";
      expanded.draggable = false;
      preview.appendChild(expanded);
      // A sibling in the same shadow root retains the palette while escaping
      // the glossary card's paint containment and the popup's scroll clipping.
      popup.parentNode.appendChild(preview);
      imagePreview.source = source;
      imagePreview.element = preview;
      positionImagePreview();
    }

    function requestImagePreview(link, image) {
      if (imagePreview?.owner !== link) {
        hideImagePreview();
        imagePreview = { owner: link, image, source: null, element: null };
      }
      refreshImagePreview(link, image);
    }

    const onPopupScroll = () => {
      if (!imagePreview) return;
      const { owner, image, element } = imagePreview;
      if (owner.getRootNode().activeElement !== owner || !element) {
        hideImagePreview();
        return;
      }
      const anchorRect = image.getBoundingClientRect();
      const bounds = (contentScroll.contains(image) ? contentScroll : currentToolbar || popup).getBoundingClientRect();
      if (anchorRect.bottom <= bounds.top || anchorRect.top >= bounds.bottom
          || anchorRect.right <= bounds.left || anchorRect.left >= bounds.right) {
        hideImagePreview();
        return;
      }
      // Native keyboard focus may scroll its image into view after focus.
      // Retain that focused preview while closing ordinary hover previews.
      positionImagePreview(anchorRect);
    };
    popup.addEventListener("scroll", onPopupScroll, true);

    // Keybind navigation after Yomitan's Display: the current entry changes
    // only when a keybind focuses an entry or the reader clicks one.
    let currentEntry = null;
    const entryNodes = () => [...contentScroll.querySelectorAll(
      ":scope > .gsm-hoshidicts-tab-panel > .gsm-hoshidicts-entry, :scope > .gsm-hoshidicts-kanji-entry")];
    contentScroll.addEventListener("click", event => {
      const entry = event.button === 0 && event.target instanceof windowRef.Element
        ? event.target.closest(".gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry") : null;
      if (entry && entryNodes().includes(entry)) currentEntry = entry;
    });

    function currentEntryIndex(nodes = entryNodes()) {
      return Math.max(0, nodes.indexOf(currentEntry));
    }

    function scrollToEntry(nodes, index, target = nodes[index]) {
      currentEntry = nodes[index];
      const top = index === 0 && target === currentEntry ? 0
        : (target.getBoundingClientRect().top - contentScroll.getBoundingClientRect().top) * getCoordinateScale()
          + contentScroll.scrollTop;
      contentScroll.scrollTo({ top, behavior: "instant" });
      return true;
    }

    // Yomitan renders every entry; later entries here wait behind Show more.
    function expandEntries() {
      const showMore = contentScroll.querySelector(":scope > .gsm-hoshidicts-tab-panel > .gsm-hoshidicts-show-more");
      showMore?.click();
      return Boolean(showMore);
    }

    // Yomitan starts from the current entry's most visible definition and moves
    // to the nearest definition from another dictionary; here each dictionary
    // is one glossary card. Kanji views have no such definitions.
    function focusEntryWithDifferentDictionary(nodes, index, sign) {
      const cardsOf = node => node.classList.contains("gsm-hoshidicts-entry")
        ? [...node.querySelectorAll(".gsm-hoshidicts-glossary-grid > .gsm-hoshidicts-glossary-card")] : [];
      const dictionaryOf = card => card.querySelector(":scope > .gsm-hoshidicts-glossary-card-title")?.title ?? "";
      const cards = cardsOf(nodes[index]);
      const view = contentScroll.getBoundingClientRect();
      let visible = null, coverage = 0;
      for (const card of sign > 0 ? cards : [...cards].reverse()) {
        const { top, bottom } = card.getBoundingClientRect();
        const shown = Math.min(bottom, view.bottom) - Math.max(top, view.top);
        if (shown > coverage) { visible = card; coverage = shown; }
      }
      if (!visible) return false;
      const dictionary = dictionaryOf(visible);
      const search = entries => {
        for (let i = index; i >= 0 && i < entries.length; i += sign) {
          const ordered = sign > 0 ? cardsOf(entries[i]) : cardsOf(entries[i]).reverse();
          const start = i === index ? ordered.indexOf(visible) + 1 : 0;
          const target = ordered.slice(start).find(card => dictionaryOf(card) !== dictionary);
          if (target) return scrollToEntry(entries, i, target);
        }
        return false;
      };
      return search(nodes) || (sign > 0 && expandEntries() && search(entryNodes()));
    }

    function focusEntry(target) {
      let nodes = entryNodes();
      if (nodes.length === 0) return false;
      const index = currentEntryIndex(nodes);
      if (target.dictionary) return focusEntryWithDifferentDictionary(nodes, index, Math.sign(target.dictionary));
      const next = target === "first" ? 0 : target === "last" ? Infinity : index + target.offset;
      if (next >= nodes.length && expandEntries()) nodes = entryNodes();
      return scrollToEntry(nodes, Math.max(0, Math.min(nodes.length - 1, next)));
    }

    function resetMasonry(grid) {
      grid.classList.remove("gsm-hoshidicts-glossary-grid-masonry");
      grid.style.height = "";
      for (const card of grid.children) {
        card.style.width = "";
        card.style.transform = "";
        card.style.visibility = "";
      }
    }

    function layoutMasonry() {
      const requestedColumns = Math.max(1, Math.trunc(getPopupColumns()));
      for (const grid of popup.querySelectorAll(".gsm-hoshidicts-glossary-grid")) {
        const cards = Array.from(grid.children);
        const columns = Math.min(requestedColumns, cards.length);
        if (columns <= 1 || grid.clientWidth <= 0) {
          resetMasonry(grid);
          continue;
        }
        grid.classList.add("gsm-hoshidicts-glossary-grid-masonry");
        const columnWidth =
          (grid.clientWidth - MASONRY_GAP_PX * (columns - 1)) / columns;
        for (const card of cards) card.style.width = `${columnWidth}px`;
        // Measure after every width is set, before placement writes begin.
        const cardHeights = cards.map(card => card.offsetHeight);
        const columnHeights = Array.from({ length: columns }, () => 0);
        cards.forEach((card, index) => {
          const column = columnHeights.indexOf(Math.min(...columnHeights));
          const x = column * (columnWidth + MASONRY_GAP_PX);
          const y = columnHeights[column];
          card.style.transform = `translate(${x}px, ${y}px)`;
          card.style.visibility = "visible";
          columnHeights[column] += cardHeights[index] + MASONRY_GAP_PX;
        });
        grid.style.height = `${Math.max(...columnHeights) - MASONRY_GAP_PX}px`;
      }
      const restoreScroll = pendingScrollRestoration;
      pendingScrollRestoration = null;
      restoreScroll?.();
    }

    function scheduleMasonry() {
      if (options.queueMasonry) {
        options.queueMasonry(layoutMasonry);
        return;
      }
      if (masonryFrame !== null) {
        return;
      }
      masonryFrame = windowRef.requestAnimationFrame(() => {
        masonryFrame = null;
        layoutMasonry();
        positionPopup();
      });
    }

    const onWindowResize = () => {
      hideImagePreview();
      scheduleMasonry();
    };
    windowRef.addEventListener("resize", onWindowResize);

    function applyToolbarLayout() {
      if (!currentToolbar && !currentLookupFailure) return;
      const noteForm = currentNoteControls?.form ?? null;
      const bottom = toolbarPosition === "bottom";
      const controls = (bottom
        ? [currentLookupFailure, noteForm, currentFeedback, currentToolbar]
        : [currentToolbar, currentFeedback, noteForm, currentLookupFailure]).filter(Boolean);
      const edge = controls[bottom ? controls.length - 1 : 0];
      const atEdge = controls.every((node, index) => !controls[index + 1]
        || node.nextElementSibling === controls[index + 1])
        && (bottom ? popup.lastElementChild === edge : popup.firstElementChild === edge);
      if (atEdge) return;
      const focused = popup.getRootNode().activeElement;
      const children = [...popup.children];
      const focusedOwner = children.find(child => child.contains(focused));
      const retainedForm = noteForm?.parentNode === popup ? noteForm : null;
      const anchor = focusedOwner || retainedForm;
      if (anchor) {
        // Move siblings around the focused subtree or retained Note form:
        // detaching either interrupts keyboard interaction and draft ownership.
        const controlSet = new Set(controls);
        const content = children.filter(child => !controlSet.has(child));
        const ordered = bottom ? [...content, ...controls] : [...controls, ...content];
        const anchorIndex = ordered.indexOf(anchor);
        ordered.forEach((child, index) => {
          if (index < anchorIndex) popup.insertBefore(child, anchor);
          else if (index > anchorIndex) popup.append(child);
        });
      } else {
        if (bottom) popup.append(...controls);
        else popup.prepend(...controls);
      }
    }

    function setRenderedToolbar(toolbar, feedback = null) {
      currentToolbar = toolbar;
      currentFeedback = feedback && feedback.parentNode === popup ? feedback : null;
      applyToolbarLayout();
    }

    function setToolbarPosition(value) {
      toolbarPosition = value === "bottom" ? "bottom" : "top";
      popup.dataset.toolbarPosition = toolbarPosition;
      applyToolbarLayout();
      return toolbarPosition;
    }

    function applyDefinitionBlurState(element) {
      if (DEFINITION_BLUR_STATES.has(definitionBlurState)) {
        element.dataset.definitionBlurState = definitionBlurState;
      } else {
        delete element.dataset.definitionBlurState;
      }
    }

    function setDefinitionBlurState(state) {
      definitionBlurState = DEFINITION_BLUR_STATES.has(state) ? state : "revealed";
      if (definitionBlurState === "revealed") {
        delete popup.dataset.definitionBlurState;
      } else {
        popup.dataset.definitionBlurState = definitionBlurState;
      }
      for (const definitions of popup.querySelectorAll(".gsm-hoshidicts-definitions")) {
        applyDefinitionBlurState(definitions);
      }
      return definitionBlurState;
    }

    function clear(preserveViewControls = false) {
      currentPresentationUpdate = null;
      pendingPresentation = null;
      hideImagePreview();
      renderedImages.clear();
      renderRevision += 1;
      currentResultPanel = null;
      captureTermView = null;
      pendingScrollRestoration = null;
      currentEntry = null;
      if (!preserveViewControls) {
        currentNoteControls?.close(false);
        currentNoteControls = null;
      }
      sourceHighlighter.clear();
      currentSourceHighlight = null;
      currentToolbar = null;
      currentFeedback = null;
      currentLookupFailure = null;
      masonryObserver?.disconnect();
      const retainedForm = currentNoteControls?.form;
      // Keep the scroller mounted so a retained repaint does not discard its
      // viewport. Keep a retained live form mounted for focus and selection too.
      contentScroll.replaceChildren();
      for (const child of [...popup.childNodes]) {
        if (child !== contentScroll && child !== retainedForm && child !== resizeHandle) child.remove();
      }
      // A hidden retirement needs no layout; the next visible render resets it.
      if (!popup.hidden && !preserveViewControls) contentScroll.scrollTop = 0;
      setDefinitionBlurState("revealed");
    }

    function mountResultChrome(toolbar, content, feedback = null) {
      contentScroll.append(content);
      if (contentScroll.parentNode !== popup) popup.append(contentScroll);
      if (feedback) popup.append(feedback);
      popup.append(toolbar);
      setRenderedToolbar(toolbar, feedback);
    }

    function retainedFocus(preserveViewControls) {
      if (!preserveViewControls) return null;
      const focused = popup.getRootNode().activeElement;
      if (!popup.contains(focused)) return null;
      if (focused.matches('[role="tab"]')) return '[role="tab"][aria-selected="true"]';
      if (focused.matches(".gsm-hoshidicts-kanji-back")) return ".gsm-hoshidicts-kanji-back";
      return focused;
    }

    function restoreRetainedFocus(focused) {
      const control = typeof focused === "string" ? popup.querySelector(focused) : focused;
      if (!control || !popup.contains(control)) return;
      if (popup.getRootNode().activeElement !== control) control.focus();
      control.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }

    function canProjectPresentation() {
      const form = currentNoteControls?.form;
      if (form && (!form.hidden || form.getAttribute("aria-busy") === "true")) return false;
      if (options.canProjectDictionaryPresentation?.() === false) return false;
      const focused = popup.getRootNode().activeElement;
      return !popup.contains(focused) || focused.matches('[role="tab"]')
        || currentNoteControls?.actions.contains(focused);
    }

    function flushDictionaryPresentation() {
      if (!pendingPresentation || !currentPresentationUpdate) return;
      const pending = pendingPresentation;
      if (currentPresentationUpdate(pending) && pendingPresentation === pending) pendingPresentation = null;
    }

    function onPresentationFocusOut() {
      if (pendingPresentation) windowRef.queueMicrotask(flushDictionaryPresentation);
    }
    popup.addEventListener("focusout", onPresentationFocusOut);

    function configureEntryActions(actions, label) {
      actions.className = "gsm-hoshidicts-entry-actions";
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", label);
      actions.addEventListener("focusin", event => {
        const item = [...actions.children].find(child =>
          child === event.target || child.contains(event.target));
        if (!item || actions.scrollWidth <= actions.clientWidth) return;
        const padding = 2;
        const left = item.offsetLeft;
        const right = left + item.offsetWidth;
        if (left < actions.scrollLeft + padding) {
          actions.scrollLeft = Math.max(0, left - padding);
        } else if (right > actions.scrollLeft + actions.clientWidth - padding) {
          actions.scrollLeft = right - actions.clientWidth + padding;
        }
      });
      return actions;
    }

    function runRenderAction(isCurrent, renderContext, action) {
      if (!isCurrent()) return;
      try {
        return action();
      } catch (error) {
        if (!isCurrent()) return;
        clear();
        renderContext.onRenderError?.(error);
      }
    }

    function ownsResultPanel(panel, renderContext) {
      return currentResultPanel === panel && renderContext.isCurrentRequest?.() !== false;
    }

    function ownsDisplayedPanel(panel, renderContext) {
      const isCurrent = renderContext.isCurrentView || renderContext.isCurrentRequest;
      return currentResultPanel === panel && isCurrent?.() !== false;
    }

    function createNoteControls(readPrefill, renderContext = {}) {
      if (currentNoteControls) {
        currentNoteControls.setPrefillReader(readPrefill, renderContext);
        return currentNoteControls;
      }
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "gsm-hoshidicts-note-button";
      button.title = "Edit personal dictionary";
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-expanded", "false");

      const icon = documentRef.createElement("span");
      icon.className = "gsm-hoshidicts-note-icon hd-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.dataset.icon = "edit";
      button.appendChild(icon);

      const actions = documentRef.createElement("div");
      configureEntryActions(actions, "Lookup actions");
      actions.appendChild(button);
      const buttonNodes = new Map();

      function createCustomButton(value) {
        const custom = documentRef.createElement("button");
        custom.type = "button";
        custom.dataset.customButtonId = value.id;
        const label = documentRef.createElement("span");
        label.className = "gsm-hoshidicts-text-action-label";
        custom.appendChild(label);
        if (value.type === "link") {
          custom.className = "gsm-hoshidicts-external-link-button gsm-hoshidicts-text-action-button";
          const activate = event => {
            if (event.defaultPrevented || event.button !== (event.type === "auxclick" ? 1 : 0)) return;
            event.preventDefault();
            event.stopPropagation();
            const link = customButtons.find(candidate =>
              candidate.id === custom.dataset.customButtonId && candidate.type === "link");
            if (!link || !custom.isConnected || popup.hidden || currentNoteControls?.actions !== actions
                || renderContext.isCurrentRequest?.() === false) return;
            const prefill = readPrefill() || {};
            const url = windowRef.HDExternalLinks.expandCustomLinkUrl(link.url, {
              word: prefill.term, reading: prefill.reading, sentence: prefill.sentence,
            });
            if (url) options.onCustomLinkClick?.({ url,
              active: event.shiftKey || !(event.button === 1 || event.ctrlKey || event.metaKey) });
          };
          custom.addEventListener("click", activate);
          custom.addEventListener("auxclick", activate);
        } else {
          custom.className = "gsm-hoshidicts-custom-anki-button gsm-hoshidicts-text-action-button";
          custom.disabled = true;
        }
        return custom;
      }

      function updateButtons() {
        const retained = new Set();
        const ordered = [];
        for (const value of customButtons) {
          let custom = buttonNodes.get(value.id);
          const expectedType = value.type === "anki" ? "anki" : "link";
          if (custom && custom.dataset.customButtonType !== expectedType) {
            custom.remove();
            buttonNodes.delete(value.id);
            custom = null;
          }
          if (!custom) {
            custom = createCustomButton(value);
            custom.dataset.customButtonType = expectedType;
            buttonNodes.set(value.id, custom);
          }
          custom.firstElementChild.textContent = value.label;
          custom.dataset.customButtonLabel = value.label;
          custom.title = value.type === "anki" ? `Send to Anki with ${value.label}` : value.label;
          custom.setAttribute("aria-label", custom.title);
          if (value.type === "anki") custom.dataset.ankiTemplateId = value.templateId;
          else delete custom.dataset.ankiTemplateId;
          retained.add(value.id);
          ordered.push(custom);
        }
        for (const [id, removed] of buttonNodes) {
          if (retained.has(id)) continue;
          const focused = popup.getRootNode().activeElement === removed;
          removed.remove();
          buttonNodes.delete(id);
          if (focused) button.focus();
        }
        actions.append(...ordered);
      }
      updateButtons();

      let editor = null;
      button.addEventListener("click", () => {
        if (!editor) {
          editor = createNoteForm(button, () => readPrefill());
          applyToolbarLayout();
        }
        if (editor.form.hidden) editor.open();
        else editor.close();
      });
      return {
        actions,
        button,
        close: (restoreFocus) => editor?.close(restoreFocus) ?? false,
        updateButtons,
        setPrefillReader(value, context) { readPrefill = value; renderContext = context; },
        get form() { return editor?.form ?? null; },
      };
    }

    function setCustomButtons(value) {
      const next = value || [];
      if (JSON.stringify(customButtons) === JSON.stringify(next)) return;
      customButtons = next;
      currentNoteControls?.updateButtons();
      positionPopup();
    }

    function setCustomLinks(value) {
      setCustomButtons((value || []).map((link, index) => ({
        id: `legacy-link-${index + 1}`,
        type: "link",
        ...link,
      })));
    }

    function createNoteForm(button, readPrefill) {
      const form = documentRef.createElement("form");
      form.className = "gsm-hoshidicts-note-form";
      form.id = `${idPrefix}-note-form`;
      form.hidden = true;
      button.setAttribute("aria-controls", form.id);

      function createField(labelText, name, multiline = false) {
        const label = documentRef.createElement("label");
        label.className = "gsm-hoshidicts-note-field";
        const labelValue = documentRef.createElement("span");
        labelValue.textContent = labelText;
        const control = multiline
          ? documentRef.createElement("textarea")
          : documentRef.createElement("input");
        control.id = `${idPrefix}-note-${name}`;
        control.name = name;
        control.className = `gsm-hoshidicts-note-${name}`;
        control.required = true;
        if (!multiline) control.autocomplete = "off";
        label.htmlFor = control.id;
        label.append(labelValue, control);
        form.appendChild(label);
        return control;
      }

      const term = createField("Term", "term");
      const reading = createField("Reading", "reading");
      const definition = createField("Definition", "definition", true);
      const error = documentRef.createElement("div");
      error.className = "gsm-hoshidicts-note-error";
      error.setAttribute("role", "alert");
      error.hidden = true;
      form.appendChild(error);

      const formActions = documentRef.createElement("div");
      formActions.className = "gsm-hoshidicts-note-actions";
      const cancel = documentRef.createElement("button");
      cancel.type = "button";
      cancel.className = "gsm-hoshidicts-note-cancel";
      cancel.textContent = "Cancel";
      const save = documentRef.createElement("button");
      save.type = "submit";
      save.className = "gsm-hoshidicts-note-save";
      save.textContent = "Save";
      formActions.append(cancel, save);
      form.appendChild(formActions);

      let editing = false;
      let accepted = false;

      function close(restoreFocus = true) {
        if (form.hidden) return false;
        form.hidden = true;
        button.setAttribute("aria-expanded", "false");
        error.hidden = true;
        error.textContent = "";
        if (editing) {
          editing = false;
          onNoteEditingChange(false);
        }
        if (restoreFocus && button.isConnected) button.focus();
        positionPopup();
        flushDictionaryPresentation();
        return true;
      }

      function open() {
        accepted = false;
        const prefill = readPrefill() || {};
        term.value = String(prefill.term || "");
        reading.value = String(prefill.reading || "");
        definition.value = String(prefill.definition || "");
        error.hidden = true;
        error.textContent = "";
        form.hidden = false;
        button.setAttribute("aria-expanded", "true");
        if (!editing) {
          editing = true;
          onNoteEditingChange(true);
        }
        positionPopup();
        form.scrollTop = 0;
        term.focus();
        term.select();
      }

      cancel.addEventListener("click", () => close());
      form.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && close()) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (accepted) return;
        const entry = {
          term: term.value,
          reading: reading.value,
          definition: definition.value,
        };
        if (Object.values(entry).some((value) => value.trim() === "")) {
          error.textContent = "Complete the term, reading, and definition.";
          error.hidden = false;
          positionPopup();
          return;
        }
        error.hidden = true;
        error.textContent = "";
        try {
          onAddCustomEntry(entry);
          accepted = true;
          close();
        } catch (appendError) {
          error.textContent = typeof appendError?.message === "string"
            ? appendError.message
            : String(appendError);
          error.hidden = false;
          positionPopup();
        }
      });

      return { close, open, form };
    }

    function setSourceHighlightEnabled(enabled) {
      sourceHighlightEnabled = enabled === true;
      if (!sourceHighlightEnabled) {
        sourceHighlighter.clear();
      } else if (currentSourceHighlight) {
        sourceHighlighter.apply(
          currentSourceHighlight.candidate,
          currentSourceHighlight.matchedText
        );
      }
      return sourceHighlightEnabled;
    }

    function setLookupStats(element, payload) {
      const lookedUp = formatLookupCount(
        "Looked up",
        payload && payload.lookupCount
      );
      element.textContent = lookedUp ?? "";
      element.hidden = lookedUp === null;
      if (!element.hidden) {
        positionPopup();
      }
    }

    // Not named `chrome`: this runs in the content script's isolated world, where
    // that identifier is the extension API.
    function createResultChrome(primaryHeader, metadataStrip = null) {
      const wrapper = documentRef.createElement("div");
      wrapper.className = "gsm-hoshidicts-result-chrome";
      wrapper.appendChild(primaryHeader);
      if (metadataStrip) {
        wrapper.appendChild(metadataStrip);
      }
      return wrapper;
    }

    function renderNotice(message, candidate, renderContext = {}) {
      clear();
      const notice = documentRef.createElement("div");
      notice.className = "gsm-hoshidicts-lookup-notice";
      notice.setAttribute("role", "status");
      notice.textContent = message;
      currentNoteControls = createNoteControls(() => ({
        term: candidate?.query || "", reading: "", definition: "", sentence: candidate?.sentence || "",
      }), renderContext);
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className = "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      primaryHeader.appendChild(currentNoteControls.actions);
      mountResultChrome(createResultChrome(primaryHeader), notice);
    }

    function renderLookupFailure(state, { preserveView = false } = {}) {
      currentLookupFailure?.remove();
      currentLookupFailure = null;
      if (!preserveView) clear();
      const failure = documentRef.createElement("div");
      failure.className = "gsm-hoshidicts-lookup-failure";
      failure.dataset.kind = state.kind;
      failure.setAttribute("role", "alert");
      const copy = documentRef.createElement("div");
      copy.className = "gsm-hoshidicts-lookup-failure-copy";
      const title = documentRef.createElement("strong");
      title.className = "gsm-hoshidicts-lookup-failure-title";
      title.textContent = state.title;
      const detail = documentRef.createElement("span");
      detail.className = "gsm-hoshidicts-lookup-failure-detail";
      detail.textContent = state.detail;
      copy.append(title, detail);
      failure.appendChild(copy);
      if (typeof state.onAction === "function" && typeof state.actionLabel === "string") {
        const action = documentRef.createElement("button");
        action.type = "button";
        action.className = "gsm-hoshidicts-lookup-failure-action gsm-hoshidicts-text-action-button";
        action.textContent = state.actionLabel;
        action.addEventListener("click", () => {
          action.disabled = true;
          Promise.resolve(state.onAction()).catch(() => {
            if (action.isConnected) action.disabled = false;
          });
        });
        failure.appendChild(action);
      }
      currentLookupFailure = failure;
      popup.appendChild(failure);
      applyToolbarLayout();
      return failure;
    }

    function appendMetadata(
      entry,
      result,
      dictionaryPresentation = [],
      {
        includeFrequency = true,
        includePitch = true,
        averageFrequency = false,
        showFrequencyDictionaryNames = false,
        imageContext,
        isCurrent,
        onLayoutChange,
      } = {}
    ) {
      const frequencyRow = documentRef.createElement("div");
      frequencyRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-frequency-metadata";
      const pitchRow = documentRef.createElement("div");
      pitchRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-pitch-metadata";
      const ipaRow = documentRef.createElement("div");
      ipaRow.className = "gsm-hoshidicts-metadata gsm-hoshidicts-ipa-metadata";
      let frequencyCount = 0;
      function updateFrequency(context) {
        const frequencyTags = includeFrequency ? createFrequencyTags(
          documentRef,
          result,
          context.dictionaryPresentation || [],
          maxMetadataTags,
          context.averageFrequency === true,
          context.showFrequencyDictionaryNames === true
        ) : [];
        const countChanged = frequencyCount !== frequencyTags.length;
        frequencyCount = frequencyTags.length;
        frequencyRow.replaceChildren(...frequencyTags);
        return countChanged;
      }
      function updatePitch(context) {
        pitchRow.replaceChildren();
        if (context.showPitchAccentBadge !== true) return;
        const names = createDictionaryDisplayNames(result.term.pitches.map(({ dictionary }) => dictionary),
          context.dictionaryPresentation);
        const seen = new Set();
        let count = frequencyCount;
        for (const group of result.term.pitches) {
          for (const pitch of group.pitches) {
            const reading = String(
              result.term.reading || result.term.expression || ""
            ).trim();
            const key = JSON.stringify([
              group.dictionary,
              reading,
              pitch.position,
              pitch.pattern,
            ]);
            if (!seen.has(key) && count < maxMetadataTags) {
              seen.add(key);
              pitchRow.appendChild(createPitchTag(
                documentRef,
                group,
                names.get(group.dictionary) || group.dictionary,
                pitch,
                reading,
                buildPitchAccentMorae
              ));
              count += 1;
            }
          }
        }
      }
      const ipaGroups = result.term.pitches.filter(group => group.transcriptions.length > 0);
      let fillOpenIpa = () => {};
      function appendTranscriptions(target) {
        const names = createDictionaryDisplayNames(ipaGroups.map(({ dictionary }) => dictionary), imageContext.dictionaryPresentation);
        for (const group of ipaGroups) {
          const body = group.transcriptions.join(" · ");
          target.appendChild(createPronunciationTag(documentRef, group, names.get(group.dictionary) || group.dictionary,
            body, "ipa"));
        }
      }
      if (ipaGroups.length > maxMetadataTags) {
        // Reuse the existing metadata display budget as a lazy threshold, not
        // a data limit. Opening the disclosure still renders every source.
        const overflow = documentRef.createElement("details");
        overflow.className = "gsm-hoshidicts-ipa-overflow";
        const summary = documentRef.createElement("summary");
        summary.textContent = `Phonetic transcriptions (${ipaGroups.length})`;
        const body = documentRef.createElement("div");
        body.className = "gsm-hoshidicts-metadata";
        overflow.append(summary, body);
        fillOpenIpa = () => {
          if (overflow.open && !body.hasChildNodes()) appendTranscriptions(body);
        };
        overflow.addEventListener("toggle", () => {
          if (!isCurrent()) return;
          fillOpenIpa();
          onLayoutChange();
        });
        ipaRow.appendChild(overflow);
      } else appendTranscriptions(ipaRow);
      const context = { dictionaryPresentation, averageFrequency, showFrequencyDictionaryNames,
        showPitchAccentBadge: includePitch };
      updateFrequency(context);
      updatePitch(context);
      entry.append(frequencyRow, pitchRow, ipaRow);
      return { updateFrequency, updatePitch, fillOpenIpa, rows: [frequencyRow, pitchRow, ipaRow] };
    }

    function collectGrammarMetadata(result) {
      const metadata = [];
      const seen = new Set();
      const append = (text, description, kind) => {
        const value = String(text || "").trim();
        if (!value || seen.has(value)) {
          return;
        }
        seen.add(value);
        metadata.push({ description, kind, text: value });
      };
      for (const step of deinflectionSteps(result)) {
        append(step.name, step.description, "deinflection");
      }
      for (const tag of [
        ...parseTagList(result.term.rules),
        ...result.term.glossaries.flatMap((glossary) =>
          parseTagList(glossary.termTags)
        ),
      ]) {
        append(tag, "", "term");
      }
      return metadata;
    }

    function renderGrammarRow(row, result, hideGrammarTags) {
      row.replaceChildren();
      if (hideGrammarTags) return;
      for (const item of collectGrammarMetadata(result)) {
        row.appendChild(createTag(documentRef, item.text, item.description, item.kind));
      }
    }

    function renderPrimaryMetadataCapsule(
      capsule,
      result,
      dictionaryPresentation,
      hideGrammarTags,
      averageFrequency,
      showFrequencyDictionaryNames,
      { frequencyChanged = true, grammarChanged = true } = {}
    ) {
      if (frequencyChanged) {
        capsule.querySelector(".gsm-hoshidicts-primary-frequencies")?.remove();
        const frequencyTags = createFrequencyTags(
          documentRef,
          result,
          dictionaryPresentation,
          maxMetadataTags,
          averageFrequency,
          showFrequencyDictionaryNames
        );
        if (frequencyTags.length > 0) {
          const frequencies = documentRef.createElement("span");
          frequencies.className = "gsm-hoshidicts-primary-frequencies";
          frequencies.append(...frequencyTags);
          capsule.prepend(frequencies);
        }
      }
      if (grammarChanged) {
        capsule.querySelector(".gsm-hoshidicts-primary-grammar")?.remove();
        if (!hideGrammarTags) {
          const grammarMetadata = collectGrammarMetadata(result);
          if (grammarMetadata.length > 0) {
            const grammar = documentRef.createElement("span");
            grammar.className = "gsm-hoshidicts-primary-grammar";
            for (const item of grammarMetadata) {
              const tag = documentRef.createElement("span");
              tag.className =
                `gsm-hoshidicts-primary-grammar-tag ` +
                `gsm-hoshidicts-primary-grammar-tag-${item.kind}`;
              tag.textContent = item.text;
              if (item.description) {
                tag.title = item.description;
              }
              grammar.appendChild(tag);
            }
            capsule.appendChild(grammar);
          }
        }
      }
      capsule.hidden = capsule.childNodes.length === 0;
    }

    function updateCompactSummary(headword, result, context, media) {
      const previous = headword.querySelector(".gsm-hoshidicts-compact-definition-summary");
      if (previous) {
        const imageLink = previous.querySelector(".gloss-image-link");
        if (imageLink) hideImagePreview(imageLink);
        previous.remove();
      }
      if (context.showCompactDefinitionSummary !== true) return Boolean(previous);
      const compact = extractCompactDefinitionSummary(result.term.glossaries,
        context.compactDefinitionSummaryDictionary, context.compactDefinitionSummaryCount);
      if (!compact) return Boolean(previous);
      const summary = documentRef.createElement("div");
      summary.className = "gsm-hoshidicts-compact-definition-summary";
      summary.dataset.hoshidictsDictionary = compact.dictionary;
      // Establish ownership before synchronous media admission. Replacing this
      // summary retires its consumer without retiring the complete card's one.
      headword.querySelector(".gsm-hoshidicts-expression").after(summary);
      if (compact.image) {
        const thumbnail = documentRef.createElement("span");
        thumbnail.className = "gsm-hoshidicts-compact-definition-image";
        summary.appendChild(thumbnail);
        appendStructuredImage(documentRef, thumbnail, { ...compact.image,
          preferredWidth: 36, preferredHeight: 36, sizeUnits: "px", collapsed: false }, {
          isCurrent: () => headword.contains(summary) && media.isCurrent(),
          isImageCurrent: () => summary.isConnected && headword.contains(summary) && media.isCurrentLink(),
          dictionary: compact.dictionary,
          imageContext: media.imageContext,
          imageSourceLabelHost: summary,
          onImageCreated: media.onImageCreated,
          onLayoutChange: media.onLayoutChange,
          onImageError: () => thumbnail.remove(),
          onImageStart: () => { if (!summary.contains(thumbnail)) summary.prepend(thumbnail); },
          requestImagePreview, refreshImagePreview, hideImagePreview,
          resolveMedia: typeof media.resolveMedia === "function"
            ? query => media.resolveMedia({ ...query, dictionary: compact.dictionary, generation: media.generation })
            : null,
        });
        if (!thumbnail.hasChildNodes()) thumbnail.remove();
      }
      const items = documentRef.createElement("ul");
      items.className = "gsm-hoshidicts-compact-definition-items";
      for (const item of compact.items) {
        const li = documentRef.createElement("li");
        li.textContent = item;
        items.appendChild(li);
      }
      summary.appendChild(items);
      return true;
    }

    function createEntryHeader(
      result,
      candidate,
      {
        element = null,
        primary = false,
        showCompactDefinitionSummary = false,
        compactDefinitionSummaryCount =
          DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT,
        compactDefinitionSummaryDictionary = null,
        summaryMedia = null,
        showPitchAccentFurigana = true,
        pitchAccentFuriganaDictionary = null,
        onBack = null,
        onClose = null,
        noteControls = null,
        feedback = null,
        onDeinflectionToggle = null,
      } = {}
    ) {
      const header = element || documentRef.createElement("header");
      header.className = primary
        ? "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header"
        : "gsm-hoshidicts-entry-header";
      header.replaceChildren();

      const headword = documentRef.createElement("div");
      headword.className = "gsm-hoshidicts-headword";
      const expression = documentRef.createElement("span");
      expression.className = "gsm-hoshidicts-expression";
      const expressionText = String(result.term.expression || "").trim();
      const readingText = String(result.term.reading || "").trim();
      function populateRuby() {
        expression.replaceChildren();
        appendExpressionRuby(
          documentRef,
          expression,
          expressionText,
          readingText,
          (character, sourceLink) => onKanjiClick(character, result, candidate, sourceLink),
          {
            enabled: showPitchAccentFurigana,
            groups: result.term.pitches,
            dictionary: pitchAccentFuriganaDictionary,
          }
        );
      }
      populateRuby();
      expression.setAttribute(
        "aria-label",
        readingText && readingText !== expressionText
          ? `${expressionText}, ${readingText}`
          : expressionText
      );
      headword.appendChild(expression);
      if (showCompactDefinitionSummary === true) {
        updateCompactSummary(headword, result, { showCompactDefinitionSummary,
          compactDefinitionSummaryCount, compactDefinitionSummaryDictionary }, summaryMedia);
      }
      const deinflection = buildDeinflectionDisclosure(documentRef, result, windowRef.navigator.language);
      if (deinflection) {
        deinflection.addEventListener("toggle", onDeinflectionToggle);
        headword.appendChild(deinflection);
      }
      let navigationAction = null;
      if (primary && (typeof onBack === "function" || typeof onClose === "function")) {
        navigationAction = documentRef.createElement("button");
        navigationAction.type = "button";
        if (typeof onClose === "function") {
          navigationAction.className = "gsm-hoshidicts-popup-close";
          navigationAction.setAttribute("aria-label", "Close lookup");
          navigationAction.addEventListener("click", onClose);
        } else {
          navigationAction.className = "gsm-hoshidicts-kanji-back";
          navigationAction.textContent = "Back";
          navigationAction.setAttribute("aria-label", "Back to previous results");
          navigationAction.addEventListener("click", onBack);
        }
      }
      header.appendChild(headword);
      const actions = primary && noteControls ? noteControls.actions : documentRef.createElement("div");
      if (!primary || !noteControls) configureEntryActions(actions, "Entry actions");
      if (primary && noteControls) actions.querySelector(".gsm-hoshidicts-audio-control")?.remove();
      for (const previous of actions.querySelectorAll(
        ":scope > .gsm-hoshidicts-popup-close, :scope > .gsm-hoshidicts-kanji-back"
      )) previous.remove();
      const audio = documentRef.createElement("div");
      audio.className = "gsm-hoshidicts-audio-control";
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "gsm-hoshidicts-audio-button";
      button.title = "Play pronunciation; Shift-click, right-click or press Down for choices";
      button.setAttribute("aria-label", `Play pronunciation for ${expressionText}`);
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      audio.append(button);
      actions.prepend(audio);
      const existingMiningAction = actions.querySelector(":scope > .gsm-hoshidicts-mine-button");
      if (existingMiningAction) actions.prepend(existingMiningAction);
      if (navigationAction) actions.prepend(navigationAction);
      header.append(actions);
      return { element: header, audio: { button, result }, mining: { actions, feedback, result },
        updateRuby(context) {
          const enabled = context.showPitchAccentFurigana !== false;
          const dictionary = typeof context.pitchAccentFuriganaDictionary === "string"
            ? context.pitchAccentFuriganaDictionary : null;
          if (enabled === showPitchAccentFurigana && dictionary === pitchAccentFuriganaDictionary) return false;
          const appearanceChanged = enabled !== showPitchAccentFurigana || enabled;
          // A kanji button is part of this ruby. Keep its identity until blur;
          // Note, disclosure and glossary focus need no such deferral.
          if (appearanceChanged && expression.contains(popup.getRootNode().activeElement)) return null;
          showPitchAccentFurigana = enabled;
          pitchAccentFuriganaDictionary = dictionary;
          if (appearanceChanged) populateRuby();
          return appearanceChanged;
        },
      };
    }

    function projectResults(results, dictionaries) {
      if (dictionaries.size === 0) {
        return results;
      }
      const projected = [];
      for (const result of results) {
        const glossaries = result.term.glossaries.filter(
          (glossary) => dictionaries.has(glossary.dictionary)
        );
        if (glossaries.length === 0) {
          continue;
        }
        projected.push({
          ...result,
          term: {
            ...result.term,
            glossaries,
          },
        });
      }
      return projected;
    }

    function renderResultPanel(
      panel,
      results,
      candidate,
      renderContext,
      {
        dictionaryDisplayNames,
        imageContext,
        feedback,
        primaryHeader,
        primaryMetadataCapsule,
      } = {}
    ) {
      const revision = ++renderRevision;
      const isCurrent = () => revision === renderRevision && ownsResultPanel(panel, renderContext);
      const isCurrentLink = () => revision === renderRevision && ownsDisplayedPanel(panel, renderContext);
      const positionIfCurrent = () => { if (isCurrent()) positionPopup(); };
      const onImageCreated = handle => renderedImages.add(handle);
      const resolveImage = query => imageContext.resolveMedia(query);
      const summaryMedia = { isCurrent, isCurrentLink, generation: renderContext.generation,
        imageContext, onImageCreated,
        resolveMedia: typeof imageContext.resolveMedia === "function" ? resolveImage : null,
        onLayoutChange: positionIfCurrent };
      hideImagePreview();
      renderedImages.clear();
      panel.replaceChildren();
      if (feedback) {
        feedback.hidden = true;
        feedback.textContent = "";
        delete feedback.dataset.kind;
      }
      const deferredGlossaryFills = [];
      const entryMetadata = [];
      const audioButtons = [];
      const miningActions = [];
      let appliedMetadata = metadataOptions(imageContext);
      let appliedFrequencyModes = frequencyModes(imageContext);
      let appliedDictionaryPresentation = imageContext.dictionaryPresentation;
      let lookupStats = null;
      let expanded = renderContext.expandAll === true;
      let restoreScrollTop = renderContext.restoreScrollTop;
      let restoreDisclosures = renderContext.restoreDisclosures;

      function restoreViewportAfterFill() {
        if (restoreDisclosures) {
          const details = [...popup.querySelectorAll("details")];
          if (details.length === restoreDisclosures.length
              && details.every((node, index) => node.className === restoreDisclosures[index].className)) {
            details.forEach((node, index) => { node.open = restoreDisclosures[index].open; });
            // Native toggle delivery is deferred. Populate restored lazy IPA
            // now so the first restored layout includes all its text.
            for (const { metadata } of entryMetadata) metadata.fillOpenIpa();
          }
          restoreDisclosures = undefined;
        }
        if (restoreScrollTop === undefined) return;
        const savedScrollTop = restoreScrollTop;
        restoreScrollTop = undefined;
        // Back's scroll height is meaningful only after the deferred bodies
        // and masonry are laid out. A newer projection or deliberate scroll
        // takes precedence over this one-shot restoration.
        pendingScrollRestoration = () => {
          // Back's fresh render reset scroll to zero. Reading it earlier,
          // while the panel is empty, would force an unnecessary layout.
          if (isCurrent() && contentScroll.scrollTop === 0) contentScroll.scrollTop = savedScrollTop;
        };
        scheduleMasonry();
      }

      function appendResult(result, resultIndex) {
        Object.assign(renderContext, metadataOptions(imageContext));
        const entry = documentRef.createElement("article");
        entry.className = "gsm-hoshidicts-entry";
        entry.dataset.expression = result.term.expression;

        const renderedHeader = createEntryHeader(result, candidate, {
          element: resultIndex === 0 ? primaryHeader : null,
          primary: resultIndex === 0,
          showCompactDefinitionSummary:
            renderContext.showCompactDefinitionSummary === true,
          compactDefinitionSummaryCount:
            renderContext.compactDefinitionSummaryCount,
          compactDefinitionSummaryDictionary:
            typeof renderContext.compactDefinitionSummaryDictionary === "string"
              ? renderContext.compactDefinitionSummaryDictionary
              : null,
          summaryMedia,
          showPitchAccentFurigana:
            renderContext.showPitchAccentFurigana !== false,
          pitchAccentFuriganaDictionary:
            typeof renderContext.pitchAccentFuriganaDictionary === "string"
              ? renderContext.pitchAccentFuriganaDictionary
              : null,
          onBack: resultIndex === 0 ? renderContext.onBack : null,
          onClose: resultIndex === 0 ? renderContext.onClose : null,
          noteControls: resultIndex === 0 ? renderContext.noteControls : null,
          feedback,
          onDeinflectionToggle: positionIfCurrent,
        });
        audioButtons.push(renderedHeader.audio);
        miningActions.push(renderedHeader.mining);
        if (resultIndex !== 0) {
          entry.appendChild(renderedHeader.element);
        }

        // The lookup count and the frequency share one line.
        const primaryMetadataRow = resultIndex === 0 ? documentRef.createElement("div") : null;
        if (primaryMetadataRow) {
          primaryMetadataRow.className = "gsm-hoshidicts-primary-metadata-row";
          entry.appendChild(primaryMetadataRow);
        }

        if (resultIndex === 0 && renderContext.lookupStatsSlot === true) {
          lookupStats = documentRef.createElement("div");
          lookupStats.className = "gsm-hoshidicts-lookup-stats";
          lookupStats.setAttribute("role", "status");
          lookupStats.setAttribute("aria-live", "polite");
          lookupStats.hidden = true;
          primaryMetadataRow.appendChild(lookupStats);
        }

        if (resultIndex === 0 && primaryMetadataCapsule) {
          renderPrimaryMetadataCapsule(
            primaryMetadataCapsule,
            result,
            Array.isArray(renderContext.dictionaryPresentation)
              ? renderContext.dictionaryPresentation
              : [],
            renderContext.hidePopupGrammarTags !== false,
            renderContext.averageFrequency === true,
            renderContext.showFrequencyDictionaryNames === true
          );
          primaryMetadataRow.appendChild(primaryMetadataCapsule);
        }

        const metadata = appendMetadata(
          entry,
          result,
          Array.isArray(imageContext.dictionaryPresentation)
            ? imageContext.dictionaryPresentation
            : [],
          {
            includeFrequency: resultIndex !== 0,
            imageContext,
            isCurrent: isCurrentLink,
            onLayoutChange: scheduleMasonry,
            includePitch: renderContext.showPitchAccentBadge === true,
            averageFrequency: renderContext.averageFrequency === true,
            showFrequencyDictionaryNames:
              renderContext.showFrequencyDictionaryNames === true,
          }
        );

        const grammarRow = resultIndex === 0 ? null : documentRef.createElement("div");
        if (grammarRow) {
          grammarRow.className = "gsm-hoshidicts-tags";
          renderGrammarRow(grammarRow, result, renderContext.hidePopupGrammarTags !== false);
          entry.appendChild(grammarRow);
        }
        entryMetadata.push({ header: renderedHeader, metadata, grammarRow });

        const groupedGlossaries = new Map();
        for (const glossary of result.term.glossaries) {
          if (!groupedGlossaries.has(glossary.dictionary)) {
            groupedGlossaries.set(glossary.dictionary, []);
          }
          groupedGlossaries.get(glossary.dictionary).push(glossary);
        }
        const glossaryGrid = documentRef.createElement("div");
        glossaryGrid.className = "gsm-hoshidicts-glossary-grid";
        for (const [dictionary, glossaries] of groupedGlossaries) {
          // Always open, as in Yomitan: only disclosures a dictionary authors
          // inside its own content collapse.
          const card = documentRef.createElement("div");
          card.className = "gsm-hoshidicts-glossary-card";
          const title = documentRef.createElement("div");
          title.className = "gsm-hoshidicts-glossary-card-title";
          title.textContent = dictionaryDisplayNames?.get(dictionary) || dictionary;
          title.title = dictionary;
          card.appendChild(title);
          const definitions = documentRef.createElement("ol");
          definitions.className = "gsm-hoshidicts-definitions";
          if (glossaries.length === 1) {
            definitions.classList.add("gsm-hoshidicts-definitions-single");
          }
          applyDefinitionBlurState(definitions);
          for (const [definitionIndex, glossary] of glossaries.entries()) {
            const definition = documentRef.createElement("li");
            const definitionTags = parseTagList(glossary.definitionTags);
            if (definitionTags.length > 0) {
              const definitionTagRow = documentRef.createElement("div");
              definitionTagRow.className = "gsm-hoshidicts-definition-tags";
              for (const tag of definitionTags) {
                definitionTagRow.appendChild(
                  createTag(documentRef, tag, "", "definition")
                );
              }
              definition.appendChild(definitionTagRow);
            }
            const content = documentRef.createElement("div");
            content.className = "gsm-hoshidicts-glossary-content";
            content.dataset.hoshidictsDictionary = dictionary;
            const fillContent = () => {
              try {
                appendTextOnlyGlossary(
                  documentRef,
                  content,
                  glossary.glossary,
                  {
                    dictionary,
                    generation: renderContext.generation,
                    isCurrent,
                    isCurrentLink,
                    onExternalLink: renderContext.onExternalLink,
                    onInternalLink: renderContext.onInternalLink,
                    onLayoutChange: positionIfCurrent,
                    requestImagePreview,
                    refreshImagePreview,
                    hideImagePreview,
                    imageContext,
                    onImageCreated,
                    resolveMedia: typeof imageContext.resolveMedia === "function" ? resolveImage : null,
                  }
                );
              } catch (error) {
                const contextual = structuredContentRenderError(error, {
                  definitionIndex,
                  dictionary,
                  dictionaryId: dictionaryStableId(
                    dictionary,
                    imageContext.dictionaryPresentation
                  ),
                  resultIndex,
                  term: result.term,
                });
                // A dictionary-authored glossary that exhausts the traversal
                // budget must not hide healthy cards from the same lookup.
                // Unexpected renderer failures still use the view-wide error
                // boundary so programming errors are not silently swallowed.
                if (contextual === error) throw error;
                content.replaceChildren();
                console.warn("hachidori: omitted dictionary definition after render failure", contextual);
              }
            };
            // Glossary bodies are most of a render. Only the first entry is
            // visible in the popup, so fill the rest after it has painted.
            if (resultIndex === 0) {
              fillContent();
            } else {
              deferredGlossaryFills.push(fillContent);
            }
            definition.appendChild(content);
            definitions.appendChild(definition);
          }
          card.appendChild(definitions);
          glossaryGrid.appendChild(card);
        }
        entry.appendChild(glossaryGrid);
        // Fixed-width masonry cards cannot signal a change to their container.
        masonryObserver?.observe(glossaryGrid);
        for (const card of glossaryGrid.children) {
          masonryObserver?.observe(card);
        }
        scheduleMasonry();
        panel.appendChild(entry);
      }

      // Fills the queued glossaries on the next task, once the first entry has
      // had a chance to paint. Fills inline without a timer available.
      function flushDeferredGlossaries(immediate = false) {
        if (deferredGlossaryFills.length === 0) {
          restoreViewportAfterFill();
          return;
        }
        const fills = deferredGlossaryFills.splice(0);
        const run = () => {
          for (const fill of fills) {
            if (!isCurrent()) return;
            fill();
          }
          if (!immediate) positionIfCurrent();
          restoreViewportAfterFill();
        };
        if (!immediate && typeof windowRef.setTimeout === "function") {
          windowRef.setTimeout(() => runRenderAction(isCurrent, renderContext, run), 0);
        } else {
          run();
        }
      }

      const visibleCount = renderContext.expandAll === true ? results.length : initialResultCount;
      results.slice(0, visibleCount).forEach(appendResult);
      flushDeferredGlossaries();

      if (results.length > visibleCount) {
        let nextResultIndex = visibleCount;
        const showMore = documentRef.createElement("button");
        showMore.type = "button";
        showMore.className = "gsm-hoshidicts-show-more";
        showMore.textContent = `Show ${results.length - visibleCount} more`;
        showMore.addEventListener("click", () => runRenderAction(
          () => ownsDisplayedPanel(panel, renderContext), renderContext, () => {
          if (!isCurrent()) {
            onBeforeResultsRendered({ expandAll: true });
            return;
          }
          showMore.remove();
          expanded = true;
          while (nextResultIndex < results.length) {
            appendResult(results[nextResultIndex], nextResultIndex++);
          }
          flushDeferredGlossaries();
          onResultsExpanded({ audioButtons, miningActions });
          positionPopup();
        }));
        panel.appendChild(showMore);
        function scheduleNextResult() {
          windowRef.requestAnimationFrame(() => {
            windowRef.setTimeout(() => runRenderAction(isCurrent, renderContext, () => {
              if (nextResultIndex >= results.length) return;
              const deadline = windowRef.performance.now() + 8;
              do {
                appendResult(results[nextResultIndex], nextResultIndex++);
                flushDeferredGlossaries(true);
              } while (nextResultIndex < results.length && windowRef.performance.now() < deadline);
              expanded = true;
              onResultsExpanded({ audioButtons, miningActions });
              if (nextResultIndex === results.length) showMore.remove();
              else {
                showMore.textContent = `Show ${results.length - nextResultIndex} more`;
                panel.appendChild(showMore);
                scheduleNextResult();
              }
              positionPopup();
            }), 0);
          });
        }
        scheduleNextResult();
      }

      currentSourceHighlight = {
        candidate,
        matchedText: renderContext.highlightText || results[0].matched || results[0].term.expression,
      };
      if (sourceHighlightEnabled) {
        sourceHighlighter.apply(
          currentSourceHighlight.candidate,
          currentSourceHighlight.matchedText
        );
      }
      function updateMetadataLabels(container, result) {
        let changed = false;
        for (const [kind, groups] of [["frequency", result.term.frequencies], ["pitch", result.term.pitches], ["ipa", result.term.pitches]]) {
          if (kind === "frequency" && imageContext.averageFrequency === true) continue;
          const names = createDictionaryDisplayNames(groups.map(({ dictionary }) => dictionary), imageContext.dictionaryPresentation);
          if (kind !== "frequency") {
            for (const tag of container.querySelectorAll(`.gsm-hoshidicts-tag-${kind}`)) {
              changed = updatePronunciationLabel(tag, names.get(tag.dataset.dictionary) || tag.dataset.dictionary) || changed;
            }
            continue;
          }
          for (const source of container.querySelectorAll(`.gsm-hoshidicts-${kind}-source`)) {
            const dictionary = source.parentNode.dataset.dictionary;
            changed = updateLabel(source, names.get(dictionary) || dictionary) || changed;
          }
        }
        return changed;
      }

      return { lookupStats, audioButtons, miningActions,
        isExpanded: () => expanded,
        updateMetadata() {
          const nextModes = frequencyModes(imageContext);
          const labelsChanged = JSON.stringify(imageContext.dictionaryPresentation) !== JSON.stringify(appliedDictionaryPresentation);
          const frequencyChanged = ["averageFrequency", "showFrequencyDictionaryNames"]
            .some(key => imageContext[key] !== appliedMetadata[key]) || nextModes !== appliedFrequencyModes;
          const grammarChanged = imageContext.hidePopupGrammarTags !== appliedMetadata.hidePopupGrammarTags;
          const pitchChanged = imageContext.showPitchAccentBadge !== appliedMetadata.showPitchAccentBadge;
          let changed = false;
          let deferred = false;
          if (labelsChanged) changed = updateMetadataLabels(primaryMetadataCapsule, results[0]);
          if (frequencyChanged || grammarChanged) {
            renderPrimaryMetadataCapsule(primaryMetadataCapsule, results[0], imageContext.dictionaryPresentation || [],
              imageContext.hidePopupGrammarTags !== false, imageContext.averageFrequency === true,
              imageContext.showFrequencyDictionaryNames === true, { frequencyChanged, grammarChanged });
            changed = true;
          }
          entryMetadata.forEach(({ header, metadata, grammarRow }, index) => {
            const countChanged = frequencyChanged && index > 0 && metadata.updateFrequency(imageContext);
            if (pitchChanged || countChanged) { metadata.updatePitch(imageContext); changed = true; }
            if (grammarChanged && grammarRow) renderGrammarRow(grammarRow, results[index], imageContext.hidePopupGrammarTags !== false);
            if (labelsChanged) {
              for (const row of metadata.rows) changed = updateMetadataLabels(row, results[index]) || changed;
            }
            const rubyChanged = header.updateRuby(imageContext);
            deferred ||= rubyChanged === null;
            changed ||= rubyChanged === true;
          });
          appliedMetadata = metadataOptions(imageContext);
          appliedFrequencyModes = nextModes;
          appliedDictionaryPresentation = imageContext.dictionaryPresentation;
          return { changed, deferred };
        },
        updateImages() {
          let changed = false;
          for (const handle of renderedImages) {
            if (!handle.isCurrent()) renderedImages.delete(handle);
            else changed = handle.updatePresentation(imageContext) || changed;
          }
          return changed;
        },
        updateDictionaryPresentation(context, names, summaryChanged) {
          summaryChanged &&= isCurrent();
          const labelsChanged = names.size !== dictionaryDisplayNames.size
            || [...names].some(([dictionary, label]) => dictionaryDisplayNames.get(dictionary) !== label);
          Object.assign(renderContext, context);
          dictionaryDisplayNames = names;
          if (!labelsChanged && !summaryChanged) return false;
          let changed = false;
          if (summaryChanged) {
            changed = updateCompactSummary(primaryHeader.querySelector(".gsm-hoshidicts-headword"),
              results[0], renderContext, summaryMedia) || changed;
          }
          const entries = panel.querySelectorAll(":scope > .gsm-hoshidicts-entry");
          entries.forEach((entry, index) => {
            if (index > 0 && summaryChanged) {
              changed = updateCompactSummary(entry.querySelector(".gsm-hoshidicts-headword"),
                results[index], renderContext, summaryMedia) || changed;
            }
            if (labelsChanged) {
              for (const title of entry.querySelectorAll(":scope > .gsm-hoshidicts-glossary-grid > .gsm-hoshidicts-glossary-card > .gsm-hoshidicts-glossary-card-title")) {
                changed = updateLabel(title, names.get(title.title) || title.title) || changed;
              }
            }
          });
          return changed;
        },
      };
    }

    function renderKanji(kanji, candidate, renderOptions = {}) {
      renderOptions = { ...renderOptions };
      const focused = retainedFocus(renderOptions.preserveViewControls);
      clear(renderOptions.preserveViewControls);
      const dictionaries = [...new Set(kanji.entries.map(({ dictionary }) => dictionary))];
      let { tabs, dictionaryDisplayNames } = createDictionaryTabs(dictionaries, renderOptions);
      const requestedKey = dictionaryTabKey(renderOptions.selectedDictionaryTab);
      let selected = tabs.find((tab) => tab.key === requestedKey) || tabs[0];
      renderOptions.onDictionaryTabSelected?.(normaliseDictionaryTab(selected));
      const noteControls = createNoteControls(() => ({
        term: kanji.character,
        reading: "",
        definition: "",
        sentence: candidate?.sentence || "",
      }), renderOptions);
      currentNoteControls = noteControls;
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      const navigation = documentRef.createElement("div");
      navigation.className = "gsm-hoshidicts-kanji-navigation";
      let back = null;
      if (typeof renderOptions.onBack === "function") {
        back = documentRef.createElement("button");
        back.type = "button";
        back.className = "gsm-hoshidicts-kanji-back";
        back.textContent = "Back";
        back.setAttribute("aria-label", "Back to previous results");
        back.addEventListener("click", renderOptions.onBack);
      }
      const glyph = documentRef.createElement("div");
      glyph.className = "gsm-hoshidicts-kanji-glyph";
      glyph.textContent = kanji.character;
      navigation.appendChild(glyph);
      for (const previous of noteControls.actions.querySelectorAll(
        ":scope > .gsm-hoshidicts-popup-close, :scope > .gsm-hoshidicts-kanji-back"
      )) previous.remove();
      if (back) noteControls.actions.prepend(back);
      primaryHeader.append(navigation, noteControls.actions);
      const toolbar = createResultChrome(primaryHeader);

      function renderEntries() {
        const entries = documentRef.createDocumentFragment();

        for (const kanjiEntry of kanji.entries) {
          if (selected.dictionaries.size > 0 && !selected.dictionaries.has(kanjiEntry.dictionary)) continue;
          const entry = documentRef.createElement("article");
          entry.className = "gsm-hoshidicts-kanji-entry";
          entry.dataset.dictionary = kanjiEntry.dictionary;

          const dictionary = documentRef.createElement("h3");
          dictionary.className = "gsm-hoshidicts-kanji-dictionary";
          dictionary.textContent = dictionaryDisplayNames.get(
            kanjiEntry.dictionary
          ) || kanjiEntry.dictionary;
          dictionary.title = kanjiEntry.dictionary;
          dictionary.setAttribute("aria-label", kanjiEntry.dictionary);
          entry.appendChild(dictionary);

          const kanjiTags = tokenList(kanjiEntry.tags);
          if (kanjiTags.length > 0) {
            const tags = documentRef.createElement("div");
            tags.className = "gsm-hoshidicts-tags";
            for (const tag of kanjiTags) {
              tags.appendChild(createTag(documentRef, tag, "", "term"));
            }
            entry.appendChild(tags);
          }

          const readings = documentRef.createElement("div");
          readings.className = "gsm-hoshidicts-kanji-readings";
          for (const [label, values] of [
            ["On", tokenList(kanjiEntry.onyomi)],
            ["Kun", tokenList(kanjiEntry.kunyomi)],
          ]) {
            if (values.length === 0) continue;
            const group = documentRef.createElement("div");
            group.className = "gsm-hoshidicts-kanji-reading-group";
            const heading = documentRef.createElement("strong");
            heading.textContent = label;
            group.appendChild(heading);
            const value = documentRef.createElement("span");
            value.textContent = values.join(" · ");
            group.appendChild(value);
            readings.appendChild(group);
          }
          if (readings.childNodes.length > 0) entry.appendChild(readings);

          const definitions = Array.isArray(kanjiEntry.definitions) ? kanjiEntry.definitions : [];
          if (definitions.length > 0) {
            const meaningsHeading = documentRef.createElement("h4");
            meaningsHeading.textContent = "Meanings";
            entry.appendChild(meaningsHeading);
            const meanings = documentRef.createElement("ol");
            meanings.className = "gsm-hoshidicts-kanji-meanings";
            for (const meaning of definitions) {
              const item = documentRef.createElement("li");
              item.textContent = meaning;
              meanings.appendChild(item);
            }
            entry.appendChild(meanings);
          }

          const stats = Array.isArray(kanjiEntry.stats) ? kanjiEntry.stats : [];
          if (stats.length > 0) {
            const details = documentRef.createElement("details");
            details.className = "gsm-hoshidicts-kanji-stats";
            const summary = documentRef.createElement("summary");
            summary.textContent = "Details";
            details.appendChild(summary);
            const list = documentRef.createElement("dl");
            for (const stat of stats) {
              const name = documentRef.createElement("dt");
              name.textContent = stat.name;
              const value = documentRef.createElement("dd");
              value.textContent = stat.value;
              list.append(name, value);
            }
            details.appendChild(list);
            entry.appendChild(details);
          }
          entries.appendChild(entry);
        }
        return entries;
      }

      mountResultChrome(toolbar, renderEntries());
      const ownsKanji = () => currentToolbar === toolbar && renderOptions.isCurrentView?.() !== false;
      currentPresentationUpdate = (context) => runRenderAction(ownsKanji, renderOptions, () => {
        const next = createDictionaryTabs(dictionaries, context);
        const nextSelected = next.tabs.find(tab => tab.key === selected.key) || next.tabs[0];
        const sameMembers = sameTabMembers(selected.dictionaries, nextSelected.dictionaries, dictionaries);
        if (!sameMembers && (renderOptions.isCurrentRequest?.() === false || !canProjectPresentation())) return false;
        Object.assign(renderOptions, context);
        dictionaryDisplayNames = next.dictionaryDisplayNames;
        if (selected.key !== nextSelected.key) renderOptions.onDictionaryTabSelected?.(normaliseDictionaryTab(nextSelected));
        selected = nextSelected;
        let changed = false;
        if (sameMembers) {
          for (const heading of contentScroll.querySelectorAll(":scope > .gsm-hoshidicts-kanji-entry > h3")) {
            changed = updateLabel(heading, dictionaryDisplayNames.get(heading.title) || heading.title) || changed;
          }
        } else {
          contentScroll.replaceChildren(renderEntries());
          changed = true;
        }
        if (changed) scheduleMasonry();
        return true;
      });

      currentSourceHighlight = { candidate, matchedText: renderOptions.highlightText || kanji.character };
      if (sourceHighlightEnabled) sourceHighlighter.apply(candidate, currentSourceHighlight.matchedText);
      if (focused) {
        positionPopup();
        restoreRetainedFocus(focused);
      }
    }

    function renderResults(results, candidate, renderContext = {}) {
      renderContext = { ...renderContext };
      // Visual preferences are independent of tab/text changes that Note or a
      // child may defer. Carry their current context through local tabs.
      const imageContext = { popupImageSources: renderContext.popupImageSources ?? null,
        dictionaryPresentation: renderContext.dictionaryPresentation, resolveMedia: renderContext.resolveMedia,
        ...metadataOptions(renderContext) };
      const focused = retainedFocus(renderContext.preserveViewControls);
      clear(renderContext.preserveViewControls);
      setDefinitionBlurState(renderContext.definitionBlurState);
      const dictionaries = collectGlossaryDictionaries(results);
      let { tabs: tabDescriptors, dictionaryDisplayNames } = createDictionaryTabs(dictionaries, renderContext);
      const tabList = tabDescriptors.length > 1
        ? documentRef.createElement("div")
        : null;
      if (tabList) {
        tabList.className = "gsm-hoshidicts-tab-list";
        tabList.setAttribute("role", "tablist");
        tabList.setAttribute("aria-label", "Dictionaries");
        tabList.setAttribute("aria-orientation", "horizontal");
      }
      const metadataStrip = tabList
        ? documentRef.createElement("div")
        : null;
      if (metadataStrip) {
        metadataStrip.className = "gsm-hoshidicts-metadata-strip";
        metadataStrip.appendChild(tabList);
      }
      const primaryMetadataCapsule = documentRef.createElement("div");
      primaryMetadataCapsule.className =
        "gsm-hoshidicts-primary-metadata-capsule";
      primaryMetadataCapsule.hidden = true;
      primaryMetadataCapsule.setAttribute("role", "group");
      primaryMetadataCapsule.setAttribute("aria-label", "Entry metadata");
      const feedback = documentRef.createElement("div");
      feedback.className = "gsm-hoshidicts-mining-feedback";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      feedback.hidden = true;
      const panel = documentRef.createElement("div");
      currentResultPanel = panel;
      const ownsView = () => ownsResultPanel(panel, renderContext);
      panel.id = `${idPrefix}-tab-panel`;
      panel.className = "gsm-hoshidicts-tab-panel";
      if (tabList) {
        panel.setAttribute("role", "tabpanel");
      }

      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      let projectedPrimary = null;
      const noteControls = createNoteControls(() => ({
        // An exact selection adds what was highlighted, not the headword it matched.
        term: candidate?.exactSelection === true ? candidate.query : projectedPrimary?.term?.expression || "",
        reading: candidate?.exactSelection !== true || candidate.query === projectedPrimary?.term?.expression
          ? projectedPrimary?.term?.reading || "" : "",
        definition: "",
        sentence: candidate?.sentence || "",
      }), renderContext);
      currentNoteControls = noteControls;
      const toolbar = createResultChrome(primaryHeader, metadataStrip);
      mountResultChrome(toolbar, panel, feedback);

      let tabButtons = [];
      let nextTabId = 0;
      const requestedKey = dictionaryTabKey(renderContext.selectedDictionaryTab);
      const requestedTabIndex = tabDescriptors.findIndex((descriptor) => descriptor.key === requestedKey);
      let focusedIndex = Math.max(0, requestedTabIndex);
      let selectedIndex = focusedIndex;
      let hasRendered = false;
      let rendered = null;

      function updateTabState() {
        tabButtons.forEach((button, buttonIndex) => {
          const selected = buttonIndex === selectedIndex;
          button.setAttribute("aria-selected", String(selected));
          button.tabIndex = buttonIndex === focusedIndex ? 0 : -1;
        });
        const selectedButton = tabButtons[selectedIndex];
        if (selectedButton) {
          panel.setAttribute("aria-labelledby", selectedButton.id);
        } else {
          panel.removeAttribute("aria-labelledby");
        }
      }

      function activateTab(index, focusButton = false) {
        const tablessAllView = tabButtons.length === 0 && index === 0;
        if (!tablessAllView && (index < 0 || index >= tabButtons.length)) {
          return;
        }
        const previousIndex = selectedIndex;
        focusedIndex = index;
        selectedIndex = index;
        updateTabState();
        const button = tabButtons[index];
        if (focusButton && button) {
          button.focus();
        }
        const selectionChanged = previousIndex !== selectedIndex;
        if ((!hasRendered || selectionChanged)
            && typeof renderContext.onDictionaryTabSelected === "function") {
          const descriptor = tabDescriptors[selectedIndex];
          renderContext.onDictionaryTabSelected(normaliseDictionaryTab(descriptor));
        }
        if (hasRendered && !selectionChanged) {
          if (!ownsView()) {
            onBeforeResultsRendered();
            return;
          }
          if (
            button && !popup.hidden
            && typeof button.scrollIntoView === "function"
          ) {
            button.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
          return;
        }
        if (hasRendered) {
          if (onBeforeResultsRendered() === false) return;
        }
        if (hasRendered || !renderContext.preserveViewControls) contentScroll.scrollTop = 0;
        renderProjection(!hasRendered && renderContext.expandAll === true);
        hasRendered = true;
        positionPopup();
      }

      function renderProjection(expandAll) {
        if (hasRendered) masonryObserver?.disconnect();
        const selectedDictionaries = tabDescriptors[selectedIndex].dictionaries;
        const projectedResults = projectResults(results, selectedDictionaries);
        const saved = !hasRendered && renderContext.disclosures;
        const matchingDisclosures = saved && (saved.results === results
          || JSON.stringify(saved.results) === JSON.stringify(results))
          && sameTabMembers(new Set(saved.dictionaries), selectedDictionaries, dictionaries);
        projectedPrimary = projectedResults[0] || null;
        rendered = renderResultPanel(
          panel,
          projectedResults,
          candidate,
          {
            ...renderContext,
            ...metadataOptions(imageContext),
            dictionaryPresentation: imageContext.dictionaryPresentation,
            noteControls,
            expandAll,
            restoreScrollTop: !hasRendered ? renderContext.restoreScrollTop : undefined,
            restoreDisclosures: matchingDisclosures ? saved.states : undefined,
            // Lookup statistics describe the first unfiltered result. Keep the
            // slot on the All tab so a dictionary projection cannot attach the
            // original term's count to a different expression. The owner paints
            // or hides it, so a count setting never reprojects definitions.
            lookupStatsSlot: selectedDictionaries.size === 0,
          },
          {
            dictionaryDisplayNames,
            feedback,
            imageContext,
            primaryHeader,
            primaryMetadataCapsule,
          }
        );
        onResultsRendered(rendered);
      }

      function activateTabFromEvent(index, focusButton = false) {
        runRenderAction(() => ownsDisplayedPanel(panel, renderContext), renderContext, () => activateTab(index, focusButton));
      }

      function createTabButton(descriptor) {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.id = `${idPrefix}-tab-${nextTabId++}`;
        button.className = "gsm-hoshidicts-tab";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", panel.id);
        if (descriptor.groupId) button.dataset.groupId = descriptor.groupId;
        if (descriptor.dictionary) {
          button.dataset.dictionary = descriptor.dictionary;
        }
        if (descriptor.favourites) button.dataset.favourites = "true";
        button.addEventListener("click", () => activateTabFromEvent(tabButtons.indexOf(button)));
        button.addEventListener("keydown", (event) => {
          const index = tabButtons.indexOf(button);
          if (index < 0) return;
          let nextIndex = null;
          if (event.key === "ArrowRight") {
            nextIndex = (index + 1) % tabButtons.length;
          } else if (event.key === "ArrowLeft") {
            nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = tabButtons.length - 1;
          }
          if (nextIndex !== null) {
            event.preventDefault();
            event.stopPropagation();
            activateTabFromEvent(nextIndex, true);
          }
        });
        return button;
      }

      function syncTabButtons(previousDescriptors = []) {
        if (!tabList) return false;
        const previous = new Map(previousDescriptors.map((descriptor, index) => [descriptor.key, tabButtons[index]]));
        const focused = popup.getRootNode().activeElement;
        const focusedKey = previousDescriptors[tabButtons.indexOf(focused)]?.key;
        let changed = false;
        tabButtons = tabDescriptors.map(descriptor => {
          const button = previous.get(descriptor.key) || createTabButton(descriptor);
          changed = updateLabel(button, descriptor.label) || changed;
          button.title = descriptor.title;
          button.setAttribute("aria-label", descriptor.title);
          previous.delete(descriptor.key);
          return button;
        });
        for (const button of previous.values()) { button.remove(); changed = true; }
        // Move the other buttons around the focused one, never detach it.
        let next = null;
        for (let index = tabButtons.length - 1; index >= 0; index -= 1) {
          const button = tabButtons[index];
          if (button !== focused && (button.parentNode !== tabList || button.nextSibling !== next)) {
            tabList.insertBefore(button, next);
            changed = true;
          }
          next = button;
        }
        focusedIndex = focusedKey ? tabDescriptors.findIndex(tab => tab.key === focusedKey) : selectedIndex;
        if (focusedIndex < 0) focusedIndex = selectedIndex;
        if (hasRendered) updateTabState();
        if (focusedKey && !tabButtons.includes(focused)) tabButtons[focusedIndex]?.focus();
        return changed;
      }
      syncTabButtons();

      tabList?.addEventListener("wheel", (event) => {
        if (
          Math.abs(event.deltaY) > Math.abs(event.deltaX)
          && tabList.scrollWidth > tabList.clientWidth
        ) {
          const maximumScrollLeft = tabList.scrollWidth - tabList.clientWidth;
          const nextScrollLeft = Math.max(
            0,
            Math.min(maximumScrollLeft, tabList.scrollLeft + event.deltaY)
          );
          if (nextScrollLeft !== tabList.scrollLeft) {
            tabList.scrollLeft = nextScrollLeft;
            event.preventDefault();
          }
        }
      }, { passive: false });

      activateTab(selectedIndex);
      currentPresentationUpdate = (context) => runRenderAction(
        () => ownsDisplayedPanel(panel, renderContext), renderContext, () => {
          const summaryChanged = ["showCompactDefinitionSummary", "compactDefinitionSummaryCount", "compactDefinitionSummaryDictionary"]
            .some(key => Object.hasOwn(context, key) && context[key] !== renderContext[key]);
          // Image-only changes may proceed while Note, focus or a child keeps
          // the old tab/text projection mounted. Enter the same connected
          // request boundary before admitting new asynchronous image work.
          const imagesChanged = Object.hasOwn(context, "popupImageSources")
            && context.popupImageSources !== imageContext.popupImageSources;
          if ((imagesChanged || summaryChanged) && ownsView() && options.canUpdateCompactSummary?.() === false) return true;
          const focused = popup.getRootNode().activeElement;
          // Presentation updates carry the reader's inventory, not this view's
          // clicked-kanji scope, which stays with the render that chose it.
          const next = createDictionaryTabs(dictionaries, { ...renderContext, ...context });
          const previous = tabDescriptors;
          const selectedKey = previous[selectedIndex].key;
          let index = next.tabs.findIndex(tab => tab.key === selectedKey);
          if (index < 0) index = 0;
          const sameMembers = sameTabMembers(previous[selectedIndex].dictionaries, next.tabs[index].dictionaries, dictionaries);
          const projectionDeferred = (summaryChanged && popup.contains(focused)
            && focused.closest(".gsm-hoshidicts-compact-definition-summary"))
            || (!sameMembers && (!ownsView() || !canProjectPresentation()));
          // New cards and summaries use the latest route. Only refresh handles
          // after replacing their owners, unless the projection is protected.
          for (const key of ["popupImageSources", "dictionaryPresentation", "resolveMedia", ...METADATA_OPTION_KEYS]) {
            if (Object.hasOwn(context, key)) imageContext[key] = context[key];
          }
          if (projectionDeferred) {
            const metadata = rendered.updateMetadata();
            if (rendered.updateImages() || metadata.changed) scheduleMasonry();
            return false;
          }
          Object.assign(renderContext, context);
          tabDescriptors = next.tabs;
          dictionaryDisplayNames = next.dictionaryDisplayNames;
          selectedIndex = index;
          let changed = syncTabButtons(previous);
          let metadataDeferred = false;
          if (selectedKey !== tabDescriptors[index].key) {
            renderContext.onDictionaryTabSelected?.(normaliseDictionaryTab(tabDescriptors[index]));
          }
          if (sameMembers) {
            const metadata = rendered.updateMetadata();
            changed = metadata.changed || changed;
            metadataDeferred = metadata.deferred;
            changed = rendered.updateDictionaryPresentation(context, dictionaryDisplayNames, summaryChanged) || changed;
            changed = rendered.updateImages() || changed;
          } else {
            const focused = retainedFocus(true);
            renderProjection(rendered.isExpanded());
            if (focused && typeof focused !== "string") {
              positionPopup();
              restoreRetainedFocus(focused);
            }
            changed = true;
          }
          if (changed) scheduleMasonry();
          return !metadataDeferred;
        });
      restoreRetainedFocus(focused);
      captureTermView = () => ({ expandAll: rendered.isExpanded(), restoreScrollTop: contentScroll.scrollTop,
        disclosures: { results, dictionaries: [...tabDescriptors[selectedIndex].dictionaries],
          states: [...popup.querySelectorAll("details")].map(node => ({ className: node.className, open: node.open })),
        },
      });
      return rendered;
    }

    return {
      scrollElement: contentScroll,
      clear,
      hideImagePreview,
      closeNoteForm() {
        return currentNoteControls?.close() === true;
      },
      renderLookupFailure,
      renderNotice,
      renderResults,
      renderKanji,
      captureTermView: () => captureTermView?.(),
      currentEntryIndex: () => currentEntryIndex(),
      focusEntry,
      setDefinitionBlurState,
      setLookupStats,
      setSourceHighlightEnabled,
      setCustomButtons,
      setCustomLinks,
      setToolbarPosition,
      scheduleMasonry,
      updateDictionaryPresentation(context) {
        if (!currentPresentationUpdate) return;
        pendingPresentation = context;
        flushDictionaryPresentation();
      },
      flushDictionaryPresentation,
      destroy() {
        sourceHighlighter.clear();
        currentPresentationUpdate = null;
        pendingPresentation = null;
        hideImagePreview();
        renderedImages.clear();
        renderRevision += 1;
        currentResultPanel = null;
        captureTermView = null;
        pendingScrollRestoration = null;
        currentLookupFailure = null;
        options.cancelMasonry?.(layoutMasonry);
        if (masonryFrame !== null) {
          windowRef.cancelAnimationFrame(masonryFrame);
          masonryFrame = null;
        }
        masonryObserver?.disconnect();
        windowRef.removeEventListener("resize", onWindowResize);
        popup.removeEventListener("scroll", onPopupScroll, true);
        popup.removeEventListener("focusout", onPresentationFocusOut);
      },
    };
  }

  // Automatic follows horizontal root placement; side panes retain their edge.
  function resolveToolbarPosition(preference, placement, current = "top") {
    if (preference === "top" || preference === "bottom") return preference;
    if (placement === "above") return "bottom";
    if (placement === "below") return "top";
    return current;
  }

  return {
    createPopupAppearance,
    createCustomPopupStyle,
    resolveToolbarPosition,
    calculatePopupPosition,
    scaleRect,
    popupCoordinateScale,
    createDictionaryDisplayNames,
    createFrequencyTags,
    createPitchTag,
    createPopupView,
    createSourceHighlighter,
    createTag,
    normaliseDictionaryTab,
    extractCompactDefinitionSummary,
    formatCompactFrequencyNumber,
    formatFrequencyValue,
    kanjiEntryGlossary,
    metadataOptions,
  };
}));
