// Definition data directly to text nodes. No headers, metadata or action controls.
// SPDX-License-Identifier: GPL-3.0-or-later
function createView(options) {
  const { document, popup, components, sourceHighlighter } = options;
  const scroll = popup;
  scroll.classList.add("plain-scroll");
  let activeSource, entries = [], selected = 0;
  let highlightEnabled = options.sourceHighlightEnabled;
  const text = value => components.glossaryToPlainText(value);
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
  }
  function renderResults(results, candidate, context = {}) {
    clear();
    for (const result of results) definition(result.term.glossaries.map(glossary => text(glossary.glossary)).join("\n"));
    finish(candidate, results[0]?.matched || candidate?.query, context);
    options.onResultsRendered?.({ audioButtons: [], miningActions: [], lookupStats: null });
  }
  function renderKanji(kanji, candidate, context = {}) {
    clear();
    for (const entry of kanji.entries) definition(text(entry.definitions));
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
