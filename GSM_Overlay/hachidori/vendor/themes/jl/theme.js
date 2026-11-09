// Direct popup renderer following JL's popup: one block per result and
// dictionary, JL's wrapping header line, dictionary tabs and JL's defaults.
// Layout, text formats and default values adapted from rampaa/JL, Apache-2.0
// (see ATTRIBUTION.md and LICENSE.Apache-2.0). No JL source is copied.
// Hachidori integration: GPL-3.0-or-later.
// SPDX-License-Identifier: GPL-3.0-or-later
const HAN = /\p{Script=Han}/u;
// JL brackets a JMdict sense's word classes apart from its other tags. Yomitan
// data has one tag string, so JMdict's part-of-speech codes pick the group.
const WORD_CLASS = /^(?:adj-\w+|adv(?:-to)?|aux(?:-adj|-v)?|conj|cop|ctr|exp|int|n(?:-adv|-pr|-pref|-suf|-t)?|num|pn|pref|prt|suf|unc|v-unspec|v[1-5][\w-]*|v[iknrtz]|vs(?:-[cis])?)$/u;
function tagGroups(value) {
  // Yomitan separates tags with spaces; a no-break space stays inside a tag.
  const tags = String(value || "").split(" ").filter(Boolean);
  return [tags.filter(tag => WORD_CLASS.test(tag)), tags.filter(tag => !WORD_CLASS.test(tag))];
}
const brackets = groups => groups.filter(tags => tags.length).map(tags => `[${tags.join(", ")}]`).join(" ");
// JL shows one frequency per dictionary.
const frequencyValue = ({ frequencies: [first] }) => first.displayValue || String(first.value);
const kanjiTokens = value => Array.isArray(value) ? value : String(value || "").split(/\s+/u).filter(Boolean);

