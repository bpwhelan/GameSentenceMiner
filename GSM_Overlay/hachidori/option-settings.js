// SPDX-License-Identifier: GPL-3.0-or-later

// The stored options' controls in Reading, Word highlighting, Design, Audio
// and Advanced, and the autosave that writes their drafts with a revision
// check. settings.js adopts the committed options.

import { extensionApi as chrome } from "./browser-api.js";
import { createActivationSettings } from "./activation-settings.js";
import { describeErrorOrJson } from "./error-text.js";
import { inferFrequencyDirection } from "./frequency-direction.js";
import { applyPageTheme } from "./settings-dom.js";
import {
  activationLabel, activeSection, adoptOptions, APPEARANCE_CHOICES, characterViewName, clampOption, customButtonController,
  DEFAULT_OPTIONS, DEFINITION_LOOKUP_MODES, DESIGN_OPTION_KEYS, element, FREQUENCY_ORDERS, frequencyModeOrder,
  hasCapability, languageName, METADATA_FIELDS, normaliseKanjiSelection, NUMBER_FIELDS, numberFormat, OPTION_SECTIONS,
  options,
  OPTIONS_SAVE_DELAY_MS, optionsRevision, POPUP_RENDERER_IDS, POPUP_THEME_GROUPS, profileFields,
  renderCurrentOptions, renderExperimentalSettings, renderLanguageCapabilities, renderLowMemoryMode, renderPackSettings,
  savedOptions, send, setSectionStatus,
  syncNavigationStatus, themeStore, updateAnkiSettings, updateAudioSettings, updateDesignPreview,
  updateKeybindSettings, WORD_HIGHLIGHT_SWITCHES, WORKER_TARGET,
} from "./settings.js";
import { dictionaries, dictionaryLabel, dictionaryState } from "./library-settings.js";
import {
  attachDefinitionBlurHandlers, renderDefinitionBlurControls, renderDefinitionBlurFrequencyChoices,
} from "./lookup-stats-settings.js";

let pendingOptions = {}; // NOSONAR: shared with the other Settings modules
let pendingOptionsRevision = 0;
let savingOptions = null; // NOSONAR: shared with the other Settings modules
let optionsSaveCompletion = Promise.resolve();
let optionsTimer = null;
let optionsSaveFailed = false;
let optionsEditRevision = null; // NOSONAR: shared with the other Settings modules
let activationController;
let frequencyDirectionRequest = 0;

// Advanced → Search history (docs/search-history.md): how many lines it keeps,
// Clear history, and its limit, applied here at once when the saved limit is
// lowered (the search page applies it with its next line). Only the saved
// limit prunes: a draft whose save is refused must not delete lines. The
// history is this browser's IndexedDB, which Settings opens when Advanced first
// shows.
let searchHistory = null;
let searchHistoryLimit = null;

function openedSearchHistory() {
  searchHistory ??= import("./search-history.js").then(({ openSearchHistory }) => {
    const store = openSearchHistory({ indexedDB: window.indexedDB });
    store.onChange(() => { void renderSearchHistory(); });
    return store;
  });
  return searchHistory;
}

async function renderSearchHistory() {
  if (activeSection !== "advanced") return;
  const count = element("search-history-count");
  const clear = element("search-history-clear");
  try {
    const store = await openedSearchHistory();
    if (savedOptions.searchHistoryLimit !== searchHistoryLimit) {
      searchHistoryLimit = savedOptions.searchHistoryLimit;
      await store.prune(searchHistoryLimit);
    }
    const kept = await store.count();
    const lines = kept === 1 ? "line" : "lines";
    count.textContent = kept === 0 ? "No lines kept." : `${numberFormat.format(kept)} ${lines} kept.`;
    clear.disabled = kept === 0;
  } catch (error) {
    count.textContent = `Could not read the search history: ${describeErrorOrJson(error)}`;
    clear.disabled = true;
  }
}

async function clearSearchHistory() {
  if (!window.confirm("Clear the search history? Every line the search page kept is deleted.")) return;
  element("search-history-clear").disabled = true;
  setSectionStatus("search-history-status", "Clearing the search history…", "working");
  try {
    await (await openedSearchHistory()).clear();
    setSectionStatus("search-history-status", "Search history cleared.", "ready", true);
  } catch (error) {
    setSectionStatus("search-history-status", `Could not clear the search history: ${describeErrorOrJson(error)}`, "error",
      false, error);
  }
  await renderSearchHistory();
}

function selectionParts(value) {
  if (value && typeof value === "object") {
    return value;
  }
  return typeof value === "string" && value !== ""
    ? { title: value, kind: "" }
    : null;
}

function selectionValue(selection) {
  return selection ? JSON.stringify(selection) : "";
}

function selectionFromValue(value) {
  if (!value) {
    return "";
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return normaliseKanjiSelection(parsed);
    }
  } catch {
    // Legacy title-only values are not JSON.
  }
  return normaliseKanjiSelection(value);
}

function isAvailableFrequencyDictionary(dictionary) {
  return dictionary.enabled !== false && hasCapability(dictionary, "freq");
}

