/*
 * Settings page: section navigation and status, the controllers of the larger
 * sections, engine status, storage events and start-up. The Library,
 * Add dictionaries, Updates, the personal dictionary, lookup counts and the
 * option controls live in their own *-settings.js modules, which import from
 * each other and from this one. A binding is assigned only in the module that
 * declares it; the others read it through the import.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { extensionApi as chrome, isFirefox } from "./browser-api.js";
import "./reader-options.js";
import { createAudioSettingsController } from "./audio-settings.js";
import { createKeybindSettingsController } from "./keybind-settings.js";
import { createAnkiTemplateSettingsController } from "./anki-settings.js";
import { createLocalAudioSetup } from "./local-audio-setup.js";
import { createBackupSettingsController } from "./backup-settings.js";
import { createExperimentalSettings } from "./experimental-settings.js";
import { createThemeStore } from "./theme-store.js";
import { createMemorySettings } from "./memory-settings.js";
import { downloadBlob } from "./blob-download.js";
import { collectDebugInfo, debugInfoBlob, debugInfoFilename } from "./debug-info.js";
import { captureDebugLog, captureDocumentActions, openDebugLogStore, recordUserError, setDebugLogLanguages } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import { createSharingSettingsController } from "./sharing-settings.js";
import { ANKI_ADDON_FILE_NAME, fetchAnkiAddon } from "./anki-addon.js";
import { createLocalFileAccessController } from "./local-file-access.js";
import { createSettingsSearch } from "./settings-search.js";
import { setStatusOutput, showErrorCopy } from "./settings-dom.js";
import { HOST_CAPABILITIES, MINING_CAPABILITIES, OVERLAY_MODE } from "./overlay-mode.js";
import { createRecommendedInstallClient } from "./recommended-install-client.js";
import { createCustomButtonSettings } from "./custom-button-settings.js";
import { createDictionaryNameDrafts } from "./dictionary-name-drafts.js";
import { createDictionaryGroupController } from "./dictionary-groups.js";
import { CUSTOM_DICTIONARY_SOURCE_KEY } from "./custom-dictionary.js";
import { SETUP_STATE_KEY, normaliseSetupState, setupIncomplete } from "./setup-state.js";
import {
  attachGroupHandlers, attachLibraryHandlers, bindNameDraft, commitGroups, committing, dictionaries,
  dictionaryLabel, dictionaryState, handleDictionaryStateChange, moveListItem, pendingDictionaryCommits,
  reloadDictionaries, removing, renderChangedDictionaryState, renderDeferredAfterBlur, renderLibraryResetLabel,
  renderOtherLanguageDictionaries, reprojectDictionaryState, setControlsDisabled, setPendingManagementFocus,
  settleDictionaryCommits, storedDictionaryState, updateItemById,
} from "./library-settings.js";
import {
  attachImportHandlers, attachRecommendedHandlers, importing, installingRecommended,
  renderRecommendedCatalogue, renderRecommendedInstallation, setImportState,
} from "./import-settings.js";
import {
  adoptUpdateSettings, attachUpdateHandlers, pendingSchedule, renderUpdateControls, renderUpdatingRows,
  savingSchedule, updating,
} from "./update-settings.js";
import {
  adoptCustomDictionaryRecord, attachCustomDictionaryHandlers, customDictionaryDirty, customEditorLoaded,
  customLoading, customSaving, handleCustomDictionarySourceChange, loadCustomDictionarySource,
  renderCustomDictionaryControls, switchCustomDictionaryLanguage,
} from "./custom-dictionary-settings.js";
import { renderLookupCountsReset, resetLookupCounts } from "./lookup-stats-settings.js";
import {
  attachOptionHandlers, discardPendingOptions, flushOptionsUntilIdle, optionsEditRevision, pendingOptions,
  renderOptions, renderSearchHistory, renderThemeChoices, savingOptions, settlePendingOptions, writeOptions,
} from "./option-settings.js";

// Get debug info includes this page's warnings and errors, the errors it shows
// and what was pressed, changed and opened, from this visit and earlier ones.
captureDocumentActions(document, captureDebugLog(window, {
  context: "settings", store: openDebugLogStore(window.indexedDB),
}));

const TARGET = "hoshidicts-offscreen";
const WORKER_TARGET = "hoshidicts-worker";
const UPDATE_TARGET = "hachidori-updates";
const AUDIO_TARGET = "hachidori-audio";
const SHARING_TARGET = "hachidori-sharing";
const ANKI_TARGET = "hachidori-anki";
const BACKUP_LIFECYCLE_PORT = "hachidori-backup-settings";
const OPTION_SECTIONS = {
  lookup: "Reading",
  "word-highlighting": "Word highlighting",
  design: "Design",
  audio: "Audio",
  anki: "Anki",
  keybinds: "Keybinds",
  // Backup & restore → Automatic backups → Days kept.
  backup: "Backup & restore",
  advanced: "Advanced",
  // A language's own settings (docs/languages.md 7.5).
  languages: "Languages",
  // Dictionaries → Personal dictionary owns its lookup switches.
  "custom-dictionary": "Personal dictionary",
};
const {
  DEFAULT_OPTIONS, DEFINITION_LOOKUP_MODES, FREQUENCY_ORDERS,
  POPUP_THEME_GROUPS, POPUP_RENDERER_IDS, POPUP_THEME_VARIANTS, popupRenderer, DESIGN_OPTION_KEYS, DEFINITION_BLUR_DIRECTIONS,
  DEFINITION_BLUR_REVEALS,
  DEFINITION_BLUR_FREQUENCY_ORDERS, EXPERIMENTAL_FEATURES, WORD_HIGHLIGHT_STYLES, definitionBlurFrequencyDictionary,
  activationLabel, clampOption, frequencyModeOrder, hasCapability, normaliseCustomButtons, normaliseKanjiSelection,
  normaliseOptions, JAPANESE_PROFILE_ID, OPTION_REQUIREMENTS, languageDescriptor, optionRequirementMet,
  hasProfiles, projectOptions, profileDescriptor, LANGUAGE_SELECTION_KEY, normaliseLanguageSelection, activeProfileId,
  languagesEnabled, profiles: recordProfiles,
} = globalThis.HDReaderOptions;
const STATUS_POLL_MS = 1000;
// Slower than the boot poll: a failing poll may be failing for a while, and the
// settings page can be left open.
const STATUS_RETRY_MS = 5000;

const NUMBER_FIELDS = [
  { key: "scanLength", id: "opt-scan-length" },
  { key: "maxResults", id: "opt-max-results" },
  { key: "scanDelayMs", id: "opt-scan-delay" },
  { key: "popupHideDelayMs", id: "opt-hide-delay" },
  { key: "hidePopupOnCursorExitDelayMs", id: "opt-hide-on-cursor-exit-delay" },
  { key: "popupNestingMaxDepth", id: "opt-popup-nesting-depth" },
  { key: "popupColumns", id: "opt-popup-columns" },
  { key: "compactDefinitionSummaryCount", id: "opt-summary-count" },
  { key: "definitionBlurThreshold", id: "opt-blur-threshold" },
  { key: "definitionBlurFrequencyThreshold", id: "opt-blur-frequency-threshold" },
  { key: "popupWidthPx", id: "opt-popup-width", live: true },
  { key: "popupHeightPx", id: "opt-popup-height", live: true },
  { key: "popupScalePercent", id: "opt-popup-scale", live: true },
  { key: "popupOpacityPercent", id: "opt-popup-opacity", live: true },
  { key: "automaticBackupDays", id: "opt-automatic-backup-days" },
  { key: "searchWindowWidthPx", id: "opt-search-window-width" },
  { key: "searchWindowHeightPx", id: "opt-search-window-height" },
  { key: "searchHistoryLimit", id: "opt-search-history-limit" },
];
const METADATA_FIELDS = [
  { key: "showLookupCounts", id: "opt-lookup-counts" },
  { key: "showFrequencyDictionaryNames", id: "opt-frequency-names" },
  { key: "compactFrequencyNumbers", id: "opt-frequency-compact" },
  { key: "averageFrequency", id: "opt-average-frequency" },
  { key: "showFrequencyTagsWithAverage", id: "opt-average-frequency-tags" },
  { key: "showPitchAccentFurigana", id: "opt-pitch-furigana" },
  { key: "showPitchAccentColors", id: "opt-pitch-colors" },
  { key: "showPitchAccentBadge", id: "opt-pitch-badge" },
  { key: "showPitchAccentDictionaryNames", id: "opt-pitch-names" },
  { key: "showPitchAccentText", id: "opt-pitch-text" },
  { key: "showPitchAccentPosition", id: "opt-pitch-position" },
  { key: "showPitchAccentGraph", id: "opt-pitch-graph" },
  { key: "hidePopupGrammarTags", id: "opt-grammar-tags", inverted: true },
];
const APPEARANCE_CHOICES = [
  { key: "popupTheme", id: "opt-popup-theme" },
  { key: "popupThemeVariant", id: "opt-popup-theme-variant", values: POPUP_THEME_VARIANTS },
  { key: "popupToolbarPosition", id: "opt-popup-toolbar" },
  { key: "imageHoverPreview", id: "opt-image-hover-preview" },
  { key: "glossaryLayoutMode", id: "opt-glossary-layout" },
  { key: "pitchAccentFuriganaStyle", id: "opt-pitch-furigana-style" },
  { key: "definitionBlurDirection", id: "opt-blur-direction", values: DEFINITION_BLUR_DIRECTIONS },
  { key: "definitionBlurFrequencyOrder", id: "opt-blur-frequency-order", values: DEFINITION_BLUR_FREQUENCY_ORDERS },
  { key: "definitionBlurReveal", id: "opt-blur-reveal", values: DEFINITION_BLUR_REVEALS },
  { key: "wordHighlightStyle", id: "opt-word-highlight-style", values: WORD_HIGHLIGHT_STYLES },
];
// Reading → Word highlighting (#520).
const WORD_HIGHLIGHT_SWITCHES = [
  { key: "wordHighlightEnabled", id: "opt-word-highlight" },
  { key: "wordHighlightUnknown", id: "opt-word-highlight-unknown" },
  { key: "wordHighlightLearning", id: "opt-word-highlight-learning" },
  { key: "wordHighlightKnown", id: "opt-word-highlight-known" },
  { key: "wordHighlightIgnored", id: "opt-word-highlight-ignored" },
];

const numberFormat = new Intl.NumberFormat();
let options = normaliseOptions({}); // NOSONAR: shared with the other Settings modules
const themeStore = createThemeStore({ root: document.getElementById("theme-store"), design: document.getElementById("design"), onSelect(slug) {
  options.popupTheme = slug;
  renderThemeChoices();
  writeOptions();
}, onDesign: theme => {
  designTheme = theme;
  void renderPackSettings();
}, getLanguage: () => (hasProfiles(storedOptionsRecord) ? editedProfile.language : null) });
let savedOptions = normaliseOptions({}); // NOSONAR: shared with the other Settings modules
let optionsRevision = -1; // NOSONAR: shared with the other Settings modules
const OPTIONS_SAVE_DELAY_MS = 150;
const nameDrafts = createDictionaryNameDrafts({
  delayMs: OPTIONS_SAVE_DELAY_MS,
  afterSave: () => renderChangedDictionaryState(),
});
const recommendedInstallation = createRecommendedInstallClient({
  send: sourceIds => send("hd_setup_install", { sourceIds }, "hachidori-setup"),
  onChange: renderRecommendedInstallation,
  onError(error) { setImportState(`Could not observe dictionary installation: ${describeErrorOrJson(error)}`, "error", error); },
});
let statusTimer = null;
let lastEngineStatus = null; // NOSONAR: shared with the other Settings modules
let requestCounter = 0;
let audioController;
let keybindController;
let ankiController;
let localAudioSetup;
let sharingController;
// The address of the Hachidori this install is linked to, or null.
let sharingLinkedAddress = null; // NOSONAR: shared with the other Settings modules
let backupController;
let backupLifecyclePort = null;
let backupLifecycleReconnectTimer = null;
const backupLifecycleTokens = new Set();
let customButtonController; // NOSONAR: shared with the other Settings modules
let experimentalController;
// Experimental switches apply in the order they were clicked: turning Multiple
// languages off first settles the page's edits, and a click meanwhile waits.
let experimentalToggles = Promise.resolve();
let memoryController;
let backingUp = false; // NOSONAR: shared with the other Settings modules
let settingsSearch;
// The options record as stored, and this browser's language choice
// (docs/languages.md 4.4); the page edits one profile of the record.
let storedOptionsRecord; // NOSONAR: shared with the other Settings modules
let languageSelection = { revision: 0, activeProfileId: null, autoSwitch: false }; // NOSONAR: shared with the other Settings modules
// Advanced → Languages and the sidebar's language link (profile-settings.js),
// loaded once the page has a language registry.
let profileSettings = null;
let editedProfileChosen = false;
// The catalogue entry Design's controls follow, for the pack's display
// settings (docs/languages.md 11.3), and the module that renders a pack's
// settings, loaded once a pack declares some (section 7.5).
let designTheme;
let languageSettings = null;
// Advanced → Languages' status, in SECTION_STATUSES once the card exists.
const LANGUAGE_STATUS = "settings-language-status";

const SECTION_STATUSES = {
  "library-reset-status": { section: "dictionaries", label: "Dictionaries" },
  "import-state": { section: "add-dictionaries", label: "Import" },
  "update-state": { section: "updates", label: "Updates" },
  "custom-dictionary-status": { section: "custom-dictionary", label: "Personal dictionary" },
  "options-status": { section: "lookup", label: "Reading" },
  "lookup-counts-reset-status": { section: "lookup", label: "Lookup history" },
  "search-history-status": { section: "advanced", label: "Search history" },
  "dict-group-error": { section: "dictionary-groups", label: "Groups" },
  "backup-status": { section: "backup", label: "Backup" },
  "sharing-status": { section: "sharing", label: "Sharing" },
  "debug-info-status": { section: "advanced", label: "Troubleshooting" },
  "experimental-status": { section: "advanced", label: "Experimental features" },
};
let activeSection = "dictionaries"; // NOSONAR: shared with the other Settings modules
const unseenSectionCompletions = new Set();

function element(id) {
  return document.getElementById(id);
}

// Firefox names its own add-on pages, and grants userScripts only when asked.
function configureFirefoxUi() {
  element("browser-shortcuts-help").textContent = "Firefox runs these on any page. Popup actions need an open popup."
    + " Change them in Firefox's add-on shortcuts.";
  element("browser-shortcuts-open").textContent = "Change in Firefox";
  const renderUserScripts = async () => {
    const granted = await chrome.permissions.contains({ permissions: ["userScripts"] }).catch(() => false);
    element("custom-javascript-allow-row").hidden = granted;
    element("custom-javascript-permission").textContent = granted ? "Firefox lets Hachidori run user scripts."
      : "Firefox asks before Hachidori can run user scripts. Allow them before using this.";
  };
  // Firefox prompts only for a request made while it handles the click.
  element("custom-javascript-allow").addEventListener("click", () => {
    void chrome.permissions.request({ permissions: ["userScripts"] }).catch(() => false).then(renderUserScripts);
  });
  chrome.permissions.onAdded.addListener(renderUserScripts);
  chrome.permissions.onRemoved.addListener(renderUserScripts);
  void renderUserScripts();
}

function configureBrowserUi() {
  if (!HOST_CAPABILITIES.customJavaScript) {
    const customJavascript = element("custom-javascript");
    customJavascript.dataset.settingsUnavailable = "true";
    customJavascript.hidden = true;
  }
  // The search page opens from the browser's shortcuts and toolbar menu,
  // which an overlay host does not have.
  if (!HOST_CAPABILITIES.browserShortcuts) element("search-page-settings").hidden = true;
  if (isFirefox(chrome)) configureFirefoxUi();
}

function sectionHasPendingWork(id) {
  switch (id) {
    case "import-state": return importing || installingRecommended;
    case "update-state": return updating || savingSchedule !== null || pendingSchedule !== null;
    case "custom-dictionary-status": return customLoading || customSaving || customDictionaryDirty();
    case "backup-status": return backingUp;
    case "options-status": return savingOptions !== null || Object.keys(pendingOptions).length > 0;
    default: return false;
  }
}

// A rail destination with views of its own shows them as a row of tabs; the
// first tab is the destination itself (Dictionaries, Reading).
function sectionTabs(section) {
  return [...document.querySelectorAll(".section-tabs")]
    .find(tabs => tabs.querySelector(`a[href="#${section}"]`)) ?? null;
}

function primaryNavigationSection(section) {
  return sectionTabs(section)?.querySelector("a").hash.slice(1) ?? section;
}

// A tab row shows under its own destination while it offers more than one
// view, so Reading has none while Word highlighting is switched off.
function renderSectionTabs() {
  const active = sectionTabs(activeSection);
  for (const tabs of document.querySelectorAll(".section-tabs")) {
    tabs.hidden = tabs !== active || tabs.querySelectorAll("a:not([hidden])").length < 2;
    for (const link of tabs.querySelectorAll("a")) {
      if (tabs === active && link.hash === `#${activeSection}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
}

function renderNavigationStatuses() {
  const messages = new Map();
  for (const [id, { section, label }] of Object.entries(SECTION_STATUSES)) {
    const source = element(id);
    const attention = source.classList.contains("is-error") || unseenSectionCompletions.has(id) || sectionHasPendingWork(id);
    if (section === activeSection || !attention || !source.textContent) continue;
    const navigationSection = primaryNavigationSection(section);
    const status = messages.get(navigationSection) ?? { messages: [], error: false, ready: true };
    status.messages.push(`${label}: ${source.textContent}`);
    status.error ||= source.classList.contains("is-error");
    status.ready &&= source.classList.contains("is-ready");
    messages.set(navigationSection, status);
  }
  for (const notice of document.querySelectorAll(".nav-status")) {
    const status = messages.get(notice.id.slice("nav-status-".length));
    const message = status?.messages.join(" ") ?? "";
    if (notice.textContent !== message) notice.textContent = message;
    notice.classList.toggle("is-error", status?.error === true);
    notice.classList.toggle("is-ready", status?.ready === true && status?.error !== true);
  }
  const compact = element("settings-navigation-status");
  const message = [...document.querySelectorAll(".nav-status")].map(output => output.textContent).filter(Boolean).join(" ");
  if (compact.textContent !== message) compact.textContent = message;
}

function syncNavigationStatus(id) {
  const { section } = SECTION_STATUSES[id];
  if (section === activeSection) unseenSectionCompletions.delete(id);
  renderNavigationStatuses();
}

// `error` is the failure an error message describes, for the debug log.
function setSectionStatus(id, message, tone, completed = false, error = null) {
  const output = element(id);
  setStatusOutput(output, message, tone, error);
  if (completed && SECTION_STATUSES[id].section !== activeSection) unseenSectionCompletions.add(id);
  syncNavigationStatus(id);
}

// Whether an experimental flag that is off hides `section`.
function sectionGated(section) {
  return EXPERIMENTAL_FEATURES.some(feature => feature.section === section && !options.experimental[feature.id])
    || requirementGatedSection(section);
}

// ---------------------------------------------------------------------------
// The language of the profile this page edits (docs/languages.md 5.3 and 7).
// In the single-profile shape the edited profile is Japanese, which meets every
// requirement and keeps every label, so nothing below changes the page.
// ---------------------------------------------------------------------------

let editedProfile = { id: JAPANESE_PROFILE_ID, language: "ja", packSettings: {} }; // NOSONAR: shared with the other Settings modules
let renderedCapabilities = JSON.stringify(["ja", {}]);
const languageLabelOriginals = new WeakMap();

function languageName(code = editedProfile.language) {
  const descriptor = languageDescriptor(code);
  if (typeof descriptor?.name === "string") return descriptor.name;
  if (code === "ja") return "Japanese";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// What a profile's pack calls the characters its character view shows
// ("Kanji" for Japanese), or null without a character view.
function characterViewName(code = editedProfile.language) {
  const view = languageDescriptor(code)?.capabilities?.characterView;
  if (typeof view?.name === "string" && view.name !== "") return view.name;
  return code === "ja" ? "Kanji" : null;
}

// data-requires holds a capability name, "ankiNoteTypeFamilies" or the JSON of
// { "scripts": [...] } (section 7.3).
function parseRequirement(value) {
  if (!value.startsWith("{")) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function requirementMet(requirement) {
  return optionRequirementMet(requirement, editedProfile.language, editedProfile.packSettings);
}

function optionAvailable(key) {
  const requirement = OPTION_REQUIREMENTS[key];
  return requirement === undefined || requirementMet(requirement.requires);
}

// A section the edited profile's language lacks, as Word highlighting without
// word highlighting. It leads to the destination it is a tab of.
function requirementGatedSection(section) {
  const node = element(section);
  return node?.localName === "section" && "requires" in node.dataset
    && !requirementMet(parseRequirement(node.dataset.requires));
}

// Flat options as a profile without a requirement reads them: each setting it
// lacks at its neutral value. The options themselves when nothing is masked.
function maskedOptions(value) {
  let masked = null;
  for (const [key, { requires, neutral }] of Object.entries(OPTION_REQUIREMENTS)) {
    if (requirementMet(requires)) continue;
    masked ??= { ...value };
    masked[key] = neutral;
  }
  return masked ?? value;
}

// Text that names the language ("Japanese text only") names the edited
// profile's; text that names its characters ("Clicked-kanji dictionary")
// names the pack's character view. Japanese keeps today's strings.
function renderLanguageText(selector, from, to) {
  for (const container of document.querySelectorAll(selector)) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!languageLabelOriginals.has(node)) languageLabelOriginals.set(node, node.data);
      const text = languageLabelOriginals.get(node).replaceAll(from, to);
      if (node.data !== text) node.data = text;
    }
  }
}

// One control's requirement for the edited profile's language; true when a
// Design control changed, which the theme filter decides with.
function applyRequirement(node) {
  const unmet = !requirementMet(parseRequirement(node.dataset.requires));
  if (unmet === "requirementUnmet" in node.dataset) return false;
  node.toggleAttribute("data-requirement-unmet", unmet);
  if ("designSetting" in node.dataset) {
    // The theme filter decides with the requirement (theme-store.js).
    if (unmet) node.hidden = true;
    return true;
  }
  if (node.localName === "section") applySectionRequirement(node, unmet);
  else node.hidden = unmet;
  return false;
}

// A gated section hides with its rail link, tab and picker option.
function applySectionRequirement(node, unmet) {
  const id = node.id;
  const hidden = unmet || !sectionAvailable(id);
  const link = document.querySelector(`.settings-nav a[href="#${id}"], .section-tabs a[href="#${id}"]`);
  if (link) (link.closest(".nav-item") ?? link).hidden = hidden;
  const option = element("settings-section").querySelector(`option[value="${id}"]`);
  if (option) option.hidden = hidden;
  node.toggleAttribute("data-settings-gated", hidden);
}

// Section 7.3: hides what the edited profile's language lacks, keeps it in
// storage, and never touches a control while the language meets its
// requirement, so a Japanese profile's page is today's.
function renderLanguageCapabilities() {
  const key = JSON.stringify([editedProfile.language, editedProfile.packSettings]);
  if (key === renderedCapabilities) return;
  renderedCapabilities = key;
  let designChanged = false;
  for (const node of document.querySelectorAll("[data-requires]")) {
    if (applyRequirement(node)) designChanged = true;
  }
  const name = languageName();
  renderLanguageText("[data-language-label]", "Japanese", name);
  renderLanguageText("[data-character-label]", "kanji", (characterViewName() ?? "Kanji").toLowerCase());
  if (designChanged) themeStore.invalidateDesign();
  keybindController?.render();
  if (resolveSection(requestedSection()) !== activeSection) showSettingsSection();
  else renderSectionTabs();
}

// Requests made for a profile name the edited one once the records have
// profiles (docs/languages.md 5.4); in the single-profile shape they are today's.
function profileFields() {
  return hasProfiles(storedOptionsRecord) ? { profileId: editedProfile.id } : {};
}

// The flat options this page shows and edits: the edited profile's, unmasked,
// with its pack's own settings beside them (sections 5.1, 5.3 and 7.5).
function projectEditedOptions(value) {
  if (!hasProfiles(value)) return normaliseOptions(value);
  return { ...projectOptions(value, editedProfile.id, { masked: false }), packSettings: { ...editedProfile.packSettings } };
}

const JAPANESE_EDITED_PROFILE = Object.freeze({ id: JAPANESE_PROFILE_ID, language: "ja", packSettings: {} });

// The profile this browser looks words up in (section 4.4).
function activeProfile() {
  return hasProfiles(storedOptionsRecord) ? activeProfileId(storedOptionsRecord, languageSelection) : JAPANESE_PROFILE_ID;
}

function describedProfile(id) {
  if (hasProfiles(storedOptionsRecord)) return profileDescriptor(storedOptionsRecord, id);
  return id === JAPANESE_PROFILE_ID ? { ...JAPANESE_EDITED_PROFILE } : null;
}

// The profile this page's address names: `settings.html?profile=ar#anki` from
// the popup's Anki button (docs/languages.md 6.3), else null.
function addressedProfile() {
  return new URLSearchParams(window.location.search).get("profile");
}

// The edited profile as the stored record describes it now. It starts as the
// profile the address names, else the active profile, and changes because of
// a storage event only when it is removed elsewhere, or when Multiple
// languages is turned off elsewhere while it is not the active profile: the
// page then shows the active profile, discards the drafts kept for the one it
// left and says so (sections 5.3 and 16.3). True when it changed.
function followEditedProfile() {
  const enabled = languagesEnabled(storedOptionsRecord);
  if (!editedProfileChosen) {
    editedProfileChosen = true;
    const initial = (enabled ? describedProfile(addressedProfile()) : null) ?? describedProfile(activeProfile())
      ?? { ...JAPANESE_EDITED_PROFILE };
    const changed = initial.id !== editedProfile.id;
    editedProfile = initial;
    return changed;
  }
  const current = describedProfile(editedProfile.id);
  if (current !== null && (enabled || current.id === activeProfile())) {
    editedProfile = current;
    return false;
  }
  const left = languageName(editedProfile.language);
  editedProfile = describedProfile(activeProfile()) ?? { ...JAPANESE_EDITED_PROFILE };
  discardProfileDrafts();
  const cause = current === null ? `${left} was removed` : "Multiple languages was turned off";
  profileSettings?.announce(`${cause} in another Hachidori page, so Settings now shows ${languageName()}.`
    + ` Unsaved changes made for ${left} were discarded.`);
  return true;
}

// The edits a removed profile kept: option drafts, the personal dictionary
// source, the Template name and the custom-button form.
function discardProfileDrafts() {
  discardPendingOptions();
  element("opt-anki-template-name").value = "";
  customButtonController?.reset();
}

// Shows the edited profile everywhere this page shows one.
function renderEditedProfile() {
  savedOptions = projectEditedOptions(storedOptionsRecord);
  // Design's theme filter reads the edited language (docs/languages.md 11.5).
  themeStore.invalidateDesign();
  reprojectDictionaryState();
  switchCustomDictionaryLanguage();
  renderCurrentOptions();
  ankiController?.render();
  customButtonController?.render();
  profileSettings?.render();
}

function listOf(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// The language of one of the record's profiles, by name.
function profileLanguageName(profileId) {
  const language = hasProfiles(storedOptionsRecord) ? profileDescriptor(storedOptionsRecord, profileId)?.language : "ja";
  return languageName(language ?? profileId);
}

// Stored records a Settings module reads whole (docs/languages.md 4.3).
function readStoredRecords(keys) {
  return chrome.storage.local.get(keys);
}

// Settings shows chooses the edited profile (section 5.3). Pending option
// edits are saved first, for the profile they were made for; the three
// editors with explicit saves are saved or discarded by the user first.
// Resolves with the message to show when the page stays where it is; `action`
// names what the user is doing, for that message.
async function chooseEditedProfile(id, action = "choosing another language") {
  if (id === editedProfile.id) return null;
  const drafts = [
    customDictionaryDirty() && "the personal dictionary",
    ankiController?.dirty() && "the Template name",
    customButtonController?.dirty() && "the custom button",
  ].filter(Boolean);
  if (drafts.length > 0) {
    return `Save or discard your changes to ${listOf(drafts)} before ${action}.`;
  }
  if (!await settlePendingOptions()) {
    return `Your changes were not saved. Choose Save my changes or Use saved settings before ${action}.`;
  }
  await settleDictionaryCommits();
  if (nameDrafts.hasPendingChanges()) return "Wait for the names you are editing to be saved, then try again.";
  const next = describedProfile(id);
  if (next === null) return "That language was removed in another Hachidori page.";
  editedProfile = next;
  renderEditedProfile();
  return null;
}

function adoptLanguageSelection(value) {
  // Adopted in commit order whatever the revision: the key can disappear and
  // come back lower (section 4.4).
  languageSelection = normaliseLanguageSelection(value);
  profileSettings?.render();
}

// Use for lookups activates the edited profile in this browser (section 16.3).
async function useEditedProfileForLookups() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await send("hd_language_selection_write",
      { baseRevision: languageSelection.revision, activeProfileId: editedProfile.id }, WORKER_TARGET);
    if (reply.selection) adoptLanguageSelection(reply.selection);
    if (reply.ok) return;
    // A conflict means another page chose first; this click still means this language.
    if (reply.conflict !== true) throw new Error(reply.error || "the language could not be chosen");
  }
  throw new Error("the language changed in another page; try again");
}

// Advanced → Languages → Switch language automatically (section 16.3).
async function writeAutoSwitch(enabled) {
  const reply = await send("hd_language_selection_write",
    { baseRevision: languageSelection.revision, autoSwitch: enabled }, WORKER_TARGET);
  if (reply.selection) adoptLanguageSelection(reply.selection);
  if (!reply.ok) throw new Error(reply.error || "the setting could not be saved");
}

// The sidebar's language link leads to Advanced → Languages' Settings shows.
function openLanguages() {
  if (window.location.hash !== "#languages") window.history.pushState(null, "", "#languages");
  showSettingsSection();
  element("settings-language-select")?.focus();
}

// Advanced → Languages needs the language registry; a page without one is a
// Japanese-only page (section 5).
async function loadProfileSettings() {
  if (profileSettings !== null || !globalThis.HDLanguages) return;
  const { createProfileSettings } = await import("./profile-settings.js");
  profileSettings = createProfileSettings({ document, element, send,
    // The rail's Advanced says so when a message needs attention elsewhere,
    // such as the edited language's removal in another page.
    setStatus: (message, tone = "", error = null) => setSectionStatus(LANGUAGE_STATUS, message, tone, false, error),
    openLanguages,
    isLinked: () => sharingLinkedAddress !== null,
    readEditedProfile: () => editedProfile,
    readActiveProfileId: activeProfile,
    readOptionsRecord: () => storedOptionsRecord,
    readDictionaryState: () => storedDictionaryState,
    readSelection: () => languageSelection,
    readRecords: () => chrome.storage.local.get(["options", "dictionaryState", CUSTOM_DICTIONARY_SOURCE_KEY,
      "lookupStats", "wordStatusOverrides"]),
    languageName,
    chooseEditedProfile,
    useEditedProfileForLookups,
    writeAutoSwitch,
    settleEdits: async () => {
      if (!await settlePendingOptions()) throw new Error("Save your changes or use the saved settings first.");
      await settleDictionaryCommits();
    },
    afterProfileChange: async () => {
      const stored = await chrome.storage.local.get(["options", LANGUAGE_SELECTION_KEY]);
      adoptLanguageSelection(stored[LANGUAGE_SELECTION_KEY]);
      adoptOptions(stored.options);
      await reloadDictionaries();
      await refreshStatus();
    },
  });
  SECTION_STATUSES[LANGUAGE_STATUS] = { section: "languages", label: "Languages" };
  profileSettings.render();
  if (activeSection === "languages") profileSettings.refresh();
  await renderPackSettings();
}

// A pack's own settings under Advanced → Languages (section 7.5); the Japanese
// pack declares none, so a Japanese profile's page has neither fieldset.
async function renderPackSettings() {
  if (profileSettings === null) return;
  const descriptor = hasProfiles(storedOptionsRecord) ? languageDescriptor(editedProfile.language) : null;
  const declared = Array.isArray(descriptor?.settings) && descriptor.settings.length > 0;
  if (!declared && languageSettings === null) return;
  languageSettings ??= await import("./language-settings.js");
  languageSettings.renderLanguageSettings({ document, descriptor: declared ? descriptor : null,
    name: languageName(), values: options.packSettings ?? {},
    presentation: designTheme?.language?.presentation === true, themeName: designTheme?.name ?? null,
    onChange(id, value) {
      options.packSettings = { ...options.packSettings, [id]: value };
      writeOptions();
    } });
}

function requestedSection() {
  const fragment = window.location.hash.slice(1);
  return fragment === "settings-content" ? activeSection : fragment;
}

// Sections the host browser cannot offer are marked by configureBrowserUi().
function availableSections() {
  return [...document.querySelectorAll("main > section:not([data-settings-unavailable='true'])")];
}

function sectionAvailable(id) {
  return element(id)?.dataset.settingsUnavailable !== "true";
}

function resolveSection(requested) {
  if (!availableSections().some((section) => section.id === requested)) return "dictionaries";
  // A section the edited profile's language lacks leads to the destination it
  // is a tab of (docs/languages.md 7.3).
  if (requirementGatedSection(requested)) return primaryNavigationSection(requested);
  // A gated section leads to the switch that reveals it.
  return sectionGated(requested) ? "advanced" : requested;
}

function showSettingsSection(focus = false) {
  settingsSearch?.clear();
  const sections = availableSections();
  activeSection = resolveSection(requestedSection());
  setPendingManagementFocus(null);
  for (const section of sections) section.hidden = section.id !== activeSection;
  element("settings-section").value = activeSection;
  renderSectionTabs();
  const primarySection = primaryNavigationSection(activeSection);
  for (const link of document.querySelectorAll(".settings-nav a")) {
    if (link.hash === `#${primarySection}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (Object.hasOwn(OPTION_SECTIONS, activeSection)) {
    SECTION_STATUSES["options-status"] = { section: activeSection, label: OPTION_SECTIONS[activeSection] };
    const slot = element(activeSection).querySelector(".options-feedback-slot");
    if (element("options-feedback").parentElement !== slot) slot.append(element("options-feedback"));
  }
  for (const [id, { section }] of Object.entries(SECTION_STATUSES)) {
    if (section === activeSection) unseenSectionCompletions.delete(id);
  }
  renderNavigationStatuses();
  renderThemeChoices();
  updateDesignPreview();
  updateAudioSettings();
  updateAnkiSettings();
  updateKeybindSettings();
  updateBackupSettings();
  updateSharingSettings();
  void renderSearchHistory();
  if (activeSection === "advanced") refreshAdvancedMemory();
  if (activeSection === "languages") profileSettings?.refresh();
  if (activeSection === "design") {
    customButtonController ??= createCustomButtonSettings({ document,
      readButtons: () => options.customButtons,
      readTemplates: () => options.anki.templates,
      saveButtons: buttons => {
        options.customButtons = normaliseCustomButtons(buttons);
        options.customLinks = options.customButtons.filter(button => button.type === "link")
          .map(({ label, url }) => ({ label, url }));
        writeOptions();
      },
    });
    customButtonController.render();
  }
  if (activeSection === "custom-dictionary" && !customEditorLoaded) void loadCustomDictionarySource();
  if (window.location.hash === "#settings-content") element("settings-content").focus();
  else if (focus) element(activeSection).querySelector("h1").focus();
}

// The edited profile's speech language and Test word (docs/languages.md 13);
// Japanese's are today's.
function audioLanguage() {
  const host = languageDescriptor(editedProfile.language)?.host;
  return { code: editedProfile.language, name: languageName(), speech: host?.ttsLanguage ?? null,
    warmup: host?.sample?.warmup ?? null };
}

function updateAudioSettings() {
  if (activeSection !== "audio") { audioController?.stop(); return; }
  audioController ??= createAudioSettingsController({
    document,
    readSources: () => options.audioSources,
    editSources: sources => {
      options.audioSources = sources;
      localAudioSetup?.render();
      writeOptions();
    },
    send: (type, fields) => send(type, { ...fields, ...profileFields() }, AUDIO_TARGET),
    readLanguage: audioLanguage,
  });
  audioController.render();
  // Audio → Sources → Local Audio Server add-on: an added source joins the list above it.
  localAudioSetup ??= createLocalAudioSetup({ document, readSources: () => options.audioSources,
    isLinked: () => sharingLinkedAddress !== null,
    editSources: sources => { options.audioSources = sources; audioController.render(); writeOptions(); },
  });
  localAudioSetup.render();
}

function updateKeybindSettings() {
  if (activeSection !== "keybinds" || optionsRevision < 0) return;
  keybindController ??= createKeybindSettingsController({ document,
    readKeybinds: () => options.keybinds,
    editKeybinds: keybinds => { options.keybinds = keybinds; writeOptions(); },
    readAudioSources: () => options.audioSources,
    getBrowserCommands: () => chrome.commands.getAll(),
    // Firefox opens its add-on shortcut manager itself; Chrome's is a page.
    openBrowserShortcuts: () => (typeof chrome.commands.openShortcutSettings === "function"
      ? chrome.commands.openShortcutSettings() : chrome.tabs.create({ url: "chrome://extensions/shortcuts" })),
    browserShortcutsAvailable: HOST_CAPABILITIES.browserShortcuts,
    // Toggle option offers what the edited profile's language has (docs/languages.md 7.3),
    // and Switch to the next language is offered once the records have profiles and
    // Multiple languages is on (16.2, 16.3).
    optionAvailable, languageName: () => languageName(),
    actionAvailable: action => action !== "switchLanguage"
      || (hasProfiles(storedOptionsRecord) && languagesEnabled(storedOptionsRecord)),
  });
  keybindController.render();
}

function updateAnkiSettings() {
  if (activeSection !== "anki" || optionsRevision < 0) return;
  ankiController ??= createAnkiTemplateSettingsController({ document, readAnki: () => options.anki,
    capabilities: MINING_CAPABILITIES,
    readExperimental: () => options.experimental,
    // The edited profile's language decides which markers, note-type
    // families and field-name suggestions Anki offers (docs/languages.md 12).
    readProfile: () => editedProfile,
    readButtons: () => options.customButtons,
    editAnki: anki => {
      options.anki = anki;
      customButtonController?.render();
      writeOptions();
    },
    send: async (type, fields) => {
      // Linked checks cannot forward draft endpoint credentials or mappings.
      // Commit them to the host first, then let the host read its saved copy.
      if (["hd_anki_discover", "hd_anki_setup"].includes(type) && sharingLinkedAddress !== null) {
        await flushOptionsUntilIdle();
      }
      // Every Anki request is for the edited profile's Templates (docs/languages.md 5.4).
      return send(type, { ...fields, ...profileFields() }, WORKER_TARGET);
    },
  });
  ankiController.render();
}

// While linked, imported archives go to the host and backups belong to it; the notices say so.
// The two resets act only on this browser's own data, so they wait for Unlink.
function renderSharingLink(value) {
  const wasLinked = sharingLinkedAddress !== null;
  sharingLinkedAddress = typeof value?.client?.address === "string" ? value.client.address : null;
  const linked = sharingLinkedAddress !== null;
  localAudioSetup?.render();
  element("sharing-overlay-preferences").hidden = !linked || !OVERLAY_MODE;
  element("sharing-import-notice").hidden = !linked;
  element("sharing-backup-notice").hidden = !linked;
  element("library-reset-linked").hidden = !linked;
  element("lookup-counts-reset-linked").hidden = !linked;
  element("backup-files").hidden = linked;
  element("automatic-backups").hidden = linked;
  setControlsDisabled(importing);
  renderLookupCountsReset();
  if (wasLinked && !linked) {
    void backupController?.refreshAutomaticBackups();
  }
}

// Advanced → Troubleshooting. A blob download, so it also works in hosts
// without chrome.downloads.
async function downloadDebugInfo() {
  const button = element("debug-info-download");
  button.disabled = true;
  setSectionStatus("debug-info-status", "Collecting debug info… This can take up to half a minute.", "working");
  try {
    const report = await collectDebugInfo({ chrome, window, send,
      targets: { worker: WORKER_TARGET, sharing: SHARING_TARGET, anki: ANKI_TARGET }, context: {
        overlayMode: OVERLAY_MODE, hostCapabilities: HOST_CAPABILITIES, miningCapabilities: MINING_CAPABILITIES,
        linkedTo: sharingLinkedAddress, activeSection, lastEngineStatus, effectiveOptions: options,
        busy: { importing, installingRecommended, updating, removing, committing, customLoading, customSaving,
          backingUp, pendingDictionaryCommits, savingOptions: savingOptions !== null },
        statuses: Object.fromEntries(Object.keys(SECTION_STATUSES).map(id => [id, element(id).textContent])),
      } });
    downloadBlob(document, debugInfoBlob(report), debugInfoFilename(new Date(report.generatedAt)));
    setSectionStatus("debug-info-status", "Debug info downloaded.", "ready", true);
  } catch (error) {
    setSectionStatus("debug-info-status", `Could not collect debug info: ${describeErrorOrJson(error)}`, "error", false, error);
  } finally {
    button.disabled = false;
  }
}

// Save the pinned release through a blob download, including in Electron hosts.
async function downloadAnkiAddon() {
  const archive = await fetchAnkiAddon();
  downloadBlob(document, archive, ANKI_ADDON_FILE_NAME);
}

function updateSharingSettings() {
  if (activeSection !== "sharing") { sharingController?.stop(); return; }
  sharingController ??= createSharingSettingsController({ document,
    send: (type, fields) => send(type, fields, SHARING_TARGET),
    setStatus: (message, tone) => setSectionStatus("sharing-status", message, tone),
    downloadAddon: downloadAnkiAddon,
  });
  sharingController.start();
}

function toggleExperimental(id, enabled) {
  experimentalToggles = experimentalToggles.then(() => applyExperimentalToggle(id, enabled));
  return experimentalToggles;
}

async function applyExperimentalToggle(id, enabled) {
  setSectionStatus("experimental-status", "");
  if (options.experimental[id] === enabled) {
    renderExperimentalSettings();
    return;
  }
  if (id === "multipleLanguages" && !enabled) {
    const refused = await showLookupLanguageFirst();
    if (refused !== null) {
      setSectionStatus("experimental-status", refused, "error");
      // The switch shows the stored flag again.
      renderExperimentalSettings();
      return;
    }
  }
  options.experimental = { ...options.experimental, [id]: enabled };
  renderExperimentalSettings();
  writeOptions();
}

// Turning Multiple languages off returns lookups to Japanese (docs/languages.md
// 16.3), so Settings first shows Japanese, saving the edits made for the
// language it showed. Resolves with the message to show when it stays on.
async function showLookupLanguageFirst() {
  if (!hasProfiles(storedOptionsRecord)) return null;
  if (describedProfile(JAPANESE_PROFILE_ID) === null) {
    return "Japanese is not one of your languages, so lookups would have no language. Add Japanese in Advanced"
      + " → Languages first.";
  }
  return chooseEditedProfile(JAPANESE_PROFILE_ID, "turning off Multiple languages");
}

function renderExperimentalSettings() {
  const features = EXPERIMENTAL_FEATURES.filter(feature => !feature.section || sectionAvailable(feature.section));
  experimentalController ??= createExperimentalSettings({
    document, features, onToggle: (id, enabled) => { void toggleExperimental(id, enabled); },
  });
  experimentalController.render(options.experimental);
  for (const feature of EXPERIMENTAL_FEATURES) {
    if (!feature.section) continue;
    const hidden = !options.experimental[feature.id] || !sectionAvailable(feature.section)
      || requirementGatedSection(feature.section);
    // A gated section is a rail destination or one tab of one.
    const link = document.querySelector(`.settings-nav a[href="#${feature.section}"], .section-tabs a[href="#${feature.section}"]`);
    (link.closest(".nav-item") ?? link).hidden = hidden;
    element("settings-section").querySelector(`option[value="${feature.section}"]`).hidden = hidden;
    // Global search leaves the hidden section's settings out as well.
    element(feature.section).toggleAttribute("data-settings-gated", hidden);
  }
  // A flag that changed elsewhere can hide the visible section, or reveal the
  // one this page was opened on before the stored options arrived.
  if (resolveSection(requestedSection()) !== activeSection) showSettingsSection();
  else renderSectionTabs();
}

// Low memory mode recycles the engine worker, so it needs the threaded engine:
// not when the offscreen document runs the local engine
// (hd_status.threaded false). The memory readout stays either way.
function renderLowMemoryMode() {
  const available = HOST_CAPABILITIES.lowMemoryMode && lastEngineStatus?.threaded !== false;
  element("low-memory-mode").hidden = !available;
  element("opt-low-memory-mode-help").hidden = !available;
  element("low-memory-mode-unavailable").hidden = available;
  element("opt-low-memory-mode").checked = options.lowMemoryMode;
  element("dictionary-entry-storage").hidden = !available;
  element("opt-dictionary-entry-storage").value = options.dictionaryEntryStorage;
  element("opt-dictionary-entry-storage").disabled = options.lowMemoryMode;
  element("dictionary-index-storage").hidden = !available || lastEngineStatus?.storageBackend !== "opfs";
  element("opt-dictionary-index-storage").value = options.dictionaryIndexStorage;
  element("use-less-ram-by-default").hidden = element("dictionary-index-storage").hidden;
  element("opt-use-less-ram-by-default").checked = options.useLessRamByDefault;
  element("opt-use-less-ram-by-default").disabled = options.lowMemoryMode || options.dictionaryIndexStorage !== "auto";
}

function memorySettings() {
  memoryController ??= createMemorySettings({ document, numberFormat, readMemory: () => send("hd_memory"),
    readExtensionTotal: () => send("hd_memory_total") });
  return memoryController;
}

// The readout is asked for on demand, not polled: when Advanced is shown or
// the engine publishes a new generation while it is shown, and when a Library
// row's Details opens. Nothing is requested while the Library is being worked
// on: a rebuilt row shows the last reading.
function refreshMemorySettings() {
  void memorySettings().refresh();
}

// Advanced also measures the whole extension; a row's Details does not.
function refreshAdvancedMemory() {
  refreshMemorySettings();
  void memorySettings().refreshExtensionTotal();
}

function updateBackupSettings() {
  if (activeSection !== "backup") return;
  backupController ??= createBackupSettingsController({
    document, send,
    download: typeof chrome.downloads?.download === "function"
      ? () => send("hd_backup_download", {}, WORKER_TARGET) : null,
    browserName: isFirefox(chrome) ? "Firefox" : "Chrome",
    listAutomatic: () => send("hd_backup_auto_list", {}, WORKER_TARGET),
    trackPreparation: trackBackupPreparation,
    cancelPreparation(token) {
      if (backupLifecycleTokens.has(token)) postBackupLifecycle({ type: "cancel", token });
    },
    checkReady() {
      if (importing || installingRecommended || updating || removing || committing || customLoading || customSaving || pendingDictionaryCommits > 0) {
        throw new Error("Wait for the current dictionary operation to finish, then try again.");
      }
      if (customDictionaryDirty() || customButtonController?.dirty() || ankiController?.dirty()
          || savingOptions !== null || optionsEditRevision !== null
          || Object.keys(pendingOptions).length > 0 || savingSchedule !== null || pendingSchedule !== null
          || nameDrafts.hasPendingChanges()) {
        throw new Error("Save or discard your pending changes before working with a backup.");
      }
    },
    setBusy(value) { backingUp = value; setControlsDisabled(importing); },
    status: (message, tone, completed, error) => setSectionStatus("backup-status", message, tone, completed, error),
    async refresh() {
      const stored = await chrome.storage.local.get(["options", "dictionaryUpdates", CUSTOM_DICTIONARY_SOURCE_KEY]);
      adoptOptions(stored.options);
      adoptUpdateSettings(stored.dictionaryUpdates);
      adoptCustomDictionaryRecord(stored[CUSTOM_DICTIONARY_SOURCE_KEY]);
      await reloadDictionaries();
      await refreshStatus();
    },
  });
}

function connectBackupLifecycle() {
  const port = chrome.runtime.connect({ name: BACKUP_LIFECYCLE_PORT });
  backupLifecyclePort = port;
  port.onDisconnect.addListener(() => {
    if (backupLifecyclePort !== port) return;
    backupLifecyclePort = null;
    if (backupLifecycleTokens.size === 0 || backupLifecycleReconnectTimer !== null) return;
    backupLifecycleReconnectTimer = window.setTimeout(() => {
      backupLifecycleReconnectTimer = null;
      if (backupLifecyclePort !== null || backupLifecycleTokens.size === 0) return;
      try { connectBackupLifecycle(); } catch { /* A later ownership change retries. */ }
    }, 250);
  });
  try {
    for (const token of backupLifecycleTokens) {
      port.postMessage({ type: "track", token, active: true });
    }
  } catch (error) {
    if (backupLifecyclePort === port) backupLifecyclePort = null;
    throw error;
  }
  return port;
}

