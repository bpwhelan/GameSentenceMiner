// SPDX-License-Identifier: GPL-3.0-or-later

// Loaded synchronously by the content-script manifest and by side-effect imports
// in extension modules, so every options consumer uses the same stored view.
(function () {
  "use strict";

  const ANKI_FIELDS = ["expression", "reading", "definition", "sentence", "frequency", "pitch", "audio",
    "captureAnimation", "captureAudio", "screenshot"];
  const ANKI_DUPLICATE_SCOPES = ["model", "deck", "all"];
  const ANKI_DUPLICATE_BEHAVIORS = ["prevent", "new", "overwrite"];
  const ANKI_OVERWRITE_MODES = ["coalesce", "coalesce-new", "skip", "append", "prepend", "overwrite"];
  const STABLE_ID_MAX_LENGTH = 256;
  const ANKI_TEMPLATE_CONFIG_KEYS = ["deck", "model", "tags", "fields", "duplicateScope", "duplicateBehavior",
    "captureScreenshot", "fieldTemplates"];
  // `captureScreenshot` only matters once a mapped field asks for {screenshot},
  // so it is on by default: a note type with a picture field gets the viewport
  // screenshot the mining request was made from, and nothing else changes.
  const DEFAULT_ANKI_TEMPLATE = { id: "default", name: "Default", deck: "Default", model: "", tags: ["hachidori"],
    fields: Object.fromEntries(ANKI_FIELDS.map(key => [key, ""])),
    duplicateScope: "model", duplicateBehavior: "prevent",
    captureScreenshot: true, fieldTemplates: null };
  const DEFAULT_ANKI = {
    url: "http://127.0.0.1:8765",
    apiKey: "",
    templates: [DEFAULT_ANKI_TEMPLATE],
    ...Object.fromEntries(ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, DEFAULT_ANKI_TEMPLATE[key]])),
  };
  const DEFAULT_MEDIA_CAPTURE = {
    enabled: false,
    timingMode: "auto",
    includeAnimation: true,
    includeCapturedAudio: true,
    historySeconds: 60,
    clipSeconds: 10,
    videoPreset: "standard",
    estimatedOffsetMs: -500,
    texthooker: { enabled: false, url: "", format: "plain" },
    page: { nativeCues: true, domText: true, autoLearnArea: true },
  };
  // Settings → Advanced → Experimental features. Each entry is one boolean flag
  // under `options.experimental`; `section` names the Settings card the flag
  // reveals. A feature's own settings live where they always did, so turning
  // a flag off keeps them for the next time it is turned on.
  const EXPERIMENTAL_FEATURES = [
    { id: "mediaMining", label: "Media mining", section: "media",
      description: "Record screen and audio clips from the page for Anki notes. Shows the Media capture section." },
    { id: "longKeyScan", label: "Long dictionary entries",
      description: "Find dictionary entries longer than the scan length. The reader collects more page text only when an installed dictionary lists such entries, and the engine reads further only when the text starts like one of them." },
    { id: "mdxImport", label: "MDX dictionaries",
      description: "Import MDict .mdx dictionaries, with their .mdd resource files, from Add dictionaries. Choose the .mdx and its .mdd files together." },
  ];
  const DEFAULT_EXPERIMENTAL = Object.fromEntries(EXPERIMENTAL_FEATURES.map(feature => [feature.id, false]));
  // yomitan-gsm hotkey actions that map onto existing Hachidori behaviour, in
  // Yomitan's menu order and with its labels. `argument` names the editor kind;
  // `scopes` are where Settings offers the action, as in Yomitan's controller.
  const KEYBIND_ACTIONS = [
    { id: "", label: "None", scopes: [] },
    { id: "close", label: "Close" },
    { id: "nextEntry", label: "Go to next entry", argument: "count" },
    { id: "previousEntry", label: "Go to previous entry", argument: "count" },
    { id: "lastEntry", label: "Go to last entry" },
    { id: "firstEntry", label: "Go to first entry" },
    { id: "nextEntryDifferentDictionary", label: "Go to next dictionary" },
    { id: "previousEntryDifferentDictionary", label: "Go to previous dictionary" },
    { id: "historyBackward", label: "Navigate backward in history" },
    { id: "addNote", label: "Add note" },
    { id: "viewNotes", label: "View notes" },
    { id: "playAudio", label: "Play audio" },
    { id: "playAudioFromSource", label: "Play audio from source", argument: "audioSource" },
    { id: "scanSelectedText", label: "Scan selected text", scopes: ["web"] },
    { id: "scanTextAtSelection", label: "Scan text at selection", scopes: ["web"] },
    // Yomitan offers this only inside its popup. Hachidori's popup cannot
    // exist while lookups are off, so the page scope can turn them back on.
    { id: "toggleOption", label: "Toggle option", argument: "option", scopes: ["popup", "web"] },
  ].map(action => ({ scopes: ["popup"], ...action }));
  const KEYBIND_ARGUMENT_DEFAULTS = { count: "1", audioSource: "", option: "" };
  // Yomitan's popup scope, adapted: Hachidori's hover popup never takes focus,
  // so it means "while a popup is open or opening". Web is anywhere on the page.
  const KEYBIND_SCOPES = ["popup", "web"];
  const KEYBIND_MODIFIERS = ["meta", "ctrl", "alt", "shift"];
  // Pressing only these codes records or matches a keybind with a null key.
  const KEYBIND_MODIFIER_CODES = new Set(["AltLeft", "AltRight", "ControlLeft", "ControlRight",
    "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight", "OSLeft", "OSRight"]);
  // Yomitan's default hotkeys without the actions Hachidori has no feature for.
  const DEFAULT_KEYBINDS = [
    ["close", "", "Escape", []],
    ["previousEntry", "3", "PageUp", ["alt"]],
    ["nextEntry", "3", "PageDown", ["alt"]],
    ["lastEntry", "", "End", ["alt"]],
    ["firstEntry", "", "Home", ["alt"]],
    ["previousEntry", "1", "ArrowUp", ["alt"]],
    ["nextEntry", "1", "ArrowDown", ["alt"]],
    ["historyBackward", "", "KeyB", ["alt"]],
    ["addNote", "", "KeyE", ["alt"]],
    ["playAudio", "", "KeyP", ["alt"]],
    ["viewNotes", "", "KeyV", ["alt"]],
  ].map(([action, argument, key, modifiers]) => ({ action, argument, key, modifiers, scopes: ["popup"], enabled: true }));
  const DEFAULT_OPTIONS = {
    scanLength: 16,
    maxResults: 32,
    hoverEnabled: true,
    onlyScanJapaneseText: true,
    showNoResultNotice: true,
    lookupMode: "activationSticky",
    activationKey: "Shift",
    hoverDelayMs: 0,
    popupHideDelayMs: 160,
    popupNestingMaxDepth: 10,
    popupTheme: "default",
    popupToolbarPosition: "auto",
    customPopupCss: "",
    customPopupJavascript: "",
    customLinks: [],
    customButtons: [],
    audioSources: [{ id: "default-tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" }],
    audioAutoplay: false,
    anki: DEFAULT_ANKI,
    mediaCapture: DEFAULT_MEDIA_CAPTURE,
    experimental: DEFAULT_EXPERIMENTAL,
    popupWidthPx: 560,
    popupHeightPx: 420,
    popupScalePercent: 100,
    popupOpacityPercent: 85,
    sourceHighlightEnabled: true,
    showPopupAudioButton: true,
    popupColumns: 1,
    showLookupCounts: true,
    definitionBlurEnabled: false,
    definitionBlurAnkiMature: false,
    definitionBlurFrequencyEnabled: false,
    definitionBlurFrequencyDictionary: "",
    definitionBlurFrequencyOrder: "auto",
    definitionBlurFrequencyThreshold: 10000,
    definitionBlurDirection: "atLeast",
    definitionBlurThreshold: 5,
    definitionBlurReveal: "timed",
    definitionBlurDelayMs: 5000,
    showCompactDefinitionSummary: false,
    compactDefinitionSummaryCount: 3,
    compactDefinitionSummaryDictionary: "",
    popupImageSource: null,
    averageFrequency: false,
    showFrequencyDictionaryNames: false,
    showPitchAccentFurigana: true,
    pitchAccentFuriganaDictionary: "",
    showPitchAccentBadge: true,
    hidePopupGrammarTags: true,
    kanjiClickDictionary: "",
    frequencyDictionary: "",
    frequencyOrder: "auto",
    automaticBackupDays: 2,
    // Recycle the engine worker after dictionary changes and import on one
    // thread; see docs/memory.md. Not a reader behaviour, so no hotkey toggle.
    lowMemoryMode: false,
    keybinds: DEFAULT_KEYBINDS,
  };
  const KEYBIND_TOGGLE_OPTIONS = Object.keys(DEFAULT_OPTIONS)
    .filter(key => typeof DEFAULT_OPTIONS[key] === "boolean" && key !== "lowMemoryMode");
  const NUMBER_RANGES = {
    scanLength: [1, 64],
    maxResults: [1, 256],
    hoverDelayMs: [0, 2000],
    popupHideDelayMs: [0, 5000],
    popupNestingMaxDepth: [0, Number.MAX_SAFE_INTEGER],
    popupWidthPx: [280, 1200],
    popupHeightPx: [200, 900],
    popupScalePercent: [25, 500],
    popupOpacityPercent: [0, 100],
    popupColumns: [1, 4],
    compactDefinitionSummaryCount: [1, 6],
    definitionBlurThreshold: [1, 1000000],
    definitionBlurFrequencyThreshold: [1, Number.MAX_SAFE_INTEGER],
    definitionBlurDelayMs: [1000, 3600000],
    // One snapshot per day, each a complete saved-state payload with lookup
    // statistics rows: the cap bounds how many copies the profile stores.
    automaticBackupDays: [1, 30],
  };
  // GSM PR #549 blurs at or above the threshold; Below is the issue #9 adaptation.
  const DEFINITION_BLUR_DIRECTIONS = ["atLeast", "below"];
  const DEFINITION_BLUR_REVEALS = ["timed", "hover"];
  const DEFINITION_BLUR_FREQUENCY_ORDERS = ["auto", "ascending", "descending"];
  // Audited Hoshidicts catalogue from GSM PR #549; palette values live in reader.css.
  const POPUP_THEME_GROUPS = [
    { label: "Automatic", ids: ["auto"] },
    { label: "Dark", ids: ["default", "miku", "catppuccin-mocha", "solarized-dark", "dark", "synthwave",
      "halloween", "forest", "aqua", "black", "luxury", "dracula", "business", "night", "coffee", "dim", "sunset", "abyss"] },
    { label: "Light", ids: ["girlypop", "solarized-light", "light", "cupcake", "bumblebee", "emerald", "corporate",
      "retro", "cyberpunk", "valentine", "garden", "lofi", "pastel", "fantasy", "wireframe", "cmyk", "autumn", "acid",
      "lemonade", "winter", "nord", "caramellatte", "silk"] },
    { label: "High contrast", ids: ["high-contrast"] },
  ].map(({ label, ids }) => ({ label, themes: ids.map(id => ({ id,
    label: id === "default" ? "Hachidori (default)"
      : id.replace(/(^|-)([a-z])/gu, (_, separator, letter) => `${separator ? " " : ""}${letter.toUpperCase()}`),
  })) }));
  const POPUP_THEME_IDS = new Set(POPUP_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id)));
  const DESIGN_OPTION_KEYS = [
    "popupTheme", "popupToolbarPosition", "customPopupCss", "customPopupJavascript", "customLinks", "customButtons", "popupWidthPx", "popupHeightPx", "popupScalePercent", "popupOpacityPercent", "sourceHighlightEnabled", "showPopupAudioButton", "popupColumns",
    "showCompactDefinitionSummary", "compactDefinitionSummaryCount", "compactDefinitionSummaryDictionary",
    "kanjiClickDictionary", "popupImageSource", "averageFrequency", "showFrequencyDictionaryNames",
    "showPitchAccentFurigana", "pitchAccentFuriganaDictionary", "showPitchAccentBadge", "hidePopupGrammarTags",
  ];
  const LEGACY_MODIFIERS = new Map([["none", "Shift"], ["shift", "Shift"], ["ctrl", "Control"], ["alt", "Alt"]]);
  const LOOKUP_MODES = ["hover", "activation", "activationSticky"];
  const POPUP_TOOLBAR_POSITIONS = new Set(["auto", "top", "bottom"]);
  // Browser KeyboardEvent names, adapting the source's desktop hotkey names.
  const ACTIVATION_KEYS = [
    "Shift", "Control", "Alt", "Meta", "Space", "Enter", "Escape", "Backspace", "Delete", "Tab",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert",
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
    ..."-=[]\\;',./`",
  ];
  const ACTIVATION_NAMES = new Map(ACTIVATION_KEYS.map((key) => [key.toLowerCase(), key]));
  const FREQUENCY_ORDERS = ["auto", "ascending", "descending", "disabled"];
  const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
  const AUDIO_SOURCE_LABELS = { custom: "Audio URL", "custom-json": "Yomitan JSON",
    "text-to-speech": "Speech: term", "text-to-speech-reading": "Speech: reading" };
  const AUDIO_SOURCE_TYPES = Object.keys(AUDIO_SOURCE_LABELS);
  const MEDIA_TIMING_MODES = ["auto", "page", "recent"];
  const MEDIA_HISTORY_SECONDS = [30, 60];
  const MEDIA_CLIP_SECONDS = [5, 10];
  const MEDIA_VIDEO_PRESETS = ["standard", "compact"];
  const MEDIA_TEXTHOOKER_FORMATS = ["plain", "gsm"];
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

  function cloneMediaCapture(value = DEFAULT_MEDIA_CAPTURE) {
    return {
      ...value,
      texthooker: { ...value.texthooker },
      page: { ...value.page },
    };
  }

  function normaliseTexthookerUrl(value) {
    if (typeof value !== "string" || value === "") return "";
    try {
      const url = new URL(value);
      if (!["ws:", "wss:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)
          || url.username || url.password || url.hash) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  function normaliseCaptureCollectors(source, result) {
    const texthooker = source.texthooker && typeof source.texthooker === "object"
      && !Array.isArray(source.texthooker) ? source.texthooker : {};
    const page = source.page && typeof source.page === "object" && !Array.isArray(source.page) ? source.page : {};
    if (typeof texthooker.enabled === "boolean") result.texthooker.enabled = texthooker.enabled;
    const url = normaliseTexthookerUrl(texthooker.url);
    if (url !== null) result.texthooker.url = url;
    if (MEDIA_TEXTHOOKER_FORMATS.includes(texthooker.format)) result.texthooker.format = texthooker.format;
    for (const key of ["nativeCues", "domText", "autoLearnArea"]) {
      if (typeof page[key] === "boolean") result.page[key] = page[key];
    }
    if (result.texthooker.enabled && !result.texthooker.url) result.texthooker.enabled = false;
  }

  function normaliseMediaCapture(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = cloneMediaCapture();
    for (const key of ["enabled", "includeAnimation", "includeCapturedAudio"]) {
      if (typeof source[key] === "boolean") result[key] = source[key];
    }
    if (MEDIA_TIMING_MODES.includes(source.timingMode)) result.timingMode = source.timingMode;
    if (MEDIA_HISTORY_SECONDS.includes(source.historySeconds)) result.historySeconds = source.historySeconds;
    if (MEDIA_CLIP_SECONDS.includes(source.clipSeconds)) result.clipSeconds = source.clipSeconds;
    if (MEDIA_VIDEO_PRESETS.includes(source.videoPreset)) result.videoPreset = source.videoPreset;
    if (Number.isInteger(source.estimatedOffsetMs)
        && source.estimatedOffsetMs >= -2000 && source.estimatedOffsetMs <= 2000) {
      result.estimatedOffsetMs = source.estimatedOffsetMs;
    }
    if (!result.includeAnimation && !result.includeCapturedAudio) {
      result.includeAnimation = DEFAULT_MEDIA_CAPTURE.includeAnimation;
      result.includeCapturedAudio = DEFAULT_MEDIA_CAPTURE.includeCapturedAudio;
    }
    normaliseCaptureCollectors(source, result);
    return result;
  }

  function sameFields(left, right, keys) {
    return keys.every(key => Object.hasOwn(left, key) && left[key] === right[key]);
  }

  function sameMediaCapture(left, right) {
    const keys = Object.keys(DEFAULT_MEDIA_CAPTURE).filter(key => !["texthooker", "page"].includes(key));
    return Object.hasOwn(left, "texthooker")
      && Object.hasOwn(left, "page")
      && sameFields(left, right, keys)
      && sameFields(left.texthooker, right.texthooker, Object.keys(DEFAULT_MEDIA_CAPTURE.texthooker))
      && sameFields(left.page, right.page, Object.keys(DEFAULT_MEDIA_CAPTURE.page));
  }

  function validMediaCapture(value, normalized) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (!value.texthooker || typeof value.texthooker !== "object" || Array.isArray(value.texthooker)
        || !value.page || typeof value.page !== "object" || Array.isArray(value.page)) return false;
    const keys = Object.keys(DEFAULT_MEDIA_CAPTURE);
    const texthookerKeys = Object.keys(DEFAULT_MEDIA_CAPTURE.texthooker);
    const pageKeys = Object.keys(DEFAULT_MEDIA_CAPTURE.page);
    if (Object.keys(value).some(key => !keys.includes(key))
        || Object.keys(value.texthooker).some(key => !texthookerKeys.includes(key))
        || Object.keys(value.page).some(key => !pageKeys.includes(key))) return false;
    return sameMediaCapture(value, normalized)
      && (normalized.includeAnimation || normalized.includeCapturedAudio)
      && (!normalized.texthooker.enabled || Boolean(normalized.texthooker.url));
  }

  function normaliseExperimental(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = { ...DEFAULT_EXPERIMENTAL };
    for (const id of Object.keys(DEFAULT_EXPERIMENTAL)) {
      if (typeof source[id] === "boolean") result[id] = source[id];
    }
    return result;
  }

  function validExperimental(value, normalized) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const ids = Object.keys(DEFAULT_EXPERIMENTAL);
    return Object.keys(value).every(id => ids.includes(id)) && sameFields(value, normalized, ids);
  }

  function normaliseAudioSources(value) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    return value.flatMap(source => {
      if (!source || typeof source.id !== "string" || source.id === "" || ids.has(source.id)
          || !AUDIO_SOURCE_TYPES.includes(source.type)) return [];
      ids.add(source.id);
      return [{ id: source.id, type: source.type, enabled: typeof source.enabled === "boolean" ? source.enabled : true,
        url: typeof source.url === "string" ? source.url : "", voice: typeof source.voice === "string" ? source.voice : "" }];
    });
  }

  function keybindArgument(action, value) {
    const kind = KEYBIND_ACTIONS.find(entry => entry.id === action)?.argument;
    if (!kind) return "";
    if (typeof value !== "string") return KEYBIND_ARGUMENT_DEFAULTS[kind];
    if (kind === "count") return /^[1-9]\d*$/u.test(value) ? value : KEYBIND_ARGUMENT_DEFAULTS.count;
    if (kind === "option") return value === "" || KEYBIND_TOGGLE_OPTIONS.includes(value) ? value : "";
    return value;
  }

  function orderedSubset(value, allowed) {
    return Array.isArray(value) ? allowed.filter(item => value.includes(item)) : [];
  }

  function normaliseKeybinds(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap(bind => {
      if (!bind || typeof bind !== "object" || !KEYBIND_ACTIONS.some(entry => entry.id === bind.action)) return [];
      return [{ action: bind.action, argument: keybindArgument(bind.action, bind.argument),
        key: typeof bind.key === "string" && bind.key !== "" ? bind.key : null,
        modifiers: orderedSubset(bind.modifiers, KEYBIND_MODIFIERS), scopes: orderedSubset(bind.scopes, KEYBIND_SCOPES),
        enabled: typeof bind.enabled === "boolean" ? bind.enabled : true }];
    });
  }

  function normaliseCustomLinks(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(link => link && typeof link.label === "string" && link.label.trim()
      && !/[\u0000-\u001f\u007f]/u.test(link.label) && typeof link.url === "string" && link.url.trim())
      .map(({ label, url }) => ({ label, url }));
  }

  function validIdentifier(value) {
    return typeof value === "string" && value !== "" && value.length <= STABLE_ID_MAX_LENGTH
      && !/[\u0000-\u001f\u007f]/u.test(value);
  }

  function legacyCustomButtons(links) {
    return normaliseCustomLinks(links).map((link, index) => ({
      id: `legacy-link-${index + 1}`,
      type: "link",
      ...link,
    }));
  }

  function normaliseCustomButtons(value) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    return value.flatMap(button => {
      if (!button || !validIdentifier(button.id) || ids.has(button.id)
          || typeof button.label !== "string" || !button.label.trim()
          || /[\u0000-\u001f\u007f]/u.test(button.label)) return [];
      let normalized;
      if (button.type === "link" && typeof button.url === "string" && button.url.trim()) {
        normalized = { id: button.id, type: "link", label: button.label, url: button.url };
      } else if (button.type === "anki" && validIdentifier(button.templateId)) {
        normalized = { id: button.id, type: "anki", label: button.label, templateId: button.templateId };
      } else {
        return [];
      }
      ids.add(button.id);
      return [normalized];
    });
  }

  function customLinksFromButtons(buttons) {
    return buttons.filter(button => button.type === "link")
      .map(({ label, url }) => ({ label, url }));
  }

  function normaliseAnkiConnectUrl(value) {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return null;
    try {
      const url = new URL(value.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      url.hash = "";
      return url.pathname === "/" && !url.search ? url.origin : url.href;
    } catch { return null; }
  }

  function cloneAnkiFieldTemplates(value) {
    if (value === null) return null;
    return Object.fromEntries(Object.entries(value).map(([field, template]) => [field, { ...template }]));
  }

  function cloneAnkiTemplate(value = DEFAULT_ANKI_TEMPLATE) {
    return {
      ...value,
      tags: [...value.tags],
      fields: { ...value.fields },
      fieldTemplates: cloneAnkiFieldTemplates(value.fieldTemplates),
    };
  }

  function normaliseAnkiFieldTemplates(value) {
    if (value === null || !validAnkiTemplates(value)) return null;
    return cloneAnkiFieldTemplates(value);
  }

  function normaliseAnkiTemplateConfig(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = cloneAnkiTemplate();
    delete result.id;
    delete result.name;
    for (const key of ["deck", "model", "captureScreenshot"]) {
      if (typeof source[key] === typeof DEFAULT_ANKI_TEMPLATE[key]) result[key] = source[key];
    }
    result.tags = Array.isArray(source.tags) ? source.tags.filter(tag => typeof tag === "string")
      : [...DEFAULT_ANKI_TEMPLATE.tags];
    result.fields = Object.fromEntries(ANKI_FIELDS.map(key => [key,
      typeof source.fields?.[key] === "string" ? source.fields[key] : ""]));
    if (ANKI_DUPLICATE_SCOPES.includes(source.duplicateScope)) {
      result.duplicateScope = source.duplicateScope;
    } else if (source.duplicateScope === "deck-root") {
      result.duplicateScope = "deck";
    } else if (source.duplicateScope === "collection") {
      result.duplicateScope = source.duplicateScopeCheckAllModels === true ? "all" : "model";
    }
    if (ANKI_DUPLICATE_BEHAVIORS.includes(source.duplicateBehavior)) result.duplicateBehavior = source.duplicateBehavior;
    if (source.checkForDuplicates === false) result.duplicateBehavior = "new";
    result.fieldTemplates = normaliseAnkiFieldTemplates(source.fieldTemplates);
    return result;
  }

  function normaliseAnkiTemplate(value, index = 0) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const fallbackId = index === 0 ? "default" : `template-${index + 1}`;
    const fallbackName = index === 0 ? "Default" : `Template ${index + 1}`;
    const validName = typeof source.name === "string" && source.name.trim()
      && !/[\u0000-\u001f\u007f]/u.test(source.name);
    return {
      id: validIdentifier(source.id) ? source.id : fallbackId,
      name: validName ? source.name : fallbackName,
      ...normaliseAnkiTemplateConfig(source),
    };
  }

  function sameAnkiTemplateConfig(left, right) {
    return ANKI_TEMPLATE_CONFIG_KEYS.every(key => JSON.stringify(left[key]) === JSON.stringify(right[key]));
  }

  function normaliseAnki(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    let templates;
    if (Array.isArray(source.templates) && source.templates.length > 0) {
      const ids = new Set();
      templates = source.templates.map((template, index) => normaliseAnkiTemplate(template, index))
        .filter(template => {
          if (ids.has(template.id)) return false;
          ids.add(template.id);
          return true;
        });
      if (templates.length === 0) templates = [cloneAnkiTemplate()];
      // A legacy caller may spread the normalized object and edit its
      // first-Template compatibility fields. Keep that edit lossless.
      const projected = normaliseAnkiTemplateConfig(source);
      const carriesProjection = ANKI_TEMPLATE_CONFIG_KEYS.every(key => Object.hasOwn(source, key));
      if (carriesProjection && !sameAnkiTemplateConfig(projected, templates[0])) {
        templates[0] = { id: templates[0].id, name: templates[0].name, ...projected };
      }
    } else {
      templates = [{ id: "default", name: "Default", ...normaliseAnkiTemplateConfig(source) }];
    }
    const first = templates[0];
    const result = {
      url: DEFAULT_ANKI.url,
      apiKey: typeof source.apiKey === "string" ? source.apiKey : DEFAULT_ANKI.apiKey,
      templates,
      ...Object.fromEntries(ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, first[key]])),
    };
    // Missing legacy settings keep localhost; an explicitly invalid endpoint
    // must remain unavailable rather than sending its requests somewhere else.
    if (Object.hasOwn(source, "url")) result.url = normaliseAnkiConnectUrl(source.url) ?? "";
    return result;
  }

  function validAnkiTemplates(value) {
    if (value === null) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(value).every(([field, template]) => field !== "" && template
      && typeof template.value === "string" && ANKI_OVERWRITE_MODES.includes(template.overwriteMode));
  }

  function validAnkiTemplate(value, normalized) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = new Set(["id", "name", ...ANKI_TEMPLATE_CONFIG_KEYS]);
    if (Object.keys(value).some(key => !keys.has(key))
        || value.id !== normalized.id || value.name !== normalized.name) return false;
    return ANKI_TEMPLATE_CONFIG_KEYS.every(key => {
      if (key === "fieldTemplates") return validAnkiTemplates(value.fieldTemplates)
        && JSON.stringify(value.fieldTemplates) === JSON.stringify(normalized.fieldTemplates);
      if (key === "fields") return value.fields && !Array.isArray(value.fields)
        && ANKI_FIELDS.every(field => value.fields[field] === normalized.fields[field]);
      if (key === "tags") return Array.isArray(value.tags) && JSON.stringify(value.tags) === JSON.stringify(normalized.tags);
      return value[key] === normalized[key];
    });
  }

  function validAnkiProjection(value, normalized) {
    return Object.entries(normalized).filter(([key]) => key !== "templates").every(([key, expected]) => {
      if (key === "url") return !Object.hasOwn(value, key)
        || (normaliseAnkiConnectUrl(value.url) !== null && normaliseAnkiConnectUrl(value.url) === expected);
      if (key === "fieldTemplates") return validAnkiTemplates(value.fieldTemplates);
      if (key === "fields") return value.fields && !Array.isArray(value.fields)
        && ANKI_FIELDS.every(field => value.fields[field] === expected[field]);
      if (key === "tags") return Array.isArray(value.tags) && value.tags.length === expected.length
        && expected.every((tag, index) => value.tags[index] === tag);
      return value[key] === expected;
    });
  }

  function validLegacyAnki(value, normalized) {
    return validAnkiProjection(value, normalized);
  }

  function validAnki(value, normalized) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (!Object.hasOwn(value, "templates")) return validLegacyAnki(value, normalized);
    const keys = new Set(["url", "apiKey", "templates", ...ANKI_TEMPLATE_CONFIG_KEYS]);
    if (Object.keys(value).some(key => !keys.has(key))
        || !Array.isArray(value.templates) || value.templates.length !== normalized.templates.length
        || !value.templates.every((template, index) =>
          validAnkiTemplate(template, normaliseAnkiTemplate(template, index)))) return false;
    return validAnkiProjection(value, normalized);
  }

  function normaliseActivationKey(value, fallback = DEFAULT_OPTIONS.activationKey) {
    if (value === " ") return "Space";
    return typeof value === "string" ? ACTIVATION_NAMES.get(value.toLowerCase()) ?? fallback : fallback;
  }

  function clampOption(key, value) {
    let number;
    try {
      number = Number(value);
    } catch {
      // Legacy writes accepted objects such as {toString: null}; keep them
      // repairable instead of failing every subsequent read and valid save.
      return DEFAULT_OPTIONS[key];
    }
    if (!Number.isFinite(number)) return DEFAULT_OPTIONS[key];
    const [min, max] = NUMBER_RANGES[key];
    return Math.max(min, Math.min(max, Math.trunc(number)));
  }

  /**
   * Preserve legacy title-only selections until dictionary state can infer kind.
   * A group is referenced by its stable ID, as the Image source option does.
   * @returns {string | {title: string, kind: "term" | "kanji"} | {kind: "tabGroup", id: string}}
   */
  function normaliseKanjiSelection(value) {
    if (value && typeof value === "object") {
      if (value.kind === "tabGroup" && typeof value.id === "string" && value.id !== "") {
        return { kind: "tabGroup", id: value.id };
      }
      if (typeof value.title === "string" && value.title !== "" && (value.kind === "term" || value.kind === "kanji")) {
        return { title: value.title, kind: value.kind };
      }
    }
    return typeof value === "string" ? value : "";
  }

  // Shared by the reader and the Design preview. Native numeric frequency
  // values are the evidence; rendered labels are intentionally ignored.
  function definitionBlurFrequencyEvidence(options, frequencyGroups, dictionaries) {
    const unavailable = { qualified: false, value: null, order: null };
    if (!options.definitionBlurFrequencyEnabled || !options.definitionBlurFrequencyDictionary
        || !Array.isArray(frequencyGroups) || !Array.isArray(dictionaries)) return unavailable;
    const source = dictionaries.find(dictionary => dictionary?.title === options.definitionBlurFrequencyDictionary);
    if (!source || source.enabled === false || source.frequencyCount === 0) return unavailable;
    const values = frequencyGroups
      .filter(group => group?.dictionary === options.definitionBlurFrequencyDictionary
        && Array.isArray(group.frequencies))
      .flatMap(group => group.frequencies)
      .map(frequency => frequency?.value)
      .filter(value => typeof value === "number" && Number.isFinite(value) && value > 0);
    if (values.length === 0) return unavailable;
    const order = options.definitionBlurFrequencyOrder === "auto"
      ? (source.frequencyMode === "rank-based" ? "ascending" : "descending")
      : options.definitionBlurFrequencyOrder;
    const value = order === "ascending" ? Math.min(...values) : Math.max(...values);
    return {
      qualified: order === "ascending"
        ? value <= options.definitionBlurFrequencyThreshold
        : value >= options.definitionBlurFrequencyThreshold,
      value,
      order,
    };
  }

  // Shared by the reader and the Design preview. Any enabled rule can qualify;
  // missing values fail open. Zero is a valid count for Below.
  function definitionBlurQualifies(options, lookupCount, ankiMature = false, frequencyQualified = false) {
    if (options.definitionBlurFrequencyEnabled && frequencyQualified === true) return true;
    if (options.definitionBlurAnkiMature && ankiMature === true) return true;
    if (!options.definitionBlurEnabled || !Number.isSafeInteger(lookupCount) || lookupCount < 0) return false;
    return options.definitionBlurDirection === "below"
      ? lookupCount < options.definitionBlurThreshold
      : lookupCount >= options.definitionBlurThreshold;
  }

  // Enumerated options fall back to their default outside the listed values.
  const ENUMERATED_OPTIONS = {
    lookupMode: new Set(LOOKUP_MODES),
    popupTheme: POPUP_THEME_IDS,
    popupToolbarPosition: POPUP_TOOLBAR_POSITIONS,
    frequencyOrder: new Set(FREQUENCY_ORDERS),
    definitionBlurFrequencyOrder: new Set(DEFINITION_BLUR_FREQUENCY_ORDERS),
    definitionBlurDirection: new Set(DEFINITION_BLUR_DIRECTIONS),
    definitionBlurReveal: new Set(DEFINITION_BLUR_REVEALS),
  };

  function normaliseField(key, value) {
    if (key === "hoverDelayMs") return 0;
    if (Object.hasOwn(NUMBER_RANGES, key)) return clampOption(key, value);
    if (typeof DEFAULT_OPTIONS[key] === "boolean") {
      return typeof value === "boolean" ? value : DEFAULT_OPTIONS[key];
    }
    if (Object.hasOwn(ENUMERATED_OPTIONS, key)) return ENUMERATED_OPTIONS[key].has(value) ? value : DEFAULT_OPTIONS[key];
    switch (key) {
      case "activationKey": return normaliseActivationKey(value);
      case "kanjiClickDictionary": return normaliseKanjiSelection(value);
      case "popupImageSource": return normalisePopupImageSource(value);
      case "audioSources": return normaliseAudioSources(value);
      case "customLinks": return normaliseCustomLinks(value);
      case "customButtons": return normaliseCustomButtons(value);
      case "keybinds": return normaliseKeybinds(value);
      case "anki": return normaliseAnki(value);
      case "mediaCapture": return normaliseMediaCapture(value);
      case "experimental": return normaliseExperimental(value);
      default: return typeof value === "string" ? value : "";
    }
  }

  // A dictionary's clicked-kanji capability: native kanji entries when it has
  // them, otherwise its term entries. Metadata-only packages have neither.
  function kanjiCapability(dictionary, requestedKind = "") {
    if (!dictionary || dictionary.enabled === false) return null;
    const defaultKind = dictionary.kanjiCount > 0 ? "kanji" : "term";
    const kind = requestedKind === "" ? defaultKind : requestedKind;
    const available = kind === "kanji" ? dictionary.kanjiCount > 0 : dictionary.termCount > 0
      || (dictionary.frequencyCount === 0 && dictionary.pitchCount === 0 && dictionary.kanjiCount === 0);
    return available ? { kind, title: dictionary.title } : null;
  }

  // Null means Automatic native kanji. A group yields its eligible members in
  // group order so a click can ask every one of them at once.
  function resolveKanjiDictionary(selection, dictionaries, groups = []) {
    if (selection?.kind === "tabGroup") {
      const group = groups.find(entry => entry.id === selection.id);
      const members = (group?.dictionaryIds || [])
        .map(id => kanjiCapability(dictionaries.find(entry => entry.id === id)))
        .filter(member => member !== null);
      return members.length > 0 ? { kind: "group", members } : null;
    }
    const title = typeof selection === "string" ? selection : selection?.title;
    if (typeof title !== "string" || title === "") return null;
    const requestedKind = typeof selection === "object" ? selection.kind : "";
    return kanjiCapability(dictionaries.find(entry => entry.title === title), requestedKind);
  }

  function normalisePopupImageSource(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.kind === "dictionary" && typeof value.title === "string" && value.title !== "") {
      return { kind: "dictionary", title: value.title };
    }
    if (value.kind === "tabGroup" && typeof value.id === "string" && value.id !== "") {
      return { kind: "tabGroup", id: value.id };
    }
    return null;
  }

  function legacyActivationOptions(source, strict) {
    if (!Object.hasOwn(source, "modifier")) return {};
    const key = LEGACY_MODIFIERS.get(source.modifier);
    if (strict && key === undefined) {
      throw new Error("the options write request carried an invalid reader option");
    }
    // Old Settings patches still pass through CAS. Plain hover changes mode
    // only, preserving a newer configured key, without a second stored policy.
    return source.modifier === "none" || key === undefined
      ? { lookupMode: "hover" }
      : { lookupMode: "activation", activationKey: key };
  }

  // Null uses the definition's dictionary. Empty means no eligible source;
  // group membership order is the per-image fallback order.
  function resolvePopupImageSources(source, dictionaries, groups) {
    if (!source) return null;
    if (source.kind === "dictionary") {
      return dictionaries.some(entry => entry.enabled && entry.title === source.title) ? [source.title] : [];
    }
    const group = groups.find(entry => entry.id === source.id);
    const titles = new Map(dictionaries.filter(entry => entry.enabled).map(entry => [entry.id, entry.title]));
    return (group?.dictionaryIds || []).filter(id => titles.has(id)).map(id => titles.get(id));
  }

  function projectOptions(value, strict) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = legacyActivationOptions(source, strict);
    for (const key of OPTION_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const raw = source[key];
      const normalized = normaliseField(key, raw);
      if (strict && !isValidOptionField(key, raw, normalized)) {
        throw new Error("the options write request carried an invalid reader option");
      }
      result[key] = normalized;
    }
    if (Object.hasOwn(source, "customButtons")) {
      result.customLinks = customLinksFromButtons(result.customButtons);
    } else if (Object.hasOwn(source, "customLinks")) {
      result.customButtons = legacyCustomButtons(result.customLinks);
    }
    return result;
  }

  function isValidOptionField(key, raw, normalized) {
    if (key === "anki") return validAnki(raw, normalized);
    if (key === "mediaCapture") return validMediaCapture(raw, normalized);
    if (key === "experimental") return validExperimental(raw, normalized);
    if (key === "kanjiClickDictionary") return typeof raw === "string" || typeof normalized === "object";
    if (key === "popupImageSource") return raw === null || normalized !== null;
    if (key === "keybinds") return Array.isArray(raw) && raw.length === normalized.length
      && normalized.every((bind, index) => raw[index] && typeof raw[index] === "object" && JSON.stringify(bind)
        === JSON.stringify(Object.fromEntries(Object.keys(bind).map(field => [field, raw[index][field]]))));
    if (key === "audioSources" || key === "customLinks" || key === "customButtons") return Array.isArray(raw) && raw.length === normalized.length
      && normalized.every((source, index) => Object.entries(source).every(([field, value]) => raw[index][field] === value));
    return typeof raw === typeof DEFAULT_OPTIONS[key] && raw === normalized;
  }

  function projectStoredOptions(value) {
    return projectOptions(value, false);
  }

  function validateOptionsPatch(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the options write request carried no object");
    }
    return projectOptions(value, true);
  }

  function normaliseOptions(value) {
    const options = { ...DEFAULT_OPTIONS, ...projectStoredOptions(value) };
    const source = value && typeof value === "object" ? value : {};
    options.anki = normaliseAnki(options.anki);
    if (Object.hasOwn(source, "customButtons")) {
      options.customButtons = normaliseCustomButtons(options.customButtons);
    } else {
      options.customButtons = legacyCustomButtons(options.customLinks);
    }
    options.customLinks = customLinksFromButtons(options.customButtons);
    options.mediaCapture = cloneMediaCapture(options.mediaCapture);
    options.experimental = { ...options.experimental };
    // Media capture predates the flag. A profile that never saved an
    // experimental record keeps the feature exactly as it was switched on.
    if (!Object.hasOwn(source, "experimental")) options.experimental.mediaMining = options.mediaCapture.enabled;
    return options;
  }

  function ankiTemplateConfig(anki, templateId) {
    const normalized = normaliseAnki(anki);
    const template = templateId === undefined || templateId === null
      ? normalized.templates[0]
      : normalized.templates.find(candidate => candidate.id === templateId);
    if (!template) return null;
    return {
      url: normalized.url,
      apiKey: normalized.apiKey,
      ...Object.fromEntries(ANKI_TEMPLATE_CONFIG_KEYS.map(key => [key, template[key]])),
    };
  }

  function projectContentOptions(value) {
    const options = normaliseOptions(value);
    return {
      ...options,
      mediaCapture: {
        ...options.mediaCapture,
        texthooker: {
          enabled: options.mediaCapture.texthooker.enabled,
          format: options.mediaCapture.texthooker.format,
        },
      },
    };
  }

  globalThis.HDReaderOptions = {
    ANKI_FIELDS, ANKI_DUPLICATE_SCOPES, ANKI_DUPLICATE_BEHAVIORS, ANKI_OVERWRITE_MODES,
    ANKI_TEMPLATE_CONFIG_KEYS, DEFAULT_ANKI_TEMPLATE, STABLE_ID_MAX_LENGTH,
    DEFAULT_OPTIONS, DEFAULT_MEDIA_CAPTURE, NUMBER_RANGES, LOOKUP_MODES, ACTIVATION_KEYS, FREQUENCY_ORDERS,
    POPUP_THEME_GROUPS, DESIGN_OPTION_KEYS,
    KEYBIND_ACTIONS, KEYBIND_ARGUMENT_DEFAULTS, KEYBIND_SCOPES, KEYBIND_MODIFIERS, KEYBIND_MODIFIER_CODES, KEYBIND_TOGGLE_OPTIONS,
    AUDIO_SOURCE_TYPES, AUDIO_SOURCE_LABELS,
    MEDIA_TIMING_MODES, MEDIA_HISTORY_SECONDS, MEDIA_CLIP_SECONDS, MEDIA_VIDEO_PRESETS, MEDIA_TEXTHOOKER_FORMATS,
    EXPERIMENTAL_FEATURES,
    clampOption, normaliseActivationKey, normaliseKanjiSelection, normaliseOptions,
    normaliseTexthookerUrl, normaliseAnkiConnectUrl, normaliseMediaCapture, normaliseAnki,
    normaliseCustomButtons, normaliseExperimental, ankiTemplateConfig,
    definitionBlurFrequencyEvidence, definitionBlurQualifies,
    DEFINITION_BLUR_DIRECTIONS, DEFINITION_BLUR_REVEALS, DEFINITION_BLUR_FREQUENCY_ORDERS,
    projectStoredOptions, projectContentOptions, validateOptionsPatch,
    resolvePopupImageSources,
    resolveKanjiDictionary,
  };
}());