function selectedFrequencyDictionary(title = options.frequencyDictionary) {
  return dictionaries.find((dictionary) => dictionary.title === title
    && isAvailableFrequencyDictionary(dictionary));
}

function normaliseKanjiClickOption() {
  let changed = false;
  const kanjiSelection = selectionParts(options.kanjiClickDictionary);
  if (kanjiSelection?.kind === "tabGroup") {
    if (!dictionaryState.groups.some((group) => group.id === kanjiSelection.id)) {
      options.kanjiClickDictionary = "";
      changed = true;
    }
  } else if (kanjiSelection) {
    const selected = dictionaries.find((entry) => entry.title === kanjiSelection.title);
    const requestedKind = kanjiSelection.kind || (selected && hasCapability(selected, "kanji") ? "kanji" : "term");
    if (!selected || !hasCapability(selected, requestedKind)) {
      options.kanjiClickDictionary = "";
      changed = true;
    } else if (kanjiSelection.kind === "") {
      options.kanjiClickDictionary = { title: kanjiSelection.title, kind: requestedKind };
      changed = true;
    }
  }
  return changed;
}

function renderFrequencyChoices() {
  const select = element("opt-frequency-dictionary");
  if (select === document.activeElement) return;
  const previous = options.frequencyDictionary;
  select.textContent = "";

  const automatic = document.createElement("option");
  automatic.value = "";
  // No sort dictionary: lookups keep your dictionary order, as Yomitan does without one (#575).
  automatic.textContent = "None — dictionary order";
  select.appendChild(automatic);

  const enabled = dictionaries.filter(isAvailableFrequencyDictionary);
  const withFrequencies = new Set(
    enabled.map((entry) => entry.title),
  );
  const groups = [{ label: "Frequency dictionaries", titles: [...withFrequencies] }];
  for (const group of groups) {
    if (group.titles.length === 0) {
      continue;
    }
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const title of group.titles) {
      const dictionary = enabled.find((entry) => entry.title === title);
      const option = document.createElement("option");
      option.value = title;
      option.textContent = dictionary ? dictionaryLabel(dictionary) : title;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  // Keep a removed selection visible rather than silently rewriting the option.
  if (previous !== "" && !withFrequencies.has(previous)) {
    const stale = document.createElement("option");
    stale.value = previous;
    stale.textContent = `${previous} (unavailable)`;
    stale.disabled = true;
    select.appendChild(stale);
  }
  select.value = previous;
}

function renderCursorExitControls() {
  element("opt-hide-on-cursor-exit").checked = options.hidePopupOnCursorExit;
  const delay = element("opt-hide-on-cursor-exit-delay");
  // Like the compact summary count: a focused draft keeps its field enabled.
  if (delay !== document.activeElement) delay.disabled = !options.hidePopupOnCursorExit;
}

// The notice belongs to the personal dictionary, and the Library card says why
// its entries are missing from lookups while it is off.
function renderPersonalDictionaryControls() {
  const enabled = options.personalDictionaryEnabled;
  element("opt-personal-dictionary").checked = enabled;
  element("selection-notice-controls").hidden = !enabled;
  element("custom-dictionary-off").hidden = enabled;
}

function renderCompactSummaryControls() {
  const enabled = options.showCompactDefinitionSummary;
  element("opt-compact-summary").checked = enabled;
  const count = element("opt-summary-count");
  // Disabling Chrome's focused select emits blur before its pending change.
  // Keep that draft's captured revision until the existing focusout boundary.
  if (count !== document.activeElement) count.disabled = !enabled;
  renderPreferredDictionary("opt-summary-dictionary", options.compactDefinitionSummaryDictionary,
    "term", "Automatic — first available definition", enabled);
}

function renderPreferredDictionary(id, preferred, kind, automaticLabel, enabled) {
  const select = element(id);
  if (select === document.activeElement) return;
  select.disabled = !enabled;
  select.replaceChildren(new Option(automaticLabel, ""));
  let available = preferred === "";
  for (const dictionary of dictionaries) {
    if (!hasCapability(dictionary, kind)) continue;
    const label = dictionaryLabel(dictionary) + (dictionary.enabled === false ? " (disabled)" : "");
    select.add(new Option(label, dictionary.title));
    available ||= dictionary.title === preferred;
  }
  // Already-missing sources remain a soft preference, not a lookup filter.
  if (!available) select.add(new Option(`${preferred} (unavailable)`, preferred));
  select.value = preferred;
}

function renderWordHighlightControls() {
  for (const { key, id } of WORD_HIGHLIGHT_SWITCHES) element(id).checked = options[key];
  const style = element("opt-word-highlight-style");
  if (style !== document.activeElement) style.value = options.wordHighlightStyle;
}

function renderMetadataControls() {
  for (const field of METADATA_FIELDS) {
    element(field.id).checked = field.inverted ? !options[field.key] : options[field.key];
  }
  renderDefinitionBlurControls();
  // The dictionary picks the reading's pitch, which also gives the headword's colour.
  renderPreferredDictionary("opt-pitch-dictionary", options.pitchAccentFuriganaDictionary,
    "pitch", "Automatic — first available pitch", options.showPitchAccentFurigana || options.showPitchAccentColors);
  // Like the dictionary picker, a focused style keeps its draft until blur.
  const furiganaStyle = element("opt-pitch-furigana-style");
  if (furiganaStyle !== document.activeElement) {
    furiganaStyle.disabled = !options.showPitchAccentFurigana;
    furiganaStyle.value = options.pitchAccentFuriganaStyle;
  }
  // Each dictionary's tags beside the averages only means something with averages on.
  const averageTags = element("opt-average-frequency-tags");
  if (averageTags !== document.activeElement) averageTags.disabled = !options.averageFrequency;
}

function renderPopupImageSources() {
  const select = element("opt-image-source");
  if (select === document.activeElement) return;
  const source = options.popupImageSource;
  const previous = selectionValue(source);
  select.replaceChildren(new Option("Automatic — current tab", ""));
  let available = source === null;
  function addSource(value, label) {
    const encoded = selectionValue(value);
    select.add(new Option(label, encoded));
    available ||= encoded === previous;
  }
  for (const dictionary of dictionaries) {
    addSource({ kind: "dictionary", title: dictionary.title },
      `Dictionary: ${dictionaryLabel(dictionary)}${dictionary.enabled === false ? " (disabled)" : ""}`);
  }
  for (const group of dictionaryState.groups) {
    addSource({ kind: "tabGroup", id: group.id }, `Group: ${group.name}`);
  }
  if (!available) addSource(source, `${source.title || source.id} (unavailable)`);
  select.value = previous;
}

function renderFrequencyOrder() {
  const order = element("opt-frequency-order");
  if (order !== document.activeElement) order.value = options.frequencyOrder;
  const selected = selectedFrequencyDictionary();
  for (const choice of order.options) {
    choice.disabled = !selected && (choice.value === "ascending" || choice.value === "descending");
  }
  element("opt-frequency-auto").disabled = !selected;
  let hint;
  const remembered = selected ? " Your dictionary choice is remembered." : "";
  if (options.frequencyOrder === "auto") hint = `Automatic sorts by your dictionary order, as Yomitan does without a sort dictionary.${remembered}`;
  else if (options.frequencyOrder === "disabled") hint = "Frequency sorting is off. Your dictionary choice is remembered.";
  else if (!selected) hint = "Choose an available frequency dictionary to use this direction.";
  else if (selected.frequencyMode === "rank-based") hint = "Rank-based: Auto direction puts the lowest numbers first.";
  else if (selected.frequencyMode === "occurrence-based") hint = "Occurrence-based: Auto direction puts the highest numbers first.";
  else hint = `No mode declared: Auto direction compares common and less-common ${languageName()} words; inconclusive results read it as ranks, lowest numbers first.`;
  const hintElement = element("frequency-order-hint");
  if (hintElement.textContent !== hint) hintElement.textContent = hint;
}

async function applyFrequencyDirection() {
  const request = ++frequencyDirectionRequest;
  const dictionary = selectedFrequencyDictionary();
  const revision = optionsRevision;
  const previousOrder = options.frequencyOrder;
  const owns = () => {
    const current = selectedFrequencyDictionary();
    return request === frequencyDirectionRequest && revision === optionsRevision && previousOrder === options.frequencyOrder
      && current?.id === dictionary?.id && current?.path === dictionary?.path && current?.revision === dictionary?.revision
      && current?.frequencyMode === dictionary?.frequencyMode;
  };
  let direction = "auto";
  if (dictionary?.frequencyMode === "rank-based") direction = "ascending";
  else if (dictionary?.frequencyMode === "occurrence-based") direction = "descending";
  else if (dictionary) {
    setOptionsStatus("Unsaved changes…");
    try {
      direction = await inferFrequencyDirection(dictionary, async text => {
        if (!owns()) throw new Error("The frequency dictionary choice changed.");
        const reply = await send("hd_lookup", {
          text, maxResults: 256, scanLength: [...text].length, options: { frequencyOrder: "disabled" },
          ...profileFields(),
        });
        if (!reply.ok) throw new Error(reply.error || "The frequency lookup failed.");
        return reply;
      }) ?? frequencyModeOrder(dictionary.frequencyMode);
    } catch (error) {
      if (!owns()) return;
      setOptionsStatus(`Could not infer frequency direction: ${describeErrorOrJson(error)}`);
      return;
    }
  }
  if (!owns()) return;
  options.frequencyOrder = direction;
  renderFrequencyOrder();
  writeOptions();
}

function appendKanjiGroup(select, enabled, group, availableValues) {
  if (group.titles.length === 0) {
    return;
  }
  const optgroup = document.createElement("optgroup");
  optgroup.label = group.label;
  for (const title of group.titles) {
    const dictionary = enabled.find((entry) => entry.title === title);
    const option = document.createElement("option");
    option.value = selectionValue({ title, kind: group.kind });
    option.textContent = dictionary ? dictionaryLabel(dictionary) : title;
    availableValues.add(option.value);
    optgroup.appendChild(option);
  }
  select.appendChild(optgroup);
}

function selectedKanjiValue(previousSelection, withKanji, withTerms) {
  if (previousSelection?.kind !== "") {
    return selectionValue(previousSelection);
  }
  let kind = "";
  if (withKanji.has(previousSelection.title)) {
    kind = "kanji";
  } else if (withTerms.has(previousSelection.title)) {
    kind = "term";
  }
  return kind === ""
    ? previousSelection.title
    : selectionValue({ title: previousSelection.title, kind });
}

function appendStaleKanjiChoice(select, previousSelection, selectedValue, availableValues) {
  if (!previousSelection || availableValues.has(selectedValue)) {
    return;
  }
  const stale = document.createElement("option");
  stale.value = selectedValue;
  stale.textContent = `${previousSelection.kind === "tabGroup" ? "Group" : previousSelection.title} (not available)`;
  select.appendChild(stale);
}

function appendKanjiGroupChoices(select, availableValues) {
  if (dictionaryState.groups.length === 0) return;
  const optgroup = document.createElement("optgroup");
  optgroup.label = "Groups";
  for (const group of dictionaryState.groups) {
    const option = new Option(group.name, selectionValue({ kind: "tabGroup", id: group.id }));
    availableValues.add(option.value);
    optgroup.appendChild(option);
  }
  select.appendChild(optgroup);
}

function renderKanjiChoices() {
  const select = element("opt-kanji-dictionary");
  // Inventory updates wait for focusout, as the Image source chooser does.
  if (select === document.activeElement) return;
  const previousSelection = selectionParts(options.kanjiClickDictionary);
  select.textContent = "";

  const automatic = document.createElement("option");
  automatic.value = "";
  // A character view's dictionaries are named for its characters (docs/languages.md 7.4).
  const characters = (characterViewName() ?? "Kanji").toLowerCase();
  automatic.textContent = `Automatic — use every ${characters} dictionary`;
  select.appendChild(automatic);

  const enabled = dictionaries.filter((entry) => entry.enabled !== false);
  const withKanji = new Set(
    enabled.filter((entry) => hasCapability(entry, "kanji")).map((entry) => entry.title),
  );
  const withTerms = new Set(
    enabled.filter((entry) => hasCapability(entry, "term")).map((entry) => entry.title),
  );
  const groups = [
    { kind: "kanji", label: `${characters[0].toUpperCase()}${characters.slice(1)} dictionaries`, titles: [...withKanji] },
    {
      kind: "term",
      label: `Term dictionaries — requires a matching single-${characters} entry`,
      titles: [...withTerms],
    },
  ];
  const availableValues = new Set();
  for (const group of groups) {
    appendKanjiGroup(select, enabled, group, availableValues);
  }
  appendKanjiGroupChoices(select, availableValues);

  const selectedValue = selectedKanjiValue(previousSelection, withKanji, withTerms);
  appendStaleKanjiChoice(select, previousSelection, selectedValue, availableValues);
  select.value = selectedValue;
}

// Theme Store renderer names for the Theme select, matching the Store cards.
const rendererLabel = slug => slug === "jl" ? "JL" : slug[0].toUpperCase() + slug.slice(1);

function renderThemeChoices() {
  themeStore.render(options);
  if (activeSection !== "design") return;
  const theme = element("opt-popup-theme");
  if (theme.options.length === 0) {
    for (const group of POPUP_THEME_GROUPS) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const entry of group.themes) optgroup.append(new Option(entry.label, entry.id));
      theme.append(optgroup);
    }
  }
  let storeGroup = [...theme.children].find(group => group.label === "Theme Store");
  if (!storeGroup) {
    storeGroup = document.createElement("optgroup");
    storeGroup.label = "Theme Store";
    for (const slug of POPUP_RENDERER_IDS) storeGroup.append(new Option(rendererLabel(slug), slug));
    theme.append(storeGroup);
  }
  if (theme !== document.activeElement) theme.value = options.popupTheme;
}