function postBackupLifecycle(message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let port = backupLifecyclePort;
    try {
      if (port === null) port = connectBackupLifecycle();
      port.postMessage(message);
      return true;
    } catch {
      if (backupLifecyclePort === port) backupLifecyclePort = null;
    }
  }
  return false;
}

function trackBackupPreparation(token, active) {
  if (active) {
    backupLifecycleTokens.add(token);
    postBackupLifecycle({ type: "track", token, active: true });
    return;
  }
  backupLifecycleTokens.delete(token);
  if (backupLifecycleReconnectTimer !== null && backupLifecycleTokens.size === 0) {
    window.clearTimeout(backupLifecycleReconnectTimer);
    backupLifecycleReconnectTimer = null;
  }
  if (backupLifecyclePort !== null) {
    postBackupLifecycle({ type: "track", token, active: false });
  }
}

function updateDesignPreview() {
  if (activeSection !== "design") return;
  let frame = element("design-preview");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "design-preview";
    frame.title = "Live dictionary popup preview";
    frame.addEventListener("load", updateDesignPreview);
    frame.src = "design-preview.html";
    element("preview-canvas").append(frame);
    resizeDesignPreview();
    element("preview-size").addEventListener("change", resizeDesignPreview);
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(resizeDesignPreview).observe(element("preview-viewport"));
    }
  }
  if (frame.style.width !== `${options.popupWidthPx * options.popupScalePercent / 100 + 96}px`
      || frame.style.height !== `${options.popupHeightPx * options.popupScalePercent / 100 + 216}px`) resizeDesignPreview();
  // The preview shows what the edited profile's popups show (docs/languages.md
  // 7.3, 11.5); the single-profile shape names no profile.
  frame.contentWindow.HDDesignPreview?.update(maskedOptions(options), dictionaryState,
    ...(hasProfiles(storedOptionsRecord) ? [editedProfile] : []));
}

