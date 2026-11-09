// Crystal: theme idea 5 of bee-san/hachidori-themes#24 as a direct renderer.
// Each result has one header (spelling, reading with pitch, deinflection and
// frequencies), then a framed section per dictionary. Every section has its
// own audio, Anki and Note controls, as in Bee's Theme; the first section's
// sit at the end of the header.
// SPDX-License-Identifier: GPL-3.0-or-later
const HAN = /\p{Script=Han}/u;
// Circled numbers that monolingual dictionaries write into their text.
const CIRCLED = /([\u2460-\u2473\u24EA\u24F5-\u24FE\u2776-\u2793\u3251-\u325F\u32B1-\u32BF])/u;
const SHOW_TEXT = 4;
const kanjiTokens = value => Array.isArray(value) ? value : String(value || "").split(/\s+/u).filter(Boolean);
// Yomitan separates tags with spaces; a no-break space stays inside a tag.
const tagNames = value => String(value || "").split(" ").filter(Boolean);
// Otherwise the first popup waits for the serif faces and its SVG ornaments:
// a cold hover took 68 ms in Hachidori's hover benchmark, against Bee's 17 ms.
// When the top frame loads the theme, measuring a few characters in the serif
// stack loads the faces (1-4 ms) and decoding theme.css's ornaments prepares
// them; the cold hover then takes the same frame as Bee's. SERIF is theme.css's
// --crystal-serif, whose Japanese families --crystal-mincho shares.
const SERIF = `"Noto Serif", "Source Serif 4", "Source Serif Pro", Georgia, Cambria, "Times New Roman",
  "Noto Serif CJK JP", "Noto Serif JP", "Source Han Serif JP", "Yu Mincho", YuMincho, "Hiragino Mincho ProN",
  "BIZ UDPMincho", "MS PMincho", serif`;
// Held for the page's lifetime so the decoded ornaments stay cached.
const ORNAMENTS = [];
if (globalThis.top === globalThis && typeof OffscreenCanvas === "function") {
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  for (const weight of [400, 600]) {
    context.font = `${weight} 16px ${SERIF}`;
    context.measureText("食べる たべる Aa");
  }
  fetch(new URL("theme.css", import.meta.url)).then(response => response.text()).then(css => {
    for (const [, uri] of css.matchAll(/url\("(data:image\/svg\+xml,[^"]*)"\)/gu)) {
      const image = new Image();
      image.src = uri;
      image.decode().catch(() => {});
      ORNAMENTS.push(image);
    }
  }).catch(() => {});
}

