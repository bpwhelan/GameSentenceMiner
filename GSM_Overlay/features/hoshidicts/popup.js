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

      const sourceElements = candidate.sourceElements;
      if (
        sourceElements.some(
          (element) => !(element instanceof windowRef.Element) || !element.isConnected
        ) ||
        sourceElements.map((element) => element.textContent || "").join("") !==
          candidate.sentence
      ) {
        return;
      }
      const ranges = [];
      const rangedSourceElements = [];
      let elementStart = 0;
      for (const element of sourceElements) {
        const elementEnd = elementStart + (element.textContent || "").length;
        if (elementEnd > startOffset && elementStart < endOffset) {
          element.classList.add("gsm-hoshidicts-source-match");
          highlightedSourceElements.push(element);

          const textNodes = [];
          const showText = windowRef.NodeFilter ? windowRef.NodeFilter.SHOW_TEXT : 4;
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
              rangedSourceElements.push(element);
            } catch {
              // Keep this element's class fallback if its exact range is invalid.
            }
          }
        }
        elementStart = elementEnd;
      }

      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      const HighlightImpl = windowRef.Highlight;
      if (
        !highlights ||
        typeof highlights.set !== "function" ||
        !HighlightImpl ||
        ranges.length === 0
      ) {
        return;
      }
      try {
        highlights.set(highlightName, new HighlightImpl(...ranges));
        for (const element of rangedSourceElements) {
          element.classList.remove("gsm-hoshidicts-source-match");
        }
        highlightedSourceElements = highlightedSourceElements.filter(
          (element) => !rangedSourceElements.includes(element)
        );
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
    let sourceHighlightEnabled = options.sourceHighlightEnabled === true;
    let currentSourceHighlight = null;

    function clear() {
      sourceHighlighter.clear();
      currentSourceHighlight = null;
      popup.replaceChildren();
      popup.scrollTop = 0;
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
      return { feedback, miningButtons };
    }

    return {
      clear,
      renderNotice,
      renderResults,
      setFeedback,
      setSourceHighlightEnabled,
    };
  }

  return {
    createPopupView,
    setMiningButtonState,
  };
}));