function resizeDesignPreview() {
  const viewport = element("preview-viewport");
  const frame = element("design-preview");
  const width = options.popupWidthPx * options.popupScalePercent / 100 + 96;
  const height = options.popupHeightPx * options.popupScalePercent / 100 + 216;
  const scale = element("preview-size").value === "actual" ? 1 : Math.min(1, viewport.clientWidth / width);
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.transform = `scale(${scale})`;
  element("preview-canvas").style.width = `${width * scale}px`;
  element("preview-canvas").style.height = `${height * scale}px`;
}

function attachSettingsNavigation() {
  settingsSearch = createSettingsSearch({ document, navigate(section) {
    if (section && window.location.hash !== `#${section}`) window.history.pushState(null, "", `#${section}`);
    showSettingsSection();
  } });
  const picker = element("settings-section");
  picker.addEventListener("change", (event) => {
    const fragment = `#${event.target.value}`;
    // Native fragment navigation moves focus off the select before hashchange.
    // Preserve arrow-key selection while adding the section to browser history.
    if (window.location.hash !== fragment) window.history.pushState(null, "", fragment);
    showSettingsSection();
  });
  window.addEventListener("hashchange", () => showSettingsSection(document.activeElement !== picker));
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    element("settings-content").focus();
  });
  for (const link of document.querySelectorAll(".settings-nav a, .section-tabs a, .section-action")) {
    link.addEventListener("click", (event) => {
      if (link.hash === window.location.hash
          && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        // The native same-fragment action would move focus back to the section
        // after our heading focus. Modified clicks retain their browser action.
        event.preventDefault();
        showSettingsSection(true);
      }
    });
  }
  showSettingsSection();
}