export function createView(options) {
  const { document, popup, components } = options;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const button = (className, text, callback) => {
    const element = node("button", className, text);
    element.type = "button";
    element.addEventListener("click", callback);
    return element;
  };
  const ornament = className => {
    const element = node("span", className);
    element.setAttribute("aria-hidden", "true");
    return element;
  };
  // The render's language (docs/themes/README.md, "Languages"). A caller
  // that passes none gets today's Japanese text, which the Japanese
  // language reproduces.
  let language = options.language ?? null;
  // Another language warms its own sample in the serif stack (11.6).
  if (language && language.code !== "ja" && language.sampleText && globalThis.top === globalThis
      && typeof OffscreenCanvas === "function") {
    const context = new OffscreenCanvas(1, 1).getContext("2d");
    for (const weight of [400, 600]) {
      context.font = `${weight} 16px ${SERIF}`;
      context.measureText(language.sampleText);
    }
  }
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
  const directionOf = (dictionary, result) => marked() ? language.dictionaryDirection(dictionary, result) : "ltr";
  // Spacing opens gaps in joined letters, so such a language gets none, and
  // plain glosses are joined with the language's sense separator (11.6).
  const setJoinedScript = () => {
    const joined = language?.typography?.joinedScript === true;
    header.classList.toggle("crystal-joined", joined);
    scroll.classList.toggle("crystal-joined", joined);
    const separator = language?.labels?.senseSeparator?.trim();
    if (separator && separator !== ";") scroll.style.setProperty("--crystal-sense-separator", JSON.stringify(separator));
    else scroll.style.removeProperty("--crystal-sense-separator");
  };
  const header = node("div", "crystal-header");
  const nav = node("div", "crystal-nav");
  const tabs = node("div", "crystal-tabs");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Dictionary groups");
  header.append(nav, tabs);
  const scroll = node("div", "crystal-scroll");
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
  const coordinateScale = () => components.popupCoordinateScale(options.getPageZoom?.() ?? 1, options.getPopupScalePercent?.() ?? 100);
  // A hovered or focused glossary image is enlarged beside the popup, as in Default.
  const preview = components.createImagePreview({ document, window: options.window, popup,
    getCoordinateScale: coordinateScale, getImageHoverPreview: options.getImageHoverPreview, scrollBounds: () => scroll });
  // blocks: one per result and dictionary, the entries keybinds index.
  // heads: one per result, with the blocks it introduces.
  let activeSource, blocks = [], bindings = [], heads = [], selected = 0, tab = null, onTabSelected = null;
  let labels = [], markers = [], tools = [], groupTabs = [], groupContext = null, availableDictionaries = [];
  let revision = 0, pendingPresentation = null, paintedPitch = "", paintedFrequency = "";
  const frequencyDictionaries = new Set(), pitchByTerm = new Map(), images = new Set();
  let customButtons = options.customButtons || [];
  const pitchOptions = context => JSON.stringify([context.showPitchAccentFurigana !== false,
    context.pitchAccentFuriganaDictionary ?? "", context.pitchAccentFuriganaStyle === "overline" ? "overline" : "contour"]);
  const shown = () => blocks.filter(block => !block.hidden);

  function closeActionMenu(restoreFocus = true) {
    const open = [...popup.querySelectorAll(".crystal-more-actions[open]")];
    for (const more of open) more.open = false;
    if (restoreFocus) open.at(-1)?.querySelector("summary").focus({ preventScroll: true });
    return open.length > 0;
  }
  function onMenuPointerDown(event) {
    const path = event.composedPath();
    // Document capture cannot see the production host's closed shadow tree.
    // Its own root handles presses within that host.
    if (event.currentTarget === document && path.includes(popup.getRootNode().host)) return;
    for (const more of popup.querySelectorAll(".crystal-more-actions[open]")) {
      if (!path.includes(more)) more.open = false;
    }
  }
  const menuRoot = popup.getRootNode();
  document.addEventListener("pointerdown", onMenuPointerDown, true);
  if (menuRoot !== document) menuRoot.addEventListener("pointerdown", onMenuPointerDown, true);

  function clear() {
    revision += 1;
    for (const control of tools) control.close(false);
    tools = []; images.clear(); groupTabs = []; groupContext = null; availableDictionaries = []; pendingPresentation = null;
    tabs.replaceChildren(); nav.replaceChildren(); scroll.replaceChildren();
    blocks = []; bindings = []; heads = []; labels = []; markers = []; selected = 0; tab = null; onTabSelected = null;
    activeSource = null; paintedFrequency = ""; frequencyDictionaries.clear(); pitchByTerm.clear();
    highlighter?.clear();
    preview.hideImagePreview();
  }
  function finish(candidate, matched, context) {
    activeSource = { candidate, matched };
    if (highlightEnabled) highlighter?.apply(candidate, matched);
    setDefinitionBlurState(context.definitionBlurState ?? "revealed");
    options.positionPopup();
    if (context.restoreScrollTop) scroll.scrollTop = context.restoreScrollTop;
  }
  function navigation(context) {
    if (context.onBack) nav.append(button("gsm-hoshidicts-kanji-back", "Back", context.onBack));
    if (context.onClose) {
      const close = button("gsm-hoshidicts-popup-close", "", context.onClose);
      close.title = "Close";
      close.setAttribute("aria-label", "Close");
      nav.append(close);
    }
  }
  function setDefinitionBlurState(state) { scroll.dataset.definitionBlur = state; }
  function dictionaryLabel(dictionary) {
    const label = node("span", "crystal-dictionary");
    setName(label, dictionary);
    label.dataset.dictionary = dictionary;
    labels.push(label);
    return label;
  }

  // Frequency badges get a book for counts in a corpus and a star for ranks.
  function paintFrequencies(context) {
    const presentation = context.dictionaryPresentation ?? [];
    const modes = new Map(presentation.map(item => [item.title, item.frequencyMode]));
    const tagsByResult = new Map();
    for (const head of heads) {
      if (!head.frequency) continue;
      let tags = tagsByResult.get(head.result);
      if (tags) tags = tags.map(tag => tag.cloneNode(true));
      else {
        tags = components.createFrequencyTags(document, head.result, presentation, Infinity,
          context.averageFrequency === true, context.showFrequencyDictionaryNames === true,
          context.compactFrequencyNumbers === true, context.showFrequencyTagsWithAverage === true, language);
        for (const tag of tags) {
          const mode = tag.dataset.frequencyAverage ?? modes.get(tag.dataset.dictionary);
          tag.dataset.crystalIcon = mode === "occurrence-based" ? "book" : "star";
        }
        tagsByResult.set(head.result, tags);
      }
      head.frequency.replaceChildren(...tags);
    }
  }
  function updateDictionaryPresentation(context, notify = true) {
    const names = new Map((context.dictionaryPresentation ?? []).map(item => [item.title, item.displayName || item.title]));
    for (const label of labels) {
      const displayName = names.get(label.dataset.dictionary) || label.dataset.dictionary;
      if (label.textContent !== displayName) setName(label, displayName);
      if (label.title !== displayName) label.title = displayName;
    }
    // Lookup data stays fixed for this view; only these inputs change its badges.
    const frequency = JSON.stringify([context.averageFrequency === true, context.showFrequencyDictionaryNames === true,
      context.compactFrequencyNumbers === true, context.showFrequencyTagsWithAverage === true,
      (context.dictionaryPresentation ?? []).filter(item => frequencyDictionaries.has(item.title))
        .map(({ title, displayName, frequencyMode }) => [title, displayName, frequencyMode])]);
    if (frequency !== paintedFrequency) {
      paintFrequencies(context);
      paintedFrequency = frequency;
    }
    // Markers hold no controls, so a pitch option change repaints them in place
    // without moving focus or touching an open Note draft.
    const pitch = pitchOptions(context);
    if (pitch !== paintedPitch) {
      paintedPitch = pitch;
      pitchByTerm.clear();
      for (const marker of markers) paintPitch(marker, context);
    }
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
  function flushDictionaryPresentation() {
    if (!pendingPresentation) return;
    const context = pendingPresentation; pendingPresentation = null;
    updateDictionaryPresentation(context);
  }

  // The first two custom actions are icons beside audio, Anki and the pencil;
  // the others are listed under More actions.
  function placeCustomActions(actions, buttons) {
    for (const [index, custom] of buttons.entries()) {
      // Inline icons reuse the shared label; More keeps its visible label.
      const label = custom.firstElementChild;
      let icon = custom.querySelector(".crystal-custom-action-icon");
      if (index < 2) {
        if (icon && icon !== label) icon.remove();
        icon = label;
      } else if (icon === label) {
        label.classList.remove("crystal-custom-action-icon", "hd-icon");
        label.removeAttribute("aria-hidden");
        delete label.dataset.icon;
        icon = null;
      }
      if (!icon) {
        icon = node("span", "crystal-custom-action-icon hd-icon");
        custom.append(icon);
      }
      icon.classList.add("crystal-custom-action-icon", "hd-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.dataset.icon = custom.dataset.customButtonType === "anki" ? "document-add" : "open";
      if (custom.dataset.customButtonType === "link") {
        custom.title = `Open ${custom.dataset.customButtonLabel}`;
        custom.setAttribute("aria-label", custom.title);
      }
    }
    actions.querySelector(".crystal-more-actions")?.remove();
    if (buttons.length <= 2) return;
    const more = node("details", "crystal-more-actions");
    const summary = node("summary", "", "⋯");
    summary.setAttribute("aria-label", "More actions");
    summary.title = "More actions";
    const menu = node("div", "crystal-action-menu");
    // Shared link actions stop bubbling. Capture their activation and dismiss
    // after the action handler runs, keeping its normal semantics.
    const dismiss = event => {
      if (event.button !== (event.type === "auxclick" ? 1 : 0) || !event.target.closest("button")) return;
      queueMicrotask(() => { if (more.isConnected) { more.open = false; summary.focus({ preventScroll: true }); } });
    };
    menu.addEventListener("click", dismiss, true);
    menu.addEventListener("auxclick", dismiss, true);
    menu.append(...buttons.slice(2)); more.append(summary, menu); actions.append(more);
  }
  // The Note form and Anki feedback open beneath the controls that own them:
  // under the header for a result's first section, else under the banner. A
  // notice has neither, so its form follows the notice.
  const insertBelowControls = (block, element) => block.insertBefore(element, block.dataset.crystalFirst === "true"
    ? block.firstChild : block.querySelector(":scope > .crystal-banner")?.nextSibling ?? null);
  function addTools(actions, block, prefill, context) {
    const control = components.createLookupActions({ ...options, customButtons,
      idPrefix: `${options.idPrefix || "crystal"}-${tools.length}`,
      readPrefill: () => prefill, renderContext: context,
      onNoteEditingChange(editing) {
        if (editing) for (const other of tools) if (other !== control) other.close(false);
        options.onNoteEditingChange?.(editing);
      },
      onFormCreated(form) { insertBelowControls(block, form); options.positionPopup(); },
      onClose: flushDictionaryPresentation,
      onButtonsUpdated: placeCustomActions,
    });
    tools.push(control);
    actions.append(control.actions);
    return control;
  }
  function termPrefill(result, candidate) {
    const exact = candidate?.exactSelection === true;
    return { term: exact ? candidate.query : result.term.expression,
      reading: !exact || candidate.query === result.term.expression ? result.term.reading || "" : "",
      definition: "", sentence: candidate?.sentence || "" };
  }

  // Monolingual dictionaries number senses ①②; the numbers are drawn in gold.
  function markCircledNumbers(root) {
    const walker = document.createTreeWalker(root, SHOW_TEXT);
    const found = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) if (CIRCLED.test(text.data)) found.push(text);
    for (const text of found) {
      text.replaceWith(...text.data.split(CIRCLED).filter(Boolean).map(part => CIRCLED.test(part)
        ? node("span", "crystal-circled", part) : document.createTextNode(part)));
    }
  }
  function formattedGlossary(parent, glossary, dictionary, context, owner, direction = undefined) {
    const content = node("div", "gsm-hoshidicts-glossary-content crystal-gloss");
    content.dataset.hoshidictsDictionary = dictionary;
    parent.append(content);
    const ownRevision = revision;
    try {
      options.appendTextOnlyGlossary(document, content, glossary, {
        dictionary, generation: context.generation,
        isCurrent: () => ownRevision === revision && owner.isConnected && context.isCurrentRequest?.() !== false,
        isCurrentLink: () => ownRevision === revision && owner.isConnected && !owner.hidden
          && (context.isCurrentView || context.isCurrentRequest)?.() !== false,
        onExternalLink: context.onExternalLink, onInternalLink: context.onInternalLink,
        resolveMedia: context.resolveMedia, imageContext: context,
        onImageCreated: image => images.add(image), onLayoutChange: options.positionPopup,
        requestImagePreview: preview.requestImagePreview, refreshImagePreview: preview.refreshImagePreview,
        hideImagePreview: preview.hideImagePreview,
        ...(marked() ? { language, direction: direction ?? directionOf(dictionary) } : {}),
      });
      markCircledNumbers(content);
    } catch (error) {
      content.replaceChildren(node("div", "gsm-hoshidicts-lookup-failure", `Could not render definition: ${error.message}`));
    }
  }
  // Numbered senses: gold diamonds, the sense's tags, then its formatted glossary.
  function appendSenses(definitions, rows, dictionary, context, owner, result = null) {
    const list = node("ol", "crystal-senses");
    list.dataset.count = String(rows.length);
    // The dictionary's direction and default language hold its block (10.2).
    if (marked()) setAttributes(list, language.glossaryAttributes(dictionary, result));
    const direction = directionOf(dictionary, result);
    definitions.append(list);
    for (const row of rows) {
      const sense = node("li", "crystal-sense");
      list.append(sense);
      const tags = Array.isArray(row.tags) ? row.tags : tagNames(row.definitionTags).map(name => ({ name }));
      if (tags.length) {
        const chips = node("span", "crystal-tags");
        for (const tag of tags) {
          const chip = node("span", "crystal-tag", tag.name);
          if (tag.notes) chip.title = tag.notes;
          chips.append(chip);
        }
        sense.append(chips);
      }
      formattedGlossary(sense, row.glossary, dictionary, context, owner, direction);
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
  // A line over high morae and under low ones, joined where the pitch changes.
  function paintPitch({ element, text, term }, context) {
    const morae = pitchByTerm.has(term) ? pitchByTerm.get(term)
      : context.showPitchAccentFurigana === false ? null
        : pitchMorae(text, term.pitches ?? [], context.pitchAccentFuriganaDictionary);
    pitchByTerm.set(term, morae);
    element.dataset.pitchStyle = context.pitchAccentFuriganaStyle === "overline" ? "overline" : "contour";
    if (!morae) {
      element.textContent = text;
      return;
    }
    element.replaceChildren(...morae.map(mora => {
      const span = node("span", "crystal-mora", mora.text);
      span.dataset.pitch = mora.level;
      if (mora.transition) span.dataset.transition = mora.transition;
      return span;
    }));
  }
  function pitchMarker(element, text, term, context) {
    const marker = { element, text, term };
    markers.push(marker);
    paintPitch(marker, context);
    return element;
  }
  function spelling(result, candidate) {
    const element = node("span", "gsm-hoshidicts-expression crystal-spelling");
    if (marked()) setAttributes(element, language.sourceAttributes());
    const isLink = language ? character => language.isCharacterLink(character) : character => HAN.test(character);
    for (const character of displayed(result, "expression")) {
      element.append(isLink(character)
        ? button("gsm-hoshidicts-kanji-link", character, event => options.onKanjiClick?.(character, result, candidate, event.currentTarget))
        : document.createTextNode(character));
    }
    return element;
  }
  // One header per result: spelling, reading, deinflection and frequencies, then
  // a slot for its first section's controls.
  function appendHead(result, word) {
    const section = node("div", "crystal-result");
    const head = node("div", "crystal-head");
    const line = node("div", "crystal-word");
    line.append(word);
    const slot = node("div", "crystal-head-actions");
    head.append(line, slot);
    section.append(head);
    scroll.append(section);
    const record = { section, head, line, slot, result, frequency: null, blocks: [] };
    heads.push(record);
    // Clicking the header selects its first shown section for keyboard actions.
    head.addEventListener("click", () => {
      const first = record.blocks.find(block => !block.hidden);
      if (first) selected = blocks.indexOf(first);
    });
    return record;
  }
  function termHead(result, candidate, context) {
    const term = result.term;
    const expression = spelling(result, candidate);
    const record = appendHead(result, expression);
    // The displayed forms (10.4); the stored ones stay what is mined.
    const expressionText = displayed(result, "expression"), readingText = displayed(result, "reading");
    const reading = readingText && readingText !== expressionText ? readingText : "";
    if (reading) {
      const readingElement = node("span", "crystal-reading");
      if (marked()) setAttributes(readingElement, language.readingAttributes());
      record.line.append(pitchMarker(readingElement, reading, term, context));
    }
    // Without a reading the spelling itself is marked, which only works for
    // kana and only a language with pitch accent has.
    else if ((language?.capabilities.pitchAccent ?? true) && !HAN.test(expressionText)) {
      pitchMarker(expression, expressionText, term, context);
    }
    const steps = components.deinflectionSteps(result);
    const matched = result.matched || "";
    // The mock-up's trail, 食べたかった ～た→たい: the rules' names without their hyphen.
    const process = steps.length ? `${label("traceMarker", "～")}${steps.map(step => step.name.replace(/^-/u, "")).join("→")}` : "";
    if (process || (matched && matched !== expressionText && matched !== readingText)) {
      if (marked() && matched) {
        // The matched form keeps its own direction inside the English trail.
        const trail = node("span", "crystal-deconj");
        const form = setAttributes(document.createElement("span"), language.sourceAttributes());
        form.textContent = matched;
        trail.append(form, ...(process ? [` ${process}`] : []));
        record.line.append(trail);
      } else record.line.append(node("span", "crystal-deconj", [matched, process].filter(Boolean).join(" ")));
    }
    const groups = (term.frequencies ?? []).filter(group => group.frequencies.length);
    for (const group of groups) frequencyDictionaries.add(group.dictionary);
    if (groups.length) {
      record.frequency = node("span", "crystal-frequency");
      record.line.append(record.frequency);
    }
    return record;
  }
  // A framed dictionary section: a banner plaque with a crystal and the
  // dictionary's name, its controls, and its content.
  function appendBlock(head, dictionary, className) {
    const block = node("article", `gsm-hoshidicts-entry crystal-block${className ? ` ${className}` : ""}`);
    block.tabIndex = -1;
    block.dataset.dictionary = dictionary;
    const first = head.blocks.length === 0;
    block.dataset.crystalFirst = String(first);
    const index = blocks.length;
    block.addEventListener("click", () => { selected = index; });
    const banner = node("div", "crystal-banner");
    const plaque = node("span", "crystal-plaque");
    plaque.append(ornament("crystal-gem"), dictionaryLabel(dictionary));
    banner.append(plaque, ornament("crystal-rule"));
    const actions = node("div", "gsm-hoshidicts-entry-actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Entry actions");
    (first ? head.slot : banner).append(actions);
    const feedback = node("div", "gsm-hoshidicts-anki-feedback");
    feedback.hidden = true;
    block.append(banner);
    insertBelowControls(block, feedback);
    head.blocks.push(block);
    blocks.push(block);
    // Media ownership checks need the block attached before its images are requested.
    head.section.append(block);
    return { block, actions, feedback };
  }
  function termBlock(head, dictionary, rows, candidate, context) {
    const { result } = head;
    // A section's actions mine and play only its own dictionary, as in JL and Bee.
    const projected = rows.length === result.term.glossaries.length ? result
      : { ...result, term: { ...result.term, glossaries: rows } };
    const { block, actions, feedback } = appendBlock(head, dictionary);
    const audio = components.createAudioControl(document, result.term.expression);
    actions.append(audio.element);
    bindings.push({ audio: { button: audio.button, result: projected }, mining: { actions, feedback, result: projected } });
    addTools(actions, block, termPrefill(result, candidate), context);
    const definitions = node("div", "gsm-hoshidicts-definitions");
    block.append(definitions);
    appendSenses(definitions, rows, dictionary, context, block, projected);
  }
  // Like Default's tabs, core binds only the sections the selected tab shows, so
  // keybinds and autoplay follow the tab.
  function shownBindings() {
    const bound = bindings.filter((_, index) => !blocks[index].hidden);
    return { audioButtons: bound.flatMap(item => item.audio ? [item.audio] : []), miningActions: bound.map(item => item.mining) };
  }
  // A header shows while any of its sections does; its controls belong to the first.
  function showHeads() {
    for (const head of heads) {
      head.section.hidden = !head.blocks.some(block => !block.hidden);
      head.slot.hidden = head.blocks[0]?.hidden ?? true;
    }
  }
  function selectGroup(descriptor, notify) {
    const filtered = !!descriptor?.groupId;
    if (notify || blocks.some(block => block.hidden !== (filtered && !descriptor.dictionaries.has(block.dataset.dictionary)))) {
      closeActionMenu(false);
    }
    tab = filtered ? { groupId: descriptor.groupId } : null;
    for (const element of tabs.children) element.setAttribute("aria-pressed", String(element.dataset.groupId === descriptor?.groupId));
    for (const block of blocks) block.hidden = filtered && !descriptor.dictionaries.has(block.dataset.dictionary);
    showHeads();
    selected = Math.max(0, blocks.findIndex(block => !block.hidden));
    if (notify) {
      scroll.scrollTop = 0;
      onTabSelected?.(tab);
      options.onResultsExpanded?.(shownBindings());
    }
  }
  // All, then the configured groups with results, in their saved order.
  function renderGroupTabs(dictionaries, context, notify = false) {
    const descriptors = components.createDictionaryTabs(dictionaries, context).tabs.filter(item => item.key === "all" || item.groupId);
    const active = descriptors.find(item => item.groupId === tab?.groupId) || descriptors[0];
    const previous = JSON.stringify(groupTabs.map(item => [item.groupId, item.label, [...item.dictionaries]]));
    const next = JSON.stringify(descriptors.map(item => [item.groupId, item.label, [...item.dictionaries]]));
    if (previous !== next) {
      const focused = popup.getRootNode().activeElement;
      const focusedTab = focused && tabs.contains(focused);
      tabs.replaceChildren();
      for (const descriptor of descriptors) {
        const element = button("crystal-tab", descriptor.label, () => selectGroup(descriptor, true));
        if (marked()) setName(element, descriptor.label);
        if (descriptor.groupId) element.dataset.groupId = descriptor.groupId;
        element.title = descriptor.title;
        tabs.append(element);
      }
      groupTabs = descriptors;
      if (focusedTab) {
        const replacement = [...tabs.children].find(element => element.dataset.groupId === focused.dataset.groupId)
          || tabs.firstElementChild || blocks.find(block => !block.hidden);
        replacement?.focus({ preventScroll: true });
      }
    }
    const changed = tab?.groupId !== active?.groupId;
    selectGroup(active, false);
    if (changed) onTabSelected?.(tab);
    if (notify) options.onResultsExpanded?.(shownBindings());
  }
  function renderTabs(dictionaries, context) {
    groupContext = context; availableDictionaries = dictionaries;
    tab = context.selectedDictionaryTab?.groupId ? { groupId: context.selectedDictionaryTab.groupId } : null;
    renderGroupTabs(dictionaries, context);
  }
  // Tabs follow the dictionary order in Settings.
  function orderedDictionaries(found, context) {
    const order = (context.dictionaryPresentation ?? []).map(item => item.title);
    return [...order.filter(title => found.includes(title)), ...found.filter(title => !order.includes(title))];
  }

  function renderResults(results, candidate, context = {}) {
    clear();
    language = context.language ?? options.language ?? null;
    setJoinedScript();
    paintedPitch = pitchOptions(context);
    onTabSelected = context.onDictionaryTabSelected;
    const found = [];
    for (const result of results) {
      const head = termHead(result, candidate, context);
      for (const [dictionary, rows] of Map.groupBy(result.term.glossaries, glossary => glossary.dictionary)) {
        if (!found.includes(dictionary)) found.push(dictionary);
        termBlock(head, dictionary, rows, candidate, context);
      }
    }
    renderTabs(orderedDictionaries(found, context), context);
    navigation(context);
    updateDictionaryPresentation(context, false);
    finish(candidate, results[0]?.matched || candidate?.query, context);
    options.onResultsRendered?.({ ...shownBindings(), lookupStats: null });
  }
  // The character once, then each kanji dictionary's meanings and readings.
  function renderKanji(kanji, candidate, context = {}) {
    clear();
    language = context.language ?? options.language ?? null;
    setJoinedScript();
    navigation(context);
    const character = node("span", "crystal-spelling crystal-kanji-character", kanji.character);
    if (marked()) setAttributes(character, language.sourceAttributes());
    const head = appendHead(null, character);
    for (const entry of kanji.entries) {
      const { block, actions, feedback } = appendBlock(head, entry.dictionary, "crystal-kanji");
      const result = { ...(language && components.language
        ? components.language.characterEntryResult(kanji.character, entry, language)
        : components.kanjiEntryResult(kanji.character, entry)), generation: context.generation };
      result.term.frequencies = kanji.frequencies ?? [];
      bindings.push({ mining: { actions, feedback, result } });
      addTools(actions, block, { term: kanji.character, reading: "", definition: "", sentence: candidate?.sentence || "" }, context);
      formattedGlossary(block, JSON.stringify(entry.definitions), entry.dictionary, context, block);
      const details = node("div", "crystal-kanji-details");
      for (const [name, value] of [[label("onyomi", "On"), entry.onyomi], [label("kunyomi", "Kun"), entry.kunyomi]]) {
        const readings = kanjiTokens(value);
        if (!readings.length) continue;
        const row = node("div", "crystal-kanji-row");
        row.append(node("span", "crystal-kanji-label", name),
          node("span", "crystal-kanji-readings", readings.join(label("readingSeparator", "、"))));
        details.append(row);
      }
      if (entry.stats?.length) {
        const stats = node("div", "crystal-kanji-row crystal-kanji-stats");
        stats.append(node("span", "crystal-kanji-label", "Statistics"));
        for (const stat of entry.stats) stats.append(node("span", "crystal-tag", `${stat.name}: ${stat.value}`));
        details.append(stats);
      }
      if (details.children.length) block.append(details);
    }
    onTabSelected = context.onDictionaryTabSelected;
    renderTabs([...new Set(kanji.entries.map(entry => entry.dictionary))], context);
    updateDictionaryPresentation(context, false);
    finish(candidate, context.highlightText || kanji.character, context);
    options.onResultsRendered?.({ ...shownBindings(), lookupStats: null });
  }
  function renderNotice(message, candidate, context = {}) {
    clear(); navigation(context);
    language = context.language ?? options.language ?? null;
    setJoinedScript();
    const notice = node("div", "gsm-hoshidicts-lookup-notice", message);
    notice.setAttribute("role", "status"); scroll.append(notice);
    addTools(nav, scroll, { term: candidate?.query || "", reading: "", definition: "", sentence: candidate?.sentence || "" }, context);
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
  // A result's first shown section scrolls with its header.
  function scrollTarget(block) {
    const head = heads.find(record => record.blocks.includes(block));
    return head && head.blocks.find(candidate => !candidate.hidden) === block ? head.section : block;
  }
  return {
    scrollElement: scroll, clear, renderResults, renderKanji, renderNotice, renderLookupFailure,
    captureTermView: () => ({ expandAll: true, restoreScrollTop: scroll.scrollTop, selectedDictionaryTab: tab }),
    currentEntryIndex: () => Math.max(0, shown().indexOf(blocks[selected])),
    focusEntry(target) {
      const visible = shown();
      if (!visible.length) return false;
      let position = Math.max(0, visible.indexOf(blocks[selected]));
      if (target.dictionary) {
        const found = components.findDifferentDictionary(visible, position, Math.sign(target.dictionary), scroll,
          block => [block], block => block.dataset.dictionary);
        if (!found) return false;
        position = found.index;
      } else {
        let next = position + target.offset;
        if (target === "first") next = 0;
        else if (target === "last") next = visible.length - 1;
        position = Math.max(0, Math.min(visible.length - 1, next));
      }
      selected = blocks.indexOf(visible[position]);
      const top = position === 0 ? 0
        : (scrollTarget(visible[position]).getBoundingClientRect().top - scroll.getBoundingClientRect().top) * coordinateScale()
          + scroll.scrollTop;
      scroll.scrollTo({ top, behavior: "instant" });
      return true;
    },
    setDefinitionBlurState, updateDictionaryPresentation, flushDictionaryPresentation,
    hideImagePreview() { preview.hideImagePreview(); },
    closeNoteForm() { return tools.some(control => control.close()); },
    closeActionMenu,
    setCustomButtons(value) {
      customButtons = value || [];
      for (const control of tools) control.setCustomButtons(customButtons);
      options.positionPopup();
    },
    setSourceHighlightEnabled(enabled) {
      highlightEnabled = enabled;
      if (!enabled) highlighter?.clear();
      else if (activeSource) highlighter?.apply(activeSource.candidate, activeSource.matched);
    },
    destroy() {
      clear(); document.removeEventListener("pointerdown", onMenuPointerDown, true);
      menuRoot.removeEventListener("pointerdown", onMenuPointerDown, true);
      preview.destroy(); popup.replaceChildren();
    },
  };
}
export default { schema: 2, slug: "crystal", contentMode: "rich", createView };
