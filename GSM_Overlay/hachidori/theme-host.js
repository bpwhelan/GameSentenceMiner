// Select a bundled renderer before constructing popup content. The renderers
// implement the existing core view contract; only their DOM and CSS differ.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";
  const RENDER_METHODS = new Set(["renderResults", "renderKanji", "renderNotice", "renderLookupFailure"]);
  const METHODS = [...RENDER_METHODS, "captureTermView", "currentEntryIndex", "focusEntry", "hideImagePreview",
    "scheduleMasonry", "setDefinitionBlurState", "setLookupStats", "setToolbarPosition", "setCustomButtons",
    "setSourceHighlightEnabled", "updateDictionaryPresentation", "flushDictionaryPresentation", "closeNoteForm", "closeActionMenu"];

  // docs/languages.md 11.1: the language a view and each render receive.
  // The Japanese descriptor is the registry's when the page has one. Without
  // it these fields of the Japanese pack, which give today's labels.
  const JAPANESE = Object.freeze({
    schema: 1, code: "ja", name: "Japanese", nativeName: "日本語", bcp47: "ja", scripts: ["Jpan"], direction: "ltr",
    text: { pattern: String.raw`[\u3005-\u3007\u303B\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F\u{20000}-\u{2FA1F}]` },
    capabilities: { readings: "required", ruby: { alignment: "kana" }, pitchAccent: true,
      characterView: { name: "Kanji", pattern: String.raw`[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]`,
        readingLabels: { onyomi: "On", kunyomi: "Kun" }, readingSeparator: "\u3001" },
      wordHighlighting: true },
    presentation: { typography: { fontFamily: null, wordBreak: null, lineBreak: null, joinedScript: false },
      labels: { traceMarker: "\uFF5E", readingBrackets: ["\u300A", "\u300B"], listSeparator: "\u3001" }, displayTransforms: {} },
    settings: [],
    host: { sample: { warmup: "食べました" } },
  });
  const DEFAULT_LABELS = Object.freeze({ reading: "Reading", traceMarker: "", readingBrackets: Object.freeze(["(", ")"]),
    senseSeparator: "; ", listSeparator: ", " });
  // Compiled the first time it is used, like glossary.js's patterns: a
  // property escape in a literal costs every frame at injection.
  let hanPattern = null;
  const HAN = () => hanPattern ??= new RegExp(String.raw`\p{Script=Han}`, "u"); // NOSONAR: a literal is parsed, with its character set, at every injection
  const FIRST_STRONG_ISOLATE = "\u2068", POP_ISOLATE = "\u2069";
  const registryPack = code => globalThis.HDLanguages?.get?.(code) ?? null;

  // A pack setting's value: the profile's when valid, else its default (7.5).
  function settingValue(setting, value) {
    return validSettingValue(setting, value) ? value : setting.default;
  }

  // A bound the schema leaves out does not limit the value.
  function validSettingValue(setting, value) {
    switch (setting.type) {
      case "boolean": return typeof value === "boolean";
      case "enum": return Array.isArray(setting.values) && setting.values.some(item => item.id === value);
      case "number": return Number.isFinite(value) && (typeof setting.min !== "number" || value >= setting.min)
        && (typeof setting.max !== "number" || value <= setting.max);
      default: return false;
    }
  }

  // An optional capability is on only while a setting with a capability
  // effect turns it on (engine contract 4.6 and 4.7).
  function resolveCapabilities(capabilities, settings, values) {
    const resolved = { ...capabilities };
    for (const [name, value] of Object.entries(resolved)) {
      if (value && typeof value === "object" && value.optional === true) {
        const enabled = settings.some(setting => setting.effect?.capability === name && values[setting.id] === true);
        if (!enabled) resolved[name] = null;
      }
    }
    return Object.freeze(resolved);
  }

  // The letters of one dictionary's gloss strings in a result (10.2): the
  // glossary data, never a theme's composed text.
  function glossDirection(glossaries) {
    const glossary = globalThis.HDGlossary;
    if (!glossaries.some(row => glossary.hasRtlText(row.glossary))) return "ltr";
    return glossary.textDirection(glossStrings(glossaries).join(" ")) ?? "ltr";
  }

  // The strings of gloss rows: text and structured content, without images.
  function glossStrings(glossaries) {
    const strings = [];
    const stack = [];
    for (const row of glossaries) {
      try { stack.push(typeof row.glossary === "string" ? JSON.parse(row.glossary) : row.glossary); }
      catch { strings.push(String(row.glossary)); }
    }
    while (stack.length > 0) collectGlossString(stack.pop(), strings, stack);
    return strings;
  }

  function collectGlossString(value, strings, stack) {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) stack.push(...value);
    else if (value && typeof value === "object") {
      if (value.type === "text") stack.push(value.text);
      else if (value.tag !== "img" && value.type !== "image") stack.push(value.content);
    }
  }

  // A render's gloss rows by dictionary title.
  function glossariesByDictionary(results) {
    const byTitle = new Map();
    for (const result of results) {
      for (const row of result.term?.glossaries ?? []) {
        if (!byTitle.has(row.dictionary)) byTitle.set(row.dictionary, []);
        byTitle.get(row.dictionary).push(row);
      }
    }
    return byTitle;
  }

  // 11.4's fallbacks act on the headwords and definition containers of the
  // subtrees a render changed.
  function fallbackTargets(roots) {
    const containers = new Set(), expressions = new Set();
    for (const root of roots) {
      if (root.nodeType !== 1) continue;
      if (root.matches(".gsm-hoshidicts-expression")) expressions.add(root);
      for (const element of root.querySelectorAll(".gsm-hoshidicts-expression")) expressions.add(element);
      const outer = root.closest(".gsm-hoshidicts-definitions");
      if (outer) containers.add(outer);
      for (const element of root.querySelectorAll(".gsm-hoshidicts-definitions")) containers.add(element);
    }
    return { containers, expressions };
  }

  // The dictionaries a definition container shows.
  function containerTitles(container) {
    const named = container.closest("[data-dictionary]")?.dataset.dictionary;
    if (named) return [named];
    return [...new Set([...container.querySelectorAll("[data-hoshidicts-dictionary]")]
      .map(element => element.dataset.hoshidictsDictionary))];
  }

  // Neither property reaches block descendants in every Chrome version.
  function applyPlaintextFallback(container) {
    for (const element of [container, ...container.querySelectorAll("*")]) {
      if (element === container || BLOCK_TAGS.has(element.localName)) {
        element.style.unicodeBidi = "plaintext";
        element.style.textAlign = "start";
      }
    }
  }

  // The labelling pass (10.1) reads the topmost nodes that mutation records
  // added or changed inside `popup`.
  function changedRoots(records, popup) {
    const found = new Set();
    for (const record of records) {
      if (record.type === "characterData") found.add(record.target);
      else for (const node of record.addedNodes) found.add(node);
    }
    return [...found].filter(node => popup.contains(node) && !hasFoundAncestor(node, popup, found));
  }

  function hasFoundAncestor(node, popup, found) {
    for (let parent = node.parentNode; parent && parent !== popup; parent = parent.parentNode) {
      if (found.has(parent)) return true;
    }
    return false;
  }

  function textNodesOf(root) {
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    const texts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node);
    return texts;
  }

  function labelledSpan(document, tag) {
    const span = document.createElement("span");
    span.setAttribute("lang", tag);
    return span;
  }

  // Text of several lines is labelled one line at a time.
  function labelLines(node, lines, tags) {
    const document = node.ownerDocument;
    const fragment = document.createDocumentFragment();
    let plain = "";
    lines.forEach((line, index) => {
      const separator = index < lines.length - 1 ? "\n" : "";
      if (!tags[index]) {
        plain += line + separator;
        return;
      }
      if (plain) fragment.append(plain);
      const span = labelledSpan(document, tags[index]);
      span.textContent = line;
      fragment.append(span);
      plain = separator;
    });
    if (plain) fragment.append(plain);
    node.replaceWith(fragment);
  }

  // One text node of the labelling pass: text that inherits the popup's own
  // language or a block's default takes the language its characters give.
  function labelText(node, popup, language) {
    const text = node.data;
    const parent = node.parentElement;
    if (!parent || !text.trim()) return;
    const holder = parent.closest("[lang]");
    if (!holder || (holder !== popup && !("hdLangDefault" in holder.dataset))) return;
    const inherited = holder.getAttribute("lang");
    const isDefault = holder !== popup;
    const detect = value => {
      const tag = value.trim() ? language.detectLabel(value, inherited, isDefault) : null;
      return tag && tag !== inherited ? tag : null;
    };
    if (text.includes("\n")) {
      const lines = text.split("\n");
      const tags = lines.map(detect);
      if (tags.some(Boolean)) labelLines(node, lines, tags);
      return;
    }
    const tag = detect(text);
    if (!tag) return;
    // The parent takes the label only when the text is all it holds, so
    // the interface controls beside such text keep English (10.1).
    if (parent === holder || parent.childNodes.length > 1) {
      const span = labelledSpan(node.ownerDocument, tag);
      node.replaceWith(span);
      span.append(node);
    } else parent.setAttribute("lang", tag);
  }

  // Lists of mixed direction get an end padding equal to their start padding.
  function padMixedLists(lists, popup) {
    if (lists.length === 0 || !popup.isConnected) return;
    const view = popup.ownerDocument.defaultView;
    const paddings = lists.map(list => view.getComputedStyle(list).paddingInlineStart);
    lists.forEach((list, index) => { list.style.paddingInlineEnd = paddings[index]; });
  }

  function createLanguage(descriptor = null, { marked = false, packSettings = {}, dictionaries = [], packFor = registryPack } = {}) {
    // Only marked paths reach the glossary helpers, so an unmarked language
    // works on every page that loads this host.
    const glossary = globalThis.HDGlossary;
    const pack = descriptor ?? registryPack("ja") ?? JAPANESE;
    const japanese = pack.code === "ja";
    const settingsSchema = Array.isArray(pack.settings) ? pack.settings : [];
    const settings = Object.freeze(Object.fromEntries(settingsSchema.map(setting =>
      [setting.id, settingValue(setting, packSettings?.[setting.id])])));
    const capabilities = resolveCapabilities(pack.capabilities ?? {}, settingsSchema, settings);
    const characterView = capabilities.characterView ?? null;
    const typography = Object.freeze({ fontFamily: null, wordBreak: null, lineBreak: null, joinedScript: false,
      ...pack.presentation?.typography });
    const labels = Object.freeze({ ...DEFAULT_LABELS, ...pack.presentation?.labels,
      character: characterView?.name ?? null, onyomi: characterView?.readingLabels?.onyomi ?? null,
      kunyomi: characterView?.readingLabels?.kunyomi ?? null, readingSeparator: characterView?.readingSeparator ?? null });
    const direction = pack.direction === "rtl" ? "rtl" : "ltr";
    const bcp47 = pack.bcp47 || pack.code;
    let info = null;
    const profileInfo = () => info ??= glossary.textLanguage(pack);
    const characterPattern = characterView && !japanese && typeof characterView.pattern === "string"
      ? new RegExp(characterView.pattern, "u") : null;
    const displayTransforms = pack.presentation?.displayTransforms ?? {};
    const displayEffects = settingsSchema.filter(setting => setting.effect?.display
      && settings[setting.id] === setting.effect.display.when
      && Array.isArray(displayTransforms[setting.effect.display.transform]));
    const targetTags = new Map(dictionaries.filter(item => typeof item?.title === "string")
      .map(item => [item.title, typeof item.targetLanguage === "string" && item.targetLanguage ? item.targetLanguage : null]));
    const targets = new Map();
    const target = title => {
      if (!targets.has(title)) targets.set(title, glossary.targetLanguage(targetTags.get(title) ?? null, packFor));
      return targets.get(title);
    };
    const directions = new WeakMap();
    let segmenter = null;
    const graphemeBoundaries = text => {
      segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const boundaries = [];
      for (const { index } of segmenter.segment(text)) boundaries.push(index);
      boundaries.push(text.length);
      return boundaries;
    };

    const language = {
      version: 1,
      code: pack.code, bcp47, name: pack.name, nativeName: pack.nativeName ?? pack.name, direction,
      scripts: Object.freeze([...(pack.scripts ?? [])]),
      capabilities, typography, labels, settings,
      sampleText: pack.host?.sample?.warmup ?? "",
      // Whether the records have profiles: before that nothing is marked and
      // every theme renders today's markup (design 4.5).
      marked: marked === true,
      sourceAttributes() {
        if (!language.marked) return {};
        return direction === "rtl" ? { lang: bcp47, dir: "rtl" } : { lang: bcp47 };
      },
      readingAttributes() {
        if (!language.marked) return {};
        return direction === "rtl" ? { lang: bcp47, dir: "auto" } : { lang: bcp47 };
      },
      // A dictionary's direction for a result (10.2): its target language's,
      // else the majority of the letters in its own gloss strings there.
      dictionaryDirection(title, result = null) {
        const known = target(title)?.direction;
        if (known) return known;
        if (!result?.term) return "ltr";
        let byTitle = directions.get(result);
        if (!byTitle) {
          byTitle = new Map();
          directions.set(result, byTitle);
        }
        if (!byTitle.has(title)) {
          byTitle.set(title, glossDirection((result.term.glossaries ?? []).filter(row => row.dictionary === title)));
        }
        return byTitle.get(title);
      },
      dictionaryLanguage(title) {
        return language.marked ? target(title)?.tag ?? null : null;
      },
      glossaryAttributes(title, result = null) {
        if (!language.marked) return {};
        const attributes = language.dictionaryDirection(title, result) === "rtl" ? { dir: "rtl" } : {};
        const tag = target(title)?.tag;
        if (tag) Object.assign(attributes, { lang: tag, "data-hd-lang-default": "" });
        return attributes;
      },
      // 10.3 for one glossary string; the Japanese profile keeps today's detection.
      detectGlossary(text, title) {
        return japanese ? glossary.languageFromText(text) : glossary.glossaryTextLanguage(text, profileInfo(), target(title));
      },
      // The labelling pass's language for text that inherits `inherited`
      // (10.1): today's test in Japanese, 10.3's steps 2 to 6 elsewhere.
      detectLabel(text, inherited, isDefault) {
        return japanese ? glossary.languageFromText(text)
          : glossary.inheritedTextLanguage(text, profileInfo(), glossary.targetLanguage(inherited, packFor), isDefault);
      },
      nameAttributes(name) {
        if (!language.marked) return {};
        const value = String(name ?? "");
        const attributes = glossary.hasRtlText(value) ? { dir: "auto" } : {};
        const detected = japanese ? glossary.languageFromText(value)
          : glossary.inheritedTextLanguage(value, profileInfo(), null, false);
        if (detected === bcp47) attributes.lang = bcp47;
        return attributes;
      },
      isolate(text) {
        const value = String(text ?? "");
        return language.marked && glossary.hasRtlText(value) ? `${FIRST_STRONG_ISOLATE}${value}${POP_ISOLATE}` : value;
      },
      // Japanese keeps the four text themes' \p{Script=Han} (11.6).
      isCharacterLink(character) {
        if (!characterView) return false;
        return japanese ? HAN().test(character) : characterPattern?.test(character) === true;
      },
      display(result, field) {
        return result?.presentation?.[field] ?? result?.term?.[field];
      },
      readingFor(result) {
        const reading = language.display(result, "reading");
        return reading && reading !== language.display(result, "expression") ? reading : "";
      },
      // Japanese slices UTF-16 units, as today; other languages never split a
      // grapheme. Both ends move forward to a grapheme boundary, so slices
      // that meet (before, match, after) partition the text.
      sliceText(text, start = 0, end = undefined) {
        const value = String(text ?? "");
        const from = Math.min(Math.max(0, Math.trunc(start) || 0), value.length);
        const to = end === undefined ? value.length : Math.min(Math.max(0, Math.trunc(end) || 0), value.length);
        const [low, high] = from <= to ? [from, to] : [to, from];
        if (japanese || !value) return value.substring(low, high);
        const boundaries = graphemeBoundaries(value);
        const first = boundaries.find(boundary => boundary >= low) ?? value.length;
        const last = boundaries.find(boundary => boundary >= high) ?? value.length;
        return value.slice(first, last);
      },
      // 10.4: each result's displayed headword and reading while a display
      // setting is active. Mining, counts and word status read `term`.
      present(results) {
        if (displayEffects.length === 0 || !globalThis.HDLanguageText) return results;
        return results.map(result => {
          const presentation = { expression: result.term?.expression, reading: result.term?.reading };
          for (const setting of displayEffects) {
            const steps = displayTransforms[setting.effect.display.transform];
            for (const field of setting.effect.display.fields ?? []) {
              if (typeof presentation[field] === "string") {
                presentation[field] = globalThis.HDLanguageText.applySteps(steps, presentation[field]);
              }
            }
          }
          return { ...result, presentation };
        });
      },
    };
    return Object.freeze(language);
  }

  function setAttributes(element, attributes) {
    for (const [name, value] of Object.entries(attributes ?? {})) element.setAttribute(name, value);
    return element;
  }
  // 11.2: the helpers of 11.1 for code that runs outside a render, which
  // names its language, plus the shared builders.
  const languageComponents = Object.freeze({
    sourceAttributes: language => language.sourceAttributes(),
    readingAttributes: language => language.readingAttributes(),
    glossaryAttributes: (language, title, result) => language.glossaryAttributes(title, result),
    nameAttributes: (language, name) => language.nameAttributes(name),
    isolate: (language, text) => language.isolate(text),
    isCharacterLink: (language, character) => language.isCharacterLink(character),
    display: (language, result, field) => language.display(result, field),
    readingFor: (language, result) => language.readingFor(result),
    sliceText: (language, text, start, end) => language.sliceText(text, start, end),
    setAttributes,
    // A theme's own text paragraph (JL's joined senses) in its dictionary's direction.
    isolateParagraph: (language, text, direction = "ltr") => language.marked
      ? globalThis.HDGlossary.isolateParagraph(text, direction) : text,
    appendHeadword: (...args) => globalThis.HDGlossary.appendHeadword(...args),
    characterEntryResult: (...args) => globalThis.HDPopup.characterEntryResult(...args),
    glossaryToPlainText: (glossary, language, options) => globalThis.HDGlossary.glossaryToPlainText(glossary, language, options),
  });

  const BLOCK_TAGS = new Set(["address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "figure",
    "footer", "header", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "td", "th", "ul"]);

  function createThemeHost({ getOptions, onReady = () => {}, assetUrl = path => chrome.runtime.getURL(path) }) {
    const cache = new Map();
    const views = new Set();
    const disabled = new Set();
    let current, shadow, sheet, fallbackStyle, pending, catalogue;
    const declarations = new Map();
    const selected = () => {
      const name = globalThis.HDReaderOptions.popupRenderer(getOptions().popupTheme);
      return disabled.has(name) ? "default" : name;
    };
    const asset = async path => {
      const response = await fetch(assetUrl(path));
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.text();
    };

    // 11.3: a theme's language declaration from its catalogue entry, read the
    // first time a render has a marked language. Until it arrives a theme
    // counts as undeclared.
    function declaration(name) {
      catalogue ??= asset("vendor/themes/index.json").then(text => {
        for (const theme of JSON.parse(text).themes ?? []) {
          const declared = theme.language ?? {};
          declarations.set(theme.slug, {
            declared: Boolean(theme.language),
            directions: Array.isArray(declared.directions) ? declared.directions : ["ltr"],
            presentation: declared.presentation === true,
          });
        }
        for (const view of views) view.applyFallbacks();
      }).catch(error => { console.warn("hachidori: could not read the theme catalogue", error); });
      return declarations.get(name) ?? null;
    }

    function load(name) {
      if (!cache.has(name)) cache.set(name, (async () => {
        const [css, icons, module] = await Promise.all([
          asset(name === "default" ? "render/reader.css" : `vendor/themes/${name}/theme.css`),
          name === "plain" ? "" : asset("icons.css"),
          name === "default" ? null : import(assetUrl(`vendor/themes/${name}/theme.js`)),
        ]);
        if (module && (module.default?.schema !== 2 || module.default.slug !== name
            || typeof module.default.createView !== "function")) throw new Error("Unsupported renderer contract");
        return { name, css: `${css}\n${icons}`, dictionaryStyles: ["default", "bee", "crystal"].includes(name),
          createView: module?.default.createView ?? globalThis.HDPopup.createPopupView };
      })());
      return cache.get(name);
    }

    function applyCss() {
      if (!shadow || !current) return;
      try {
        sheet ??= new shadow.ownerDocument.defaultView.CSSStyleSheet();
        sheet.replaceSync(current.css);
        shadow.adoptedStyleSheets = [sheet, ...shadow.adoptedStyleSheets.filter(value => value !== sheet)];
      } catch {
        // Preserve the existing plain-style path for DOMs without constructed sheets.
        fallbackStyle ??= shadow.ownerDocument.createElement("style");
        fallbackStyle.textContent = current.css;
        shadow.prepend(fallbackStyle);
      }
      shadow.host.dataset.hoshidictsRenderer = current.name;
      let palette = getOptions().popupTheme;
      if (current.name !== "default") palette = current.name;
      else if (disabled.has(palette)) palette = "default";
      else if (palette === "auto") {
        palette = shadow.ownerDocument.defaultView.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      shadow.host.dataset.hoshidictsTheme = palette;
      for (const style of shadow.querySelectorAll("style[data-hoshidicts-dictionary-style]")) style.remove();
    }

    function fail(error) {
      if (selected() === "default") throw error;
      disabled.add(selected());
      console.warn("hachidori: theme renderer failed; using Default for this page", error);
      return sync();
    }

    async function sync() {
      const name = selected();
      if (current?.name === name) return;
      if (pending?.name === name) return pending.promise;
      const promise = load(name).then(next => {
        if (selected() !== name) return;
        current = next;
        applyCss();
        for (const view of views) view.rebuild();
        onReady();
      }).catch(fail).finally(() => { if (pending?.promise === promise) pending = null; });
      pending = { name, promise };
      return promise;
    }

    function createView(options) {
      let view, lastRender;
      let destroyed = false;
      const settings = new Map();
      const popup = options.popup;
      const viewLanguage = options.language ?? createLanguage();
      // The language of the latest render, which presentation updates,
      // deferred fills and the labelling pass use.
      let language = viewLanguage;
      let renderDictionaries = new Map();
      let markedPopup = false;
      let observer = null;
      const components = { createLookupActions: globalThis.HDPopup.createLookupActions,
        kanjiEntryResult: globalThis.HDPopup.kanjiEntryResult,
        createDictionaryTabs: globalThis.HDPopup.createDictionaryTabs,
        createFrequencyTags: globalThis.HDPopup.createFrequencyTags,
        glossaryToPlainText: globalThis.HDGlossary.glossaryToPlainText,
        buildPitchAccentMorae: globalThis.HDGlossary.buildPitchAccentMorae, pitchAccentPositions: globalThis.HDGlossary.pitchAccentPositions,
        createAudioControl: globalThis.HDPopup.createAudioControl, deinflectionSteps: globalThis.HDPopup.deinflectionSteps,
        createImagePreview: globalThis.HDPopup.createImagePreview,
        findDifferentDictionary: globalThis.HDPopup.findDifferentDictionary, popupCoordinateScale: globalThis.HDPopup.popupCoordinateScale,
        language: languageComponents };
      const themeName = () => current?.name ?? selected();
      const undeclared = () => declaration(themeName())?.declared !== true;
      const themeOptions = { ...options, language: viewLanguage, components,
        // 11.4: outside Japanese a theme without a language declaration may
        // test characters with Japanese rules, so its clicks are ignored.
        ...(typeof options.onKanjiClick === "function" ? { onKanjiClick: (...args) => {
          if (language.marked && language.code !== "ja" && undeclared()) return;
          return options.onKanjiClick(...args);
        } } : {}),
        // Placing the popup reads its layout, so its content is labelled
        // first rather than laid out again for the labels.
        ...(typeof options.positionPopup === "function" ? { positionPopup: (...args) => {
          labelPass();
          return options.positionPopup(...args);
        } } : {}),
        // Content shown without a new render (Show more, tabs) is labelled too.
        ...(typeof options.onResultsExpanded === "function" ? { onResultsExpanded: (...args) => {
          labelPass();
          return options.onResultsExpanded(...args);
        } } : {}),
        // Core's structured-content renderer applies 10.2 and 10.3 for the
        // latest render's language in every theme that uses it.
        ...(typeof options.appendTextOnlyGlossary === "function" ? { appendTextOnlyGlossary: (documentRef, parent, raw, rendering = {}) =>
          options.appendTextOnlyGlossary(documentRef, parent, raw, language.marked ? { language,
            direction: renderDictionaries.get(rendering.dictionary) ?? undefined, ...rendering } : rendering) } : {}),
      };

      // 10.1: once the records have profiles the popup is an English,
      // left-to-right interface that carries the language of its content.
      function markPopup() {
        const marked = language.marked;
        if (!marked && !markedPopup) return;
        markedPopup = marked;
        const typography = language.typography;
        for (const [property, value] of [["--hd-language-font-family", typography.fontFamily],
          ["--hd-language-word-break", typography.wordBreak], ["--hd-language-line-break", typography.lineBreak]]) {
          if (marked && typeof value === "string" && value) popup.style.setProperty(property, value);
          else popup.style.removeProperty(property);
        }
        if (marked) {
          popup.setAttribute("dir", "ltr");
          popup.setAttribute("lang", "en");
          popup.dataset.hdLanguage = language.code;
          popup.dataset.hdDirection = language.direction;
          observer ??= new popup.ownerDocument.defaultView.MutationObserver(records => labelPass(records));
          observer.observe(popup, { childList: true, subtree: true, characterData: true });
        } else {
          for (const name of ["dir", "lang", "data-hd-language", "data-hd-direction"]) popup.removeAttribute(name);
          observer?.disconnect();
        }
      }

      // The dictionaries of a render and their directions, for the fallback
      // and for glossaries a theme renders without naming one.
      function noteRender(method, args) {
        renderDictionaries = new Map();
        if (!language.marked) return;
        if (method === "renderResults") {
          for (const [title, rows] of glossariesByDictionary(args[0] ?? [])) {
            renderDictionaries.set(title, language.dictionaryDirection(title, { term: { glossaries: rows } }));
          }
        } else if (method === "renderKanji") {
          for (const entry of args[0]?.entries ?? []) renderDictionaries.set(entry.dictionary, language.dictionaryDirection(entry.dictionary));
        }
      }

      function withLanguage(method, args) {
        if (method === "renderLookupFailure") return args;
        if (method === "updateDictionaryPresentation") {
          return args[0]?.language ? args : [{ ...args[0], language }, ...args.slice(1)];
        }
        const context = { ...args[2] };
        context.language ??= viewLanguage;
        const next = [...args];
        next[2] = context;
        if (method === "renderResults" && Array.isArray(args[0])) next[0] = context.language.present(args[0]);
        return next;
      }

      // 11.4: a theme that does not lay out a direction a render needs gets
      // it on the contract's content hooks.
      function fallbackDirection() {
        if (!language.marked) return false;
        const declared = declaration(themeName());
        if (!declared) return false;
        const needed = new Set([language.direction, ...renderDictionaries.values()]);
        return [...needed].some(direction => !declared.directions.includes(direction));
      }

      function applyFallback(roots) {
        const { containers, expressions } = fallbackTargets(roots);
        // The headword is in the profile's language, whatever an older theme wrote on it.
        for (const expression of expressions) setAttributes(expression, language.sourceAttributes());
        for (const container of containers) {
          if (fallbackMode(container) === "plaintext") applyPlaintextFallback(container);
        }
      }

      // A container of one dictionary takes that dictionary's direction; one
      // of several lays out each block by its own text. Decided once.
      function fallbackMode(container) {
        if (container.dataset.hdFallback) return container.dataset.hdFallback;
        const titles = containerTitles(container);
        let mode = "plaintext";
        if (titles.length === 1) {
          mode = "dictionary";
          if ((renderDictionaries.get(titles[0]) ?? language.dictionaryDirection(titles[0])) === "rtl") {
            container.setAttribute("dir", "rtl");
            container.style.textAlign = "start";
          }
        }
        container.dataset.hdFallback = mode;
        return mode;
      }

      // 10.1's labelling pass over the subtrees added or changed since the
      // last pass: text that inherits the popup's own language or a block's
      // default takes the language its characters give, one line at a time
      // for text of several lines. Lists of mixed direction then get an end
      // padding equal to their start padding.
      function labelPass(records = observer?.takeRecords() ?? []) {
        if (destroyed || !language.marked || records.length === 0) return;
        const roots = changedRoots(records, popup);
        if (roots.length === 0) return;
        if (fallbackDirection()) applyFallback(roots);
        const lists = [];
        for (const root of roots) {
          if (root.nodeType === 3) labelText(root, popup, language);
          else if (root.nodeType === 1) {
            for (const node of textNodesOf(root)) labelText(node, popup, language);
            if ("hdMixedList" in root.dataset) lists.push(root);
            lists.push(...root.querySelectorAll("[data-hd-mixed-list]"));
          }
        }
        padMixedLists(lists, popup);
        observer?.takeRecords();
      }

      const record = { rebuild() {
        if (destroyed || !current) return;
        const viewport = view?.captureTermView?.();
        options.onRendererRetired?.();
        view?.destroy();
        view = null;
        options.popup.replaceChildren();
        observer?.takeRecords();
        try {
          view = current.createView({ ...themeOptions });
          if (lastRender) {
            const [method, args] = lastRender;
            if (method === "renderResults" && viewport) args[2] = { ...args[2], ...viewport };
            if (args[2]?.isCurrentRequest?.() !== false) call(method, args);
          }
          for (const [method, args] of settings) call(method, args);
        } catch (error) { void fail(error); }
      },
      applyFallbacks() {
        if (destroyed || !language.marked || !fallbackDirection()) return;
        applyFallback([popup]);
        observer?.takeRecords();
      } };
      function call(method, args) {
        if (destroyed) return;
        if (RENDER_METHODS.has(method) || method === "updateDictionaryPresentation") args = withLanguage(method, args);
        if (RENDER_METHODS.has(method) && method !== "renderLookupFailure") {
          language = args[2].language;
          noteRender(method, args);
          markPopup();
        }
        if (RENDER_METHODS.has(method)) lastRender = [method, args];
        if (["setDefinitionBlurState", "setSourceHighlightEnabled", "setCustomButtons", "setToolbarPosition"].includes(method)) {
          settings.set(method, args);
        }
        if (method === "updateDictionaryPresentation" && ["renderResults", "renderKanji"].includes(lastRender?.[0])) {
          lastRender[1][2] = { ...lastRender[1][2], ...args[0] };
        }
        // Keep the latest model while the newly selected bundle loads. Never
        // construct the old renderer's content for a new selection.
        if (RENDER_METHODS.has(method) && current?.name !== selected()) {
          void sync();
          return;
        }
        try {
          const returned = view?.[method]?.(...args);
          if (RENDER_METHODS.has(method) || method === "updateDictionaryPresentation") labelPass();
          return returned;
        } catch (error) { void fail(error); }
      }
      views.add(record);
      record.rebuild();
      return {
        ...Object.fromEntries(METHODS.map(method => [method, (...args) => call(method, args)])),
        get scrollElement() { return view?.scrollElement ?? options.popup; },
        clear() { lastRender = null; settings.clear(); view?.clear(); },
        destroy() { destroyed = true; views.delete(record); observer?.disconnect(); view?.destroy(); },
      };
    }

    return { sync, createView,
      attach(root) { shadow = root; applyCss(); },
      get dictionaryStyles() { return current?.dictionaryStyles === true; },
      get renderer() { return current?.name ?? null; },
    };
  }
  globalThis.HDThemeHost = { createThemeHost, createLanguage };
}());