async function send(type, fields = {}, target = TARGET) {
  requestCounter += 1;
  const reply = await chrome.runtime.sendMessage({
    target,
    type,
    requestId: `${type.replace(/^hd_/, "")}-${requestCounter}`,
    ...fields,
  });
  if (!reply) {
    throw new Error("the extension's service worker did not reply");
  }
  return reply;
}

function setStatus(message, tone, failures = [], error = null) {
  const status = element("engine-status");
  const shown = status.textContent === message && status.classList.contains("is-error");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-ready", tone === "ready");
  renderStatusFailures(failures);
  if (tone !== "error") showErrorCopy(status, null);
  else if (!shown) {
    const detail = failures.map(failure => `${failure.title}: ${failure.error}`).join("\n");
    showErrorCopy(status, recordUserError(window, status.id, message, error, detail), element("engine-status-failures"));
  }
}

// One entry per package the engine could not load, its title and raw load error
// as literal text. Unchanged records keep their nodes across status polls.
function renderStatusFailures(failures) {
  const list = element("engine-status-failures");
  list.hidden = failures.length === 0;
  if (list.childElementCount === failures.length
      && failures.every(({ title, error }, index) => {
        const [renderedTitle, renderedError] = list.children[index].children;
        return renderedTitle.textContent === title && renderedError.textContent === error;
      })) {
    return;
  }
  const items = document.createDocumentFragment();
  for (const { title, error } of failures) {
    const item = document.createElement("li");
    const titleText = document.createElement("span");
    titleText.className = "engine-status-failure-title";
    titleText.textContent = title;
    const errorText = document.createElement("span");
    errorText.className = "engine-status-failure-error";
    errorText.textContent = error;
    item.append(titleText, errorText);
    items.appendChild(item);
  }
  list.replaceChildren(items);
}

