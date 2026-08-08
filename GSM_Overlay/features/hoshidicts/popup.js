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
  const MAX_CUSTOM_DEFINITION_BYTES = 2 * 1024;
  const UTF8_ENCODER = new TextEncoder();

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
    const onAddCustomEntry = options.onAddCustomEntry;
    const onNoteEditingChange =
      typeof options.onNoteEditingChange === "function"
        ? options.onNoteEditingChange
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
    let noteEditing = false;

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
      popup.replaceChildren();
      popup.scrollTop = 0;
    }

    function setFeedback(feedback, message, kind = "info") {
      feedback.hidden = !message;
      feedback.dataset.kind = kind;
      feedback.textContent = message;
    }

    function appendNoteControls(prefill, selectTermOnOpen = false) {
      const toolbar = documentRef.createElement("div");
      toolbar.className = "gsm-hoshidicts-toolbar";

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
      noteButton.append(noteIcon, "Add definition");
      toolbar.appendChild(noteButton);
      popup.appendChild(toolbar);

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
      popup.appendChild(form);
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
    }

    function renderNotice(message, candidate) {
      clear();
      appendNoteControls(
        { term: candidate?.query || "", reading: "", definition: "" },
        true
      );
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
      appendNoteControls({
        term: results[0].term.expression,
        reading: results[0].term.reading,
        definition: "",
      });
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
    createPopupView,
    setMiningButtonState,
  };
}));
