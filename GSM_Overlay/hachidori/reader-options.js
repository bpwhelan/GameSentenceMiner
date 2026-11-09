// SPDX-License-Identifier: GPL-3.0-or-later

// Loaded synchronously by the content-script manifest and by side-effect imports
// in extension modules, so every options consumer uses the same stored view.
(function () {
  "use strict";

  const ANKI_FIELDS = ["expression", "reading", "definition", "sentence", "frequency", "pitch", "audio", "screenshot"];
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
  // Settings → Advanced → Experimental features. Each entry is one boolean flag
  // under `options.experimental`; `section` names the Settings card the flag
  // reveals.
  const EXPERIMENTAL_FEATURES = [
    { id: "googleDocs", label: "Google Docs",
      description: "Look up words in Google Docs. Asks Google Docs to expose its text to Hachidori, which Google may change or remove without notice; the sentence is the hovered run of text." },
    { id: "netflixMining", label: "Netflix mining",
      description: "Add the Netflix subtitle line's audio to Anki notes with {sentence-audio} and a looping GIF of it with {gif}, and use the whole line as the sentence. Hovering a subtitle pauses the video until the pointer leaves the subtitle and the popup. Reads Netflix's subtitle files (adapted from Subadub), which Netflix may change without notice. The video's sound plays through Hachidori, which keeps the last 30 seconds in memory to cut the line from; a line you have not heard all of plays on or replays once. Reload Netflix after turning this on. Protected video can make the audio silent or the GIF black." },
    { id: "netflixPreviewScreenshots", label: "Netflix preview screenshots",
      description: "Use Netflix's timeline preview image for {screenshot} when the video comes out black. Preview images have lower resolution and show a nearby moment, not necessarily the exact frame. Does not record or replay the video. Other pages keep normal screenshots. Netflix may change or remove these previews." },
    { id: "youtubeMining", label: "YouTube mining",
      description: "Add the YouTube caption line's audio to Anki notes with {sentence-audio} and a looping GIF of it with {gif}, use the whole line as the sentence, and take {screenshot} from the video itself. Hovering a caption pauses the video until the pointer leaves the caption and the popup. Reads the caption track YouTube's player shows, typed or auto-generated, which YouTube may change without notice. The video's sound plays through Hachidori, which keeps the last 30 seconds in memory to cut the line from; a line you have not heard all of plays on or replays once. Reload YouTube after turning this on. Works on watch pages, not on Shorts, embedded videos or live streams." },
    // docs/languages.md 16.3. Off, lookups use the Japanese profile and nothing
    // switches language; the profiles and this browser's choice are kept.
    { id: "multipleLanguages", label: "Multiple languages", section: "languages",
      description: "Read other languages besides Japanese, such as English, Korean, Spanish or Arabic, each with its own dictionaries, settings, Anki Templates and pronunciation sources. Adds Languages under Advanced, where you add a language and choose the one lookups use; with two or more, the toolbar switches between them. Turning this off returns lookups to Japanese and keeps the languages you added, with their settings and dictionaries, for the next time you turn it on." },
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
    { id: "historyForward", label: "Navigate forward in history" },
    // On the search page, Enter adds the word under the searched text's cursor.
    { id: "addNote", label: "Add note", scopes: ["popup", "search"] },
    { id: "viewNotes", label: "View notes" },
    { id: "playAudio", label: "Play audio" },
    { id: "playAudioFromSource", label: "Play audio from source", argument: "audioSource" },
    { id: "scanSelectedText", label: "Scan selected text", scopes: ["web"] },
    { id: "scanTextAtSelection", label: "Scan text at selection", scopes: ["web"] },
    // Yomitan offers this only inside its popup. Hachidori's popup cannot
    // exist while lookups are off, so the page scope can turn them back on.
    { id: "toggleOption", label: "Toggle option", argument: "option", scopes: ["popup", "web"] },
    // Hachidori's own: shows or hides the word highlights (#520) of the page,
    // and sets the current entry's word to known or ignored for them.
    { id: "toggleWordHighlights", label: "Toggle word highlights", scopes: ["web"] },
    { id: "markWordKnown", label: "Mark word as known" },
    { id: "ignoreWord", label: "Ignore word" },
    // Makes the next language this browser's active profile (docs/languages.md
    // 16.2). Not Yomitan's profileNext, which Hachidori drops.
    { id: "switchLanguage", label: "Switch to the next language", scopes: ["web"] },
    // The search page's (docs/search-history.md): in its box, the lines of its
    // history, as a shell's Up and Down; in the searched text, Rubi's cursor.
    { id: "searchPreviousLine", label: "Previous line in the search history", scopes: ["search"] },
    { id: "searchNextLine", label: "Next line in the search history", scopes: ["search"] },
    { id: "searchPreviousWord", label: "Previous word in the searched text", scopes: ["search"] },
    { id: "searchNextWord", label: "Next word in the searched text", scopes: ["search"] },
    { id: "searchRowUp", label: "Row above, or the earlier line", scopes: ["search"] },
    { id: "searchRowDown", label: "Row below, or the later line", scopes: ["search"] },
  ].map(action => ({ scopes: ["popup"], ...action }));
  const KEYBIND_ARGUMENT_DEFAULTS = { count: "1", audioSource: "", option: "" };
  // Yomitan's popup scope, adapted: Hachidori's hover popup never takes focus,
  // so it means "while a popup is open or opening". Search is the search page,
  // as Yomitan's; web is anywhere on the page.
  const KEYBIND_SCOPES = ["popup", "search", "web"];
  const KEYBIND_MODIFIERS = ["meta", "ctrl", "alt", "shift"];
  // Pressing only these codes records or matches a keybind with a null key.
  const KEYBIND_MODIFIER_CODES = new Set(["AltLeft", "AltRight", "ControlLeft", "ControlRight",
    "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight", "OSLeft", "OSRight"]);
  // The modifiers a key press or wheel step holds, in stored keybind order.
  const keybindModifiers = event => KEYBIND_MODIFIERS.filter(modifier => event[`${modifier}Key`] === true);
  // A vertical wheel step is a keybind key: the reader matches it over a popup
  // and the Keys field records it.
  function keybindWheelKey(event) {
    if (event.deltaY > 0) return "WheelDown";
    if (event.deltaY < 0) return "WheelUp";
    return null;
  }
  // Yomitan's default hotkeys without the actions Hachidori has no feature for,
  // then the one-entry moves Yomitan's popup gives Alt+wheel outside its hotkeys.
  const keybind = scopes => ([action, argument, key, modifiers]) =>
    ({ action, argument, key, modifiers, scopes, enabled: true });
  const DEFAULT_KEYBINDS = [
    ["close", "", "Escape", []],
    ["previousEntry", "3", "PageUp", ["alt"]],
    ["nextEntry", "3", "PageDown", ["alt"]],
    ["lastEntry", "", "End", ["alt"]],
    ["firstEntry", "", "Home", ["alt"]],
    ["previousEntry", "1", "ArrowUp", ["alt"]],
    ["nextEntry", "1", "ArrowDown", ["alt"]],
    ["historyBackward", "", "KeyB", ["alt"]],
    ["historyForward", "", "KeyF", ["alt"]],
    ["addNote", "", "KeyE", ["alt"]],
    ["playAudio", "", "KeyP", ["alt"]],
    ["viewNotes", "", "KeyV", ["alt"]],
    ["previousEntry", "1", "WheelUp", ["alt"]],
    ["nextEntry", "1", "WheelDown", ["alt"]],
  ].map(keybind(["popup"]));
  // The search page's keys (docs/search-history.md): Rubi's arrows and Enter.
  // Each acts only where it applies (the box, or the searched text with focus),
  // so an arrow is free for its usual work everywhere else.
  const SEARCH_KEYBINDS = [
    ["searchPreviousLine", "", "ArrowUp", []],
    ["searchNextLine", "", "ArrowDown", []],
    ["searchPreviousWord", "", "ArrowLeft", []],
    ["searchNextWord", "", "ArrowRight", []],
    ["searchRowUp", "", "ArrowUp", []],
    ["searchRowDown", "", "ArrowDown", []],
    ["addNote", "", "Enter", []],
  ].map(keybind(["search"]));
  const DEFAULT_OPTIONS = {
    scanLength: 16,
    maxResults: 32,
    hoverEnabled: true,
    onlyScanJapaneseText: true,
    // Reading → Personal dictionary: highlight lookups, the pencil and personal
    // entries in results. Off never touches the managed package or its source.
    personalDictionaryEnabled: true,
    showNoResultNotice: true,
    lookupMode: "activationSticky",
    activationKey: "Shift",
    definitionLookupMode: "inherit",
    // Reading → Activation: how long a lookup that needs no key waits for the
    // pointer to rest on one word (0 looks up at once), and the same wait in a
    // popup's definitions, where null follows the page's.
    scanDelayMs: 0,
    definitionScanDelayMs: null,
    popupHideDelayMs: 160,
    // Yomitan's scanning.hidePopupOnCursorExit and hidePopupOnCursorExitDelay.
    hidePopupOnCursorExit: false,
    hidePopupOnCursorExitDelayMs: 160,
    // Reading → Results: also show words that only frequency and pitch
    // dictionaries have, without definitions (#620).
    showMetadataOnlyResults: false,
    popupNestingMaxDepth: 10,
    popupTheme: "default",
    // Design → Colours for a theme whose catalogue entry lists colour variants
    // (Crystal's Grey, Beige and Retro blue). "auto" leaves the choice to the
    // theme, which follows the system's light or dark mode.
    popupThemeVariant: "auto",
    popupToolbarPosition: "auto",
    customPopupCss: "",
    customPopupJavascript: "",
    customLinks: [],
    customButtons: [],
    audioSources: [{ id: "default-tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" }],
    audioAutoplay: false,
    anki: DEFAULT_ANKI,
    smallerAnkiCards: false,
    experimental: DEFAULT_EXPERIMENTAL,
    popupWidthPx: 560,
    popupHeightPx: 420,
    popupScalePercent: 100,
    popupOpacityPercent: 85,
    sourceHighlightEnabled: true,
    showPopupAudioButton: true,
    popupColumns: 1,
    // Yomitan's general.glossaryLayoutMode: "compact" puts a definition's
    // glosses on one line, separated by " | ", in the popup (CSS only);
    // "compact-popup-anki" does that in Anki glossary fields as well.
    glossaryLayoutMode: "default",
    showLookupCounts: true,
    // Only the lookup-count condition; stored as `definitionBlurEnabled` before #401.
    definitionBlurCountEnabled: false,
    definitionBlurAnkiMature: false,
    definitionBlurFrequencyEnabled: false,
    definitionBlurFrequencyDictionary: "",
    definitionBlurFrequencyOrder: "auto",
    definitionBlurFrequencyThreshold: 10000,
    definitionBlurDirection: "atLeast",
    definitionBlurThreshold: 5,
    definitionBlurReveal: "timed",
    definitionBlurDelayMs: 5000,
    // Reading → Word highlighting (#520): marks the page's words
    // by their Anki status. Its switches and style stay while it is off.
    wordHighlightEnabled: false,
    wordHighlightUnknown: true,
    wordHighlightLearning: true,
    wordHighlightKnown: false,
    // Words set to Ignore from the popup, which are otherwise left unmarked.
    wordHighlightIgnored: false,
    wordHighlightStyle: "underline",
    showCompactDefinitionSummary: false,
    compactDefinitionSummaryCount: 3,
    compactDefinitionSummaryDictionary: "",
    popupImageSource: null,
    // Hover/focus enlargement of dictionary images: "off", "large" skips
    // inline glyphs (em-sized or at most 32px square), "all" previews every image.
    imageHoverPreview: "large",
    averageFrequency: false,
    // With averages on, Yomitan hides each dictionary's frequency tag; this
    // keeps them shown after the averages instead.
    showFrequencyTagsWithAverage: false,
    showFrequencyDictionaryNames: false,
    compactFrequencyNumbers: false,
    showPitchAccentFurigana: true,
    pitchAccentFuriganaDictionary: "",
    // How the headword's furigana draws its pitch: "contour" (a line over high
    // morae and under low ones) or "overline" (the pitch list's Yomitan text).
    pitchAccentFuriganaStyle: "contour",
    showPitchAccentBadge: true,
    // Yomitan labels every pronunciation group with its dictionary.
    showPitchAccentDictionaryNames: true,
    // Yomitan's downstep text, position and graph notations, with its defaults.
    showPitchAccentText: true,
    showPitchAccentPosition: true,
    showPitchAccentGraph: false,
    // jp-mining-note's pitch accent group colours, off by default as there.
    // The key is US-spelled like colorScheme; Settings says "colours".
    showPitchAccentColors: false,
    hidePopupGrammarTags: true,
    kanjiClickDictionary: "",
    frequencyDictionary: "",
    frequencyOrder: "auto",
    automaticBackupDays: 2,
    useLessRamByDefault: false,
    // Recycle the engine worker after dictionary changes and import on one
    // thread; see docs/memory.md. Not a reader behaviour, so no hotkey toggle.
    lowMemoryMode: false,
    dictionaryEntryStorage: "auto",
    dictionaryIndexStorage: "auto",
    // Reading → Search page (#610): the toolbar menu's Search button, beside
    // Settings, which opens the search page. On, as its owner asked.
    showToolbarSearchButton: true,
    // Reading → Search page (#656): a click on a word of the search page's
    // query or results looks it up, off as Yomitan's
    // scanning.enablePopupSearch is; and the size of the popup window its
    // shortcut opens, Yomitan's popupWindow width and height.
    searchClickLookup: false,
    searchWindowWidthPx: 600,
    searchWindowHeightPx: 640,
    // Advanced → Search history (docs/search-history.md), off until switched
    // on: keep each line the search page searches, up to this many, oldest
    // first out, and move through them with the search page's keys.
    searchHistoryEnabled: false,
    searchHistoryLimit: 10000,
    keybinds: [...DEFAULT_KEYBINDS, ...SEARCH_KEYBINDS],
  };
  // Word highlighting's switches stay with its Reading Settings section;
  // a page shows or hides its marks with Toggle word highlights instead. The
  // toolbar's Search button and the search history are not reader behaviours.
  const UNTOGGLED_OPTIONS = new Set(["lowMemoryMode", "useLessRamByDefault", "smallerAnkiCards", "wordHighlightEnabled", "wordHighlightUnknown",
    "wordHighlightLearning", "wordHighlightKnown", "wordHighlightIgnored", "showToolbarSearchButton", "searchHistoryEnabled"]);
  const KEYBIND_TOGGLE_OPTIONS = Object.keys(DEFAULT_OPTIONS)
    .filter(key => typeof DEFAULT_OPTIONS[key] === "boolean" && !UNTOGGLED_OPTIONS.has(key));
  const NUMBER_RANGES = {
    scanLength: [1, 64],
    maxResults: [1, 256],
    scanDelayMs: [0, 5000],
    definitionScanDelayMs: [0, 5000],
    popupHideDelayMs: [0, 5000],
    hidePopupOnCursorExitDelayMs: [0, 5000],
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
    // Chrome fits a larger window to the screen. Firefox does not: it opens a
    // window asked to be larger than 16,384 pixels at 16,384, and one asked to
    // be 2^31 - 1 pixels wide at its 95-pixel minimum.
    searchWindowWidthPx: [200, 16384],
    searchWindowHeightPx: [200, 16384],
    // Lines the search history keeps (docs/search-history.md): as many as the user sets.
    searchHistoryLimit: [1, Number.MAX_SAFE_INTEGER],
  };
  // GSM PR #549 blurs at or above the threshold; Below is the issue #9 adaptation.
  const DEFINITION_BLUR_DIRECTIONS = ["atLeast", "below"];
  // After a delay (hover reveals too), on hover only, or on click only (#598).
  const DEFINITION_BLUR_REVEALS = ["timed", "hover", "click"];
  const DEFINITION_BLUR_FREQUENCY_ORDERS = ["auto", "ascending", "descending"];
  const IMAGE_HOVER_PREVIEWS = ["off", "large", "all"];
  // Yomitan's stored values.
  const GLOSSARY_LAYOUT_MODES = ["default", "compact", "compact-popup-anki"];
  const PITCH_ACCENT_FURIGANA_STYLES = ["contour", "overline"];
  // How a word highlight marks its word: a line under it, its text, or its background.
  const WORD_HIGHLIGHT_STYLES = ["underline", "color", "background"];
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
  const POPUP_RENDERER_IDS = ["nazeka", "plain", "jl", "bee", "crystal"];
  // Every colour variant a bundled theme's catalogue entry may list, after "auto".
  const POPUP_THEME_VARIANTS = ["auto", "grey", "beige", "blue"];
  for (const id of POPUP_RENDERER_IDS) POPUP_THEME_IDS.add(id);
  const popupRenderer = theme => POPUP_RENDERER_IDS.includes(theme) ? theme : "default";
  const DESIGN_OPTION_KEYS = [
    "popupTheme", "popupThemeVariant", "popupToolbarPosition", "customPopupCss", "customPopupJavascript", "customLinks", "customButtons", "popupWidthPx", "popupHeightPx", "popupScalePercent", "popupOpacityPercent", "sourceHighlightEnabled", "popupColumns",
    "glossaryLayoutMode", "showCompactDefinitionSummary", "compactDefinitionSummaryCount", "compactDefinitionSummaryDictionary",
    "kanjiClickDictionary", "popupImageSource", "imageHoverPreview", "averageFrequency", "showFrequencyTagsWithAverage",
    "showFrequencyDictionaryNames",
    "compactFrequencyNumbers", "showPitchAccentFurigana", "pitchAccentFuriganaDictionary", "pitchAccentFuriganaStyle",
    "showPitchAccentBadge", "showPitchAccentDictionaryNames", "showPitchAccentText", "showPitchAccentPosition", "showPitchAccentGraph",
    "showPitchAccentColors", "hidePopupGrammarTags",
  ];
  const LEGACY_MODIFIERS = new Map([["none", "Shift"], ["shift", "Shift"], ["ctrl", "Control"], ["alt", "Alt"]]);
  const LOOKUP_MODES = ["hover", "activation", "activationSticky"];
  // How words in a popup's definitions open child popups. "inherit" follows lookupMode.
  const DEFINITION_LOOKUP_MODES = ["inherit", "activation", "click"];
  const POPUP_TOOLBAR_POSITIONS = new Set(["auto", "top", "bottom"]);
  // Mouse buttons that can be held to scan instead of a key. `button` is
  // MouseEvent.button and `flag` its MouseEvent.buttons bit: the two numberings
  // differ (middle is 1 and 4). Yomitan names buttons by bit index, so its
  // `mouse2` is the middle button; the stored names are descriptive instead.
  // `name` is the Settings choice and `label` reads in a sentence.
  const ACTIVATION_BUTTONS = new Map([
    ["MouseMiddle", { button: 1, flag: 4, name: "Middle mouse button", label: "the middle mouse button" }],
    ["MouseBack", { button: 3, flag: 8, name: "Back mouse button (mouse 4)", label: "the Back mouse button" }],
    ["MouseForward", { button: 4, flag: 16, name: "Forward mouse button (mouse 5)", label: "the Forward mouse button" }],
  ]);
  // The mouse buttons, then browser KeyboardEvent names adapting the source's
  // desktop hotkey names.
  const ACTIVATION_KEYS = [
    ...ACTIVATION_BUTTONS.keys(),
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
  function sameFields(left, right, keys) {
    return keys.every(key => Object.hasOwn(left, key) && left[key] === right[key]);
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

  // The activation input as it reads in "Hold … to scan": a key by its name.
  function activationLabel(key) {
    return ACTIVATION_BUTTONS.get(key)?.label ?? key;
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

  // An empty blur dictionary means "Same as sorting": the Reading → Frequency
  // sorting dictionary, which may itself be None (no sort dictionary).
  function definitionBlurFrequencyDictionary(options) {
    return options.definitionBlurFrequencyDictionary || options.frequencyDictionary;
  }

  // The direction a dictionary's own mode implies: only a declared
  // "occurrence-based" list counts up. A dictionary without frequencyMode is
  // read as ranks, as Yomitan's rank aggregates read it
  // (yomidevs/yomitan@d3c54c1 ext/js/data/anki-note-data-creator.js:184):
  // CC100, BCCWJ and most other Japanese lists are ranks that predate the field.
  function frequencyModeOrder(frequencyMode) {
    return frequencyMode === "occurrence-based" ? "descending" : "ascending";
  }

  // Shared by the reader and the Design preview. Native numeric frequency
  // values are the evidence; rendered labels are intentionally ignored.
  function definitionBlurFrequencyEvidence(options, frequencyGroups, dictionaries) {
    const unavailable = { qualified: false, value: null, order: null };
    const title = definitionBlurFrequencyDictionary(options);
    if (!options.definitionBlurFrequencyEnabled || !title
        || !Array.isArray(frequencyGroups) || !Array.isArray(dictionaries)) return unavailable;
    const source = dictionaries.find(dictionary => dictionary?.title === title);
    if (!source || source.enabled === false || source.frequencyCount === 0) return unavailable;
    const values = frequencyGroups
      .filter(group => group?.dictionary === title
        && Array.isArray(group.frequencies))
      .flatMap(group => group.frequencies)
      .map(frequency => frequency?.value)
      .filter(value => typeof value === "number" && Number.isFinite(value) && value > 0);
    if (values.length === 0) return unavailable;
    const order = options.definitionBlurFrequencyOrder === "auto"
      ? frequencyModeOrder(source.frequencyMode)
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
    if (!options.definitionBlurCountEnabled || !Number.isSafeInteger(lookupCount) || lookupCount < 0) return false;
    return options.definitionBlurDirection === "below"
      ? lookupCount < options.definitionBlurThreshold
      : lookupCount >= options.definitionBlurThreshold;
  }

  // Enumerated options fall back to their default outside the listed values.
  const ENUMERATED_OPTIONS = {
    dictionaryEntryStorage: new Set(["auto", "paged", "resident"]),
    dictionaryIndexStorage: new Set(["auto", "paged", "resident"]),
    lookupMode: new Set(LOOKUP_MODES),
    definitionLookupMode: new Set(DEFINITION_LOOKUP_MODES),
    popupTheme: POPUP_THEME_IDS,
    popupThemeVariant: new Set(POPUP_THEME_VARIANTS),
    popupToolbarPosition: POPUP_TOOLBAR_POSITIONS,
    frequencyOrder: new Set(FREQUENCY_ORDERS),
    definitionBlurFrequencyOrder: new Set(DEFINITION_BLUR_FREQUENCY_ORDERS),
    definitionBlurDirection: new Set(DEFINITION_BLUR_DIRECTIONS),
    definitionBlurReveal: new Set(DEFINITION_BLUR_REVEALS),
    imageHoverPreview: new Set(IMAGE_HOVER_PREVIEWS),
    glossaryLayoutMode: new Set(GLOSSARY_LAYOUT_MODES),
    pitchAccentFuriganaStyle: new Set(PITCH_ACCENT_FURIGANA_STYLES),
    wordHighlightStyle: new Set(WORD_HIGHLIGHT_STYLES),
  };

  function normaliseField(key, value) {
    // Same as page delay is null, not a copy of the page value.
    if (key === "definitionScanDelayMs" && value === null) return null;
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
      case "experimental": return normaliseExperimental(value);
      default: return typeof value === "string" ? value : "";
    }
  }

  // Whether a dictionary has entries of a kind: "freq", "pitch", "kanji", or
  // terms for any other kind. A package with no entries of any kind counts as
  // a term dictionary. Settings and the service worker check option
  // selections with it.
  function hasCapability(dictionary, kind) {
    if (kind === "freq") return dictionary.frequencyCount > 0;
    if (kind === "pitch") return dictionary.pitchCount > 0;
    if (kind === "kanji") return dictionary.kanjiCount > 0;
    if (dictionary.termCount > 0) return true;
    return dictionary.frequencyCount === 0 && dictionary.pitchCount === 0 && dictionary.kanjiCount === 0;
  }

  const KANJI_SELECTION_KINDS = new Set(["term", "kanji"]);

  // Keep a disabled source selected so re-enabling it restores the same route.
  // Removed groups, dictionaries or capabilities reset the clicked-kanji choice.
  function normaliseKanjiClickSelection(value, dictionaries, groups) {
    const selection = typeof value === "string" ? { title: value, kind: "" } : value;
    if (selection?.kind === "tabGroup") {
      return groups.some((group) => group.id === selection.id) ? value : "";
    }
    if (!selection?.title) return value;
    const selected = dictionaries.find((entry) => entry.title === selection.title);
    let kind = selection.kind;
    if (!KANJI_SELECTION_KINDS.has(kind)) {
      kind = selected && hasCapability(selected, "kanji") ? "kanji" : "term";
    }
    if (!selected || !hasCapability(selected, kind)) return "";
    return KANJI_SELECTION_KINDS.has(selection.kind) ? value : { title: selection.title, kind };
  }

  // Storage commits and backup preparation prune against the same library.
  function normaliseDictionarySelections(value, dictionaries, groups = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const options = { ...value };
    const selectedFrequency = dictionaries.find((entry) => entry.title === options.frequencyDictionary);
    if (options.frequencyDictionary
        && (!selectedFrequency || selectedFrequency.enabled === false || !hasCapability(selectedFrequency, "freq"))) {
      options.frequencyDictionary = "";
    }
    if (Object.hasOwn(options, "kanjiClickDictionary")) {
      options.kanjiClickDictionary = normaliseKanjiClickSelection(options.kanjiClickDictionary, dictionaries, groups);
    }
    return options;
  }

  // A dictionary's clicked-kanji capability: native kanji entries when it has
  // them, otherwise its term entries. Metadata-only packages have neither.
  function kanjiCapability(dictionary, requestedKind = "") {
    if (!dictionary || dictionary.enabled === false) return null;
    const defaultKind = dictionary.kanjiCount > 0 ? "kanji" : "term";
    const kind = requestedKind === "" ? defaultKind : requestedKind;
    const available = hasCapability(dictionary, kind === "kanji" ? "kanji" : "term");
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

  // Keys an older stored record or backup may still carry. `modifier` and
  // `definitionBlurEnabled` migrate; `hoverDelayMs` was never adjustable and is
  // dropped rather than read as `scanDelayMs`.
  const RETIRED_OPTION_KEYS = ["modifier", "definitionBlurEnabled", "hoverDelayMs"];

  // `definitionBlurEnabled` was renamed; the new key wins when both are present.
  function legacyBlurCountOption(source, strict) {
    if (!Object.hasOwn(source, "definitionBlurEnabled") || Object.hasOwn(source, "definitionBlurCountEnabled")) return {};
    const value = source.definitionBlurEnabled;
    if (typeof value === "boolean") return { definitionBlurCountEnabled: value };
    if (strict) throw new Error("the options write request carried an invalid reader option");
    return {};
  }

  function projectOptionKeys(value, strict) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = { ...legacyActivationOptions(source, strict), ...legacyBlurCountOption(source, strict) };
    // Keep the existing mining choice when the experiment becomes an Anki
    // option. An explicit new option takes precedence over the old flag.
    if (!Object.hasOwn(source, "smallerAnkiCards") && typeof source.experimental?.smallerAnkiCards === "boolean") {
      result.smallerAnkiCards = source.experimental.smallerAnkiCards;
    }
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
    if (key === "experimental") return validExperimental(raw, normalized);
    if (key === "kanjiClickDictionary") return typeof raw === "string" || typeof normalized === "object";
    if (key === "popupImageSource") return raw === null || normalized !== null;
    if (key === "definitionScanDelayMs") return raw === null || (typeof raw === "number" && raw === normalized);
    if (key === "keybinds") return Array.isArray(raw) && raw.length === normalized.length
      && normalized.every((bind, index) => raw[index] && typeof raw[index] === "object" && JSON.stringify(bind)
        === JSON.stringify(Object.fromEntries(Object.keys(bind).map(field => [field, raw[index][field]]))));
    if (key === "audioSources" || key === "customLinks" || key === "customButtons") return Array.isArray(raw) && raw.length === normalized.length
      && normalized.every((source, index) => Object.entries(source).every(([field, value]) => raw[index][field] === value));
    return typeof raw === typeof DEFAULT_OPTIONS[key] && raw === normalized;
  }

  // A record with profiles reads, for code that predates them, as its Japanese
  // profile flattened with the global keys (docs/languages.md 5.1).
  function projectStoredOptions(value) {
    return projectOptionKeys(hasProfiles(value) ? flatProfileRecord(value, JAPANESE_PROFILE_ID) : value, false);
  }

  function validateOptionsPatch(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the options write request carried no object");
    }
    return projectOptionKeys(value, true);
  }

  function normaliseOptions(value) {
    return normaliseFlatOptions(hasProfiles(value) ? flatProfileRecord(value, JAPANESE_PROFILE_ID) : value);
  }

  function normaliseFlatOptions(value) {
    const options = { ...DEFAULT_OPTIONS, ...projectOptionKeys(value, false) };
    const source = value && typeof value === "object" ? value : {};
    options.anki = normaliseAnki(options.anki);
    if (Object.hasOwn(source, "customButtons")) {
      options.customButtons = normaliseCustomButtons(options.customButtons);
    } else {
      options.customButtons = legacyCustomButtons(options.customLinks);
    }
    options.customLinks = customLinksFromButtons(options.customButtons);
    options.experimental = { ...options.experimental };
    // A keybind list saved before the search page had keys has no search row:
    // it gains the search page's defaults, so its Up recalls a line whatever was
    // saved. Settings saves them with the next keybind edit. A list with any
    // search row is the user's own.
    if (!options.keybinds.some(bind => bind.scopes.includes("search"))) {
      options.keybinds = [...options.keybinds, ...SEARCH_KEYBINDS];
    }
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
    return normaliseOptions(value);
  }

  // ---------------------------------------------------------------------------
  // The profile layer (docs/languages.md, sections 4 and 5). A record without
  // `profiles` is the single-profile shape: today's record, read as one
  // Japanese profile through today's code path. Once the records have profiles,
  // global keys stay at the top level of `options`, profile keys live only in
  // `profiles[].settings`, and `anki` is split: `url` and `apiKey` at the top,
  // `templates` in the profile.
  // ---------------------------------------------------------------------------

  const JAPANESE_PROFILE_ID = "ja";
  const JAPANESE_LANGUAGE = "ja";
  // Section 5.2: requests that name no profile mean the Japanese data, and a
  // request naming a profile that does not exist is refused.
  const PROFILE_MESSAGES = Object.freeze({
    noJapaneseProfile: "This Hachidori has no Japanese profile. Add Japanese in its Settings, or update the linked browser.",
    profileRemoved: "This language was removed in another Hachidori page.",
  });
  // Appendix A of the design: the keys that describe the reader's hands,
  // screen and machine rather than a language. Every other option key except
  // `anki` belongs to the profile.
  const GLOBAL_OPTION_KEYS = Object.freeze([
    "hoverEnabled", "lookupMode", "activationKey", "definitionLookupMode", "scanDelayMs", "definitionScanDelayMs",
    "popupHideDelayMs", "hidePopupOnCursorExit", "hidePopupOnCursorExitDelayMs", "popupNestingMaxDepth",
    "popupToolbarPosition", "customPopupCss", "customPopupJavascript", "smallerAnkiCards", "experimental",
    "popupWidthPx", "popupHeightPx", "popupScalePercent", "sourceHighlightEnabled", "automaticBackupDays",
    "useLessRamByDefault", "lowMemoryMode", "dictionaryEntryStorage", "dictionaryIndexStorage",
    "showToolbarSearchButton", "searchClickLookup", "searchWindowWidthPx", "searchWindowHeightPx", "keybinds",
    "searchHistoryEnabled", "searchHistoryLimit",
  ]);
  const GLOBAL_KEYS = new Set(GLOBAL_OPTION_KEYS);
  const PROFILE_OPTION_KEYS = Object.freeze(OPTION_KEYS.filter(key => !GLOBAL_KEYS.has(key) && key !== "anki"));
  const PROFILE_KEYS = new Set(PROFILE_OPTION_KEYS);
  // Retired keys migrate into the scope of the key they became.
  const GLOBAL_RETIRED_KEYS = ["modifier", "hoverDelayMs"];
  const LANGUAGE_CODE = /^[a-z]{2,3}$/u;
  // `Hani` in a requirement matches every script code that includes Han.
  const HAN_SCRIPTS = new Set(["Hani", "Hans", "Hant", "Hanb", "Jpan", "Kore"]);

  // Section 7.3: each option key that needs something of the language, and the
  // value that makes it behave as off for a profile that lacks it.
  const OPTION_REQUIREMENTS = Object.freeze({
    showPitchAccentFurigana: { requires: "pitchAccent", neutral: false },
    pitchAccentFuriganaDictionary: { requires: "pitchAccent", neutral: "" },
    pitchAccentFuriganaStyle: { requires: "pitchAccent", neutral: "contour" },
    showPitchAccentBadge: { requires: "pitchAccent", neutral: false },
    showPitchAccentDictionaryNames: { requires: "pitchAccent", neutral: false },
    showPitchAccentText: { requires: "pitchAccent", neutral: false },
    showPitchAccentPosition: { requires: "pitchAccent", neutral: false },
    showPitchAccentGraph: { requires: "pitchAccent", neutral: false },
    showPitchAccentColors: { requires: "pitchAccent", neutral: false },
    kanjiClickDictionary: { requires: "characterView", neutral: "" },
    wordHighlightEnabled: { requires: "wordHighlighting", neutral: false },
    wordHighlightUnknown: { requires: "wordHighlighting", neutral: true },
    wordHighlightLearning: { requires: "wordHighlighting", neutral: true },
    wordHighlightKnown: { requires: "wordHighlighting", neutral: false },
    wordHighlightIgnored: { requires: "wordHighlighting", neutral: false },
    wordHighlightStyle: { requires: "wordHighlighting", neutral: "underline" },
  });

  function plainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function hasProfiles(storedOptions) {
    return Array.isArray(plainObject(storedOptions)?.profiles);
  }

  function storedRevision(storedOptions) {
    const revision = plainObject(storedOptions)?.revision;
    return Number.isInteger(revision) && revision >= 0 ? revision : 0;
  }

  function pick(source, keys) {
    return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
  }

  // The top-level `anki` of a record with profiles: the connection only.
  function ankiConnection(value) {
    const source = plainObject(value);
    if (source === null) return null;
    return {
      ...(Object.hasOwn(source, "url") ? { url: normaliseAnkiConnectUrl(source.url) ?? "" } : {}),
      apiKey: typeof source.apiKey === "string" ? source.apiKey : DEFAULT_ANKI.apiKey,
    };
  }

  // A profile's own `anki`: its Templates only.
  function ankiTemplates(value) {
    const source = plainObject(value);
    return source === null ? null : { templates: normaliseAnki({ templates: source.templates }).templates };
  }

  // A stored profile with anything malformed dropped; null when it has no
  // usable id or language. Its settings are the sparse profile keys it holds.
  function normaliseProfile(value) {
    const source = plainObject(value);
    if (source === null || !validIdentifier(source.id)
        || typeof source.language !== "string" || !LANGUAGE_CODE.test(source.language)) return null;
    const settings = plainObject(source.settings) ?? {};
    const projected = projectOptionKeys(pick(settings, [...PROFILE_OPTION_KEYS, "definitionBlurEnabled"]), false);
    const anki = ankiTemplates(settings.anki);
    return {
      id: source.id,
      language: source.language,
      settings: { ...pick(projected, PROFILE_OPTION_KEYS), ...(anki === null ? {} : { anki }) },
      packSettings: { ...plainObject(source.packSettings) },
    };
  }

  function storedProfiles(storedOptions) {
    const ids = new Set();
    return storedOptions.profiles.flatMap(value => {
      const profile = normaliseProfile(value);
      if (profile === null || ids.has(profile.id)) return [];
      ids.add(profile.id);
      return [profile];
    });
  }

  // A flat record's own profile keys, as a profile's settings.
  function profileSettingsOf(flat) {
    const anki = flat.anki === undefined ? null : { templates: normaliseAnki(flat.anki).templates };
    return { ...pick(flat, PROFILE_OPTION_KEYS), ...(anki === null ? {} : { anki }) };
  }

  /**
   * The profile list. A record without `profiles` is one Japanese profile
   * holding the record's own profile keys.
   * @returns {{id: string, language: string, settings: object, packSettings: object}[]}
   */
  function profiles(storedOptions) {
    if (!hasProfiles(storedOptions)) {
      return [{ id: JAPANESE_PROFILE_ID, language: JAPANESE_LANGUAGE,
        settings: profileSettingsOf(projectOptionKeys(storedOptions, false)), packSettings: {} }];
    }
    return storedProfiles(storedOptions);
  }

  function findProfile(storedOptions, profileId) {
    return profiles(storedOptions).find(profile => profile.id === profileId) ?? null;
  }

  // The flat record a profile reads as: the global keys from the top level,
  // the profile keys from the profile (none without one), `anki` joined.
  function flatProfileRecord(storedOptions, profileId) {
    const source = plainObject(storedOptions);
    const profile = findProfile(storedOptions, profileId);
    const flat = pick(source, [...GLOBAL_OPTION_KEYS, ...GLOBAL_RETIRED_KEYS]);
    if (profile !== null) {
      const { anki: profileAnki, ...settings } = profile.settings;
      Object.assign(flat, settings);
      const connection = ankiConnection(source.anki);
      if (connection !== null || profileAnki !== undefined) {
        flat.anki = { ...connection, ...(profileAnki === undefined ? {} : { templates: profileAnki.templates }) };
      }
    } else {
      const connection = ankiConnection(source.anki);
      if (connection !== null) flat.anki = connection;
    }
    return flat;
  }

  function registry() {
    const languages = globalThis.HDLanguages;
    return languages && typeof languages.get === "function" ? languages : null;
  }

  // A language's descriptor from the registry; null outside a build that has
  // its pack, and in contexts that load no registry.
  function languageDescriptor(language) {
    return registry()?.get(language) ?? null;
  }

  function validPackSettingValue(setting, value) {
    if (setting?.type === "boolean") return typeof value === "boolean";
    if (setting?.type === "enum") return Array.isArray(setting.values) && setting.values.some(entry => entry?.id === value);
    if (setting?.type === "number") {
      return typeof value === "number" && Number.isFinite(value)
        && (typeof setting.min !== "number" || value >= setting.min)
        && (typeof setting.max !== "number" || value <= setting.max);
    }
    return false;
  }

  // A pack setting's value for a profile: the stored one when the pack
  // declares the setting and the value is valid for it, otherwise its default.
  function packSettingValue(descriptor, packSettings, id) {
    const setting = (Array.isArray(descriptor?.settings) ? descriptor.settings : []).find(entry => entry?.id === id);
    if (!setting) return undefined;
    const value = plainObject(packSettings)?.[id];
    return validPackSettingValue(setting, value) ? value : setting.default;
  }

  // Whether a language has a capability: optional ones only while a pack
  // setting with that capability effect turns them on.
  function languageCapability(descriptor, name, packSettings = {}) {
    const value = descriptor?.capabilities?.[name];
    if (name === "readings") return value === "required" || value === "optional";
    if (value === undefined || value === null || value === false) return false;
    if (plainObject(value)?.optional === true) {
      const setting = (Array.isArray(descriptor.settings) ? descriptor.settings : [])
        .find(entry => entry?.effect?.capability === name);
      return setting !== undefined && packSettingValue(descriptor, packSettings, setting.id) === true;
    }
    return true;
  }

  // Section 7.3: a capability name, {scripts: [...]} or "ankiNoteTypeFamilies".
  // Japanese meets every requirement, also where no registry is loaded; a
  // language this context has no descriptor for meets none.
  function optionRequirementMet(requirement, language, packSettings = {}) {
    const descriptor = languageDescriptor(language);
    if (descriptor === null) return language === JAPANESE_LANGUAGE;
    if (requirement === "ankiNoteTypeFamilies") {
      const families = descriptor.host?.anki?.noteTypeFamilies;
      return Array.isArray(families) && families.length > 0;
    }
    if (Array.isArray(plainObject(requirement)?.scripts)) {
      const scripts = Array.isArray(descriptor.scripts) ? descriptor.scripts : [];
      return requirement.scripts.some(wanted => scripts.some(script => script === wanted
        || (wanted === "Hani" && HAN_SCRIPTS.has(script))));
    }
    return typeof requirement === "string" && languageCapability(descriptor, requirement, packSettings);
  }

  function maskOptions(options, language, packSettings) {
    for (const [key, { requires, neutral }] of Object.entries(OPTION_REQUIREMENTS)) {
      if (!optionRequirementMet(requires, language, packSettings)) options[key] = neutral;
    }
    return options;
  }

  /**
   * Flat options for one profile, shaped exactly like normaliseOptions' result:
   * global keys from the top level, profile keys from the profile, then
   * capability masking (section 7.3) unless `masked` is false. A profile the
   * record lacks reads as the global keys over the defaults.
   */
  function projectOptions(storedOptions, profileId = JAPANESE_PROFILE_ID, { masked = true } = {}) {
    if (!hasProfiles(storedOptions)) {
      if (profileId === JAPANESE_PROFILE_ID) return normaliseFlatOptions(storedOptions);
      const options = normaliseFlatOptions(pick(plainObject(storedOptions) ?? {}, [...GLOBAL_OPTION_KEYS, ...GLOBAL_RETIRED_KEYS]));
      return masked ? maskOptions(options, null, {}) : options;
    }
    const profile = findProfile(storedOptions, profileId);
    const options = normaliseFlatOptions(flatProfileRecord(storedOptions, profileId));
    return masked ? maskOptions(options, profile?.language ?? null, profile?.packSettings ?? {}) : options;
  }

  // `{ id, language, packSettings }`, or null when the record has no such profile.
  function profileDescriptor(storedOptions, profileId) {
    const profile = findProfile(storedOptions, profileId);
    return profile === null ? null : { id: profile.id, language: profile.language, packSettings: { ...profile.packSettings } };
  }

  // The top level of a record with profiles, normalised: sparse global keys
  // and the Anki connection.
  function storedGlobals(storedOptions) {
    const source = plainObject(storedOptions) ?? {};
    const globals = pick(projectOptionKeys(pick(source, [...GLOBAL_OPTION_KEYS, ...GLOBAL_RETIRED_KEYS]), false),
      GLOBAL_OPTION_KEYS);
    const connection = ankiConnection(source.anki);
    return connection === null ? globals : { ...globals, anki: connection };
  }

  function patchHoldsProfileKeys(patch) {
    return Object.keys(patch).some(key => key === "anki" || PROFILE_KEYS.has(key));
  }

  /**
   * The one options writer (section 5.2): applies a validated flat patch to the
   * stored, unmasked record, keeping its revision; callers move the revision.
   * Global keys go to the top level, profile keys to the named profile, `anki`
   * split. For a single-profile record it is exactly what today's writers do:
   * the stored projection, its revision, then the patch.
   */
  function applyOptionsPatch(storedOptions, patch, profileId = JAPANESE_PROFILE_ID) {
    const revision = storedRevision(storedOptions);
    const flatPatch = plainObject(patch) ?? {};
    if (!hasProfiles(storedOptions)) {
      if (profileId !== JAPANESE_PROFILE_ID && patchHoldsProfileKeys(flatPatch)) {
        throw new Error("the options write names a profile that does not exist");
      }
      return { ...projectOptionKeys(storedOptions, false), revision, ...flatPatch };
    }
    const list = storedProfiles(storedOptions);
    const index = list.findIndex(profile => profile.id === profileId);
    if (index < 0 && patchHoldsProfileKeys(flatPatch)) {
      throw new Error("the options write names a profile that does not exist");
    }
    const top = storedGlobals(storedOptions);
    const settings = index < 0 ? null : { ...list[index].settings };
    for (const [key, value] of Object.entries(flatPatch)) {
      if (key === "anki") {
        top.anki = ankiConnection(value);
        settings.anki = ankiTemplates(value);
      } else if (GLOBAL_KEYS.has(key)) {
        top[key] = value;
      } else if (PROFILE_KEYS.has(key)) {
        settings[key] = value;
      }
    }
    return { revision, ...top,
      profiles: list.map((profile, position) => position === index ? { ...profile, settings } : profile) };
  }

  // A patch of pack settings by id (section 7.5): ids the language's pack
  // declares must carry valid values, ids the patch omits keep theirs, and a
  // value for an id this build's pack does not declare is kept as sent.
  function applyPackSettingsPatch(storedOptions, packPatch, profileId) {
    const patch = plainObject(packPatch);
    if (patch === null) throw new Error("the pack settings write carried no object");
    if (Object.keys(patch).length === 0) return storedOptions;
    if (!hasProfiles(storedOptions)) throw new Error("This language has no settings of its own.");
    const list = storedProfiles(storedOptions);
    const index = list.findIndex(profile => profile.id === profileId);
    if (index < 0) throw new Error("the options write names a profile that does not exist");
    const descriptor = languageDescriptor(list[index].language);
    for (const [id, value] of Object.entries(patch)) {
      const setting = (Array.isArray(descriptor?.settings) ? descriptor.settings : []).find(entry => entry?.id === id);
      if (setting !== undefined && !validPackSettingValue(setting, value)) {
        throw new Error(`the pack setting ${JSON.stringify(id)} carried an invalid value`);
      }
    }
    const profilesList = list.map((profile, position) => position === index
      ? { ...profile, packSettings: { ...profile.packSettings, ...patch } } : profile);
    return { ...applyOptionsPatch(storedOptions, {}, profileId), profiles: profilesList };
  }

  // dictionaryState schema 2 (section 4.2): `dictionaries` lists every package
  // once, without `enabled`; `profiles[id]` holds each profile's ordered list
  // of `{ id, enabled }` and its groups.
  const DICTIONARY_STATE_PROFILES_SCHEMA = 2;

  function hasDictionaryProfiles(storedState) {
    const state = plainObject(storedState);
    return state?.schemaVersion === DICTIONARY_STATE_PROFILES_SCHEMA && plainObject(state.profiles) !== null;
  }

  // A package row with `enabled` where today's rows carry it: after `path`.
  function packageWithEnabled(row, enabled) {
    const result = {};
    let placed = false;
    for (const [key, value] of Object.entries(row)) {
      if (key === "enabled") continue;
      result[key] = value;
      if (key === "path") {
        result.enabled = enabled;
        placed = true;
      }
    }
    if (!placed) result.enabled = enabled;
    return result;
  }

  /**
   * The schema-1 view of one profile: its packages in its order with its
   * `enabled` flags, and its groups. A single-profile state is the Japanese
   * profile's view as stored; null when the state has no such profile.
   */
  function projectDictionaryState(storedState, profileId = JAPANESE_PROFILE_ID) {
    if (storedState === null || storedState === undefined) return null;
    if (!hasDictionaryProfiles(storedState)) return profileId === JAPANESE_PROFILE_ID ? storedState : null;
    const profile = plainObject(storedState.profiles[profileId]);
    if (profile === null) return null;
    const packages = new Map((Array.isArray(storedState.dictionaries) ? storedState.dictionaries : [])
      .filter(row => plainObject(row) !== null).map(row => [row.id, row]));
    const dictionaries = (Array.isArray(profile.dictionaries) ? profile.dictionaries : []).flatMap(entry => {
      const row = packages.get(entry?.id);
      return row === undefined ? [] : [packageWithEnabled(row, entry.enabled !== false)];
    });
    return {
      schemaVersion: 1,
      revision: storedState.revision,
      dictionaries,
      groups: Array.isArray(profile.groups) ? profile.groups : [],
    };
  }

  /**
   * Every package once, in installation order, with `enabled` meaning
   * "enabled in any profile": what the engine loads, what managed updates and
   * the installer see. A single-profile state's own list.
   */
  function allPackages(storedState) {
    if (storedState === null || storedState === undefined) return [];
    const rows = Array.isArray(storedState.dictionaries) ? storedState.dictionaries : [];
    if (!hasDictionaryProfiles(storedState)) return rows;
    const enabled = new Set(Object.values(storedState.profiles).flatMap(profile =>
      (Array.isArray(profile?.dictionaries) ? profile.dictionaries : [])
        .filter(entry => entry?.enabled !== false).map(entry => entry?.id)));
    return rows.filter(row => plainObject(row) !== null).map(row => packageWithEnabled(row, enabled.has(row.id)));
  }

  // The installation-local active profile and automatic switching (section
  // 4.4). The key exists only once the records have profiles; an absent key
  // reads as revision 0 with no choice.
  const LANGUAGE_SELECTION_KEY = "languageSelection";

  function normaliseLanguageSelection(value) {
    const source = plainObject(value) ?? {};
    return {
      revision: storedRevision(source),
      activeProfileId: validIdentifier(source.activeProfileId) ? source.activeProfileId : null,
      autoSwitch: source.autoSwitch === true,
    };
  }

  // Advanced → Experimental features → Multiple languages (section 16.3).
  function languagesEnabled(storedOptions) {
    return normaliseExperimental(plainObject(storedOptions)?.experimental).multipleLanguages === true;
  }

  // The profile this installation looks words up in: the selection's when it
  // names an existing profile and Multiple languages is on, otherwise the
  // Japanese profile, or the first profile when there is none.
  function activeProfileId(storedOptions, selection) {
    const list = profiles(storedOptions);
    const chosen = languagesEnabled(storedOptions) ? normaliseLanguageSelection(selection).activeProfileId : null;
    if (list.some(profile => profile.id === chosen)) return chosen;
    return list.find(profile => profile.id === JAPANESE_PROFILE_ID)?.id ?? list[0]?.id ?? JAPANESE_PROFILE_ID;
  }

  globalThis.HDReaderOptions = {
    ANKI_FIELDS, ANKI_DUPLICATE_SCOPES, ANKI_DUPLICATE_BEHAVIORS, ANKI_OVERWRITE_MODES,
    ANKI_TEMPLATE_CONFIG_KEYS, DEFAULT_ANKI_TEMPLATE, STABLE_ID_MAX_LENGTH,
    DEFAULT_OPTIONS, RETIRED_OPTION_KEYS, NUMBER_RANGES, LOOKUP_MODES, DEFINITION_LOOKUP_MODES, ACTIVATION_BUTTONS, ACTIVATION_KEYS, FREQUENCY_ORDERS,
    POPUP_THEME_GROUPS, POPUP_RENDERER_IDS, POPUP_THEME_VARIANTS, popupRenderer, DESIGN_OPTION_KEYS,
    KEYBIND_ACTIONS, KEYBIND_ARGUMENT_DEFAULTS, KEYBIND_SCOPES, KEYBIND_MODIFIERS, KEYBIND_MODIFIER_CODES, KEYBIND_TOGGLE_OPTIONS,
    keybindModifiers, keybindWheelKey,
    AUDIO_SOURCE_TYPES, AUDIO_SOURCE_LABELS,
    EXPERIMENTAL_FEATURES,
    activationLabel, clampOption, normaliseActivationKey, normaliseKanjiSelection, normaliseOptions,
    normaliseAnkiConnectUrl, normaliseAnki,
    normaliseCustomButtons, normaliseExperimental, ankiTemplateConfig,
    definitionBlurFrequencyDictionary, definitionBlurFrequencyEvidence, definitionBlurQualifies, frequencyModeOrder,
    DEFINITION_BLUR_DIRECTIONS, DEFINITION_BLUR_REVEALS, DEFINITION_BLUR_FREQUENCY_ORDERS, IMAGE_HOVER_PREVIEWS,
    GLOSSARY_LAYOUT_MODES, PITCH_ACCENT_FURIGANA_STYLES, WORD_HIGHLIGHT_STYLES,
    projectStoredOptions, projectContentOptions, validateOptionsPatch, normaliseDictionarySelections,
    resolvePopupImageSources,
    hasCapability, resolveKanjiDictionary,
    JAPANESE_PROFILE_ID, GLOBAL_OPTION_KEYS, PROFILE_OPTION_KEYS, OPTION_REQUIREMENTS, PROFILE_MESSAGES,
    hasProfiles, profiles, projectOptions, profileDescriptor, applyOptionsPatch, applyPackSettingsPatch,
    hasDictionaryProfiles, projectDictionaryState, allPackages, packageWithEnabled,
    languageDescriptor, optionRequirementMet, packSettingValue,
    LANGUAGE_SELECTION_KEY, normaliseLanguageSelection, activeProfileId, languagesEnabled,
  };
}());