function renderCustomCss(force = false) {
  const editor = element("opt-custom-popup-css");
  if ((force || editor !== document.activeElement) && editor.value !== options.customPopupCss) {
    editor.value = options.customPopupCss;
  }
  element("custom-css-count").textContent = `${numberFormat.format(editor.value.length)} characters`;
}

function renderCustomJavascript(force = false) {
  const editor = element("opt-custom-popup-javascript");
  if ((force || editor !== document.activeElement) && editor.value !== options.customPopupJavascript) {
    editor.value = options.customPopupJavascript;
  }
  element("custom-javascript-count").textContent = `${numberFormat.format(editor.value.length)} characters`;
}

// Yomitan's "Scan modifier key" lists No key first. Its empty value is never
// stored: it means lookupMode "hover" and keeps the remembered activationKey.
// No key leaves the keep-open switch on for the next key, as a re-render would.
function renderActivationControls() {
  activationController ??= createActivationSettings({ document, report: message => setOptionsStatus(message) });
  activationController.render(options.lookupMode === "hover" ? "" : options.activationKey);
  element("opt-lookup-sticky").checked = options.lookupMode !== "activation";
  element("opt-lookup-sticky-row").hidden = options.lookupMode === "hover";
  // Child popups name the remembered key, which No key keeps.
  const childPopups = element("opt-definition-lookup-mode");
  childPopups.querySelector('option[value="activation"]').textContent = `Hold ${activationLabel(options.activationKey)}`;
  if (childPopups !== document.activeElement) childPopups.value = options.definitionLookupMode;
  renderScanDelayControls();
}

