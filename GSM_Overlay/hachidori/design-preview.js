// SPDX-License-Identifier: GPL-3.0-or-later
// Static, local sample data; the view itself is the production popup renderer.
(function () {
  "use strict";
  HDVisualNovel.initialize(document.querySelector(".vn-scene"));
  const host = document.getElementById("preview-host");
  const shadow = host.attachShadow({ mode: "open" });
  const appearance = HDPopup.createPopupAppearance(host);
  const customStyle = HDPopup.createCustomPopupStyle(shadow);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "render/reader.css";
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  const iconStylesheet = document.createElement("link");
  iconStylesheet.rel = "stylesheet";
  iconStylesheet.href = "icons.css";
  shadow.append(stylesheet, iconStylesheet, popup);
  const source = document.getElementById("preview-source");
  const sourceOffset = source.textContent.indexOf("食べる");
  const candidate = { query: "食べる", sentence: source.textContent, matchOffset: sourceOffset,
    sourceElements: [source], sourceText: source.textContent, sourceOffset };
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
  // Fixed mature word, count of 3 and native frequency samples; the shared
  // rules, real hover and real delay decide the preview's blur. Nothing is
  // recorded, looked up or sent to Anki.
  const SAMPLE_LOOKUP_COUNT = 3;
  let sampleRevealed = false;
  let sampleBlurTimer = null;
  let sampleTermView = false;
  const DEFINITION_BLUR_KEYS = [
    "showLookupCounts", "definitionBlurEnabled", "definitionBlurAnkiMature",
    "definitionBlurFrequencyEnabled", "definitionBlurFrequencyDictionary",
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
  }

  function armSampleBlur() {
    clearSampleBlurTimer();
    if (sampleBlurState() !== "blurred" || options.definitionBlurReveal !== "timed") return;
    sampleBlurTimer = setTimeout(() => { sampleBlurTimer = null; revealSample(); }, options.definitionBlurDelayMs);
  }

  popup.addEventListener("mouseover", (event) => {
    if (sampleBlurState() === "blurred" && event.target instanceof Element
        && event.target.closest(".gsm-hoshidicts-definitions, .gsm-hoshidicts-compact-definition-summary")) revealSample();
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

  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    buildPitchAccentMorae: HDGlossary.buildPitchAccentMorae,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    appendStructuredImage: HDGlossary.appendStructuredImage,
    parseTagList: HDGlossary.parseTagList,
    getPopupColumns: () => options.popupColumns,
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
      void (globalThis.browser ?? globalThis.chrome).runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_open_external", ...link })
        .catch(error => console.debug("hachidori: preview link could not be opened", error));
    },
    onResultsRendered({ lookupStats }) {
      sampleLookupStats = lookupStats;
      paintSampleLookupStats();
      updateSampleAudio();
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
    const installedFrequencies = enabled
      .filter(entry => entry.frequencyCount > 0 && !["Sample ranks", "Sample corpus"].includes(entry.title))
      .map(entry => ({ dictionary: entry.title, frequencies: [{
        value: entry.frequencyMode === "rank-based" ? 120 : 18240,
        displayValue: entry.frequencyMode === "rank-based" ? "120" : "18,240",
      }] }));
    const glossary = (dictionary, items) => ({ dictionary, glossary: JSON.stringify(items), definitionTags: "v1 vt", termTags: "common" });
    const results = [{ matched: "食べる", deinflected: "食べる", trace: [], preprocessorSteps: 0,
      term: { expression: "食べる", reading: "たべる", rules: "v1", score: 0,
        glossaries: [
          glossary(first, ["to eat", "to live on (e.g. a salary)", "to have a meal"]),
          glossary(second, [{ type: "structured-content", content: [
            { tag: "p", content: "朝ごはんを食べる。 — To eat breakfast." },
            { tag: "img", path: "sample-meal.svg", width: 160, height: 80, title: "A bowl of rice and chopsticks" },
            { tag: "details", content: [{ tag: "summary", content: "Usage note" },
              { tag: "p", content: "食べる is an ichidan verb. Its polite form is 食べます。" }] },
          ] }]),
          glossary("Sample collocations", ["ご飯を食べる — to eat a meal", "外で食べる — to eat out"]),
          glossary("Sample expressions", ["食べてみる — to try a food", "食べ終わる — to finish eating"]),
        ],
        frequencies: [
          { dictionary: "Sample ranks", frequencies: [{ value: 120, displayValue: "120" }, { value: 240, displayValue: "240" }] },
          { dictionary: "Sample corpus", frequencies: [{ value: 18240, displayValue: "18,240" }] },
          ...installedFrequencies,
        ],
        pitches: [{ dictionary: pitch, pitches: [{ position: 2, pattern: "LHL", nasal: [], devoice: [] }], transcriptions: ["ta̠be̞ɾɯ̟ᵝ"] }],
      } }];
    return { results, dictionaryPresentation: [
      { title: "Sample ranks", frequencyMode: "rank-based", frequencyCount: 2 },
      { title: "Sample corpus", frequencyMode: "occurrence-based", frequencyCount: 1 }, ...enabled,
    ] };
  }

  function context() {
    return { ...HDPopup.metadataOptions(options),
      definitionBlurState: sampleBlurState(),
      showCompactDefinitionSummary: options.showCompactDefinitionSummary,
      compactDefinitionSummaryCount: options.compactDefinitionSummaryCount,
      compactDefinitionSummaryDictionary: options.compactDefinitionSummaryDictionary,
      dictionaryPresentation: sample.dictionaryPresentation,
      dictionaryTabGroups: state.groups.map(group => ({ ...group, dictionaries: group.dictionaryIds
        .map(id => state.dictionaries.find(entry => entry.id === id && entry.enabled)?.title).filter(Boolean) })),
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
      const capability = HDReaderOptions.resolveKanjiDictionary(options.kanjiClickDictionary, state.dictionaries, state.groups);
      kanjiSource = capability;
      const renderContext = { ...context(), preserveViewControls, highlightText: candidate.query, onBack() {
        kanjiCharacter = null;
        renderSample();
        popup.querySelectorAll(".gsm-hoshidicts-kanji-link")[clickedKanjiIndex]?.focus({ preventScroll: true });
      } };
      const nativeSample = (dictionary) => ({ dictionary, onyomi: "ショク ジキ", kunyomi: "た.べる く.う", tags: "常用",
        definitions: ["eat", "food"], stats: [{ name: "strokes", value: "9" }, { name: "grade", value: "2" }] });
      if (capability?.kind === "term" || capability?.kind === "group") {
        // A group compares its members: one card each, in group order, with a tab per member.
        const members = capability.kind === "group" ? capability.members : [capability];
        view.renderResults([{ matched: kanjiCharacter, trace: [], term: {
          expression: kanjiCharacter, reading: "しょく", glossaries: members.map(member => ({ dictionary: member.title,
            glossary: member.kind === "kanji" ? HDPopup.kanjiEntryGlossary(nativeSample(member.title))
              : JSON.stringify(["food; eating — sample single-kanji entry"]) })), frequencies: [], pitches: [],
        } }], candidate, capability.kind === "group"
          ? { ...renderContext, dictionaryTabScope: members.map(member => member.title) } : renderContext);
        sampleTermView = true;
        armSampleBlur();
      } else {
        // Native kanji is outside term blur.
        sampleTermView = false;
        clearSampleBlurTimer();
        view.renderKanji({ character: kanjiCharacter, entries: [nativeSample(capability?.title || "Sample kanji")] },
          candidate, { ...renderContext, definitionBlurState: "revealed" });
      }
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
  }

  window.HDDesignPreview = { update(nextOptions, nextState) {
    const toolbarChanged = !state || options.popupToolbarPosition !== nextOptions.popupToolbarPosition;
    const geometryChanged = !state || options.popupColumns !== nextOptions.popupColumns
      || options.popupWidthPx !== nextOptions.popupWidthPx || options.popupHeightPx !== nextOptions.popupHeightPx
      || options.popupScalePercent !== nextOptions.popupScalePercent;
    if (!state || options.sourceHighlightEnabled !== nextOptions.sourceHighlightEnabled) {
      view.setSourceHighlightEnabled(nextOptions.sourceHighlightEnabled);
    }
    appearance.update(nextOptions);
    const cssChanged = customStyle.update(nextOptions.customPopupCss);
    const countsChanged = !state || options.showLookupCounts !== nextOptions.showLookupCounts;
    // A blur edit restarts the sample decision so its effect is visible.
    const blurChanged = !state || DEFINITION_BLUR_KEYS.some(key => options[key] !== nextOptions[key]);
    options = { ...nextOptions };
    view.setCustomButtons(options.customButtons);
    updateSampleAudio();
    if (geometryChanged) view.hideImagePreview();
    if (geometryChanged || toolbarChanged) positionPopup(toolbarChanged);
    if (geometryChanged || cssChanged) view.scheduleMasonry();
    if (countsChanged) paintSampleLookupStats();
    if (blurChanged) {
      sampleRevealed = false;
      if (sampleTermView) {
        view.setDefinitionBlurState(sampleBlurState());
        armSampleBlur();
      }
    }
    const key = JSON.stringify([HDPopup.metadataOptions(nextOptions),
      nextOptions.showCompactDefinitionSummary, nextOptions.compactDefinitionSummaryCount,
      nextOptions.compactDefinitionSummaryDictionary, nextOptions.popupImageSource, nextOptions.kanjiClickDictionary, nextState.revision]);
    if (key === updateKey) return;
    updateKey = key;
    state = nextState;
    const nextSources = HDReaderOptions.resolvePopupImageSources(options.popupImageSource, state.dictionaries, state.groups);
    if (JSON.stringify(nextSources) !== JSON.stringify(imageSources)) imageSources = nextSources;
    const nextSample = createSample();
    const nextSampleKey = JSON.stringify(nextSample.results);
    sample = nextSample;
    const changed = kanjiCharacter
      ? JSON.stringify(kanjiSource) !== JSON.stringify(HDReaderOptions.resolveKanjiDictionary(options.kanjiClickDictionary, state.dictionaries, state.groups))
      : sampleKey !== nextSampleKey;
    sampleKey = nextSampleKey;
    if (changed) {
      if (!kanjiCharacter) termView = { ...view.captureTermView(), selectedDictionaryTab };
      renderSample(true);
    } else view.updateDictionaryPresentation(context());
  } };
  stylesheet.addEventListener("load", () => { appearance.refreshHighlight(); view.scheduleMasonry(); });
  window.addEventListener("pagehide", () => { clearSampleBlurTimer(); customStyle.destroy(); appearance.destroy(); view.destroy(); }, { once: true });
}());
