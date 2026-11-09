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
  // The render's language (docs/themes/README.md, "Languages"). A caller
  // that passes none gets today's Japanese text, which the Japanese
  // language reproduces.
  let language = options.language ?? null;
  const setAttributes = (element, attributes) => {
    for (const [name, value] of Object.entries(attributes ?? {})) element.setAttribute(name, value);
    return element;
  };
  const marked = () => language?.marked === true;
  const label = (name, fallback) => language?.labels?.[name] ?? fallback;
  const slice = (text, start, end) => language ? language.sliceText(text, start, end) : text.substring(start, end);
  // A name alone in an inline element when the language isolates it (10.1).
  function setName(element, name) {
    const attributes = marked() ? language.nameAttributes(name) : {};
    if (Object.keys(attributes).length === 0) element.textContent = name;
    else {
      const inner = setAttributes(document.createElement("span"), attributes);
      inner.textContent = name;
      element.replaceChildren(inner);
    }
  }
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
    for (const label of labels) setName(label, names.get(label.dataset.dictionary) || label.dataset.dictionary);
  }
  function dictionaryLabel(dictionary) {
    const label = node("span", "nazeka-dictionary");
    setName(label, dictionary);
    label.dataset.dictionary = dictionary;
    labels.push(label);
    return label;
  }
  function renderResults(results, candidate, context = {}) {
    clear();
    language = context.language ?? options.language ?? null;
    const audioButtons = [], miningActions = [];
    // Adapted from Nazeka build_div_inner's original-text context. Japanese
    // cuts by UTF-16 units as today; other languages never split a grapheme.
    const text = results[0]?.matched || candidate?.query || "";
    const moreText = candidate?.sentence || text;
    const index = candidate?.matchOffset || 0;
    let before = slice(moreText, 0, index);
    let after = slice(moreText, index + text.length);
    if (before.length > 5) before = "…" + slice(before, before.length - 3);
    if (after.length > 5) after = slice(after, 0, 3) + "…";
    const source = node("div", "nazeka-original");
    // Outside Japanese the bold match is the sentence's own slice, so a match
    // that ends inside a grapheme takes all of it and the excerpt reads whole.
    const lookup = language && language.code !== "ja" && moreText !== text ? slice(moreText, index, index + text.length) : text;
    const excerpt = [document.createTextNode(before), node("strong", "nazeka-lookup", lookup), document.createTextNode(after)];
    if (marked()) {
      // The sentence keeps its own direction; Close and Back stay outside it.
      const sentence = setAttributes(node("span", "nazeka-excerpt"), language.sourceAttributes());
      sentence.append(...excerpt);
      source.append(sentence);
    } else source.append(...excerpt);
    navigation(source, context);
    scroll.append(source);
    for (const [index, result] of results.entries()) {
      const term = result.term;
      const entry = node("article", "gsm-hoshidicts-entry");
      entry.tabIndex = -1;
      entry.addEventListener("click", () => { selected = index; });
      const word = node("div", "nazeka-word");
      const expression = node("span", "gsm-hoshidicts-expression nazeka-main-keb");
      // The displayed forms (10.4); the stored ones stay what is mined.
      const expressionText = language ? language.display(result, "expression") : term.expression;
      const readingText = language ? language.display(result, "reading") : term.reading;
      if (marked()) setAttributes(expression, language.sourceAttributes());
      // Japanese keeps today's label, which repeats a reading equal to the word.
      if (!language || language.code === "ja") expression.setAttribute("aria-label", `${expressionText}, ${readingText}`);
      else {
        const spoken = language.readingFor(result);
        expression.setAttribute("aria-label", spoken ? `${expressionText}, ${spoken}` : expressionText);
      }
      for (const character of expressionText) {
        expression.append((language ? language.isCharacterLink(character) : /\p{Script=Han}/u.test(character))
          ? button("gsm-hoshidicts-kanji-link", character, event => options.onKanjiClick?.(character, result, candidate, event.currentTarget))
          : document.createTextNode(character));
      }
      word.append(expression);
      if (readingText && readingText !== expressionText) {
        const [open, close] = label("readingBrackets", ["《", "》"]);
        const reading = node("span", "nazeka-reading", readingText);
        if (marked()) setAttributes(reading, language.readingAttributes());
        word.append(document.createTextNode(open), reading, document.createTextNode(close));
      }
      const audio = components.createAudioControl(document, term.expression);
      word.append(audio.element);
      audioButtons.push({ button: audio.button, result });
      const steps = components.deinflectionSteps(result);
      if (steps.length) word.append(node("span", "nazeka-deconj", ` ${label("traceMarker", "～")}${steps.map(step => step.name).join(" → ")}`));
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
        // The dictionary's direction and default language hold its row (10.2).
        if (marked()) setAttributes(row, language.glossaryAttributes(glossary.dictionary, result));
        const direction = marked() ? language.dictionaryDirection(glossary.dictionary, result) : "ltr";
        const name = dictionaryLabel(glossary.dictionary);
        const tags = glossary.definitionTags ? `(${glossary.definitionTags}) ` : "";
        row.append(name, node("span", "gsm-hoshidicts-glossary-content",
          ` ${tags}${components.glossaryToPlainText(glossary.glossary, language, { direction })}`));
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
    language = context.language ?? options.language ?? null;
    const miningActions = [];
    navigation(scroll, context);
    const character = node("div", "nazeka-word", kanji.character);
    if (marked()) setAttributes(character, language.sourceAttributes());
    scroll.append(character);
    for (const entry of kanji.entries) {
      const info = node("div", "nazeka-kanji-info");
      info.tabIndex = -1;
      const index = entries.length;
      info.addEventListener("click", () => { selected = index; });
      const direction = marked() ? language.dictionaryDirection(entry.dictionary) : "ltr";
      info.append(dictionaryLabel(entry.dictionary),
        node("div", "nazeka-reading", [entry.onyomi, entry.kunyomi].flat().filter(Boolean).join(" · ")),
        node("div", "", components.glossaryToPlainText(entry.definitions, language, { direction })),
        node("div", "", (entry.stats ?? []).map(stat => `${stat.name}: ${stat.value}`).join(" · ")));
      const actions = node("div", "gsm-hoshidicts-entry-actions");
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", "Kanji actions");
      const feedback = node("div", "gsm-hoshidicts-anki-feedback");
      feedback.hidden = true;
      const result = { ...(language && components.language
        ? components.language.characterEntryResult(kanji.character, entry, language)
        : components.kanjiEntryResult(kanji.character, entry)), generation: context.generation };
      result.term.frequencies = kanji.frequencies ?? [];
      miningActions.push({ actions, feedback, result });
      info.append(actions, feedback);
      entries.push(info);
      scroll.append(info);
    }
    updateDictionaryPresentation(context);
    finish(candidate, context.highlightText || kanji.character, context);
    options.onResultsRendered?.({ audioButtons: [], miningActions, lookupStats: null });
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