// Only lookups that need no key wait for the pointer to rest: page lookups
// with No key, and definitions that follow them. Same as page delay is stored
// as null, so it keeps following later page delay edits.
function renderScanDelayControls() {
  const hover = options.lookupMode === "hover";
  const custom = options.definitionScanDelayMs !== null;
  for (const [id, hidden] of [["opt-scan-delay-row", !hover],
    ["opt-definition-scan-delay-row", !hover || options.definitionLookupMode !== "inherit"],
    ["opt-definition-scan-delay-custom", !custom]]) {
    const row = element(id);
    // Hiding a focused control can emit blur before its pending change.
    if (!hidden || !row.contains(document.activeElement)) row.hidden = hidden;
  }
  const mode = element("opt-definition-scan-delay-mode");
  mode.querySelector('option[value="inherit"]').textContent = `Same as page delay (${options.scanDelayMs} ms)`;
  if (mode !== document.activeElement) mode.value = custom ? "custom" : "inherit";
  const delay = element("opt-definition-scan-delay");
  if (delay !== document.activeElement) delay.value = String(options.definitionScanDelayMs ?? options.scanDelayMs);
}

function renderOptions() {
  renderLanguageCapabilities();
  applyPageTheme(document, options);
  for (const field of NUMBER_FIELDS) {
    const input = element(field.id);
    if (input !== document.activeElement) {
      input.value = String(options[field.key]);
    }
  }
  element("opt-hover-enabled").checked = options.hoverEnabled;
  element("opt-japanese-only").checked = options.onlyScanJapaneseText;
  renderPersonalDictionaryControls();
  element("opt-no-result-notice").checked = options.showNoResultNotice;
  element("opt-metadata-only-results").checked = options.showMetadataOnlyResults;
  renderCursorExitControls();
  element("opt-source-highlight").checked = options.sourceHighlightEnabled;
  element("opt-popup-audio-button").checked = options.showPopupAudioButton;
  element("opt-toolbar-search").checked = options.showToolbarSearchButton;
  element("opt-search-click-lookup").checked = options.searchClickLookup;
  element("opt-search-history").checked = options.searchHistoryEnabled;
  void renderSearchHistory();
  element("opt-audio-autoplay").checked = options.audioAutoplay;
  element("opt-smaller-anki-cards").checked = options.smallerAnkiCards;
  renderThemeChoices();
  renderCustomCss();
  renderCustomJavascript();
  customButtonController?.render();
  const toolbar = element("opt-popup-toolbar");
  if (toolbar !== document.activeElement) toolbar.value = options.popupToolbarPosition;
  const imageHoverPreview = element("opt-image-hover-preview");
  if (imageHoverPreview !== document.activeElement) imageHoverPreview.value = options.imageHoverPreview;
  const glossaryLayout = element("opt-glossary-layout");
  if (glossaryLayout !== document.activeElement) glossaryLayout.value = options.glossaryLayoutMode;
  renderActivationControls();
  renderFrequencyOrder();
  renderKanjiChoices();
  renderFrequencyChoices();
  renderCompactSummaryControls();
  renderPopupImageSources();
  renderMetadataControls();
  renderWordHighlightControls();
  renderExperimentalSettings();
  renderLowMemoryMode();
  void renderPackSettings();
  updateDesignPreview();
  updateAudioSettings();
  updateAnkiSettings();
  updateKeybindSettings();
}

