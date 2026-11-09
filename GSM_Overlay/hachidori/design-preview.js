// SPDX-License-Identifier: GPL-3.0-or-later
// Static, local sample data; the view itself is the production popup renderer.
(function () {
  "use strict";
  // A pack's sample character stats in the shape the renderers read,
  // [{ name, value }], also when the pack writes the kanji bank's { name: value }.
  function sampleStats(stats) {
    if (Array.isArray(stats)) return stats;
    if (!stats || typeof stats !== "object") return [];
    return Object.entries(stats).map(([name, value]) => ({ name, value: String(value) }));
  }
  HDVisualNovel.initialize(document.querySelector(".vn-scene"));
  const host = document.getElementById("preview-host");
  const shadow = host.attachShadow({ mode: "open" });
  const appearance = HDPopup.createPopupAppearance(host);
  const customStyle = HDPopup.createCustomPopupStyle(shadow);
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  shadow.append(popup);
  const source = document.getElementById("preview-source");
  const dialogue = source.closest(".vn-dialogue");
  const speaker = dialogue.querySelector(".vn-speaker");
  // Today's Japanese scene; another language's comes from its pack's
  // `host.sample.practice` (docs/languages.md 11.5).
  const JAPANESE_SCENE = Object.freeze({ text: source.textContent, lookup: "食べる" });
  const JAPANESE_SPEAKER = speaker.textContent;
  let candidate;
  function setScene(scene, sceneLanguage) {
    if (source.textContent !== scene.text) source.textContent = scene.text;
    const other = sceneLanguage && sceneLanguage.code !== "ja";
    const speakerText = other ? "" : JAPANESE_SPEAKER;
    if (speaker.textContent !== speakerText) speaker.textContent = speakerText;
    speaker.hidden = Boolean(other);
    dialogue.lang = other ? sceneLanguage.bcp47 : "ja";
    if (other && sceneLanguage.direction === "rtl") dialogue.dir = "rtl";
    else dialogue.removeAttribute("dir");
    const typography = other ? sceneLanguage.typography : null;
    dialogue.style.fontFamily = typography?.fontFamily ?? "";
    dialogue.style.lineBreak = other ? typography.lineBreak ?? "auto" : "";
    dialogue.style.wordBreak = typography?.wordBreak ?? "";
    if (!dialogue.getAttribute("style")) dialogue.removeAttribute("style");
    const sourceOffset = Math.max(0, scene.text.indexOf(scene.lookup));
    candidate = { query: scene.lookup, sentence: scene.text, matchOffset: sourceOffset,
      sourceElements: [source], sourceText: scene.text, sourceOffset };
  }
  setScene(JAPANESE_SCENE, null);
  // The edited profile's language (11.1), unmarked Japanese before the records
  // have profiles, and its pack's samples once fetched.
  let language = HDThemeHost.createLanguage();
  let languageKey = null;
  let packSample = null;
  const packSamples = new Map();
  let options = { ...HDReaderOptions.DEFAULT_OPTIONS };
  let state;
  let sample;
  let sampleKey;
  let updateKey;
  let imageSources = null;
  let kanjiCharacter = null;
  let kanjiSource = null;
  let termView;
  let selectedDictionaryTab = null;
  let sampleMedia = null;
  let sampleLookupStats = null;
  let clickedKanjiIndex = 0;
  const themeHost = HDThemeHost.createThemeHost({ getOptions: () => options,
    assetUrl: path => new URL(path, document.baseURI).href,
    onReady() { appearance.refreshHighlight(); positionPopup(); },
  });
  themeHost.attach(shadow);

  // Fixed mature word, count of 3 and native frequency samples; the shared
  // rules, real hover and real delay decide the preview's blur. Nothing is
  // recorded, looked up or sent to Anki.
  const SAMPLE_LOOKUP_COUNT = 3;
  let sampleRevealed = false;
  let sampleBlurTimer = null;
  let sampleTermView = false;
  const DEFINITION_BLUR_KEYS = [
    "showLookupCounts", "definitionBlurCountEnabled", "definitionBlurAnkiMature",
    "definitionBlurFrequencyEnabled", "definitionBlurFrequencyDictionary", "frequencyDictionary",
    "definitionBlurFrequencyOrder", "definitionBlurFrequencyThreshold",
    "definitionBlurDirection", "definitionBlurThreshold", "definitionBlurReveal", "definitionBlurDelayMs",
  ];

  function sampleBlurState() {
    const count = options.showLookupCounts ? SAMPLE_LOOKUP_COUNT : null;
    const frequency = HDReaderOptions.definitionBlurFrequencyEvidence(options,
      sample?.results?.[0]?.term?.frequencies, sample?.dictionaryPresentation);
    return !sampleRevealed && HDReaderOptions.definitionBlurQualifies(options, count, true, frequency.qualified)
      ? "blurred" : "revealed";
  }

  function clearSampleBlurTimer() {
    if (sampleBlurTimer === null) return;
    clearTimeout(sampleBlurTimer);
    sampleBlurTimer = null;
  }

  function revealSample() {
    sampleRevealed = true;
    clearSampleBlurTimer();
    view.setDefinitionBlurState("revealed");
    definitionReveal.sync();
  }

  function armSampleBlur() {
    clearSampleBlurTimer();
    if (sampleBlurState() !== "blurred" || options.definitionBlurReveal !== "timed") return;
    sampleBlurTimer = setTimeout(() => { sampleBlurTimer = null; revealSample(); }, options.definitionBlurDelayMs);
  }

  // Native kanji is outside term blur, so only a term sample is blurred.
  const definitionReveal = HDPopup.createDefinitionReveal(popup, {
    revealMode: () => options.definitionBlurReveal,
    blurred: () => sampleTermView && sampleBlurState() === "blurred",
    reveal: revealSample,
  });

  function positionPopup(resetToolbar = false) {
    const factor = HDPopup.popupCoordinateScale(1, options.popupScalePercent);
    const position = HDPopup.calculatePopupPosition(HDPopup.scaleRect(source.getBoundingClientRect(), factor),
      { width: options.popupWidthPx, height: options.popupHeightPx }, { width: innerWidth * factor, height: innerHeight * factor });
    for (const key of ["left", "top", "width", "height"]) popup.style[key] = `${position[key]}px`;
    const edge = HDPopup.resolveToolbarPosition(options.popupToolbarPosition, position.placement,
      resetToolbar ? "top" : popup.dataset.toolbarPosition);
    if (popup.dataset.toolbarPosition !== edge) view.setToolbarPosition(edge);
  }

  const view = themeHost.createView({ document, window, popup, language,
    sourceHighlighter: HDPopup.createSourceHighlighter(window, document, "gsm-hoshidicts-match", shadow),
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    appendStructuredImage: HDGlossary.appendStructuredImage,
    parseTagList: HDGlossary.parseTagList,
    getPopupColumns: () => options.popupColumns,
    getImageHoverPreview: () => options.imageHoverPreview,
    getPopupScalePercent: () => options.popupScalePercent,
    customButtons: options.customButtons,
    positionPopup, sourceHighlightEnabled: true,
    onKanjiClick(character, result, anchor, link) {
      if (!kanjiCharacter) {
        clickedKanjiIndex = [...popup.querySelectorAll(".gsm-hoshidicts-kanji-link")].indexOf(link);
        termView = { ...view.captureTermView(), selectedDictionaryTab };
      }
      kanjiCharacter = character;
      renderSample();
      popup.querySelector(".gsm-hoshidicts-kanji-back").focus({ preventScroll: true });
    },
    onAddCustomEntry() { throw new Error("This is a preview. Notes are not saved."); },
    onCustomLinkClick(link) {
      void globalThis.chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_open_external", ...link })
        .catch(error => console.debug("hachidori: preview link could not be opened", error));
    },
    onResultsRendered({ lookupStats, miningActions = [] }) {
      // A visual sample only: the preview never connects to Anki or saves notes.
      for (const { actions } of miningActions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gsm-hoshidicts-mine-button";
        button.disabled = true;
        button.title = "Mine to Anki (preview only)";
        button.setAttribute("aria-label", button.title);
        const icon = document.createElement("span");
        icon.className = "gsm-hoshidicts-mine-icon hd-icon";
        icon.dataset.icon = "add";
        icon.setAttribute("aria-hidden", "true");
        button.append(icon);
        actions.prepend(button);
      }
      sampleLookupStats = lookupStats;
      paintSampleLookupStats();
      updateSampleAudio();
      definitionReveal.sync();
    },
  });

  function updateSampleAudio() {
    const available = options.audioSources.some(source => source.enabled
      && (source.type.startsWith("text-to-speech") || source.url.trim()));
    for (const control of popup.querySelectorAll(".gsm-hoshidicts-audio-control")) {
      if (control.hidden !== !available) control.hidden = !available;
    }
  }

  // A static sample count; the switch only paints or hides the rendered slot.
  function paintSampleLookupStats() {
    if (!sampleLookupStats?.isConnected) return;
    view.setLookupStats(sampleLookupStats, options.showLookupCounts ? { lookupCount: 3, seenCount: null } : null);
  }

  function createSample() {
    const enabled = state.dictionaries.filter(entry => entry.enabled);
    const definitions = enabled.filter(entry => entry.termCount > 0);
    const first = definitions[0]?.title || "Sample dictionary";
    const preferred = definitions.find(entry => entry.title === options.compactDefinitionSummaryDictionary)?.title;
    const second = preferred && preferred !== first ? preferred : definitions[1]?.title || "Sample usage";
    const pitch = enabled.find(entry => entry.title === options.pitchAccentFuriganaDictionary && entry.pitchCount > 0)?.title
      || enabled.find(entry => entry.pitchCount > 0)?.title || "Sample pitch";
    // A dictionary without a declared mode is a rank list (CC100, BCCWJ, …),
    // so it gets the rank sample; only a declared occurrence list gets a count.
    const installedFrequencies = enabled
      .filter(entry => entry.frequencyCount > 0 && !["Sample ranks", "Sample corpus"].includes(entry.title))
      .map(entry => ({ dictionary: entry.title, frequencies: [entry.frequencyMode === "occurrence-based"
        ? { value: 18240, displayValue: "18,240" } : { value: 120, displayValue: "120" }] }));
    // Tag-bank tags in Jitendex's four categories, a part of speech and one
    // without a category, sorted as the engine sends them, so the tag colours
    // show here in every palette.
    const sampleTag = (name, category, order, notes) => ({ name, category, order, score: 0, notes });
    const verbTags = [sampleTag("v1", "partOfSpeech", 0, "Ichidan verb"), sampleTag("vt", "default", 0, "")];
    const glossary = (dictionary, items, tags = verbTags) => ({ dictionary, glossary: JSON.stringify(items),
      definitionTags: tags.map(tag => tag.name).join(" "), termTags: "common", tags });
    const entry = language.code !== "ja" ? packSample?.entry ?? null : null;
    const results = entry ? languageSampleResults(entry, { first, second, installedFrequencies, sampleTag, glossary })
      : [{ matched: "食べる", deinflected: "食べる", trace: [], preprocessorSteps: 0,
        term: { expression: "食べる", reading: "たべる", rules: "v1", score: 0,
          glossaries: [
            glossary(first, ["to eat", "to live on (e.g. a salary)", "to have a meal"], [...verbTags,
              sampleTag("priority\u00a0form", "frequent", 1, "high priority spelling or reading of this term"),
              sampleTag("★", "popular", 2, "high priority entry")]),
            glossary(second, [{ type: "structured-content", content: [
              { tag: "p", content: "朝ごはんを食べる。 — To eat breakfast." },
              { tag: "img", path: "sample-meal.svg", width: 160, height: 80, title: "A bowl of rice and chopsticks" },
              { tag: "details", content: [{ tag: "summary", content: "Usage note" },
                { tag: "p", content: "食べる is an ichidan verb. Its polite form is 食べます。" }] },
            ] }], [sampleTag("rarely\u00a0used\u00a0form", "archaism", 0, "rarely used form of this term"),
              sampleTag("special\u00a0reading", "expression", 1, "an idiomatic reading of a kanji compound")]),
            glossary("Sample collocations", ["ご飯を食べる — to eat a meal", "外で食べる — to eat out"]),
            glossary("Sample expressions", ["食べてみる — to try a food", "食べ終わる — to finish eating"]),
          ],
          frequencies: [
            { dictionary: "Sample ranks", frequencies: [{ value: 120, displayValue: "120" }, { value: 240, displayValue: "240" }] },
            { dictionary: "Sample corpus", frequencies: [{ value: 18240, displayValue: "18,240" }] },
            ...installedFrequencies,
          ],
          // The engine's shape for Yomitan's string form: the pattern beside a
          // placeholder position of 0.
          pitches: [{ dictionary: pitch, pitches: [{ position: 0, pattern: "LHL", nasal: [], devoice: [] }], transcriptions: ["ta̠be̞ɾɯ̟ᵝ"] }],
        } }];
    return { results, dictionaryPresentation: [
      { title: "Sample ranks", frequencyMode: "rank-based", frequencyCount: 2 },
      { title: "Sample corpus", frequencyMode: "occurrence-based", frequencyCount: 1 }, ...enabled,
    ] };
  }

  // Core's scaffolding (a second dictionary, frequencies, tags, an image and
  // structured content) around the pack's `host.sample.entry` (11.5).
  function languageSampleResults(entry, { first, second, installedFrequencies, sampleTag, glossary }) {
    const tags = String(entry.definitionTags || "").split(" ").filter(Boolean)
      .map((name, index) => sampleTag(name, "partOfSpeech", index, ""));
    const glosses = Array.isArray(entry.glossary) ? entry.glossary : [String(entry.glossary ?? "")];
    const practice = packSample?.practice?.text ?? entry.expression;
    return [{ matched: entry.matched || entry.expression, deinflected: entry.expression,
      trace: (entry.trace ?? []).map(name => ({ name: String(name), description: "" })), preprocessorSteps: 0,
      term: { expression: entry.expression, reading: entry.reading ?? entry.expression, rules: entry.definitionTags ?? "", score: 0,
        glossaries: [
          glossary(first, glosses, tags),
          glossary(second, [{ type: "structured-content", content: [
            { tag: "p", content: practice },
            { tag: "img", path: "sample-meal.svg", width: 160, height: 80, title: "A bowl of rice and chopsticks" },
            { tag: "details", content: [{ tag: "summary", content: "Usage note" }, { tag: "p", content: `${entry.expression}: ${glosses[0] ?? ""}` }] },
          ] }], []),
          glossary("Sample collocations", [`${entry.expression} — ${glosses[0] ?? ""}`], []),
          glossary("Sample expressions", [`${entry.matched || entry.expression} — ${glosses.at(-1) ?? ""}`], []),
        ],
        frequencies: [
          { dictionary: "Sample ranks", frequencies: [{ value: 120, displayValue: "120" }, { value: 240, displayValue: "240" }] },
          { dictionary: "Sample corpus", frequencies: [{ value: 18240, displayValue: "18,240" }] },
          ...installedFrequencies,
        ],
        pitches: [],
      } }];
  }

  function context() {
    const dictionaryTabGroups = state.groups.map(group => ({ ...group, dictionaries: group.dictionaryIds
      .map(id => state.dictionaries.find(entry => entry.id === id && entry.enabled)?.title).filter(Boolean) }));
    const sampleDictionaries = sample.results[0].term.glossaries.map(row => row.dictionary);
    if (["bee", "crystal"].includes(HDReaderOptions.popupRenderer(options.popupTheme))
        && !dictionaryTabGroups.some(group => group.dictionaries.some(title => sampleDictionaries.includes(title)))) {
      dictionaryTabGroups.push(
        { id: "sample-definitions", name: "Sample definitions", dictionaries: [sampleDictionaries[0], "Sample collocations"] },
        { id: "sample-examples", name: "Sample examples", dictionaries: [sampleDictionaries[1], "Sample expressions"] },
      );
    }
    return { ...HDPopup.metadataOptions(options),
      language,
      definitionBlurState: sampleBlurState(),
      showCompactDefinitionSummary: options.showCompactDefinitionSummary,
      compactDefinitionSummaryCount: options.compactDefinitionSummaryCount,
      compactDefinitionSummaryDictionary: options.compactDefinitionSummaryDictionary,
      dictionaryPresentation: sample.dictionaryPresentation,
      dictionaryTabGroups,
      popupImageSources: imageSources,
      async resolveMedia(request) {
        const dictionary = imageSources === null ? request.dictionary : imageSources[0];
        if (!dictionary) throw new Error("No enabled image source in this selection.");
        request.onResolvedSource?.(dictionary);
        sampleMedia ??= fetch("sample-meal.svg").then(response => response.blob()).then(blob => URL.createObjectURL(blob));
        return sampleMedia;
      },
    };
  }

  function renderSample(preserveViewControls = false) {
    if (kanjiCharacter) {
      renderSampleCharacter(preserveViewControls);
    } else {
      view.renderResults(sample.results, candidate, { ...context(), preserveViewControls,
        onDictionaryTabSelected(selection) { selectedDictionaryTab = selection; },
        selectedDictionaryTab: termView?.selectedDictionaryTab, expandAll: termView?.expandAll,
        restoreScrollTop: termView?.restoreScrollTop, disclosures: termView?.disclosures,
      });
      termView = null;
      sampleTermView = true;
      armSampleBlur();
    }
    // The render's own callback ran before sampleTermView was set.
    definitionReveal.sync();
  }

  // The clicked character's sample entry: the pack's, or today's Japanese one.
  function characterSample(dictionary) {
    const packCharacter = language.code !== "ja" ? packSample?.character ?? null : null;
    if (packCharacter !== null) return { ...packCharacter, stats: sampleStats(packCharacter.stats), dictionary };
    return { dictionary, onyomi: "ショク ジキ", kunyomi: "た.べる く.う", tags: "常用",
      definitions: ["eat", "food"], stats: [{ name: "strokes", value: "9" }, { name: "grade", value: "2" }] };
  }

  // A clicked character: a term or group dictionary shows its cards, a
  // character dictionary its entry, outside term blur.
  function renderSampleCharacter(preserveViewControls) {
    const capability = HDReaderOptions.resolveKanjiDictionary(options.kanjiClickDictionary, state.dictionaries, state.groups);
    kanjiSource = capability;
    const renderContext = { ...context(), preserveViewControls, highlightText: candidate.query, onBack() {
      kanjiCharacter = null;
      renderSample();
      popup.querySelectorAll(".gsm-hoshidicts-kanji-link")[clickedKanjiIndex]?.focus({ preventScroll: true });
    } };
    if (capability?.kind === "term" || capability?.kind === "group") {
      renderSampleCharacterCards(capability, renderContext);
      return;
    }
    sampleTermView = false;
    clearSampleBlurTimer();
    view.renderKanji({ character: kanjiCharacter, entries: [characterSample(capability?.title || "Sample kanji")] },
      candidate, { ...renderContext, definitionBlurState: "revealed" });
  }

  // A group compares its members: one card each, in group order, with a tab per member.
  function renderSampleCharacterCards(capability, renderContext) {
    const members = capability.kind === "group" ? capability.members : [capability];
    view.renderResults([{ matched: kanjiCharacter, deinflected: kanjiCharacter, trace: [], preprocessorSteps: 0, term: {
      expression: kanjiCharacter, reading: language.code === "ja" ? "しょく" : kanjiCharacter, rules: "", score: 0,
      glossaries: members.map(member => member.kind === "kanji"
        ? HDPopup.characterEntryResult(kanjiCharacter, characterSample(member.title), language).term.glossaries[0]
        : { dictionary: member.title, glossary: JSON.stringify(["food; eating — sample single-kanji entry"]),
          definitionTags: "", termTags: "" }), frequencies: [], pitches: [],
    } }], candidate, capability.kind === "group"
      ? { ...renderContext, dictionaryTabScope: members.map(member => member.title) } : renderContext);
    sampleTermView = true;
    armSampleBlur();
  }


  // The pack's `host.sample` (entry, practice, character) for languages other
  // than Japanese, which stays in its language.json (docs/languages.md 9.1).
  function loadPackSample(code) {
    packSamples.set(code, null);
    void fetch(new URL(`vendor/languages/${code}/language.json`, document.baseURI))
      .then(response => response.ok ? response.json() : null)
      .then(pack => {
        const loaded = pack?.host?.sample ?? null;
        packSamples.set(code, loaded);
        if (!loaded || language.code !== code || !lastUpdate) return;
        packSample = loaded;
        if (loaded.practice) setScene(loaded.practice, language);
        updateKey = null;
        window.HDDesignPreview.update(...lastUpdate);
      })
      .catch(error => console.debug("hachidori: preview language sample could not be read", error));
  }

  let lastUpdate = null;
  // `profile` is the edited profile (`{ language, packSettings }`) once the
  // records have profiles; without one the preview is today's Japanese one.
  // The edited profile's language (11.1, 11.5) and its pack's sample scene,
  // or today's Japanese one.
  function adoptPreviewLanguage(profile, nextState) {
    const nextLanguageKey = JSON.stringify(profile ? [profile.language, profile.packSettings ?? {}, nextState.revision] : null);
    if (nextLanguageKey === languageKey) return;
    languageKey = nextLanguageKey;
    language = profile ? HDThemeHost.createLanguage(globalThis.HDLanguages?.get?.(profile.language) ?? null,
      { marked: true, packSettings: profile.packSettings ?? {}, dictionaries: nextState.dictionaries })
      : HDThemeHost.createLanguage();
    packSample = language.code === "ja" ? null : packSamples.get(language.code) ?? null;
    setScene(packSample?.practice ?? JAPANESE_SCENE, language);
    kanjiCharacter = null;
    if (language.code !== "ja" && !packSamples.has(language.code)) loadPackSample(language.code);
  }

  // A blur edit restarts the sample decision so its effect is visible.
  function restartSampleBlur() {
    sampleRevealed = false;
    if (sampleTermView) {
      view.setDefinitionBlurState(sampleBlurState());
      armSampleBlur();
    }
    definitionReveal.sync();
  }

  window.HDDesignPreview = { update(nextOptions, nextState, profile = null) {
    lastUpdate = [nextOptions, nextState, profile];
    adoptPreviewLanguage(profile, nextState);
    const themeChanged = HDReaderOptions.popupRenderer(options.popupTheme) !== HDReaderOptions.popupRenderer(nextOptions.popupTheme);
    const toolbarChanged = !state || options.popupToolbarPosition !== nextOptions.popupToolbarPosition;
    const geometryChanged = !state || options.popupColumns !== nextOptions.popupColumns
      || options.glossaryLayoutMode !== nextOptions.glossaryLayoutMode
      || options.popupWidthPx !== nextOptions.popupWidthPx || options.popupHeightPx !== nextOptions.popupHeightPx
      || options.popupScalePercent !== nextOptions.popupScalePercent;
    if (!state || options.sourceHighlightEnabled !== nextOptions.sourceHighlightEnabled) {
      view.setSourceHighlightEnabled(nextOptions.sourceHighlightEnabled);
    }
    appearance.update(nextOptions);
    const cssChanged = customStyle.update(nextOptions.customPopupCss);
    const countsChanged = !state || options.showLookupCounts !== nextOptions.showLookupCounts;
    const blurChanged = !state || DEFINITION_BLUR_KEYS.some(key => options[key] !== nextOptions[key]);
    options = { ...nextOptions };
    void themeHost.sync();
    view.setCustomButtons(options.customButtons);
    updateSampleAudio();
    if (geometryChanged) view.hideImagePreview();
    if (geometryChanged || toolbarChanged) positionPopup(toolbarChanged);
    if (geometryChanged || cssChanged) view.scheduleMasonry();
    if (countsChanged) paintSampleLookupStats();
    if (blurChanged) restartSampleBlur();
    const key = JSON.stringify([HDPopup.metadataOptions(nextOptions),
      nextOptions.popupTheme,
      nextOptions.showCompactDefinitionSummary, nextOptions.compactDefinitionSummaryCount,
      nextOptions.compactDefinitionSummaryDictionary, nextOptions.popupImageSource, nextOptions.kanjiClickDictionary, nextState.revision,
      ...(languageKey === "null" ? [] : [languageKey, packSample !== null])]);
    if (key === updateKey) return;
    updateKey = key;
    state = nextState;
    const nextSources = HDReaderOptions.resolvePopupImageSources(options.popupImageSource, state.dictionaries, state.groups);
    if (JSON.stringify(nextSources) !== JSON.stringify(imageSources)) imageSources = nextSources;
    const nextSample = createSample();
    const nextSampleKey = JSON.stringify(nextSample.results);
    sample = nextSample;
    const changed = themeChanged || (kanjiCharacter
      ? JSON.stringify(kanjiSource) !== JSON.stringify(HDReaderOptions.resolveKanjiDictionary(options.kanjiClickDictionary, state.dictionaries, state.groups))
      : sampleKey !== nextSampleKey);
    sampleKey = nextSampleKey;
    if (changed) {
      if (!kanjiCharacter) termView = { ...view.captureTermView(), selectedDictionaryTab };
      renderSample(true);
    } else {
      view.updateDictionaryPresentation(context());
      definitionReveal.sync();
    }
  } };
  window.addEventListener("pagehide", () => { clearSampleBlurTimer(); customStyle.destroy(); appearance.destroy(); view.destroy(); }, { once: true });
}());
