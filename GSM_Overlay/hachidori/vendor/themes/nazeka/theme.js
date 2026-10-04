// Direct popup renderer adapted from wareya/nazeka texthook.js.
// Copyright 2017 wareya; Apache-2.0 (see ATTRIBUTION.md and LICENSE.Apache-2.0).
// Hachidori integration changes: GPL-3.0-or-later.
// SPDX-License-Identifier: GPL-3.0-or-later
function createView(options) {
  const { document, popup, components } = options;
  const scroll = document.createElement("div");
  scroll.className = "nazeka-scroll";
  popup.append(scroll);
  const highlighter = options.sourceHighlighter;
  let highlightEnabled = options.sourceHighlightEnabled;
  let activeSource, entries = [], selected = 0, labels = [];
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const button = (className, text, callback) => {
    const element = node("button", className, text);
    element.type = "button";
    element.addEventListener("click", callback);
    return element;
  };
  if (options.onResizeStart) {
    const resize = node("div", "gsm-hoshidicts-resize-handle");
    resize.title = "Resize popup";
    resize.addEventListener("pointerdown", options.onResizeStart);
    resize.addEventListener("pointermove", options.onResizeMove);
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) resize.addEventListener(event, options.onResizeEnd);
    popup.append(resize);
  }
  function clear() {
    scroll.replaceChildren();
    entries = []; labels = []; selected = 0; activeSource = null;
    highlighter?.clear();
  }
  function finish(candidate, matched, context) {
    activeSource = { candidate, matched };
    if (highlightEnabled) highlighter?.apply(candidate, matched);
    setDefinitionBlurState(context.definitionBlurState ?? "revealed");
    options.positionPopup();
    if (context.restoreScrollTop) scroll.scrollTop = context.restoreScrollTop;
  }
  function navigation(parent, context) {
    if (context.onClose) parent.append(button("gsm-hoshidicts-popup-close", "Close", context.onClose));
    else if (context.onBack) parent.append(button("gsm-hoshidicts-kanji-back", "Back", context.onBack));
  }
  function setDefinitionBlurState(state) { scroll.dataset.definitionBlur = state; }
  function updateDictionaryPresentation(context) {
    const names = new Map((context.dictionaryPresentation ?? []).map(item => [item.title, item.displayName || item.title]));
    for (const label of labels) label.textContent = names.get(label.dataset.dictionary) || label.dataset.dictionary;
  }
  function dictionaryLabel(dictionary) {
    const label = node("span", "nazeka-dictionary", dictionary);
    label.dataset.dictionary = dictionary;
    labels.push(label);
    return label;
  }
  function renderResults(results, candidate, context = {}) {
    clear();
    const audioButtons = [], miningActions = [];
    // Adapted from Nazeka build_div_inner's original-text context.
    const text = results[0]?.matched || candidate?.query || "";
    const moreText = candidate?.sentence || text;
    const index = candidate?.matchOffset || 0;
    let before = moreText.substring(0, index);
    let after = moreText.substring(index + text.length);
    if (before.length > 5) before = "…" + before.substring(before.length - 3);
    if (after.length > 5) after = after.substring(0, 3) + "…";
    const source = node("div", "nazeka-original");
    source.append(document.createTextNode(before), node("strong", "nazeka-lookup", text), document.createTextNode(after));
    navigation(source, context);
    scroll.append(source);
    for (const [index, result] of results.entries()) {
      const term = result.term;
      const entry = node("article", "gsm-hoshidicts-entry");
      entry.tabIndex = -1;
      entry.addEventListener("click", () => { selected = index; });
      const word = node("div", "nazeka-word");
      const expression = node("span", "gsm-hoshidicts-expression nazeka-main-keb");
      expression.setAttribute("aria-label", `${term.expression}, ${term.reading}`);
      for (const character of term.expression) {
        expression.append(/\p{Script=Han}/u.test(character)
          ? button("gsm-hoshidicts-kanji-link", character, event => options.onKanjiClick?.(character, result, candidate, event.currentTarget))
          : document.createTextNode(character));
      }
      word.append(expression);
      if (term.reading && term.reading !== term.expression) {
        word.append(document.createTextNode("《"), node("span", "nazeka-reading", term.reading), document.createTextNode("》"));
      }
      const audio = components.createAudioControl(document, term.expression);
      word.append(audio.element);
      audioButtons.push({ button: audio.button, result });
      const steps = components.deinflectionSteps(result);
      if (steps.length) word.append(node("span", "nazeka-deconj", ` ～${steps.map(step => step.name).join(" → ")}`));
      const ranks = (term.frequencies ?? []).flatMap(group => group.frequencies.map(frequency => frequency.displayValue ?? frequency.value));
      if (ranks.length) word.append(node("span", "nazeka-frequency", ` #${ranks.join(" / ")}`));
      const actions = node("div", "gsm-hoshidicts-entry-actions");
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", "Entry actions");
      const feedback = node("div", "gsm-hoshidicts-anki-feedback");
      feedback.hidden = true;
      miningActions.push({ actions, feedback, result });
      word.append(actions);
      const definitions = node("div", "gsm-hoshidicts-definitions");
      for (const glossary of term.glossaries) {
        const row = node("div", "nazeka-sense");
        const label = dictionaryLabel(glossary.dictionary);
        const tags = glossary.definitionTags ? `(${glossary.definitionTags}) ` : "";
        row.append(label, node("span", "gsm-hoshidicts-glossary-content", ` ${tags}${components.glossaryToPlainText(glossary.glossary)}`));
        definitions.append(row);
      }
      entry.append(word, definitions, feedback);
      entries.push(entry);
      scroll.append(entry);
    }
    updateDictionaryPresentation(context);
    finish(candidate, results[0]?.matched || candidate?.query, context);
    options.onResultsRendered?.({ audioButtons, miningActions, lookupStats: null });
  }
  function renderKanji(kanji, candidate, context = {}) {
    clear();
    navigation(scroll, context);
    scroll.append(node("div", "nazeka-word", kanji.character));
    for (const entry of kanji.entries) {
      const info = node("div", "nazeka-kanji-info");
      info.append(dictionaryLabel(entry.dictionary),
        node("div", "nazeka-reading", [entry.onyomi, entry.kunyomi].flat().filter(Boolean).join(" · ")),
        node("div", "", components.glossaryToPlainText(entry.definitions)),
        node("div", "", (entry.stats ?? []).map(stat => `${stat.name}: ${stat.value}`).join(" · ")));
      scroll.append(info);
    }
    updateDictionaryPresentation(context);
    finish(candidate, context.highlightText || kanji.character, context);
  }
  function renderNotice(message, candidate, context = {}) {
    clear(); navigation(scroll, context);
    const notice = node("div", "gsm-hoshidicts-lookup-notice", message);
    notice.setAttribute("role", "status"); scroll.append(notice);
    finish(candidate, candidate?.query, context);
  }
  function renderLookupFailure(state, { preserveView = false } = {}) {
    if (!preserveView) clear();
    scroll.querySelector(".gsm-hoshidicts-lookup-failure")?.remove();
    const failure = node("div", "gsm-hoshidicts-lookup-failure", `${state.title}: ${state.detail}`);
    failure.setAttribute("role", "alert");
    if (state.onAction) failure.append(button("", state.actionLabel, state.onAction));
    scroll.append(failure); options.positionPopup();
    return failure;
  }
  return {
    scrollElement: scroll, clear, renderResults, renderKanji, renderNotice, renderLookupFailure,
    captureTermView: () => ({ expandAll: true, restoreScrollTop: scroll.scrollTop }),
    currentEntryIndex: () => selected,
    focusEntry(target) {
      if (!entries.length) return false;
      let destination;
      if (target.dictionary) {
        const found = components.findDifferentDictionary(entries, selected, Math.sign(target.dictionary), scroll,
          entry => [...entry.querySelectorAll(".nazeka-sense")],
          row => row.querySelector(".nazeka-dictionary").dataset.dictionary);
        if (!found) return false;
        selected = found.index;
        destination = found.target;
      } else {
        const next = target === "first" ? 0 : target === "last" ? entries.length - 1 : selected + target.offset;
        selected = Math.max(0, Math.min(entries.length - 1, next));
        destination = entries[selected];
      }
      const scale = components.popupCoordinateScale(options.getPageZoom?.() ?? 1, options.getPopupScalePercent?.() ?? 100);
      const top = selected === 0 && destination === entries[0] ? 0
        : (destination.getBoundingClientRect().top - scroll.getBoundingClientRect().top) * scale + scroll.scrollTop;
      scroll.scrollTo({ top, behavior: "instant" });
      return true;
    },
    setDefinitionBlurState, updateDictionaryPresentation,
    setSourceHighlightEnabled(enabled) {
      highlightEnabled = enabled;
      if (!enabled) highlighter?.clear();
      else if (activeSource) highlighter?.apply(activeSource.candidate, activeSource.matched);
    },
    destroy() { clear(); popup.replaceChildren(); },
  };
}
export default { schema: 2, slug: "nazeka", contentMode: "text", createView };
