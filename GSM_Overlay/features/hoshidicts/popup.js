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

    function createMatchRange(candidate, matchedText) {
      const matchLength = typeof matchedText === "string" ? matchedText.length : 0;
      if (matchLength <= 0 || !Array.isArray(candidate.sourceElements)) {
        return null;
      }
      const startOffset = Math.max(0, candidate.matchOffset);
      const endOffset = Math.min(candidate.sentence.length, startOffset + matchLength);
      if (endOffset <= startOffset) {
        return null;
      }

      const sourceElements = candidate.sourceElements.filter(
        (element) => element instanceof windowRef.Element && element.isConnected
      );
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
        return { range: null, sourceElements, startOffset, endOffset };
      }
      try {
        const range = documentRef.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        return { range, sourceElements, startOffset, endOffset };
      } catch {
        return { range: null, sourceElements, startOffset, endOffset };
      }
    }

    function applyElementFallback(match) {
      let elementStart = 0;
      for (const element of match.sourceElements) {
        const elementEnd = elementStart + (element.textContent || "").length;
        if (elementEnd > match.startOffset && elementStart < match.endOffset) {
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
        const match = createMatchRange(candidate, matchedText);
        if (!match) {
          continue;
        }
        if (canUseRanges && match.range) {
          ranges.push(match.range);
        } else {
          applyElementFallback(match);
        }
      }
      if (canUseRanges && ranges.length > 0) {
        try {
          highlights.set(highlightName, new HighlightImpl(...ranges));
        } catch {
          for (const { candidate, matchedText } of matches.values()) {
            const match = createMatchRange(candidate, matchedText);
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

  function createPopupView(options) {
    const documentRef = options.document;
    const windowRef = options.window;
    const popup = options.popup;
    const appendExpressionRuby = options.appendExpressionRuby;
    const appendTextOnlyGlossary = options.appendTextOnlyGlossary;
    const parseTagList = options.parseTagList;
    const positionPopup = options.positionPopup;
    const onMineClick = options.onMineClick;
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
          result.term.reading
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

    return {
      clear,
      renderNotice,
      renderResults,
      setFeedback,
    };
  }

  return {
    createSourceHighlighter,
    createPopupView,
    setMiningButtonState,
  };
}));