function attachOptionHandlers() {
  for (const field of NUMBER_FIELDS) {
    const input = element(field.id);
    input.addEventListener("change", () => {
      options[field.key] = clampOption(field.key, input.value);
      input.value = String(options[field.key]);
      writeOptions();
    });
  }

  element("opt-hover-enabled").addEventListener("change", (event) => {
    options.hoverEnabled = event.target.checked;
    writeOptions();
  });
  for (const field of APPEARANCE_CHOICES) {
    element(field.id).addEventListener("change", (event) => {
      options[field.key] = field.values && !field.values.includes(event.target.value)
        ? DEFAULT_OPTIONS[field.key] : event.target.value;
      if (field.key === "definitionBlurReveal") renderDefinitionBlurControls();
      writeOptions();
    });
  }
  attachDefinitionBlurHandlers();
  element("opt-source-highlight").addEventListener("change", (event) => {
    options.sourceHighlightEnabled = event.target.checked;
    writeOptions();
  });
  element("opt-popup-audio-button").addEventListener("change", (event) => {
    options.showPopupAudioButton = event.target.checked;
    writeOptions();
  });
  element("opt-toolbar-search").addEventListener("change", (event) => {
    options.showToolbarSearchButton = event.target.checked;
    writeOptions();
  });
  element("opt-search-click-lookup").addEventListener("change", (event) => {
    options.searchClickLookup = event.target.checked;
    writeOptions();
  });
  element("opt-search-history").addEventListener("change", (event) => {
    options.searchHistoryEnabled = event.target.checked;
    writeOptions();
  });
  element("search-history-clear").addEventListener("click", () => { void clearSearchHistory(); });
  element("reset-design").addEventListener("click", () => {
    for (const key of DESIGN_OPTION_KEYS) options[key] = DEFAULT_OPTIONS[key];
    customButtonController?.reset();
    renderCustomCss(true);
    renderCustomJavascript(true);
    renderOptions();
    writeOptions();
  });
  element("opt-custom-popup-css").addEventListener("input", event => {
    // This target listener runs before the section's bubbling draft listener.
    optionsEditRevision ??= Math.max(0, optionsRevision);
    options.customPopupCss = event.target.value;
    renderCustomCss();
    writeOptions();
  });
  element("reset-custom-css").addEventListener("click", () => {
    options.customPopupCss = DEFAULT_OPTIONS.customPopupCss;
    renderCustomCss(true);
    writeOptions();
  });
  element("opt-custom-popup-javascript").addEventListener("input", event => {
    optionsEditRevision ??= Math.max(0, optionsRevision);
    options.customPopupJavascript = event.target.value;
    renderCustomJavascript();
    writeOptions();
  });
  element("reset-custom-javascript").addEventListener("click", () => {
    options.customPopupJavascript = DEFAULT_OPTIONS.customPopupJavascript;
    renderCustomJavascript(true);
    writeOptions();
  });
  for (const field of METADATA_FIELDS) {
    element(field.id).addEventListener("change", (event) => {
      options[field.key] = field.inverted ? !event.target.checked : event.target.checked;
      renderMetadataControls();
      writeOptions();
    });
  }
  element("opt-pitch-dictionary").addEventListener("change", (event) => {
    options.pitchAccentFuriganaDictionary = event.target.value;
    writeOptions();
  });
  element("opt-japanese-only").addEventListener("change", (event) => {
    options.onlyScanJapaneseText = event.target.checked;
    writeOptions();
  });
  for (const { key, id } of WORD_HIGHLIGHT_SWITCHES) {
    element(id).addEventListener("change", (event) => {
      options[key] = event.target.checked;
      writeOptions();
    });
  }
  element("opt-smaller-anki-cards").addEventListener("change", (event) => {
    options.smallerAnkiCards = event.target.checked;
    writeOptions();
  });
  element("opt-personal-dictionary").addEventListener("change", (event) => {
    options.personalDictionaryEnabled = event.target.checked;
    renderPersonalDictionaryControls();
    writeOptions();
  });
  element("opt-no-result-notice").addEventListener("change", (event) => {
    options.showNoResultNotice = event.target.checked;
    writeOptions();
  });
  element("opt-metadata-only-results").addEventListener("change", (event) => {
    options.showMetadataOnlyResults = event.target.checked;
    writeOptions();
  });
  element("opt-hide-on-cursor-exit").addEventListener("change", (event) => {
    options.hidePopupOnCursorExit = event.target.checked;
    renderCursorExitControls();
    writeOptions();
  });
  element("opt-low-memory-mode").addEventListener("change", (event) => {
    options.lowMemoryMode = event.target.checked;
    renderLowMemoryMode();
    writeOptions();
  });
  element("opt-dictionary-index-storage").addEventListener("change", (event) => {
    options.dictionaryIndexStorage = event.target.value;
    renderLowMemoryMode();
    writeOptions();
  });
  element("opt-use-less-ram-by-default").addEventListener("change", (event) => {
    options.useLessRamByDefault = event.target.checked;
    writeOptions();
  });
  element("opt-dictionary-entry-storage").addEventListener("change", (event) => {
    options.dictionaryEntryStorage = event.target.value;
    writeOptions();
  });
  element("opt-audio-autoplay").addEventListener("change", (event) => {
    options.audioAutoplay = event.target.checked;
    writeOptions();
  });
  element("opt-compact-summary").addEventListener("change", (event) => {
    options.showCompactDefinitionSummary = event.target.checked;
    renderCompactSummaryControls();
    writeOptions();
  });
  element("opt-summary-dictionary").addEventListener("change", (event) => {
    options.compactDefinitionSummaryDictionary = event.target.value;
    writeOptions();
  });
  element("opt-image-source").addEventListener("change", (event) => {
    // Values come from the canonical descriptors rendered above, not labels.
    options.popupImageSource = event.target.value ? JSON.parse(event.target.value) : null;
    writeOptions();
  });
  // The picker and the keep-open switch together choose one lookup mode, so
  // either control's change reads both.
  const writeActivation = () => {
    const key = element("opt-activation-key").value;
    if (key === "") {
      options.lookupMode = "hover";
    } else {
      options.activationKey = key;
      options.lookupMode = element("opt-lookup-sticky").checked ? "activationSticky" : "activation";
    }
    renderActivationControls();
    writeOptions();
  };
  element("opt-activation-key").addEventListener("change", writeActivation);
  element("opt-lookup-sticky").addEventListener("change", writeActivation);
  element("opt-definition-lookup-mode").addEventListener("change", (event) => {
    options.definitionLookupMode = DEFINITION_LOOKUP_MODES.includes(event.target.value) ? event.target.value : "inherit";
    renderScanDelayControls();
    writeOptions();
  });
  element("opt-definition-scan-delay-mode").addEventListener("change", (event) => {
    // Custom starts from the page delay it was following.
    options.definitionScanDelayMs = event.target.value === "custom" ? options.scanDelayMs : null;
    renderScanDelayControls();
    writeOptions();
  });
  element("opt-definition-scan-delay").addEventListener("change", (event) => {
    options.definitionScanDelayMs = clampOption("definitionScanDelayMs", event.target.value);
    event.target.value = String(options.definitionScanDelayMs);
    writeOptions();
  });

  element("opt-frequency-order").addEventListener("change", (event) => {
    frequencyDirectionRequest++;
    options.frequencyOrder = FREQUENCY_ORDERS.includes(event.target.value) ? event.target.value : "auto";
    renderFrequencyOrder();
    writeOptions();
  });

  element("opt-frequency-dictionary").addEventListener("change", (event) => {
    // A focused native chooser can outlive a dictionary capability change.
    if (event.target.value && !selectedFrequencyDictionary(event.target.value)) {
      event.target.value = options.frequencyDictionary;
      setOptionsStatus("That frequency dictionary is no longer available.");
      return;
    }
    options.frequencyDictionary = event.target.value;
    // Blur set to "Same as sorting" follows this choice.
    renderDefinitionBlurControls();
    void applyFrequencyDirection();
  });
  element("opt-frequency-auto").addEventListener("click", applyFrequencyDirection);

  element("opt-kanji-dictionary").addEventListener("change", (event) => {
    options.kanjiClickDictionary = selectionFromValue(event.target.value);
    writeOptions();
  });
  const optionSections = Object.keys(OPTION_SECTIONS).map(element);
  for (const section of optionSections) {
    section.addEventListener("input", (event) => {
      if (!event.target.id.startsWith("opt-")) return;
      optionsEditRevision ??= Math.max(0, optionsRevision);
      const field = NUMBER_FIELDS.find(({ id, live }) => live && id === event.target.id);
      if (field && event.target.value !== "" && event.target.validity.valid) {
        options[field.key] = Number(event.target.value);
        writeOptions();
      }
    });
    section.addEventListener("change", () => {
      optionsEditRevision = null;
    });
    section.addEventListener("focusout", (event) => {
      optionsEditRevision = null;
      if (event.target.id === "opt-custom-popup-css") renderCustomCss(true);
      if (event.target.id === "opt-custom-popup-javascript") renderCustomJavascript(true);
      if (event.target.id === "opt-frequency-dictionary") renderFrequencyChoices();
      if (event.target.id === "opt-blur-frequency-dictionary") renderDefinitionBlurFrequencyChoices();
      if (event.target.id === "opt-image-source") renderPopupImageSources();
      if (event.target.id === "opt-kanji-dictionary") renderKanjiChoices();
      if (event.target.id === "opt-pitch-dictionary" || event.target.id === "opt-pitch-furigana-style") renderMetadataControls();
      if (event.target.closest("#definition-blur-settings")) {
        renderDefinitionBlurControls();
      }
      if (event.target.id === "opt-summary-dictionary" || event.target.id === "opt-summary-count") renderCompactSummaryControls();
      if (event.target.id === "opt-hide-on-cursor-exit-delay") renderCursorExitControls();
      if (event.target.closest("#opt-scan-delay-row, #opt-definition-scan-delay-row")) renderScanDelayControls();
      const choice = APPEARANCE_CHOICES.find(({ id }) => id === event.target.id);
      if (choice) event.target.value = options[choice.key];
      const field = NUMBER_FIELDS.find(({ id }) => id === event.target.id);
      if (field) event.target.value = String(options[field.key]);
    });
  }
  element("options-retry").addEventListener("click", () => {
    optionsSaveFailed = false;
    pendingOptionsRevision = optionsRevision;
    void flushOptions();
  });
  element("options-use-saved").addEventListener("click", () => {
    window.clearTimeout(optionsTimer);
    optionsTimer = null;
    pendingOptions = {};
    optionsEditRevision = null;
    optionsSaveFailed = false;
    renderCurrentOptions();
    renderCustomCss(true);
    renderCustomJavascript(true);
    setOptionsStatus("Using saved settings.");
  });
}