function scheduleStatusPoll(delay = STATUS_POLL_MS) {
  if (statusTimer !== null) {
    return;
  }
  statusTimer = setTimeout(() => {
    statusTimer = null;
    void refreshStatus();
  }, delay);
}

async function refreshStatus() {
  let reply;
  try {
    reply = await send("hd_status");
  } catch (error) {
    lastEngineStatus = null;
    // A poll can fail transiently: the service worker can be torn down mid-relay,
    // or the offscreen document can be recreated faster than background.js's
    // retries. Keep polling, or one blip freezes this line on a stale error while
    // the engine finishes booting and every lookup works.
    setStatus(`Cannot reach the engine: ${describeErrorOrJson(error)}`, "error", [], error);
    scheduleStatusPoll(STATUS_RETRY_MS);
    return;
  }
  if (!reply.ok) {
    lastEngineStatus = null;
    // Either a boot failure or background.js's relay giving up, and the two are
    // not distinguishable from here, so retry both: a boot error survives the
    // retry and keeps saying so.
    setStatus(`Engine error: ${reply.error ?? "unknown"}`, "error");
    scheduleStatusPoll(STATUS_RETRY_MS);
    return;
  }
  const previousGeneration = lastEngineStatus?.generation;
  const previousUpdating = lastEngineStatus?.updating?.id ?? null;
  lastEngineStatus = reply;
  renderEngineStatus();
  renderUpdatingRows(previousUpdating, reply.updating?.id ?? null);
  renderLowMemoryMode();
  if (activeSection === "advanced" && reply.ready && !reply.loading && reply.generation !== previousGeneration) {
    refreshAdvancedMemory();
  }
  if (!reply.ready || reply.loading || updating) {
    scheduleStatusPoll();
  }
}

