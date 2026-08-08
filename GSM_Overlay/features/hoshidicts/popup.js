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

  const DEFAULT_INITIAL_RESULT_COUNT = 6;
  const DEFAULT_MAX_METADATA_TAGS = 12;
  const DEFAULT_HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const DEFINITION_BLUR_STATES = new Set(["pending", "blurred"]);
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

  function createDictionaryDisplayNames(dictionaries) {
    const cleanedNames = new Map();
    const counts = new Map();
    for (const dictionary of dictionaries) {
      const cleanedName = cleanDictionaryDisplayName(dictionary);
      cleanedNames.set(dictionary, cleanedName);
      counts.set(cleanedName, (counts.get(cleanedName) || 0) + 1);
    }
    const displayNames = new Map();
    for (const dictionary of dictionaries) {
      const cleanedName = cleanedNames.get(dictionary);
      displayNames.set(
        dictionary,
        counts.get(cleanedName) === 1 ? cleanedName : dictionary
      );
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

  function createFrequencyTag(
    documentRef,
    group,
    dictionaryDisplayName,
    frequencies
  ) {
    const tag = createTag(documentRef, "", group.dictionary, "frequency");
    tag.dataset.dictionary = group.dictionary;

    const source = documentRef.createElement("span");
    source.className = "gsm-hoshidicts-frequency-source";
    source.textContent = dictionaryDisplayName;
    tag.appendChild(source);

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

    tag.setAttribute(
      "aria-label",
      `${group.dictionary}: ${frequencies.map(({ display }) => display).join(", ")}`
    );
    return tag;
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
    button.disabled = state !== "ready" && state !== "error";
    button.title = message || {
      checking: "Checking Anki availability",
      ready: "Mine to Anki",
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
    icon.textContent = {
      checking: "…",
      ready: "+",
      mining: "⟳",
      success: "✓",
      error: "!",
      duplicate: "•",
      unavailable: "-",
    }[state] || "-";
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

  function createDictionaryPresentationGroups(dictionaryPresentation) {
    const groups = [];
    let currentGroup = null;
    for (const preference of dictionaryPresentation) {
      if (preference.displayMode === "always" || currentGroup === null) {
        currentGroup = [];
        groups.push(currentGroup);
      }
      currentGroup.push(preference.title);
    }
    return groups;
  }

  function applyDictionaryPresentation(results, dictionaryPresentation) {
    if (dictionaryPresentation.length === 0) {
      return results;
    }
    const configuredDictionaries = new Set(
      dictionaryPresentation.map(({ title }) => title)
    );
    const groups = createDictionaryPresentationGroups(dictionaryPresentation);
    const available = new Set(collectGlossaryDictionaries(results));
    const selected = new Set(
      [...available].filter(
        (dictionary) => !configuredDictionaries.has(dictionary)
      )
    );
    for (const group of groups) {
      const dictionary = group.find((title) => available.has(title));
      if (dictionary) {
        selected.add(dictionary);
      }
    }
    return results.map((result) => ({
      ...result,
      term: {
        ...result.term,
        glossaries: result.term.glossaries.filter(
          ({ dictionary }) => selected.has(dictionary)
        ),
      },
    })).filter((result) => result.term.glossaries.length > 0);
  }

  function createPopupView(options) {
    const documentRef = options.document;
    const windowRef = options.window;
    const popup = options.popup;
    const appendExpressionRuby = options.appendExpressionRuby;
    const appendTextOnlyGlossary = options.appendTextOnlyGlossary;
    const parseTagList = options.parseTagList;
    const positionPopup = options.positionPopup;
    const onMineClick = options.onMineClick;
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
      popup.replaceChildren();
      popup.scrollTop = 0;
      setDefinitionBlurState("revealed");
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
        popup.scrollTop = 0;
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

    function createResultChrome(primaryHeader, tabList = null) {
      const chrome = documentRef.createElement("div");
      chrome.className = "gsm-hoshidicts-result-chrome";
      chrome.appendChild(primaryHeader);
      if (tabList) {
        chrome.appendChild(tabList);
      }
      return chrome;
    }

    function renderNotice(message, candidate) {
      clear();
      const noteControls = createNoteControls(
        { term: candidate?.query || "", reading: "", definition: "" },
        true
      );
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      const actions = documentRef.createElement("div");
      actions.className = "gsm-hoshidicts-entry-actions";
      actions.appendChild(noteControls.button);
      primaryHeader.appendChild(actions);
      popup.append(createResultChrome(primaryHeader), noteControls.form);
      const notice = documentRef.createElement("div");
      notice.className = "gsm-hoshidicts-lookup-notice";
      notice.setAttribute("role", "status");
      notice.textContent = message;
      popup.appendChild(notice);
    }

    function appendMetadata(entry, result) {
      const frequencyRow = documentRef.createElement("div");
      frequencyRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-frequency-metadata";
      const pitchRow = documentRef.createElement("div");
      pitchRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-pitch-metadata";
      const seen = new Set();
      let count = 0;
      const frequencyDictionaryDisplayNames = createDictionaryDisplayNames(
        result.term.frequencies.map(({ dictionary }) => dictionary)
      );
      const pitchDictionaryDisplayNames = createDictionaryDisplayNames(
        result.term.pitches.map(({ dictionary }) => dictionary)
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
        if (frequencies.length > 0 && !seen.has(key) && count < maxMetadataTags) {
          seen.add(key);
          frequencyRow.appendChild(createFrequencyTag(
            documentRef,
            group,
            frequencyDictionaryDisplayNames.get(group.dictionary) || group.dictionary,
            frequencies
          ));
          count += 1;
        }
      }
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
      if (frequencyRow.childNodes.length > 0) {
        entry.appendChild(frequencyRow);
      }
      if (pitchRow.childNodes.length > 0) {
        entry.appendChild(pitchRow);
      }
    }

    function createEntryHeader(
      result,
      candidate,
      feedback,
      { element = null, noteButton = null, primary = false } = {}
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
      appendExpressionRuby(
        documentRef,
        expression,
        expressionText,
        readingText,
        (character) => onKanjiClick(character, result, candidate)
      );
      expression.setAttribute(
        "aria-label",
        readingText && readingText !== expressionText
          ? `${expressionText}, ${readingText}`
          : expressionText
      );
      headword.appendChild(expression);
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
      actions.appendChild(mineButton);
      actions.appendChild(audioButton);
      if (noteButton) {
        actions.appendChild(noteButton);
      }
      header.appendChild(actions);
      return {
        audioItems: [{ button: audioButton, result }],
        element: header,
        miningButtons: [mineButton],
      };
    }

    function collectDictionaries(results) {
      return collectGlossaryDictionaries(results);
    }

    function projectResults(results, dictionary) {
      if (dictionary === null) {
        return results;
      }
      const projected = [];
      for (const result of results) {
        const glossaries = result.term.glossaries.filter(
          (glossary) => glossary.dictionary === dictionary
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
      { dictionaryDisplayNames, noteButton, primaryHeader } = {}
    ) {
      panel.replaceChildren();
      const feedback = documentRef.createElement("div");
      feedback.className = "gsm-hoshidicts-mining-feedback";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      feedback.hidden = true;
      panel.appendChild(feedback);
      const miningButtons = [];
      const audioItems = [];
      let lookupStats = null;

      results.forEach((result, resultIndex) => {
        const entry = documentRef.createElement("article");
        entry.className = "gsm-hoshidicts-entry";
        entry.dataset.expression = result.term.expression;
        if (resultIndex >= initialResultCount) {
          entry.hidden = true;
        }

        const renderedHeader = createEntryHeader(result, candidate, feedback, {
          element: resultIndex === 0 ? primaryHeader : null,
          noteButton: resultIndex === 0 ? noteButton : null,
          primary: resultIndex === 0,
        });
        audioItems.push(...renderedHeader.audioItems);
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

        appendMetadata(entry, result);

        const tagRow = documentRef.createElement("div");
        tagRow.className = "gsm-hoshidicts-tags";
        const seenTags = new Set();
        for (const step of result.trace) {
          if (!seenTags.has(`trace:${step.name}`)) {
            seenTags.add(`trace:${step.name}`);
            tagRow.appendChild(
              createTag(documentRef, step.name, step.description, "deinflection")
            );
          }
        }
        for (const tag of [
          ...parseTagList(result.term.rules),
          ...result.term.glossaries.flatMap((glossary) =>
            parseTagList(glossary.termTags)
          ),
        ]) {
          if (!seenTags.has(`term:${tag}`)) {
            seenTags.add(`term:${tag}`);
            tagRow.appendChild(createTag(documentRef, tag, "", "term"));
          }
        }
        if (tagRow.childNodes.length > 0) {
          entry.appendChild(tagRow);
        }

        const groupedGlossaries = new Map();
        for (const glossary of result.term.glossaries) {
          if (!groupedGlossaries.has(glossary.dictionary)) {
            groupedGlossaries.set(glossary.dictionary, []);
          }
          groupedGlossaries.get(glossary.dictionary).push(glossary);
        }
        for (const [dictionary, glossaries] of groupedGlossaries) {
          const details = documentRef.createElement("details");
          details.className = "gsm-hoshidicts-glossary-card";
          details.open = true;
          details.addEventListener("toggle", positionPopup);
          const summary = documentRef.createElement("summary");
          summary.textContent = dictionaryDisplayNames?.get(dictionary) || dictionary;
          summary.title = dictionary;
          summary.setAttribute("aria-label", dictionary);
          details.appendChild(summary);
          const definitions = documentRef.createElement("ol");
          definitions.className = "gsm-hoshidicts-definitions";
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
            appendTextOnlyGlossary(documentRef, content, glossary.glossary, {
              dictionary,
              generation: renderContext.generation,
              onLayoutChange: positionPopup,
              resolveMedia: renderContext.resolveMedia,
            });
            definition.appendChild(content);
            definitions.appendChild(definition);
          }
          details.appendChild(definitions);
          entry.appendChild(details);
        }
        panel.appendChild(entry);
      });

      if (results.length > initialResultCount) {
        const showMore = documentRef.createElement("button");
        showMore.type = "button";
        showMore.className = "gsm-hoshidicts-show-more";
        showMore.textContent = `Show ${results.length - initialResultCount} more`;
        showMore.addEventListener("click", () => {
          for (const entry of panel.querySelectorAll(".gsm-hoshidicts-entry[hidden]")) {
            entry.hidden = false;
          }
          showMore.remove();
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
      return { audioItems, feedback, lookupStats, miningButtons };
    }

    function renderKanji(kanji, candidate, renderOptions = {}) {
      clear();
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
      actions.appendChild(noteControls.button);
      primaryHeader.appendChild(actions);
      popup.append(createResultChrome(primaryHeader), noteControls.form);

      for (const kanjiEntry of kanji.entries) {
        const entry = documentRef.createElement("article");
        entry.className = "gsm-hoshidicts-kanji-entry";
        entry.dataset.dictionary = kanjiEntry.dictionary;

        const dictionary = documentRef.createElement("h3");
        dictionary.className = "gsm-hoshidicts-kanji-dictionary";
        dictionary.textContent = kanjiEntry.dictionary;
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

      sourceHighlighter.apply(
        candidate,
        renderOptions.highlightText || kanji.character
      );
    }

    function renderResults(results, candidate, renderContext = {}) {
      clear();
      setDefinitionBlurState(renderContext.definitionBlurState);
      const dictionaries = collectDictionaries(results);
      const dictionaryDisplayNames = createDictionaryDisplayNames(dictionaries);
      const dictionaryPresentation = Array.isArray(
        renderContext.dictionaryPresentation
      ) ? renderContext.dictionaryPresentation : [];
      const availableDictionaries = new Set(dictionaries);
      const favoriteDictionaries = dictionaryPresentation
        .filter(({ favorite, title }) =>
          favorite === true && availableDictionaries.has(title)
        )
        .map(({ title }) => title);
      const tabList = favoriteDictionaries.length > 0
        ? documentRef.createElement("div")
        : null;
      if (tabList) {
        tabList.className = "gsm-hoshidicts-tab-list";
        tabList.setAttribute("role", "tablist");
        tabList.setAttribute("aria-label", "Dictionaries");
        tabList.setAttribute("aria-orientation", "horizontal");
      }
      const allResults = applyDictionaryPresentation(
        results,
        dictionaryPresentation
      );

      const panel = documentRef.createElement("div");
      panel.id = `${idPrefix}-tab-panel`;
      panel.className = "gsm-hoshidicts-tab-panel";
      if (tabList) {
        panel.setAttribute("role", "tabpanel");
      }

      const initialResult = allResults[0] || results[0];
      const noteControls = createNoteControls({
        term: initialResult.term.expression,
        reading: initialResult.term.reading,
        definition: "",
      });
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      popup.append(
        createResultChrome(primaryHeader, tabList),
        noteControls.form,
        panel
      );

      const tabValues = [null, ...favoriteDictionaries];
      const tabButtons = [];
      let activeIndex = 0;
      let hasRendered = false;
      let rendered = null;

      function activateTab(index, focusTab = false) {
        const tablessAllView = tabButtons.length === 0 && index === 0;
        if (!tablessAllView && (index < 0 || index >= tabButtons.length)) {
          return;
        }
        if (hasRendered && index === activeIndex) {
          if (focusTab) {
            tabButtons[index].focus();
          }
          return;
        }
        if (hasRendered) {
          onBeforeResultsRendered();
        }
        activeIndex = index;
        tabButtons.forEach((button, buttonIndex) => {
          const selected = buttonIndex === activeIndex;
          button.setAttribute("aria-selected", String(selected));
          button.tabIndex = selected ? 0 : -1;
        });
        const activeTab = tabButtons[activeIndex] || null;
        if (activeTab) {
          panel.setAttribute("aria-labelledby", activeTab.id);
          if (focusTab) {
            activeTab.focus();
          }
          if (!popup.hidden && typeof activeTab.scrollIntoView === "function") {
            activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        } else {
          panel.removeAttribute("aria-labelledby");
        }

        popup.scrollTop = 0;
        const projectedResults = activeIndex === 0
          ? allResults
          : projectResults(results, tabValues[activeIndex]);
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
              activeIndex === 0 && renderContext.showLookupCounts === true,
          },
          {
            dictionaryDisplayNames,
            noteButton: noteControls.button,
            primaryHeader,
          }
        );
        if (hasRendered) {
          onResultsRendered(rendered);
        }
        hasRendered = true;
        positionPopup();
      }

      tabValues.forEach((dictionary, index) => {
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
        button.textContent = dictionary === null
          ? "All"
          : dictionaryDisplayNames.get(dictionary) || dictionary;
        button.title = dictionary === null ? "All dictionaries" : dictionary;
        button.setAttribute(
          "aria-label",
          dictionary === null ? "All dictionaries" : dictionary
        );
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

      activateTab(0);
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
      setSourceHighlightEnabled,
    };
  }

  return {
    applyDictionaryPresentation,
    createSourceHighlighter,
    createPopupView,
    setMiningButtonState,
  };
}));