function setOptionsStatus(message, completed = false) {
  let tone = message === "Saved." ? "ready" : "";
  if (optionsSaveFailed) tone = "error";
  setSectionStatus("options-status", message, tone, completed);
  element("options-status").classList.toggle("is-quiet", !optionsSaveFailed
    && ["Saved.", "Saving…", "Unsaved changes…", "Using saved settings."].includes(message));
  element("options-conflict-actions").hidden = !optionsSaveFailed;
}

// Keep only edited fields. A storage event can update the committed snapshot,
// but cannot replace a local draft or authorize a stale draft's write.
function writeOptions() {
  applyPageTheme(document, options);
  themeStore.render(options);
  updateDesignPreview();
  const previous = { ...savedOptions, ...savingOptions?.patch };
  const changes = Object.fromEntries(Object.entries(options).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(previous[key])));
  if (Object.keys(pendingOptions).length === 0) {
    pendingOptionsRevision = optionsEditRevision ?? Math.max(0, optionsRevision);
  }
  pendingOptions = changes;
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  if (optionsSaveFailed) return;
  setOptionsStatus("Unsaved changes…");
  optionsTimer = window.setTimeout(() => { void flushOptions(); }, OPTIONS_SAVE_DELAY_MS);
}

async function flushOptions() {
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  if (savingOptions !== null) return optionsSaveCompletion;
  if (optionsSaveFailed) return;
  if (Object.keys(pendingOptions).length === 0) {
    setOptionsStatus("Saved.");
    return;
  }
  let finishSave;
  optionsSaveCompletion = new Promise(resolve => { finishSave = resolve; });
  // Edits belong to the profile they were made for, which this page edits
  // until they are saved (docs/languages.md 5.3).
  const sent = { patch: pendingOptions, baseRevision: pendingOptionsRevision, fields: profileFields() };
  savingOptions = sent;
  pendingOptions = {};
  setOptionsStatus("Saving…");
  try {
    // A pack's own settings travel beside the option keys (section 7.5).
    const { packSettings, ...optionPatch } = sent.patch;
    const reply = await send("hd_options_write", {
      baseRevision: sent.baseRevision,
      options: optionPatch,
      ...sent.fields,
      ...(packSettings === undefined ? {} : { packSettings }),
    }, WORKER_TARGET);
    if (reply.options) adoptOptions(reply.options);
    if (!reply.ok) {
      throw new Error(reply.error || "the options could not be saved");
    }
    // A newer external event may already have arrived; keep that state, while
    // binding queued edits to the reply we actually committed, not that event.
    pendingOptionsRevision = Math.max(pendingOptionsRevision, reply.options.revision);
    if (optionsEditRevision !== null) {
      optionsEditRevision = Math.max(optionsEditRevision, reply.options.revision);
    }
    setOptionsStatus(Object.keys(pendingOptions).length > 0 ? "Unsaved changes…" : "Saved.", true);
  } catch (error) {
    // A patch for a profile this page no longer edits (another page removed
    // it, and the page moved on) was discarded with that profile's drafts.
    if (sent.fields.profileId === profileFields().profileId) pendingOptions = { ...sent.patch, ...pendingOptions };
    optionsSaveFailed = Object.keys(pendingOptions).length > 0;
    // A reply can be lost after storage commits. Read the current revision for
    // explicit retry; do not silently overwrite it or drop the retained draft.
    try {
      const stored = await chrome.storage.local.get("options");
      adoptOptions(stored.options);
    } catch { /* The draft stays available even while storage is unreachable. */ }
    setOptionsStatus(`Could not save settings: ${describeErrorOrJson(error)}`);
  } finally {
    savingOptions = null;
    syncNavigationStatus("options-status");
    renderCurrentOptions();
    if (!optionsSaveFailed && optionsTimer === null && Object.keys(pendingOptions).length > 0) {
      void flushOptions();
    }
    finishSave();
  }
}

// Saves every pending edit. False while a refused save waits for Save my
// changes or Use saved settings.
async function settlePendingOptions() {
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  for (;;) {
    if (optionsSaveFailed) return false;
    if (savingOptions === null && Object.keys(pendingOptions).length === 0) return true;
    await flushOptions(); // NOSONAR: each pass saves what the previous save left queued
  }
}

async function flushOptionsUntilIdle() {
  if (!await settlePendingOptions()) {
    throw new Error("Save the pending settings before checking AnkiConnect.");
  }
}

// The edited profile was removed elsewhere: its unsaved edits cannot be
// saved anywhere (docs/languages.md 5.3).
function discardPendingOptions() {
  window.clearTimeout(optionsTimer);
  optionsTimer = null;
  pendingOptions = {};
  optionsEditRevision = null;
  optionsSaveFailed = false;
}

export {
  attachOptionHandlers, discardPendingOptions, flushOptionsUntilIdle, isAvailableFrequencyDictionary,
  normaliseKanjiClickOption, optionsEditRevision, pendingOptions, renderOptions, renderSearchHistory,
  renderThemeChoices, renderWordHighlightControls, savingOptions, selectedFrequencyDictionary, setOptionsStatus,
  settlePendingOptions, writeOptions
};
