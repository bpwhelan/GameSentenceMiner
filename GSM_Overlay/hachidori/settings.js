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

import { extensionApi as chrome } from "./browser-api.js";
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
import { captureDebugLog } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import { createSharingSettingsController } from "./sharing-settings.js";
import { ANKI_ADDON_FILE_NAME, fetchAnkiAddon } from "./anki-addon.js";
import { createLocalFileAccessController } from "./local-file-access.js";
import { createSettingsSearch } from "./settings-search.js";
import { setStatusOutput } from "./settings-dom.js";
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
  reloadDictionaries, removing, renderChangedDictionaryState, renderDeferredAfterBlur, setControlsDisabled,
  setPendingManagementFocus, updateItemById,
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
  adoptCustomDictionaryDocument, attachCustomDictionaryHandlers, customDictionaryDirty, customEditorLoaded,
  customLoading, customSaving, handleCustomDictionarySourceChange, loadCustomDictionarySource,
  renderCustomDictionaryControls,
} from "./custom-dictionary-settings.js";
import { renderLookupCountsReset, resetLookupCounts } from "./lookup-stats-settings.js";
import {
  attachOptionHandlers, flushOptionsUntilIdle, optionsEditRevision, pendingOptions, renderOptions,
  renderThemeChoices, renderWordHighlightControls, savingOptions, writeOptions,
} from "./option-settings.js";

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
  // Dictionaries → Personal dictionary owns its lookup switches.
  "custom-dictionary": "Personal dictionary",
};
const {
  DEFAULT_OPTIONS, DEFINITION_LOOKUP_MODES, FREQUENCY_ORDERS,
  POPUP_THEME_GROUPS, POPUP_RENDERER_IDS, popupRenderer, DESIGN_OPTION_KEYS, DEFINITION_BLUR_DIRECTIONS, DEFINITION_BLUR_REVEALS,
  DEFINITION_BLUR_FREQUENCY_ORDERS, EXPERIMENTAL_FEATURES, WORD_HIGHLIGHT_STYLES, definitionBlurFrequencyDictionary,
  activationLabel, clampOption, hasCapability, normaliseCustomButtons, normaliseKanjiSelection, normaliseOptions,
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
];
const METADATA_FIELDS = [
  { key: "showLookupCounts", id: "opt-lookup-counts" },
  { key: "showFrequencyDictionaryNames", id: "opt-frequency-names" },
  { key: "compactFrequencyNumbers", id: "opt-frequency-compact" },
  { key: "averageFrequency", id: "opt-average-frequency" },
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
  { key: "popupToolbarPosition", id: "opt-popup-toolbar" },
  { key: "imageHoverPreview", id: "opt-image-hover-preview" },
  { key: "glossaryLayoutMode", id: "opt-glossary-layout" },
  { key: "pitchAccentFuriganaStyle", id: "opt-pitch-furigana-style" },
  { key: "definitionBlurDirection", id: "opt-blur-direction", values: DEFINITION_BLUR_DIRECTIONS },
  { key: "definitionBlurFrequencyOrder", id: "opt-blur-frequency-order", values: DEFINITION_BLUR_FREQUENCY_ORDERS },
  { key: "definitionBlurReveal", id: "opt-blur-reveal", values: DEFINITION_BLUR_REVEALS },
  { key: "wordHighlightStyle", id: "opt-word-highlight-style", values: WORD_HIGHLIGHT_STYLES },
];
// Reading → Word highlighting (#520, experimental).
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
} });
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
  onError(error) { setImportState(`Could not observe dictionary installation: ${describeErrorOrJson(error)}`, "error"); },
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
let memoryController;
let backingUp = false; // NOSONAR: shared with the other Settings modules
let settingsSearch;

const SECTION_STATUSES = {
  "library-reset-status": { section: "dictionaries", label: "Dictionaries" },
  "import-state": { section: "add-dictionaries", label: "Import" },
  "update-state": { section: "updates", label: "Updates" },
  "custom-dictionary-status": { section: "custom-dictionary", label: "Personal dictionary" },
  "options-status": { section: "lookup", label: "Reading" },
  "lookup-counts-reset-status": { section: "lookup", label: "Lookup history" },
  "dict-group-error": { section: "dictionary-groups", label: "Groups" },
  "backup-status": { section: "backup", label: "Backup" },
  "sharing-status": { section: "sharing", label: "Sharing" },
  "debug-info-status": { section: "advanced", label: "Troubleshooting" },
};
let activeSection = "dictionaries"; // NOSONAR: shared with the other Settings modules
const unseenSectionCompletions = new Set();

function element(id) {
  return document.getElementById(id);
}

