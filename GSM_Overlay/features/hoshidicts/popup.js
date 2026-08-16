/*
 * Hoshidicts popup view for the GSM overlay.
 *
 * Keeps rendering, source highlighting, and mining-button presentation out of
 * the reader's pointer/socket state machine.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsPopup = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DEFAULT_INITIAL_RESULT_COUNT = 1;
  const DEFAULT_MAX_METADATA_TAGS = 12;
  const DEFAULT_HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const MASONRY_GAP_PX = 8;
  const DEFINITION_BLUR_STATES = new Set(["pending", "blurred"]);
  const DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT = 3;
  const MIN_COMPACT_DEFINITION_SUMMARY_COUNT = 1;
  const MAX_COMPACT_DEFINITION_SUMMARY_COUNT = 6;
  const COMPACT_DEFINITION_MAX_CHARACTERS = 240;
  const COMPACT_DEFINITION_MAX_NODES = 512;
  const COMPACT_DEFINITION_MAX_DEPTH = 16;
  const COMPACT_DEFINITION_BLOCK_TAGS = new Set([
    "article",
    "blockquote",
    "br",
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
    "canvas",
    "iframe",
    "img",
    "rt",
    "script",
    "style",
    "svg",
    "video",
  ]);
  const MAX_CUSTOM_DEFINITION_BYTES = 2 * 1024;
  const UTF8_ENCODER = new TextEncoder();
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

  const DEINFLECTION_STRINGS = {
    en: {
      summary: "Why this matched",
      steps: "Deinflection steps",
      aria: "Why this matched: {matched} became {deinflected}",
    },
    ja: {
      summary: "一致した理由",
      steps: "活用解除の手順",
      aria: "一致した理由: {matched} から {deinflected} に戻しました",
    },
    ukr: {
      summary: "Чому це збіглося",
      steps: "Кроки відновлення словникової форми",
      aria: "Чому це збіглося: {matched} перетворено на {deinflected}",
    },
  };

  const DEINFLECTION_LOCALE_ALIASES = new Map([
    ["en", "en"],
    ["en_us", "en"],
    ["ja", "ja"],
    ["ja_jp", "ja"],
    ["ukr", "ukr"],
    ["ukr_ua", "ukr"],
  ]);

  function normalizeDeinflectionLocale(value) {
    const canonical = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/-/gu, "_");
    return DEINFLECTION_LOCALE_ALIASES.get(canonical) || "en";
  }

  function deinflectionStrings(locale) {
    return DEINFLECTION_STRINGS[normalizeDeinflectionLocale(locale)];
  }

  function buildDeinflectionDisclosure(documentRef, result, locale) {
    const matched = typeof result.matched === "string" ? result.matched.slice(0, 4096) : "";
    const deinflected = typeof result.deinflected === "string" ? result.deinflected.slice(0, 4096) : "";
    const steps = Array.isArray(result.trace)
      ? result.trace
          .map((step) => (step && typeof step === "object" ? step : {}))
          .map((step) => ({
            name: typeof step.name === "string" ? step.name.slice(0, 1024) : "",
            description: typeof step.description === "string" ? step.description.slice(0, 4096) : "",
          }))
          .filter((step) => step.name.length > 0)
      : [];
    if (!matched || !deinflected || matched === deinflected || steps.length === 0) {
      return null;
    }

    const strings = deinflectionStrings(locale);
    const details = documentRef.createElement("details");
    details.className = "gsm-hoshidicts-deinflection";

    const summary = documentRef.createElement("summary");
    const label = documentRef.createElement("span");
    label.className = "gsm-hoshidicts-deinflection-label";
    label.textContent = strings.summary;
    const path = documentRef.createElement("span");
    path.className = "gsm-hoshidicts-deinflection-path";
    const from = documentRef.createElement("span");
    from.className = "gsm-hoshidicts-deinflection-endpoint";
    from.textContent = matched;
    const arrow = documentRef.createElement("span");
    arrow.className = "gsm-hoshidicts-deinflection-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = " → ";
    const to = documentRef.createElement("span");
    to.className = "gsm-hoshidicts-deinflection-endpoint";
    to.textContent = deinflected;
    path.append(from, arrow, to);
    summary.append(label, path);
    summary.setAttribute(
      "aria-label",
      strings.aria
        .replace("{matched}", matched)
        .replace("{deinflected}", deinflected)
    );
    details.appendChild(summary);

    const stepList = documentRef.createElement("ol");
    stepList.className = "gsm-hoshidicts-deinflection-steps";
    stepList.setAttribute("aria-label", strings.steps);
    for (const step of steps) {
      const item = documentRef.createElement("li");
      const name = documentRef.createElement("span");
      name.className = "gsm-hoshidicts-deinflection-step-name";
      name.textContent = step.name;
      item.appendChild(name);
      if (step.description) {
        const description = documentRef.createElement("span");
        description.className = "gsm-hoshidicts-deinflection-step-description";
        description.textContent = step.description;
        item.appendChild(description);
      }
      stepList.appendChild(item);
    }
    details.appendChild(stepList);
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

  function isJsonStringWithinUtf8Limit(value, maxBytes) {
    return UTF8_ENCODER.encode(JSON.stringify(value)).length <= maxBytes + 2;
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
        return `${formatCompactFrequencyNumber(frequency.value)}${JITEN_KANA_FREQUENCY_MARKER}`;
      }
    }
    return formatCompactFrequencyNumber(frequency.value);
  }

  function frequencyNumberForAverage(frequency) {
    if (typeof frequency.displayValue === "string") {
      const match = /^\d+/u.exec(frequency.displayValue);
      if (match) {
        const value = Number.parseInt(match[0], 10);
        if (value > 0) return value;
      }
    }
    return Number.isFinite(frequency.value) && frequency.value > 0
      ? frequency.value
      : null;
  }

  function createFrequencyTag(
    documentRef,
    group,
    dictionaryDisplayName,
    frequencies,
    showDictionaryName = true
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
    frequencies.forEach(({ display, frequency }, index) => {
      if (index > 0) {
        values.append(" · ");
      }
      const value = documentRef.createElement("span");
      value.className = "gsm-hoshidicts-frequency-value";
      value.dataset.frequency = String(frequency.value);
      value.textContent = display;
      if (display !== String(frequency.value)) {
        value.title = String(frequency.value);
      }
      values.appendChild(value);
    });

    const frequencyLabel = frequencies
      .map(({ display }) => display)
      .join(", ");
    tag.setAttribute(
      "aria-label",
      showDictionaryName ? `${group.dictionary}: ${frequencyLabel}` : frequencyLabel
    );
    return tag;
  }

  function createFrequencyTags(
    documentRef,
    result,
    dictionaryPresentation,
    maximumTags,
    averageFrequency = false,
    showFrequencyDictionaryNames = true
  ) {
    if (averageFrequency) {
      const frequencies = [];
      for (const group of result.term.frequencies) {
        for (const frequency of group.frequencies) {
          const value = frequencyNumberForAverage(frequency);
          if (value !== null) {
            frequencies.push(value);
            break;
          }
        }
      }
      if (frequencies.length === 0) return [];
      const value = Math.floor(
        frequencies.length /
          frequencies.reduce((total, frequency) => total + 1 / frequency, 0)
      );
      const frequency = { value, displayValue: null };
      return [
        createFrequencyTag(
          documentRef,
          { dictionary: "Frequency" },
          "Frequency:",
          [{ display: formatCompactFrequencyNumber(value), frequency }],
          showFrequencyDictionaryNames
        ),
      ];
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
        const display = formatFrequencyValue(frequency);
        if (display === null) {
          continue;
        }
        const key = JSON.stringify([frequency.value, display]);
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
    reading
  ) {
    const bodyText = [
      `${reading ? `${reading} ` : ""}[${pitch.position}]`,
      pitch.pattern,
    ].filter(Boolean).join(" ");
    const description = [
      group.dictionary,
      pitch.pattern ? `Pattern ${pitch.pattern}` : "",
      ...group.transcriptions,
    ].filter(Boolean).join(" · ");
    const tag = createTag(documentRef, "", description, "pitch");

    const source = documentRef.createElement("span");
    source.className = "gsm-hoshidicts-pitch-source";
    source.textContent = dictionaryDisplayName;
    tag.appendChild(source);

    const body = documentRef.createElement("span");
    body.className = "gsm-hoshidicts-pitch-body";
    body.textContent = bodyText;
    tag.appendChild(body);
    tag.setAttribute(
      "aria-label",
      `${group.dictionary}: ${bodyText}`
    );
    return tag;
  }

  function setMiningButtonState(button, state, message = "") {
    button.dataset.state = state;
    button.disabled = !["ready", "add-duplicate", "overwrite", "error"].includes(state);
    button.title = message || {
      checking: "Checking Anki availability",
      ready: "Mine to Anki",
      "add-duplicate": "Add duplicate to Anki",
      overwrite: "Overwrite note in Anki",
      mining: "Adding note",
      success: "Note added",
      error: "Could not add note",
      duplicate: "Note already exists",
      unavailable: "Anki mining is unavailable",
    }[state] || "Mine to Anki";
    button.setAttribute("aria-label", button.title);
    const icon = button.ownerDocument.createElement("span");
    icon.className = "gsm-hoshidicts-mine-icon";
    icon.setAttribute("aria-hidden", "true");
    const iconName = {
      ready: "big-circle",
      "add-duplicate": "add-duplicate-big-circle",
      overwrite: "overwrite-big-circle",
      duplicate: "add-duplicate-big-circle",
    }[state];
    if (iconName) {
      icon.dataset.icon = iconName;
    } else {
      icon.textContent = {
        checking: "…",
        mining: "⟳",
        success: "✓",
        error: "!",
        unavailable: "-",
      }[state] || "-";
    }
    button.replaceChildren(icon);
  }

  function formatLookupCount(label, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return `${label} ${value} ${value === 1 ? "time" : "times"}`;
  }

  function createSourceHighlighter(windowRef, documentRef, highlightName) {
    const matches = new Map();
    let highlightedSourceElements = new Set();

    function clearRenderedHighlight() {
      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      if (highlights && typeof highlights.delete === "function") {
        highlights.delete(highlightName);
      }
      for (const element of highlightedSourceElements) {
        element.classList.remove("gsm-hoshidicts-source-match");
      }
      highlightedSourceElements = new Set();
    }

    function createMatchRanges(candidate, matchedText) {
      const matchLength = typeof matchedText === "string" ? matchedText.length : 0;
      if (matchLength <= 0 || !Array.isArray(candidate.sourceElements)) {
        return null;
      }
      const startOffset = Math.max(0, candidate.matchOffset);
      const endOffset = Math.min(candidate.sentence.length, startOffset + matchLength);
      if (endOffset <= startOffset) {
        return null;
      }

      const sourceElements = candidate.sourceElements;
      if (
        sourceElements.some(
          (element) => !(element instanceof windowRef.Element) || !element.isConnected
        ) ||
        sourceElements.map((element) => element.textContent || "").join("") !==
          candidate.sentence
      ) {
        return null;
      }
      const showText = windowRef.NodeFilter ? windowRef.NodeFilter.SHOW_TEXT : 4;
      const ranges = [];
      const rangedSourceElements = new Set();
      let elementStart = 0;
      for (const element of sourceElements) {
        const elementEnd = elementStart + (element.textContent || "").length;
        if (elementEnd <= startOffset || elementStart >= endOffset) {
          elementStart = elementEnd;
          continue;
        }
        const textNodes = [];
        const walker = documentRef.createTreeWalker(element, showText);
        let node = walker.nextNode();
        while (node) {
          textNodes.push(node);
          node = walker.nextNode();
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
            rangedSourceElements.add(element);
          } catch {
            // The class fallback below handles invalid ranges.
          }
        }
        elementStart = elementEnd;
      }
      return {
        ranges,
        rangedSourceElements,
        sourceElements,
        startOffset,
        endOffset,
      };
    }

    function applyElementFallback(match, skippedElements = new Set()) {
      let elementStart = 0;
      for (const element of match.sourceElements) {
        const elementEnd = elementStart + (element.textContent || "").length;
        if (
          !skippedElements.has(element) &&
          elementEnd > match.startOffset &&
          elementStart < match.endOffset
        ) {
          element.classList.add("gsm-hoshidicts-source-match");
          highlightedSourceElements.add(element);
        }
        elementStart = elementEnd;
      }
    }

    function render() {
      clearRenderedHighlight();
      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      const HighlightImpl = windowRef.Highlight;
      const canUseRanges = Boolean(
        highlights && typeof highlights.set === "function" && HighlightImpl
      );
      const ranges = [];
      for (const { candidate, matchedText } of matches.values()) {
        const match = createMatchRanges(candidate, matchedText);
        if (!match) {
          continue;
        }
        if (canUseRanges && match.ranges.length > 0) {
          ranges.push(...match.ranges);
          applyElementFallback(match, match.rangedSourceElements);
        } else {
          applyElementFallback(match);
        }
      }
      if (canUseRanges && ranges.length > 0) {
        try {
          highlights.set(highlightName, new HighlightImpl(...ranges));
        } catch {
          for (const { candidate, matchedText } of matches.values()) {
            const match = createMatchRanges(candidate, matchedText);
            if (match) {
              applyElementFallback(match);
            }
          }
        }
      }
    }

    function applyFor(key, candidate, matchedText) {
      matches.set(key, { candidate, matchedText });
      render();
    }

    function clearFor(key) {
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
      scope(key) {
        return {
          apply(candidate, matchedText) {
            applyFor(key, candidate, matchedText);
          },
          clear() {
            clearFor(key);
          },
        };
      },
      clearAll() {
        matches.clear();
        clearRenderedHighlight();
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

  function isIgnoredCompactDefinitionSection(value) {
    const marker = getCompactDefinitionMarker(value);
    return marker && marker !== "glossary" && (
      marker.startsWith("part-of-speech") ||
      marker === "source" || marker.startsWith("source-") ||
      marker === "attribution" || marker.startsWith("attribution-") ||
      marker === "example" || marker === "examples" ||
      marker.startsWith("example-") ||
      marker === "form" || marker === "forms" ||
      marker.startsWith("forms-")
    );
  }

  function normalizeCompactDefinitionText(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
  }

  function isCompactDefinitionBlock(value) {
    return isRecord(value) && COMPACT_DEFINITION_BLOCK_TAGS.has(
      String(value.tag || "").toLowerCase()
    );
  }

  function collectCompactDefinitionText(value, state, depth = 0) {
    if (
      state.nodes >= COMPACT_DEFINITION_MAX_NODES ||
      depth > COMPACT_DEFINITION_MAX_DEPTH
    ) {
      return "";
    }
    state.nodes += 1;
    if (typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      let text = "";
      let previousWasBlock = false;
      for (const child of value) {
        if (state.nodes >= COMPACT_DEFINITION_MAX_NODES) break;
        const childText = collectCompactDefinitionText(child, state, depth + 1);
        if (!childText) continue;
        const childIsBlock = isCompactDefinitionBlock(child);
        if (text && (previousWasBlock || childIsBlock)) {
          text += " ";
        }
        text += childText;
        previousWasBlock = childIsBlock;
      }
      return text;
    }
    if (!isRecord(value) || isIgnoredCompactDefinitionSection(value)) {
      return "";
    }
    const tag = typeof value.tag === "string" ? value.tag.toLowerCase() : "";
    if (COMPACT_DEFINITION_IGNORED_TAGS.has(tag) || value.type === "image") {
      return "";
    }
    if (value.type === "text" && Object.prototype.hasOwnProperty.call(value, "text")) {
      return collectCompactDefinitionText(value.text, state, depth + 1);
    }
    return Object.prototype.hasOwnProperty.call(value, "content")
      ? collectCompactDefinitionText(value.content, state, depth + 1)
      : "";
  }

  function findCompactDefinitionNodes(value, predicate, state, depth = 0) {
    if (
      state.nodes >= COMPACT_DEFINITION_MAX_NODES ||
      depth > COMPACT_DEFINITION_MAX_DEPTH
    ) {
      return [];
    }
    state.nodes += 1;
    if (Array.isArray(value)) {
      const matches = [];
      for (const child of value) {
        matches.push(...findCompactDefinitionNodes(
          child,
          predicate,
          state,
          depth + 1
        ));
        if (state.nodes >= COMPACT_DEFINITION_MAX_NODES) break;
      }
      return matches;
    }
    if (!isRecord(value) || isIgnoredCompactDefinitionSection(value)) {
      return [];
    }
    if (predicate(value)) {
      return [value];
    }
    return Object.prototype.hasOwnProperty.call(value, "content")
      ? findCompactDefinitionNodes(value.content, predicate, state, depth + 1)
      : [];
  }

  function isCompactDefinitionList(value) {
    const tag = String(value.tag || "").toLowerCase();
    return tag === "ul" || tag === "ol";
  }

  /** Block nodes with no block descendants: the smallest sense-sized chunks. */
  function findCompactDefinitionLeafBlocks(root) {
    return findCompactDefinitionNodes(
      root,
      (value) => COMPACT_DEFINITION_BLOCK_TAGS.has(
        String(value.tag || "").toLowerCase()
      ) && findCompactDefinitionNodes(
        value.content,
        (child) => COMPACT_DEFINITION_BLOCK_TAGS.has(
          String(child.tag || "").toLowerCase()
        ),
        { nodes: 0 }
      ).length === 0,
      { nodes: 0 }
    );
  }

  function compactDefinitionItemsFromNodes(nodes) {
    const items = [];
    let inspected = 0;
    for (const node of nodes) {
      if (inspected >= COMPACT_DEFINITION_MAX_NODES) break;
      inspected += 1;
      const text = normalizeCompactDefinitionText(
        collectCompactDefinitionText(node, { nodes: 0 })
      );
      for (const segment of text.split(/\s*\u2022\s*/u)) {
        if (segment) items.push(segment);
      }
    }
    return items;
  }

  function compactDefinitionItemsFromList(list) {
    const rawChildren = Array.isArray(list.content)
      ? list.content
      : [list.content];
    const children = rawChildren.slice(0, COMPACT_DEFINITION_MAX_NODES);
    const listItems = [];
    for (const child of children) {
      if (isRecord(child) && String(child.tag || "").toLowerCase() === "li") {
        listItems.push(child);
      }
    }
    return compactDefinitionItemsFromNodes(
      listItems.length > 0 ? listItems : children
    );
  }

  function compactDefinitionItemsFromMarkedNode(node) {
    const tag = String(node.tag || "").toLowerCase();
    if (tag === "ul" || tag === "ol") {
      return compactDefinitionItemsFromList(node);
    }
    const nestedLists = findCompactDefinitionNodes(
      node.content,
      isCompactDefinitionList,
      { nodes: 0 }
    );
    if (nestedLists.length > 0) {
      return nestedLists.flatMap(compactDefinitionItemsFromList);
    }
    const leafBlocks = findCompactDefinitionLeafBlocks(node.content);
    return leafBlocks.length > 0
      ? compactDefinitionItemsFromNodes(leafBlocks)
      : compactDefinitionItemsFromNodes([node]);
  }

  function extractCompactDefinitionItems(rawGlossary) {
    const parsed = parseCompactDefinitionValue(rawGlossary);
    if (parsed === null) return [];

    const glossaryNodes = findCompactDefinitionNodes(
      parsed,
      (value) => getCompactDefinitionMarker(value) === "glossary",
      { nodes: 0 }
    );
    if (glossaryNodes.length > 0) {
      return glossaryNodes.flatMap(compactDefinitionItemsFromMarkedNode);
    }

    const semanticLists = findCompactDefinitionNodes(
      parsed,
      isCompactDefinitionList,
      { nodes: 0 }
    );
    for (const list of semanticLists) {
      const items = compactDefinitionItemsFromList(list);
      if (items.length > 0) return items;
    }

    const leafBlocks = findCompactDefinitionLeafBlocks(parsed);
    if (leafBlocks.length > 0) {
      return compactDefinitionItemsFromNodes(leafBlocks);
    }

    if (Array.isArray(parsed)) {
      const items = compactDefinitionItemsFromNodes(parsed);
      if (items.length > 0) return items;
    }
    return compactDefinitionItemsFromNodes([parsed]);
  }

  function extractCompactDefinitionImage(rawGlossary) {
    const parsed = parseCompactDefinitionValue(rawGlossary);
    if (parsed === null) return null;
    return findCompactDefinitionNodes(
      parsed,
      (value) => value.type === "image" ||
        String(value.tag || "").toLowerCase() === "img",
      { nodes: 0 }
    )[0] || null;
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
      for (const rawGlossary of rawGlossaries) {
        for (const rawItem of extractCompactDefinitionItems(rawGlossary)) {
          if (items.length >= itemLimit) break;
          const item = normalizeCompactDefinitionText(rawItem);
          if (!item || seen.has(item)) continue;
          const codePoints = Array.from(item);
          const remaining = COMPACT_DEFINITION_MAX_CHARACTERS - characterCount;
          if (remaining <= 0) break;
          const bounded = codePoints.length <= remaining
            ? item
            : remaining === 1
              ? "\u2026"
              : `${codePoints.slice(0, remaining - 1).join("")}\u2026`;
          items.push(bounded);
          seen.add(item);
          characterCount += Array.from(bounded).length;
          if (bounded !== item) break;
        }
        if (
          items.length >= itemLimit ||
          characterCount >= COMPACT_DEFINITION_MAX_CHARACTERS
        ) {
          break;
        }
      }
      if (items.length > 0) {
        const image = rawGlossaries
          .map(extractCompactDefinitionImage)
          .find(Boolean) || null;
        return { dictionary, image, items };
      }
    }
    return null;
  }

  function createPopupView(options) {
    const documentRef = options.document;
    const windowRef = options.window;
    const popup = options.popup;
    const appendExpressionRuby = options.appendExpressionRuby;
    const appendTextOnlyGlossary = options.appendTextOnlyGlossary;
    const parseTagList = options.parseTagList;
    const positionPopup = options.positionPopup;
    const getPopupColumns = typeof options.getPopupColumns === "function"
      ? options.getPopupColumns
      : () => 1;
    const onMineClick = options.onMineClick;
    const onBrowseClick = typeof options.onBrowseClick === "function"
      ? options.onBrowseClick
      : () => {};
    const onCustomLinkClick = typeof options.onCustomLinkClick === "function"
      ? options.onCustomLinkClick
      : () => {};
    const onKanjiClick = typeof options.onKanjiClick === "function"
      ? options.onKanjiClick
      : () => {};
    const onAddCustomEntry = options.onAddCustomEntry;
    const onNoteEditingChange =
      typeof options.onNoteEditingChange === "function"
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
    const sourceHighlighter = options.sourceHighlighter || createSourceHighlighter(
      windowRef,
      documentRef,
      options.highlightName || DEFAULT_HIGHLIGHT_NAME
    );
    let definitionBlurState = "revealed";
    let sourceHighlightEnabled = options.sourceHighlightEnabled === true;
    let currentSourceHighlight = null;
    let noteEditing = false;
    let toolbarPosition = options.toolbarPosition === "bottom" ? "bottom" : "top";
    let popupButtons = options.popupButtons;
    let currentToolbar = null;
    let currentNoteForm = null;
    let currentFeedback = null;
    let actionContexts = new Set();
    let masonryFrame = null;
    const masonryObserver = typeof windowRef.ResizeObserver === "function"
      ? new windowRef.ResizeObserver(() => scheduleMasonry())
      : null;
    popup.dataset.toolbarPosition = toolbarPosition;

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
        const columnHeights = Array.from({ length: columns }, () => 0);
        for (const card of cards) {
          const column = columnHeights.indexOf(Math.min(...columnHeights));
          const x = column * (columnWidth + MASONRY_GAP_PX);
          const y = columnHeights[column];
          card.style.width = `${columnWidth}px`;
          card.style.transform = `translate(${x}px, ${y}px)`;
          card.style.visibility = "visible";
          columnHeights[column] += card.offsetHeight + MASONRY_GAP_PX;
        }
        grid.style.height = `${Math.max(...columnHeights) - MASONRY_GAP_PX}px`;
      }
    }

    function scheduleMasonry() {
      if (masonryFrame !== null) {
        return;
      }
      masonryFrame = windowRef.requestAnimationFrame(() => {
        masonryFrame = null;
        layoutMasonry();
        positionPopup();
      });
    }

    const onWindowResize = () => scheduleMasonry();
    windowRef.addEventListener("resize", onWindowResize);

    function applyToolbarLayout() {
      if (!currentToolbar || !currentNoteForm) {
        return;
      }
      // Keep the transient status (e.g. "Added to Anki.") attached to the
      // toolbar so the bottom variant carries the complete Yomitan-style
      // status surface instead of leaving feedback floating at the popup top.
      const desired =
        toolbarPosition === "bottom"
          ? [currentNoteForm, currentFeedback, currentToolbar]
          : [currentToolbar, currentFeedback, currentNoteForm];
      const ordered = desired.filter(Boolean);
      // Only touch the DOM when the surface is not already in the desired
      // order. A no-op reposition must never detach a focused control (e.g. an
      // open Note field), which throws in jsdom and reorders under focus.
      const alreadyOrdered = ordered.every((node, index) => {
        const next = ordered[index + 1];
        return !next || node.nextElementSibling === next;
      }) &&
        (toolbarPosition === "bottom"
          ? popup.lastElementChild === currentToolbar
          : popup.firstElementChild === currentToolbar);
      if (alreadyOrdered) {
        return;
      }
      if (toolbarPosition === "bottom") {
        popup.append(...ordered);
      } else {
        popup.prepend(...ordered);
      }
    }

    function setRenderedToolbar(toolbar, noteForm, feedback = null) {
      currentToolbar = toolbar;
      currentNoteForm = noteForm;
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

    function setNoteEditing(editing) {
      const nextEditing = Boolean(editing);
      if (noteEditing === nextEditing) {
        return;
      }
      noteEditing = nextEditing;
      onNoteEditingChange(nextEditing);
    }

    function clear() {
      setNoteEditing(false);
      sourceHighlighter.clear();
      currentSourceHighlight = null;
      currentToolbar = null;
      currentNoteForm = null;
      actionContexts.clear();
      masonryObserver?.disconnect();
      popup.replaceChildren();
      popup.scrollTop = 0;
      setDefinitionBlurState("revealed");
    }

    function arrangeEntryActions(context) {
      const { actions, audioButton, candidate, feedback, mineButton, noteButton, result } =
        context;
      actions.replaceChildren();
      if (mineButton && popupButtons.addToAnki) {
        actions.appendChild(mineButton);
      }
      if (audioButton && popupButtons.audio) {
        actions.appendChild(audioButton);
      }
      if (noteButton && popupButtons.customDefinition) {
        actions.appendChild(noteButton);
      }
      if (popupButtons.viewInAnki) {
        if (!context.browseButton) {
          const browseButton = documentRef.createElement("button");
          browseButton.type = "button";
          browseButton.className =
            "gsm-hoshidicts-view-in-anki-button gsm-hoshidicts-text-action-button";
          browseButton.title = "Open note in Anki";
          browseButton.setAttribute("aria-label", browseButton.title);
          browseButton.addEventListener("click", () => {
            onBrowseClick(browseButton, result, feedback);
          });
          context.browseButton = browseButton;
        }
        actions.appendChild(context.browseButton);
      }
      for (const link of popupButtons.customLinks) {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className =
          "gsm-hoshidicts-external-link-button gsm-hoshidicts-text-action-button";
        button.textContent = link.label;
        button.title = link.label;
        button.setAttribute("aria-label", link.label);
        button.addEventListener("click", () => {
          onCustomLinkClick(link, result, candidate, feedback);
        });
        actions.appendChild(button);
      }
    }

    function registerEntryActions(context) {
      actionContexts.add(context);
      arrangeEntryActions(context);
    }

    function setPopupButtons(value) {
      popupButtons = value;
      const liveContexts = new Set();
      for (const context of actionContexts) {
        if (!context.actions.isConnected) {
          continue;
        }
        arrangeEntryActions(context);
        liveContexts.add(context);
      }
      actionContexts = liveContexts;
      if (
        !popupButtons.customDefinition &&
        currentNoteForm &&
        !currentNoteForm.hidden
      ) {
        currentNoteForm.hidden = true;
        for (const context of liveContexts) {
          context.noteButton?.setAttribute("aria-expanded", "false");
        }
        setNoteEditing(false);
      }
      positionPopup();
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

    function setFeedback(feedback, message, kind = "info") {
      feedback.hidden = !message;
      feedback.dataset.kind = kind;
      feedback.textContent = message;
    }

    function setLookupStats(element, payload) {
      const seen = formatLookupCount("Seen", payload && payload.seenCount);
      const lookedUp = formatLookupCount(
        "Looked up",
        payload && payload.lookupCount
      );
      const segments = [seen, lookedUp].filter(Boolean);
      element.textContent = segments.join(" · ");
      element.hidden = segments.length === 0;
      if (!element.hidden) {
        positionPopup();
      }
    }

    function createNoteControls(prefill, selectTermOnOpen = false) {
      const noteButton = documentRef.createElement("button");
      noteButton.type = "button";
      noteButton.className = "gsm-hoshidicts-note-button";
      noteButton.title = "Add a custom definition";
      noteButton.setAttribute("aria-label", noteButton.title);
      noteButton.setAttribute("aria-expanded", "false");

      const noteIcon = documentRef.createElement("span");
      noteIcon.className = "gsm-hoshidicts-note-icon";
      noteIcon.setAttribute("aria-hidden", "true");
      noteIcon.textContent = "\u270e";
      noteButton.appendChild(noteIcon);

      const form = documentRef.createElement("form");
      form.className = "gsm-hoshidicts-note-form";
      form.hidden = true;

      function appendField(labelText, field) {
        const label = documentRef.createElement("label");
        label.className = "gsm-hoshidicts-note-field";
        const labelCaption = documentRef.createElement("span");
        labelCaption.textContent = labelText;
        label.appendChild(labelCaption);
        label.appendChild(field);
        form.appendChild(label);
      }

      const termInput = documentRef.createElement("input");
      termInput.className = "gsm-hoshidicts-note-term";
      termInput.type = "text";
      termInput.required = true;
      termInput.maxLength = 1024;
      termInput.autocomplete = "off";
      termInput.value = String(prefill?.term || "");
      appendField("Term", termInput);

      const readingInput = documentRef.createElement("input");
      readingInput.className = "gsm-hoshidicts-note-reading";
      readingInput.type = "text";
      readingInput.required = true;
      readingInput.maxLength = 1024;
      readingInput.autocomplete = "off";
      readingInput.value = String(prefill?.reading || "");
      appendField("Reading", readingInput);

      const definitionInput = documentRef.createElement("textarea");
      definitionInput.className = "gsm-hoshidicts-note-definition";
      definitionInput.required = true;
      definitionInput.maxLength = MAX_CUSTOM_DEFINITION_BYTES;
      definitionInput.rows = 3;
      definitionInput.value = String(prefill?.definition || "");
      appendField("Definition", definitionInput);

      const error = documentRef.createElement("div");
      error.className = "gsm-hoshidicts-note-error";
      error.setAttribute("role", "alert");
      error.hidden = true;
      form.appendChild(error);

      const actions = documentRef.createElement("div");
      actions.className = "gsm-hoshidicts-note-actions";
      const cancelButton = documentRef.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "gsm-hoshidicts-note-cancel";
      cancelButton.textContent = "Cancel";
      const saveButton = documentRef.createElement("button");
      saveButton.type = "submit";
      saveButton.className = "gsm-hoshidicts-note-save";
      saveButton.textContent = "Save";
      actions.append(cancelButton, saveButton);
      form.appendChild(actions);
      let saving = false;

      function setSaving(nextSaving) {
        saving = nextSaving;
        termInput.disabled = saving;
        readingInput.disabled = saving;
        definitionInput.disabled = saving;
        cancelButton.disabled = saving;
        saveButton.disabled = saving;
        saveButton.textContent = saving ? "Saving\u2026" : "Save";
      }

      function closeForm(force = false) {
        if (saving && !force) {
          return;
        }
        form.hidden = true;
        noteButton.setAttribute("aria-expanded", "false");
        setNoteEditing(false);
        positionPopup();
      }

      function openForm() {
        form.hidden = false;
        noteButton.setAttribute("aria-expanded", "true");
        setNoteEditing(true);
        popup.scrollTop = toolbarPosition === "bottom" ? popup.scrollHeight : 0;
        termInput.focus();
        if (selectTermOnOpen) {
          termInput.select();
        }
        positionPopup();
      }

      noteButton.addEventListener("click", openForm);
      cancelButton.addEventListener("click", closeForm);
      form.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeForm();
        noteButton.focus();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const entry = {
          term: termInput.value.trim(),
          reading: readingInput.value.trim(),
          definition: definitionInput.value.trim(),
        };
        if (!entry.term || !entry.reading || !entry.definition) {
          error.textContent = "Term, reading, and definition are required.";
          error.hidden = false;
          return;
        }
        if (entry.term.startsWith("#")) {
          error.textContent = "Custom dictionary terms cannot begin with #.";
          error.hidden = false;
          return;
        }
        if (!isJsonStringWithinUtf8Limit(
          entry.definition,
          MAX_CUSTOM_DEFINITION_BYTES
        )) {
          error.textContent =
            "The definition must be no larger than 2 KiB when saved.";
          error.hidden = false;
          return;
        }
        if (typeof onAddCustomEntry !== "function") {
          error.textContent = "The custom dictionary is unavailable.";
          error.hidden = false;
          return;
        }

        error.hidden = true;
        setSaving(true);
        try {
          await onAddCustomEntry(entry);
          closeForm(true);
        } catch (saveError) {
          error.textContent = saveError && typeof saveError.message === "string"
            ? saveError.message
            : String(saveError);
          error.hidden = false;
        } finally {
          if (saveButton.isConnected) {
            setSaving(false);
            positionPopup();
          }
        }
      });
      return { button: noteButton, form };
    }

    function createResultChrome(primaryHeader, metadataStrip = null) {
      const chrome = documentRef.createElement("div");
      chrome.className = "gsm-hoshidicts-result-chrome";
      chrome.appendChild(primaryHeader);
      if (metadataStrip) {
        chrome.appendChild(metadataStrip);
      }
      return chrome;
    }

    function renderNotice(message, candidate) {
      clear();
      const notice = documentRef.createElement("div");
      notice.className = "gsm-hoshidicts-lookup-notice";
      notice.setAttribute("role", "status");
      notice.textContent = message;
      const noteControls = createNoteControls(
        { term: candidate?.query || "", reading: "", definition: "" },
        true
      );
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      const actions = documentRef.createElement("div");
      actions.className = "gsm-hoshidicts-entry-actions";
      registerEntryActions({
        actions,
        candidate,
        feedback: notice,
        noteButton: noteControls.button,
        result: { term: { expression: candidate?.query || "" } },
      });
      primaryHeader.appendChild(actions);
      const toolbar = createResultChrome(primaryHeader);
      popup.append(toolbar, notice, noteControls.form);
      setRenderedToolbar(toolbar, noteControls.form, notice);
    }

    function appendMetadata(
      entry,
      result,
      dictionaryPresentation = [],
      {
        includeFrequency = true,
        includePitch = true,
        averageFrequency = false,
        showFrequencyDictionaryNames = true,
      } = {}
    ) {
      const frequencyRow = documentRef.createElement("div");
      frequencyRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-frequency-metadata";
      const pitchRow = documentRef.createElement("div");
      pitchRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-pitch-metadata";
      const seen = new Set();
      let count = 0;
      const pitchDictionaryDisplayNames = createDictionaryDisplayNames(
        result.term.pitches.map(({ dictionary }) => dictionary),
        dictionaryPresentation
      );
      if (includeFrequency) {
        const frequencyTags = createFrequencyTags(
          documentRef,
          result,
          dictionaryPresentation,
          maxMetadataTags,
          averageFrequency,
          showFrequencyDictionaryNames
        );
        frequencyRow.append(...frequencyTags);
        count += frequencyTags.length;
      }
      if (includePitch) {
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
                pitchDictionaryDisplayNames.get(group.dictionary) || group.dictionary,
                pitch,
                reading
              ));
              count += 1;
            }
          }
        }
      }
      if (frequencyRow.childNodes.length > 0) {
        entry.appendChild(frequencyRow);
      }
      if (pitchRow.childNodes.length > 0) {
        entry.appendChild(pitchRow);
      }
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
      for (const step of result.trace) {
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

    function renderPrimaryMetadataCapsule(
      capsule,
      result,
      dictionaryPresentation,
      hideGrammarTags,
      averageFrequency,
      showFrequencyDictionaryNames
    ) {
      capsule.replaceChildren();
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
        capsule.appendChild(frequencies);
      }
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
      capsule.hidden = capsule.childNodes.length === 0;
    }

    function updateMetadataStripVisibility(strip, tabList, capsule) {
      strip.hidden = !tabList && capsule.hidden;
    }

    function createEntryHeader(
      result,
      candidate,
      feedback,
      {
        element = null,
        noteButton = null,
        primary = false,
        showCompactDefinitionSummary = false,
        compactDefinitionSummaryCount =
          DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT,
        compactDefinitionSummaryDictionary = null,
        generation = null,
        resolveMedia = null,
        onLayoutChange = null,
        showPitchAccentFurigana = true,
        pitchAccentFuriganaDictionary = null,
        onBack = null,
        deinflectionLocale = "en",
      } = {}
    ) {
      const header = element || documentRef.createElement("header");
      header.className = primary
        ? "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header"
        : "gsm-hoshidicts-entry-header";
      header.replaceChildren();

      if (typeof onBack === "function") {
        const navigation = documentRef.createElement("div");
        navigation.className = "gsm-hoshidicts-kanji-navigation";
        const back = documentRef.createElement("button");
        back.type = "button";
        back.className = "gsm-hoshidicts-kanji-back";
        back.textContent = "Back";
        back.setAttribute("aria-label", "Back to term results");
        back.addEventListener("click", onBack);
        navigation.appendChild(back);
        header.appendChild(navigation);
      }

      const headword = documentRef.createElement("div");
      headword.className = "gsm-hoshidicts-headword";
      const expression = documentRef.createElement("span");
      expression.className = "gsm-hoshidicts-expression";
      const expressionText = String(result.term.expression || "").trim();
      const readingText = String(result.term.reading || "").trim();
      appendExpressionRuby(
        documentRef,
        expression,
        expressionText,
        readingText,
        (character) => onKanjiClick(character, result, candidate),
        {
          enabled: showPitchAccentFurigana,
          groups: result.term.pitches,
          dictionary: pitchAccentFuriganaDictionary,
        }
      );
      expression.setAttribute(
        "aria-label",
        readingText && readingText !== expressionText
          ? `${expressionText}, ${readingText}`
          : expressionText
      );
      headword.appendChild(expression);
      if (showCompactDefinitionSummary === true) {
        const compactSummary = extractCompactDefinitionSummary(
          result.term.glossaries,
          compactDefinitionSummaryDictionary,
          compactDefinitionSummaryCount
        );
        if (compactSummary) {
          const summary = documentRef.createElement("div");
          summary.className = "gsm-hoshidicts-compact-definition-summary";
          summary.dataset.hoshidictsDictionary = compactSummary.dictionary;
          if (compactSummary.image && typeof resolveMedia === "function") {
            const image = documentRef.createElement("div");
            image.className = "gsm-hoshidicts-compact-definition-image";
            appendTextOnlyGlossary(
              documentRef,
              image,
              JSON.stringify({
                type: "structured-content",
                content: compactSummary.image,
              }),
              {
                dictionary: compactSummary.dictionary,
                generation,
                onLayoutChange,
                resolveMedia,
              }
            );
            if (image.childNodes.length > 0) {
              summary.appendChild(image);
            }
          }
          const items = documentRef.createElement("ul");
          items.className = "gsm-hoshidicts-compact-definition-items";
          for (const item of compactSummary.items) {
            const listItem = documentRef.createElement("li");
            listItem.textContent = item;
            items.appendChild(listItem);
          }
          summary.appendChild(items);
          headword.appendChild(summary);
        }
      }
      const deinflection = buildDeinflectionDisclosure(
        documentRef,
        result,
        deinflectionLocale
      );
      if (deinflection) {
        if (typeof onLayoutChange === "function") {
          deinflection.addEventListener("toggle", () => onLayoutChange());
        }
        headword.appendChild(deinflection);
      }
      header.appendChild(headword);

      const actions = documentRef.createElement("div");
      actions.className = "gsm-hoshidicts-entry-actions";
      const audioButton = documentRef.createElement("button");
      audioButton.type = "button";
      audioButton.className = "gsm-hoshidicts-audio-button";
      audioButton.dataset.state = "ready";
      audioButton.hidden = true;
      audioButton.title = "Play pronunciation";
      audioButton.setAttribute("aria-label", audioButton.title);
      audioButton.textContent = "";

      const mineButton = documentRef.createElement("button");
      mineButton.type = "button";
      mineButton.className = "gsm-hoshidicts-mine-button";
      setMiningButtonState(mineButton, "checking");
      mineButton.addEventListener("click", () => {
        onMineClick(mineButton, result, candidate, feedback);
      });
      registerEntryActions({
        actions,
        audioButton,
        candidate,
        feedback,
        mineButton,
        noteButton,
        result,
      });
      header.appendChild(actions);
      return {
        audioItems: [{ button: audioButton, result }],
        element: header,
        miningItems: [{ button: mineButton, result, candidate }],
        miningButtons: [mineButton],
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
        feedback: providedFeedback,
        metadataStrip,
        noteButton,
        primaryHeader,
        primaryMetadataCapsule,
        tabList,
      } = {}
    ) {
      panel.replaceChildren();
      // The transient status lives in the toolbar/status surface (a top-level
      // popup child, repositioned with the toolbar), not inside the scrolling
      // definition panel — so callers pass a persistent element to reuse across
      // tab re-renders. Fall back to a panel-local node only when none is given.
      let feedback = providedFeedback || null;
      if (feedback) {
        feedback.hidden = true;
        feedback.textContent = "";
        delete feedback.dataset.kind;
      } else {
        feedback = documentRef.createElement("div");
        feedback.className = "gsm-hoshidicts-mining-feedback";
        feedback.setAttribute("role", "status");
        feedback.setAttribute("aria-live", "polite");
        feedback.hidden = true;
        panel.appendChild(feedback);
      }
      const miningButtons = [];
      const miningItems = [];
      const audioItems = [];
      const deferredGlossaryFills = [];
      let lookupStats = null;

      function appendResult(result, resultIndex) {
        const entry = documentRef.createElement("article");
        entry.className = "gsm-hoshidicts-entry";
        entry.dataset.expression = result.term.expression;

        const renderedHeader = createEntryHeader(result, candidate, feedback, {
          element: resultIndex === 0 ? primaryHeader : null,
          noteButton: resultIndex === 0 ? noteButton : null,
          primary: resultIndex === 0,
          showCompactDefinitionSummary:
            renderContext.showCompactDefinitionSummary === true,
          compactDefinitionSummaryCount:
            renderContext.compactDefinitionSummaryCount,
          compactDefinitionSummaryDictionary:
            typeof renderContext.compactDefinitionSummaryDictionary === "string"
              ? renderContext.compactDefinitionSummaryDictionary
              : null,
          generation: renderContext.generation,
          resolveMedia: renderContext.resolveMedia,
          onLayoutChange: positionPopup,
          showPitchAccentFurigana:
            renderContext.showPitchAccentFurigana !== false,
          pitchAccentFuriganaDictionary:
            typeof renderContext.pitchAccentFuriganaDictionary === "string"
              ? renderContext.pitchAccentFuriganaDictionary
              : null,
          onBack:
            resultIndex === 0 && typeof renderContext.onBack === "function"
              ? renderContext.onBack
              : null,
          deinflectionLocale: renderContext.deinflectionLocale,
        });
        audioItems.push(...renderedHeader.audioItems);
        miningItems.push(...renderedHeader.miningItems);
        miningButtons.push(...renderedHeader.miningButtons);
        if (resultIndex !== 0) {
          entry.appendChild(renderedHeader.element);
        }

        if (resultIndex === 0 && renderContext.showLookupCounts === true) {
          lookupStats = documentRef.createElement("div");
          lookupStats.className = "gsm-hoshidicts-lookup-stats";
          lookupStats.setAttribute("role", "status");
          lookupStats.setAttribute("aria-live", "polite");
          lookupStats.hidden = true;
          entry.appendChild(lookupStats);
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
            renderContext.showFrequencyDictionaryNames !== false
          );
          if (metadataStrip) {
            updateMetadataStripVisibility(
              metadataStrip,
              tabList,
              primaryMetadataCapsule
            );
          }
        }

        appendMetadata(
          entry,
          result,
          Array.isArray(renderContext.dictionaryPresentation)
            ? renderContext.dictionaryPresentation
            : [],
          {
            includeFrequency: resultIndex !== 0,
            includePitch: renderContext.showPitchAccentBadge === true,
            averageFrequency: renderContext.averageFrequency === true,
            showFrequencyDictionaryNames:
              renderContext.showFrequencyDictionaryNames !== false,
          }
        );

        if (
          resultIndex !== 0 &&
          renderContext.hidePopupGrammarTags === false
        ) {
          const tagRow = documentRef.createElement("div");
          tagRow.className = "gsm-hoshidicts-tags";
          for (const item of collectGrammarMetadata(result)) {
            tagRow.appendChild(createTag(
              documentRef,
              item.text,
              item.description,
              item.kind
            ));
          }
          if (tagRow.childNodes.length > 0) {
            entry.appendChild(tagRow);
          }
        }

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
          const details = documentRef.createElement("details");
          details.className = "gsm-hoshidicts-glossary-card";
          details.open = true;
          details.addEventListener("toggle", scheduleMasonry);
          const summary = documentRef.createElement("summary");
          summary.textContent = dictionaryDisplayNames?.get(dictionary) || dictionary;
          summary.title = dictionary;
          summary.setAttribute("aria-label", dictionary);
          details.appendChild(summary);
          const definitions = documentRef.createElement("ol");
          definitions.className = "gsm-hoshidicts-definitions";
          if (glossaries.length === 1) {
            definitions.classList.add("gsm-hoshidicts-definitions-single");
          }
          applyDefinitionBlurState(definitions);
          for (const glossary of glossaries) {
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
            const fillContent = () => appendTextOnlyGlossary(
              documentRef,
              content,
              glossary.glossary,
              {
                dictionary,
                generation: renderContext.generation,
                onInternalLink: renderContext.onInternalLink,
                onLayoutChange: positionPopup,
                resolveMedia: renderContext.resolveMedia,
              }
            );
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
          details.appendChild(definitions);
          glossaryGrid.appendChild(details);
        }
        entry.appendChild(glossaryGrid);
        for (const card of glossaryGrid.children) {
          masonryObserver?.observe(card);
        }
        scheduleMasonry();
        panel.appendChild(entry);
      }

      // Fills the queued glossaries on the next task, once the first entry has
      // had a chance to paint. Fills inline without a timer available.
      function flushDeferredGlossaries() {
        if (deferredGlossaryFills.length === 0) {
          return;
        }
        const fills = deferredGlossaryFills.splice(0);
        const run = () => {
          for (const fill of fills) {
            fill();
          }
          positionPopup();
        };
        if (typeof windowRef.setTimeout === "function") {
          windowRef.setTimeout(run, 0);
        } else {
          run();
        }
      }

      results.slice(0, initialResultCount).forEach(appendResult);
      flushDeferredGlossaries();

      if (results.length > initialResultCount) {
        const showMore = documentRef.createElement("button");
        showMore.type = "button";
        showMore.className = "gsm-hoshidicts-show-more";
        showMore.textContent = `Show ${results.length - initialResultCount} more`;
        showMore.addEventListener("click", () => {
          const miningButtonStart = miningButtons.length;
          const miningItemStart = miningItems.length;
          showMore.remove();
          results.slice(initialResultCount).forEach((result, resultIndex) => {
            appendResult(result, resultIndex + initialResultCount);
          });
          flushDeferredGlossaries();
          onResultsExpanded({
            audioItems,
            appendedMiningButtons: miningButtons.slice(miningButtonStart),
            appendedMiningItems: miningItems.slice(miningItemStart),
            feedback,
            miningItems,
          });
          positionPopup();
        });
        panel.appendChild(showMore);
      }

      currentSourceHighlight = {
        candidate,
        matchedText: results[0].matched || results[0].term.expression,
      };
      if (sourceHighlightEnabled) {
        sourceHighlighter.apply(
          currentSourceHighlight.candidate,
          currentSourceHighlight.matchedText
        );
      }
      return {
        audioItems,
        feedback,
        lookupStats,
        miningButtons,
        miningItems,
      };
    }

    function renderKanji(kanji, candidate, renderOptions = {}) {
      clear();
      const dictionaryDisplayNames = createDictionaryDisplayNames(
        kanji.entries.map(({ dictionary }) => dictionary),
        Array.isArray(renderOptions.dictionaryPresentation)
          ? renderOptions.dictionaryPresentation
          : []
      );
      const noteControls = createNoteControls(
        { term: kanji.character, reading: "", definition: "" },
        true
      );
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      const navigation = documentRef.createElement("div");
      navigation.className = "gsm-hoshidicts-kanji-navigation";
      if (typeof renderOptions.onBack === "function") {
        const back = documentRef.createElement("button");
        back.type = "button";
        back.className = "gsm-hoshidicts-kanji-back";
        back.textContent = "Back";
        back.setAttribute("aria-label", "Back to term results");
        back.addEventListener("click", renderOptions.onBack);
        navigation.appendChild(back);
      }
      const glyph = documentRef.createElement("div");
      glyph.className = "gsm-hoshidicts-kanji-glyph";
      glyph.textContent = kanji.character;
      navigation.appendChild(glyph);
      primaryHeader.appendChild(navigation);
      const actions = documentRef.createElement("div");
      actions.className = "gsm-hoshidicts-entry-actions";
      const feedback = documentRef.createElement("div");
      feedback.className = "gsm-hoshidicts-mining-feedback";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      feedback.hidden = true;
      registerEntryActions({
        actions,
        candidate,
        feedback,
        noteButton: noteControls.button,
        result: { term: { expression: kanji.character } },
      });
      primaryHeader.appendChild(actions);
      const toolbar = createResultChrome(primaryHeader);
      popup.append(toolbar, feedback, noteControls.form);

      const preferredDictionary = typeof renderOptions.kanjiClickDictionary === "string"
        ? renderOptions.kanjiClickDictionary
        : kanji.entries.find(({ dictionary }) => /^KANJIDIC\b/i.test(dictionary))
          ?.dictionary;
      const entries = preferredDictionary
        ? kanji.entries.filter(({ dictionary }) =>
            dictionary === preferredDictionary
          )
        : kanji.entries;
      for (const kanjiEntry of entries) {
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

        if (kanjiEntry.tags.length > 0) {
          const tags = documentRef.createElement("div");
          tags.className = "gsm-hoshidicts-tags";
          for (const tag of kanjiEntry.tags) {
            tags.appendChild(createTag(documentRef, tag, "", "term"));
          }
          entry.appendChild(tags);
        }

        const readings = documentRef.createElement("div");
        readings.className = "gsm-hoshidicts-kanji-readings";
        for (const [label, values] of [
          ["On", kanjiEntry.onyomi],
          ["Kun", kanjiEntry.kunyomi],
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

        if (kanjiEntry.definitions.length > 0) {
          const meaningsHeading = documentRef.createElement("h4");
          meaningsHeading.textContent = "Meanings";
          entry.appendChild(meaningsHeading);
          const meanings = documentRef.createElement("ol");
          meanings.className = "gsm-hoshidicts-kanji-meanings";
          for (const meaning of kanjiEntry.definitions) {
            const item = documentRef.createElement("li");
            item.textContent = meaning;
            meanings.appendChild(item);
          }
          entry.appendChild(meanings);
        }

        if (kanjiEntry.stats.length > 0) {
          const details = documentRef.createElement("details");
          details.className = "gsm-hoshidicts-kanji-stats";
          const summary = documentRef.createElement("summary");
          summary.textContent = "Details";
          details.appendChild(summary);
          const list = documentRef.createElement("dl");
          for (const stat of kanjiEntry.stats) {
            const name = documentRef.createElement("dt");
            name.textContent = stat.name;
            const value = documentRef.createElement("dd");
            value.textContent = stat.value;
            list.append(name, value);
          }
          details.appendChild(list);
          entry.appendChild(details);
        }
        popup.appendChild(entry);
      }

      setRenderedToolbar(toolbar, noteControls.form, feedback);

      if (sourceHighlightEnabled) {
        sourceHighlighter.apply(
          candidate,
          renderOptions.highlightText || kanji.character
        );
      }
    }

    function renderResults(results, candidate, renderContext = {}) {
      clear();
      setDefinitionBlurState(renderContext.definitionBlurState);
      const dictionaries = collectGlossaryDictionaries(results);
      const dictionaryPresentation = Array.isArray(
        renderContext.dictionaryPresentation
      ) ? renderContext.dictionaryPresentation : [];
      const dictionaryTabGroups = Array.isArray(
        renderContext.dictionaryTabGroups
      ) ? renderContext.dictionaryTabGroups : [];
      const dictionaryDisplayNames = createDictionaryDisplayNames(
        dictionaries,
        dictionaryPresentation
      );
      const availableDictionaries = new Set(dictionaries);
      const groupedDictionaries = new Set(
        dictionaryTabGroups.flatMap(({ dictionaries: groupDictionaries }) =>
          Array.isArray(groupDictionaries) ? groupDictionaries : []
        )
      );
      const availableGroups = dictionaryTabGroups.flatMap((group) => {
        const groupDictionaries = Array.isArray(group.dictionaries)
          ? group.dictionaries.filter((title) => availableDictionaries.has(title))
          : [];
        return groupDictionaries.length > 0
          ? [{ ...group, dictionaries: groupDictionaries }]
          : [];
      });
      const favoriteDictionaries = dictionaryPresentation
        .filter(({ favorite, title }) =>
          favorite === true &&
          availableDictionaries.has(title) &&
          !groupedDictionaries.has(title)
        )
        .map(({ title }) => title);
      const usedTabLabels = new Set();
      function uniqueTabLabel(label, qualifier) {
        let candidate = label;
        let suffix = 1;
        while (usedTabLabels.has(candidate)) {
          const qualifiedSuffix = suffix === 1
            ? qualifier
            : `${qualifier} ${suffix}`;
          candidate = `${label} (${qualifiedSuffix})`;
          suffix += 1;
        }
        usedTabLabels.add(candidate);
        return candidate;
      }
      const tabDescriptors = [
        {
          label: uniqueTabLabel("All", "tab"),
          title: "All dictionaries",
          dictionaries: new Set(),
        },
        ...availableGroups.map((group) => ({
          label: uniqueTabLabel(group.name, "group"),
          title: `Tab group: ${group.name}`,
          groupId: group.id,
          dictionaries: new Set(group.dictionaries),
        })),
        ...favoriteDictionaries.map((dictionary) => ({
          label: uniqueTabLabel(
            dictionaryDisplayNames.get(dictionary) || dictionary,
            "dictionary"
          ),
          title: dictionary,
          dictionary,
          dictionaries: new Set([dictionary]),
        })),
      ];
      const tabList = tabDescriptors.length > 1
        ? documentRef.createElement("div")
        : null;
      if (tabList) {
        tabList.className = "gsm-hoshidicts-tab-list";
        tabList.setAttribute("role", "tablist");
        tabList.setAttribute("aria-label", "Dictionaries");
        tabList.setAttribute("aria-orientation", "horizontal");
      }
      const metadataStrip = documentRef.createElement("div");
      metadataStrip.className = "gsm-hoshidicts-metadata-strip";
      metadataStrip.hidden = true;
      if (tabList) {
        metadataStrip.appendChild(tabList);
      }
      const primaryMetadataCapsule = documentRef.createElement("div");
      primaryMetadataCapsule.className =
        "gsm-hoshidicts-primary-metadata-capsule";
      primaryMetadataCapsule.hidden = true;
      primaryMetadataCapsule.setAttribute("role", "group");
      primaryMetadataCapsule.setAttribute("aria-label", "Entry metadata");
      metadataStrip.appendChild(primaryMetadataCapsule);
      const panel = documentRef.createElement("div");
      panel.id = `${idPrefix}-tab-panel`;
      panel.className = "gsm-hoshidicts-tab-panel";
      if (tabList) {
        panel.setAttribute("role", "tabpanel");
      }

      const initialResult = results[0];
      const noteControls = createNoteControls({
        term: initialResult.term.expression,
        reading: initialResult.term.reading,
        definition: "",
      });
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      const toolbar = createResultChrome(primaryHeader, metadataStrip);
      // Persistent status node lives beside the toolbar (not in the scrolling
      // panel) so it travels with the toolbar when placement flips it to the
      // bottom, keeping the complete Yomitan-style status surface together.
      const feedback = documentRef.createElement("div");
      feedback.className = "gsm-hoshidicts-mining-feedback";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      feedback.hidden = true;
      popup.append(toolbar, feedback, noteControls.form, panel);
      setRenderedToolbar(toolbar, noteControls.form, feedback);

      const tabButtons = [];
      const requestedTab = isRecord(renderContext.selectedDictionaryTab)
        ? renderContext.selectedDictionaryTab
        : null;
      const requestedTabIndex = requestedTab
        ? tabDescriptors.findIndex((descriptor) =>
            typeof requestedTab.dictionary === "string"
              ? descriptor.dictionary === requestedTab.dictionary
              : typeof requestedTab.groupId === "string"
                ? descriptor.groupId === requestedTab.groupId
                : false
          )
        : -1;
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
        if (hasRendered && !selectionChanged) {
          if (
            button && !popup.hidden
            && typeof button.scrollIntoView === "function"
          ) {
            button.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
          return;
        }
        if (hasRendered) {
          onBeforeResultsRendered();
        }
        popup.scrollTop = 0;
        const selectedDictionaries = tabDescriptors[selectedIndex].dictionaries;
        const projectedResults = projectResults(results, selectedDictionaries);
        rendered = renderResultPanel(
          panel,
          projectedResults,
          candidate,
          {
            ...renderContext,
            // Lookup statistics describe the first unfiltered result. Keep the
            // line on the All tab so a dictionary projection cannot attach the
            // original term's count to a different expression.
            showLookupCounts:
              selectedDictionaries.size === 0
              && renderContext.showLookupCounts === true,
          },
          {
            dictionaryDisplayNames,
            feedback,
            metadataStrip,
            noteButton: noteControls.button,
            primaryHeader,
            primaryMetadataCapsule,
            tabList,
          }
        );
        if (hasRendered) {
          onResultsRendered(rendered);
        }
        hasRendered = true;
        positionPopup();
      }

      tabDescriptors.forEach((descriptor, index) => {
        if (!tabList) {
          return;
        }
        const button = documentRef.createElement("button");
        button.type = "button";
        button.id = `${idPrefix}-tab-${index}`;
        button.className = "gsm-hoshidicts-tab";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", panel.id);
        button.setAttribute("aria-selected", "false");
        button.tabIndex = -1;
        button.textContent = descriptor.label;
        button.title = descriptor.title;
        button.setAttribute("aria-label", descriptor.title);
        if (descriptor.groupId) button.dataset.groupId = descriptor.groupId;
        if (descriptor.dictionary) {
          button.dataset.dictionary = descriptor.dictionary;
        }
        button.addEventListener("click", () => activateTab(index));
        button.addEventListener("keydown", (event) => {
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
            activateTab(nextIndex, true);
          }
        });
        tabButtons.push(button);
        tabList.appendChild(button);
      });

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
      return rendered;
    }

    return {
      clear,
      renderNotice,
      renderResults,
      renderKanji,
      setDefinitionBlurState,
      setFeedback,
      setLookupStats,
      setPopupButtons,
      setSourceHighlightEnabled,
      setToolbarPosition,
      scheduleMasonry,
      destroy() {
        if (masonryFrame !== null) {
          windowRef.cancelAnimationFrame(masonryFrame);
          masonryFrame = null;
        }
        masonryObserver?.disconnect();
        windowRef.removeEventListener("resize", onWindowResize);
      },
    };
  }

  return {
    createSourceHighlighter,
    createPopupView,
    normalizeDeinflectionLocale,
    setMiningButtonState,
  };
}));
