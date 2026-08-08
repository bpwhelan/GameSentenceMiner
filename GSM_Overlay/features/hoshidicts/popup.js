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

  function createTag(documentRef, text, description, kind) {
    const tag = documentRef.createElement("span");
    tag.className = `gsm-hoshidicts-tag gsm-hoshidicts-tag-${kind}`;
    tag.textContent = text;
    if (description) {
      tag.title = description;
    }
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
    button.textContent = {
      checking: "…",
      ready: "+",
      mining: "⟳",
      success: "✓",
      error: "!",
      duplicate: "•",
      unavailable: "-",
    }[state] || "-";
  }

  function createSourceHighlighter(windowRef, documentRef, highlightName) {
    let highlightedSourceElements = [];

    function clear() {
      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      if (highlights && typeof highlights.delete === "function") {
        highlights.delete(highlightName);
      }
      for (const element of highlightedSourceElements) {
        element.classList.remove("gsm-hoshidicts-source-match");
      }
      highlightedSourceElements = [];
    }

    function apply(candidate, matchedText) {
      clear();
      const matchLength = typeof matchedText === "string" ? matchedText.length : 0;
      if (matchLength <= 0 || !Array.isArray(candidate.sourceElements)) {
        return;
      }
      const startOffset = Math.max(0, candidate.matchOffset);
      const endOffset = Math.min(candidate.sentence.length, startOffset + matchLength);
      if (endOffset <= startOffset) {
        return;
      }

      const sourceElements = candidate.sourceElements.filter(
        (element) => element instanceof windowRef.Element && element.isConnected
      );
      let elementStart = 0;
      for (const element of sourceElements) {
        const elementEnd = elementStart + (element.textContent || "").length;
        if (elementEnd > startOffset && elementStart < endOffset) {
          element.classList.add("gsm-hoshidicts-source-match");
          highlightedSourceElements.push(element);
        }
        elementStart = elementEnd;
      }

      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      const HighlightImpl = windowRef.Highlight;
      if (!highlights || typeof highlights.set !== "function" || !HighlightImpl) {
        return;
      }
      const textNodes = [];
      const showText = windowRef.NodeFilter ? windowRef.NodeFilter.SHOW_TEXT : 4;
      for (const element of sourceElements) {
        const walker = documentRef.createTreeWalker(element, showText);
        let node = walker.nextNode();
        while (node) {
          textNodes.push(node);
          node = walker.nextNode();
        }
      }
      function findBoundary(offset) {
        let consumed = 0;
        for (const node of textNodes) {
          const length = (node.nodeValue || "").length;
          if (offset <= consumed + length) {
            return { node, offset: Math.max(0, offset - consumed) };
          }
          consumed += length;
        }
        return null;
      }
      const start = findBoundary(startOffset);
      const end = findBoundary(endOffset);
      if (!start || !end) {
        return;
      }
      try {
        const range = documentRef.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        highlights.set(highlightName, new HighlightImpl(range));
        for (const element of highlightedSourceElements) {
          element.classList.remove("gsm-hoshidicts-source-match");
        }
        highlightedSourceElements = [];
      } catch {
        // Keep the non-mutating element-class fallback when exact ranges fail.
      }
    }

    return { apply, clear };
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
    const initialResultCount = Number.isInteger(options.initialResultCount)
      ? Math.max(1, options.initialResultCount)
      : DEFAULT_INITIAL_RESULT_COUNT;
    const maxMetadataTags = Number.isInteger(options.maxMetadataTags)
      ? Math.max(1, options.maxMetadataTags)
      : DEFAULT_MAX_METADATA_TAGS;
    const sourceHighlighter = createSourceHighlighter(
      windowRef,
      documentRef,
      options.highlightName || DEFAULT_HIGHLIGHT_NAME
    );

    function clear() {
      sourceHighlighter.clear();
      popup.replaceChildren();
      popup.scrollTop = 0;
    }

    function setFeedback(feedback, message, kind = "info") {
      feedback.hidden = !message;
      feedback.dataset.kind = kind;
      feedback.textContent = message;
    }

    function renderNotice(message) {
      clear();
      const notice = documentRef.createElement("div");
      notice.className = "gsm-hoshidicts-lookup-notice";
      notice.setAttribute("role", "status");
      notice.textContent = message;
      popup.appendChild(notice);
    }

    function appendMetadata(entry, result) {
      const row = documentRef.createElement("div");
      row.className = "gsm-hoshidicts-metadata";
      const seen = new Set();
      let count = 0;
      for (const group of result.term.frequencies) {
        for (const frequency of group.frequencies) {
          const value = frequency.displayValue || String(frequency.value);
          const key = `frequency:${group.dictionary}:${value}`;
          if (!seen.has(key) && count < maxMetadataTags) {
            seen.add(key);
            row.appendChild(createTag(
              documentRef,
              `Freq ${value}`,
              group.dictionary,
              "frequency"
            ));
            count += 1;
          }
        }
      }
      for (const group of result.term.pitches) {
        for (const pitch of group.pitches) {
          const text = `Pitch ${pitch.position}${pitch.pattern ? ` ${pitch.pattern}` : ""}`;
          const key = `pitch:${group.dictionary}:${text}`;
          if (!seen.has(key) && count < maxMetadataTags) {
            seen.add(key);
            const description = [group.dictionary, ...group.transcriptions]
              .filter(Boolean)
              .join(" · ");
            row.appendChild(createTag(documentRef, text, description, "pitch"));
            count += 1;
          }
        }
      }
      if (row.childNodes.length > 0) {
        entry.appendChild(row);
      }
    }

    function renderResults(results, candidate) {
      clear();
      const feedback = documentRef.createElement("div");
      feedback.className = "gsm-hoshidicts-mining-feedback";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      feedback.hidden = true;
      popup.appendChild(feedback);
      const miningButtons = [];

      results.forEach((result, resultIndex) => {
        const entry = documentRef.createElement("article");
        entry.className = "gsm-hoshidicts-entry";
        entry.dataset.expression = result.term.expression;
        if (resultIndex >= initialResultCount) {
          entry.hidden = true;
        }

        const header = documentRef.createElement("header");
        header.className = "gsm-hoshidicts-entry-header";
        const expression = documentRef.createElement("span");
        expression.className = "gsm-hoshidicts-expression";
        appendExpressionRuby(
          documentRef,
          expression,
          result.term.expression,
          result.term.reading,
          (character) => onKanjiClick(character, result, candidate)
        );
        header.appendChild(expression);

        const mineButton = documentRef.createElement("button");
        mineButton.type = "button";
        mineButton.className = "gsm-hoshidicts-mine-button";
        setMiningButtonState(mineButton, "checking");
        mineButton.addEventListener("click", () => {
          onMineClick(mineButton, result, candidate, feedback);
        });
        header.appendChild(mineButton);
        miningButtons.push(mineButton);
        entry.appendChild(header);

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
        appendMetadata(entry, result);

        const groupedGlossaries = new Map();
        for (const glossary of result.term.glossaries) {
          if (!groupedGlossaries.has(glossary.dictionary)) {
            groupedGlossaries.set(glossary.dictionary, []);
          }
          groupedGlossaries.get(glossary.dictionary).push(glossary);
        }
        let dictionaryIndex = 0;
        for (const [dictionary, glossaries] of groupedGlossaries) {
          const details = documentRef.createElement("details");
          details.className = "gsm-hoshidicts-glossary-card";
          details.open = dictionaryIndex === 0;
          const summary = documentRef.createElement("summary");
          summary.textContent = dictionary;
          details.appendChild(summary);
          const definitions = documentRef.createElement("ol");
          definitions.className = "gsm-hoshidicts-definitions";
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
            appendTextOnlyGlossary(documentRef, content, glossary.glossary);
            definition.appendChild(content);
            definitions.appendChild(definition);
          }
          details.appendChild(definitions);
          entry.appendChild(details);
          dictionaryIndex += 1;
        }
        popup.appendChild(entry);
      });

      if (results.length > initialResultCount) {
        const showMore = documentRef.createElement("button");
        showMore.type = "button";
        showMore.className = "gsm-hoshidicts-show-more";
        showMore.textContent = `Show ${results.length - initialResultCount} more`;
        showMore.addEventListener("click", () => {
          for (const entry of popup.querySelectorAll(".gsm-hoshidicts-entry[hidden]")) {
            entry.hidden = false;
          }
          showMore.remove();
          positionPopup();
        });
        popup.appendChild(showMore);
      }

      sourceHighlighter.apply(
        candidate,
        results[0].matched || results[0].term.expression
      );
      return { feedback, miningButtons };
    }

    function renderKanji(kanji, candidate, renderOptions = {}) {
      clear();
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
      popup.appendChild(navigation);

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

    return {
      clear,
      renderNotice,
      renderResults,
      renderKanji,
      setFeedback,
    };
  }

  return {
    createPopupView,
    setMiningButtonState,
  };
}));