function configureBrowserUi() {
  if (!HOST_CAPABILITIES.customJavaScript) {
    const customJavascript = element("custom-javascript");
    customJavascript.dataset.settingsUnavailable = "true";
    customJavascript.hidden = true;
  }
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

function setSectionStatus(id, message, tone, completed = false) {
  const output = element(id);
  setStatusOutput(output, message, tone);
  if (completed && SECTION_STATUSES[id].section !== activeSection) unseenSectionCompletions.add(id);
  syncNavigationStatus(id);
}

// Whether an experimental flag that is off hides `section`.
function sectionGated(section) {
  return EXPERIMENTAL_FEATURES.some(feature => feature.section === section && !options.experimental[feature.id]);
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
  if (activeSection === "advanced") refreshAdvancedMemory();
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
    send: (type, fields) => send(type, fields, AUDIO_TARGET),
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
    openBrowserShortcuts: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }),
    browserShortcutsAvailable: HOST_CAPABILITIES.browserShortcuts,
  });
  keybindController.render();
}

function updateAnkiSettings() {
  if (activeSection !== "anki" || optionsRevision < 0) return;
  ankiController ??= createAnkiTemplateSettingsController({ document, readAnki: () => options.anki,
    capabilities: MINING_CAPABILITIES,
    readExperimental: () => options.experimental,
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
      return send(type, fields, WORKER_TARGET);
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
    setSectionStatus("debug-info-status", `Could not collect debug info: ${describeErrorOrJson(error)}`, "error");
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

async function toggleExperimental(id, enabled) {
  options.experimental = { ...options.experimental, [id]: enabled };
  // Word highlighting keeps its own switches and style, but its marks must
  // not stay on pages behind a hidden section.
  if (id === "wordHighlighting" && !enabled) {
    options.wordHighlightEnabled = false;
    renderWordHighlightControls();
  }
  renderExperimentalSettings();
  writeOptions();
}

function renderExperimentalSettings() {
  const features = EXPERIMENTAL_FEATURES.filter(feature => !feature.section || sectionAvailable(feature.section));
  experimentalController ??= createExperimentalSettings({
    document, features, onToggle: (id, enabled) => { void toggleExperimental(id, enabled); },
  });
  experimentalController.render(options.experimental);
  for (const feature of EXPERIMENTAL_FEATURES) {
    if (!feature.section) continue;
    const hidden = !options.experimental[feature.id] || !sectionAvailable(feature.section);
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
    browserName: "Chrome",
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
    status: (message, tone, completed) => setSectionStatus("backup-status", message, tone, completed),
    async refresh() {
      const stored = await chrome.storage.local.get(["options", "dictionaryUpdates", CUSTOM_DICTIONARY_SOURCE_KEY]);
      adoptOptions(stored.options);
      adoptUpdateSettings(stored.dictionaryUpdates);
      adoptCustomDictionaryDocument(stored[CUSTOM_DICTIONARY_SOURCE_KEY]);
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
  frame.contentWindow.HDDesignPreview?.update(options, dictionaryState);
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

function setStatus(message, tone, failures = []) {
  const status = element("engine-status");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-ready", tone === "ready");
  renderStatusFailures(failures);
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
    setStatus(`Cannot reach the engine: ${describeErrorOrJson(error)}`, "error");
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
  savedOptions = normaliseOptions(value);
  renderCurrentOptions();
  return true;
}

function handleOptionsChange(change) {
  adoptOptions(change.newValue);
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
  if (changes[CUSTOM_DICTIONARY_SOURCE_KEY]) {
    handleCustomDictionarySourceChange(changes[CUSTOM_DICTIONARY_SOURCE_KEY]);
  }
  if (changes.dictionaryState && !handleDictionaryStateChange(changes.dictionaryState)) {
    return;
  }
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
  // Get debug info includes this page's own recent warnings and errors.
  captureDebugLog(window, { context: "settings" });
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
  const stored = await chrome.storage.local.get(["options", "dictionaryUpdates", SETUP_STATE_KEY, "sharing"]);
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
  await refreshStatus();
  void recommendedInstallation.request();
}

export {
  activationLabel, activeSection, adoptOptions, APPEARANCE_CHOICES, backingUp, clampOption,
  customButtonController, DEFAULT_OPTIONS, DEFINITION_LOOKUP_MODES, definitionBlurFrequencyDictionary,
  DESIGN_OPTION_KEYS, dictionaryGroupController, element, FREQUENCY_ORDERS, hasCapability, lastEngineStatus,
  memorySettings, METADATA_FIELDS, nameDrafts, normaliseKanjiSelection, NUMBER_FIELDS, numberFormat,
  OPTION_SECTIONS, options, OPTIONS_SAVE_DELAY_MS, optionsRevision, POPUP_RENDERER_IDS, POPUP_THEME_GROUPS,
  popupRenderer, recommendedInstallation, refreshMemorySettings, refreshStatus, renderCurrentOptions,
  renderEngineStatus, renderExperimentalSettings, renderLowMemoryMode, savedOptions, scheduleStatusPoll, send,
  setSectionStatus, setStatus, sharingLinkedAddress, syncNavigationStatus, TARGET, themeStore, UPDATE_TARGET,
  updateAnkiSettings, updateAudioSettings, updateDesignPreview, updateKeybindSettings,
  WORD_HIGHLIGHT_SWITCHES, WORKER_TARGET
};

await start();
