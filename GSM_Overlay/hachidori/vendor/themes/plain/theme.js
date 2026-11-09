// Definition data directly to text nodes. No headers, metadata or action controls.
// SPDX-License-Identifier: GPL-3.0-or-later
function createView(options) {
  const { document, popup, components, sourceHighlighter } = options;
  const scroll = popup;
  scroll.classList.add("plain-scroll");
  let activeSource, entries = [], selected = 0;
  let highlightEnabled = options.sourceHighlightEnabled;
  // The render's language (docs/themes/README.md, "Languages"); without one,
  // or before the records have profiles, today's text.
  let language = options.language ?? null;
  const marked = () => language?.marked === true;
  const text = (value, direction = "ltr") => components.glossaryToPlainText(value, language, { direction });
  const selectEntry = event => {
    const index = entries.indexOf(event.target.closest(".gsm-hoshidicts-entry"));
    if (index >= 0) selected = index;
  };
  scroll.addEventListener("click", selectEntry);
  function clear() {
    scroll.replaceChildren(); entries = []; selected = 0; activeSource = null;
    sourceHighlighter?.clear();
  }
  function finish(candidate, matched, context) {
    activeSource = { candidate, matched };
    if (highlightEnabled) sourceHighlighter?.apply(candidate, matched);
    scroll.dataset.definitionBlur = context.definitionBlurState ?? "revealed";
    options.positionPopup();
    if (context.restoreScrollTop) scroll.scrollTop = context.restoreScrollTop;
  }
  function definition(value) {
    const entry = document.createElement("div");
    entry.className = "gsm-hoshidicts-entry gsm-hoshidicts-definitions gsm-hoshidicts-glossary-content";
    entry.textContent = value;
    entries.push(entry);
    scroll.append(entry);
    return entry;
  }
  // Once the records have profiles, each dictionary's text is its own block
  // with the dictionary's direction and default language (10.2).
  function dictionaryDefinitions(rows, result) {
    const entry = definition("");
    for (const [dictionary, glossaries] of Map.groupBy(rows, row => row.dictionary)) {
      const block = document.createElement("div");
      for (const [name, value] of Object.entries(language.glossaryAttributes(dictionary, result))) block.setAttribute(name, value);
      block.dataset.hoshidictsDictionary = dictionary;
      const direction = language.dictionaryDirection(dictionary, result);
      block.textContent = glossaries.map(row => text(row.glossary, direction)).join("\n");
      entry.append(block);
    }
  }
  function renderResults(results, candidate, context = {}) {
    clear();
    language = context.language ?? options.language ?? null;
    for (const result of results) {
      if (marked()) dictionaryDefinitions(result.term.glossaries, result);
      else definition(result.term.glossaries.map(glossary => text(glossary.glossary)).join("\n"));
    }
    finish(candidate, results[0]?.matched || candidate?.query, context);
    options.onResultsRendered?.({ audioButtons: [], miningActions: [], lookupStats: null });
  }
  function renderKanji(kanji, candidate, context = {}) {
    clear();
    language = context.language ?? options.language ?? null;
    for (const entry of kanji.entries) {
      if (marked()) dictionaryDefinitions([{ dictionary: entry.dictionary, glossary: entry.definitions }], null);
      else definition(text(entry.definitions));
    }
    finish(candidate, context.highlightText || kanji.character, context);
  }
  function renderNotice(message, candidate, context = {}) {
    clear(); scroll.textContent = message;
    finish(candidate, candidate?.query, context);
  }
  function renderLookupFailure(state, { preserveView = false } = {}) {
    if (!preserveView) clear();
    scroll.querySelector('[role="alert"]')?.remove();
    const failure = document.createElement("div");
    failure.setAttribute("role", "alert");
    failure.textContent = `${state.title}: ${state.detail}`;
    if (state.onAction) {
      const retry = document.createElement("button");
      retry.type = "button"; retry.textContent = state.actionLabel;
      retry.addEventListener("click", state.onAction); failure.append(retry);
    }
    scroll.append(failure); options.positionPopup();
    return failure;
  }
  return {
    scrollElement: scroll, clear, renderResults, renderKanji, renderNotice, renderLookupFailure,
    captureTermView: () => ({ expandAll: true, restoreScrollTop: scroll.scrollTop }),
    currentEntryIndex: () => selected,
    focusEntry(target) {
      if (!entries.length || target.dictionary) return false;
      const next = target === "first" ? 0 : target === "last" ? entries.length - 1 : selected + target.offset;
      selected = Math.max(0, Math.min(entries.length - 1, next));
      entries[selected].scrollIntoView({ block: "nearest" });
      return true;
    },
    setDefinitionBlurState(state) { scroll.dataset.definitionBlur = state; },
    setSourceHighlightEnabled(enabled) {
      highlightEnabled = enabled;
      if (!enabled) sourceHighlighter?.clear();
      else if (activeSource) sourceHighlighter?.apply(activeSource.candidate, activeSource.matched);
    },
    destroy() {
      clear(); scroll.removeEventListener("click", selectEntry);
      scroll.classList.remove("plain-scroll"); delete scroll.dataset.definitionBlur;
    },
  };
}
export default { schema: 2, slug: "plain", contentMode: "text", createView };