function renderEngineStatus() {
  if (lastEngineStatus === null) return;
  const count = dictionaries.filter((entry) => entry.enabled !== false).length;
  const failed = Array.isArray(lastEngineStatus.failedDictionaries) ? lastEngineStatus.failedDictionaries : [];
  if (lastEngineStatus.ready && failed.length > 0) {
    const subject = failed.length === 1 ? "1 dictionary" : `${numberFormat.format(failed.length)} dictionaries`;
    const pronoun = failed.length === 1 ? "it" : "them";
    setStatus(`Could not load ${subject}. Re-import or remove ${pronoun}; the other dictionaries still work.`, "error", failed);
    return;
  }
  if (lastEngineStatus.ready) {
    if (count === 0 && !lastEngineStatus.loading) {
      setStatus(dictionaries.length === 0
        ? "Ready to add your first dictionary."
        : "Ready. Enable a dictionary in Dictionaries to start reading.");
      return;
    }
    const enabled = count === 1 ? "1 dictionary enabled" : `${numberFormat.format(count)} dictionaries enabled`;
    setStatus(lastEngineStatus.loading ? `Ready, ${enabled}, working…` : `Ready, ${enabled}.`, "ready");
  } else {
    setStatus("Starting the engine and loading dictionaries…");
  }
}

