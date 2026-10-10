/*
 * Hover scanning, popup hosting, and offscreen-engine messaging for
 * Hachidori.
 *
 * Rendering lives in render/popup.js and render/glossary.js (ported from
 * GameSentenceMiner PR #549); this file only produces the candidates those
 * modules consume and drives the request/reply state machine. A candidate
 * carries its raw page text as {sourceElements, sourceText, sourceOffset} for
 * the highlighter and Yomitan's sentence around the match as {sentence,
 * matchOffset} for Anki notes. Like Yomitan's default layout-unaware scan,
 * page text is read in DOM order regardless of how it is boxed, and a pointer
 * candidate's sources are the text nodes around the hovered glyph.
 *
 * Reading the page text itself lives in content-scan.js, and the dictionary
 * state and kanji-group replies in content-dictionaries.js. Both load before
 * this file and publish on globalThis.HDContent.
 *
 * Copyright (C) 2026 Manhhao
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function () {
  "use strict";

  const TARGET = "hoshidicts-offscreen";
  const PAGE_ZOOM_TARGET = "hachidori-page-zoom";
  const WORKER_TARGET = "hoshidicts-worker";
  const READER_TARGET = "hachidori-reader";
  // The worker's word-status change signal for reading tabs (#520).
  const WORD_STATUS_TARGET = "hachidori-anki-content";
  const HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const HOST_TAG = "hachidori-host";
  const POPUP_SHOWN_EVENT = "hachidori-popup-shown";
  const POPUP_HIDDEN_EVENT = "hachidori-popup-hidden";
  const EXTENSION_PROTOCOL = (() => {
    try {
      return new URL(chrome.runtime.getURL("")).protocol;
    } catch {
      return "";
    }
  })();

  const {
    ACTIVATION_BUTTONS,
    DEFAULT_OPTIONS,
    KEYBIND_MODIFIER_CODES,
    clampOption,
    definitionBlurFrequencyEvidence,
    definitionBlurQualifies,
    keybindModifiers,
    keybindWheelKey,
    normaliseActivationKey,
    projectContentOptions,
  } = globalThis.HDReaderOptions;
  const { normaliseLookupTerm, lookupStatsKey } = globalThis.HDLookupStats;
  const { normaliseDictionaryTab: normalizedDictionaryTab } = globalThis.HDPopup;
  const {
    mergeKanjiGroupResults, nativeKanjiEntries, normalizeDictionaryState, projectResultsToDictionary, sameDictionaries,
    sameDictionaryContents,
  } = globalThis.HDContent;
  const {
    EDITING_SELECTOR, JAPANESE_CHARACTER_PATTERN, OPAQUE_TAGS, blockOf, candidateSignature, candidateStart,
    caretRangeAt, collectScanEntries, collectSentenceSources, computedStyleFor, expandCandidateAnchor, glyphAtPoint,
    hasVisibleContent, isEditingElement, isHiddenElement, isJapaneseToken, isScannableElement, isScannableTextNode,
    rangeOffsetWithin, rawMatchedText, refineSentence, runEntries, sameAnchorNode, selectionSentence,
    sentenceMatchedText, sourceOffset, textBlocks, textRuns, withSentence,
  } = globalThis.HDContent.createPageScanner({ isOurNode });
  const MODIFIER_PROPERTIES = new Map([
    ["Shift", "shiftKey"],
    ["Control", "ctrlKey"],
    ["Alt", "altKey"],
    ["Meta", "metaKey"],
  ]);
  // MouseEvent.button values of Back and Forward, which navigate on release.
  const NAVIGATION_BUTTONS = new Set([3, 4]);
  // Popup text that looks up child popups.
  const DEFINITION_TEXT_SELECTOR = ".gsm-hoshidicts-glossary-content, .gsm-hoshidicts-compact-definition-summary";

  const POPUP_GAP_PX = 4;
  const POPUP_PADDING_PX = 6;
  const MAX_MEDIA_CACHE_BYTES = 16 * 1024 * 1024;
  const MAX_MEDIA_CACHE_ENTRIES = 64;
  const MAX_MEDIA_CONCURRENT_REQUESTS = 4;
  const MAX_MEDIA_PENDING_REQUESTS = 128;
  const MEDIA_REQUEST_TIMEOUT_MS = 4000;

  // Deliberately narrow: "receiving end does not exist" also fires while the
  // service worker is still waking up, and tearing down on that would kill the
  // content script over a transient race.
  const INVALIDATED_MESSAGE_PATTERN = /context invalidated/iu;

  if (typeof document.createTreeWalker !== "function") {
    return;
  }
  // The reader belongs to ordinary pages. First-run setup loads these same
  // scripts into its own startup page for the practice step. Its native skip
  // link may leave the known heading fragment before the module loads or on
  // reload; query variants and every other internal page stay excluded.
  if (
    location.protocol === EXTENSION_PROTOCOL &&
    location.href !== chrome.runtime.getURL("startup.html") &&
    location.href !== chrome.runtime.getURL("startup.html#setup-heading")
  ) {
    return;
  }

  let gsmBridge = null; // GSM hook
  let disposed = false;
  let appearance;
  let customStyle;
  let audio, mining;
  let options = { ...DEFAULT_OPTIONS };
  let dictionaries = [];
  let dictionaryGroups = [];
  let nextRequestId = 0;
  let currentGeneration = -1;

  const rootLevel = createLevelState(0);
  const levels = [rootLevel];
  let nextLevelId = 0;
  const themeHost = window.HDThemeHost.createThemeHost({
    getOptions: () => options,
    onReady() {
      styleGeneration = -1;
      appearance?.refreshHighlight();
      wordHighlights?.refreshColors();
      if (shadow) ensureDictionaryStyles(currentGeneration);
    },
  });

  function createLevelState(depth) {
    return {
      depth, popup: null, view: null, highlighter: null, retired: false,
      activeCandidate: null, activeSignature: null, activeHighlightText: "",
      activeTermRender: null, currentViewRequest: null, noteEditing: false,
      pendingCustomAppends: 0, deferredDictionaryInvalidationRevision: -1,
      deferredRefresh: null, lookupToken: 0, pendingHover: null, pendingLink: null,
      retainedView: false,
      pendingViewReplay: null,
      blurTimer: null,
      placedAnchor: null,
    };
  }

  let host = null;
  let shadow = null;
  let highlighter = null;
  let uiPromise = null;
  let popupLayoutFrame = null;
  let popupLayouts = new Map();
  let pageZoom = 1;
  let pageZoomRatio = null;
  let pageZoomRequest = 0;
  let sessionPopupSize = null;
  let popupResize = null;

  let styleGeneration = -1;
  let styleRequest = null;
  const mediaCache = new Map();
  const pendingMedia = new Map();
  let mediaCacheBytes = 0;
  let activeMediaRequests = 0;
  let mediaQueue = [];
  let popupImageSources = null;

  let lastPointer = null;
  let scanTimer = null;
  // The one word a lookup that needs no key is waiting on: its level (null for
  // the page), candidate and timer. See dwellElapsed().
  let scanDwell = null;
  let hideTimer = null;
  let transferTimer = null;
  let descendantTimer = null;
  let cursorExitTimer = null;
  let pointerLevel = null;
  let pointerInPopup = false;
  let activationPressed = false;
  let activationCode = null;
  // A press or a key since the pointer last moved: the reader may be typing in
  // the field under the pointer rather than pointing at its text.
  let editedSincePointerMoved = false;
  // The scan button's last press and the native actions it cancels.
  let scanPress = null;
  let pendingCandidateLookup = null;
  let selectionDragActive = false;
  let activeSelectionCandidate = null;
  // A drag the reader selects itself, glyph by glyph, in an overlay host.
  let dragSelection = null;
  let overlayMode = false;
  let hostCapabilities = { linkButtons: true, externalLinkHost: false };
  let hostAttentionPublished = false;
  let hostAttentionHold = 0;

  let optionsStorageRevision = -1;
  let ankiMaturityEpoch = 0;
  let dictionaryStateRevision = -1;
  let lookupStatsDescriptor = { generation: null, revision: -1 };
  const DEFINITION_BLUR_KEYS = [
    "definitionBlurCountEnabled", "definitionBlurAnkiMature", "definitionBlurFrequencyEnabled",
    "definitionBlurFrequencyDictionary", "frequencyDictionary", "definitionBlurFrequencyOrder", "definitionBlurFrequencyThreshold",
    "definitionBlurDirection", "definitionBlurThreshold", "definitionBlurReveal", "definitionBlurDelayMs",
  ];

  function extensionAlive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // An overlay host such as GSM passes clicks through to the game unless the
  // reader says it needs the window. A popup needs it, and so does a drag that
  // is selecting text: the host answers a mousedown by turning click-through on,
  // which would lose the drag before release could look anything up. The claim
  // carries over to the selection's pending lookup, so the host never sees a
  // gap between the drag and the popup it produces. A held scan button claims
  // the window the same way, or the host would stop reporting it mid-hold.
  // Child popups that wait for it are in a popup, which holds the claim already.
  function syncHostAttention() {
    queueMicrotask(() => gsmBridge?.refresh()); // GSM hook
    const wanted = Boolean(rootLevel.popup && !rootLevel.popup.hidden) || selectionDragActive
      || hostAttentionHold > 0 || pendingCandidateLookup?.candidate?.exactSelection === true
      || (activationPressed && options.lookupMode !== "hover" && activationButton() !== null);
    if (wanted === hostAttentionPublished) return;
    hostAttentionPublished = wanted;
    window.dispatchEvent(new CustomEvent(wanted ? POPUP_SHOWN_EVENT : POPUP_HIDDEN_EVENT));
  }

  function setSelectionDrag(active) {
    selectionDragActive = active;
    if (!active) dragSelection = null;
    syncHostAttention();
  }

  // Overlay hosts (docs/overlay-mode.md) set the flag in overlay-mode.js. This
  // classic script reads the module through its extension URL; a host without
  // it, such as a test page, gets the browser behaviour.
  async function loadOverlayMode() {
    try {
      const module = await import(chrome.runtime.getURL("overlay-mode.js"));
      overlayMode = module.OVERLAY_MODE === true;
      const advertised = module.HOST_CAPABILITIES ?? {};
      hostCapabilities = { ...hostCapabilities, ...advertised };
      if (!Object.hasOwn(advertised, "linkButtons") && Object.hasOwn(advertised, "customLinks")) {
        hostCapabilities.linkButtons = advertised.customLinks;
      }
      const next = applyHostCapabilities(options);
      const customButtonsChanged = JSON.stringify(next.customButtons) !== JSON.stringify(options.customButtons);
      const miningChanged = customButtonsChanged;
      options = next;
      if (customButtonsChanged) {
        for (const level of levels) level.view?.setCustomButtons(options.customButtons);
      }
      if (miningChanged) mining?.update(options, optionsStorageRevision >= 0);
    } catch {
      overlayMode = false;
    }
  }

  function applyHostCapabilities(projected) {
    if (!hostCapabilities.linkButtons) projected = {
      ...projected,
      customLinks: [],
      customButtons: projected.customButtons.filter(button => button.type !== "link"),
    };
    return projected;
  }

  const projectHostOptions = stored => applyHostCapabilities(projectContentOptions(stored));

  function dictionaryPresentation() {
    return dictionaries
      .filter((entry) => entry.enabled !== false)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        favorite: entry.favorite,
        frequencyMode: entry.frequencyMode,
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
      }));
  }

  function dictionaryTabGroups() {
    const titles = new Map(dictionaries.filter((entry) => entry.enabled)
      .map((entry) => [entry.id, entry.title]));
    return dictionaryGroups.map((group) => ({
      id: group.id,
      name: group.name,
      dictionaries: group.dictionaryIds.filter((id) => titles.has(id)).map((id) => titles.get(id)),
    }));
  }

  function selectedKanjiDictionaryCapability() {
    return globalThis.HDReaderOptions.resolveKanjiDictionary(options.kanjiClickDictionary, dictionaries, dictionaryGroups);
  }

  function isOurNode(node) {
    // The text-field imposter can exist before the popup host does.
    if (fieldImposter?.container.contains(node)) {
      return true;
    }
    if (!host) {
      return false;
    }
    // The popup lives in a closed shadow root, so a caret or event inside it is
    // retargeted to the host; a node whose root is not the page document also
    // means "not page text" (user-agent shadow DOM of <input>, page shadow DOM).
    return node === host || (node.nodeType === Node.ELEMENT_NODE
      ? host.contains(node)
      : host.contains(node.parentNode));
  }

  function pageEditorFocused() {
    for (let focused = document.activeElement; focused; focused = focused.shadowRoot?.activeElement) {
      if (isEditingElement(focused)) {
        // Startup is the only extension page allowed above. Its scene arrow
        // keeps keyboard focus without pausing the practice lookup.
        if (location.protocol === EXTENSION_PROTOCOL && focused.matches(".vn-next")) continue;
        return true;
      }
    }
    return false;
  }

  // How many code points of page text a lookup is given. The engine scans
  // options.scanLength of them as before, and reaches further only when the
  // text begins like a dictionary key longer than that (hoshidicts long-key
  // index; each package row carries the longest such key it lists). Eight more
  // leaves room for an inflected ending, matching the engine. Dictionaries
  // imported before the index existed report 0 and cost nothing extra.
  const LONG_KEY_INFLECTION_SLACK = 8;
  const MAX_SCAN_WINDOW = 256;

  function scanWindow() {
    let longest = 0;
    for (const entry of dictionaries) {
      if (entry.enabled !== false && entry.termCount > 0 && entry.longKeyLength > longest) {
        longest = entry.longKeyLength;
      }
    }
    if (longest === 0) return options.scanLength;
    return Math.min(MAX_SCAN_WINDOW, Math.max(options.scanLength, longest + LONG_KEY_INFLECTION_SLACK));
  }

  // Google Docs paints text to <canvas>. While Settings → Advanced →
  // Experimental features → Google Docs is on, background.js has Docs draw its
  // SVG annotation layer as well (google-docs-flag.js): one <rect aria-label>
  // per run of text, with the run's position, transform and font, but still no
  // text node. The reader lays an invisible SVG <text> imposter over the hovered
  // rect and scans that, as Yomitan's google-docs-util does.
  const GOOGLE_DOCS_HOST = location.hostname === "docs.google.com";
  const DOCS_RECT_SELECTOR = ".kix-canvas-tile-content svg>g>rect";
  let docsProbeStyle = null;
  // One imposter per hovered rect: repeated moves over the same run keep
  // sameAnchorNode() true, so they share the pending lookup and the popup.
  let docsImposter = null;

  function docsEnabled() {
    return GOOGLE_DOCS_HOST && options.experimental.googleDocs === true;
  }

  // Experimental Features → Netflix mining: background.js registers
  // netflix-content.js on Netflix while the flag is on; the switch also gates
  // a page that loaded it before the switch went off.
  const NETFLIX_HOST = location.hostname === "www.netflix.com";
  function netflixMiningEnabled() {
    return NETFLIX_HOST && options.experimental.netflixMining === true
      && typeof window.HDNetflix?.miningFields === "function";
  }

  // netflix-content.js cannot read the switch, so the reader tells it whether
  // to pause Netflix while a subtitle is hovered and to keep what the viewer
  // hears for sentence audio, and turns both off when it stops.
  function syncNetflix() {
    if (typeof window.HDNetflix?.setHoverPause !== "function") {
      loadNetflix();
      return;
    }
    const enabled = !disposed && netflixMiningEnabled();
    window.HDNetflix.setHoverPause(enabled);
    window.HDNetflix.setLineAudio(enabled);
  }

  // background.js registers netflix-content.js for Netflix pages that load
  // after the switch goes on. A page that was already open has this reader
  // without it, so the reader asks the worker once to add the Netflix scripts
  // to its document, then follows the switch.
  let netflixLoad = null;
  function loadNetflix() {
    if (netflixLoad !== null || disposed || !NETFLIX_HOST || window !== window.top
        || options.experimental.netflixMining !== true) return;
    netflixLoad = sendRequest("hd_netflix_load", {}, "hachidori-netflix")
      .then(syncNetflix, () => { netflixLoad = null; });
  }

  // Reading → Word highlighting (#520, experimental): word-highlights.js marks
  // this frame's words by their Anki status, reading the page's text as a
  // hover does through textBlocks(), blockOf(), textRuns() and runEntries().
  let wordHighlights = null;
  // Toggle word highlights hides the marks in this frame until it reloads or
  // highlighting is switched off.
  let wordHighlightsHidden = false;
  // Mark as known and Ignore: the popup's buttons and keybinds, and the stored
  // overrides (word-status-overrides.js) they write, which win over the Anki
  // status in the marks.
  let wordStatusActions = null;
  let wordStatusOverrides = new Map();
  let wordStatusOverridesChanged = false;

  // Storage events arrive in commit order, so each one is the current record,
  // whatever its revision: a linked browser's mirror starts again from the
  // host's. The first read applies only if no event has come before it.
  function adoptWordStatusOverrides(value, changed) {
    if (!changed && wordStatusOverridesChanged) return;
    wordStatusOverridesChanged ||= changed;
    wordStatusOverrides = window.HDWordStatusOverrides.wordStatusOverrideMap(value);
    wordHighlights?.setOverrides(wordStatusOverrides);
    wordStatusActions?.setOverrides(wordStatusOverrides);
  }

  function syncWordHighlights() {
    if (!options.wordHighlightEnabled) wordHighlightsHidden = false;
    if (disposed || !options.hoverEnabled || !options.wordHighlightEnabled || wordHighlightsHidden) {
      wordHighlights?.stop();
      return;
    }
    if (!wordHighlights) {
      wordHighlights = window.HDWordHighlights.createWordHighlighter({
        window,
        send: sendRequest,
        textBlocks,
        blockOf,
        textRuns,
        runEntries,
        isJapanese: (text) => JAPANESE_CHARACTER_PATTERN.test(text),
        prepare: ensureUi,
        readPalette: () => (host ? window.getComputedStyle(host) : null),
      });
      wordHighlights.setOverrides(wordStatusOverrides);
    }
    if (wordHighlights.running) wordHighlights.update(options);
    else wordHighlights.start(options);
  }

  function onWordStatusChanged(message) {
    if (!disposed && message?.target === WORD_STATUS_TARGET && message.type === "hd_anki_word_status_changed") {
      wordHighlights?.statusChanged(message.revision ?? null);
    }
    return false;
  }

  function releaseDocsImposter() {
    docsImposter?.text.remove();
    docsImposter = null;
  }

  function releaseDocsProbe() {
    releaseDocsImposter();
    docsProbeStyle?.remove();
    docsProbeStyle = null;
  }

  /** The annotation rect under the pointer, or null. The tiles are only hit-testable while the probe style is on. */
  function docsRectAt(clientX, clientY) {
    if (!docsProbeStyle) {
      docsProbeStyle = document.createElement("style");
      docsProbeStyle.textContent = ".kix-canvas-tile-content{pointer-events:none!important}"
        + ".kix-canvas-tile-content svg>g>rect{pointer-events:all!important}";
      (document.head || document.documentElement).append(docsProbeStyle);
    }
    docsProbeStyle.disabled = false;
    const element = document.elementFromPoint(clientX, clientY);
    docsProbeStyle.disabled = true;
    return element?.matches(DOCS_RECT_SELECTOR) && element.getAttribute("aria-label") ? element : null;
  }

  /** The SVG <text> carrying `rect`'s run at its position, transform and font; invisible and not hit-testable. */
  function docsImposterFor(rect) {
    const run = rect.getAttribute("aria-label");
    if (docsImposter?.rect === rect && docsImposter.text.isConnected && docsImposter.node.nodeValue === run) {
      return docsImposter;
    }
    releaseDocsImposter();
    const node = document.createTextNode(run);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    for (const name of ["x", "y"]) {
      if (rect.hasAttribute(name)) text.setAttribute(name, rect.getAttribute(name));
    }
    text.append(node);
    const transform = rect.getAttribute("transform") || "";
    const important = (property, value) => text.style.setProperty(property, value, "important");
    important("all", "initial");
    important("transform", transform);
    important("font", rect.getAttribute("data-font-css") || "");
    important("text-anchor", "start");
    rect.parentNode.append(text);
    // Docs positions the rect by its box and the <text> by its baseline.
    const box = rect.getBoundingClientRect();
    const drawn = text.getBoundingClientRect();
    const dy = ((box.top - drawn.top) + (box.bottom - drawn.bottom)) / 2;
    important("transform", `translate(0px,${dy}px) ${transform}`);
    important("opacity", "0");
    important("pointer-events", "none");
    docsImposter = { rect, text, node };
    return docsImposter;
  }

  /** The offset of the glyph under the pointer, found by bisecting an imposter's client rects. */
  function imposterOffsetAt(node, clientX, clientY) {
    const range = document.createRange();
    let start = 0;
    let end = node.nodeValue.length;
    while (end - start > 1) {
      const mid = (start + end) >> 1;
      range.setStart(node, mid);
      range.setEnd(node, end);
      const hit = [...range.getClientRects()].some(rect =>
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
      if (hit) start = mid; else end = mid;
    }
    // Bisection can land on the low surrogate of a wide glyph.
    if (start > 0 && (node.nodeValue.charCodeAt(start) & 0xfc00) === 0xdc00) start -= 1;
    return start;
  }

  /**
   * The candidate at `offset` in an imposter's one text node. The imposter is
   * the scan root, so the walk ends with that node and never crosses into the
   * page, and the node is the sole source, so the sentence and the highlight
   * work in it as they do in a page's text nodes.
   */
  function imposterCandidate(anchor, node, offset, vertical) {
    const styleCache = new Map();
    const entries = collectScanEntries(node, offset, anchor, scanWindow(), styleCache);
    if (entries.length === 0) return null;
    const query = entries.map((entry) => entry.text).join("");
    if (options.onlyScanJapaneseText && !isJapaneseToken(query)) return null;
    const first = entries[0];
    const anchorRange = document.createRange();
    anchorRange.setStart(node, first.offset);
    anchorRange.setEnd(node, Math.min(node.nodeValue.length, first.offset + first.sourceLength));
    return withSentence({
      anchor,
      anchorRange,
      query,
      scanEntries: entries,
      sourceDepth: -1,
      sourceElements: [node],
      vertical,
    }, first.offset, first.sourceLength, styleCache);
  }

  function resolveDocsCandidate(clientX, clientY) {
    const rect = docsRectAt(clientX, clientY);
    if (!rect) return null;
    const { text, node } = docsImposterFor(rect);
    // The <text> lives inside Docs' <svg>, which the page scan treats as opaque.
    return imposterCandidate(text, node, imposterOffsetAt(node, clientX, clientY), false);
  }

  // An <input> or <textarea> keeps its value in user-agent shadow DOM, which
  // the caret APIs never enter. As Yomitan's TextSourceGenerator does, the
  // reader lays an invisible copy of the hovered field over it and scans that.
  // These are Yomitan's input types; a password is never read.
  const FIELD_INPUT_TYPES = new Set(["text", "search"]);
  // One imposter at a time. It stays while it anchors the root lookup or its
  // field is under the pointer, so repeated moves share the pending lookup and
  // the popup, and it goes once neither holds or the popup closes.
  let fieldImposter = null;

  /** `element` when it is a visible text field with a value the reader may read, else null. */
  function scannableField(element) {
    const tag = element?.localName;
    if ((tag !== "textarea" && (tag !== "input" || !FIELD_INPUT_TYPES.has(element.type)))
        || !element.value || element.getRootNode() !== document || !document.body) return null;
    const styleCache = new Map();
    // A field styled to mask its text, such as a PIN box, is a password in all but name.
    const masked = computedStyleFor(element, styleCache).getPropertyValue("-webkit-text-security");
    if ((masked !== "" && masked !== "none") || isHiddenElement(element, styleCache)) return null;
    for (let current = element.parentElement; current; current = current.parentElement) {
      if (OPAQUE_TAGS.has(current.localName) || computedStyleFor(current, styleCache).display === "none") return null;
    }
    return element;
  }

  function releaseFieldImposter() {
    fieldImposter?.container.remove();
    fieldImposter = null;
  }

  function retireFieldImposter() {
    if (!fieldImposter || lastPointer?.target === fieldImposter.field) return;
    const { imposter } = fieldImposter;
    if (pendingCandidateLookup?.candidate.anchor !== imposter && rootLevel.activeCandidate?.anchor !== imposter) {
      releaseFieldImposter();
    }
  }

  /**
   * Yomitan's _createImposter: the field's value in a <div> that carries every
   * computed property of the field and lies exactly over it with its scroll
   * offsets, in a container that is invisible, unselectable and never
   * hit-tested. `box` is the field's client rect. The imposter is reused while
   * the field keeps its value, scroll offsets and place in the document.
   */
  function fieldImposterFor(field, box) {
    const page = document.documentElement.getBoundingClientRect();
    const place = { left: box.left - page.left, top: box.top - page.top, width: box.width, height: box.height };
    const reused = fieldImposter;
    if (reused?.field === field && reused.value === field.value && reused.scrollLeft === field.scrollLeft
        && reused.scrollTop === field.scrollTop && reused.container.isConnected
        && Object.keys(place).every((key) => reused.place[key] === place[key])) {
      return reused;
    }
    releaseFieldImposter();
    const style = window.getComputedStyle(field);
    const container = document.createElement("div");
    setImportant(container, {
      all: "initial", position: "absolute", left: "0", top: "0", width: `${page.width}px`, height: `${page.height}px`,
      overflow: "hidden", opacity: "0", "pointer-events": "none", "user-select": "none",
    });
    container.setAttribute("aria-hidden", "true");
    const imposter = document.createElement("div");
    for (const property of style) imposter.style.setProperty(property, style.getPropertyValue(property), "important");
    // Placed and scrolled where the field is at once, not eased there.
    setImportant(imposter, {
      position: "absolute", left: `${place.left}px`, top: `${place.top}px`, margin: "0", "pointer-events": "none",
      "user-select": "none", transition: "none", animation: "none", "scroll-behavior": "auto",
    });
    const input = field.localName === "input";
    let value = field.value;
    if (input) {
      // One unwrapped line keeping repeated spaces, as the input lays it out. A
      // line as tall as the content box centres the glyphs in it, as the input
      // does whatever its own line height.
      const frame = style.boxSizing === "border-box"
        ? ["padding-top", "padding-bottom", "border-top-width", "border-bottom-width"]
          .reduce((sum, property) => sum + pixels(style, property), 0)
        : 0;
      setImportant(imposter, {
        overflow: "hidden", "white-space": "pre", "line-height": `${pixels(style, "height") - frame}px`,
      });
    } else {
      if (style.overflow === "visible") setImportant(imposter, { overflow: "auto" });
      // A final line break opens a line in a textarea but not in a <div>.
      if (value.endsWith("\n")) value += "\n";
    }
    const node = document.createTextNode(value);
    imposter.append(node);
    container.append(imposter);
    document.body.append(container);
    const narrower = fitFieldImposter(field, imposter, style, box, place);
    // The copy lays out text the field has scrolled out of sight. An input shows
    // text only in its content box; a textarea scrolls it in its padding box.
    const inset = input ? [pixels(style, "padding-left"), pixels(style, "padding-right") + narrower] : [0, 0];
    fieldImposter = {
      field, container, imposter, node, place, value: field.value, scrollLeft: field.scrollLeft,
      scrollTop: field.scrollTop, vertical: style.writingMode.startsWith("vertical"),
      clip: {
        left: field.clientLeft + inset[0], right: field.clientLeft + field.clientWidth - inset[1],
        top: field.clientTop, bottom: field.clientTop + field.clientHeight,
      },
    };
    return fieldImposter;
  }

  /**
   * Corrects the laid-out copy's size and place against the field, as Yomitan
   * does, then scrolls it as the field is scrolled. Returns how much narrower
   * the field's own text box is: a search field's clear button or a datalist's
   * picker lets an input scroll further than the copy could.
   */
  function fitFieldImposter(field, imposter, style, box, place) {
    const drawn = imposter.getBoundingClientRect();
    if (drawn.width !== box.width || drawn.height !== box.height) {
      setImportant(imposter, { width: `${pixels(style, "width") + box.width - drawn.width}px`,
        height: `${pixels(style, "height") + box.height - drawn.height}px` });
    }
    if (drawn.left !== box.left || drawn.top !== box.top) {
      setImportant(imposter, {
        left: `${place.left + box.left - drawn.left}px`, top: `${place.top + box.top - drawn.top}px`,
      });
    }
    const narrower = field.localName === "input"
      ? Math.max(0, field.scrollWidth - field.clientWidth - imposter.scrollWidth + imposter.clientWidth)
      : 0;
    if (narrower > 0) {
      setImportant(imposter, { "padding-right": `${pixels(style, "padding-right") + narrower}px` });
      if (style.boxSizing !== "border-box") {
        const width = Number.parseFloat(imposter.style.getPropertyValue("width"));
        setImportant(imposter, { width: `${width - narrower}px` });
      }
    }
    imposter.scrollLeft = field.scrollLeft;
    imposter.scrollTop = field.scrollTop;
    return narrower;
  }

  function pixels(style, property) {
    return Number.parseFloat(style.getPropertyValue(property)) || 0;
  }

  function setImportant(element, declarations) {
    for (const [property, value] of Object.entries(declarations)) {
      element.style.setProperty(property, value, "important");
    }
  }

  function resolveFieldCandidate(field, clientX, clientY) {
    const box = field.getBoundingClientRect();
    const { clip, imposter, node, vertical } = fieldImposterFor(field, box);
    const x = clientX - box.left;
    const y = clientY - box.top;
    if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) return null;
    const offset = imposterOffsetAt(node, clientX, clientY);
    return glyphContainsPoint(node, offset, clientX, clientY)
      ? imposterCandidate(imposter, node, offset, vertical)
      : null;
  }

  /**
   * Caret APIs snap to nearby text even in padding, and bisection always finds
   * some glyph. Admit only the pointed glyph, with two CSS pixels for thin
   * glyphs and subpixel layout.
   */
  function glyphContainsPoint(node, offset, clientX, clientY) {
    const text = node.nodeValue || "";
    if (offset >= text.length) return false;
    const glyph = document.createRange();
    glyph.setStart(node, offset);
    glyph.setEnd(node, offset + (text.codePointAt(offset) > 0xffff ? 2 : 1));
    return [...glyph.getClientRects()].some((rect) => clientX >= rect.left - 2 && clientX <= rect.right + 2
      && clientY >= rect.top - 2 && clientY <= rect.bottom + 2);
  }

  /**
   * Builds a candidate for the caret at (clientX, clientY), or null when there
   * is nothing Japanese to look up there.
   */
  function resolveCandidate(clientX, clientY) {
    if (docsEnabled()) {
      const docs = resolveDocsCandidate(clientX, clientY);
      if (docs) return docs;
    }
    const hit = document.elementFromPoint(clientX, clientY);
    const field = scannableField(hit);
    if (field) return resolveFieldCandidate(field, clientX, clientY);
    const caretRange = caretRangeAt(clientX, clientY);
    const node = caretRange?.startContainer;
    if (node?.nodeType !== Node.TEXT_NODE || !hit?.contains(node)) return null;
    const text = node.nodeValue || "";
    let offset = caretRange.startOffset;
    // Caret alignment can step back onto the low surrogate of a wide glyph.
    if (offset > 0 && (text.charCodeAt(offset) & 0xfc00) === 0xdc00) offset -= 1;
    return glyphContainsPoint(node, offset, clientX, clientY) ? resolveCandidateAt(node, offset) : null;
  }

  function resolveCandidateAt(startNode, startOffset) {
    const styleCache = new Map();
    if (!isScannableTextNode(startNode, styleCache)) {
      return null;
    }
    const entries = collectScanEntries(
      startNode,
      Math.min(startOffset, (startNode.nodeValue || "").length),
      document.body,
      scanWindow(),
      styleCache
    );
    if (entries.length === 0) {
      return null;
    }
    const query = entries.map((entry) => entry.text).join("");
    if (options.onlyScanJapaneseText && !isJapaneseToken(query)) {
      return null;
    }

    const first = entries[0];
    const sourceElements = collectSentenceSources(first.node, document.body, styleCache);
    let matchStart;
    let anchorRange;
    try {
      matchStart = sourceOffset(sourceElements, first.node, first.offset);
      anchorRange = document.createRange();
      anchorRange.setStart(first.node, first.offset);
      anchorRange.setEnd(
        first.node,
        Math.min(
          (first.node.nodeValue || "").length,
          first.offset + first.sourceLength
        )
      );
    } catch {
      return null;
    }
    return withSentence({
      anchor: first.node.parentElement,
      anchorRange,
      query,
      scanEntries: entries,
      sourceDepth: -1,
      sourceElements,
      vertical: computedStyleFor(first.node.parentElement, styleCache)
        .writingMode.startsWith("vertical"),
    }, matchStart, first.sourceLength, styleCache);
  }

  function resolveDefinitionCandidate(clientX, clientY, level) {
    if (
      !shadow ||
      !level ||
      level.retired ||
      levels[level.depth] !== level ||
      !level.popup ||
      level.popup.hidden
    ) {
      return null;
    }
    const styleCache = new Map();
    const caretRange = caretRangeAt(clientX, clientY, shadow);
    if (!caretRange) {
      return null;
    }
    const startNode = caretRange.startContainer;
    if (startNode.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const lookupText = startNode.parentElement?.closest(DEFINITION_TEXT_SELECTOR);
    if (
      !lookupText ||
      !level.popup.contains(lookupText) ||
      !lookupText.contains(startNode)
    ) {
      return null;
    }
    for (
      let current = startNode.parentElement;
      current;
      current = current.parentElement
    ) {
      if (
        isHiddenElement(current, styleCache) ||
        isEditingElement(current) ||
        current.localName === "a" ||
        OPAQUE_TAGS.has(current.localName) ||
        computedStyleFor(current, styleCache).display === "none"
      ) {
        return null;
      }
      if (current === lookupText) {
        break;
      }
      if (current === level.popup) {
        return null;
      }
    }
    let entries = collectScanEntries(
      startNode,
      Math.min(caretRange.startOffset, (startNode.nodeValue || "").length),
      lookupText,
      scanWindow(),
      styleCache
    );
    const linkBoundary = entries.findIndex((entry) =>
      entry.node.parentElement?.closest("a")
    );
    if (linkBoundary >= 0) {
      entries = entries.slice(0, linkBoundary);
    }
    if (entries.length === 0) {
      return null;
    }
    const query = entries.map((entry) => entry.text).join("");
    if (options.onlyScanJapaneseText && !isJapaneseToken(query)) {
      return null;
    }
    const first = entries[0];
    let matchStart;
    let anchorRange;
    try {
      matchStart = rangeOffsetWithin(lookupText, first.node, first.offset);
      anchorRange = document.createRange();
      anchorRange.setStart(first.node, first.offset);
      anchorRange.setEnd(
        first.node,
        Math.min(
          (first.node.nodeValue || "").length,
          first.offset + first.sourceLength
        )
      );
    } catch {
      return null;
    }
    return withSentence({
      anchor: lookupText,
      anchorRange,
      query,
      scanEntries: entries,
      sourceDepth: level.depth,
      sourceElements: [lookupText],
      vertical: computedStyleFor(lookupText, styleCache)
        .writingMode.startsWith("vertical"),
    }, matchStart, first.sourceLength, styleCache);
  }

  function selectionBoundaryElement(node) {
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function resolveSelectedLookupCandidate(selection = window.getSelection()) {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const styleCache = new Map();
    if (!isScannableElement(selectionBoundaryElement(range.startContainer), styleCache)
        || !isScannableElement(selectionBoundaryElement(range.endContainer), styleCache)) return null;
    const query = selection.toString();
    if (!query.trim() || (options.onlyScanJapaneseText && !isJapaneseToken(query))) return null;
    const anchor = selectionBoundaryElement(range.commonAncestorContainer);
    for (const control of anchor.querySelectorAll(EDITING_SELECTOR)) {
      if (isEditingElement(control) && range.intersectsNode(control)
          && hasVisibleContent(control, styleCache)) return null;
    }
    const rawSelectionText = range.toString();
    // The highlight works in the anchor's text; the sentence is read as a hover reads it.
    return withSentence({
      anchor,
      anchorRange: range.cloneRange(),
      exactSelection: true,
      query,
      rawSelectionText,
      sourceDepth: -1,
      sourceElements: [anchor],
      vertical: computedStyleFor(anchor, styleCache).writingMode.startsWith("vertical"),
      ...selectionSentence(range, styleCache),
    }, rangeOffsetWithin(anchor, range.startContainer, range.startOffset), rawSelectionText.length, styleCache);
  }

  // Yomitan's Scan text at selection: an ordinary scan from the selection's
  // first text. The live selection, not the scanned word, keeps it retained.
  function resolveSelectionScanCandidate(selection = window.getSelection()) {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const query = selection.toString();
    if (options.onlyScanJapaneseText && !isJapaneseToken(query)) return null;
    const range = selection.getRangeAt(0);
    let node = range.startContainer, offset = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
      do node = walker.nextNode(); while (node && !range.intersectsNode(node));
      offset = 0;
    }
    const candidate = node ? resolveCandidateAt(node, offset) : null;
    return candidate && { ...candidate, selectionRange: range.cloneRange(), selectionText: query };
  }

  function teardown(reason) {
    gsmBridge?.destroy(); // GSM hook
    if (disposed) {
      return;
    }
    audio?.dispose();
    mining?.retire();
    wordStatusActions?.retire();
    disposed = true;
    selectionDragActive = false;
    dragSelection = null;
    activationPressed = false;
    cancelPopupLayout();
    clearDictionaryResources();
    window.clearTimeout(scanTimer);
    window.clearTimeout(hideTimer);
    cancelScanDwell();
    clearTransferTimer();
    clearDescendantTimer();
    clearCursorExitTimer();
    scanTimer = null;
    hideTimer = null;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("auxclick", onAuxClick, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("focusin", onPageFocusIn, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("resize", refreshPageZoom);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage?.removeListener(onReaderCommand);
      chrome.runtime.onMessage?.removeListener(onWordStatusChanged);
    } catch {
      // The context is already gone; the listener died with it.
    }
    wordHighlights?.stop();
    try {
      highlighter?.clearAll();
      for (const level of levels) level.view?.destroy();
    } catch {
      // Teardown is best effort.
    }
    appearance?.destroy();
    customStyle?.destroy();
    releaseDocsProbe();
    syncNetflix();
    releaseFieldImposter();
    host?.remove();
    host = null;
    shadow = null;
    rootLevel.popup = null;
    rootLevel.view = null;
    highlighter = null;
    rootLevel.activeCandidate = null;
    rootLevel.activeTermRender = null;
    rootLevel.currentViewRequest = null;
    rootLevel.noteEditing = false;
    syncHostAttention();
    if (reason) {
      console.debug(`hachidori: content script stopped (${reason})`);
    }
  }

  function discardUi() {
    audio?.retire();
    mining?.retire();
    wordStatusActions?.retire();
    cancelPopupLayout();
    clearDictionaryResources();
    try {
      highlighter?.clearAll();
      for (const level of levels) level.view?.destroy();
    } catch {
      // Best effort: the point is only to leave nothing half-built behind.
    }
    releaseFieldImposter();
    host?.remove();
    host = null;
    shadow = null;
    rootLevel.popup = null;
    rootLevel.view = null;
    highlighter = null;
    rootLevel.activeCandidate = null;
    rootLevel.activeSignature = null;
    rootLevel.activeTermRender = null;
    rootLevel.currentViewRequest = null;
    rootLevel.noteEditing = false;
    syncHostAttention();
  }

  function clearDictionaryResources() {
    mediaCache.clear();
    mediaCacheBytes = 0;
    mediaQueue = [];
    for (const job of [...pendingMedia.values()]) {
      finishMediaJob(job, new Error("obsolete media request"));
    }
    styleGeneration = -1;
    styleRequest = null;
  }

  function noteGeneration(generation, owner = rootLevel) {
    if (!Number.isFinite(generation) || generation === currentGeneration) {
      return;
    }
    currentGeneration = generation;
    audio?.retire();
    mining?.retire();
    clearDictionaryResources();
    // Generation is an engine incarnation, not a monotonic storage revision.
    // Invalidate other in-flight owners even when a restarted engine returns 1.
    for (const level of levels) {
      if (level !== owner) {
        level.lookupToken += 1;
        level.retainedView = Boolean(level.currentViewRequest && !level.popup.hidden);
      }
    }
  }

  function sendRequest(type, payload, target = TARGET) {
    return new Promise((resolve, reject) => {
      if (disposed || !extensionAlive()) {
        teardown("context-invalidated");
        reject(new Error("extension context invalidated"));
        return;
      }
      const requestId = payload?.requestId ?? `${type.replace(/^hd_/u, "")}-${nextRequestId += 1}`;
      const request = { ...payload, requestId, target, type };
      try {
        chrome.runtime.sendMessage(request, (reply) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            const message = lastError.message || "sendMessage failed";
            if (INVALIDATED_MESSAGE_PATTERN.test(message)) {
              teardown("context-invalidated");
            }
            reject(new Error(message));
            return;
          }
          if (
            !reply ||
            reply.type !== `${type}_result` ||
            reply.requestId !== requestId
          ) {
            reject(new Error(`unexpected reply for ${type}`));
            return;
          }
          if (reply.ok !== true) {
            const error = new Error(reply.error || `${type} failed`);
            error.responseReceived = true;
            if (typeof reply.errorCode === "string") error.code = reply.errorCode;
            reject(error);
            return;
          }
          gsmBridge?.requestCompleted(type, reply); // GSM hook
          resolve(reply);
        });
      } catch (error) {
        teardown("context-invalidated");
        reject(error);
      }
    });
  }

  function cacheMedia(key, url) {
    // The engine produces base64 data URLs. Count decoded bytes without
    // decoding or copying the payload merely to maintain the cache budget.
    const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
    const byteLength = (url.length - url.indexOf(",") - 1) / 4 * 3 - padding;
    mediaCache.set(key, { url, byteLength });
    mediaCacheBytes += byteLength;
    while (mediaCache.size > MAX_MEDIA_CACHE_ENTRIES || mediaCacheBytes > MAX_MEDIA_CACHE_BYTES) {
      const oldestKey = mediaCache.keys().next().value;
      mediaCacheBytes -= mediaCache.get(oldestKey).byteLength;
      // These are data URLs, not revocable Blob URLs. Drop our reference;
      // an image already rendered from it retains its independent DOM owner.
      mediaCache.delete(oldestKey);
    }
  }

  function finishMediaJob(job, error, url) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer !== null) window.clearTimeout(job.timer);
    if (pendingMedia.get(job.key) === job) pendingMedia.delete(job.key);
    if (job.active) {
      job.active = false;
      activeMediaRequests -= 1;
    }
    if (error) job.reject(error);
    else job.resolve(url);
  }

  function pruneMediaQueue() {
    mediaQueue = mediaQueue.filter((job) => {
      if (job.consumers.some((isCurrent) => isCurrent())) return true;
      finishMediaJob(job, new Error("obsolete media request"));
      return false;
    });
  }

  async function dispatchMedia(job) {
    try {
      const reply = await sendRequest("hd_media", job.payload);
      if (job.settled) return;
      if (pendingMedia.get(job.key) !== job || job.payload.generation !== currentGeneration
          || reply.generation !== job.payload.generation) {
        throw new Error("obsolete media reply");
      }
      if (typeof reply.dataUrl !== "string") throw new Error("dictionary image is unavailable");
      // Started resource fetches may finish while hidden; image callbacks
      // separately check their current view before touching DOM.
      cacheMedia(job.key, reply.dataUrl);
      finishMediaJob(job, null, reply.dataUrl);
    } catch (error) {
      finishMediaJob(job, error);
    } finally {
      pumpMediaQueue();
    }
  }

  function pumpMediaQueue() {
    while (mediaQueue.length > 0 && activeMediaRequests < MAX_MEDIA_CONCURRENT_REQUESTS) {
      const job = mediaQueue.shift();
      if (!job.consumers.some((isCurrent) => isCurrent())) {
        finishMediaJob(job, new Error("obsolete media request"));
        continue;
      }
      job.active = true;
      activeMediaRequests += 1;
      job.timer = window.setTimeout(() => {
        finishMediaJob(job, new Error("dictionary image request timed out"));
        pumpMediaQueue();
      }, MEDIA_REQUEST_TIMEOUT_MS);
      void dispatchMedia(job);
    }
  }

  function resolveMedia({ dictionary, generation, path, isCurrent }) {
    if (!isCurrent() || generation !== currentGeneration) {
      return Promise.reject(new Error("obsolete media request"));
    }
    const key = `${generation}\u0000${dictionary}\u0000${path}`;
    const cached = mediaCache.get(key);
    if (cached) {
      mediaCache.delete(key);
      mediaCache.set(key, cached);
      return Promise.resolve(cached.url);
    }
    const pending = pendingMedia.get(key);
    if (pending) {
      pending.consumers.push(isCurrent);
      return pending.promise;
    }
    if (pendingMedia.size >= MAX_MEDIA_PENDING_REQUESTS) pruneMediaQueue();
    if (pendingMedia.size >= MAX_MEDIA_PENDING_REQUESTS) {
      return Promise.reject(new Error("dictionary image queue is full"));
    }
    const job = { key, consumers: [isCurrent], payload: { dictionary, generation, path },
      active: false, settled: false, timer: null };
    job.promise = new Promise((resolveJob, rejectJob) => {
      job.resolve = resolveJob;
      job.reject = rejectJob;
    });
    pendingMedia.set(key, job);
    mediaQueue.push(job);
    pumpMediaQueue();
    return job.promise;
  }

  function imageSourceContext() {
    const next = window.HDReaderOptions.resolvePopupImageSources(options.popupImageSource, dictionaries, dictionaryGroups);
    // Keep the effective route's identity through alias/name-only changes.
    // In-flight consumers capture it, independently of broad storage revisions.
    if (next !== popupImageSources && !sameDictionaries(next, popupImageSources)) popupImageSources = next;
    return { popupImageSources, resolveMedia: resolvePopupMedia };
  }

  function resolvePopupMedia(request) {
    const sources = popupImageSources;
    const isCurrent = () => sources === popupImageSources && request.generation === currentGeneration && request.isCurrent();
    const ownedRequest = { ...request, isCurrent };
    if (sources !== null) return resolveRoutedMedia(ownedRequest, sources);
    // Automatic retains the direct cache/queue path without candidate scans.
    return resolveMedia(ownedRequest).then(url => {
      if (!isCurrent()) throw new Error("obsolete media reply");
      return url;
    });
  }

  async function resolveRoutedMedia(request, sources) {
    const { isCurrent } = request;
    for (const dictionary of sources) {
      if (!isCurrent()) throw new Error("obsolete media request");
      let url;
      try {
        url = await resolveMedia({ ...request, dictionary, isCurrent });
      } catch (error) {
        if (!isCurrent()) throw error;
        // Availability is per requested path, not one global group winner.
        continue;
      }
      if (!isCurrent()) throw new Error("obsolete media reply");
      request.onResolvedSource?.(dictionary);
      return url;
    }
    throw new Error("dictionary image is unavailable");
  }

  function ensureDictionaryStyles(generation) {
    if (!shadow || !themeHost.dictionaryStyles || generation === styleGeneration) {
      return;
    }
    styleGeneration = generation;
    const request = {};
    styleRequest = request;
    sendRequest("hd_styles", {}).then((reply) => {
      if (disposed || !shadow || !themeHost.dictionaryStyles || styleRequest !== request) {
        return;
      }
      if (reply.generation !== generation) throw new Error("obsolete dictionary styles");
      window.HDGlossary.applyDictionaryStyles(
        document,
        shadow,
        generation,
        Array.isArray(reply.styles) ? reply.styles : []
      );
    }).catch(() => {
      // Dictionary CSS is cosmetic; a failure must not block the lookup that
      // asked for it. Retry on the next render without resetting a newer job.
      if (styleRequest === request) {
        styleGeneration = -1;
        styleRequest = null;
      }
    });
  }

  // Browser zoom scales CSS pixels. The popup cancels it with CSS zoom to keep
  // one on-screen size, so its lengths are unzoomed pixels and page geometry is
  // converted into them before placement.
  function popupRect(rect) {
    return window.HDPopup.scaleRect(rect, window.HDPopup.popupCoordinateScale(pageZoom, options.popupScalePercent));
  }

  function popupViewport() {
    const factor = window.HDPopup.popupCoordinateScale(pageZoom, options.popupScalePercent);
    return { width: window.innerWidth * factor, height: window.innerHeight * factor };
  }

  function applyPageZoom() {
    host?.style.setProperty("--gsm-hoshidicts-page-zoom", String(1 / pageZoom));
  }

  function refreshPageZoom() {
    // Resizing a window keeps its device pixel ratio; a zoom change does not.
    if (disposed || window.devicePixelRatio === pageZoomRatio) return;
    pageZoomRatio = window.devicePixelRatio;
    const request = ++pageZoomRequest;
    sendRequest("hd_page_zoom", {}, PAGE_ZOOM_TARGET).then((reply) => {
      if (disposed || request !== pageZoomRequest || !(reply.zoomFactor > 0) || reply.zoomFactor === pageZoom) return;
      pageZoom = reply.zoomFactor;
      applyPageZoom();
      for (const level of levels) level.view?.hideImagePreview();
      positionPopup();
    }, (error) => console.debug("hachidori: page zoom unavailable", error));
  }

  function calculatePopupPosition(anchorRect, viewport, vertical, preferBelow = false) {
    return window.HDPopup.calculatePopupPosition(anchorRect, sessionPopupSize ?? {
      width: options.popupWidthPx, height: options.popupHeightPx,
    }, viewport, { gap: POPUP_GAP_PX, padding: POPUP_PADDING_PX, vertical, preferBelow });
  }

  function anchorRectFor(candidate) {
    if (candidate.anchorRange) {
      try {
        const first = candidate.scanEntries?.[0];
        if (first && !candidate.linkAnchor && candidate.exactSelection !== true) {
          const origin = document.createRange();
          origin.setStart(first.node, first.offset);
          origin.setEnd(first.node, first.offset + first.sourceLength);
          const glyph = origin.getBoundingClientRect();
          const x = (glyph.left + glyph.right) / 2;
          const y = (glyph.top + glyph.bottom) / 2;
          const fragment = [...candidate.anchorRange.getClientRects()].find(rect =>
            rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y);
          if (fragment) return fragment;
        }
        const rect = candidate.anchorRange.getBoundingClientRect();
        if (rect && Number.isFinite(rect.left) && (rect.width > 0 || rect.height > 0)) {
          return rect;
        }
      } catch {
        // The range's nodes moved; fall back to the container box.
      }
    }
    return candidate.anchor.getBoundingClientRect();
  }

  function anchorConnected(candidate) {
    return Boolean(candidate) &&
      candidate.anchor.isConnected &&
      candidateStart(candidate).node.isConnected &&
      (candidate.exactSelection !== true || (
        !candidate.anchorRange.collapsed
        && candidate.anchor.contains(candidate.anchorRange.startContainer)
        && candidate.anchor.contains(candidate.anchorRange.endContainer)
      ));
  }

  // Like Yomitan, a root popup stays where it first opened (#402): later
  // placements reuse the source rect captured then, and its page source may
  // scroll away or leave the DOM without closing it. A child keeps following
  // its link text inside the parent pane.
  function sourceRetained(candidate, level) {
    return anchorConnected(candidate)
      || (level === rootLevel && candidate != null && rootLevel.placedAnchor?.candidate === candidate);
  }

  function requestCanRender(token, candidate, level = rootLevel) {
    if (disposed || level.retired || token !== level.lookupToken || !level.popup) return false;
    if (retireDetachedAncestor(level)) return false;
    // Initial selections still own the live page selection; Note/Back replays
    // intentionally use their stored descriptor even after focus collapses it.
    if (!sourceRetained(candidate, level) || (level === rootLevel && pendingCandidateLookup?.token === token
        && candidate.exactSelection === true && !selectionIsUnchanged(candidate))) {
      hide(level);
      return false;
    }
    return true;
  }

  function retireDetachedAncestor(level) {
    for (let depth = 0; depth < level.depth; depth += 1) {
      const ancestor = levels[depth];
      if (!sourceRetained(ancestor.activeCandidate, ancestor)) {
        hide(ancestor);
        return true;
      }
    }
    return false;
  }

  function lookupFailureState(error, request = null) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.code === "dictionary-structured-content-limit") {
      return {
        kind: "render",
        title: typeof error.userTitle === "string"
          ? error.userTitle
          : "Dictionary content could not be rendered.",
        detail: typeof error.userDetail === "string" ? error.userDetail : message,
      };
    }
    if (error?.code === "engine-mutating" || message === "the dictionary engine is busy mutating") {
      return {
        kind: "updating",
        title: "Dictionary update in progress.",
        detail: "Try the lookup again when the update finishes.",
      };
    }
    if (error?.code === "sharing-disconnected" || message === "The linked Hachidori is not reachable.") {
      return {
        kind: "disconnected",
        title: "Shared Hachidori is disconnected.",
        detail: "Reconnect it in Settings → Sharing, then try again.",
      };
    }
    if (error?.code === "engine-starting" || message === "the dictionary engine is still starting") {
      return {
        kind: "starting",
        title: "Dictionary engine is starting.",
        detail: "Wait a moment, then try again.",
      };
    }
    if (error?.code === "engine-start-failed") {
      return {
        kind: "engine",
        title: "Dictionary engine could not start.",
        detail: "Open Settings to check the engine status, then try again.",
      };
    }
    if (request?.kind === "kanji") {
      return {
        kind: "kanji",
        title: "Kanji lookup failed.",
        detail: "The current definition is still available. Try again.",
      };
    }
    return null;
  }

  function retainFailedView(request, token, level, replayOptions) {
    if (!replayOptions?.preserveViewControls || disposed || level.retired
        || token !== level.lookupToken || level.currentViewRequest !== request
        || level.popup.hidden || !requestCanRender(token, request.candidate, level)) return false;
    level.retainedView = true;
    return true;
  }

  function handleRequestFailure(request, token, error, level, replayOptions) {
    const preserveView = retainProtectedReplay(request, token, level, replayOptions)
      || retainFailedView(request, token, level, replayOptions);
    return handleLookupFailure(token, error, level, request, preserveView);
  }

  function handleLookupFailure(token, error, level = rootLevel, request = null, preserveView = false) {
    if (disposed || level.retired || token !== level.lookupToken) return false;
    if (error?.code !== "dictionary-structured-content-limit") {
      console.debug("hachidori: lookup failed", error);
    }
    const state = lookupFailureState(error, request);
    if (state === null) {
      if (!preserveView) hide(level);
      return false;
    }
    if (!preserveView) {
      show(request?.candidate ?? level.activeCandidate, level);
      level.currentViewRequest = request;
      level.activeHighlightText = "";
      level.activeTermRender = null;
      clearDefinitionBlurTimer(level);
      pruneLevels(level.depth + 1);
    }
    level.view.renderLookupFailure({
      ...state,
      actionLabel: "Try again",
      onAction: () => executeViewRequest(
        request,
        level,
        preserveView ? { preserveViewControls: true } : null,
      ),
    }, { preserveView });
    positionPopup(level);
    return false;
  }

  function handleRenderFailure(token, error, request, level = rootLevel) {
    if (disposed || level.retired || token !== level.lookupToken) return false;
    if (error?.cause instanceof Error) {
      console.warn("hachidori: could not render results", error, "caused by", error.cause);
    } else {
      console.warn("hachidori: could not render results", error);
    }
    return handleLookupFailure(token, error, level, request);
  }

  function retainProtectedReplay(request, token, level, replayOptions) {
    if (!replayOptions?.preserveViewControls || disposed || level.retired
        || token !== level.lookupToken || level.currentViewRequest !== request
        || level.popup.hidden
        || (!level.noteEditing && level.pendingCustomAppends === 0)) return false;
    if (!requestCanRender(token, request.candidate, level)) return false;
    level.retainedView = true;
    return true;
  }

  function positionToolbar(level, placement, reset = false) {
    const desired = window.HDPopup.resolveToolbarPosition(options.popupToolbarPosition, placement,
      reset ? "top" : level.popup.dataset.toolbarPosition);
    if (level.popup.dataset.toolbarPosition !== desired) level.view.setToolbarPosition(desired);
  }

  function placePopup(level, position, resetToolbar) {
    positionToolbar(level, position.placement, resetToolbar);
    level.popup.style.left = `${position.left}px`;
    level.popup.style.top = `${position.top}px`;
    level.popup.style.width = `${position.width}px`;
    level.popup.style.height = `${position.height}px`;
    // A new size, scale or toolbar edge can move the chooser's button.
    audio?.positionMenu(level);
  }

  function positionPopup(fromLevel = rootLevel, resetToolbar = false) {
    queueMicrotask(() => gsmBridge?.refresh()); // GSM hook
    if (fromLevel.retired || fromLevel.popup?.inert || !rootLevel.popup || rootLevel.popup.hidden || !rootLevel.activeCandidate) {
      return;
    }
    if (retireDetachedAncestor(fromLevel)) return;
    const placed = rootLevel.placedAnchor;
    let anchorRect = placed?.candidate === rootLevel.activeCandidate ? placed.rect : null;
    if (!anchorRect) {
      if (!anchorConnected(rootLevel.activeCandidate)) {
        hide();
        return;
      }
      anchorRect = anchorRectFor(rootLevel.activeCandidate);
      rootLevel.placedAnchor = { candidate: rootLevel.activeCandidate, rect: anchorRect };
    }
    highlighter?.refresh();
    const viewport = popupViewport();
    if (fromLevel === rootLevel) {
      placePopup(rootLevel, popupResize?.level === rootLevel ? popupResizePosition() : calculatePopupPosition(
        popupRect(anchorRect),
        viewport,
        rootLevel.activeCandidate.vertical
      ), resetToolbar);
    }
    if (levels.length === 1) return;
    if (viewport.width <= POPUP_PADDING_PX * 2 || viewport.height <= POPUP_PADDING_PX * 2) {
      pruneLevels(1);
      // Finish this placement before a newly unprotected view can reproject.
      window.queueMicrotask(flushDictionaryPresentation);
      return;
    }
    // Like Yomitan, a child opens beside the text that opened it: below that
    // word when it fits, otherwise above, aligned with its left edge, and
    // shortened on the roomier side rather than covering the word when it fits
    // on neither. Only each pane's own source is measured, so no ancestor box
    // is read for any descendant.
    for (const level of levels.slice(Math.max(1, fromLevel.depth))) {
      if (level.popup.hidden) break;
      if (!anchorConnected(level.activeCandidate)) {
        hide(level);
        break;
      }
      placePopup(level, popupResize?.level === level ? popupResizePosition() : calculatePopupPosition(
        popupRect(anchorRectFor(level.activeCandidate)),
        viewport,
        level.activeCandidate.vertical,
        true
      ), resetToolbar);
    }
  }

  function cancelPopupLayout() {
    if (popupLayoutFrame !== null) window.cancelAnimationFrame(popupLayoutFrame);
    popupLayoutFrame = null;
    popupLayouts.clear();
  }

  function cancelMasonry(level, layout) {
    if (popupLayouts.get(level) !== layout) return;
    popupLayouts.delete(level);
    if (popupLayouts.size === 0) cancelPopupLayout();
  }

  function popupResizePosition() {
    const viewport = popupViewport();
    const left = Math.min(popupResize.left, viewport.width - POPUP_PADDING_PX);
    const top = Math.min(popupResize.top, viewport.height - POPUP_PADDING_PX);
    return { left, top, placement: "beside",
      width: Math.min(sessionPopupSize.width, viewport.width - left - POPUP_PADDING_PX),
      height: Math.min(sessionPopupSize.height, viewport.height - top - POPUP_PADDING_PX) };
  }

  function startPopupResize(event, level) {
    if (event.button !== 0 || level.retired) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const rect = popupRect(level.popup.getBoundingClientRect());
    const minimum = popupRect(handle.getBoundingClientRect());
    cancelCandidateScan();
    clearHideTimer();
    clearTransferTimer();
    clearDescendantTimer();
    sessionPopupSize = { width: rect.width, height: rect.height };
    popupResize = { level, handle, pointerId: event.pointerId, ...rect,
      x: event.clientX, y: event.clientY, minimum };
    handle.setPointerCapture(event.pointerId);
  }

  function movePopupResize(event) {
    if (!popupResize || event.pointerId !== popupResize.pointerId) return;
    if ((event.buttons & 1) === 0) { stopPopupResize(); return; }
    const drag = popupResize;
    const factor = window.HDPopup.popupCoordinateScale(pageZoom, options.popupScalePercent);
    sessionPopupSize = {
      width: Math.max(drag.minimum.width, drag.width + (event.clientX - drag.x) * factor),
      height: Math.max(drag.minimum.height, drag.height + (event.clientY - drag.y) * factor),
    };
    const position = popupResizePosition();
    sessionPopupSize = { width: position.width, height: position.height };
    positionPopup();
  }

  function stopPopupResize() {
    if (!popupResize) return;
    const { handle, pointerId } = popupResize;
    popupResize = null;
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }

  function queueMasonry(level, layout) {
    if (disposed || level.retired || level.popup.hidden || level.popup.inert) return;
    popupLayouts.set(level, layout);
    if (popupLayoutFrame !== null) return;
    // Lay out every dirty pane before placing the chain once in this frame.
    // A width change can queue another observer batch without losing its work.
    popupLayoutFrame = window.requestAnimationFrame(() => {
      const layouts = popupLayouts;
      popupLayouts = new Map();
      popupLayoutFrame = null;
      let owner = null;
      for (const [level, layout] of layouts) {
        if (level.retired || level.popup.hidden || level.popup.inert) continue;
        layout();
        if (!owner || level.depth < owner.depth) owner = level;
      }
      if (owner) positionPopup(owner);
    });
  }

  // A screenshot of the page must not contain anything Hachidori drew: the host
  // carries the popup, its image preview and the fallback highlight paint, and the
  // registered highlight is suspended beside it. Two frames give the change time
  // to paint before the capture. Concealment is counted, so one capture cannot
  // reveal the reader while another still owns it, and everything is restored
  // whatever the captures did.
  let concealing = 0;
  let restoreMatchHighlight = null;
  let restoreWordHighlights = null;
  let hostOpacity = "";
  let hostOpacityPriority = "";
  async function concealReader(during) {
    if (host === null) return during();
    // The source-term highlight is painted by the document, not by the shadow
    // tree, so the highlighter stops publishing for as long as this lasts —
    // including for a lookup that settles while the picture is being taken.
    // Word highlights leave the picture the same way.
    if (concealing === 0) {
      restoreMatchHighlight = highlighter?.suspend() ?? null;
      restoreWordHighlights = wordHighlights?.suspend() ?? null;
      hostOpacity = host.style.getPropertyValue("opacity");
      hostOpacityPriority = host.style.getPropertyPriority("opacity");
      // Descendants can override inherited visibility, including masonry cards.
      // Opacity composites the whole host without changing its layout.
      host.style.setProperty("opacity", "0", "important");
    }
    concealing += 1;
    try {
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      return await during();
    } finally {
      concealing -= 1;
      if (concealing === 0) {
        host.style.setProperty("opacity", hostOpacity, hostOpacityPriority);
        restoreMatchHighlight?.();
        restoreMatchHighlight = null;
        restoreWordHighlights?.();
        restoreWordHighlights = null;
      }
    }
  }

  function hostParent() {
    const fullscreen = document.fullscreenElement;
    if (!fullscreen || fullscreen === document.documentElement || fullscreen === document.body
        || fullscreen.shadowRoot
        || ["iframe", "frame", "video", "canvas", "img", "object", "embed", "svg"]
          .includes(fullscreen.localName)) return document.body;
    return fullscreen;
  }

  function mountHost() {
    const parent = hostParent();
    if (host && parent && host.parentNode !== parent) parent.appendChild(host);
  }

  function onFullscreenChange() {
    mountHost();
    positionPopup();
  }

  function buildUi() {
    host = document.createElement(HOST_TAG);
    // Inline !important is the only declaration a page cannot override, and the
    // host must stay a zero-sized, non-interactive fixed anchor whatever the
    // page's CSS says. `all: initial` also stops inherited page typography from
    // reaching the shadow tree.
    host.style.cssText = [
      "all: initial !important",
      "position: fixed !important",
      "top: 0 !important",
      "left: 0 !important",
      "width: 0 !important",
      "height: 0 !important",
      "pointer-events: none !important",
      "z-index: 2147483647 !important",
    ].join("; ");
    applyPageZoom();
    shadow = host.attachShadow({ mode: "open" });

    mountHost();
    appearance = window.HDPopup.createPopupAppearance(host);
    appearance.update(options);
    customStyle = window.HDPopup.createCustomPopupStyle(shadow);
    customStyle.update(options.customPopupCss);
    themeHost.attach(shadow);

    highlighter = window.HDPopup.createSourceHighlighter(
      window,
      document,
      HIGHLIGHT_NAME,
      shadow
    );
    buildLevelUi(rootLevel);
  }

  function buildLevelUi(level) {
    mining ??= window.HDAnki.createAnkiController({
      send: (type, fields) => sendRequest(type, fields, "hachidori-anki"),
      onChange: owner => positionPopup(owner),
      conceal: concealReader,
      recordNetflixLine: (cue, templateId, options) => window.HDNetflix.record(cue, {
        send: (type, fields) => sendRequest(type, fields, "hachidori-netflix"), templateId, ...options }),
    });
    mining.update(options, optionsStorageRevision >= 0);
    audio ??= window.HDAudio.createAudioController({ window, popupRect,
      send: (type, fields) => sendRequest(type, fields, "hachidori-audio"),
      // The chooser places itself inside its pane. Open, it is that pane's
      // interaction, so a child pane that would cover its choices closes.
      onMenuChange(owner) {
        cancelCandidateScan();
        clearHideTimer();
        if (audio.hasMenu(owner) && levels.length > owner.depth + 1 && !hasProtectedNote(owner.depth + 1)) {
          dismissLevels(owner.depth + 1, false);
        }
      },
      onSelectionChange: owner => mining.refresh(owner),
    });
    audio.update(options, optionsStorageRevision >= 0);
    wordStatusActions ??= window.HDWordHighlights.createWordStatusActions({
      send: (type, fields) => sendRequest(type, fields, WORKER_TARGET),
    });
    wordStatusActions.update(options);
    wordStatusActions.setOverrides(wordStatusOverrides);
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.dataset.hoshidictsDepth = String(level.depth);
    popup.hidden = true;
    popup.addEventListener("focusin", () => {
      cancelCandidateScan();
      clearHideTimer();
    });
    popup.addEventListener("focusout", onPopupFocusOut);
    // Scroll events do not bubble from the definition pane or its inner cards.
    // Keep linked popups aligned with anchors moving inside those scrollers.
    popup.addEventListener("scroll", () => {
      if (level.retired) return;
      const child = levels[level.depth + 1];
      if (child) positionPopup(child);
    }, { capture: true, passive: true });
    popup.addEventListener("wheel", (event) => onPopupWheelKeybind(event, level), { capture: true, passive: false });
    popup.addEventListener("wheel", onPopupWheel, { passive: false });
    popup.addEventListener("mouseenter", () => onPopupEnter(level));
    popup.addEventListener("mouseleave", (event) => onPopupLeave(event, level));
    // Yomitan dismisses a nested popup when its parent is pressed. A primary
    // press here retires this pane's descendants at once, focused or not, and
    // drops a pending definition scan so an older lookup cannot reopen one.
    // A draft or pending append protects them as on every other hide path. A
    // press on an internal link keeps that link's own child for its click to
    // reuse or replace, retiring only the branch below it.
    let press = null;
    popup.addEventListener("mousedown", (event) => {
      press = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
      if (event.button !== 0 || level.retired) return;
      const link = popupLinkAt(event.target, level)?.hasAttribute("data-hoshidicts-query") === true;
      const depth = level.depth + (link ? 2 : 1);
      if (levels.length <= depth || hasProtectedNote(depth)) return;
      clearScanTimer();
      cancelScanDwell();
      dismissLevels(depth, false);
    });
    // Reading → Activation → Child popups → Click: a primary click on a word in
    // the definitions opens its child once the press above has retired the
    // previous one. A press that travels or leaves a selection is a copy, and
    // links, images, buttons and disclosures keep their own click.
    popup.addEventListener("click", (event) => {
      const start = press;
      press = null;
      if (options.definitionLookupMode !== "click" || !start || event.defaultPrevented || hasProtectedNote()
          || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= GLYPH_DRAG_START_PX
          || event.target.closest("a, button, summary")) return;
      const selection = shadow.getSelection?.() ?? window.getSelection();
      if (selection && !selection.isCollapsed && popup.contains(selection.anchorNode)) return;
      const candidate = resolveDefinitionCandidate(event.clientX, event.clientY, level);
      if (candidate) void openChildLookup(candidate, level, { source: "click" });
    });
    popup.addEventListener(
      "mousemove",
      (event) => onPopupMouseMove(event, level),
      { capture: true, passive: true }
    );
    popup.addEventListener("mouseover", (event) => {
      const request = level.currentViewRequest;
      if (request?.blur && request.blur.state !== "revealed" && event.target instanceof Element
          && event.target.closest(".gsm-hoshidicts-definitions, .gsm-hoshidicts-compact-definition-summary")) {
        revealDefinitions(request, level);
      }
    });
    shadow.appendChild(popup);
    level.popup = popup;
    level.highlighter = highlighter.scope(level);
    level.view = themeHost.createView({
      onRendererRetired() {
        audio.retire(level);
        mining.retire(level);
        wordStatusActions.retire(level);
        level.noteEditing = false;
      },
      appendExpressionRuby: window.HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: window.HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary,
      appendStructuredImage: window.HDGlossary.appendStructuredImage,
      document,
      getPageZoom: () => pageZoom,
      getPopupScalePercent: () => options.popupScalePercent,
      getPopupColumns: () => options.popupColumns,
      getImageHoverPreview: () => options.imageHoverPreview,
      onResizeStart: event => startPopupResize(event, level),
      onResizeMove: movePopupResize,
      onResizeEnd: stopPopupResize,
      customButtons: options.customButtons,
      highlightName: HIGHLIGHT_NAME,
      idPrefix: level === rootLevel ? "hoshidicts" : `hoshidicts-${nextLevelId += 1}`,
      onAddCustomEntry: (entry) => appendCustomEntry(entry, level),
      onCustomLinkClick(link) {
        if (!level.currentViewRequest || level.retainedView
            || !requestCanRender(level.lookupToken, level.activeCandidate, level)) return;
        openExternalLink(link);
      },
      onKanjiClick: (character, result, candidate, link) => showKanji(character, result, candidate, link, level),
      onNoteEditingChange: (editing) => onNoteEditingChange(editing, level),
      onResultsRendered: rendered => bindResultActions(rendered, level),
      onResultsExpanded: rendered => bindResultActions(rendered, level),
      onBeforeResultsRendered: (intent) => {
        audio.retire(level);
        mining.retire(level);
        wordStatusActions.retire(level);
        pruneLevels(level.depth + 1);
        if (level.retainedView) {
          replayVisibleView(level, intent);
          return false;
        }
      },
      canProjectDictionaryPresentation: () => !level.retired && !level.noteEditing
        && level.pendingCustomAppends === 0 && levels.length === level.depth + 1
        && requestCanRender(level.lookupToken, level.activeCandidate, level),
      canUpdateCompactSummary: () => requestCanRender(level.lookupToken, level.activeCandidate, level),
      parseTagList: window.HDGlossary.parseTagList,
      popup,
      positionPopup: () => positionPopup(level),
      queueMasonry: (layout) => queueMasonry(level, layout),
      cancelMasonry: (layout) => cancelMasonry(level, layout),
      sourceHighlighter: level.highlighter,
      sourceHighlightEnabled: options.sourceHighlightEnabled,
      toolbarPosition: window.HDPopup.resolveToolbarPosition(options.popupToolbarPosition),
      window,
    });
  }

  function bindResultActions(rendered, level) {
    queueMicrotask(() => gsmBridge?.refresh()); // GSM hook
    const token = level.lookupToken, request = level.currentViewRequest;
    // Keybinds index these like the view's entries; Show more grows the same
    // arrays and rebinds only the newly revealed controls. The count element
    // belongs to the initial render and stays until the next one.
    level.entryAudio = rendered.audioButtons;
    level.entryMining = rendered.miningActions;
    if ("lookupStats" in rendered) {
      level.lookupStatsElement = rendered.lookupStats;
      paintLookupStatistics(request, level);
    }
    const context = { owner: level, popup: level.popup, request,
      isCurrent: () => level.currentViewRequest === request && !level.retainedView
        && requestCanRender(token, level.activeCandidate, level),
    };
    // The primary result's autoplay waits until its definitions are revealed,
    // whichever tab or expansion binds.
    audio.bind(rendered.audioButtons, {
      ...context,
      ...("lookupStats" in rendered ? { autoplayHeld: () => request?.blur?.autoplayHeld === true } : {}),
    });
    mining.bind(rendered.miningActions, { ...context, getRequest: result => {
      const candidate = level.activeCandidate;
      const selection = shadow.getSelection?.() ?? window.getSelection();
      const frequencyModes = new Map(dictionaries.map(item => [item.title, item.frequencyMode]));
      const term = { ...result.term, frequencies: result.term.frequencies.map(group =>
        ({ ...group, frequencyMode: frequencyModes.get(group.dictionary) })) };
      return { ...result, term, generation: level.activeTermRender.generation, sentence: candidate.sentence,
        matchOffset: candidate.matchOffset, matched: sentenceMatchedText(candidate, result.matched || result.term.expression),
        searchQuery: request?.payload?.text ?? request?.kanjiPayload?.character ?? candidate.query,
        popupSelectionText: selection?.anchorNode && level.popup.contains(selection.anchorNode) ? selection.toString() : "",
        documentTitle: document.title, audioSelection: audio.selectionFor(result) ?? undefined,
        // Like Yomitan, a note mined on Hachidori's own page (the setup practice) has no source address.
        pageUrl: location.protocol === EXTENSION_PROTOCOL ? "" : location.href,
        dictionaryAliases: Object.fromEntries(dictionaries.filter(item => item.displayName).map(item => [item.title, item.displayName])),
        dictionaryIds: Object.fromEntries(dictionaries.map(item => [item.title, item.id])),
        frequencyDictionaries: dictionaries.filter(item => item.enabled && item.frequencyCount > 0).map(item => item.title),
        // Experimental Netflix mining: the root popup's pinned cue, and for the
        // root lookup the whole cue as its sentence.
        ...(netflixMiningEnabled() ? window.HDNetflix.miningFields(rootLevel.activeCandidate?.netflixObservation,
          level === rootLevel ? candidate : null) : {}),
      };
    } });
    // Only Default's stylesheet styles Mark as known and Ignore; elsewhere
    // their keybinds act alone.
    wordStatusActions.bind(rendered.miningActions, { ...context, buttons: themeHost.renderer === "default" });
  }

  // A count on its way keeps its slot's place, so its arrival moves nothing.
  // Once its request settles without one, the slot hides.
  function paintLookupStatistics(request, level, settled = false) {
    if (!options.showLookupCounts) {
      if (level.lookupStatsElement) level.lookupStatsElement.hidden = true;
      return;
    }
    if (request !== level.currentViewRequest
        || !requestCanRender(level.lookupToken, level.activeCandidate, level) || !level.lookupStatsElement?.isConnected) return;
    const entry = request?.lookupStats;
    const statistics = entry?.payload?.descriptor.generation === lookupStatsDescriptor.generation
      ? entry.payload.statistics : null;
    const onItsWay = Boolean(entry) && (entry.needsRefresh || (entry.pending && !settled));
    level.view.setLookupStats(level.lookupStatsElement, statistics, onItsWay);
  }

  function adoptLookupStatsDescriptor(descriptor, changes = {}) {
    if (!Number.isSafeInteger(descriptor?.revision) || descriptor.revision < 0
        || (descriptor.generation !== null
          && (typeof descriptor.generation !== "string" || descriptor.generation === ""))) return;
    const sameGeneration = descriptor.generation === lookupStatsDescriptor.generation;
    if (descriptor.revision < lookupStatsDescriptor.revision && !sameGeneration) return;
    const replaced = descriptor.generation !== lookupStatsDescriptor.generation;
    if (descriptor.revision >= lookupStatsDescriptor.revision) lookupStatsDescriptor = descriptor;
    for (const level of levels) {
      const request = level.currentViewRequest;
      const entry = request?.lookupStats;
      if (!entry) continue;
      const row = changes[lookupStatsKey(descriptor, entry)]?.newValue;
      if (row && (!entry.payload || entry.payload.descriptor.generation !== descriptor.generation
          || entry.payload.descriptor.revision < descriptor.revision)) {
        entry.payload = { descriptor, statistics: row };
        entry.needsRefresh = false;
      } else if (replaced) entry.needsRefresh = true;
      else continue;
      paintLookupStatistics(request, level);
      if (row) settleDefinitionBlur(request, level, currentLookupCount(entry));
      refreshLookupStatistics(request, level);
    }
  }

  // The count that decides definition blur: null while unknown or unavailable.
  function currentLookupCount(entry) {
    const payload = entry.payload;
    if (!payload || payload.descriptor.generation !== lookupStatsDescriptor.generation) return null;
    return payload.statistics?.lookupCount ?? null;
  }

  function refreshLookupStatistics(request, level, record = false) {
    const entry = request.lookupStats;
    if (!options.showLookupCounts || entry.pending || (!record && !entry.needsRefresh)
        || request !== level.currentViewRequest
        || !requestCanRender(level.lookupToken, level.activeCandidate, level)) return;
    entry.pending = true;
    entry.needsRefresh = false;
    const requestedOptionsRevision = optionsStorageRevision;
    void sendRequest(record ? "hd_lookup_stats_record" : "hd_lookup_stats_read", {
      term: entry.term, reading: entry.reading,
    }, "hoshidicts-worker").then(payload => {
      adoptLookupStatsDescriptor(payload.descriptor);
      if (payload.descriptor.generation !== lookupStatsDescriptor.generation) {
        entry.needsRefresh = true;
        return;
      }
      if (!(entry.payload?.descriptor.revision > payload.descriptor.revision)) {
        entry.payload = payload;
        entry.needsRefresh = options.showLookupCounts
          && payload.statistics === null && requestedOptionsRevision !== optionsStorageRevision;
      }
      if (request.lookupStats === entry) {
        paintLookupStatistics(request, level, true);
        settleDefinitionBlur(request, level, currentLookupCount(entry));
      }
    }).catch(error => {
      // A lost reply may follow a committed increment. Never retry the write.
      console.debug("hachidori: lookup statistics unavailable", error);
      if (request.lookupStats === entry) {
        paintLookupStatistics(request, level, true);
        settleDefinitionBlur(request, level, null);
      }
    }).finally(() => {
      entry.pending = false;
      if (request.lookupStats === entry && entry.needsRefresh) refreshLookupStatistics(request, level);
    });
  }

  function acceptLookupStatistics(results, request, level) {
    const { term, reading } = normaliseLookupTerm(results[0].term.expression, results[0].term.reading);
    const firstVisit = !request.lookupStats;
    let entry = request.lookupStats;
    if (!entry || entry.term !== term || entry.reading !== reading) {
      entry = request.lookupStats = { term, reading, pending: false, payload: null, needsRefresh: true };
    } else if (entry.payload && entry.payload.descriptor.generation !== lookupStatsDescriptor.generation) {
      entry.needsRefresh = true;
    }
    // The descriptor owns one visit, including a visit while counts are off.
    // Back, tabs and Note refresh can read a replacement, but cannot increment.
    paintLookupStatistics(request, level);
    refreshLookupStatistics(request, level, firstVisit);
    checkDefinitionBlurMaturity(request, level);
  }

  // The primary word owns one local maturity-cache check per visit. It starts after
  // rendering and never joins the lookup or storage queue. Back keeps its
  // result; a changed Anki configuration discards the old evidence.
  function checkDefinitionBlurMaturity(request, level) {
    const blur = request.blur;
    if (blur.awaitingOptions || !options.definitionBlurAnkiMature || blur.ankiCheck !== undefined) return;
    const check = blur.ankiCheck = { epoch: ankiMaturityEpoch };
    const { expression, reading } = level.activeTermRender.results[0].term;
    void sendRequest("hd_anki_maturity", { request: { term: { expression, reading } } }, "hachidori-anki")
      .then(payload => payload.mature === true, () => false).then(mature => {
        if (blur.ankiCheck !== check) return;
        blur.ankiMature = check.epoch === ankiMaturityEpoch && mature;
        settleDefinitionBlur(request, level);
      });
  }

  function definitionBlurActive(candidate = options) {
    return (candidate.definitionBlurCountEnabled && candidate.showLookupCounts)
      || candidate.definitionBlurAnkiMature || candidate.definitionBlurFrequencyEnabled;
  }

  function snapshotDefinitionBlurFrequency(results) {
    const groups = Array.isArray(results?.[0]?.term?.frequencies) ? results[0].term.frequencies : [];
    return {
      groups: groups.flatMap(group => typeof group?.dictionary === "string" && Array.isArray(group.frequencies)
        ? [{ dictionary: group.dictionary,
            frequencies: group.frequencies.map(frequency => ({ value: frequency?.value })) }]
        : []),
      dictionaries: dictionaries
        .filter(dictionary => dictionary.enabled !== false && dictionary.frequencyCount > 0)
        .map(({ title, frequencyMode, frequencyCount }) => ({ title, frequencyMode, frequencyCount })),
    };
  }

  function currentDefinitionBlurFrequency(blur, candidate = options) {
    return definitionBlurFrequencyEvidence(candidate, blur.frequency.groups, blur.frequency.dictionaries);
  }

  function discardStaleAnkiMaturity(request, level) {
    const blur = request.blur;
    if (!blur.ankiCheck || blur.ankiCheck.epoch === ankiMaturityEpoch) return;
    blur.ankiCheck = null;
    blur.ankiMature = false;
    settleDefinitionBlur(request, level);
  }

  // Definition blur (issue #9 L5). The decision lives on the request, so tabs,
  // expansion, Note refresh and Back keep it while a new request starts fresh.
  // One absolute reveal deadline runs from the first display; a live timer
  // exists only while that request is the level's current view.
  function clearDefinitionBlurTimer(level) {
    if (level.blurTimer === null) return;
    clearTimeout(level.blurTimer);
    level.blurTimer = null;
  }

  function applyDefinitionBlurState(request, level) {
    if (level.currentViewRequest === request && level.view) level.view.setDefinitionBlurState(request.blur.state);
  }

  function revealDefinitions(request, level) {
    const blur = request?.blur;
    if (!blur || blur.state === "revealed") return;
    blur.state = "revealed";
    if (level.currentViewRequest === request) clearDefinitionBlurTimer(level);
    applyDefinitionBlurState(request, level);
    releaseDefinitionBlurAutoplay(request, level);
  }

  function armDefinitionBlurTimer(request, level) {
    clearDefinitionBlurTimer(level);
    const blur = request.blur;
    if (blur.state === "revealed" || options.definitionBlurReveal !== "timed") return;
    const remaining = blur.displayedAt + options.definitionBlurDelayMs - Date.now();
    if (remaining <= 0) {
      revealDefinitions(request, level);
      return;
    }
    level.blurTimer = setTimeout(() => {
      level.blurTimer = null;
      if (level.currentViewRequest === request) revealDefinitions(request, level);
    }, remaining);
  }

  // Before the stored settings arrive the decision stays pending, like the
  // audio controller's own options hold, so a first lookup cannot reveal or
  // auto-play against defaults that the stored settings then contradict.
  function beginDefinitionBlur(request, level, results) {
    clearDefinitionBlurTimer(level);
    if (!request) return;
    if (!request.blur) {
      const awaitingOptions = optionsStorageRevision < 0;
      const active = awaitingOptions || definitionBlurActive();
      request.blur = { state: active ? "pending" : "revealed", displayedAt: Date.now(), awaitingOptions,
        lookupCount: undefined, ankiMature: undefined, autoplayHeld: active,
        frequency: snapshotDefinitionBlurFrequency(results) };
    }
    if (!request.blur.awaitingOptions) {
      discardStaleAnkiMaturity(request, level);
      settleDefinitionBlur(request, level);
      armDefinitionBlurTimer(request, level);
    }
  }

  function resolveDefinitionBlurOptions(request, level) {
    const blur = request.blur;
    blur.awaitingOptions = false;
    checkDefinitionBlurMaturity(request, level);
    armDefinitionBlurTimer(request, level);
    settleDefinitionBlur(request, level);
  }

  // Pending and blurred definitions hold the first result's autoplay; every
  // reveal releases it once.
  function releaseDefinitionBlurAutoplay(request, level) {
    if (!request.blur.autoplayHeld) return;
    request.blur.autoplayHeld = false;
    audio?.settleAutoplay(level, request);
  }

  // Any enabled signal can qualify immediately. Frequency is synchronous,
  // while a negative decision waits for enabled count and Anki evidence.
  // Retain the first count while Anki is pending so later row events cannot
  // change this visit's decision. Hover and the absolute deadline can reveal
  // before either reply, without reblurring.
  function settleDefinitionBlur(request, level, lookupCount) {
    const blur = request.blur;
    if (!blur) return;
    if (blur.lookupCount === undefined && lookupCount !== undefined) blur.lookupCount = lookupCount;
    if (blur.awaitingOptions || blur.state === "revealed") return;
    const countEnabled = options.definitionBlurCountEnabled && options.showLookupCounts;
    const frequency = currentDefinitionBlurFrequency(blur);
    const qualifies = definitionBlurQualifies(options, countEnabled ? blur.lookupCount : null,
      blur.ankiMature, frequency.qualified);
    const pending = !qualifies && ((countEnabled && blur.lookupCount === undefined)
      || (options.definitionBlurAnkiMature && blur.ankiMature === undefined));
    if (pending) {
      if (blur.state !== "pending") {
        blur.state = "pending";
        applyDefinitionBlurState(request, level);
      }
      return;
    }
    if (!qualifies) {
      revealDefinitions(request, level);
      return;
    }
    if (blur.state !== "blurred") {
      blur.state = "blurred";
      applyDefinitionBlurState(request, level);
    }
  }

  function ensureUi() {
    if (!uiPromise) {
      uiPromise = (async () => {
        if (!document.body || !window.HDPopup || !window.HDGlossary) {
          throw new Error("render modules or document body unavailable");
        }
        await themeHost.sync();
        if (disposed) {
          throw new Error("torn down");
        }
        buildUi();
      })().catch((error) => {
        console.warn("hachidori: popup unavailable", error);
        // The next hover retries, so a half-built host must not stay in the page
        // and must not leave `view` null behind a non-null `popup`.
        discardUi();
        uiPromise = null;
        throw error;
      });
    }
    return uiPromise;
  }

  function show(candidate, level = rootLevel) {
    level.activeCandidate = candidate;
    level.activeSignature = candidateSignature(candidate);
    // A Netflix subtitle line is pinned as the popup opens, so adding the note
    // after the line has gone still records that line.
    if (level === rootLevel && candidate.sourceDepth === -1 && netflixMiningEnabled()) {
      candidate.netflixObservation ??= window.HDNetflix.observe(candidate.anchor);
    }
    // The body may have been replaced, or the player may have entered fullscreen.
    mountHost();
    level.popup.hidden = false;
    level.popup.inert = false;
    level.view.scrollElement.scrollTop = 0;
    syncHostAttention();
    if (level === rootLevel) retireFieldImposter();
  }

  function pruneLevels(depth, restoreFocus = true) {
    clearDescendantTimer();
    if (levels.length <= Math.max(1, depth)) {
      if (levels.length === 1) clearTransferTimer();
      return;
    }
    const source = levels[depth]?.activeCandidate?.anchor;
    const removed = levels.splice(Math.max(1, depth));
    const focused = removed.some((level) => level.popup?.contains(shadow?.activeElement));
    for (const level of removed.reverse()) {
      if (popupResize?.level === level) stopPopupResize();
      audio?.retire(level);
      mining?.retire(level);
      wordStatusActions?.retire(level);
      clearDefinitionBlurTimer(level);
      level.retired = true;
      level.lookupToken += 1;
      level.popup.hidden = true;
      level.view?.clear();
      level.view?.destroy();
      level.popup?.remove();
    }
    // Removing a pane can uncover surviving fallback source paint.
    highlighter?.refresh();
    if (restoreFocus && focused && source?.isConnected) source.focus({ preventScroll: true });
    if (levels.length === 1) clearTransferTimer();
  }

  // Retiring panes can release a deferred parent replay or projection.
  function dismissLevels(depth, restoreFocus = true) {
    pruneLevels(depth, restoreFocus);
    flushDeferredNotes();
    flushDictionaryPresentation();
  }

  function hide(level = rootLevel) {
    if (level === rootLevel || popupResize?.level === level) stopPopupResize();
    audio?.retire(level);
    mining?.retire(level);
    clearDefinitionBlurTimer(level);
    if (level !== rootLevel) {
      if (!level.retired) dismissLevels(level.depth);
      return;
    }
    cancelPopupLayout();
    clearScanTimer();
    cancelScanDwell();
    selectionDragActive = false;
    dragSelection = null;
    activeSelectionCandidate = null;
    pendingCandidateLookup = null;
    clearHideTimer();
    clearTransferTimer();
    clearCursorExitTimer();
    pointerLevel = null;
    pruneLevels(1, false);
    rootLevel.activeCandidate = null;
    rootLevel.placedAnchor = null;
    rootLevel.activeSignature = null;
    rootLevel.activeHighlightText = "";
    rootLevel.activeTermRender = null;
    rootLevel.currentViewRequest = null;
    rootLevel.noteEditing = false;
    rootLevel.deferredDictionaryInvalidationRevision = -1;
    rootLevel.deferredRefresh = null;
    rootLevel.retainedView = false;
    rootLevel.lookupToken += 1;
    releaseFieldImposter();
    if (rootLevel.popup) {
      rootLevel.popup.hidden = true;
      rootLevel.popup.inert = false;
      rootLevel.view.clear();
      highlighter.clearAll();
    }
    syncHostAttention();
  }

  function clearHideTimer() {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function clearTransferTimer() {
    if (transferTimer !== null) window.clearTimeout(transferTimer);
    transferTimer = null;
  }

  function scheduleTransferCheck() {
    clearTransferTimer();
    transferTimer = window.setTimeout(() => {
      transferTimer = null;
      if (lastPointer && (isOurNode(lastPointer.target)
          || pointInsidePopup(lastPointer.clientX, lastPointer.clientY))) {
        pointerInPopup = true;
        clearHideTimer();
        return;
      }
      // Leaving the chain from a corridor between panes fires no mouseleave.
      scheduleCursorExitHide();
      // No position means the pointer has since left the window or the reader
      // the tab, and neither dismisses the chain (#432).
      if (lastPointer) scanPointer(lastPointer);
    }, 80);
  }

  function clearDescendantTimer() {
    if (descendantTimer !== null) window.clearTimeout(descendantTimer);
    descendantTimer = null;
  }

  function onPopupEnter(level) {
    if (level.retired) return;
    pointerLevel = level;
    pointerInPopup = true;
    clearTransferTimer();
    clearHideTimer();
    clearCursorExitTimer();
    scheduleDescendantPrune(level);
  }

  function clearCursorExitTimer() {
    if (cursorExitTimer !== null) window.clearTimeout(cursorExitTimer);
    cursorExitTimer = null;
  }

  // Yomitan's frontend.js _onPopupFramePointerOut: with "Hide popup on cursor
  // exit" on, leaving the chain for the page, an iframe or outside the window
  // hides it, in every lookup mode. Only the pane the pointer was last seen in
  // can be left, so a popup it never entered stays. Pane to pane is no exit:
  // a child overlaps its parent, and onPopupEnter owns that transfer.
  function onPopupLeave(event, level) {
    // Leaving the pane, for any destination, leaves the word it was resting on.
    if (scanDwell?.level === level) cancelScanDwell();
    if (!options.hidePopupOnCursorExit || level !== pointerLevel || popupResize) return;
    const next = event.relatedTarget;
    if (next && levels.some((other) => other.popup?.contains(next))) return;
    scheduleCursorExitHide();
  }

  // Like Yomitan, a running timer is not restarted, and even 0 ms waits for
  // the mousemove that follows the boundary events. Exact-selection lookups
  // stay, as retainSelectedLookup() keeps them on every pointer path.
  function scheduleCursorExitHide() {
    if (!options.hidePopupOnCursorExit || cursorExitTimer !== null || activeSelectionCandidate
        || !rootLevel.popup || rootLevel.popup.hidden) return;
    cursorExitTimer = window.setTimeout(() => {
      cursorExitTimer = null;
      // A page move may have stopped in a corridor between panes; leaving it
      // for the page reaches here again through the transfer check. A last
      // position seen in a pane means the pointer went on into an iframe.
      if (levels.length > 1 && lastPointer && !lastPointer.level
          && pointInsidePopup(lastPointer.clientX, lastPointer.clientY)) {
        pointerInPopup = true;
        return;
      }
      pointerInPopup = false;
      pointerLevel = null;
      if (!hasProtectedNote() && !audio?.hasMenu() && !keyboardFocusInPopup()) hide();
    }, options.hidePopupOnCursorExitDelayMs);
  }

  // Every caller is pointer movement in an ancestor. Like the root's
  // schedulePointerHide(), activationSticky keeps a rendered child through it,
  // as Yomitan does unless "Hide popup on cursor exit" is on. An ancestor
  // press, Escape, Close/Back and a replacement still dismiss the child, and
  // cancelPendingHover() still drops one that has not rendered. With the
  // option on, every mode prunes after its delay, as Yomitan's popup.js
  // _onFrameMouseOver does.
  function scheduleDescendantPrune(level) {
    clearDescendantTimer();
    const depth = level.depth + 1;
    const cursorExit = options.hidePopupOnCursorExit;
    if (depth >= levels.length || (!cursorExit && options.lookupMode === "activationSticky")) return;
    const delay = cursorExit ? options.hidePopupOnCursorExitDelayMs : options.popupHideDelayMs;
    const prune = () => {
      descendantTimer = null;
      if (!hasProtectedNote(depth) && (!pointerLevel || pointerLevel.depth < depth)
          && !levels.slice(depth).some((child) => child.popup.contains(shadow.activeElement))) {
        dismissLevels(depth);
      }
    };
    if (delay === 0) prune();
    else descendantTimer = window.setTimeout(prune, delay);
  }

  function popupHasFocus() {
    return levels.some((level) => level.popup && !level.popup.hidden && level.popup.contains(shadow?.activeElement));
  }

  // Keyboard focus keeps a popup the pointer left, but not the focus Chrome
  // leaves on a clicked button: Yomitan hides regardless of focus.
  function keyboardFocusInPopup() {
    return popupHasFocus() && shadow.activeElement.matches(":focus-visible");
  }

  function focusBlocksScan(level) {
    return popupHasFocus() && (!level
      || (isEditingElement(shadow.activeElement) && shadow.activeElement.localName !== "button"));
  }

  function hasProtectedNote(fromDepth = 0) {
    for (let index = fromDepth; index < levels.length; index += 1) {
      if (levels[index].noteEditing || levels[index].pendingCustomAppends > 0) return true;
    }
    return false;
  }

  // Wheel keybinds, after Yomitan's Alt+wheel entry moves: a wheel step's
  // direction is its key, matched like a key press and acted on by the popup
  // under the pointer. One notch presses the binding once. A touchpad's stream
  // of small steps in one direction presses it when the stream starts and again
  // for each further notch's worth of travel, rather than once per event. A
  // handled step goes no further, so neither the pane nor the page scrolls; an
  // unhandled one reaches the popup's wheel isolation below.
  const WHEEL_NOTCH_PX = 100;
  const WHEEL_GESTURE_GAP_MS = 100;
  let wheelGesture = null;

  function onPopupWheelKeybind(event, level) {
    const key = keybindWheelKey(event);
    if (disposed || key === null) return;
    const signature = [key, ...keybindModifiers(event)].join();
    const continuing = wheelGesture?.level === level && wheelGesture.signature === signature
      && event.timeStamp - wheelGesture.timeStamp < WHEEL_GESTURE_GAP_MS;
    const travel = continuing ? wheelGesture.travel + Math.abs(event.deltaY) : WHEEL_NOTCH_PX;
    const presses = Math.floor(travel / WHEEL_NOTCH_PX);
    let handled = continuing;
    for (let press = 0; press < presses; press += 1) handled = runKeybinds(event, level, key) || handled;
    if (!handled) {
      wheelGesture = null;
      return;
    }
    wheelGesture = { level, signature, timeStamp: event.timeStamp, travel: travel % WHEEL_NOTCH_PX };
    event.preventDefault();
    event.stopPropagation();
  }

  // The popup's wheel belongs to the popup. Readers such as ttu turn pages from
  // wheel events on their body, and a pane that cannot scroll further (or has
  // nothing to scroll) would otherwise chain the gesture into the page.
  function onPopupWheel(event) {
    event.stopPropagation();
    if (event.defaultPrevented || event.ctrlKey) return;
    const popup = event.currentTarget;
    for (let node = event.target; node instanceof Element; node = node === popup ? null : node.parentElement) {
      if (canScrollBy(node, event.deltaX, event.deltaY)) return;
    }
    event.preventDefault();
  }

  function canScrollBy(element, deltaX, deltaY) {
    const room = (delta, offset, size, viewport) => delta > 0 ? offset + viewport < size - 1 : delta < 0 && offset > 0;
    const vertical = room(deltaY, element.scrollTop, element.scrollHeight, element.clientHeight);
    const horizontal = room(deltaX, element.scrollLeft, element.scrollWidth, element.clientWidth);
    if (!vertical && !horizontal) return false;
    const style = window.getComputedStyle(element);
    const scrolls = overflow => overflow === "auto" || overflow === "scroll";
    return (vertical && scrolls(style.overflowY)) || (horizontal && scrolls(style.overflowX));
  }

  function onPopupFocusOut(event) {
    const target = event.target;
    window.queueMicrotask(() => {
      // A redraw can remove the focused Note form. That is not departure
      // from the refreshed popup; wait until removal/focus transfer settles.
      if (target.isConnected && levels.some((level) => level.popup?.contains(target))) scheduleHide();
      flushDictionaryPresentation();
    });
  }

  function scheduleHide() {
    if (gsmBridge?.navigationActive) return; // GSM hook
    if (disposed || hasProtectedNote() || audio?.hasMenu() || !rootLevel.popup || rootLevel.popup.hidden
        || popupHasFocus() || hideTimer !== null || transferTimer !== null) {
      return;
    }
    // The gap between the word and the popup is dead space; give the pointer
    // time to cross it so the popup stays reachable and selectable.
    const dismiss = () => {
      hideTimer = null;
      if (!hasProtectedNote() && !audio?.hasMenu() && !pointerInPopup && !popupHasFocus()) {
        hide();
      }
    };
    if (options.popupHideDelayMs === 0) dismiss();
    else hideTimer = window.setTimeout(dismiss, options.popupHideDelayMs);
  }

  function compactSummaryOptions() {
    return { showCompactDefinitionSummary: options.showCompactDefinitionSummary,
      compactDefinitionSummaryCount: options.compactDefinitionSummaryCount,
      compactDefinitionSummaryDictionary: options.compactDefinitionSummaryDictionary };
  }

  function openExternalLink({ url, active }) {
    if (hostCapabilities.externalLinkHost) {
      void window.HDExternalLinkHost.open(window, { url, active }).catch((error) => {
        console.debug("hachidori: overlay host could not open external link", error);
      });
      return;
    }
    // A lost reply may follow a successful open, so never retry navigation.
    void sendRequest("hd_open_external", { url, active }, "hoshidicts-worker").catch((error) => {
      console.debug("hachidori: external link could not be opened", error);
    });
  }

  function renderContextFor(level = rootLevel) {
    return {
      definitionBlurState: level.currentViewRequest?.blur?.state ?? "revealed",
      dictionaryPresentation: dictionaryPresentation(),
      dictionaryTabGroups: dictionaryTabGroups(),
      generation: currentGeneration,
      onExternalLink: openExternalLink,
      onInternalLink: (link) => onInternalLink(link, level),
      ...imageSourceContext(),
      ...compactSummaryOptions(),
      ...window.HDPopup.metadataOptions(options),
    };
  }

  function focusPopupControl(selector, level = rootLevel) {
    const control = level.popup?.querySelector(selector);
    if (typeof control?.focus !== "function") {
      return;
    }
    try {
      control.focus({ preventScroll: true });
    } catch {
      control.focus();
    }
  }

  function kanjiLinkFocusTarget(sourceLink, character, level = rootLevel) {
    const links = level.popup?.querySelectorAll(".gsm-hoshidicts-kanji-link");
    const index = links ? Array.prototype.indexOf.call(links, sourceLink) : -1;
    return { character, index };
  }

  function focusKanjiLink(focusTarget, level = rootLevel) {
    const links = level.popup?.querySelectorAll(".gsm-hoshidicts-kanji-link");
    if (!links || links.length === 0) {
      return;
    }
    const character = typeof focusTarget === "object" ? focusTarget?.character : focusTarget;
    let target = links[0];
    const index = Number.isInteger(focusTarget?.index) ? focusTarget.index : -1;
    if (index >= 0 && index < links.length && links[index].textContent === character) {
      target = links[index];
    } else if (typeof character === "string" && character !== "") {
      for (const link of links) {
        if (link.textContent === character) {
          target = link;
          break;
        }
      }
    }
    if (typeof target?.focus !== "function") {
      return;
    }
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  async function restoreTermRender(previous, focusTarget, level = rootLevel) {
    audio?.retire(level);
    mining?.retire(level);
    if (previous.generation !== currentGeneration || !sameDictionaryContents(previous.dictionaries, dictionaries)) {
      const restoring = executeViewRequest(previous.request, level, previous.viewport);
      const token = level.lookupToken;
      if (await restoring && token === level.lookupToken && level.currentViewRequest === previous.request) {
        focusKanjiLink(focusTarget, level);
      }
      return;
    }
    level.lookupToken += 1;
    renderTerms(
      previous.results,
      previous.candidate,
      previous.matchedText,
      previous.renderOptions,
      previous.request,
      level,
      previous.viewport,
    );
    focusKanjiLink(focusTarget, level);
  }

  function dictionarySelectionContext(request) {
    return {
      selectedDictionaryTab: request?.selectedDictionaryTab ?? null,
      onDictionaryTabSelected(selection) {
        if (request) request.selectedDictionaryTab = normalizedDictionaryTab(selection);
      },
    };
  }

  function backRenderOptions(request, level = rootLevel) {
    return request?.previous
      ? { onBack: () => restoreTermRender(request.previous, request.returnFocus, level) }
      : level === rootLevel ? {} : { onClose: () => hide(level) };
  }

  function renderTerms(
    results,
    candidate,
    matchedText,
    renderOptions = {},
    request,
    level = rootLevel,
    replayOptions = null,
  ) {
    request ??= level.currentViewRequest;
    level.deferredRefresh = null;
    level.deferredDictionaryInvalidationRevision = -1;
    level.retainedView = false;
    pruneLevels(level.depth + 1);
    const token = level.lookupToken;
    level.currentViewRequest = request ?? null;
    beginDefinitionBlur(request, level, results);
    level.activeTermRender = {
      candidate,
      dictionaries,
      generation: currentGeneration,
      matchedText,
      renderOptions,
      request: level.currentViewRequest,
      results,
      token,
    };
    try {
      level.view.renderResults(results, candidate, {
        ...renderContextFor(level),
        ...renderOptions,
        ...replayOptions,
        highlightText: matchedText,
        isCurrentRequest: () => !disposed && !level.retired && token === level.lookupToken,
        isCurrentView: () => !disposed && !level.retired && level.currentViewRequest === request
          && (token === level.lookupToken || level.retainedView),
        onRenderError(error) { handleRenderFailure(token, error, request, level); },
        ...dictionarySelectionContext(request),
      });
    } catch (error) {
      // A malformed result must cost one hover, not the whole content script.
      handleRenderFailure(token, error, request, level);
      return false;
    }
    level.activeHighlightText = matchedText;
    ensureDictionaryStyles(currentGeneration);
    positionPopup(level);
    if (!replayOptions?.preserveViewControls
        && (typeof renderOptions.onBack === "function" || typeof renderOptions.onClose === "function")
        && (level === rootLevel || request?.previous || level.focusLinkedBack)) {
      focusPopupControl(renderOptions.onClose ? ".gsm-hoshidicts-popup-close" : ".gsm-hoshidicts-kanji-back", level);
    }
    acceptLookupStatistics(results, request, level);
    return true;
  }

  function handleTermMiss(request, dictionaryCount, token, level, replayOptions) {
    if (retainProtectedReplay(request, token, level, replayOptions)) return false;
    const pencil = options.personalDictionaryEnabled;
    if (dictionaryCount === 0 || (request.exactSelection && pencil && options.showNoResultNotice)) {
      show(request.candidate, level);
      level.activeHighlightText = "";
      level.activeTermRender = null;
      clearDefinitionBlurTimer(level);
      // Keep the exact request so saving a new word can refresh this notice
      // into its personal definition, even after the form collapses selection.
      level.currentViewRequest = request;
      level.view.renderNotice(
        dictionaryCount === 0
          ? `No dictionaries loaded. Import a Yomitan .zip in Settings${pencil
            ? ", or add your own definition with the pencil" : ""}.`
          : "No definition found. Add your own with the pencil.",
        request.candidate,
        { isCurrentRequest: () => !disposed && !level.retired && token === level.lookupToken },
      );
      positionPopup(level);
      return false;
    }
    hide(level);
    // A hidden miss keeps the selection like a rendered notice does, so pointer
    // movement cannot repeat its lookup until the selection changes or Escape.
    // Without the personal dictionary the pointer ignores selections, so a
    // retained miss would only block hover lookups over the highlighted text.
    if (request.exactSelection && pencil) activeSelectionCandidate = request.candidate;
    return false;
  }

  async function executeTermRequest(request, level = rootLevel, replayOptions = null) {
    audio?.retire(level);
    mining?.retire(level);
    const token = (level.lookupToken += 1);
    level.retainedView = replayOptions?.preserveViewControls === true;
    if (level.popup && !level.popup.hidden && request !== level.currentViewRequest) {
      pruneLevels(level.depth + 1, false);
      clearDefinitionBlurTimer(level);
      level.popup.inert = true;
      level.currentViewRequest = null;
      level.activeTermRender = null;
      level.deferredRefresh = null;
      level.deferredDictionaryInvalidationRevision = -1;
      level.noteEditing = false;
    }
    level.view?.hideImagePreview();
    let reply;
    try {
      // The first hover pays for the popup host and the stylesheet fetch; run
      // them alongside the lookup instead of ahead of it.
      [, reply] = await Promise.all([
        ensureUi(),
        sendRequest("hd_lookup", request.payload),
      ]);
    } catch (error) {
      return handleRequestFailure(request, token, error, level, replayOptions);
    }
    // Hover fires far faster than lookups return; anything but the newest reply
    // would repaint a word the pointer already left.
    if (!requestCanRender(token, request.candidate, level)) {
      return;
    }
    noteGeneration(reply.generation, level);
    const results = (Array.isArray(reply.results) ? reply.results : [])
      .filter((result) => result && result.term
        && (!(request.exactSelection || request.candidate.linkAnchor)
          || result.matched === request.payload.text));
    if (results.length === 0) {
      return handleTermMiss(request, reply.dictionaryCount, token, level, replayOptions);
    }
    const matched = results[0].matched || results[0].term.expression;
    expandCandidateAnchor(request.candidate, matched);
    if (!replayOptions?.preserveViewControls) show(request.candidate, level);
    if (request.highlightText === undefined) {
      request.highlightText = rawMatchedText(request.candidate, matched);
      // The sentence was cut around the hovered glyph; a terminator inside the
      // matched word (U.S.A.) must not end it.
      refineSentence(request.candidate, request.highlightText.length);
    }
    return renderTerms(
      results,
      request.candidate,
      request.highlightText,
      backRenderOptions(request, level),
      request,
      level,
      replayOptions,
    );
  }

  function runLookup(candidate, overrides = {}, level = rootLevel) {
    const text = typeof overrides.text === "string" ? overrides.text : candidate.query;
    const exactSelection = candidate.exactSelection === true && overrides.text === undefined;
    const exactMatch = exactSelection || candidate.linkAnchor === true;
    return executeTermRequest({
      candidate,
      exactSelection,
      highlightText: overrides.keepHighlight === true ? level.activeHighlightText : undefined,
      kind: "term",
      payload: {
        maxResults: options.maxResults,
        options: {
          frequencyDictionary: options.frequencyDictionary,
          frequencyOrder: options.frequencyOrder,
          personalDictionary: options.personalDictionaryEnabled,
          primaryReading: typeof overrides.primaryReading === "string"
            ? overrides.primaryReading
            : "",
        },
        scanLength: exactMatch ? clampOption("scanLength", Array.from(text).length) : options.scanLength,
        text,
      },
      previous: overrides.previous ?? null,
      returnFocus: overrides.returnFocus ?? null,
      selectedDictionaryTab: normalizedDictionaryTab(overrides.selectedDictionaryTab),
    }, level);
  }

  function sameChildLookup(existing, candidate, primaryReading) {
    return Boolean(existing?.activeCandidate) &&
      existing.primaryReading === primaryReading &&
      existing.activeSignature === candidateSignature(candidate) &&
      sameAnchorNode(candidate, existing.activeCandidate);
  }

  function openChildLookup(candidate, level, {
    focusChild = false,
    primaryReading = "",
    source = "hover",
  } = {}) {
    if (
      level.retired ||
      !level.activeCandidate ||
      !anchorConnected(candidate) ||
      !level.popup.contains(candidate.anchor) ||
      level.depth >= options.popupNestingMaxDepth ||
      popupViewport().width <= POPUP_PADDING_PX * 2 ||
      popupViewport().height <= POPUP_PADDING_PX * 2
    ) {
      return;
    }
    clearHideTimer();
    clearTransferTimer();
    clearDescendantTimer();
    const existing = levels[level.depth + 1];
    // Only a hover child is cancelled when the pointer leaves its word; link
    // and click children load independently of pointer movement.
    const pendingKey = source === "hover" ? "pendingHover" : "pendingLink";
    const pending = existing?.[pendingKey];
    if (
      sameChildLookup(existing, candidate, primaryReading) &&
      (
        pending?.token === existing.lookupToken ||
        (
          existing.currentViewRequest?.kind === "term" &&
          existing.activeTermRender?.token === existing.lookupToken
        )
      )
    ) {
      if (focusChild) {
        existing.focusLinkedBack = true;
        if (!existing.popup.hidden) {
          focusPopupControl(
            existing.currentViewRequest?.previous
              ? ".gsm-hoshidicts-kanji-back"
              : ".gsm-hoshidicts-popup-close",
            existing
          );
        }
      }
      return pending?.promise;
    }
    pruneLevels(level.depth + 2, false);
    const child = existing ?? createLevelState(level.depth + 1);
    if (!existing) {
      levels.push(child);
      buildLevelUi(child);
    }
    child.primaryReading = primaryReading;
    child.focusLinkedBack = focusChild;
    child.activeCandidate = candidate;
    child.activeSignature = candidateSignature(candidate);
    const promise = runLookup(candidate, {
      primaryReading,
      selectedDictionaryTab: source === "link" ? null : level.currentViewRequest?.selectedDictionaryTab,
    }, child);
    const record = { promise, token: child.lookupToken };
    child[pendingKey] = record;
    void promise.finally(() => {
      if (child[pendingKey] === record) {
        child[pendingKey] = null;
      }
    });
    return promise;
  }

  function onInternalLink({ anchor, focusChild = false, primaryReading = "", query }, level = rootLevel) {
    if (!anchor?.isConnected || !query) {
      return;
    }
    // Link text is an anchor/highlight, never the query's page-scan offsets,
    // and the whole of it is the match, so it is its own sentence.
    const candidate = withSentence({
      anchor, linkAnchor: true, query, sourceElements: [anchor], sourceDepth: level.depth, vertical: false,
    }, 0, (anchor.textContent || "").length, new Map());
    return openChildLookup(candidate, level, {
      focusChild,
      primaryReading,
      source: "link",
    });
  }

  async function executeKanjiRequest(request, level = rootLevel, replayOptions = null) {
    audio?.retire(level);
    mining?.retire(level);
    const { candidate, capability, character } = request;
    const group = capability?.kind === "group";
    const token = (level.lookupToken += 1);
    level.retainedView = replayOptions?.preserveViewControls === true;
    level.view?.hideImagePreview();
    // Every selected source is asked at once. A term-only selection defers the
    // native fallback until its members miss.
    const wantsNative = group ? capability.members.some((member) => member.kind === "kanji") : capability?.kind !== "term";
    let reply, termReplies;
    try {
      [reply, ...termReplies] = await Promise.all([
        wantsNative ? sendRequest("hd_kanji", request.kanjiPayload) : null,
        ...request.termPayloads.map((payload) => sendRequest("hd_lookup_dictionary", payload)),
      ]);
    } catch (error) {
      return handleLookupFailure(token, error, level, request, true);
    }
    if (!requestCanRender(token, candidate, level) || level.popup.hidden) {
      return false;
    }
    for (const each of [reply, ...termReplies]) if (each) noteGeneration(each.generation, level);
    let results = [];
    if (group) {
      results = mergeKanjiGroupResults(capability.members, character, reply, termReplies);
    } else if (capability?.kind === "term") {
      results = projectResultsToDictionary(Array.isArray(termReplies[0].results) ? termReplies[0].results : [], capability.title);
    }
    if (results.length > 0) {
      return renderTerms(
        results,
        candidate,
        request.highlightText,
        {
          ...backRenderOptions(request, level),
          ...(group ? { dictionaryTabScope: capability.members.map((member) => member.title) } : {}),
        },
        request,
        level,
        replayOptions,
      );
    }
    if (reply === null) {
      try {
        reply = await sendRequest("hd_kanji", request.kanjiPayload);
      } catch (error) {
        return handleLookupFailure(token, error, level, request, true);
      }
      if (!requestCanRender(token, candidate, level) || level.popup.hidden) {
        return false;
      }
      noteGeneration(reply.generation, level);
    }
    const kanji = reply.kanji;
    const validEntries = nativeKanjiEntries(reply);
    if (!kanji || validEntries.length === 0) {
      return handleLookupFailure(token, new Error("kanji lookup returned no usable result"), level, request, true);
    }
    const selectedEntries = capability?.kind === "kanji"
      ? validEntries.filter((entry) => entry.dictionary === capability.title)
      : validEntries;
    const entries = selectedEntries.length > 0 ? selectedEntries : validEntries;
    clearDefinitionBlurTimer(level);
    level.currentViewRequest = request;
    level.deferredRefresh = null;
    level.deferredDictionaryInvalidationRevision = -1;
    level.retainedView = false;
    pruneLevels(level.depth + 1);
    try {
      level.view.renderKanji({ ...kanji, entries }, candidate, {
        ...renderContextFor(level),
        isCurrentRequest: () => !disposed && !level.retired && token === level.lookupToken,
        isCurrentView: () => !disposed && !level.retired && level.currentViewRequest === request
          && (token === level.lookupToken || level.retainedView),
        onRenderError(error) { handleLookupFailure(token, error, level); },
        ...dictionarySelectionContext(request),
        highlightText: request.highlightText,
        ...backRenderOptions(request, level),
        ...replayOptions,
      });
    } catch (error) {
      console.warn("hachidori: could not render kanji", error);
      return handleLookupFailure(token, error, level, request, true);
    }
    ensureDictionaryStyles(currentGeneration);
    positionPopup(level);
    if (!replayOptions?.preserveViewControls) focusPopupControl(".gsm-hoshidicts-kanji-back", level);
    return true;
  }

  function showKanji(character, _result, _candidate, sourceLink, level = rootLevel) {
    if (!level.activeCandidate || typeof character !== "string" || !character) {
      return;
    }
    const capability = selectedKanjiDictionaryCapability();
    const termSources = capability?.kind === "group"
      ? capability.members.filter((member) => member.kind === "term")
      : capability?.kind === "term" ? [capability] : [];
    return executeKanjiRequest({
      candidate: level.activeCandidate,
      capability,
      character,
      highlightText: level.activeHighlightText || character,
      kanjiPayload: { character },
      kind: "kanji",
      previous: level.activeTermRender && {
        ...level.activeTermRender,
        viewport: level.view.captureTermView?.(),
      },
      returnFocus: kanjiLinkFocusTarget(sourceLink, character, level),
      selectedDictionaryTab: normalizedDictionaryTab(level.currentViewRequest?.selectedDictionaryTab),
      termPayloads: termSources.map((source) => ({
        dictionary: source.title,
        maxResults: options.maxResults,
        options: {
          frequencyDictionary: options.frequencyDictionary,
          frequencyOrder: options.frequencyOrder,
          personalDictionary: options.personalDictionaryEnabled,
          primaryReading: "",
        },
        scanLength: 1,
        text: character,
      })),
    }, level);
  }

  function executeViewRequest(request, level = rootLevel, replayOptions = null) {
    return request.kind === "kanji"
      ? executeKanjiRequest(request, level, replayOptions)
      : executeTermRequest(request, level, replayOptions);
  }

  function replayVisibleView(level, intent) {
    const request = level.currentViewRequest;
    const pending = level.pendingViewReplay;
    if (pending?.request === request && pending.token === level.lookupToken) {
      pending.options.expandAll = intent?.expandAll === true;
      return;
    }
    const replayOptions = { preserveViewControls: true, expandAll: intent?.expandAll === true };
    const operation = executeViewRequest(request, level, replayOptions);
    const replay = { request, token: level.lookupToken, options: replayOptions };
    level.pendingViewReplay = replay;
    void operation.finally(() => {
      if (level.pendingViewReplay === replay) level.pendingViewReplay = null;
    });
  }

  async function appendCustomEntry(entry, level = rootLevel) {
    const expectedView = level.currentViewRequest;
    level.pendingCustomAppends += 1;
    try {
      const reply = await sendRequest("hd_custom_append", { entry });
      const adoption = adoptDictionaryState(reply.state);
      if (adoption.dictionaryChanged) invalidateStoredState(true);
      else if (adoption.presentationChanged) updateDictionaryPresentation();
      if (
        expectedView !== null
        && !level.retired
        && level.currentViewRequest === expectedView
        && level.popup && !level.popup.hidden
        && sourceRetained(expectedView.candidate, level)
      ) {
        level.deferredRefresh = expectedView;
      }
      return reply;
    } finally {
      level.pendingCustomAppends -= 1;
      flushDeferredNotes();
      flushDictionaryPresentation();
    }
  }

  function flushDeferredNotes() {
    for (const level of levels) {
      if (level.pendingCustomAppends > 0 || hasProtectedNote(level.depth + 1)) continue;
      const request = level.deferredRefresh;
      if (request && request === level.currentViewRequest && !level.popup.hidden
          && sourceRetained(request.candidate, level)) {
        level.deferredRefresh = null;
        level.deferredDictionaryInvalidationRevision = -1;
        // The append has committed. Replay failures must never invite a second
        // append, and a protected descendant must keep its source DOM alive.
        void executeViewRequest(request, level).catch((error) => {
          console.debug("hachidori: Note saved but the lookup could not refresh", error);
        });
        return;
      }
      if (!level.noteEditing && level.deferredDictionaryInvalidationRevision >= 0) {
        hide(level);
        return;
      }
    }
  }

  function clearScanTimer() {
    if (scanTimer !== null) {
      window.clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function discardPendingCandidate() {
    if (pendingCandidateLookup?.candidate === activeSelectionCandidate) activeSelectionCandidate = null;
    pendingCandidateLookup = null;
  }

  function cancelScanDwell() {
    if (scanDwell !== null) window.clearTimeout(scanDwell.timer);
    scanDwell = null;
  }

  // A move inside the popup keeps the dwell on a word in its definitions: that
  // pane's own mousemove follows and decides what the pointer rests on.
  function cancelCandidateScan(insidePopup = false) {
    clearScanTimer();
    if (!insidePopup || scanDwell?.level === null) cancelScanDwell();
    if (rootLevel.popup?.inert) {
      hide();
      return;
    }
    // Retaining a rendered popup during transfer must not invalidate its media
    // or deferred glossary. Only an unfinished candidate loses ownership.
    if (pendingCandidateLookup?.token === rootLevel.lookupToken) rootLevel.lookupToken += 1;
    discardPendingCandidate();
    retireFieldImposter();
  }

  function cancelPendingHover(level) {
    // A dwell is a hover child that has not been asked for yet.
    cancelScanDwell();
    const child = levels[level.depth + 1];
    if (
      !child ||
      child.pendingHover?.token !== child.lookupToken ||
      (!child.popup?.hidden && !child.popup?.inert)
    ) {
      return;
    }
    pruneLevels(child.depth, false);
  }

  function lookupCandidate(candidate, signature = candidateSignature(candidate)) {
    clearCursorExitTimer();
    const lookup = runLookup(candidate);
    const pending = { token: rootLevel.lookupToken, candidate, signature };
    pendingCandidateLookup = pending;
    void lookup.finally(() => {
      if (pendingCandidateLookup === pending) pendingCandidateLookup = null;
      syncHostAttention();
    });
  }

  function activationAllowed() {
    return options.lookupMode === "hover" || activationPressed;
  }

  // Words in a popup's definitions follow lookupMode unless Reading →
  // Activation → Child popups asks for the key or a click instead.
  function definitionKeyGated() {
    return options.definitionLookupMode === "activation"
      || (options.definitionLookupMode === "inherit" && options.lookupMode !== "hover");
  }

  function definitionHoverAllowed() {
    return options.definitionLookupMode !== "click" && (!definitionKeyGated() || activationPressed);
  }

  // Reading → Activation → Hover scan delay and Definition hover delay. Only a
  // lookup that needs no key waits: a held key or button, a click, a link or
  // a selection is deliberate. Definitions follow the page unless set.
  function hoverScanDelay(level) {
    if (level === null) return options.lookupMode === "hover" ? options.scanDelayMs : 0;
    return definitionKeyGated() ? 0 : options.definitionScanDelayMs ?? options.scanDelayMs;
  }

  // Whether the word under the pointer, on the page (level null) or in a
  // pane's definitions, may be looked up now. Otherwise its dwell starts, or
  // runs on when it is already this word's, so moving within the word never
  // postpones it. On expiry the pointer is scanned again and the word is looked
  // up only if it is still the one there; a word that changed under a resting
  // pointer waits for the pointer to move.
  function dwellElapsed(candidate, level, signature = candidateSignature(candidate)) {
    const dwell = scanDwell;
    const same = dwell?.level === level && dwell.signature === signature
      && sameAnchorNode(candidate, dwell.candidate);
    if (same && dwell.timer !== null) return false;
    cancelScanDwell();
    if (same) return true;
    if (dwell?.timer === null) return false;
    const delay = hoverScanDelay(level);
    if (delay === 0) return true;
    // The pointer has left any word that is still loading.
    if (level === null) cancelCandidateScan();
    else cancelPendingHover(level);
    const next = { level, candidate, signature, timer: null };
    next.timer = window.setTimeout(() => {
      next.timer = null;
      if (lastPointer) scanPointer(lastPointer);
      if (scanDwell === next) cancelScanDwell();
    }, delay);
    scanDwell = next;
    return false;
  }

  // The configured activation input when it is a mouse button that something
  // waits for: page lookups outside Hover mode, or child popups set to hold it.
  // Otherwise a press keeps its ordinary meaning.
  function activationButton() {
    if (options.lookupMode === "hover" && !definitionKeyGated()) return null;
    return ACTIVATION_BUTTONS.get(options.activationKey) ?? null;
  }

  // Yomitan's default: once shown, the popup outlives the activation key and
  // the pointer's wanderings; only an explicit dismissal or a new lookup ends it.
  function schedulePointerHide() {
    if (options.lookupMode !== "activationSticky") scheduleHide();
  }

  function updateModifierState(event) {
    const property = MODIFIER_PROPERTIES.get(options.activationKey);
    if (property) activationPressed = event[property] === true;
    // Every mouse event reports the held buttons, so a release the page never
    // saw ends a button's activation at the next move.
    const button = ACTIVATION_BUTTONS.get(options.activationKey);
    if (button && typeof event.buttons === "number") {
      const held = (event.buttons & button.flag) !== 0;
      if (held !== activationPressed) {
        activationPressed = held;
        syncHostAttention();
      }
    }
  }

  // Pressing the activation input while the pointer is stationary reveals the
  // word under it without asking the reader to jiggle the mouse.
  function scanActivatedPointer() {
    const popupLevel = activePointerLevel(lastPointer);
    const keyGated = popupLevel ? definitionKeyGated() : options.lookupMode !== "hover";
    if (keyGated && lastPointer && !hasProtectedNote() && !focusBlocksScan(popupLevel)
        && (!pointerInPopup || popupLevel)
        && !selectionDragActive
        && (popupLevel || !retainSelectedLookup())) {
      scheduleScan();
    }
  }

  // Releasing it closes an `activation` popup after the hide delay;
  // `activationSticky` keeps the popup.
  function releaseActivation() {
    if (options.lookupMode !== "activation" || activationPressed || selectionIsUnchanged()) return;
    cancelCandidateScan();
    scheduleHide();
  }

  function pointInsidePopup(clientX, clientY) {
    if (!rootLevel.popup || rootLevel.popup.hidden) return false;
    let previous = null;
    for (const level of levels) {
      if (!level.popup || level.popup.hidden) continue;
      const rect = level.popup.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right
          && clientY >= rect.top && clientY <= rect.bottom) return true;
      if (previous) {
        const left = previous.right <= rect.left ? previous.right : rect.right;
        const right = previous.right <= rect.left ? rect.left : previous.left;
        if (left <= right && clientX >= left - 2 && clientX <= right + 2
            && clientY >= Math.max(previous.top, rect.top) - 4
            && clientY <= Math.min(previous.bottom, rect.bottom) + 4) return true;
      }
      previous = rect;
    }
    return false;
  }

  function activePointerLevel(pointer) {
    const level = pointer?.level;
    return level &&
      !level.retired &&
      levels[level.depth] === level &&
      level.popup?.contains(pointer.target)
      ? level
      : null;
  }

  function popupLinkAt(target, level) {
    const element = target?.nodeType === Node.ELEMENT_NODE
      ? target
      : target?.parentElement;
    const link = element?.closest?.("a");
    return link && level.popup.contains(link) ? link : null;
  }

  function scanDefinitionPointer(pointer, level) {
    pointerInPopup = true;
    pointerLevel = level;
    clearHideTimer();
    // Reaching for a pronunciation choice opens no child popups.
    if (audio?.hasMenu()) {
      cancelPendingHover(level);
      return;
    }
    const link = popupLinkAt(pointer.target, level);
    if (link) {
      cancelPendingHover(level);
      if (link.hasAttribute("data-hoshidicts-query")) clearDescendantTimer();
      else scheduleDescendantPrune(level);
      return;
    }
    if (!definitionHoverAllowed() || level.depth >= options.popupNestingMaxDepth) {
      cancelPendingHover(level);
      scheduleDescendantPrune(level);
      return;
    }
    const candidate = resolveDefinitionCandidate(
      pointer.clientX,
      pointer.clientY,
      level
    );
    if (!candidate) {
      cancelPendingHover(level);
      scheduleDescendantPrune(level);
      return;
    }
    clearDescendantTimer();
    // A word whose child is already open or loading needs no dwell.
    if (sameChildLookup(levels[level.depth + 1], candidate, "")) cancelScanDwell();
    else if (!dwellElapsed(candidate, level)) return;
    openChildLookup(candidate, level);
  }

  function scanPointer(pointer) {
    if (disposed || !extensionAlive()) {
      teardown("context-invalidated");
      return;
    }
    retireFieldImposter();
    if (!options.hoverEnabled) return;
    if (transferTimer !== null) return;
    const popupLevel = activePointerLevel(pointer);
    if (hasProtectedNote() || focusBlocksScan(popupLevel)) {
      cancelCandidateScan();
      if (popupLevel) cancelPendingHover(popupLevel);
      clearHideTimer();
      return;
    }
    if (popupLevel) {
      scanDefinitionPointer(pointer, popupLevel);
      return;
    }
    if (selectionDragActive || retainSelectedLookup()) return;
    pointerInPopup = isOurNode(pointer.target) ||
      pointInsidePopup(pointer.clientX, pointer.clientY);
    if (pointerInPopup) {
      cancelCandidateScan();
      clearHideTimer();
      return;
    }
    // A live selection outranks the pointer only while the personal dictionary
    // owns automatic selection lookups.
    const selection = options.personalDictionaryEnabled ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) {
      if (!activationAllowed()) {
        cancelCandidateScan();
        schedulePointerHide();
        return;
      }
      const selected = resolveSelectedLookupCandidate(selection);
      if (selected) startSelectionLookup(selected);
      else {
        cancelCandidateScan();
        scheduleHide();
      }
      return;
    }
    if (!activationAllowed()) {
      cancelCandidateScan();
      schedulePointerHide();
      return;
    }
    const candidate = resolveCandidate(pointer.clientX, pointer.clientY);
    if (!candidate) {
      cancelCandidateScan();
      schedulePointerHide();
      return;
    }
    const signature = candidateSignature(candidate);
    // Scanning the popup's own word again, pending or shown, keeps the popup
    // and cancels its cursor-exit hide, and ends a dwell on any other word.
    if (pendingCandidateLookup?.token === rootLevel.lookupToken
        && pendingCandidateLookup.signature === signature
        && sameAnchorNode(candidate, pendingCandidateLookup.candidate)) {
      cancelScanDwell();
      clearHideTimer();
      clearCursorExitTimer();
      return;
    }
    if (
      rootLevel.popup && !rootLevel.popup.hidden && !rootLevel.popup.inert &&
      rootLevel.activeSignature === signature &&
      sameAnchorNode(candidate, rootLevel.activeCandidate)
    ) {
      cancelScanDwell();
      clearHideTimer();
      clearCursorExitTimer();
      return;
    }
    clearHideTimer();
    if (!dwellElapsed(candidate, null, signature)) return;
    lookupCandidate(candidate, signature);
  }

  function onPopupMouseMove(event, level) {
    if (gsmBridge?.navigationActive) return; // GSM hook
    if (popupResize) return;
    if (disposed || !options.hoverEnabled || level.retired) {
      return;
    }
    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      level,
      target: event.target,
    };
    updateModifierState(event);
    pointerInPopup = true;
    pointerLevel = level;
    clearTransferTimer();
    clearHideTimer();
    if (hasProtectedNote() || focusBlocksScan(level)) {
      cancelPendingHover(level);
      clearScanTimer();
      return;
    }
    const link = popupLinkAt(event.target, level);
    if (link) {
      cancelPendingHover(level);
      clearScanTimer();
      if (link.hasAttribute("data-hoshidicts-query")) clearDescendantTimer();
      else scheduleDescendantPrune(level);
      return;
    }
    if (selectionDragActive || !definitionHoverAllowed()) {
      cancelPendingHover(level);
      clearScanTimer();
      return;
    }
    scheduleScan();
  }

  function onMouseMove(event) {
    if (gsmBridge?.navigationActive) return; // GSM hook
    if (popupResize) return;
    if (disposed || !options.hoverEnabled) {
      return;
    }
    editedSincePointerMoved = false;
    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    };
    updateModifierState(event);
    // A release the page never saw, such as one outside the window, ends the
    // drag on the next move.
    if (selectionDragActive && (event.buttons & 1) === 0) finishSelectionDrag({ dismissClick: false });
    if (dragSelection) {
      extendGlyphDrag(event);
      return;
    }
    // Cancel a pending dismissal here rather than waiting for the scheduled
    // scan. The retargeted event target is enough; the rect test costs a
    // layout and can wait for the scan.
    if (isOurNode(event.target)) {
      pointerInPopup = true;
      clearTransferTimer();
      cancelCandidateScan(true);
      clearHideTimer();
      return;
    }
    const leavingChain = pointerInPopup && levels.length > 1;
    pointerInPopup = false;
    pointerLevel = null;
    if (leavingChain) scheduleTransferCheck();
    if (hasProtectedNote() || popupHasFocus()) {
      cancelCandidateScan();
      return;
    }
    if (selectionDragActive) return;
    if (activeSelectionCandidate) {
      clearHideTimer();
      scheduleScan();
      return;
    }
    if (!activationAllowed()) {
      cancelCandidateScan();
      schedulePointerHide();
      return;
    }
    scheduleScan();
  }

  function scheduleScan() {
    if (scanTimer !== null) {
      return;
    }
    // Coalesce the moves of one task into a scan at the pointer's latest position.
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      if (lastPointer) {
        scanPointer(lastPointer);
      }
    }, 0);
  }

  const GLYPH_DRAG_START_PX = 3;

  // In an overlay the browser's own drag cannot be trusted: Chromium loses the
  // anchor when the press lands after a boxed glyph, and the selection ends as
  // the glyph under the pointer or nothing. The reader selects whole glyphs from
  // the pressed one to the pointer's instead, and the prevented mousedown keeps
  // the browser's selection out of it.
  function startGlyphDrag(event) {
    const anchor = glyphAtPoint(event.clientX, event.clientY);
    if (!anchor) return null;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    return { anchor, focus: null, x: event.clientX, y: event.clientY };
  }

  function extendGlyphDrag(event) {
    // A press that does not travel is a click, not a one-glyph selection.
    if (!dragSelection.focus
        && Math.hypot(event.clientX - dragSelection.x, event.clientY - dragSelection.y) < GLYPH_DRAG_START_PX) return;
    // A gap between boxes keeps the last glyph, as does the popup itself.
    const focus = glyphAtPoint(event.clientX, event.clientY) ?? dragSelection.focus;
    if (!focus) return;
    dragSelection.focus = focus;
    const { anchor } = dragSelection;
    const forward = anchor.node === focus.node
      ? anchor.start <= focus.start
      : Boolean(anchor.node.compareDocumentPosition(focus.node) & Node.DOCUMENT_POSITION_FOLLOWING);
    try {
      const selection = window.getSelection();
      if (forward) selection.setBaseAndExtent(anchor.node, anchor.start, focus.node, focus.end);
      else selection.setBaseAndExtent(anchor.node, anchor.end, focus.node, focus.start);
    } catch {
      // The page replaced a glyph mid-drag; the next move selects afresh.
    }
  }

  function onMouseDown(event) {
    if (disposed) {
      return;
    }
    editedSincePointerMoved = true;
    // A press decides afresh what its own release and click may do.
    if (scanPress?.button === event.button) scanPress = null;
    const button = activationButton();
    if (button && options.hoverEnabled && event.button === button.button && startButtonScan(event)) return;
    if (isOurNode(event.target) || pointInsidePopup(event.clientX, event.clientY)) return;
    updateModifierState(event);
    if (event.button === 0 && options.hoverEnabled
        && isScannableElement(selectionBoundaryElement(event.target), new Map())) {
      // A press on text may start a selection, so the popup stays until release
      // decides, and the host hears now that the reader needs the window.
      cancelCandidateScan();
      clearHideTimer();
      activeSelectionCandidate = null;
      setSelectionDrag(true);
      if (overlayMode) dragSelection = startGlyphDrag(event);
      return;
    }
    hide();
  }

  // The scan button works like the activation key: pressing it looks up the
  // word under the pointer, and moving while it is held keeps scanning. Its
  // capture-phase press claims an overlay host's window before the host's own
  // listener can turn click-through back on. A popup link's press is the
  // link's, so its middle click keeps opening it.
  function startButtonScan(event) {
    const { clientX, clientY } = event;
    const inPopup = isOurNode(event.target) || pointInsidePopup(clientX, clientY);
    // Hover mode's page lookups wait for nothing; only child popups can.
    if (!inPopup && options.lookupMode === "hover") return false;
    // The popup is a closed shadow root: its own mousemove recorded the real
    // target and level under the pointer.
    if (!inPopup) lastPointer = { clientX, clientY, target: event.target };
    const level = inPopup ? activePointerLevel(lastPointer) : null;
    // Child popups set to Click wait for no button.
    if (level && (popupLinkAt(lastPointer.target, level) || !definitionKeyGated())) return false;
    const { claimed, cancelRelease, candidate } = scanPressClaim(event, inPopup, level);
    if (claimed) event.preventDefault();
    scanPress = { button: event.button, cancelRelease, cancelClick: Boolean(candidate) };
    activationPressed = true;
    syncHostAttention();
    scanActivatedPointer();
    return true;
  }

  // Over content the reader scans, a scan press starts no autoscroll and Back
  // or Forward does not navigate; the click opens no new tab only when the
  // press was on a word the reader looks up. A text field keeps its press, so
  // it still pastes or navigates, unless the press is on a word in it.
  function scanPressClaim({ button, clientX, clientY, target }, inPopup, level) {
    if (scannableField(inPopup ? null : target)) {
      const candidate = resolveCandidate(clientX, clientY);
      return { claimed: Boolean(candidate), cancelRelease: Boolean(candidate), candidate };
    }
    const claimed = level
      ? Boolean(selectionBoundaryElement(lastPointer.target)?.closest(DEFINITION_TEXT_SELECTOR))
      : !inPopup && isScannableElement(selectionBoundaryElement(target), new Map());
    const candidate = claimed
      && (level ? resolveDefinitionCandidate(clientX, clientY, level) : resolveCandidate(clientX, clientY));
    return { claimed, cancelRelease: claimed && NAVIGATION_BUTTONS.has(button), candidate };
  }

  // Release decides what the press was: a selection looks up that text, a
  // plain click dismisses. The drag's claim on the host window carries over to
  // the lookup it starts.
  function finishSelectionDrag({ dismissClick }) {
    hostAttentionHold += 1;
    try {
      setSelectionDrag(false);
      const token = rootLevel.lookupToken;
      onSelectionChange();
      if (dismissClick && rootLevel.lookupToken === token) hide();
    } finally {
      hostAttentionHold -= 1;
      syncHostAttention();
    }
  }

  function selectionIsUnchanged(candidate = activeSelectionCandidate) {
    if (!candidate) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const previous = candidate.selectionRange ?? candidate.anchorRange;
    return range.startContainer === previous.startContainer && range.startOffset === previous.startOffset
      && range.endContainer === previous.endContainer && range.endOffset === previous.endOffset
      && selection.toString() === (candidate.selectionText ?? candidate.query);
  }

  function startSelectionLookup(candidate) {
    hostAttentionHold += 1;
    try {
      hide();
      activeSelectionCandidate = candidate;
      lookupCandidate(candidate);
    } finally {
      hostAttentionHold -= 1;
      syncHostAttention();
    }
  }

  function retainSelectedLookup() {
    if (!activeSelectionCandidate) return false;
    if (!selectionIsUnchanged()) onSelectionChange();
    if (!activeSelectionCandidate) return false;
    clearHideTimer();
    return true;
  }

  function onSelectionChange() {
    if (disposed || !options.hoverEnabled || selectionDragActive || hasProtectedNote()
        || popupHasFocus() || pageEditorFocused() || selectionIsUnchanged()) return;
    const selection = window.getSelection();
    if ([selection?.anchorNode, selection?.focusNode].some((node) =>
      node && (node === host || node.getRootNode() === shadow))) return;
    // Automatic selection lookups are the personal dictionary's entry point.
    // Off, as in Yomitan, a changed selection only releases one a keybind scanned.
    if (!options.personalDictionaryEnabled) {
      if (activeSelectionCandidate) hide();
      return;
    }
    const candidate = resolveSelectedLookupCandidate(selection);
    if (!candidate && !activeSelectionCandidate) return;
    if (candidate && !activationAllowed()) hide();
    else if (candidate) startSelectionLookup(candidate);
    else hide();
  }

  function onMouseUp(event) {
    if (disposed) return;
    const button = activationButton();
    if (button && event.button === button.button) {
      if (scanPress?.button === event.button && scanPress.cancelRelease) event.preventDefault();
      updateModifierState(event);
      releaseActivation();
      return;
    }
    if (event.button !== 0 || !selectionDragActive) return;
    updateModifierState(event);
    finishSelectionDrag({ dismissClick: true });
  }

  // A middle click on a word the scan press looked up opens no new tab.
  function onAuxClick(event) {
    if (scanPress?.button !== event.button) return;
    if (scanPress.cancelClick) event.preventDefault();
    scanPress = null;
  }

  function onPageFocusIn() {
    if (!disposed && pageEditorFocused()) {
      cancelCandidateScan();
      activationPressed = false;
      activationCode = null;
      syncHostAttention();
    }
  }

  // Close keeps the reader's Escape order: an audio menu, then theme actions, then a Note form,
  // then the focused or deepest popup, then a pending or waiting lookup. Nothing closed
  // leaves the key to activation.
  function closeFromKeybind(event) {
    if (audio?.closeMenu()) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (rootLevel.popup && !rootLevel.popup.hidden) {
      const focused = levels.find((level) => level.popup.contains(shadow.activeElement));
      const menuOwner = focused || levels.at(-1);
      if (!menuOwner.popup.inert && menuOwner.view?.closeActionMenu?.() === true) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      const editing = focused?.noteEditing ? focused : levels.findLast((level) => level.noteEditing);
      const noteOwner = editing || focused || levels.at(-1);
      if (!noteOwner.popup.inert && noteOwner.view?.closeNoteForm?.() === true) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      event.stopPropagation();
      cancelScanDwell();
      hide(focused || levels.at(-1));
      return true;
    }
    const dismissedCandidate = pendingCandidateLookup !== null || activeSelectionCandidate !== null || scanDwell !== null;
    hide();
    return dismissedCandidate;
  }

  // Yomitan leaves unmodified character keys to a focused text field.
  function textFieldFocused() {
    let focused = document.activeElement;
    while (focused) {
      if (focused.isContentEditable || ["input", "select", "textarea"].includes(focused.localName)) return true;
      focused = focused === host ? shadow.activeElement : focused.shadowRoot?.activeElement;
    }
    return false;
  }

  function clickKeybindControl(control) {
    if (!control?.isConnected || control.hidden || control.disabled) return false;
    control.click();
    return true;
  }

  function scanSelectedText() {
    if (disposed || !options.hoverEnabled) return false;
    const candidate = resolveSelectedLookupCandidate();
    if (!candidate) return false;
    startSelectionLookup(candidate);
    return true;
  }

  function runKeybindAction({ action, argument }, event,
    level = levels.findLast((item) => item.popup && !item.popup.hidden)) {
    if (action === "close") return closeFromKeybind(event);
    if (action === "scanSelectedText" || action === "scanTextAtSelection") {
      if (!options.hoverEnabled) return false;
      if (action === "scanSelectedText") return scanSelectedText();
      const candidate = resolveSelectionScanCandidate();
      if (!candidate) return false;
      startSelectionLookup(candidate);
      return true;
    }
    if (action === "toggleOption") {
      if (!argument || optionsStorageRevision < 0) return false;
      // A conflicting write changes nothing; the storage event carries the result.
      void sendRequest("hd_options_write", { baseRevision: optionsStorageRevision,
        options: { [argument]: !options[argument] } }, WORKER_TARGET).catch(() => {});
      return true;
    }
    if (action === "toggleWordHighlights") {
      if (!options.hoverEnabled || !options.wordHighlightEnabled) return false;
      wordHighlightsHidden = !wordHighlightsHidden;
      syncWordHighlights();
      return true;
    }
    if (!level?.view || level.popup.inert) return false;
    const entry = level.view.currentEntryIndex();
    switch (action) {
      case "nextEntry":
      case "previousEntry":
        return level.view.focusEntry({ offset: (action === "nextEntry" ? 1 : -1) * Number(argument) });
      case "firstEntry":
      case "lastEntry":
        return level.view.focusEntry(action === "firstEntry" ? "first" : "last");
      case "nextEntryDifferentDictionary":
      case "previousEntryDifferentDictionary":
        return level.view.focusEntry({ dictionary: action === "nextEntryDifferentDictionary" ? 1 : -1 });
      case "historyBackward":
        return clickKeybindControl(level.popup.querySelector(".gsm-hoshidicts-kanji-back"));
      case "addNote":
      case "viewNotes": {
        // The entry's own button: the lookup row may also hold a shown result's row.
        const state = action === "addNote" ? "add" : "view";
        return clickKeybindControl([...(level.entryMining?.[entry]?.actions.children ?? [])]
          .find(child => child.matches(`.gsm-hoshidicts-mine-button[data-action="${state}"]`)));
      }
      case "playAudio":
      case "playAudioFromSource": {
        const button = level.entryAudio?.[entry]?.button;
        if (!button || (action === "playAudioFromSource" && !argument)) return false;
        return audio.playButton(button, action === "playAudioFromSource" ? argument : "");
      }
      case "markWordKnown":
      case "ignoreWord":
        return wordStatusActions.press(level, entry, action === "markWordKnown" ? "known" : "ignored");
      default:
        return false;
    }
  }

  // A browser shortcut runs its keybind action here; entry moves go one entry.
  function onReaderCommand(message) {
    if (disposed || message?.target !== READER_TARGET || message.type !== "hd_reader_command") return false;
    runKeybindAction({ action: message.action, argument: ["nextEntry", "previousEntry"].includes(message.action) ? "1" : "" },
      { preventDefault() {}, stopPropagation() {} });
    return false;
  }

  // After Yomitan's HotkeyHandler: the physical key and the exact modifier set
  // select enabled keybinds whose scope applies; the first handled one wins.
  // A wheel step passes its own key and the popup it is over.
  function runKeybinds(event, level, key = KEYBIND_MODIFIER_CODES.has(event.code) ? null : event.code) {
    const modifiers = keybindModifiers(event);
    // A pending lookup counts as its popup: Escape has always cancelled one,
    // as it does one still waiting for the pointer to rest.
    const popupScope = Boolean(rootLevel.popup && !rootLevel.popup.hidden)
      || pendingCandidateLookup !== null || activeSelectionCandidate !== null || scanDwell !== null;
    const characterInput = (modifiers.length === 0 || modifiers.join() === "shift")
      && (event.key?.length === 1 || event.key === "Process");
    for (const bind of options.keybinds) {
      if (!bind.enabled || bind.action === "" || (bind.key === null && bind.modifiers.length === 0)
          || bind.key !== key || bind.modifiers.join() !== modifiers.join()
          || !(bind.scopes.includes("web") || (popupScope && bind.scopes.includes("popup")))
          || (characterInput && textFieldFocused())) continue;
      if (runKeybindAction(bind, event, level) === false) continue;
      if (bind.action !== "close") event.preventDefault();
      return true;
    }
    return false;
  }

  function onKeyDown(event) {
    if (gsmBridge?.navigationActive) return; // GSM hook
    if (disposed || event.repeat || runKeybinds(event)) {
      return;
    }
    if (!options.hoverEnabled) return;
    // Autofocused search fields (such as Jisho's) must not disable lookups on
    // the rest of the page. Modifier activation leaves native typing intact;
    // printable/editor keys stay reserved for the focused field.
    if (pageEditorFocused() && !MODIFIER_PROPERTIES.has(options.activationKey)) return;
    const wasPressed = activationPressed;
    updateModifierState(event);
    if (normaliseActivationKey(event.key, null) === options.activationKey) {
      activationPressed = true;
      activationCode = event.code;
    } else {
      editedSincePointerMoved = true;
    }
    if (!wasPressed && activationPressed && !typingUnderPointer()) scanActivatedPointer();
  }

  // Shift for a capital letter in the field under a resting pointer must not
  // cover the field with its own text; moving with the key held still scans.
  function typingUnderPointer() {
    return editedSincePointerMoved && scannableField(document.activeElement) === lastPointer?.target;
  }

  function onKeyUp(event) {
    if (gsmBridge?.navigationActive) return; // GSM hook
    if (disposed) return;
    updateModifierState(event);
    if (!MODIFIER_PROPERTIES.has(options.activationKey)
        && (event.code === activationCode || normaliseActivationKey(event.key, null) === options.activationKey)) {
      activationPressed = false;
    }
    if (!activationPressed) activationCode = null;
    releaseActivation();
  }

  function onMouseOut(event) {
    if (gsmBridge?.navigationActive) return; // GSM hook
    if (popupResize) return;
    // A null relatedTarget on a document-level mouseout means the pointer left
    // the window entirely, which mouseleave cannot report from here: it does not
    // bubble, and a capture listener would fire for every element left.
    if (!disposed && event.relatedTarget === null) {
      lastPointer = null;
      cancelCandidateScan();
      // As in Yomitan's TextScanner, leaving the window only forgets the
      // pointer, whether on the way to the tab strip or another window (#432)
      // or as an overlay host turns click-through on past OCR text (#403). The
      // popup follows the ordinary hover and cursor-exit rules at the next move.
      if (!overlayMode) pointerInPopup = false;
    }
  }

  function onWindowBlur() {
    if (gsmBridge?.navigationActive) return; // GSM hook
    stopPopupResize();
    if (!disposed && overlayMode) {
      // An overlay host moves focus between itself and the game while the
      // reader stays in the page (#403), so blur dismisses nothing and keeps a
      // drag or a held scan button. Only a key's release can go missing.
      if (!ACTIVATION_BUTTONS.has(options.activationKey)) {
        activationPressed = false;
        activationCode = null;
      }
      return;
    }
    if (!disposed) {
      // Cleared first, so the drag's sync also releases a held scan button's claim.
      activationPressed = false;
      activationCode = null;
      setSelectionDrag(false);
      lastPointer = null;
      pointerInPopup = false;
      // Focus that moved into one of this page's frames is a click outside the
      // popup. Leaving the tab, the window or the browser is not: Yomitan has
      // no blur listener, so the popup, its children and a Note draft wait for
      // the reader's return (#432). Only unfinished pointer work is cancelled.
      if (document.hasFocus()) hide();
      else cancelCandidateScan();
    }
  }

  function onPageHide() {
    stopPopupResize();
    sessionPopupSize = null;
    // Navigation can destroy the content owner without blurring the tab.
    // Retire while runtime messaging is alive; a BFCache return can reuse UI.
    audio?.retire();
    mining?.retire();
    for (const level of levels) clearDefinitionBlurTimer(level);
  }

  function onPageShow(event) {
    if (!event.persisted) return;
    positionPopup();
    // The absolute deadline kept running while the page was cached.
    for (const level of levels) {
      const request = level.currentViewRequest;
      if (request?.blur && !request.blur.awaitingOptions) armDefinitionBlurTimer(request, level);
    }
  }

  // Page and element scrolls leave an open popup where it is (#402).
  function onScroll() {
    cancelCandidateScan();
    rootLevel.view?.hideImagePreview();
  }

  function invalidateStoredState(dictionaryChanged) {
    audio?.retire();
    mining?.retire();
    discardPendingCandidate();
    // A completed selection hit or miss also belongs to the old lookup state.
    // Preserve Note's view ownership through its deferred refresh.
    if (!hasProtectedNote()) activeSelectionCandidate = null;
    for (const level of levels) {
      level.view?.hideImagePreview();
      if (level.popup?.inert) {
        hide(level);
        return;
      }
      level.lookupToken += 1;
      level.retainedView = Boolean(level.currentViewRequest && !level.popup.hidden);
      if (dictionaryChanged && level.popup && !level.popup.hidden) {
        if (!hasProtectedNote(level.depth)) {
          hide(level);
          return;
        }
        if (level.noteEditing || level.pendingCustomAppends > 0) {
          level.deferredDictionaryInvalidationRevision = dictionaryStateRevision;
        }
      }
    }
  }

  function onNoteEditingChange(editing, level = rootLevel) {
    if (level.retired) return;
    level.noteEditing = editing === true;
    if (level.noteEditing) {
      cancelCandidateScan();
      clearHideTimer();
    } else {
      flushDeferredNotes();
      flushDictionaryPresentation();
    }
  }

  function updateDictionaryPresentation() {
    const context = { dictionaryPresentation: dictionaryPresentation(), dictionaryTabGroups: dictionaryTabGroups(),
      ...compactSummaryOptions(), ...imageSourceContext(), ...window.HDPopup.metadataOptions(options) };
    for (const level of levels) {
      if (level.popup && !level.popup.hidden) level.view.updateDictionaryPresentation(context);
    }
  }

  function flushDictionaryPresentation() {
    for (const level of levels) {
      if (level.popup && !level.popup.hidden) level.view.flushDictionaryPresentation();
    }
  }

  function adoptDictionaryState(stored) {
    const next = normalizeDictionaryState(stored);
    if (next.revision <= dictionaryStateRevision) {
      return { adopted: false, dictionaryChanged: false, presentationChanged: false };
    }
    const dictionaryChanged = !sameDictionaryContents(next.dictionaries, dictionaries);
    const presentationChanged = !sameDictionaries(next.dictionaries, dictionaries)
      || !sameDictionaries(next.groups, dictionaryGroups);
    if (dictionaryChanged) {
      clearDictionaryResources();
      wordHighlights?.invalidate();
    }
    dictionaryStateRevision = next.revision;
    dictionaries = next.dictionaries;
    dictionaryGroups = next.groups;
    return { adopted: true, dictionaryChanged, presentationChanged };
  }

  function onStorageChanged(changes, area) {
    if (disposed || area !== "local") {
      return;
    }
    let changed = false;
    const previousLevelCount = levels.length;
    let dictionaryChanged = false;
    let presentationChanged = false;
    if (changes.options) {
      const adoption = adoptOptions(changes.options.newValue);
      changed = adoption.lookupChanged;
      presentationChanged = adoption.presentationChanged;
    }
    if (changes.dictionaryState) {
      const adoption = adoptDictionaryState(changes.dictionaryState.newValue);
      dictionaryChanged = adoption.dictionaryChanged;
      presentationChanged ||= adoption.presentationChanged;
      changed ||= dictionaryChanged;
    }
    if (changes.lookupStats) adoptLookupStatsDescriptor(changes.lookupStats.newValue, changes);
    if (changes.wordStatusOverrides) adoptWordStatusOverrides(changes.wordStatusOverrides.newValue, true);
    if (changed) {
      invalidateStoredState(dictionaryChanged);
    } else if (presentationChanged) updateDictionaryPresentation();
    if (levels.length < previousLevelCount) {
      flushDeferredNotes();
      flushDictionaryPresentation();
    }
  }

  function adoptOptions(stored) {
    const revision = Number.isInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : 0;
    if (revision <= optionsStorageRevision) return { lookupChanged: false, presentationChanged: false };
    const next = projectHostOptions(stored);
    const personalChanged = next.personalDictionaryEnabled !== options.personalDictionaryEnabled;
    const lookupChanged = next.scanLength !== options.scanLength || next.maxResults !== options.maxResults
      || next.frequencyDictionary !== options.frequencyDictionary || next.frequencyOrder !== options.frequencyOrder
      || personalChanged
      || JSON.stringify(next.kanjiClickDictionary) !== JSON.stringify(options.kanjiClickDictionary);
    const activationChanged = next.lookupMode !== options.lookupMode || next.activationKey !== options.activationKey
      || next.definitionLookupMode !== options.definitionLookupMode;
    const interactionChanged = activationChanged || next.hoverEnabled !== options.hoverEnabled
      || next.onlyScanJapaneseText !== options.onlyScanJapaneseText || personalChanged
      || next.scanDelayMs !== options.scanDelayMs || next.definitionScanDelayMs !== options.definitionScanDelayMs;
    const hideDelayChanged = next.popupHideDelayMs !== options.popupHideDelayMs && hideTimer !== null;
    const cursorExitChanged = next.hidePopupOnCursorExit !== options.hidePopupOnCursorExit
      || next.hidePopupOnCursorExitDelayMs !== options.hidePopupOnCursorExitDelayMs;
    const columnsChanged = next.popupColumns !== options.popupColumns;
    const layoutChanged = next.glossaryLayoutMode !== options.glossaryLayoutMode;
    const sizeChanged = next.popupWidthPx !== options.popupWidthPx || next.popupHeightPx !== options.popupHeightPx
      || next.popupScalePercent !== options.popupScalePercent;
    const toolbarChanged = next.popupToolbarPosition !== options.popupToolbarPosition;
    const highlightChanged = next.sourceHighlightEnabled !== options.sourceHighlightEnabled;
    const summaryChanged = next.showCompactDefinitionSummary !== options.showCompactDefinitionSummary
      || next.compactDefinitionSummaryCount !== options.compactDefinitionSummaryCount
      || next.compactDefinitionSummaryDictionary !== options.compactDefinitionSummaryDictionary;
    const imageSourceChanged = JSON.stringify(next.popupImageSource) !== JSON.stringify(options.popupImageSource);
    const metadataChanged = Object.entries(window.HDPopup.metadataOptions(next)).some(([key, value]) => value !== options[key]);
    // The caller adopts the complete storage delivery before new summary work.
    // A simultaneous dictionary replacement must invalidate the old view first.
    const countsChanged = next.showLookupCounts !== options.showLookupCounts;
    const ankiChanged = JSON.stringify(next.anki) !== JSON.stringify(options.anki);
    const customButtonsChanged = JSON.stringify(next.customButtons) !== JSON.stringify(options.customButtons);
    if (ankiChanged || next.definitionBlurAnkiMature !== options.definitionBlurAnkiMature) ankiMaturityEpoch++;
    const blurChanged = ankiChanged || next.showLookupCounts !== options.showLookupCounts || DEFINITION_BLUR_KEYS
      .some(key => next[key] !== options[key]);
    const optionsArrived = optionsStorageRevision < 0;
    const adoption = { lookupChanged,
      presentationChanged: (summaryChanged || imageSourceChanged || metadataChanged) && next.hoverEnabled };
    if (activationChanged) {
      activationPressed = false;
      activationCode = null;
    }
    optionsStorageRevision = revision;
    options = next;
    if (activationChanged) syncHostAttention();
    if (docsProbeStyle && !docsEnabled()) releaseDocsProbe();
    syncNetflix();
    if (customButtonsChanged) {
      for (const level of levels) level.view?.setCustomButtons(options.customButtons);
    }
    if (countsChanged) {
      for (const level of levels) {
        const request = level.currentViewRequest;
        const entry = request?.lookupStats;
        if (!entry) continue;
        if (next.showLookupCounts) entry.needsRefresh = true;
        paintLookupStatistics(request, level);
        refreshLookupStatistics(request, level);
      }
    }
    if (optionsArrived) {
      for (const level of levels) {
        const request = level.currentViewRequest;
        if (request?.blur?.awaitingOptions) resolveDefinitionBlurOptions(request, level);
      }
    } else if (blurChanged) {
      for (const level of levels) {
        const request = level.currentViewRequest;
        const blur = request?.blur;
        if (!blur) continue;
        discardStaleAnkiMaturity(request, level);
        settleDefinitionBlur(request, level);
        if (blur.state === "pending") checkDefinitionBlurMaturity(request, level);
        // Disabling reveals at once; other edits apply to unrevealed views
        // from their original display time. Note drafts are untouched.
        if (!definitionBlurActive()) {
          revealDefinitions(request, level);
        } else armDefinitionBlurTimer(request, level);
      }
    }
    audio?.update(options);
    mining?.update(options);
    wordStatusActions?.update(options);
    appearance?.update(options);
    void themeHost.sync();
    // After the appearance, so a changed theme's palette is on the host.
    syncWordHighlights();
    if (sizeChanged) for (const level of levels) level.view?.hideImagePreview();
    const cssChanged = customStyle?.update(options.customPopupCss);
    if (highlightChanged) {
      for (const level of levels) level.view?.setSourceHighlightEnabled(options.sourceHighlightEnabled);
    }
    if (toolbarChanged) {
      for (const level of levels) {
        if (level.popup && (!options.hoverEnabled || level.popup.hidden)) positionToolbar(level, null, true);
      }
    }
    if (levels.length > options.popupNestingMaxDepth + 1) pruneLevels(options.popupNestingMaxDepth + 1);
    // Either edit applies at once: a pending exit restarts under the new
    // setting, and a pending descendant prune waits for the pointer to
    // schedule the next one.
    if (cursorExitChanged) {
      clearDescendantTimer();
      if (cursorExitTimer !== null) {
        clearCursorExitTimer();
        scheduleCursorExitHide();
      }
    }
    // Masonry must measure the new inline width, not lay out the old width and
    // wait for ResizeObserver to correct every card in a second frame.
    if ((sizeChanged || toolbarChanged) && options.hoverEnabled && rootLevel.popup && !rootLevel.popup.hidden) {
      positionPopup(rootLevel, toolbarChanged);
    }
    if ((columnsChanged || layoutChanged || sizeChanged || cssChanged) && options.hoverEnabled) {
      for (const level of levels) {
        if (!level.popup?.hidden) level.view?.scheduleMasonry();
      }
    }
    if (!options.hoverEnabled) {
      setSelectionDrag(false);
      lastPointer = null;
      activationPressed = false;
      activationCode = null;
      hide();
    }
    else if (interactionChanged) {
      if (selectionIsUnchanged()) {
        clearScanTimer();
        clearHideTimer();
        return adoption;
      }
      cancelCandidateScan();
      clearHideTimer();
      const popupLevel = activePointerLevel(lastPointer);
      if (!hasProtectedNote() && !popupHasFocus() && (!pointerInPopup || popupLevel)) {
        if (!(popupLevel ? definitionHoverAllowed() : activationAllowed())) {
          if (popupLevel) cancelPendingHover(popupLevel);
          else schedulePointerHide();
        }
        else if (lastPointer) scheduleScan();
      }
    } else if (hideDelayChanged) {
      clearHideTimer();
      scheduleHide();
    }
    return adoption;
  }

  function start() {
    void loadOverlayMode();
    // Startup awaits this snapshot before demonstrating its first selection.
    let storageReady;
    const reader = Object.freeze({ scanSelectedText });
    globalThis.HDReaderReady = new Promise(resolve => {
      storageReady = () => { resolve(reader); };
    });
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
      // Optional like the worker's commands API: reader smoke hosts have no runtime messages.
      chrome.runtime.onMessage?.addListener(onReaderCommand);
      chrome.runtime.onMessage?.addListener(onWordStatusChanged);
      chrome.storage.local.get({ dictionaryState: null, options: DEFAULT_OPTIONS, lookupStats: null,
        wordStatusOverrides: null }, (stored) => {
        try {
          if (disposed || chrome.runtime.lastError) return;
          adoptWordStatusOverrides(stored?.wordStatusOverrides, false);
          const optionsAdoption = adoptOptions(stored && stored.options);
          const adoption = adoptDictionaryState(stored && stored.dictionaryState);
          adoptLookupStatsDescriptor(stored && stored.lookupStats);
          if (optionsAdoption.lookupChanged || adoption.dictionaryChanged) {
            invalidateStoredState(adoption.dictionaryChanged);
          } else if (optionsAdoption.presentationChanged || adoption.presentationChanged) updateDictionaryPresentation();
        } finally {
          storageReady();
        }
      });
    } catch {
      // Without storage access the defaults are still usable.
      storageReady();
    }
    // Capture so a page that stops propagation on its own text still gets
    // scanned; passive so the hot pointer and scroll paths can never delay the
    // page's own scrolling. A press, its release and its click stay cancelable:
    // an overlay drag and a scan button's press are the reader's, not the
    // browser's.
    const observe = { capture: true, passive: true };
    document.addEventListener("mousemove", onMouseMove, observe);
    document.addEventListener("mousedown", onMouseDown, { capture: true });
    document.addEventListener("mouseup", onMouseUp, { capture: true });
    document.addEventListener("auxclick", onAuxClick, { capture: true });
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("focusin", onPageFocusIn, observe);
    document.addEventListener("mouseout", onMouseOut, observe);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("scroll", onScroll, observe);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("resize", refreshPageZoom);
    refreshPageZoom();
  }

  // GSM integration hook begin
  gsmBridge = globalThis.GsmHachidoriIntegration?.install({
    state: () => ({ disposed, levels, options, dictionaries, pendingCandidateLookup }),
    ready: () => globalThis.HDReaderReady,
    readOptions: async () => (await chrome.storage.local.get("options")).options ?? null,
    resolveCandidate, resolveCandidateAt, candidateSignature, sameAnchorNode, lookupCandidate, hide, sendRequest,
    cancelHover({ preserveLookup = false } = {}) {
      if (preserveLookup) clearScanTimer(); else cancelCandidateScan();
      clearHideTimer(); clearTransferTimer(); clearDescendantTimer();
    },
    command: (action, argument) => runKeybindAction({ action, argument }, { preventDefault() {}, stopPropagation() {} }),
  });
  // GSM integration hook end
  start();
}());