export function createView(options, enhanced = false) {
  const { document, popup, components } = options;
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
  const displayed = (result, field) => language ? language.display(result, field) : result.term[field];
  const label = (name, fallback) => language?.labels?.[name] ?? fallback;
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
  const nameNode = name => {
    const attributes = marked() ? language.nameAttributes(name) : {};
    if (Object.keys(attributes).length === 0) return document.createTextNode(name);
    const inner = setAttributes(document.createElement("span"), attributes);
    inner.textContent = name;
    return inner;
  };
  // A dictionary's direction (10.2) and the text of its rows (11.2).
  const directionOf = (dictionary, result) => marked() ? language.dictionaryDirection(dictionary, result) : "ltr";
  const plainText = (value, direction) => components.glossaryToPlainText(value, language, { direction });
  // A marked language comes from the theme host, with components.language.
  const paragraph = (text, direction) => marked() ? components.language.isolateParagraph(language, text, direction) : text;
  const header = node("div", "jl-header");
  // JL's title row carries the x; the dictionary tabs sit below it.
  const nav = node("div", "jl-nav");
  const tabs = node("div", "jl-tabs");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", enhanced ? "Dictionary groups" : "Dictionaries");
  header.append(nav, tabs);
  const scroll = node("div", "jl-scroll");
  popup.append(header, scroll);
  if (options.onResizeStart) {
    const resize = node("div", "gsm-hoshidicts-resize-handle");
    resize.title = "Resize popup";
    resize.addEventListener("pointerdown", options.onResizeStart);
    resize.addEventListener("pointermove", options.onResizeMove);
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) resize.addEventListener(event, options.onResizeEnd);
    popup.append(resize);
  }
  const highlighter = options.sourceHighlighter;
  let highlightEnabled = options.sourceHighlightEnabled;
  // Bee enlarges a hovered or focused glossary image with Default's preview.
  const preview = enhanced ? components.createImagePreview({ document, window: options.window, popup,
    getCoordinateScale: () => components.popupCoordinateScale(options.getPageZoom?.() ?? 1, options.getPopupScalePercent?.() ?? 100),
    getImageHoverPreview: options.getImageHoverPreview, scrollBounds: () => scroll }) : null;
  let activeSource, entries = [], bindings = [], selected = 0, labels = [], frequencies = [], markers = [], tab = null, onTabSelected = null;
  let tools = [], groupTabs = [], groupContext = null, availableDictionaries = [], revision = 0;
  // Design's pitch switch and dictionary, as the markers were last painted.
  let paintedPitch = "";
  let paintedFrequency = "";
  const frequencyDictionaries = new Set(), pitchByTerm = new Map();
  const pitchOptions = context => JSON.stringify([context.showPitchAccentFurigana !== false, context.pitchAccentFuriganaDictionary ?? "",
    enhanced ? context.pitchAccentFuriganaStyle ?? "contour" : "contour"]);
  let customButtons = options.customButtons || [];
  const images = new Set();
  let pendingPresentation = null;
  const shown = () => entries.filter(entry => !entry.hidden);

  function closeActionMenu(restoreFocus = true) {
    const open = [...popup.querySelectorAll(".bee-more-actions[open]")];
    for (const more of open) more.open = false;
    if (restoreFocus) open.at(-1)?.querySelector("summary").focus({ preventScroll: true });
    return open.length > 0;
  }
  function onMenuPointerDown(event) {
    const path = event.composedPath();
    // Document capture cannot see the production host's closed shadow tree.
    // Its own root handles presses within that host, including sibling panes.
    if (event.currentTarget === document && path.includes(popup.getRootNode().host)) return;
    for (const more of popup.querySelectorAll(".bee-more-actions[open]")) {
      if (!path.includes(more)) more.open = false;
    }
  }
  const menuRoot = popup.getRootNode();
  if (enhanced) {
    document.addEventListener("pointerdown", onMenuPointerDown, true);
    if (menuRoot !== document) menuRoot.addEventListener("pointerdown", onMenuPointerDown, true);
  }

  function clear() {
    revision += 1;
    for (const control of tools) control.close(false);
    tools = []; images.clear(); groupTabs = []; groupContext = null; availableDictionaries = []; pendingPresentation = null;
    tabs.replaceChildren(); nav.replaceChildren(); scroll.replaceChildren();
    // JL shows each render from the top. Resetting here, before the new
    // content exists, keeps the reset from laying that content out.
    if (!enhanced) scroll.scrollTop = 0;
    entries = []; bindings = []; labels = []; frequencies = []; markers = []; selected = 0; tab = null; onTabSelected = null; activeSource = null;
    paintedFrequency = ""; frequencyDictionaries.clear(); pitchByTerm.clear();
    highlighter?.clear();
    preview?.hideImagePreview();
  }
  function finish(candidate, matched, context) {
    activeSource = { candidate, matched };
    if (highlightEnabled) highlighter?.apply(candidate, matched);
    setDefinitionBlurState(context.definitionBlurState ?? "revealed");
    options.positionPopup();
    if (context.restoreScrollTop) scroll.scrollTop = context.restoreScrollTop;
  }
  function navigation(context) {
    if (enhanced && context.onBack) nav.append(button("gsm-hoshidicts-kanji-back", "Back", context.onBack));
    if (context.onClose) {
      const close = button("gsm-hoshidicts-popup-close", "x", context.onClose);
      close.title = "Close";
      close.setAttribute("aria-label", "Close");
      nav.append(close);
    } else if (!enhanced && context.onBack) nav.append(button("gsm-hoshidicts-kanji-back", "Back", context.onBack));
  }
  function setDefinitionBlurState(state) { scroll.dataset.definitionBlur = state; }
  function dictionaryLabel(dictionary) {
    const label = node("span", "jl-dictionary", null);
    setName(label, dictionary);
    label.dataset.dictionary = dictionary;
    labels.push(label);
    return label;
  }
  function updateDictionaryPresentation(context, notify = true) {
    const names = new Map((context.dictionaryPresentation ?? []).map(item => [item.title, item.displayName || item.title]));
    const name = dictionary => names.get(dictionary) || dictionary;
    for (const label of labels) {
      const displayName = name(label.dataset.dictionary);
      if (!enhanced || label.textContent !== displayName) setName(label, displayName);
      if (enhanced && label.title !== displayName) label.title = displayName;
    }
    // JL: "#rank" with one frequency dictionary, "Name: rank, …" with several.
    if (enhanced) {
      // Lookup data stays fixed for this view. Only these presentation inputs
      // affect its frequency chips; pitch/group changes leave the DOM intact.
      const frequency = JSON.stringify([context.averageFrequency === true,
        context.showFrequencyDictionaryNames === true, context.compactFrequencyNumbers === true,
        (context.dictionaryPresentation ?? []).filter(item => frequencyDictionaries.has(item.title))
          .map(({ title, displayName, frequencyMode }) => [title, displayName, frequencyMode])]);
      if (frequency !== paintedFrequency) {
        const tagsByResult = new Map();
        for (const { element, result } of frequencies) {
          let tags = tagsByResult.get(result);
          if (tags) tags = tags.map(tag => tag.cloneNode(true));
          else {
            tags = components.createFrequencyTags(document, result, context.dictionaryPresentation ?? [], Infinity,
              context.averageFrequency === true, context.showFrequencyDictionaryNames === true, context.compactFrequencyNumbers === true,
              false, language);
            tagsByResult.set(result, tags);
          }
          element.replaceChildren(...tags);
        }
        paintedFrequency = frequency;
      }
    } else if (marked()) {
      // Each entry is its own name and value, so a value stays beside its name.
      for (const { element, groups } of frequencies) {
        if (groups.length === 1) {
          element.textContent = `#${frequencyValue(groups[0])}`;
          continue;
        }
        element.replaceChildren(...groups.flatMap((group, index) => [
          ...(index > 0 ? [", "] : []), nameNode(name(group.dictionary)), `: ${frequencyValue(group)}`]));
      }
    } else {
      for (const { element, groups } of frequencies) element.textContent = groups.length === 1 ? `#${frequencyValue(groups[0])}`
        : groups.map(group => `${name(group.dictionary)}: ${frequencyValue(group)}`).join(", ");
    }
    // Markers hold no controls, so a pitch option change repaints them in place
    // without moving focus or touching an open Note draft.
    const pitch = pitchOptions(context);
    if (pitch !== paintedPitch) {
      paintedPitch = pitch;
      pitchByTerm.clear();
      for (const marker of markers) paintPitch(marker, context);
    }
    if (enhanced) {
      for (const image of images) image.updatePresentation(context);
      if (groupContext) {
        if (tools.some(control => control.form && !control.form.hidden) || options.canProjectDictionaryPresentation?.() === false) {
          pendingPresentation = context;
          return;
        }
        groupContext = { ...groupContext, ...context };
        renderGroupTabs(availableDictionaries, groupContext, notify);
      }
    }
  }
  function flushDictionaryPresentation() {
    if (!pendingPresentation) return;
    const context = pendingPresentation; pendingPresentation = null;
    updateDictionaryPresentation(context);
  }

  function addTools(parent, host, prefill, context) {
    const control = components.createLookupActions({ ...options, customButtons,
      idPrefix: `${options.idPrefix || "bee"}-${tools.length}`,
      readPrefill: () => prefill, renderContext: context,
      onNoteEditingChange(editing) {
        if (editing) for (const other of tools) if (other !== control) other.close(false);
        options.onNoteEditingChange?.(editing);
      },
      onFormCreated(form) { host.insertBefore(form, host.children[1] || null); options.positionPopup(); },
      onClose: flushDictionaryPresentation,
      onButtonsUpdated(actions, buttons) {
        for (const [index, custom] of buttons.entries()) {
          // Inline icons reuse the shared label; More keeps its visible label.
          const label = custom.firstElementChild;
          let icon = custom.querySelector(".bee-custom-action-icon");
          if (index < 2) {
            if (icon && icon !== label) icon.remove();
            icon = label;
          } else if (icon === label) {
            label.classList.remove("bee-custom-action-icon", "hd-icon");
            label.removeAttribute("aria-hidden");
            delete label.dataset.icon;
            icon = null;
          }
          if (!icon) {
            icon = node("span", "bee-custom-action-icon hd-icon");
            custom.append(icon);
          }
          icon.classList.add("bee-custom-action-icon", "hd-icon");
          icon.setAttribute("aria-hidden", "true");
          icon.dataset.icon = custom.dataset.customButtonType === "anki" ? "document-add" : "open";
          if (custom.dataset.customButtonType === "link") {
            custom.title = `Open ${custom.dataset.customButtonLabel}`;
            custom.setAttribute("aria-label", custom.title);
          }
        }
        actions.querySelector(".bee-more-actions")?.remove();
        if (buttons.length <= 2) return;
        const more = node("details", "bee-more-actions");
        const summary = node("summary", "", "⋯");
        summary.setAttribute("aria-label", "More actions");
        const menu = node("div", "bee-action-menu");
        // Shared link actions stop bubbling. Capture their activation and
        // dismiss after the action handler runs, keeping its normal semantics.
        const dismiss = event => {
          if (event.button !== (event.type === "auxclick" ? 1 : 0) || !event.target.closest("button")) return;
          queueMicrotask(() => { if (more.isConnected) { more.open = false; summary.focus({ preventScroll: true }); } });
        };
        menu.addEventListener("click", dismiss, true);
        menu.addEventListener("auxclick", dismiss, true);
        menu.append(...buttons.slice(2)); more.append(summary, menu); actions.append(more);
      },
    });
    tools.push(control);
    parent.append(control.actions);
    return control;
  }

  function termPrefill(result, candidate) {
    const exact = candidate?.exactSelection === true;
    return { term: exact ? candidate.query : result.term.expression,
      reading: !exact || candidate.query === result.term.expression ? result.term.reading || "" : "",
      definition: "", sentence: candidate?.sentence || "" };
  }

  // Bee shows only the structured glossary: no JL text, tag brackets or disclosure.
  function formattedDefinition(parent, rows, dictionary, context, owner, result = null) {
    const content = node("div", "gsm-hoshidicts-glossary-content bee-rich-content");
    content.dataset.hoshidictsDictionary = dictionary;
    // The dictionary's direction and default language hold its block (10.2).
    if (marked()) setAttributes(content, language.glossaryAttributes(dictionary, result));
    const rendering = marked() ? { language, direction: directionOf(dictionary, result) } : {};
    parent.append(content);
    const ownRevision = revision;
    const isCurrent = () => ownRevision === revision && owner.isConnected
      && context.isCurrentRequest?.() !== false;
    try {
      for (const row of rows) {
        const rowContent = node("div", "bee-rich-row");
        content.append(rowContent);
        options.appendTextOnlyGlossary(document, rowContent, row.glossary, {
          dictionary, generation: context.generation, isCurrent,
          isCurrentLink: () => ownRevision === revision && owner.isConnected && !owner.hidden
            && (context.isCurrentView || context.isCurrentRequest)?.() !== false,
          onExternalLink: context.onExternalLink, onInternalLink: context.onInternalLink,
          resolveMedia: context.resolveMedia, imageContext: context,
          onImageCreated: image => images.add(image), onLayoutChange: options.positionPopup,
          requestImagePreview: preview.requestImagePreview, refreshImagePreview: preview.refreshImagePreview,
          hideImagePreview: preview.hideImagePreview, ...rendering,
        });
      }
    } catch (error) {
      content.replaceChildren(node("div", "gsm-hoshidicts-lookup-failure", `Could not render definition: ${error.message}`));
    }
  }

  // The first pitch accent that fits the text, preferring Design's pitch dictionary.
  function pitchMorae(text, groups, preferred) {
    const ordered = [...groups.filter(group => group.dictionary === preferred),
      ...groups.filter(group => group.dictionary !== preferred)];
    for (const group of ordered) {
      for (const pitch of group.pitches) {
        const morae = components.buildPitchAccentMorae(text, components.pitchAccentPositions(pitch));
        if (morae) return morae;
      }
    }
    return null;
  }
  // JL's marker: a line over high morae and under low ones, joined where the pitch changes.
  function appendMorae(parent, morae) {
    for (const mora of morae) {
      const span = node("span", "jl-mora", mora.text);
      span.dataset.pitch = mora.level;
      if (mora.transition) span.dataset.transition = mora.transition;
      parent.append(span);
    }
  }
  function paintPitch({ element, text, term }, context) {
    const morae = enhanced && pitchByTerm.has(term) ? pitchByTerm.get(term)
      : context.showPitchAccentFurigana === false ? null
        : pitchMorae(text, term.pitches ?? [], context.pitchAccentFuriganaDictionary);
    if (enhanced) pitchByTerm.set(term, morae);
    element.textContent = morae ? "" : text;
    if (enhanced) element.dataset.pitchStyle = context.pitchAccentFuriganaStyle === "overline" ? "overline" : "contour";
    if (morae) appendMorae(element, morae);
  }
  // Painted while its block is still detached; updateDictionaryPresentation repaints it.
  function pitchMarker(element, text, term, context) {
    const marker = { element, text, term };
    markers.push(marker);
    paintPitch(marker, context);
    return element;
  }
  function spelling(result, candidate) {
    const element = node("span", "gsm-hoshidicts-expression jl-spelling");
    if (marked()) setAttributes(element, language.sourceAttributes());
    const isLink = language ? character => language.isCharacterLink(character) : character => HAN.test(character);
    for (const character of displayed(result, "expression")) {
      element.append(isLink(character)
        ? button("gsm-hoshidicts-kanji-link", character, event => options.onKanjiClick?.(character, result, candidate, event.currentTarget))
        : document.createTextNode(character));
    }
    return element;
  }
  // JL's order: spelling, reading, audio, deconjugation, frequencies, dictionary, Anki.
  function topLine(result, dictionary, candidate, context) {
    const term = result.term;
    const line = node("div", "jl-top");
    // The displayed forms (10.4); the stored ones stay what is mined.
    const expressionText = displayed(result, "expression"), readingText = displayed(result, "reading");
    const reading = readingText && readingText !== expressionText ? readingText : "";
    const expression = spelling(result, candidate);
    line.append(expression);
    if (reading) {
      const readingElement = node("span", "jl-reading");
      if (marked()) setAttributes(readingElement, language.readingAttributes());
      line.append(pitchMarker(readingElement, reading, term, context));
    }
    // Without a reading JL marks the spelling itself, which only works for kana
    // and only a language with pitch accent has.
    else if ((language?.capabilities.pitchAccent ?? true) && !HAN.test(expressionText)) {
      pitchMarker(expression, expressionText, term, context);
    }
    const audio = components.createAudioControl(document, term.expression);
    // JL puts audio after the reading; Bee groups it with the Anki and pencil buttons.
    if (!enhanced) line.append(audio.element);
    const steps = components.deinflectionSteps(result);
    const matched = result.matched || "";
    const process = steps.length ? `${label("traceMarker", "～")}${steps.map(step => step.name).join("→")}` : "";
    // JL shows the matched text, then any deconjugation, unless it is just the word.
    if (process || (matched && matched !== expressionText && matched !== readingText)) {
      if (marked() && matched) {
        // The matched form keeps its own direction inside the English trail.
        const deconjugation = node("span", "jl-deconj");
        const form = setAttributes(document.createElement("span"), language.sourceAttributes());
        form.textContent = matched;
        deconjugation.append(form, ...(process ? [` ${process}`] : []));
        line.append(deconjugation);
      } else line.append(node("span", "jl-deconj", [matched, process].filter(Boolean).join(" ")));
    }
    const groups = (term.frequencies ?? []).filter(group => group.frequencies.length);
    if (enhanced) for (const group of groups) frequencyDictionaries.add(group.dictionary);
    if (groups.length) {
      const element = node("span", "jl-frequency");
      frequencies.push({ element, groups, result });
      line.append(element);
    }
    const actions = node("div", "gsm-hoshidicts-entry-actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Entry actions");
    if (enhanced) actions.append(audio.element);
    if (enhanced) {
      const sourceActions = node("div", "bee-source-actions");
      sourceActions.append(dictionaryLabel(dictionary), actions); line.append(sourceActions);
    } else line.append(dictionaryLabel(dictionary), actions);
    return { line, audio, actions };
  }
  // JL joins one sense's glosses with "; ". Structured rows keep the text layout.
  function rowText(glossary, direction) {
    let value;
    try { value = JSON.parse(glossary); } catch { return paragraph(glossary, direction); }
    return Array.isArray(value) && value.every(item => typeof item === "string")
      ? paragraph(value.join(label("senseSeparator", "; ")).trim(), direction) : plainText(value, direction);
  }
  // JL's JMdict layout: a tag group every row shares leads on its own line, then numbered rows.
  function definitionText(rows, direction) {
    const items = rows.map(row => ({ groups: tagGroups(row.definitionTags), text: rowText(row.glossary, direction) }));
    if (items.length === 1) return [brackets(items[0].groups), items[0].text].filter(Boolean).join(" ");
    const shared = items[0].groups.map((tags, group) => tags.length > 0
      && items.every(item => item.groups[group].join(" ") === tags.join(" ")));
    const lines = items.map((item, index) => {
      const own = brackets(item.groups.map((tags, group) => shared[group] ? [] : tags));
      return `${index + 1}. ${own ? `${own} ` : ""}${item.text}`;
    });
    const common = brackets(items[0].groups.filter((_, group) => shared[group]));
    return (common ? [common, ...lines] : lines).join("\n");
  }
  function appendBlock(result, dictionary, rows, candidate, context) {
    // Actions on a block mine and play only its own dictionary, as in JL.
    const projected = rows.length === result.term.glossaries.length ? result
      : { ...result, term: { ...result.term, glossaries: rows } };
    const entry = node("article", "gsm-hoshidicts-entry jl-entry");
    entry.tabIndex = -1;
    entry.dataset.dictionary = dictionary;
    const index = entries.length;
    entry.addEventListener("click", () => { selected = index; });
    const { line, audio, actions } = topLine(result, dictionary, candidate, context);
    const definitions = node("div", "gsm-hoshidicts-definitions");
    const feedback = node("div", "gsm-hoshidicts-anki-feedback");
    feedback.hidden = true;
    entry.append(line, definitions, feedback);
    entries.push(entry);
    bindings.push({ audio: { button: audio.button, result: projected }, mining: { actions, feedback, result: projected } });
    // Media ownership checks need the block attached before its images are requested.
    scroll.append(entry);
    // The dictionary's direction and default language hold its block (10.2).
    const direction = directionOf(dictionary, projected);
    if (enhanced) {
      addTools(actions, entry, termPrefill(result, candidate), context);
      formattedDefinition(definitions, rows, dictionary, context, entry, projected);
    } else {
      if (marked()) setAttributes(definitions, language.glossaryAttributes(dictionary, projected));
      definitions.append(node("div", "gsm-hoshidicts-glossary-content", definitionText(rows, direction)));
    }
  }
  // Like Default's tabs, core binds only the blocks the selected tab shows, so
  // keybinds and autoplay follow the tab.
  function shownBindings() {
    const bound = bindings.filter((_, index) => !entries[index].hidden);
    return { audioButtons: bound.flatMap(item => item.audio ? [item.audio] : []), miningActions: bound.map(item => item.mining) };
  }
  // Tabs only hide blocks, so switching needs no render.
  function selectTab(dictionary, notify) {
    tab = dictionary;
    for (const element of tabs.children) element.setAttribute("aria-pressed", String((element.dataset.dictionary ?? null) === dictionary));
    for (const entry of entries) entry.hidden = dictionary !== null && entry.dataset.dictionary !== dictionary;
    selected = Math.max(0, entries.findIndex(entry => !entry.hidden));
    if (!notify) return;
    scroll.scrollTop = 0;
    onTabSelected?.(dictionary === null ? null : { dictionary });
    options.onResultsExpanded?.(shownBindings());
  }
  function renderTabs(dictionaries, context) {
    if (enhanced) {
      groupContext = context; availableDictionaries = dictionaries;
      tab = context.selectedDictionaryTab?.groupId ? { groupId: context.selectedDictionaryTab.groupId } : null;
      renderGroupTabs(dictionaries, context);
      return;
    }
    const all = button("jl-tab", "All", () => selectTab(null, true));
    all.title = "All dictionaries";
    tabs.append(all);
    for (const dictionary of dictionaries) {
      const element = button("jl-tab", dictionary, () => selectTab(dictionary, true));
      element.dataset.dictionary = dictionary;
      element.title = dictionary;
      labels.push(element);
      tabs.append(element);
    }
    const requested = context.selectedDictionaryTab?.dictionary;
    selectTab(dictionaries.includes(requested) ? requested : null, false);
  }

  function selectGroup(descriptor, notify) {
    const filtered = !!descriptor?.groupId;
    if (notify || entries.some(entry => entry.hidden !== (filtered && !descriptor.dictionaries.has(entry.dataset.dictionary)))) {
      closeActionMenu(false);
    }
    tab = filtered ? { groupId: descriptor.groupId } : null;
    for (const element of tabs.children) element.setAttribute("aria-pressed", String(element.dataset.groupId === descriptor?.groupId));
    for (const entry of entries) entry.hidden = filtered && !descriptor.dictionaries.has(entry.dataset.dictionary);
    selected = Math.max(0, entries.findIndex(entry => !entry.hidden));
    if (notify) {
      scroll.scrollTop = 0;
      onTabSelected?.(tab);
      options.onResultsExpanded?.(shownBindings());
    }
  }
  function renderGroupTabs(dictionaries, context, notify = false) {
    const descriptors = components.createDictionaryTabs(dictionaries, context).tabs.filter(item => item.key === "all" || item.groupId);
    const selectedGroup = tab?.groupId;
    const active = descriptors.find(item => item.groupId === selectedGroup) || descriptors[0];
    const previous = JSON.stringify(groupTabs.map(item => [item.groupId, item.label, [...item.dictionaries]]));
    const next = JSON.stringify(descriptors.map(item => [item.groupId, item.label, [...item.dictionaries]]));
    if (previous !== next) {
      const focused = popup.getRootNode().activeElement;
      const focusedTab = focused && tabs.contains(focused);
      tabs.replaceChildren();
      for (const descriptor of descriptors) {
        const element = button("jl-tab", descriptor.label, () => selectGroup(descriptor, true));
        if (marked()) setName(element, descriptor.label);
        if (descriptor.groupId) element.dataset.groupId = descriptor.groupId;
        element.title = descriptor.title;
        tabs.append(element);
      }
      groupTabs = descriptors;
      if (focusedTab) {
        const replacement = [...tabs.children].find(element => element.dataset.groupId === focused.dataset.groupId)
          || tabs.firstElementChild || entries.find(entry => !entry.hidden);
        replacement?.focus({ preventScroll: true });
      }
    }
    const changed = tab?.groupId !== active?.groupId;
    selectGroup(active, false);
    if (changed) onTabSelected?.(tab);
    if (notify) options.onResultsExpanded?.(shownBindings());
  }

  function renderResults(results, candidate, context = {}) {
    clear();
    language = context.language ?? options.language ?? null;
    paintedPitch = pitchOptions(context);
    onTabSelected = context.onDictionaryTabSelected;
    const found = [];
    for (const result of results) {
      for (const [dictionary, rows] of Map.groupBy(result.term.glossaries, glossary => glossary.dictionary)) {
        if (!found.includes(dictionary)) found.push(dictionary);
        appendBlock(result, dictionary, rows, candidate, context);
      }
    }
    // Tabs follow the dictionary order in Settings, like JL's priority order.
    const order = (context.dictionaryPresentation ?? []).map(item => item.title);
    renderTabs([...order.filter(title => found.includes(title)), ...found.filter(title => !order.includes(title))], context);
    navigation(context);
    updateDictionaryPresentation(context, false);
    finish(candidate, results[0]?.matched || candidate?.query, context);
    options.onResultsRendered?.({ ...shownBindings(), lookupStats: null });
  }
  // JL's kanji text: meanings, then labelled readings and statistics.
  function renderKanji(kanji, candidate, context = {}) {
    clear();
    language = context.language ?? options.language ?? null;
    navigation(context);
    for (const entry of kanji.entries) {
      // Bee shows the structured meanings; JL shows them as text.
      const lines = enhanced ? [] : [plainText(entry.definitions, directionOf(entry.dictionary))];
      for (const [name, value] of [[label("onyomi", "On"), entry.onyomi], [label("kunyomi", "Kun"), entry.kunyomi]]) {
        const readings = kanjiTokens(value);
        if (readings.length) lines.push(`${name}: ${readings.join(label("readingSeparator", "、"))}`);
      }
      if (entry.stats?.length) lines.push("Statistics:", ...entry.stats.map(stat => `${stat.name}: ${stat.value}`));
      const block = node("article", "jl-entry jl-kanji");
      block.tabIndex = -1;
      const index = entries.length;
      block.addEventListener("click", () => { selected = index; });
      const line = node("div", "jl-top");
      const kanjiWord = node("span", "jl-spelling", kanji.character);
      if (marked()) setAttributes(kanjiWord, language.sourceAttributes());
      const sourceActions = enhanced ? node("div", "bee-source-actions") : line;
      const actions = node("div", "gsm-hoshidicts-entry-actions");
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", "Kanji actions");
      const feedback = node("div", "gsm-hoshidicts-anki-feedback");
      feedback.hidden = true;
      const result = { ...(language && components.language
        ? components.language.characterEntryResult(kanji.character, entry, language)
        : components.kanjiEntryResult(kanji.character, entry)), generation: context.generation };
      result.term.frequencies = kanji.frequencies ?? [];
      line.append(kanjiWord);
      if (enhanced) line.append(sourceActions);
      sourceActions.append(dictionaryLabel(entry.dictionary), actions);
      block.append(line, feedback);
      scroll.append(block);
      block.dataset.dictionary = entry.dictionary;
      entries.push(block);
      bindings.push({ mining: { actions, feedback, result } });
      if (enhanced) {
        addTools(actions, block, { term: kanji.character, reading: "", definition: "", sentence: candidate?.sentence || "" }, context);
        formattedDefinition(block, [{ glossary: JSON.stringify(entry.definitions) }], entry.dictionary, context, block);
      }
      block.append(node("div", "jl-kanji-text", lines.filter(Boolean).join("\n")));
    }
    if (enhanced) {
      onTabSelected = context.onDictionaryTabSelected;
      renderTabs([...new Set(kanji.entries.map(entry => entry.dictionary))], context);
    }
    updateDictionaryPresentation(context, false);
    finish(candidate, context.highlightText || kanji.character, context);
    options.onResultsRendered?.({ ...shownBindings(), lookupStats: null });
  }
  function renderNotice(message, candidate, context = {}) {
    clear(); navigation(context);
    language = context.language ?? options.language ?? null;
    const notice = node("div", "gsm-hoshidicts-lookup-notice", message);
    notice.setAttribute("role", "status"); scroll.append(notice);
    if (enhanced) addTools(nav, scroll, { term: candidate?.query || "", reading: "", definition: "", sentence: candidate?.sentence || "" }, context);
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
    captureTermView: () => ({ expandAll: true, restoreScrollTop: scroll.scrollTop,
      selectedDictionaryTab: enhanced ? tab : tab === null ? null : { dictionary: tab } }),
    currentEntryIndex: () => Math.max(0, shown().indexOf(entries[selected])),
    focusEntry(target) {
      const visible = shown();
      if (!visible.length) return false;
      let position = Math.max(0, visible.indexOf(entries[selected]));
      if (target.dictionary) {
        const found = components.findDifferentDictionary(visible, position, Math.sign(target.dictionary), scroll,
          entry => [entry], entry => entry.dataset.dictionary);
        if (!found) return false;
        position = found.index;
      } else {
        let next = position + target.offset;
        if (target === "first") next = 0;
        else if (target === "last") next = visible.length - 1;
        position = Math.max(0, Math.min(visible.length - 1, next));
      }
      selected = entries.indexOf(visible[position]);
      const scale = components.popupCoordinateScale(options.getPageZoom?.() ?? 1, options.getPopupScalePercent?.() ?? 100);
      const top = position === 0 ? 0
        : (visible[position].getBoundingClientRect().top - scroll.getBoundingClientRect().top) * scale + scroll.scrollTop;
      scroll.scrollTo({ top, behavior: "instant" });
      return true;
    },
    setDefinitionBlurState, updateDictionaryPresentation, flushDictionaryPresentation,
    hideImagePreview() { preview?.hideImagePreview(); },
    closeNoteForm() { return tools.some(control => control.close()); },
    closeActionMenu,
    setCustomButtons(value) {
      customButtons = value || [];
      for (const control of tools) control.setCustomButtons(customButtons);
      if (enhanced) options.positionPopup();
    },
    setSourceHighlightEnabled(enabled) {
      highlightEnabled = enabled;
      if (!enabled) highlighter?.clear();
      else if (activeSource) highlighter?.apply(activeSource.candidate, activeSource.matched);
    },
    destroy() {
      clear(); document.removeEventListener("pointerdown", onMenuPointerDown, true);
      menuRoot.removeEventListener("pointerdown", onMenuPointerDown, true);
      preview?.destroy(); popup.replaceChildren();
    },
  };
}
export default { schema: 2, slug: "jl", contentMode: "text", createView };