const dictionaryGroupController = createDictionaryGroupController({
  setError: (message) => setSectionStatus("dict-group-error", message, "error"),
  readState: () => dictionaryState,
  readDictionaries: () => dictionaries,
  commitGroups,
  dictionaryLabel,
  moveListItem,
  updateItemById,
  renderDeferredAfterBlur,
  bindNameDraft,
});

function attachHandlers() {
  attachCustomDictionaryHandlers();

  attachImportHandlers();

  attachLibraryHandlers();
  element("lookup-counts-reset").addEventListener("click", () => { void resetLookupCounts(); });
  element("debug-info-download").addEventListener("click", () => { void downloadDebugInfo(); });

  attachGroupHandlers();

  attachRecommendedHandlers();
  attachUpdateHandlers();

  attachOptionHandlers();

  window.addEventListener("beforeunload", (event) => {
    if (!importing && !backingUp && pendingDictionaryCommits === 0 && savingOptions === null && optionsEditRevision === null
        && Object.keys(pendingOptions).length === 0 && savingSchedule === null && pendingSchedule === null
        && !nameDrafts.hasPendingChanges() && !customButtonController?.dirty() && !ankiController?.dirty()) {
      return;
    }
    // Leaving can revoke an import's blob URL or discard a queued settings draft.
    event.preventDefault();
    event.returnValue = "";
  });

  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage?.addListener(recommendedInstallation.receive);
  window.addEventListener("pagehide", recommendedInstallation.stop);
  window.addEventListener("pageshow", event => { if (event.persisted) void recommendedInstallation.request(); });
}

function renderCurrentOptions() {
  options = { ...savedOptions, ...savingOptions?.patch, ...pendingOptions };
  renderOptions();
}

function adoptOptions(value) {
  const revision = Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0;
  if (revision <= optionsRevision) return false;
  optionsRevision = revision;
  // This page's debug log redacts the profiles' languages too (docs/languages.md
  // 8.5); records without profiles leave it as it is.
  if (hasProfiles(value) || hasProfiles(storedOptionsRecord)) {
    setDebugLogLanguages(recordProfiles(value).map(profile => profile.language));
  }
  storedOptionsRecord = value;
  if (followEditedProfile()) {
    renderEditedProfile();
    return true;
  }
  savedOptions = projectEditedOptions(value);
  renderCurrentOptions();
  profileSettings?.render();
  return true;
}

function handleOptionsChange(change) {
  adoptOptions(change.newValue);
  renderLibraryResetLabel();
  renderOtherLanguageDictionaries();
}

function renderSetupResume(value) {
  let incomplete = false;
  try {
    incomplete = setupIncomplete(normaliseSetupState(value));
  } catch {
    // An unreadable setup record hides the resume link; the startup page reports it.
  }
  element("setup-resume").hidden = !incomplete;
}

function handleStorageChange(changes, area) {
  if (area !== "local") {
    return;
  }
  if (changes[SETUP_STATE_KEY]) {
    renderSetupResume(changes[SETUP_STATE_KEY].newValue);
  }
  if (changes.sharing) {
    renderSharingLink(changes.sharing.newValue);
  }
  if (changes[LANGUAGE_SELECTION_KEY]) {
    adoptLanguageSelection(changes[LANGUAGE_SELECTION_KEY].newValue);
  }
  if (changes[CUSTOM_DICTIONARY_SOURCE_KEY]) {
    handleCustomDictionarySourceChange(changes[CUSTOM_DICTIONARY_SOURCE_KEY]);
  }
  if (changes.dictionaryState && !handleDictionaryStateChange(changes.dictionaryState)) {
    return;
  }
  // Advanced → Languages counts each language's dictionaries and lists the
  // languages held without a profile.
  if (changes.dictionaryState) profileSettings?.render();
  if (changes.options || changes.dictionaryState || changes[CUSTOM_DICTIONARY_SOURCE_KEY] || changes.lookupStats
      || changes.wordStatusOverrides) profileSettings?.recordsChanged();
  if (changes.options) {
    handleOptionsChange(changes.options);
  }
  if (changes.dictionaryUpdates) {
    if (adoptUpdateSettings(changes.dictionaryUpdates.newValue)) renderUpdateControls();
  }
  if (changes.automaticBackups) {
    void backupController?.refreshAutomaticBackups();
  }
}

function renderMiningCapabilityHelp() {
  element("audio-mining-help").hidden = MINING_CAPABILITIES.browserSpeech;
}

async function start() {
  configureBrowserUi();
  renderMiningCapabilityHelp();
  element("custom-buttons-settings").disabled = false;
  element("custom-buttons-overlay-help").hidden = !HOST_CAPABILITIES.externalLinkHost;
  if (HOST_CAPABILITIES.localFileAccessPrompt) {
    createLocalFileAccessController({ document, container: element("settings-local-file-access") });
  }
  attachSettingsNavigation();
  renderRecommendedCatalogue();
  attachHandlers();
  const stored = await chrome.storage.local.get(["options", "dictionaryUpdates", SETUP_STATE_KEY, "sharing",
    LANGUAGE_SELECTION_KEY]);
  languageSelection = normaliseLanguageSelection(stored[LANGUAGE_SELECTION_KEY]);
  adoptOptions(stored.options);
  adoptUpdateSettings(stored.dictionaryUpdates);
  renderSetupResume(stored[SETUP_STATE_KEY]);
  renderSharingLink(stored.sharing);
  renderCustomDictionaryControls();
  if (await reloadDictionaries()) {
    writeOptions();
  }
  renderOptions();
  renderUpdateControls();
  await loadProfileSettings();
  await refreshStatus();
  void recommendedInstallation.request();
}

export {
  activationLabel, activeSection, adoptOptions, APPEARANCE_CHOICES, backingUp, characterViewName, clampOption,
  customButtonController, DEFAULT_OPTIONS, DEFINITION_LOOKUP_MODES, definitionBlurFrequencyDictionary,
  DESIGN_OPTION_KEYS, dictionaryGroupController, editedProfile, element, FREQUENCY_ORDERS, frequencyModeOrder,
  hasCapability, languageName, lastEngineStatus, listOf,
  memorySettings, METADATA_FIELDS, nameDrafts, normaliseKanjiSelection, NUMBER_FIELDS, numberFormat,
  OPTION_SECTIONS, optionAvailable, options, OPTIONS_SAVE_DELAY_MS, optionsRevision, POPUP_RENDERER_IDS,
  POPUP_THEME_GROUPS, popupRenderer, profileFields, profileLanguageName, readStoredRecords,
  recommendedInstallation, refreshMemorySettings,
  refreshStatus, renderCurrentOptions,
  renderEngineStatus, renderExperimentalSettings, renderLanguageCapabilities, renderLowMemoryMode, renderPackSettings,
  savedOptions, scheduleStatusPoll, send, storedOptionsRecord,
  setSectionStatus, setStatus, sharingLinkedAddress, syncNavigationStatus, TARGET, themeStore, UPDATE_TARGET,
  updateAnkiSettings, updateAudioSettings, updateDesignPreview, updateKeybindSettings,
  WORD_HIGHLIGHT_SWITCHES, WORKER_TARGET
};

await start();
