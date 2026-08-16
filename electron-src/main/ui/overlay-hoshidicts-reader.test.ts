import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAudioControllerStub,
  configureBootstrapReader,
  createDom,
  createDomFrom,
  createReaderHarness,
  deferred,
  dispatchKey,
  dispatchMouse,
  dispatchPlain,
  FakeWebSocket,
  featurePath,
  firstRequestOfType,
  flushPromises,
  hover,
  kanjiResult,
  lastRequest,
  lastRequestOfType,
  launchBootstrap,
  loadBootstrapModule,
  loadReaderModule,
  lookupResult,
  lookupResultWithDictionaries,
  miningButtonsInResultOrder,
  overlayPath,
  parseDocument,
  readFeatureFile,
  readOverlayFile,
  renderFirstLookup,
  requestsOfType,
  resetReaderTestState,
  respond,
  sentRequests,
  setRect,
  type ReaderHarness
} from "../../../GSM_Overlay/features/hoshidicts/test_helpers";
import {
  createDefaultHoshidictsReaderPreferences,
  HOSHIDICTS_THEMES
} from "../../shared/features/hoshidicts";
import { GSM_THEME_DEFINITIONS } from "../../shared/themes";

const READER_CSS_RULES = Array.from(
  readFeatureFile("reader.css").matchAll(
    /(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/gu
  )
);

/**
 * Declarations of the nth rule whose selector list contains exactly this
 * selector, so shared metrics and per-element overrides stay distinguishable.
 */
function readerCssRule(selector: string, occurrence = 0) {
  return READER_CSS_RULES.filter((rule) =>
    rule.groups?.selectors
      .split(",")
      .map((candidate) => candidate.replace(/\/\*[\s\S]*?\*\//gu, "").trim())
      .includes(selector)
  )[occurrence]?.groups?.declarations;
}

/**
 * The reader's complete default preference snapshot, for exact comparisons.
 *
 * Derived from the shared spec table rather than hand-copied, so a default that
 * changes on the Electron side fails here instead of drifting silently. The
 * three dictionary-context keys are explicit: they are not in the spec table.
 */
function readerPreferences(overrides: Record<string, unknown> = {}) {
  return {
    ...createDefaultHoshidictsReaderPreferences(),
    dictionaryPresentation: [],
    frequencyDictionaries: [],
    dictionaryTabGroups: [],
    ...overrides
  };
}

/** The complete normalised object the bootstrap forwards to the reader. */
function livePreferences(overrides: Record<string, unknown> = {}) {
  return readerPreferences(overrides);
}

/**
 * The launch environment GSM builds for a preference set: one JSON variable,
 * minus customPopupCss, which the control channel delivers instead.
 */
function launchEnvironmentFor(overrides: Record<string, unknown> = {}) {
  const { customPopupCss: _customPopupCss, ...carried } = livePreferences(overrides);
  return { GSM_HOSHIDICTS_READER_PREFERENCES: JSON.stringify(carried) };
}

afterEach(resetReaderTestState);

describe("Hoshidicts safe popup rendering", () => {
  const POPUP = ".gsm-hoshidicts-popup";

  it("scales the popup by its own variables instead of element opacity", () => {
    expect(readerCssRule(POPUP)).not.toMatch(/(?:^|;)\s*opacity\s*:/);
  });

  it("does not blur the popup backdrop so the preview and transparent in-game overlay match", () => {
    // Electron transparent windows cannot backdrop-blur the native game/OBS
    // surface below the BrowserWindow, but the Design preview paints its
    // background in the SAME renderer, so a backdrop-filter blurs there only.
    // That divergence is exactly what the parity fix removes: the outer popup
    // must carry no backdrop-filter, leaving only its alpha background.
    expect(readerCssRule(POPUP) ?? "").not.toMatch(/(?:^|[-])backdrop-filter\s*:/u);
  });

  it("pins a bottom toolbar to the popup floor so short definitions cannot float it up", () => {
    // The popup is a fixed-height column, so a bottom toolbar must be pushed to
    // the floor rather than trailing short content up the middle of the popup.
    const popupRule = readerCssRule(POPUP) ?? "";
    expect(popupRule).toMatch(/display\s*:\s*flex/);
    expect(popupRule).toMatch(/flex-direction\s*:\s*column/);

    const bottomChromeRule = readerCssRule(
      '.gsm-hoshidicts-popup[data-toolbar-position="bottom"] .gsm-hoshidicts-result-chrome'
    ) ?? "";
    // A leading `auto` in the margin (either the longhand margin-top or the
    // shorthand's first value) is what pushes the toolbar to the popup floor.
    expect(bottomChromeRule).toMatch(/margin(?:-top)?\s*:\s*auto/);
  });

  it("keeps the transient status attached to the toolbar in the bottom status surface", () => {
    // The status node is a top-level popup child ordered just before the bottom
    // toolbar. If only the toolbar carries `margin-top: auto`, the free space
    // collapses BETWEEN the status and the toolbar, floating the status up the
    // middle of the popup and splitting the Yomitan-style status surface. So a
    // visible status in bottom mode must own the floor group's auto margin, and
    // the toolbar immediately after it must not add a second one.
    const bottomFeedbackRule = readerCssRule(
      '.gsm-hoshidicts-popup[data-toolbar-position="bottom"] .gsm-hoshidicts-mining-feedback'
    ) ?? "";
    expect(bottomFeedbackRule).toMatch(/margin-top\s*:\s*auto/);

    const attachedChromeRule = readerCssRule(
      '.gsm-hoshidicts-popup[data-toolbar-position="bottom"] .gsm-hoshidicts-mining-feedback:not([hidden]) + .gsm-hoshidicts-result-chrome'
    ) ?? "";
    expect(attachedChromeRule).toMatch(/margin-top\s*:\s*0/);
  });

  // The Back control sits in a flex sibling row beside the headword and the
  // action buttons. That wrapper declares min-width: 0, so with default
  // flex-shrink it is allowed to shrink below the Back button's intrinsic
  // width once the row is under pressure (a wide headword, e.g. a compact
  // definition summary on a clicked-kanji generic-dictionary result). The
  // button then overflows its shrunken wrapper and a later-painted sibling can
  // cover it, hiding Back behind the kanji result. Pinning the wrapper's
  // shrink to 0 keeps it at least as wide as the Back button so the control
  // stays in the navigation layer at every popup width. This is a local flex
  // sizing fix, not a global z-index escalation.
  it("does not let the Back navigation wrapper shrink below the Back button", () => {
    const navigationRule = readerCssRule(".gsm-hoshidicts-kanji-navigation") ?? "";
    expect(navigationRule).toMatch(
      /(?:^|;)\s*flex-shrink\s*:\s*0\b|(?:^|;)\s*flex\s*:\s*0\s+0\b/
    );
  });

  // reader.css owns these palettes; jsdom applies no CSS, so scraping the file
  // only restated it. What matters behaviourally is that every theme the reader
  // can select has a rule to select, which the reader test at the bottom of this
  // file drives through THEME_SET.
  it.each(HOSHIDICTS_THEMES)("declares a %s theme rule", (theme) => {
    const selector =
      theme === "default"
        ? 'html[data-hoshidicts-theme="default"]'
        : `html[data-hoshidicts-theme="${theme}"]`;
    expect(readFeatureFile("reader.css")).toContain(selector);
  });

  // Every theme is only usable if its palette rule declares the full token set
  // the popup reads; a block that omits one falls back to an unrelated theme's
  // value and looks broken. The default (dark) block is the reference set.
  it.each([...HOSHIDICTS_THEMES] as string[])(
    "declares every palette token in the %s theme rule",
    (theme: string) => {
      const css = readFeatureFile("reader.css");
      const paletteTokens = (selector: string) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
        return new Set(
          [...(rule?.[1] ?? "").matchAll(/(--hoshidicts-palette-[a-z0-9-]+)\s*:/gu)]
            .map((match) => match[1])
        );
      };
      const expected = paletteTokens('html[data-hoshidicts-theme="default"]');
      expect(expected.size).toBeGreaterThan(0);
      const declared = paletteTokens(
        `html[data-hoshidicts-theme="${theme}"]`
      );
      expect([...expected].sort()).toEqual([...declared].sort());
    }
  );

  it("blurs glossary content without obscuring definition tags", () => {
    const blurRule =
      /\.gsm-hoshidicts-definitions\[data-definition-blur-state="pending"\]\s+\.gsm-hoshidicts-glossary-content,\s*\.gsm-hoshidicts-definitions\[data-definition-blur-state="blurred"\]\s+\.gsm-hoshidicts-glossary-content\s*\{(?<declarations>[^}]*)\}/u.exec(
        readFeatureFile("reader.css")
      );

    expect(blurRule?.groups?.declarations).toContain("filter: blur(5px)");
    expect(blurRule?.groups?.declarations).toContain("user-select: none");
    expect(blurRule?.[0]).not.toContain("definition-tags");
  });

  // A hover-only enlargement helps read small dictionary glossary illustrations
  // without adding any JavaScript, controls, or modal. It must be scoped to the
  // real glossary image inside the popup glossary content so game frames,
  // toolbar icons, dictionary logos, README assets, and other Electron UI can
  // never match; gated behind `@media (hover: hover)` so touch/tap devices are
  // unchanged; and it must not clip the enlarged pixels behind the container's
  // overflow. Only the zoom transition is dropped under reduced motion — the
  // enlargement itself still works.
  describe("glossary image hover zoom", () => {
    const css = readFeatureFile("reader.css");

    // The whole `@media (hover: hover) { ... }` block, captured so we can prove
    // the zoom lives inside it (touch devices never match) and inspect it.
    function hoverMediaBlock() {
      let depth = 0;
      let start = -1;
      const opener = css.indexOf("@media (hover: hover)");
      if (opener < 0) return null;
      for (let index = css.indexOf("{", opener); index < css.length; index += 1) {
        const character = css[index];
        if (character === "{") {
          if (depth === 0) start = index;
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
          if (depth === 0) return css.slice(start + 1, index);
        }
      }
      return null;
    }

    it("enlarges the real popup glossary image only on hover-capable devices", () => {
      const block = hoverMediaBlock();
      expect(block).not.toBeNull();
      // The zoom targets the actual dictionary glossary image, scoped under the
      // popup glossary content, on hover or keyboard focus.
      const rule =
        /\.gsm-hoshidicts-glossary-content\s+[^{}]*\.gloss-image[^{}]*:(?:hover|focus[^{}]*)[^{}]*\{(?<declarations>[^{}]*)\}/u.exec(
          block ?? ""
        );
      expect(rule?.groups?.declarations).toMatch(
        /transform\s*:\s*scale\(\s*(?:1\.\d+|[2-9])/u
      );
    });

    it("scopes the zoom under Hoshidicts glossary content, never bare images", () => {
      const block = hoverMediaBlock() ?? "";
      // Every zoom selector that scales must be anchored to the popup glossary
      // content, so no toolbar icon, logo, game frame, or README image matches.
      const zoomRules = [
        ...block.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/gu)
      ].filter((match) => /transform\s*:\s*scale\(/u.test(match.groups?.declarations ?? ""));
      expect(zoomRules.length).toBeGreaterThan(0);
      for (const zoomRule of zoomRules) {
        for (const selector of (zoomRule.groups?.selectors ?? "").split(",")) {
          expect(selector).toContain(".gsm-hoshidicts-glossary-content");
        }
      }
    });

    it("lets the enlarged image escape the container clip so it stays visible", () => {
      const block = hoverMediaBlock() ?? "";
      // The gloss image container clips with overflow: hidden. The zoom must lift
      // that clip (and raise the image) while hovering so the enlarged pixels are
      // not cut off, without touching the base non-hover layout.
      expect(block).toMatch(
        /\.gsm-hoshidicts-glossary-content\s+[^{}]*:hover\s+\.gloss-image-container[^{}]*\{(?<declarations>[^{}]*overflow\s*:\s*visible[^{}]*)\}/u
      );
    });

    it("escapes the popup scrollport, not just the container clip", () => {
      // Root cause of the earlier clip: `.gsm-hoshidicts-popup` is a scrollport
      // (overflow-x: hidden; overflow-y: auto). A descendant that is only lifted
      // to `overflow: visible` STILL cannot paint outside that ancestor scrollport,
      // so a scale(1.6) enlargement near the popup edge was cut off by the popup.
      // Strip CSS comments first so prose (which mentions these properties by name)
      // can never satisfy the assertions — only real declarations count.
      const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");

      // Confirm the popup really is a clipping scrollport (the ancestor to escape).
      const popupRule =
        /\.gsm-hoshidicts-popup\s*\{(?<declarations>(?:[^{}]|\{[^{}]*\})*)\}/u.exec(
          cssNoComments
        );
      expect(popupRule?.groups?.declarations).toMatch(/overflow-y\s*:\s*auto/u);
      expect(popupRule?.groups?.declarations).toMatch(/overflow-x\s*:\s*hidden/u);

      // The hover/focus enlargement must therefore take the image's container
      // OUT of the scrollport's flow (position: fixed | absolute) so the popup's
      // overflow no longer clips the enlarged pixels. `overflow: visible` alone
      // on the container does not achieve this and is what let the bug through.
      const opener = cssNoComments.indexOf("@media (hover: hover)");
      let depth = 0;
      let start = -1;
      let block = "";
      for (let index = cssNoComments.indexOf("{", opener); index < cssNoComments.length; index += 1) {
        const character = cssNoComments[index];
        if (character === "{") {
          if (depth === 0) start = index;
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            block = cssNoComments.slice(start + 1, index);
            break;
          }
        }
      }
      const containerRule =
        /\.gsm-hoshidicts-glossary-content\s+[^{}]*:(?:hover|focus[^{}]*)\s+\.gloss-image-container[^{}]*\{(?<declarations>[^{}]*)\}/u.exec(
          block
        );
      expect(containerRule).not.toBeNull();
      expect(containerRule?.groups?.declarations).toMatch(
        /position\s*:\s*(?:fixed|absolute)/u
      );
      // And the enlargement transform itself is still present and > 1.
      expect(block).toMatch(/transform\s*:\s*scale\(\s*(?:1\.\d+|[2-9])/u);
    });

    it("keeps a modest zoom transition but drops it under reduced motion", () => {
      const block = hoverMediaBlock() ?? "";
      // A transition on the glossary image gives the enlargement a smooth feel.
      const baseRule =
        /\.gsm-hoshidicts-glossary-content\s+[^{}]*\.gloss-image[^{}]*\{(?<declarations>[^{}]*transition\s*:\s*transform[^{}]*)\}/u.exec(
          block
        );
      expect(baseRule).not.toBeNull();

      // Under prefers-reduced-motion the transition is removed, but the zoom
      // transform itself is NOT — reduced motion drops animation, not the size.
      const reducedMotion =
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(?<body>(?:[^{}]|\{[^{}]*\})*)\}/gu;
      let disablesTransition = false;
      for (const media of css.matchAll(reducedMotion)) {
        const body = media.groups?.body ?? "";
        if (
          /\.gloss-image[^{}]*\{[^{}]*transition\s*:\s*none/u.test(body) &&
          !/transform\s*:\s*(?:none|scale\(\s*1\s*\))/u.test(body)
        ) {
          disablesTransition = true;
        }
      }
      expect(disablesTransition).toBe(true);
    });
  });


  it("uses Yomitan card icons for new and duplicate mining states", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const button = dom.window.document.createElement("button");

    api.setMiningButtonState(button, "ready");
    expect(button.querySelector<HTMLElement>(".gsm-hoshidicts-mine-icon")
      ?.dataset.icon).toBe("big-circle");
    expect(button.textContent).toBe("");

    api.setMiningButtonState(button, "add-duplicate");
    expect(button.querySelector<HTMLElement>(".gsm-hoshidicts-mine-icon")
      ?.dataset.icon).toBe("add-duplicate-big-circle");
    expect(button.textContent).toBe("");

    api.setMiningButtonState(button, "duplicate");
    expect(button.querySelector<HTMLElement>(".gsm-hoshidicts-mine-icon")
      ?.dataset.icon).toBe("add-duplicate-big-circle");
    expect(button.textContent).toBe("");
  });

  it("segments supplementary-plane kanji separately from trailing kana", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);

    expect(
      Array.from(api.segmentFurigana("𠮟る", "しかる"), (segment: any) => ({
        text: segment.text,
        reading: segment.reading
      }))
    ).toEqual([
      { text: "𠮟", reading: "しか" },
      { text: "る", reading: "" }
    ]);
  });

  it("groups pitch readings by mora and builds every Tokyo pitch contour", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);

    expect(api.splitPitchAccentMorae("きょう")).toEqual(["きょ", "う"]);
    expect(api.splitPitchAccentMorae("がっこう")).toEqual([
      "が",
      "っ",
      "こ",
      "う"
    ]);
    expect(api.buildPitchAccentMorae("たべる", 0)).toEqual([
      { text: "た", level: "low", transition: "rise" },
      { text: "べ", level: "high", transition: null },
      { text: "る", level: "high", transition: null }
    ]);
    expect(api.buildPitchAccentMorae("たべる", 1)).toEqual([
      { text: "た", level: "high", transition: "drop" },
      { text: "べ", level: "low", transition: null },
      { text: "る", level: "low", transition: null }
    ]);
    expect(api.buildPitchAccentMorae("たべる", 2)).toEqual([
      { text: "た", level: "low", transition: "rise" },
      { text: "べ", level: "high", transition: "drop" },
      { text: "る", level: "low", transition: null }
    ]);
    expect(api.buildPitchAccentMorae("たべる", 3)).toEqual([
      { text: "た", level: "low", transition: "rise" },
      { text: "べ", level: "high", transition: null },
      { text: "る", level: "high", transition: "drop" }
    ]);
    expect(api.buildPitchAccentMorae("たべる", 4)).toBeNull();

    const pitchGroups = [
      {
        dictionary: "First",
        pitches: [{ position: 99 }, { position: 1 }]
      },
      {
        dictionary: "Preferred",
        pitches: [{ position: -1 }, { position: 2 }]
      }
    ];
    expect(api.selectPitchAccent(pitchGroups, "Preferred", 3)).toMatchObject({
      dictionary: "Preferred",
      pitch: { position: 2 }
    });
    expect(api.selectPitchAccent(pitchGroups, "Missing", 3)).toMatchObject({
      dictionary: "First",
      pitch: { position: 1 }
    });
  });

  it("links to dedicated settings from Overlay Settings, not the overlay toolbar", () => {
    const settingsHtml = readOverlayFile("settings.html");
    const document = parseDocument(settingsHtml);

    expect(readOverlayFile("index.html")).not.toContain(
      'id="btn-hoshidicts-settings"'
    );
    expect(
      document.querySelector("#openHoshidictsSettings")?.textContent?.trim()
    ).toBe("Hoshidicts Settings");
    // Slicing the inline script out and running it in a vm only re-proved that
    // these five lines are present, which reading them does directly.
    expect(settingsHtml).toContain(
      'document.getElementById("openHoshidictsSettings")'
    );
    expect(settingsHtml).toContain('invoke("open-hoshidicts-settings")');
  });

  it.each([
    ["reader enablement", {}, { enabled: true }],
    ["hover lookups", { lookupMode: "hover" }, { lookupMode: "hover" }],
    ["a custom activation key", { activationKey: "F8" }, { activationKey: "F8" }],
    [
      "pitch accent presentation",
      {
        showPitchAccentFurigana: false,
        showPitchAccentBadge: true,
        pitchAccentFuriganaDictionary: "Kanjium Pitch Accents"
      },
      {
        showPitchAccentFurigana: false,
        showPitchAccentBadge: true,
        pitchAccentFuriganaDictionary: "Kanjium Pitch Accents"
      }
    ],
    [
      "popup appearance",
      {
        popupWidthPx: 720,
        popupHeightPx: 520,
        popupColumns: 3,
        theme: "cyberpunk",
        popupOpacityPercent: 70,
        popupToolbarPosition: "bottom"
      },
      {
        popupWidthPx: 720,
        popupHeightPx: 520,
        popupColumns: 3,
        theme: "cyberpunk",
        popupOpacityPercent: 70,
        popupToolbarPosition: "bottom"
      }
    ],
    [
      "lookup and frequency settings",
      {
        scanLength: 24,
        maxResults: 48,
        sortFrequencyDictionary: "Frequency",
        sortFrequencyDictionaryOrder: "ascending",
        averageFrequency: true,
        showFrequencyDictionaryNames: false
      },
      {
        scanLength: 24,
        maxResults: 48,
        sortFrequencyDictionary: "Frequency",
        sortFrequencyDictionaryOrder: "ascending",
        averageFrequency: true,
        showFrequencyDictionaryNames: false
      }
    ],
    [
      "definition blur",
      {
        definitionBlur: {
          enabled: true,
          lookupThreshold: 12,
          revealMode: "hover",
          revealDelayMs: 9000
        }
      },
      {
        definitionBlur: {
          enabled: true,
          lookupThreshold: 12,
          revealMode: "hover",
          revealDelayMs: 9000
        }
      }
    ],
    [
      "popup buttons, which the environment now carries",
      {
        popupButtons: {
          addToAnki: false,
          audio: false,
          customDefinition: false,
          viewInAnki: true,
          customLinks: [{ label: "Jisho", url: "https://jisho.org/search/%w" }]
        }
      },
      {
        popupButtons: {
          addToAnki: false,
          audio: false,
          customDefinition: false,
          viewInAnki: true,
          customLinks: [{ label: "Jisho", url: "https://jisho.org/search/%w" }]
        }
      }
    ]
  ])("reads %s from the launch environment", (_label, overrides, expected) => {
    const { api, preferences } = launchBootstrap(launchEnvironmentFor(overrides));

    const { enabled, ...preferenceExpectations } = expected as Record<string, any>;
    expect(preferences).toEqual(livePreferences(preferenceExpectations));
    if (enabled !== undefined) {
      expect(api.isEnabled()).toBe(enabled);
    }
  });

  it("marks the document for scanner suppression before the overlay scripts load", () => {
    const { addClass, documentElement, setProperty, window } = launchBootstrap(
      launchEnvironmentFor({ popupOpacityPercent: 70 })
    );

    expect(window.gsmHoshidictsReaderEnabled).toBe(true);
    expect(addClass).toHaveBeenCalledWith("gsm-hoshidicts-enabled");
    expect(documentElement.dataset.gsmHoshidictsEnabled).toBe("true");
    expect(documentElement.dataset.hoshidictsTheme).toBe("default");
    expect(setProperty).toHaveBeenCalledWith(
      "--gsm-hoshidicts-popup-opacity",
      "70%"
    );
    expect(setProperty).not.toHaveBeenCalledWith(
      "--gsm-hoshidicts-popup-backdrop-filter",
      expect.anything()
    );

    const disabled = loadBootstrapModule({ GSM_HOSHIDICTS_ENABLED: "0" });
    expect(disabled.window.gsmHoshidictsReaderEnabled).toBe(false);
    expect(disabled.api.isEnabled()).toBe(false);
    expect(disabled.addClass).not.toHaveBeenCalled();
    expect(disabled.documentElement.dataset.gsmHoshidictsEnabled).toBeUndefined();
    expect(disabled.api.initialize({})).toBeNull();
  });

  it("accepts a launch theme", () => {
    const { documentElement, preferences } = launchBootstrap(
      launchEnvironmentFor({ theme: "synthwave" })
    );

    expect(preferences.theme).toBe("synthwave");
    expect(documentElement.dataset.hoshidictsTheme).toBe("synthwave");
  });

  it("creates the reader with the launch preferences and GSM API clients", async () => {
    const configured = configureBootstrapReader({
      env: launchEnvironmentFor({
        lookupMode: "hover",
        activationKey: "F8",
        sourceHighlightEnabled: true,
        popupNestingMaxDepth: 4
      })
    });

    expect(configured.createHoshidictsReader).toHaveBeenCalledWith(
      expect.objectContaining({
        ...livePreferences({
          lookupMode: "hover",
          activationKey: "F8",
          sourceHighlightEnabled: true,
          popupNestingMaxDepth: 4
        }),
        activationKeyPressed: false,
        audioClient: { kind: "audio" },
        serverUrl: "ws://127.0.0.1:7276"
      })
    );
    for (const create of [
      configured.createHoshidictsAudioClient,
      configured.createHoshidictsLookupStatsClient,
      configured.createHoshidictsMiningClient
    ]) {
      expect(create).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:7275" });
    }
    // A second settings push must not build a second reader.
    configured.api.initialize({ gamepadServerPort: 7276 });
    expect(configured.createHoshidictsReader).toHaveBeenCalledTimes(1);

    const options = configured.readerOptions;
    const duplicateCheck = { notes: [{ sentence: "食べる" }] };
    await options.checkMiningNotes(duplicateCheck);
    expect(configured.mining.check).toHaveBeenCalledWith(duplicateCheck);
    await options.getMiningStatus();
    expect(configured.mining.getStatus).toHaveBeenCalled();
    await options.onMine({ word: "食べる" });
    expect(configured.mining.mine).toHaveBeenCalledWith({ word: "食べる" });
    await options.onBrowse({ word: "食べる" });
    expect(configured.mining.browse).toHaveBeenCalledWith({ word: "食べる" });
    options.onLookup({ term: "食べる", reading: "たべる" });
    expect(configured.recordLookup).toHaveBeenCalledWith({
      term: "食べる",
      reading: "たべる"
    });
    await options.onOpenExternalLink("https://jisho.org/search/test");
    expect(configured.invoke).toHaveBeenCalledWith("hoshidicts-open-external", {
      url: "https://jisho.org/search/test"
    });
    const entry = {
      term: "螺旋丸",
      reading: "らせんがん",
      definition: "Rotating chakra sphere attack"
    };
    await expect(options.onAddCustomEntry(entry)).resolves.toEqual({ saved: true });
    expect(configured.invoke).toHaveBeenCalledWith(
      "hoshidicts-add-custom-entry",
      entry
    );
  });

  it("passes the settings locale to the reader at creation", () => {
    const configured = configureBootstrapReader({
      settings: { gamepadServerPort: 7276, locale: "ja" }
    });
    expect(configured.readerOptions.locale).toBe("ja");
  });

  it("relays a later settings locale to the existing reader", () => {
    const configured = configureBootstrapReader({
      settings: { gamepadServerPort: 7276, locale: "en" }
    });
    configured.api.initialize({ gamepadServerPort: 7276, locale: "ukr" });
    expect(configured.reader.updateLocale).toHaveBeenLastCalledWith("ukr");
    expect(configured.createHoshidictsReader).toHaveBeenCalledTimes(1);
  });

  it("hands the reader one normalised object for live preferences", () => {
    const configured = configureBootstrapReader();
    const live = livePreferences({
      lookupMode: "hover",
      scanLength: 24,
      maxResults: 48,
      sortFrequencyDictionary: "Frequency",
      sortFrequencyDictionaryOrder: "ascending",
      activationKey: "F9",
      sourceHighlightEnabled: true,
      onlyScanJapaneseText: false,
      popupHideDelayMs: 800,
      showLookupCounts: false,
      popupNestingMaxDepth: 3,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "autumn",
      customPopupCss: ":scope { border-radius: 16px; }",
      dictionaryPresentation: [
        { title: "Primary", favorite: false, displayName: "Main dictionary" },
        { title: "Frequency", favorite: true, frequencyMode: "rank-based" }
      ],
      frequencyDictionaries: ["Frequency"],
      dictionaryTabGroups: [
        { id: "reference", name: "Reference", dictionaries: ["Primary"] }
      ],
      popupButtons: {
        addToAnki: false,
        audio: true,
        customDefinition: false,
        viewInAnki: true,
        customLinks: [{ label: "Jisho", url: "https://jisho.org/search/%w" }]
      },
      definitionBlur: {
        enabled: true,
        lookupThreshold: 7,
        revealMode: "hover",
        revealDelayMs: 6000
      }
    });

    configured.emit("hoshidicts-reader-preferences", live);
    expect(configured.reader.updatePreferences).toHaveBeenLastCalledWith(live);
    expect(configured.api.getPreferences()).toEqual(live);
    expect(configured.documentElement.dataset.hoshidictsTheme).toBe("autumn");
    expect(configured.setProperty).toHaveBeenCalledWith(
      "--gsm-hoshidicts-popup-opacity",
      "70%"
    );
  });

  // Both frequency modes are meaningful to the reader, so neither may be
  // normalised away; only unknown values fall back.
  it.each(["rank-based", "occurrence-based"])(
    "preserves the %s frequency mode through live preferences",
    (frequencyMode) => {
      const configured = configureBootstrapReader();
      const live = livePreferences({
        dictionaryPresentation: [
          { title: "Frequency", favorite: true, frequencyMode }
        ],
        frequencyDictionaries: ["Frequency"]
      });

      configured.emit("hoshidicts-reader-preferences", live);

      expect(
        configured.api.getPreferences().dictionaryPresentation
      ).toEqual([{ title: "Frequency", favorite: true, frequencyMode }]);
    }
  );

  it.each([
    ["a blurred lookup threshold below one", { definitionBlur: { enabled: true, lookupThreshold: 0, revealMode: "timed", revealDelayMs: 5000 } }],
    ["an over-long blur reveal delay", { definitionBlur: { enabled: true, lookupThreshold: 5, revealMode: "timed", revealDelayMs: 3_600_001 } }],
    ["a blank dictionary display name", { dictionaryPresentation: [{ title: "Primary", favorite: false, displayName: "   " }] }],
    ["duplicate frequency dictionaries", { frequencyDictionaries: ["Frequency", "Frequency"] }],
    ["an unknown frequency mode", { dictionaryPresentation: [{ title: "Frequency", favorite: true, frequencyMode: "invalid" }] }],
    ["oversized custom popup CSS", { customPopupCss: "x".repeat(32 * 1024 + 1) }],
    ["a non-boolean lookup-count flag", { showLookupCounts: "false" }],
    ["an unknown theme", { theme: "not-a-theme" }],
    ["a credential-bearing popup link", {
      popupButtons: {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: false,
        customLinks: [{ label: "Bad", url: "https://user:pass@example.com/%w" }]
      }
    }],
    ["a duplicate tab-group name", {
      dictionaryTabGroups: [
        { id: "a", name: "Reference", dictionaries: [] },
        { id: "b", name: "Reference", dictionaries: [] }
      ]
    }]
  ])("ignores live preferences with %s", (_label, overrides) => {
    const configured = configureBootstrapReader();

    configured.emit("hoshidicts-reader-preferences", livePreferences(overrides));

    expect(configured.reader.updatePreferences).not.toHaveBeenCalled();
    expect(configured.api.getPreferences()).toEqual(livePreferences());
  });

  it("applies a live theme push", () => {
    const configured = configureBootstrapReader();

    configured.emit(
      "hoshidicts-reader-preferences",
      livePreferences({ theme: "synthwave" })
    );

    expect(configured.reader.updatePreferences).toHaveBeenLastCalledWith(
      livePreferences({ theme: "synthwave" })
    );
    expect(configured.documentElement.dataset.hoshidictsTheme).toBe("synthwave");
  });

  it("relays activation-key edges and complete audio profiles", () => {
    const configured = configureBootstrapReader();
    const profile = {
      version: 1,
      enabled: true,
      autoPlay: true,
      volume: 60,
      sources: [{ id: "jisho", type: "jisho", url: "", voice: "" }]
    };

    configured.emit("hoshidicts-activation-key-state", true);
    expect(configured.reader.setActivationKeyPressed).toHaveBeenCalledWith(true);
    configured.emit("hoshidicts-activation-key-state", "nope");
    expect(configured.reader.setActivationKeyPressed).toHaveBeenLastCalledWith(false);

    configured.emit("hoshidicts-audio-preferences", { audioProfile: profile });
    expect(configured.api.getAudioProfile()).toBe(profile);
    expect(configured.reader.updateAudioPreferences).toHaveBeenCalledWith(profile);
    configured.emit("hoshidicts-audio-preferences", null);
    expect(configured.reader.updateAudioPreferences).toHaveBeenCalledTimes(1);
  });

  it("tears the reader down on destroy", () => {
    const configured = configureBootstrapReader();

    configured.api.destroy();

    expect(configured.reader.destroy).toHaveBeenCalled();
    expect(configured.api.getReader()).toBeNull();
    expect(configured.window.gsmHoshidictsReader).toBeNull();
  });

  it("keeps the overlay entry points down to feature includes and two calls", () => {
    const overlayHtml = readOverlayFile("index.html");
    const mainSource = readOverlayFile("main.js");

    for (const include of [
      "features/hoshidicts/constants.js",
      "features/hoshidicts/preferences.js",
      "features/hoshidicts/bootstrap.js"
    ]) {
      expect(overlayHtml).toContain(`<script src="${include}"></script>`);
    }
    expect(overlayHtml.indexOf("features/hoshidicts/audio.js")).toBeLessThan(
      overlayHtml.indexOf("features/hoshidicts/popup.js")
    );
    expect(overlayHtml.indexOf("features/hoshidicts/popup.js")).toBeLessThan(
      overlayHtml.indexOf("features/hoshidicts/reader.js")
    );
    expect(overlayHtml).toContain("GSMHoshidictsBootstrap.attachDesktopBridge({");
    expect(overlayHtml).toContain("GSMHoshidictsBootstrap.initialize(newsettings);");
    // The overlay must not re-validate preferences or rebuild the reader itself.
    expect(overlayHtml).not.toContain("validateHoshidicts");
    expect(overlayHtml).not.toContain("createHoshidictsReader");
    expect(mainSource).toContain("createHoshidictsWindowBridge({");
    expect(mainSource).not.toContain("normalizeHoshidictsReaderPreferences");
  });

  it("sender-validates overlay custom-entry IPC before using the desktop bridge", () => {
    const mainSource = readOverlayFile("main.js");

    expect(mainSource).toContain(
      'ipcMain.handle("hoshidicts-add-custom-entry", async (event, payload)'
    );
    expect(mainSource).toContain("event.sender !== mainWindow.webContents");
    expect(mainSource).toContain("hoshidictsWindowBridge.requestAddCustomEntry");
  });

  it("sender-validates custom website IPC and only opens external URLs", () => {
    const mainSource = readOverlayFile("main.js");

    expect(mainSource).toContain(
      'ipcMain.handle("hoshidicts-open-external", async (event, payload)'
    );
    expect(mainSource).toContain("event.sender !== mainWindow.webContents");
    expect(mainSource).toContain("shell.openExternal");
  });


  it("renders plain HTML-like glossary text literally and allows only text tags", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const parent = dom.window.document.createElement("div");

    api.appendTextOnlyGlossary(
      dom.window.document,
      parent,
      '<img src=x onerror="window.hacked=true"><script>bad()</script>'
    );

    expect(parent.querySelector("img")).toBeNull();
    expect(parent.querySelector("script")).toBeNull();
    expect(parent.textContent).toContain("<img src=x");

    parent.replaceChildren();
    api.appendTextOnlyGlossary(
      dom.window.document,
      parent,
      JSON.stringify([
        { tag: "strong", content: "safe" },
        { tag: "img", path: "ignored.png", data: { alt: "ignored" } },
        { tag: "span", content: [" text"] }
      ])
    );

    expect(parent.querySelector("strong")?.textContent).toBe("safe");
    expect(parent.querySelector("img")).toBeNull();
    expect(parent.textContent).toBe("safe text");
  });

  it("renders Yomitan data attributes and dictionary links while dropping active content", async () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const parent = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(parent);
    const resolveMedia = vi.fn(async () => "blob:reference-image");
    const onInternalLink = vi.fn();
    const onLayoutChange = vi.fn();

    api.appendTextOnlyGlossary(
      dom.window.document,
      parent,
      JSON.stringify({
        type: "structured-content",
        content: [
          { type: "text", text: "Character " },
          {
            tag: "span",
            data: {
              id: "role-badge",
              class: "tag",
              code: "name",
              content: "part-of-speech-info"
            },
            style: {
              background: "#334455",
              borderRadius: "4px",
              color: "#ffffff",
              fontWeight: 700,
              padding: "2px 4px",
              position: "fixed"
            },
            onclick: "window.hacked=true",
            content: "Hero"
          },
          {
            tag: "details",
            content: [
              { tag: "summary", content: "Voice actor" },
              {
                tag: "ul",
                content: [{
                  tag: "li",
                  style: { listStyleType: '"①"' },
                  content: "Example"
                }]
              }
            ]
          },
          {
            tag: "a",
            href: "?query=%E7%8C%AB&wildcards=off&primary_reading=%E3%81%AD%E3%81%93",
            content: "猫"
          },
          { tag: "a", href: "https://example.test/reference", content: "source" },
          { tag: "script", content: "window.hacked=true" },
          {
            tag: "div",
            style: {
              background: "url(file:///secret)",
              color: "expression(alert(1))",
              fontSize: "17em",
              marginTop: "257px",
              paddingLeft: "calc(100vw)"
            },
            content: "still readable"
          },
          {
            type: "image",
            path: "img/character.jpg",
            width: 67,
            height: 100,
            sizeUnits: "px",
            appearance: "monochrome",
            background: false,
            collapsed: true,
            collapsible: true,
            imageRendering: "pixelated",
            title: "Character portrait",
            verticalAlign: "middle",
            data: { alt: "Character portrait" }
          },
          { tag: "img", path: "https://example.test/tracker.png" },
          { tag: "img", path: "../outside.png" }
        ]
      }),
      {
        dictionary: "Character Names",
        generation: 7,
        onInternalLink,
        onLayoutChange,
        resolveMedia
      }
    );
    await flushPromises();

    const badge = parent.querySelector<HTMLElement>('[data-sc-id="role-badge"]')!;
    expect(badge.textContent).toBe("Hero");
    expect(badge.style.background).not.toBe("");
    expect(badge.style.borderRadius).toBe("4px");
    expect(badge.style.fontWeight).toBe("700");
    expect(badge.style.position).toBe("");
    expect(badge.getAttribute("onclick")).toBeNull();
    expect(badge.dataset.scClass).toBe("tag");
    expect(badge.dataset.scCode).toBe("name");
    expect(badge.dataset.scContent).toBe("part-of-speech-info");
    expect(parent.querySelector<HTMLElement>("li")?.style.listStyleType).toBe('"①"');
    const links = parent.querySelectorAll<HTMLAnchorElement>("a.gloss-link");
    expect(links).toHaveLength(2);
    expect(links[0].dataset.hoshidictsQuery).toBe("猫");
    expect(links[0].dataset.hoshidictsReading).toBe("ねこ");
    expect(links[0].getAttribute("href")).toBe("#");
    links[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(onInternalLink).toHaveBeenCalledTimes(1);
    expect(onInternalLink.mock.calls[0][0].anchor).toBe(links[0]);
    expect(onInternalLink.mock.calls[0][0].primaryReading).toBe("ねこ");
    expect(onInternalLink.mock.calls[0][0].query).toBe("猫");
    expect(parent.textContent).toContain("猫");
    expect(links[1].href).toBe("https://example.test/reference");
    expect(links[1].target).toBe("_blank");
    expect(links[1].rel).toContain("noopener");
    expect(parent.textContent).not.toContain("window.hacked");
    const hostile = Array.from(parent.querySelectorAll<HTMLElement>("div"))
      .find((element) => element.textContent === "still readable")!;
    expect(hostile.getAttribute("style")).toBeNull();
    expect(hostile.style.fontSize).toBe("");
    expect(hostile.style.marginTop).toBe("");
    const image = parent.querySelector<HTMLImageElement>("img")!;
    const imageLink = image.closest<HTMLAnchorElement>(".gloss-image-link")!;
    const imageContainer = image.closest<HTMLElement>(".gloss-image-container")!;
    expect(image.alt).toBe("Character portrait");
    expect(image.classList.contains("gloss-image")).toBe(true);
    expect(imageLink.dataset.appearance).toBe("monochrome");
    expect(imageLink.dataset.background).toBe("false");
    expect(imageLink.dataset.collapsed).toBe("true");
    expect(imageLink.dataset.collapsible).toBe("true");
    expect(imageLink.dataset.imageRendering).toBe("pixelated");
    expect(imageLink.dataset.verticalAlign).toBe("middle");
    expect(imageContainer.style.width).toBe("67px");
    expect(imageContainer.style.aspectRatio).toBe("67 / 100");
    expect(imageContainer.title).toBe("Character portrait");
    expect(image.style.width).toBe("100%");
    expect(image.style.height).toBe("100%");
    expect(image.src).toBe("blob:reference-image");
    expect(imageLink.href).toBe("blob:reference-image");
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(resolveMedia).toHaveBeenCalledWith({
      dictionary: "Character Names",
      generation: 7,
      height: 100,
      path: "img/character.jpg",
      width: 67
    });

    parent.querySelector("details")!.dispatchEvent(new dom.window.Event("toggle"));
    image.dispatchEvent(new dom.window.Event("load"));
    image.dispatchEvent(new dom.window.Event("error"));
    expect(image.hidden).toBe(true);
    expect(parent.textContent).toContain("still readable");
    expect(onLayoutChange).toHaveBeenCalledTimes(3);
  });

  it("requests and scopes each dictionary stylesheet once per generation", async () => {
    const { api, dom, first, reader } = createReaderHarness({
      openSocket: false,
      lookupMode: "hover",
      customPopupCss: ":scope { border-radius: 16px; }",
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    await hover(dom, first);
    const lookupRequest = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(lookupResult(
      lookupRequest.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: {
          tag: "span",
          data: { content: "part-of-speech-info" },
          content: "verb"
        }
      }),
      17
    ));

    const stylesRequest = lastRequestOfType(socket, "hoshidicts_styles");
    expect(stylesRequest).toMatchObject({ generation: 17 });
    socket.receive({
      type: "hoshidicts_styles_result",
      requestId: stylesRequest.requestId,
      generation: 17,
      success: true,
      featureDisabled: false,
      staleGeneration: false,
      error: null,
      styles: [{
        dictionary: "JMdict",
        styles: 'span[data-sc-content="part-of-speech-info"] { color: red; }'
      }]
    });

    const glossary = reader.getPopupElement().querySelector<HTMLElement>(
      '.gsm-hoshidicts-glossary-content[data-hoshidicts-dictionary="JMdict"]'
    );
    expect(glossary?.querySelector("[data-sc-content=part-of-speech-info]")?.textContent)
      .toBe("verb");
    const style = dom.window.document.head.querySelector<HTMLStyleElement>(
      'style[data-hoshidicts-dictionary-style="JMdict"]'
    );
    expect(style?.dataset.hoshidictsGeneration).toBe("17");
    expect(style?.textContent).toContain("@scope");
    expect(style?.textContent).toContain('span[data-sc-content="part-of-speech-info"]');

    const customStyle = dom.window.document.head.querySelector<HTMLStyleElement>(
      'style[data-hoshidicts-custom-popup-style="true"]'
    );
    expect(customStyle?.textContent).toContain(
      "@scope (.gsm-hoshidicts-popup) {"
    );
    expect(customStyle?.textContent).toContain(
      ":scope { border-radius: 16px; }"
    );
    expect(style?.nextElementSibling).toBe(customStyle);

    reader.updatePreferences({
      customPopupCss: ".gsm-hoshidicts-expression { color: hotpink; }"
    });
    expect(customStyle?.textContent).toContain("color: hotpink");
    reader.updatePreferences({ customPopupCss: "" });
    expect(customStyle?.isConnected).toBe(false);
    reader.updatePreferences({ customPopupCss: ":scope { opacity: .9; }" });
    expect(customStyle?.isConnected).toBe(true);

    reader.destroy();
    expect(style?.isConnected).toBe(false);
    expect(customStyle?.isConnected).toBe(false);
  });

  it("opens a Jitendex internal definition link in a child popup", async () => {
    const { api, dom, first, reader } = createReaderHarness({
      openSocket: false,
      lookupMode: "hover",
      popupHideDelayMs: 0,
      popupNestingMaxDepth: 2,
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    await hover(dom, first);
    const parentRequest = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(lookupResult(
      parentRequest.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: {
          tag: "a",
          href: "?query=%E7%8C%AB&wildcards=off&primary_reading=%E3%81%AD%E3%81%93",
          content: "猫"
        }
      }),
      4
    ));

    const link = reader.getPopupElement().querySelector<HTMLAnchorElement>(
      "a[data-hoshidicts-query]"
    )!;
    setRect(link, { left: 100, top: 100, right: 130, bottom: 120 });
    dispatchMouse(dom, link, "click");
    const childRequest = lastRequestOfType(socket, "hoshidicts_lookup");
    expect(childRequest.text).toBe("猫");
    expect(childRequest.primaryReading).toBe("ねこ");
    expect(childRequest.requestId).not.toBe(parentRequest.requestId);
    const childResponse = lookupResult(childRequest.requestId, "猫", "alternate", 4);
    childResponse.results[0].term.reading = "ねこ以外";
    const preferred = lookupResult(
      childRequest.requestId,
      "猫",
      "preferred",
      4
    ).results[0];
    preferred.term.reading = "ねこ";
    childResponse.results.push(preferred);
    socket.receive(childResponse);
    // Glossaries after the first entry fill on the next task so the popup can
    // paint first.
    await vi.advanceTimersByTimeAsync(0);

    const popups = reader.getPopupElements();
    expect(popups).toHaveLength(2);
    expect(popups[0].textContent).toContain("猫");
    const childPopup = popups[1] as HTMLElement;
    let childEntries = Array.from(
      childPopup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    );
    expect(childEntries).toHaveLength(1);
    expect(childEntries[0].textContent).toContain("preferred");
    expect(childPopup.querySelector(".gsm-hoshidicts-show-more")?.textContent)
      .toBe("Show 1 more");
    childPopup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")
      ?.click();
    await vi.advanceTimersByTimeAsync(0);
    childEntries = Array.from(
      childPopup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    );
    expect(childEntries).toHaveLength(2);
    expect(childEntries[1].textContent).toContain("alternate");

    setRect(popups[0], { left: 100, top: 100, right: 200, bottom: 300 });
    setRect(popups[1], { left: 206, top: 110, right: 306, bottom: 310 });
    popups[0].dispatchEvent(new dom.window.MouseEvent("pointerenter"));
    popups[0].dispatchEvent(new dom.window.MouseEvent("pointerleave"));
    expect(reader.isVisible()).toBe(true);
    dispatchMouse(dom, dom.window.document.body, "mousemove", { clientX: 203, clientY: 150 });
    await vi.advanceTimersByTimeAsync(500);
    expect(reader.getPopupElements()).toHaveLength(2);
    popups[1].dispatchEvent(new dom.window.MouseEvent("pointerenter"));
    popups[1].dispatchEvent(new dom.window.MouseEvent("pointerleave"));
    popups[0].dispatchEvent(new dom.window.MouseEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(500);
    expect(reader.getPopupElements()).toHaveLength(2);

    dispatchMouse(dom, dom.window.document.body, "mousemove", { clientX: 400, clientY: 400 });
    expect(reader.isVisible()).toBe(false);
  });

  it.each([
    [
      "prefers above the word when the popup fits there",
      { left: 100, right: 140, top: 300, bottom: 330 },
      { width: 200, height: 150 },
      { width: 800, height: 600 },
      undefined,
      { left: 100, top: 146, width: 200, height: 150, placement: "above" }
    ],
    [
      "falls below the word when above cannot fit but below can",
      { left: 100, right: 140, top: 40, bottom: 70 },
      { width: 200, height: 150 },
      { width: 800, height: 600 },
      undefined,
      { left: 100, top: 74, width: 200, height: 150, placement: "below" }
    ],
    [
      "chooses the roomier side above when neither fits",
      { left: 100, right: 140, top: 360, bottom: 380 },
      { width: 200, height: 320 },
      { width: 800, height: 600 },
      undefined,
      { left: 100, top: 36, width: 200, height: 320, placement: "above" }
    ],
    [
      "chooses the roomier side below when neither fits",
      { left: 100, right: 140, top: 200, bottom: 240 },
      { width: 200, height: 320 },
      { width: 800, height: 600 },
      undefined,
      { left: 100, top: 244, width: 200, height: 320, placement: "below" }
    ],
    [
      "clamps beside the anchor at the viewport edge",
      { left: 780, right: 800, top: 570, bottom: 590 },
      { width: 420, height: 300 },
      { width: 800, height: 600 },
      undefined,
      { left: 374, top: 266, width: 420, height: 300, placement: "above" }
    ],
    [
      "stacks vertically when asked",
      { left: 10, right: 30, top: 20, bottom: 80 },
      { width: 300, height: 500 },
      { width: 800, height: 600 },
      { vertical: true },
      { left: 34, top: 20, width: 300, height: 500, placement: "beside" }
    ],
    [
      "keeps a wide popup's size while clamping upwards",
      { left: 320, right: 380, top: 650, bottom: 680 },
      { width: 420, height: 80 },
      { width: 1280, height: 720 },
      undefined,
      { left: 320, top: 566, width: 420, height: 80, placement: "above" }
    ],
    [
      "keeps a tall popup's size while clamping upwards",
      { left: 100, right: 140, top: 130, bottom: 150 },
      { width: 200, height: 250 },
      { width: 500, height: 300 },
      undefined,
      { left: 100, top: 44, width: 200, height: 250, placement: "below" }
    ],
    [
      "shrinks to fit a viewport smaller than the preference",
      { left: 120, right: 160, top: 100, bottom: 130 },
      { width: 560, height: 420 },
      { width: 320, height: 240 },
      undefined,
      { left: 6, top: 6, width: 308, height: 228, placement: "below" }
    ]
  ])("%s", (_label, anchor, size, viewport, options, expected) => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);

    expect(
      api.calculatePopupPosition(anchor, size, viewport, options)
    ).toEqual(expected);
  });

  it("uses one exact popup size instead of a stale measured height", async () => {
    const { dom, first, reader, socket } = createReaderHarness();
    Object.defineProperties(dom.window, {
      innerWidth: { configurable: true, value: 1280 },
      innerHeight: { configurable: true, value: 720 }
    });
    setRect(first, { left: 320, top: 650, right: 380, bottom: 680 });
    const popup = reader.getPopupElement();
    popup.style.maxHeight = "80px";
    popup.style.minHeight = "80px";
    vi.spyOn(popup, "getBoundingClientRect").mockImplementation(() => {
      const height = popup.style.maxHeight === "80px" ? 80 : 400;
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 420,
        bottom: height,
        width: 420,
        height,
        toJSON: () => ({})
      } as DOMRect;
    });

    await hover(dom, first, { shiftKey: true, clientX: 321, clientY: 651 });
    const request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "食べる"));

    expect(popup.style.top).toBe("226px");
    expect(popup.style.width).toBe("560px");
    expect(popup.style.height).toBe("420px");
    expect(popup.style.maxHeight).toBe("none");
    expect(["0", "0px"]).toContain(popup.style.minHeight);
  });

  it("uses the configured local GSM API without a Yomitan bridge", async () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url.endsWith("/status")) {
          return { available: true, model: "Mining" };
        }
        if (url.endsWith("/check")) {
          return {
            success: true,
            duplicateBehavior: "prevent",
            results: [{ state: "addable", canAdd: true, duplicate: false }]
          };
        }
        return { success: true, noteId: 42, requestBody: init.body };
      }
    }));

    expect(
      api.resolveGsmApiBaseUrl({
        texthookerUrl: "http://127.0.0.1:8123/texthooker"
      })
    ).toBe("http://127.0.0.1:8123");
    expect(
      api.resolveGsmApiBaseUrl({
        weburl1: "ws://localhost:8124/ws/plaintext"
      })
    ).toBe("http://localhost:8124");
    expect(
      api.resolveGsmApiBaseUrl({
        texthookerUrl: "https://example.test/texthooker"
      })
    ).toBe("http://127.0.0.1:7275");

    const client = api.createHoshidictsMiningClient({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchMock
    });
    await expect(client.getStatus()).resolves.toMatchObject({
      available: true
    });
    const duplicateCheck = { notes: [{ sentence: "食べる" }] };
    await expect(client.check(duplicateCheck)).resolves.toMatchObject({
      success: true,
      duplicateBehavior: "prevent"
    });
    await expect(client.mine({ sentence: "食べる" })).resolves.toMatchObject({
      success: true,
      noteId: 42
    });
    await expect(client.browse({ word: "食べる" })).resolves.toMatchObject({
      success: true
    });
    const lookupClient = api.createHoshidictsLookupStatsClient({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchMock
    });
    await expect(
      lookupClient.record({ term: "食べる", reading: "たべる" })
    ).resolves.toMatchObject({ success: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8123/api/hoshidicts/mining/status",
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8123/api/hoshidicts/mining/check",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(duplicateCheck)
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8123/api/hoshidicts/mine",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sentence: "食べる" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8123/api/hoshidicts/mining/browse",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ word: "食べる" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8123/api/hoshidicts/lookup-stats",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ term: "食べる", reading: "たべる" }),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("preserves structured duplicate errors from the mining API", async () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const client = api.createHoshidictsMiningClient({
      fetch: vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({
          success: false,
          code: "duplicate",
          error: "This note already exists."
        })
      }))
    });

    await expect(client.mine({ sentence: "食べる" })).rejects.toMatchObject({
      code: "duplicate",
      message: "This note already exists.",
      status: 409
    });
  });

  it("serializes lookup-stat writes per canonical term while keeping other terms concurrent", async () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = deferred<Response>();
    const different = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => different.promise)
      .mockImplementationOnce(() => second.promise);
    const response = (lookupCount: number) => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, lookupCount })
    }) as Response;
    const client = api.createHoshidictsLookupStatsClient({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchMock
    });

    const firstLookup = client.record({ term: " が ", reading: " ガ " });
    const secondLookup = client.record({ term: "か\u3099", reading: "カ\u3099" });
    const differentLookup = client.record({ term: "飲む", reading: "のむ" });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    first.resolve(response(4));
    different.resolve(response(1));
    await expect(firstLookup).resolves.toMatchObject({ lookupCount: 4 });
    await expect(differentLookup).resolves.toMatchObject({ lookupCount: 1 });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ term: "が", reading: "ガ" })
    }));
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ term: "が", reading: "ガ" })
    }));

    second.resolve(response(5));
    await expect(secondLookup).resolves.toMatchObject({ lookupCount: 5 });
  });
});

describe("Hoshidicts compact definition summaries", () => {
  it("normalizes the preferred dictionary as null or a bounded non-empty title", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);

    expect(api.normalizeCompactDefinitionSummaryDictionary(null)).toBeNull();
    expect(api.normalizeCompactDefinitionSummaryDictionary("  Jitendex  "))
      .toBe("Jitendex");
    expect(api.normalizeCompactDefinitionSummaryDictionary("   ")).toBeNull();
    expect(api.normalizeCompactDefinitionSummaryDictionary(true)).toBeNull();
    expect(api.normalizeCompactDefinitionSummaryDictionary("x".repeat(4097)))
      .toBeNull();
    expect(api.normalizeCompactDefinitionSummaryCount(undefined)).toBe(3);
    expect(api.normalizeCompactDefinitionSummaryCount(5)).toBe(5);
    expect(api.normalizeCompactDefinitionSummaryCount(0)).toBe(3);
    expect(api.normalizeCompactDefinitionSummaryCount(7)).toBe(3);
  });

  it("keeps compact summaries strictly opt-in", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries[0].glossary = JSON.stringify([
          "to eat",
          "to consume"
        ]);
      }
    });

    expect(harness.reader.getPreferences().showCompactDefinitionSummary)
      .toBe(false);
    expect(harness.reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-compact-definition-summary"
    )).toBeNull();
  });

  it("renders the chosen number of items while retaining the complete card", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true
    });
    const definitions = Array.from(
      { length: 8 },
      (_, index) => `definition ${index + 1}`
    );
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries[0].glossary =
          JSON.stringify(definitions);
      }
    });

    const popup = harness.reader.getPopupElement();
    let summary = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(harness.reader.getPreferences().compactDefinitionSummaryCount)
      .toBe(3);
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(definitions.slice(0, 3));
    expect(Array.from(summary.textContent ?? "")).toHaveLength(
      definitions.slice(0, 3).join("").length
    );

    harness.reader.updatePreferences({ compactDefinitionSummaryCount: 5 });
    summary = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(definitions.slice(0, 5));
    const fullCard = popup.querySelector(".gsm-hoshidicts-glossary-card");
    expect(fullCard).not.toBeNull();
    expect(fullCard?.querySelector(".gsm-hoshidicts-glossary-content")?.textContent)
      .toContain("definition 8");
  });

  it("counts bullet-separated text as separate compact definition items", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 2
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries[0].glossary =
          "Male •  16 years • 175cm • 65kg • Birthday: February 6";
      }
    });

    const popup = harness.reader.getPopupElement();
    const summary = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(["Male", "16 years"]);
    expect(popup.querySelector(".gsm-hoshidicts-glossary-content")?.textContent)
      .toBe("Male •  16 years • 175cm • 65kg • Birthday: February 6");
  });

  it("handles very large bullet-separated compact definition text without overflowing the stack", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 2
    });
    const hugeGlossary = Array.from(
      { length: 130_000 },
      (_, index) => `item ${index}`
    ).join(" • ");
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries[0].glossary = hugeGlossary;
      }
    });

    const summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(["item 0", "item 1"]);
  });

  it("drops empty items from bullet-separated compact definition text", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries[0].glossary =
          "• Male •• 16 years •";
      }
    });

    const summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(["Male", "16 years"]);
  });

  it("truncates the compact text budget without truncating the full definition", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true
    });
    const longDefinitions = ["x".repeat(239), "unabridged definition"];
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries[0].glossary =
          JSON.stringify(longDefinitions);
      }
    });

    const popup = harness.reader.getPopupElement();
    const compactText = popup.querySelector(
      ".gsm-hoshidicts-compact-definition-summary"
    )?.textContent ?? "";
    expect(Array.from(compactText)).toHaveLength(240);
    expect(compactText.endsWith("…")).toBe(true);
    expect(popup.querySelector(".gsm-hoshidicts-glossary-content")?.textContent)
      .toBe(longDefinitions.join(""));
  });

  it("prioritizes Jitendex glossary nodes without copying POS or examples", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      compactDefinitionSummaryDictionary: "Jitendex"
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        const jitendexGlossary = JSON.stringify({
          type: "structured-content",
          content: [
            {
              tag: "span",
              data: { content: "part-of-speech-info" },
              content: "noun"
            },
            {
              tag: "ul",
              data: { content: "glossary" },
              content: [
                { tag: "li", content: "rash; thoughtless" },
                { tag: "li", content: "careless; hasty; imprudent" }
              ]
            },
            {
              tag: "div",
              data: { content: "example-sentence" },
              content: "He acted rashly."
            }
          ]
        });
        response.results[0].term.glossaries = [
          {
            dictionary: "JMdict",
            glossary: JSON.stringify(["first dictionary definition"]),
            definitionTags: "",
            termTags: ""
          },
          {
            dictionary: "Jitendex",
            glossary: jitendexGlossary,
            definitionTags: "",
            termTags: ""
          }
        ];
      }
    });

    const summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual([
        "rash; thoughtless",
        "careless; hasty; imprudent"
      ]);
    expect(summary.dataset.hoshidictsDictionary).toBe("Jitendex");
    expect(summary.textContent).not.toContain("noun");
    expect(summary.textContent).not.toContain("He acted rashly");
    expect(summary.querySelector("a, img, ruby, span")).toBeNull();
  });

  it("shows a tiny image from the dictionary chosen for the compact definition", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryDictionary: "Illustrated Dictionary"
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries = [
          {
            dictionary: "Other Dictionary",
            glossary: JSON.stringify({
              type: "structured-content",
              content: [
                { type: "image", path: "img/other.jpg", width: 200, height: 100 },
                { tag: "p", content: "other definition" }
              ]
            }),
            definitionTags: "",
            termTags: ""
          },
          {
            dictionary: "Illustrated Dictionary",
            glossary: JSON.stringify({
              type: "structured-content",
              content: [
                {
                  type: "image",
                  path: "img/chosen.jpg",
                  width: 320,
                  height: 180,
                  data: { alt: "Chosen illustration" }
                },
                { tag: "p", content: "chosen definition" }
              ]
            }),
            definitionTags: "",
            termTags: ""
          }
        ];
      }
    });

    const summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(summary.dataset.hoshidictsDictionary).toBe("Illustrated Dictionary");
    expect(summary.textContent).toContain("chosen definition");
    const image = summary.querySelector<HTMLImageElement>(
      ".gsm-hoshidicts-compact-definition-image img"
    )!;
    expect(image).not.toBeNull();
    expect(image.alt).toBe("Chosen illustration");
    expect(image.closest<HTMLElement>(".gloss-image-link")?.dataset.path)
      .toBe("img/chosen.jpg");
    expect(
      readerCssRule(".gsm-hoshidicts-compact-definition-image .gloss-image-container")
    ).toContain("width: 36px");
    expect(
      readerCssRule(".gsm-hoshidicts-compact-definition-image .gloss-image-container")
    ).toContain("height: 36px");
    expect(
      readerCssRule(".gsm-hoshidicts-compact-definition-summary")
    ).toContain("align-self: flex-end");
  });

  it("supports plain JMdict JSON strings and arrays", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      compactDefinitionSummaryDictionary: "JMdict"
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries = [
          {
            dictionary: "JMdict",
            glossary: JSON.stringify("plain definition"),
            definitionTags: "",
            termTags: ""
          },
          {
            dictionary: "JMdict",
            glossary: JSON.stringify(["array alternative", "another sense"]),
            definitionTags: "",
            termTags: ""
          }
        ];
      }
    });

    const summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(["plain definition", "array alternative", "another sense"]);
  });

  it("supports generic structured lists without dictionary-specific markers", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      compactDefinitionSummaryDictionary: "Generic structured dictionary"
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        const glossary = response.results[0].term.glossaries[0];
        glossary.dictionary = "Generic structured dictionary";
        glossary.glossary = JSON.stringify({
          type: "structured-content",
          content: {
            tag: "section",
            content: {
              tag: "ol",
              content: [
                { tag: "li", content: "generic first sense" },
                { tag: "li", content: "generic second sense" }
              ]
            }
          }
        });
      }
    });

    const summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(summary.dataset.hoshidictsDictionary)
      .toBe("Generic structured dictionary");
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(["generic first sense", "generic second sense"]);
  });

  it("falls back to the first extractable dictionary when preferred is absent or unusable", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      compactDefinitionSummaryDictionary: "Missing dictionary"
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.glossaries = [
          {
            dictionary: "JMdict",
            glossary: JSON.stringify(["usable fallback"]),
            definitionTags: "",
            termTags: ""
          },
          {
            dictionary: "Broken dictionary",
            glossary: "null",
            definitionTags: "",
            termTags: ""
          },
          {
            dictionary: "Third dictionary",
            glossary: "third definition",
            definitionTags: "",
            termTags: ""
          }
        ];
      }
    });

    let summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(summary.dataset.hoshidictsDictionary).toBe("JMdict");
    expect(summary.textContent).toBe("usable fallback");

    harness.reader.updatePreferences({
      compactDefinitionSummaryDictionary: "Broken dictionary"
    });
    summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(summary.dataset.hoshidictsDictionary).toBe("JMdict");
    expect(summary.textContent).toBe("usable fallback");
  });

  it("falls back to leaf definition blocks for monolingual dictionaries", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      compactDefinitionSummaryDictionary: "国語辞典"
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        const monoGlossary = JSON.stringify({
          type: "structured-content",
          content: [
            {
              tag: "span",
              data: { content: "part-of-speech-info" },
              content: "形容動詞"
            },
            {
              tag: "div",
              content: [
                { tag: "span", content: "言動が" },
                {
                  tag: "ruby",
                  content: ["軽", { tag: "rt", content: "かる" }]
                },
                { tag: "span", content: "く" },
                "、",
                { tag: "span", content: "慎重さを欠く" },
                { tag: "span", content: "さま。" }
              ]
            },
            {
              tag: "div",
              data: { content: "example-sentence" },
              content: "軽率な行動を慎む。"
            }
          ]
        });
        response.results[0].term.glossaries = [
          {
            dictionary: "JMdict",
            glossary: JSON.stringify(["careless"]),
            definitionTags: "",
            termTags: ""
          },
          {
            dictionary: "国語辞典",
            glossary: monoGlossary,
            definitionTags: "",
            termTags: ""
          }
        ];
      }
    });

    const summary = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(summary.dataset.hoshidictsDictionary).toBe("国語辞典");
    expect(Array.from(summary.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(["言動が軽く、慎重さを欠くさま。"]);
    expect(summary.textContent).not.toContain("かる");
    expect(summary.textContent).not.toContain("形容動詞");
    expect(summary.textContent).not.toContain("軽率な行動を慎む");
  });

  it("shares the popup definition-blur state and transition behavior", () => {
    const css = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "GSM_Overlay/features/hoshidicts/reader.css"
      ),
      "utf8"
    );
    expect(css).toMatch(
      /data-definition-blur-state="pending"[^{}]*compact-definition-summary[^{]*\{[^}]*filter:\s*blur\(5px\)/u
    );
    expect(css).toMatch(
      /prefers-reduced-motion:[^{]+\{[\s\S]*?compact-definition-summary[^{}]*\{[^}]*transition:\s*none/u
    );
  });
});

describe("Hoshidicts definition blur", () => {
  it("does not autoplay audio for a word whose definitions are blurred", async () => {
    const audioController = createAudioControllerStub();
    const { api, dom, first, reader, socket } = createReaderHarness({
      audioController,
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "hover",
        revealDelayMs: 5000
      },
      onLookup: async () => ({ success: true, lookupCount: 5 }),
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "食べる"));

    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBe("blurred");
    expect(audioController.setRenderedResults).toHaveBeenCalled();
    expect(audioController.setRenderedResults.mock.calls.some(
      ([, options]) => options?.autoPlay === true
    )).toBe(false);
  });

  it("renders every definition pending and fails open below the lookup threshold", async () => {
    const lookupRecord = deferred<{ success: boolean; lookupCount: number }>();
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup: () => lookupRecord.promise,
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    const response = lookupResult(request.requestId, "食べる");
    response.results[0].term.glossaries.push({
      dictionary: "Second dictionary",
      glossary: "consume",
      definitionTags: "",
      termTags: ""
    });
    response.results = Array.from({ length: 7 }, (_, index) => ({
      ...response.results[0],
      term: {
        ...response.results[0].term,
        expression: `語${index}`,
        reading: `ご${index}`
      }
    }));
    socket.receive(response);

    const popup = reader.getPopupElement();
    let definitions = Array.from<HTMLElement>(
      popup.querySelectorAll(".gsm-hoshidicts-definitions")
    );
    expect(definitions).toHaveLength(2);
    expect(popup.querySelectorAll(".gsm-hoshidicts-entry")).toHaveLength(1);
    expect(popup.querySelectorAll(".gsm-hoshidicts-entry[hidden]")).toHaveLength(0);
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === "pending"
    )).toBe(true);
    expect(popup.dataset.definitionBlurState).toBe("pending");
    expect(popup.querySelector(
      ".gsm-hoshidicts-compact-definition-summary"
    )).not.toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-expression")).not.toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-expression")?.closest(
      ".gsm-hoshidicts-definitions"
    )).toBeNull();
    expect(popup.querySelector("summary")?.textContent).toBe("JMdict");

    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")!.click();
    definitions = Array.from<HTMLElement>(
      popup.querySelectorAll(".gsm-hoshidicts-definitions")
    );
    expect(definitions).toHaveLength(14);
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === "pending"
    )).toBe(true);

    lookupRecord.resolve({ success: true, lookupCount: 4 });
    await flushPromises();
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === undefined
    )).toBe(true);
    expect(popup.dataset.definitionBlurState).toBeUndefined();
  });

  it("reveals at the timed deadline measured from popup display at the threshold", async () => {
    const lookupRecord = deferred<{ success: boolean; lookupCount: number }>();
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup: () => lookupRecord.promise,
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    socket.receive(lookupResult(request.requestId, "食べる"));
    const definitions = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )!;
    expect(definitions.dataset.definitionBlurState).toBe("pending");

    await vi.advanceTimersByTimeAsync(3000);
    lookupRecord.resolve({ success: true, lookupCount: 5 });
    await flushPromises();
    expect(definitions.dataset.definitionBlurState).toBe("blurred");
    await vi.advanceTimersByTimeAsync(1999);
    expect(definitions.dataset.definitionBlurState).toBe("blurred");
    await vi.advanceTimersByTimeAsync(1);
    expect(definitions.dataset.definitionBlurState).toBeUndefined();

    reader.hide("next-lookup");
    await hover(dom, first);
    const nextRequest = lastRequest(socket);
    await respond(socket, lookupResult(nextRequest.requestId, "食べる"));
    const nextDefinitions = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )!;
    expect(nextDefinitions.dataset.definitionBlurState).toBe("blurred");
    reader.updatePreferences({ definitionBlur: { enabled: false } });
    expect(nextDefinitions.dataset.definitionBlurState).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(nextDefinitions.dataset.definitionBlurState).toBeUndefined();
  });

  it("lets the timed deadline win over a slow lookup-count response", async () => {
    const lookupRecord = deferred<{ success: boolean; lookupCount: number }>();
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 1000
      },
      onLookup: () => lookupRecord.promise,
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    socket.receive(lookupResult(request.requestId, "食べる"));
    const definitions = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )!;
    expect(definitions.dataset.definitionBlurState).toBe("pending");

    await vi.advanceTimersByTimeAsync(1000);
    expect(definitions.dataset.definitionBlurState).toBeUndefined();

    lookupRecord.resolve({ success: true, lookupCount: 5 });
    await flushPromises();
    expect(definitions.dataset.definitionBlurState).toBeUndefined();
  });

  it("always reveals on hover while keeping the timed fallback optional", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup: async () => ({ success: true, lookupCount: 8 }),
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    const response = lookupResult(request.requestId, "食べる");
    response.results[0].term.glossaries.push({
      dictionary: "Second dictionary",
      glossary: "consume",
      definitionTags: "",
      termTags: ""
    });
    await respond(socket, response);

    const definitions = Array.from<HTMLElement>(
      reader.getPopupElement().querySelectorAll(".gsm-hoshidicts-definitions")
    );
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === "blurred"
    )).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === "blurred"
    )).toBe(true);
    const compactSummary = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(compactSummary).not.toBeNull();
    dispatchPlain(dom, compactSummary, "pointerover");
    dispatchPlain(dom, compactSummary, "pointerout");
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === undefined
    )).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === undefined
    )).toBe(true);

    reader.hide("hover-only");
    reader.updatePreferences({
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "hover",
        revealDelayMs: 5000
      }
    });
    await hover(dom, first);
    const nextRequest = lastRequest(socket);
    await respond(socket, lookupResult(nextRequest.requestId, "食べる"));
    const hoverOnlyDefinitions = Array.from<HTMLElement>(
      reader.getPopupElement().querySelectorAll(".gsm-hoshidicts-definitions")
    );
    expect(hoverOnlyDefinitions.every(
      (element) => element.dataset.definitionBlurState === "blurred"
    )).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(hoverOnlyDefinitions.every(
      (element) => element.dataset.definitionBlurState === "blurred"
    )).toBe(true);
    hoverOnlyDefinitions[0].dispatchEvent(
      new dom.window.Event("pointerover", { bubbles: true })
    );
    expect(hoverOnlyDefinitions.every(
      (element) => element.dataset.definitionBlurState === undefined
    )).toBe(true);
  });

  it("fails open on a lookup-stat error and ignores a stale popup response", async () => {
    const staleRecord = deferred<{ success: boolean; lookupCount: number }>();
    const currentRecord = deferred<{ success: boolean; lookupCount: number }>();
    const onLookup = vi.fn()
      .mockReturnValueOnce(staleRecord.promise)
      .mockReturnValueOnce(currentRecord.promise);
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup,
    });
    const moveToFirst = () => dispatchMouse(dom, first, "mousemove", { clientX: 11, clientY: 11 });

    moveToFirst();
    await vi.advanceTimersByTimeAsync(20);
    let request = lastRequest(socket);
    socket.receive(lookupResult(request.requestId, "old"));
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBe("pending");

    reader.hide("replaced");
    moveToFirst();
    await vi.advanceTimersByTimeAsync(20);
    request = lastRequest(socket);
    socket.receive(lookupResult(request.requestId, "new"));
    currentRecord.resolve({ success: true, lookupCount: 5 });
    await flushPromises();
    const currentDefinitions = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )!;
    expect(currentDefinitions.dataset.definitionBlurState).toBe("blurred");

    staleRecord.resolve({ success: true, lookupCount: 1 });
    await flushPromises();
    expect(currentDefinitions.dataset.definitionBlurState).toBe("blurred");

    reader.hide("network-error");
    onLookup.mockRejectedValueOnce(new Error("offline"));
    moveToFirst();
    await vi.advanceTimersByTimeAsync(20);
    request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "error"));
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBeUndefined();

    reader.hide("invalid-response");
    onLookup.mockResolvedValueOnce({ success: true, lookupCount: "five" });
    moveToFirst();
    await vi.advanceTimersByTimeAsync(20);
    request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "invalid"));
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBeUndefined();
  });

});

describe("Hoshidicts dictionary tabs", () => {
  function createLookupHarness(options: Record<string, unknown> = {}) {
    const { api, dom, first, reader, second, socket } = createReaderHarness({
      lookupMode: "hover",
      ...options
    });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });

    async function lookup(
      buildResponse: (requestId: string) => ReturnType<typeof lookupResult>,
      target: Element = first
    ) {
      await hover(dom, target, { clientX: target === second ? 31 : 11 });
      const request = lastRequest(socket);
      const response = buildResponse(request.requestId);
      if (!Object.prototype.hasOwnProperty.call(options, "dictionaryPresentation")) {
        const titles = Array.from(new Set(
          response.results.flatMap((result) =>
            result.term.glossaries.map((glossary) => glossary.dictionary)
          )
        ));
        reader.updatePreferences({
          dictionaryPresentation: titles.map((title) => ({
            title,
            favorite: true
          }))
        });
      }
      socket.receive(response);
      return { popup: reader.getPopupElement(), request, response };
    }

    return { dom, first, lookup, reader, second, socket };
  }

  it("projects summaries with tabs and toggles them live without a new lookup", async () => {
    const audioController = createAudioControllerStub();
    const { lookup, reader, socket } = createLookupHarness({
      audioController,
      dictionaryPresentation: [
        { title: "Main", favorite: true },
        { title: "Backup", favorite: true }
      ],
      showCompactDefinitionSummary: false,
      compactDefinitionSummaryCount: 3,
      compactDefinitionSummaryDictionary: "Main"
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        {
          dictionary: "Main",
          glossary: JSON.stringify(["main definition", "main alternative"])
        },
        {
          dictionary: "Backup",
          glossary: JSON.stringify(["backup definition"])
        }
      ])
    );
    const sentBeforeToggle = socket.sent.length;
    expect(popup.querySelector(
      ".gsm-hoshidicts-compact-definition-summary"
    )).toBeNull();

    Array.from(popup.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "Backup")
      ?.click();
    const audioCallsBeforeToggle =
      audioController.setRenderedResults.mock.calls.length;
    reader.updatePreferences({ showCompactDefinitionSummary: true });

    expect(socket.sent).toHaveLength(sentBeforeToggle);
    expect(reader.getPreferences().showCompactDefinitionSummary).toBe(true);
    const summaries = popup.querySelectorAll<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].dataset.hoshidictsDictionary).toBe("Backup");
    expect(summaries[0].textContent).toBe("backup definition");
    expect(popup.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toBe("Backup");
    expect(audioController.setRenderedResults.mock.calls).toHaveLength(
      audioCallsBeforeToggle + 1
    );
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: false });
    expect(popup.querySelector(".gsm-hoshidicts-glossary-card")).not.toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-glossary-content")?.textContent)
      .toBe("backup definition");

    reader.updatePreferences({ showCompactDefinitionSummary: false });

    expect(socket.sent).toHaveLength(sentBeforeToggle);
    expect(popup.querySelector(
      ".gsm-hoshidicts-compact-definition-summary"
    )).toBeNull();
    expect(popup.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toBe("Backup");
  });

  it("switches the preferred summary live without lookup or audio autoplay", async () => {
    const audioController = createAudioControllerStub();
    const { lookup, reader, socket } = createLookupHarness({
      audioController,
      dictionaryPresentation: [
        { title: "Main", favorite: true },
        { title: "Backup", favorite: true }
      ],
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryCount: 3,
      compactDefinitionSummaryDictionary: "Main"
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        {
          dictionary: "Main",
          glossary: JSON.stringify(["main definition"])
        },
        {
          dictionary: "Backup",
          glossary: JSON.stringify(["backup definition"])
        }
      ])
    );
    const sentBeforeSwitch = socket.sent.length;
    const audioCallsBeforeSwitch =
      audioController.setRenderedResults.mock.calls.length;

    expect(popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )?.dataset.hoshidictsDictionary).toBe("Main");
    expect(popup.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toBe("All");

    reader.updatePreferences({
      compactDefinitionSummaryDictionary: "Backup"
    });

    expect(socket.sent).toHaveLength(sentBeforeSwitch);
    expect(reader.getPreferences().compactDefinitionSummaryDictionary)
      .toBe("Backup");
    const summary = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )!;
    expect(summary.dataset.hoshidictsDictionary).toBe("Backup");
    expect(summary.textContent).toBe("backup definition");
    expect(popup.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toBe("All");
    expect(audioController.setRenderedResults.mock.calls).toHaveLength(
      audioCallsBeforeSwitch + 1
    );
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: false });

    expect(socket.sent).toHaveLength(sentBeforeSwitch);

    reader.updatePreferences({ compactDefinitionSummaryDictionary: null });
    expect(reader.getPreferences().compactDefinitionSummaryDictionary).toBeNull();
    expect(popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-compact-definition-summary"
    )?.dataset.hoshidictsDictionary).toBe("Main");
    expect(socket.sent).toHaveLength(sentBeforeSwitch);
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: false });
  });

  it("expands repeated word, sentence, and mining blob placeholders independently", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const blob = {
      result: { term: { expression: "食べる" } },
      sentence: "私は 食べる。",
      matchOffset: 3
    };
    expect(api.expandPopupButtonUrl(
      "https://example.test/?w=%w&w2=%w&s=%s&s2=%s&blob=%blob&blob2=%blob",
      { word: "食べる/食う", sentence: "私は 食べる。", blob }
    )).toBe(
      "https://example.test/?w=%E9%A3%9F%E3%81%B9%E3%82%8B%2F%E9%A3%9F%E3%81%86" +
      "&w2=%E9%A3%9F%E3%81%B9%E3%82%8B%2F%E9%A3%9F%E3%81%86" +
      "&s=%E7%A7%81%E3%81%AF%20%E9%A3%9F%E3%81%B9%E3%82%8B%E3%80%82" +
      "&s2=%E7%A7%81%E3%81%AF%20%E9%A3%9F%E3%81%B9%E3%82%8B%E3%80%82" +
      `&blob=${encodeURIComponent(JSON.stringify(blob))}` +
      `&blob2=${encodeURIComponent(JSON.stringify(blob))}`
    );
  });

  it("sends the complete Anki mining payload through the blob placeholder", async () => {
    const onOpenExternalLink = vi.fn(async (_url: string) => ({ opened: true }));
    const mine = vi.fn(async (_payload: Record<string, unknown>) => ({
      success: true,
      noteId: 123
    }));
    const { lookup } = createLookupHarness({
      popupButtons: {
        addToAnki: true,
        audio: false,
        customDefinition: false,
        viewInAnki: false,
        customLinks: [{
          label: "Bridge",
          url: "https://bridge.example/import?payload=%blob"
        }]
      },
      getMiningStatus: async () => ({ available: true }),
      onMine: mine,
      onOpenExternalLink
    });
    const { popup } = await lookup((requestId) =>
      lookupResult(requestId, "食べる")
    );
    await flushPromises();

    popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-external-link-button"
    )!.click();
    await flushPromises();
    popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-mine-button"
    )!.click();
    await flushPromises();
    await flushPromises();

    const openedUrl = new URL(onOpenExternalLink.mock.calls[0][0]);
    expect(JSON.parse(openedUrl.searchParams.get("payload")!))
      .toEqual(mine.mock.calls[0][0]);
  });

  it("keeps custom link actions at least as large as icon actions", () => {
    const declarations = readerCssRule(".gsm-hoshidicts-text-action-button");

    expect(declarations).toMatch(/min-width:\s*36px/u);
    expect(declarations).toMatch(/min-height:\s*36px/u);
  });

  it("keeps popup actions in fixed order and rerenders them live", async () => {
    const onBrowse = vi.fn(async () => ({ success: true }));
    const onOpenExternalLink = vi.fn(async () => ({ opened: true }));
    const popupButtons = {
      addToAnki: true,
      audio: true,
      customDefinition: true,
      viewInAnki: true,
      customLinks: [
        {
          label: "Jisho",
          url: "https://jisho.org/search/%w?sentence=%s"
        }
      ]
    };
    const { lookup, reader } = createLookupHarness({
      popupButtons,
      onBrowse,
      onOpenExternalLink
    });
    const { popup } = await lookup((requestId) =>
      lookupResult(requestId, "食べる")
    );
    await flushPromises();

    const actionNames = () => Array.from(
      popup.querySelector(".gsm-hoshidicts-primary-header " +
        ".gsm-hoshidicts-entry-actions")!.children,
      (element) => element.className
    );
    expect(actionNames()).toEqual([
      "gsm-hoshidicts-mine-button",
      "gsm-hoshidicts-audio-button",
      "gsm-hoshidicts-note-button",
      "gsm-hoshidicts-view-in-anki-button gsm-hoshidicts-text-action-button",
      "gsm-hoshidicts-external-link-button gsm-hoshidicts-text-action-button"
    ]);

    popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-view-in-anki-button"
    )!.click();
    await flushPromises();
    expect(onBrowse).toHaveBeenCalledWith({ word: "食べる" });
    expect(popup.querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toBe("Opened in Anki.");

    popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-external-link-button"
    )!.click();
    await flushPromises();
    expect(onOpenExternalLink).toHaveBeenCalledOnce();
    expect(onOpenExternalLink).toHaveBeenCalledWith(
      "https://jisho.org/search/%E9%A3%9F%E3%81%B9%E3%82%8B" +
        "?sentence=%E9%A3%9F%E3%81%B9%E3%82%8B"
    );

    reader.updatePreferences({
      popupButtons: {
        addToAnki: false,
        audio: false,
        customDefinition: false,
        viewInAnki: false,
        customLinks: [
          { label: "Weblio", url: "https://example.test/%w" }
        ]
      }
    });
    expect(actionNames()).toEqual([
      "gsm-hoshidicts-external-link-button gsm-hoshidicts-text-action-button"
    ]);
    expect(popup.querySelector(".gsm-hoshidicts-external-link-button")?.textContent)
      .toBe("Weblio");
  });

  it("clones ordered frequency dictionary preferences on the way out", () => {
    const { reader } = createLookupHarness({
      frequencyDictionaries: ["Foo", "Foo!"]
    });

    const firstSnapshot = reader.getPreferences();
    expect(firstSnapshot.frequencyDictionaries).toEqual(["Foo", "Foo!"]);
    firstSnapshot.frequencyDictionaries.push("Mutated outside reader");
    expect(reader.getPreferences().frequencyDictionaries).toEqual([
      "Foo",
      "Foo!"
    ]);

    reader.updatePreferences({ frequencyDictionaries: ["Foo!", "Foo"] });
    expect(reader.getPreferences().frequencyDictionaries).toEqual([
      "Foo!",
      "Foo"
    ]);
  });

  it("includes every configured frequency dictionary in duplicate and mining payloads", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicateBehavior: "prevent",
      results: payload.notes.map(() => ({
        state: "addable",
        canAdd: true,
        duplicate: false
      }))
    }));
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const { lookup, reader } = createLookupHarness({
      checkMiningNotes,
      frequencyDictionaries: ["Foo", "Foo!"],
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" }
      ]);
      response.results[0].term.frequencies = [{
        dictionary: "Foo",
        frequencies: [{ value: 7, displayValue: "7 rank" }]
      }];
      return response;
    });
    await flushPromises();

    expect(
      checkMiningNotes.mock.calls.at(-1)?.[0].notes[0].frequencyDictionaries
    ).toEqual(["Foo", "Foo!"]);

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();
    await flushPromises();

    expect(mine.mock.calls[0][0].frequencyDictionaries).toEqual([
      "Foo",
      "Foo!"
    ]);
    expect(mine.mock.calls[0][0].result.term.frequencies).toEqual([{
      dictionary: "Foo",
      frequencies: [{ value: 7, displayValue: "7 rank" }]
    }]);
  });

  it("shows a fresh reader without tabs when presentation is undefined", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      dictionaryPresentation: undefined
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        const glossary = response.results[0].term.glossaries[0];
        response.results[0].term.glossaries = [
          { ...glossary, dictionary: "Primary", glossary: "primary" },
          { ...glossary, dictionary: "Secondary", glossary: "secondary" }
        ];
      }
    });

    const popup = harness.reader.getPopupElement();
    expect(harness.reader.getPreferences().dictionaryPresentation).toEqual([]);
    expect(popup.querySelector('[role="tablist"]')).toBeNull();
    expect(popup.querySelector('[role="tab"]')).toBeNull();
    expect(popup.querySelector('[role="tabpanel"]')).toBeNull();
    const glossaryGrid = popup.querySelector(".gsm-hoshidicts-glossary-grid");
    expect(glossaryGrid).not.toBeNull();
    expect(glossaryGrid?.children).toHaveLength(2);
    expect(
      Array.from(glossaryGrid?.children ?? []).every((element) =>
        element.classList.contains("gsm-hoshidicts-glossary-card")
      )
    ).toBe(true);
  });

  it("packs uneven dictionary cards into the shortest popup column", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      popupColumns: 2,
      dictionaryPresentation: undefined
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        const glossary = response.results[0].term.glossaries[0];
        response.results[0].term.glossaries = [
          { ...glossary, dictionary: "Tall", glossary: "tall" },
          { ...glossary, dictionary: "Short", glossary: "short" },
          { ...glossary, dictionary: "Next", glossary: "next" }
        ];
      }
    });

    const popup = harness.reader.getPopupElement();
    const glossaryGrid = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-grid"
    )!;
    const cards = Array.from(
      glossaryGrid.children
    ) as HTMLElement[];
    Object.defineProperty(glossaryGrid, "clientWidth", {
      configurable: true,
      value: 408
    });
    [200, 80, 60].forEach((height, index) => {
      Object.defineProperty(cards[index], "offsetHeight", {
        configurable: true,
        value: height
      });
    });

    harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
    await vi.advanceTimersByTimeAsync(20);

    expect(cards.map((card) => card.style.width)).toEqual([
      "200px",
      "200px",
      "200px"
    ]);
    expect(cards.map((card) => card.style.transform)).toEqual([
      "translate(0px, 0px)",
      "translate(208px, 0px)",
      "translate(208px, 88px)"
    ]);
    expect(glossaryGrid.style.height).toBe("200px");
  });

  it("renders one large lookup response without dropping dictionaries or glossary text", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      dictionaryPresentation: undefined
    });
    const tailMarker = "FIRST_DICTIONARY_TAIL";
    const structuredGlossary = JSON.stringify({
      type: "structured-content",
      content: [
        ...Array.from({ length: 4096 }, () => "x".repeat(32)),
        tailMarker
      ]
    });
    const response = await renderFirstLookup(harness, {
      shiftKey: false,
      transform(result) {
        result.dictionaryCount = 70;
        result.results[0].term.glossaries = Array.from(
          { length: 70 },
          (_, index) => ({
            dictionary: `Dictionary ${index}`,
            glossary: index === 0
              ? structuredGlossary
              : `definition-${index}:${"y".repeat(2 * 1024)}`,
            definitionTags: "",
            termTags: ""
          })
        );
      }
    });

    expect(new TextEncoder().encode(JSON.stringify(response)).length)
      .toBeGreaterThan(256 * 1024);
    const popup = harness.reader.getPopupElement();
    expect(popup.querySelectorAll(".gsm-hoshidicts-glossary-card"))
      .toHaveLength(70);
    expect(
      popup.querySelector<HTMLElement>(
        '.gsm-hoshidicts-glossary-content[data-hoshidicts-dictionary="Dictionary 0"]'
      )?.textContent
    ).toContain(tailMarker);
    expect(popup.textContent).toContain("definition-69");
  });

  it("hides the tab strip when no matching dictionary is favorited", async () => {
    const { lookup, reader } = createLookupHarness({
      dictionaryPresentation: [
        { title: "JMdict", favorite: false },
        { title: "Missing favorite", favorite: true }
      ]
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" },
        { dictionary: "Jitendex", glossary: "to consume" }
      ])
    );

    expect(popup.querySelector('[role="tablist"]')).toBeNull();
    expect(popup.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(popup.querySelector('[role="tabpanel"]')).toBeNull();
    expect(Array.from(popup.querySelectorAll("summary"), (summary) =>
      summary.textContent
    )).toEqual(["JMdict", "Jitendex"]);
  });

  it("shows every dictionary in All while a favorite tab filters locally", async () => {
    const { lookup, reader } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: false },
        { title: "Backup", favorite: true }
      ]
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main definition" },
        { dictionary: "Backup", glossary: "backup definition" }
      ])
    );

    expect(Array.from(popup.querySelectorAll('[role="tab"]'), (tab) =>
      tab.textContent
    )).toEqual(["All", "Backup"]);
    expect(popup.querySelector('[role="tabpanel"]')?.textContent)
      .toContain("main definition");
    expect(popup.querySelector('[role="tabpanel"]')?.textContent)
      .toContain("backup definition");

    popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click();
    expect(popup.querySelector('[role="tabpanel"]')?.textContent)
      .toContain("backup definition");
    expect(popup.querySelector('[role="tabpanel"]')?.textContent)
      .not.toContain("main definition");
  });

  it("places the toolbar opposite the root popup's automatic placement", async () => {
    const { first, lookup, reader } = createLookupHarness({
      dictionaryPresentation: [{ title: "Main", favorite: true }],
      popupToolbarPosition: "auto"
    });

    // Anchor near the bottom of the viewport: the popup fits above the word,
    // so the toolbar belongs on the bottom, opposite the anchor.
    setRect(first, { left: 10, top: 700, right: 30, bottom: 720 });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "above the word" }
      ])
    );
    expect(popup.dataset.toolbarPosition).toBe("bottom");

    // Move the anchor to the top: the popup must fall below the word, so the
    // toolbar flips to the top when the popup repositions.
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    reader.getPopupElement().ownerDocument.defaultView!.dispatchEvent(
      new (reader.getPopupElement().ownerDocument.defaultView as any).Event(
        "resize"
      )
    );
    expect(popup.dataset.toolbarPosition).toBe("top");
  });

  it.each(["top", "bottom"])(
    "keeps a fixed %s toolbar when the root popup changes sides",
    async (popupToolbarPosition) => {
      const { first, lookup, reader } = createLookupHarness({
        dictionaryPresentation: [{ title: "Main", favorite: true }],
        popupToolbarPosition
      });

      setRect(first, { left: 10, top: 700, right: 30, bottom: 720 });
      const { popup } = await lookup((requestId) =>
        lookupResultWithDictionaries(requestId, [
          { dictionary: "Main", glossary: "fixed toolbar" }
        ])
      );
      expect(popup.dataset.toolbarPosition).toBe(popupToolbarPosition);

      setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
      reader.getPopupElement().ownerDocument.defaultView!.dispatchEvent(
        new (reader.getPopupElement().ownerDocument.defaultView as any).Event(
          "resize"
        )
      );
      expect(popup.dataset.toolbarPosition).toBe(popupToolbarPosition);
    }
  );

  it("moves the complete toolbar to the bottom live and keeps its Note form positioned", async () => {
    const { first, lookup, reader } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: false },
        { title: "Backup", favorite: true }
      ],
      popupButtons: {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: true,
        customLinks: [
          { label: "Jisho", url: "https://jisho.org/search/%w" }
        ]
      }
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main definition" },
        { dictionary: "Backup", glossary: "backup definition" }
      ])
    );
    const chrome = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-result-chrome"
    )!;
    const form = popup.querySelector<HTMLFormElement>(
      ".gsm-hoshidicts-note-form"
    )!;
    const panel = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-tab-panel"
    )!;
    const feedback = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-mining-feedback"
    )!;
    const metadataStrip = chrome.querySelector<HTMLElement>(
      ".gsm-hoshidicts-metadata-strip"
    )!;
    const metadataCapsule = metadataStrip.querySelector<HTMLElement>(
      ".gsm-hoshidicts-primary-metadata-capsule"
    )!;

    // The anchor sits near the top, so the popup falls below the word and the
    // toolbar is automatically pinned to the top. The transient status node
    // rides directly under the toolbar as part of the status surface.
    expect(popup.dataset.toolbarPosition).toBe("top");
    expect(popup.firstElementChild).toBe(chrome);
    expect(chrome.nextElementSibling).toBe(feedback);
    expect(feedback.nextElementSibling).toBe(form);
    expect(form.nextElementSibling).toBe(panel);
    expect(chrome.lastElementChild).toBe(metadataStrip);
    expect(metadataCapsule.textContent).toContain("Frequency123 ★");

    // Moving the anchor near the viewport bottom makes the popup open above the
    // word, so the toolbar flips to the bottom while keeping the Note form and
    // the transient status positioned just before it (a complete bottom
    // status surface).
    setRect(first, { left: 10, top: 700, right: 30, bottom: 720 });
    reader.getPopupElement().ownerDocument.defaultView!.dispatchEvent(
      new (reader.getPopupElement().ownerDocument.defaultView as any).Event(
        "resize"
      )
    );

    expect(popup.dataset.toolbarPosition).toBe("bottom");
    expect(popup.firstElementChild).toBe(panel);
    expect(panel.nextElementSibling).toBe(form);
    expect(form.nextElementSibling).toBe(feedback);
    expect(feedback.nextElementSibling).toBe(chrome);
    expect(popup.lastElementChild).toBe(chrome);
    expect(chrome.lastElementChild).toBe(metadataStrip);
    expect(metadataCapsule.isConnected).toBe(true);
    expect(chrome.querySelector('[role="tablist"]')).not.toBeNull();
    expect(chrome.querySelector(".gsm-hoshidicts-expression")).not.toBeNull();
    expect(chrome.querySelector(".gsm-hoshidicts-mine-button")).not.toBeNull();
    expect(chrome.querySelector(".gsm-hoshidicts-view-in-anki-button"))
      .not.toBeNull();
    expect(chrome.querySelector(".gsm-hoshidicts-external-link-button"))
      .not.toBeNull();

    Object.defineProperty(popup, "scrollHeight", {
      configurable: true,
      value: 900
    });
    popup.scrollTop = 0;
    chrome.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-note-button"
    )!.click();
    expect(form.hidden).toBe(false);
    expect(popup.scrollTop).toBe(900);

    // Returning the anchor to the top flips the popup below the word, so the
    // toolbar returns to the top with the status and Note form after it.
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    reader.getPopupElement().ownerDocument.defaultView!.dispatchEvent(
      new (reader.getPopupElement().ownerDocument.defaultView as any).Event(
        "resize"
      )
    );
    expect(popup.dataset.toolbarPosition).toBe("top");
    expect(popup.firstElementChild).toBe(chrome);
    expect(chrome.nextElementSibling).toBe(feedback);
    expect(feedback.nextElementSibling).toBe(form);
    expect(form.nextElementSibling).toBe(panel);

    // And back to the bottom when the popup opens above the word again.
    setRect(first, { left: 10, top: 700, right: 30, bottom: 720 });
    reader.getPopupElement().ownerDocument.defaultView!.dispatchEvent(
      new (reader.getPopupElement().ownerDocument.defaultView as any).Event(
        "resize"
      )
    );
    expect(popup.dataset.toolbarPosition).toBe("bottom");
    expect(popup.firstElementChild).toBe(panel);
    expect(panel.nextElementSibling).toBe(form);
    expect(form.nextElementSibling).toBe(feedback);
    expect(feedback.nextElementSibling).toBe(chrome);
    expect(popup.lastElementChild).toBe(chrome);
  });

  it("keeps transient mining feedback in the bottom status surface with the toolbar", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const { first, lookup, reader } = createLookupHarness({
      dictionaryPresentation: [{ title: "Main", favorite: true }],
      popupToolbarPosition: "auto",
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });

    // Anchor near the bottom of the viewport: the popup opens above the word,
    // so the toolbar (headword, controls, and status) pins to the bottom.
    setRect(first, { left: 10, top: 700, right: 30, bottom: 720 });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "above the word" }
      ])
    );
    await flushPromises();
    expect(popup.dataset.toolbarPosition).toBe("bottom");

    const chrome = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-result-chrome"
    )!;
    const panel = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-tab-panel"
    )!;

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();
    await flushPromises();

    const feedback = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-mining-feedback"
    )!;
    expect(feedback.hidden).toBe(false);
    expect(feedback.textContent).toBe("Added to Anki.");

    // The transient status must belong to the bottom toolbar/status surface,
    // not float at the very top of the popup above the definitions while the
    // toolbar sits at the bottom. It must render after the definition panel and
    // sit adjacent to the toolbar chrome in the bottom status surface.
    const order = (element: Element) =>
      Array.prototype.indexOf.call(
        popup.querySelectorAll("*"),
        element
      );
    expect(order(feedback)).toBeGreaterThan(order(panel));
    expect(feedback.nextElementSibling).toBe(chrome);
  });

  it("keeps a vertical popup's toolbar at the top instead of flipping it beside the word", async () => {
    const { dom, first, lookup } = createLookupHarness({
      dictionaryPresentation: [{ title: "Main", favorite: true }],
      popupToolbarPosition: "auto"
    });

    // Vertical Japanese text opens the popup BESIDE the word, not above or
    // below it, so the opposite-side flip does not apply: the toolbar keeps its
    // configured (default top) position rather than being pushed to the bottom.
    first.setAttribute("style", "writing-mode: vertical-rl");
    expect(
      dom.window.getComputedStyle(first).writingMode.startsWith("vertical")
    ).toBe(true);

    // Anchor near the viewport bottom: a horizontal popup here would open above
    // the word and flip its toolbar to the bottom. The vertical popup must not.
    setRect(first, { left: 10, top: 700, right: 30, bottom: 720 });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "beside the word" }
      ])
    );

    expect(popup.dataset.toolbarPosition).toBe("top");
    const chrome = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-result-chrome"
    )!;
    expect(popup.firstElementChild).toBe(chrome);
  });

  it("shows short, accessible glossary dictionary tabs without changing their identity", async () => {
    const { lookup, reader } = createLookupHarness();
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict [2026-08-08]", glossary: "to eat" },
        { dictionary: "Jitendex.org [2026-08-08]", glossary: "to consume" },
        { dictionary: "JMdict [2026-08-08]", glossary: "to live on" },
        { dictionary: "KANJIDIC (English)", glossary: "kanji meaning" },
        {
          dictionary: '<img src=x onerror="window.hacked=true">',
          glossary: "untrusted dictionary name"
        }
      ]);
      response.dictionaryCount = 256;
      return response;
    });

    const tablist = popup.querySelector('[role="tablist"]');
    const tabs = Array.from(
      popup.querySelectorAll<HTMLElement>('[role="tab"]')
    );
    expect(tablist).not.toBeNull();
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "All",
      "JMdict",
      "Jitendex",
      "KANJIDIC (English)",
      '<img src=x onerror="window.hacked=true">'
    ]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tablist?.hasAttribute("aria-multiselectable")).toBe(false);
    expect(tablist?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(tablist?.textContent).not.toContain("Frequency");
    expect(tablist?.textContent).not.toContain("Pitch");
    expect(tablist?.querySelector("img")).toBeNull();
    expect(tabs[1]?.title).toBe("JMdict [2026-08-08]");
    expect(tabs[1]?.getAttribute("aria-label")).toBe(
      "JMdict [2026-08-08]"
    );
    expect(tabs[2]?.title).toBe("Jitendex.org [2026-08-08]");
    expect(tabs[2]?.getAttribute("aria-label")).toBe(
      "Jitendex.org [2026-08-08]"
    );
    expect(tabs[3]?.textContent).toBe("KANJIDIC (English)");
    const jitendexSummary = Array.from(
      popup.querySelectorAll<HTMLElement>("summary")
    ).find((summary) => summary.textContent === "Jitendex");
    expect(jitendexSummary?.title).toBe("Jitendex.org [2026-08-08]");
    expect(jitendexSummary?.getAttribute("aria-label")).toBe(
      "Jitendex.org [2026-08-08]"
    );
    expect(popup.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    const panel = popup.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
  });

  it("renders aliases while keeping favorite selection and dictionary identity canonical", async () => {
    const { lookup, reader, socket } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: true, displayName: "Primary Lexicon" },
        { title: "Backup", favorite: true, displayName: "Reference Notes" }
      ]
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main definition" },
        { dictionary: "Backup", glossary: "backup definition" }
      ])
    );

    const tabs = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "All",
      "Primary Lexicon",
      "Reference Notes"
    ]);
    expect(tabs[1]?.title).toBe("Main");
    expect(tabs[1]?.getAttribute("aria-label")).toBe("Main");
    expect(Array.from(popup.querySelectorAll("summary"), (summary) =>
      summary.textContent
    )).toEqual(["Primary Lexicon", "Reference Notes"]);
    expect(popup.querySelector("summary")?.title).toBe("Main");
    expect(
      popup.querySelector<HTMLElement>(
        '.gsm-hoshidicts-glossary-content[data-hoshidicts-dictionary="Main"]'
      )
    ).not.toBeNull();

    const sentBeforeClick = socket.sent.length;
    tabs[2]?.click();
    expect(socket.sent).toHaveLength(sentBeforeClick);
    expect(popup.querySelector('[role="tabpanel"]')?.textContent)
      .toContain("backup definition");
    expect(popup.querySelector('[role="tabpanel"]')?.textContent)
      .not.toContain("main definition");
    expect(
      popup.querySelector<HTMLElement>(
        '.gsm-hoshidicts-glossary-content[data-hoshidicts-dictionary="Backup"]'
      )
    ).not.toBeNull();
  });

  it("disambiguates duplicate aliases without confusing canonical dictionaries", async () => {
    const { lookup, reader } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: true, displayName: "Core" },
        { title: "Backup", favorite: true, displayName: "Core" },
        { title: "Core", favorite: true }
      ]
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main" },
        { dictionary: "Backup", glossary: "backup" },
        { dictionary: "Core", glossary: "core" }
      ])
    );

    const tabs = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "All",
      "Core (Main)",
      "Core (Backup)",
      "Core"
    ]);
    expect(tabs.slice(1).map((tab) => tab.title)).toEqual([
      "Main",
      "Backup",
      "Core"
    ]);
  });

  it("updates visible aliases live without issuing another dictionary lookup", async () => {
    const { lookup, reader, socket } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: true, displayName: "Original label" }
      ]
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main definition" }
      ])
    );
    const sentBeforeRename = socket.sent.length;

    reader.updatePreferences({
      dictionaryPresentation: [
        { title: "Main", favorite: true, displayName: "Renamed label" }
      ]
    });

    expect(socket.sent).toHaveLength(sentBeforeRename);
    expect(Array.from(popup.querySelectorAll('[role="tab"]'), (tab) =>
      tab.textContent
    )).toEqual(["All", "Renamed label"]);
    expect(popup.querySelector("summary")?.textContent).toBe("Renamed label");
    expect(popup.querySelector("summary")?.title).toBe("Main");
    expect(reader.getPreferences().dictionaryPresentation).toEqual([
      { title: "Main", favorite: true, displayName: "Renamed label" }
    ]);
  });

  it("updates groups live only when their ordered value changes", async () => {
    const groups = [
      { id: "reference", name: "Reference", dictionaries: ["Main"] }
    ];
    const { lookup, reader, socket } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: true },
        { title: "Backup", favorite: true }
      ],
      dictionaryTabGroups: groups
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main definition" },
        { dictionary: "Backup", glossary: "backup definition" }
      ])
    );
    const originalTabList = popup.querySelector('[role="tablist"]');
    const sentBeforeUpdate = socket.sent.length;

    reader.updatePreferences({
      dictionaryTabGroups: groups.map((group) => ({
        ...group,
        dictionaries: [...group.dictionaries]
      }))
    });
    expect(popup.querySelector('[role="tablist"]')).toBe(originalTabList);

    reader.updatePreferences({
      dictionaryTabGroups: [
        { id: "both", name: "Combined", dictionaries: ["Main", "Backup"] }
      ]
    });

    expect(socket.sent).toHaveLength(sentBeforeUpdate);
    expect(Array.from(popup.querySelectorAll('[role="tab"]'), (tab) =>
      tab.textContent
    )).toEqual(["All", "Combined"]);
    expect(reader.getPreferences().dictionaryTabGroups).toEqual([
      { id: "both", name: "Combined", dictionaries: ["Main", "Backup"] }
    ]);
  });

  it("falls back to full dictionary titles when cleaned labels would collide", async () => {
    const { lookup, reader, socket } = createLookupHarness();
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Jitendex.org [2023-12-12]", glossary: "old" },
        { dictionary: "Jitendex.org [2024-01-05]", glossary: "new" },
        { dictionary: "Lexicon (revision 4)", glossary: "revision" },
        { dictionary: "Lexicon (English)", glossary: "semantic qualifier" }
      ])
    );

    const tabs = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "All",
      "Jitendex.org [2023-12-12]",
      "Jitendex.org [2024-01-05]",
      "Lexicon",
      "Lexicon (English)"
    ]);
    expect(tabs[2]?.title).toBe("Jitendex.org [2024-01-05]");
    expect(tabs[2]?.getAttribute("aria-label")).toBe(
      "Jitendex.org [2024-01-05]"
    );
    const sentBeforeTabClick = socket.sent.length;
    tabs[2]?.click();
    expect(socket.sent).toHaveLength(sentBeforeTabClick);
    const panelText = popup.querySelector('[role="tabpanel"]')?.textContent;
    expect(panelText).toContain("new");
    expect(panelText).not.toContain("old");
  });

  it("filters the existing result locally when a dictionary tab is clicked", async () => {
    const { lookup, reader, socket } = createLookupHarness();
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" },
        { dictionary: "Jitendex", glossary: "to consume" }
      ]);
      response.results.push({
        ...response.results[0],
        term: {
          ...response.results[0].term,
          expression: "食す",
          reading: "しょくす",
          glossaries: [
            {
              dictionary: "JMdict",
              glossary: "to take food",
              definitionTags: "",
              termTags: ""
            }
          ]
        }
      });
      return response;
    });
    const sentBeforeTabClick = socket.sent.length;

    const jitendexTab = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((tab) => tab.textContent === "Jitendex");
    expect(jitendexTab).toBeDefined();
    jitendexTab?.click();

    const visibleEntries = Array.from(
      popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    ).filter((entry) => !entry.hidden);
    expect(socket.sent).toHaveLength(sentBeforeTabClick);
    expect(visibleEntries.map((entry) => entry.dataset.expression)).toEqual([
      "食べる"
    ]);
    expect(popup.querySelector('[role="tabpanel"]')?.textContent).toContain(
      "to consume"
    );
    expect(popup.querySelector('[role="tabpanel"]')?.textContent).not.toContain(
      "to eat"
    );
    expect(popup.querySelector('[role="tabpanel"]')?.textContent).not.toContain(
      "to take food"
    );
    expect(jitendexTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("shows ordered groups before ungrouped favorites and selects them exclusively", async () => {
    const { lookup, reader, socket } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Alpha", favorite: true },
        { title: "Beta", favorite: true },
        { title: "Gamma", favorite: true },
        { title: "Delta", favorite: true }
      ],
      dictionaryTabGroups: [
        { id: "primary", name: "Delta", dictionaries: ["Alpha", "Beta"] },
        { id: "overlap", name: "Overlap", dictionaries: ["Beta", "Gamma"] },
        {
          id: "suffix",
          name: "Delta (dictionary)",
          dictionaries: ["Epsilon"]
        },
        { id: "empty", name: "No results", dictionaries: ["Missing"] }
      ]
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Alpha", glossary: "alpha definition" },
        { dictionary: "Beta", glossary: "beta definition" },
        { dictionary: "Gamma", glossary: "gamma definition" },
        { dictionary: "Delta", glossary: "delta definition" },
        { dictionary: "Epsilon", glossary: "epsilon definition" }
      ])
    );
    const sentBeforeSelection = socket.sent.length;
    const buttons = Array.from(
      popup.querySelectorAll<HTMLButtonElement>(".gsm-hoshidicts-tab")
    );
    const all = buttons.find((button) => button.textContent === "All")!;
    expect(buttons.map((button) => button.textContent)).toEqual([
      "All",
      "Delta",
      "Overlap",
      "Delta (dictionary)",
      "Delta (dictionary 2)"
    ]);
    const primary = buttons[1]!;
    const overlap = buttons[2]!;
    expect(primary.title).toBe("Tab group: Delta");
    expect(primary.getAttribute("aria-label")).toBe("Tab group: Delta");
    expect(buttons[4]?.getAttribute("aria-label")).toBe("Delta");

    primary.click();

    expect(socket.sent).toHaveLength(sentBeforeSelection);
    expect(all.getAttribute("aria-selected")).toBe("false");
    expect(primary.getAttribute("aria-selected")).toBe("true");
    expect(overlap.getAttribute("aria-selected")).toBe("false");
    expect(
      popup.querySelector(".gsm-hoshidicts-tab-panel")
        ?.getAttribute("aria-labelledby")
    ).toBe(primary.id);
    expect(popup.querySelector(".gsm-hoshidicts-tab-panel")?.textContent)
      .toContain("alpha definition");
    expect(popup.querySelector(".gsm-hoshidicts-tab-panel")?.textContent)
      .toContain("beta definition");
    expect(popup.querySelector(".gsm-hoshidicts-tab-panel")?.textContent)
      .not.toContain("gamma definition");

    overlap.click();
    expect(primary.getAttribute("aria-selected")).toBe("false");
    expect(overlap.getAttribute("aria-selected")).toBe("true");
    expect(popup.querySelector(".gsm-hoshidicts-tab-panel")?.textContent)
      .not.toContain("alpha definition");
    expect(popup.querySelector(".gsm-hoshidicts-tab-panel")?.textContent)
      .toContain("gamma definition");
    expect(popup.querySelector(".gsm-hoshidicts-tab-panel")?.textContent)
      .toContain("beta definition");
  });

  it("starts each new lookup on All after a group was selected", async () => {
    const { lookup, reader, second } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Alpha", favorite: true },
        { title: "Beta", favorite: true }
      ],
      dictionaryTabGroups: [
        { id: "alpha", name: "Alpha group", dictionaries: ["Alpha"] }
      ]
    });
    const firstLookup = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Alpha", glossary: "alpha definition" },
        { dictionary: "Beta", glossary: "beta definition" }
      ])
    );
    firstLookup.popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]
      ?.click();
    expect(firstLookup.popup.querySelector('[role="tabpanel"]')?.textContent)
      .not.toContain("beta definition");

    const secondLookup = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Alpha", glossary: "new alpha" },
        { dictionary: "Beta", glossary: "new beta" }
      ]), second);
    const tabs = secondLookup.popup.querySelectorAll('[role="tab"]');
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(secondLookup.popup.querySelector('[role="tabpanel"]')?.textContent)
      .toContain("new alpha");
    expect(secondLookup.popup.querySelector('[role="tabpanel"]')?.textContent)
      .toContain("new beta");
  });

  it("keeps the custom-definition draft mounted below the chrome across tab changes", async () => {
    const { lookup, reader } = createLookupHarness();
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" },
        { dictionary: "Jitendex", glossary: "to consume" }
      ])
    );
    const noteButton = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-note-button"
    )!;
    const form = popup.querySelector<HTMLFormElement>(
      ".gsm-hoshidicts-note-form"
    )!;
    noteButton.click();
    const definition = form.querySelector<HTMLTextAreaElement>(
      ".gsm-hoshidicts-note-definition"
    )!;
    definition.value = "Keep this draft";

    Array.from(popup.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "Jitendex")
      ?.click();

    expect(popup.querySelector(".gsm-hoshidicts-note-form") === form).toBe(true);
    expect(form.hidden).toBe(false);
    expect(definition.value).toBe("Keep this draft");
    expect(popup.querySelector(".gsm-hoshidicts-note-button") === noteButton)
      .toBe(true);
    expect(noteButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("resets expansion, scrolling, and highlighting for each dictionary", async () => {
    const { first, lookup, reader, second } = createLookupHarness({
      sourceHighlightEnabled: true
    });
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "first match" }
      ]);
      response.results[0].matched = "食";
      response.results.push(
        ...Array.from({ length: 8 }, (_, index) => ({
          ...response.results[0],
          matched: "食べる",
          term: {
            ...response.results[0].term,
            expression: `食べる ${index + 1}`,
            glossaries: [
              {
                dictionary: "Jitendex",
                glossary: `filtered definition ${index + 1}`,
                definitionTags: "",
                termTags: ""
              }
            ]
          }
        }))
      );
      return response;
    });

    expect(first.classList.contains("gsm-hoshidicts-source-match")).toBe(true);
    expect(second.classList.contains("gsm-hoshidicts-source-match")).toBe(false);
    popup.scrollTop = 100;

    const tabs = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    );
    tabs.find((tab) => tab.textContent === "Jitendex")?.click();

    let entries = Array.from(
      popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    );
    expect(entries).toHaveLength(1);
    expect(entries.filter((entry) => entry.hidden)).toHaveLength(0);
    expect(popup.querySelector(".gsm-hoshidicts-show-more")?.textContent).toBe(
      "Show 7 more"
    );
    expect(popup.scrollTop).toBe(0);
    expect(second.classList.contains("gsm-hoshidicts-source-match")).toBe(true);

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")
      ?.click();
    entries = Array.from(
      popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    );
    expect(entries).toHaveLength(8);
    expect(entries.some((entry) => entry.hidden)).toBe(false);
    tabs[0]?.click();
    tabs.find((tab) => tab.textContent === "Jitendex")?.click();
    entries = Array.from(
      popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    );
    expect(entries).toHaveLength(1);
    expect(entries.filter((entry) => entry.hidden)).toHaveLength(0);
  });

  it("mines selected glossaries with only their current dictionary styles", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicateBehavior: "prevent",
      results: payload.notes.map(() => ({
        state: "addable",
        canAdd: true,
        duplicate: false
      }))
    }));
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const { dom, first, lookup, reader, socket } = createLookupHarness({
      checkMiningNotes,
      dictionaryPresentation: [
        { title: "JMdict", favorite: true },
        {
          title: "Jitendex.org [2026-08-08]",
          favorite: true,
          displayName: "Jitendex"
        },
        {
          title: "Frequency",
          favorite: false,
          displayName: "Corpus rank",
          frequencyMode: "rank-based"
        }
      ],
      createObjectURL: () => "blob:kiku-parity",
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    dom.window.document.title = "GSM Kiku parity";
    const selectionRange = dom.window.document.createRange();
    selectionRange.selectNodeContents(first);
    dom.window.getSelection()?.removeAllRanges();
    dom.window.getSelection()?.addRange(selectionRange);
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" },
        {
          dictionary: "Jitendex.org [2026-08-08]",
          glossary: JSON.stringify({
            type: "structured-content",
            content: [
              { tag: "strong", content: "to consume" },
              {
                type: "image",
                path: "img/forms.jpeg",
                width: 67,
                height: 100
              }
            ]
          })
        }
      ])
    );
    const stylesRequest = lastRequestOfType(socket, "hoshidicts_styles");
    socket.receive({
      type: "hoshidicts_styles_result",
      requestId: stylesRequest.requestId,
      generation: 1,
      success: true,
      featureDisabled: false,
      staleGeneration: false,
      error: null,
      styles: [{
        dictionary: "JMdict",
        styles: ".jmdict-definition { color: blue; }"
      }, {
        dictionary: "Jitendex.org [2026-08-08]",
        styles: ".jitendex-definition { color: red; }"
      }]
    });
    const mediaRequest = firstRequestOfType(socket, "hoshidicts_media");
    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: mediaRequest.requestId,
      success: true,
      generation: 1,
      dictionary: "Jitendex.org [2026-08-08]",
      path: "img/forms.jpeg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });

    expect(checkMiningNotes.mock.calls.at(-1)?.[0].notes[0].dictionaryStyles)
      .toEqual([{
        dictionary: "JMdict",
        styles: ".jmdict-definition { color: blue; }"
      }, {
        dictionary: "Jitendex.org [2026-08-08]",
        styles: ".jitendex-definition { color: red; }"
      }]);
    expect(checkMiningNotes.mock.calls.at(-1)?.[0].notes[0]).toMatchObject({
      dictionaryAliases: [{
        dictionary: "Jitendex.org [2026-08-08]",
        alias: "Jitendex"
      }, {
        dictionary: "Frequency",
        alias: "Corpus rank"
      }],
      documentTitle: "GSM Kiku parity",
      popupSelectionText: "食",
      searchQuery: "食べる"
    });
    expect(
      checkMiningNotes.mock.calls.at(-1)?.[0].notes[0].result.term
        .frequencies[0]
    ).toMatchObject({
      dictionary: "Frequency",
      frequencyMode: "rank-based"
    });
    const allMineButton = popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    expect(allMineButton.dataset.state).toBe("ready");
    allMineButton.click();
    await flushPromises();
    await flushPromises();
    expect(mine.mock.calls[0][0].result.term.glossaries).toEqual([
      expect.objectContaining({ dictionary: "JMdict", glossary: "to eat" }),
      expect.objectContaining({
        dictionary: "Jitendex.org [2026-08-08]",
        glossary: expect.stringContaining("img/forms.jpeg")
      })
    ]);
    expect(mine.mock.calls[0][0].dictionaryStyles).toEqual([{
      dictionary: "JMdict",
      styles: ".jmdict-definition { color: blue; }"
    }, {
      dictionary: "Jitendex.org [2026-08-08]",
      styles: ".jitendex-definition { color: red; }"
    }]);
    expect(mine.mock.calls[0][0].dictionaryMedia).toEqual([{
      dictionary: "Jitendex.org [2026-08-08]",
      path: "img/forms.jpeg",
      mediaType: "image/jpeg",
      dataBase64: "/9j/4AA="
    }]);
    expect(mine.mock.calls[0][0].dictionaryAliases).toEqual([{
      dictionary: "Jitendex.org [2026-08-08]",
      alias: "Jitendex"
    }, {
      dictionary: "Frequency",
      alias: "Corpus rank"
    }]);
    expect(mine.mock.calls[0][0].result.term.frequencies[0]).toMatchObject({
      dictionary: "Frequency",
      frequencyMode: "rank-based"
    });

    const jitendexTab = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((tab) => tab.textContent === "Jitendex");
    expect(jitendexTab).toBeDefined();
    jitendexTab?.click();
    await flushPromises();
    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
      ?.click();
    await flushPromises();
    await flushPromises();

    expect(mine).toHaveBeenCalledTimes(2);
    const payload = mine.mock.calls[1][0];
    expect(payload.result.term.glossaries).toEqual([
      expect.objectContaining({
        dictionary: "Jitendex.org [2026-08-08]",
        glossary: expect.stringContaining("img/forms.jpeg")
      })
    ]);
    expect(payload.result.term.frequencies).toEqual([
      {
        dictionary: "Frequency",
        frequencyMode: "rank-based",
        frequencies: [{ value: 123, displayValue: "123 ★" }]
      }
    ]);
    expect(payload.result.term.pitches).toEqual([
      expect.objectContaining({ dictionary: "Pitch" })
    ]);
    expect(payload.dictionaryStyles).toEqual([{
      dictionary: "Jitendex.org [2026-08-08]",
      styles: ".jitendex-definition { color: red; }"
    }]);
    expect(payload.dictionaryMedia).toEqual([{
      dictionary: "Jitendex.org [2026-08-08]",
      path: "img/forms.jpeg",
      mediaType: "image/jpeg",
      dataBase64: "/9j/4AA="
    }]);
    expect(payload.dictionaryAliases).toEqual([{
      dictionary: "Jitendex.org [2026-08-08]",
      alias: "Jitendex"
    }, {
      dictionary: "Frequency",
      alias: "Corpus rank"
    }]);
    expect(checkMiningNotes.mock.calls.at(-1)?.[0].notes[0].dictionaryStyles)
      .toEqual([{
        dictionary: "Jitendex.org [2026-08-08]",
        styles: ".jitendex-definition { color: red; }"
      }]);

    const jmdictTab = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((tab) => tab.textContent === "JMdict");
    jmdictTab?.click();
    await flushPromises();
    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
      ?.click();
    await flushPromises();
    await flushPromises();

    expect(mine).toHaveBeenCalledTimes(3);
    expect(mine.mock.calls[2][0].result.term.glossaries).toEqual([
      expect.objectContaining({ dictionary: "JMdict", glossary: "to eat" })
    ]);
    expect(mine.mock.calls[2][0].dictionaryStyles).toEqual([{
      dictionary: "JMdict",
      styles: ".jmdict-definition { color: blue; }"
    }]);
    expect(mine.mock.calls[2][0]).not.toHaveProperty("dictionaryMedia");
    expect(mine.mock.calls[2][0].dictionaryAliases).toEqual([{
      dictionary: "Frequency",
      alias: "Corpus rank"
    }]);
    expect(checkMiningNotes.mock.calls.at(-1)?.[0].notes[0].dictionaryStyles)
      .toEqual([{
        dictionary: "JMdict",
        styles: ".jmdict-definition { color: blue; }"
      }]);
  });

  it("clears mining styles on generation changes and ignores stale responses", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicateBehavior: "prevent",
      results: payload.notes.map(() => ({
        state: "addable",
        canAdd: true,
        duplicate: false
      }))
    }));
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const { lookup, reader, second, socket } = createLookupHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [{
        dictionary: "JMdict",
        glossary: "to eat"
      }]);
      response.generation = 17;
      return response;
    });
    const generation17Request = lastRequestOfType(socket, "hoshidicts_styles");
    await respond(socket, {
      type: "hoshidicts_styles_result",
      requestId: generation17Request.requestId,
      generation: 17,
      success: true,
      featureDisabled: false,
      staleGeneration: false,
      error: null,
      styles: [{ dictionary: "JMdict", styles: ".old { color: red; }" }]
    });

    expect(checkMiningNotes.mock.calls.at(-1)?.[0].notes[0].dictionaryStyles)
      .toEqual([{ dictionary: "JMdict", styles: ".old { color: red; }" }]);
    expect(
      popup.ownerDocument.head.querySelector(
        'style[data-hoshidicts-generation="17"]'
      )
    ).not.toBeNull();

    await lookup((requestId) => {
      const response = lookupResultWithDictionaries(
        requestId,
        [{ dictionary: "JMdict", glossary: "to finish" }],
        "終わる"
      );
      response.generation = 18;
      return response;
    }, second);
    const generation18Request = lastRequestOfType(socket, "hoshidicts_styles");

    await respond(socket, {
      type: "hoshidicts_styles_result",
      requestId: generation17Request.requestId,
      generation: 17,
      success: true,
      featureDisabled: false,
      staleGeneration: false,
      error: null,
      styles: [{ dictionary: "JMdict", styles: ".stale { color: orange; }" }]
    });

    expect(generation18Request.generation).toBe(18);
    expect(
      popup.ownerDocument.head.querySelector(
        "style[data-hoshidicts-dictionary-style]"
      )
    ).toBeNull();
    expect(checkMiningNotes.mock.calls.at(-1)?.[0].notes[0])
      .not.toHaveProperty("dictionaryStyles");

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
      ?.click();
    await flushPromises();
    expect(mine.mock.calls.at(-1)?.[0]).not.toHaveProperty("dictionaryStyles");
  });

  it("keeps complete dictionary styles in large mining requests", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicateBehavior: "prevent",
      results: payload.notes.map(() => ({
        state: "addable",
        canAdd: true,
        duplicate: false
      }))
    }));
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const { lookup, reader, socket } = createLookupHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [{
        dictionary: "Large dictionary",
        glossary: "definition"
      }]);
      response.results = Array.from({ length: 16 }, (_, index) => ({
        ...response.results[0],
        matched: `食べる${index}`,
        term: {
          ...response.results[0].term,
          expression: `食べる${index}`
        }
      }));
      return response;
    });
    const stylesRequest = lastRequestOfType(socket, "hoshidicts_styles");
    const maximumStyle = "x".repeat(256 * 1024);
    socket.receive({
      type: "hoshidicts_styles_result",
      requestId: stylesRequest.requestId,
      generation: 1,
      success: true,
      featureDisabled: false,
      staleGeneration: false,
      error: null,
      styles: [{ dictionary: "Large dictionary", styles: maximumStyle }]
    });
    expect(popup.querySelectorAll(".gsm-hoshidicts-entry")).toHaveLength(1);
    const showMore = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-show-more"
    )!;
    expect(showMore.textContent).toBe("Show 15 more");
    showMore.click();
    expect(popup.querySelectorAll(".gsm-hoshidicts-entry")).toHaveLength(16);
    for (let index = 0; index < 20; index += 1) {
      await flushPromises();
    }

    const styledPayloads = checkMiningNotes.mock.calls
      .map(([payload]) => payload)
      .filter((payload) =>
        Object.hasOwn(payload.notes[0], "dictionaryStyles")
      );
    expect(styledPayloads).toHaveLength(16);
    expect(styledPayloads.every((payload) => payload.notes.length === 1))
      .toBe(true);
    expect(styledPayloads.every((payload) =>
      new TextEncoder().encode(JSON.stringify(payload)).length <= 64 * 1024 * 1024
    )).toBe(true);
    expect(styledPayloads.every((payload) =>
      payload.notes[0].dictionaryStyles?.[0]?.styles.length === 256 * 1024
    )).toBe(true);

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
      ?.click();
    await flushPromises();
    expect(mine.mock.calls.at(-1)?.[0].dictionaryStyles?.[0]?.styles)
      .toHaveLength(256 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(mine.mock.calls.at(-1)?.[0])).length)
      .toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("mines the combined local projection for a group", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 456 }));
    const { lookup, reader, socket } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Alpha", favorite: true },
        { title: "Beta", favorite: true },
        { title: "Gamma", favorite: true }
      ],
      dictionaryTabGroups: [
        { id: "core", name: "Core", dictionaries: ["Alpha", "Beta"] }
      ],
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Alpha", glossary: "alpha" },
        { dictionary: "Beta", glossary: "beta" },
        { dictionary: "Gamma", glossary: "gamma" }
      ])
    );
    await flushPromises();
    const sentBeforeClick = socket.sent.length;

    Array.from(popup.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "Core")
      ?.click();
    await flushPromises();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
      ?.click();
    await flushPromises();

    expect(socket.sent).toHaveLength(sentBeforeClick);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(mine.mock.calls[0][0].result.term.glossaries.map(
      (glossary: { dictionary: string }) => glossary.dictionary
    )).toEqual(["Alpha", "Beta"]);
  });

  it("keeps replacement-tab mining disabled until an in-flight note finishes", async () => {
    let finishMine!: (value: { success: boolean; noteId: number }) => void;
    const mine = vi.fn(
      () =>
        new Promise<{ success: boolean; noteId: number }>((resolve) => {
          finishMine = resolve;
        })
    );
    const { lookup, reader } = createLookupHarness({
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" },
        { dictionary: "Jitendex", glossary: "to consume" }
      ])
    );
    await flushPromises();

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
      ?.click();
    Array.from(popup.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "Jitendex")
      ?.click();
    await flushPromises();

    const replacementButton = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-mine-button"
    )!;
    expect(replacementButton.dataset.state).toBe("checking");
    expect(replacementButton.disabled).toBe(true);
    replacementButton.click();
    expect(mine).toHaveBeenCalledTimes(1);

    finishMine({ success: true, noteId: 123 });
    await flushPromises();
    expect(replacementButton.dataset.state).toBe("ready");
    expect(replacementButton.disabled).toBe(false);
  });

  it("resets the selected dictionary to All on the next lookup", async () => {
    const { lookup, reader, second } = createLookupHarness();
    const { popup: firstPopup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" },
        { dictionary: "Jitendex", glossary: "to consume" }
      ])
    );
    Array.from(firstPopup.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "Jitendex")
      ?.click();

    await lookup(
      (requestId) =>
      lookupResultWithDictionaries(
        requestId,
        [
          { dictionary: "JMdict", glossary: "ending" },
          { dictionary: "Bilingual", glossary: "to finish" }
        ],
        "終わる"
      ),
      second
    );

    const selectedTab = reader
      .getPopupElement()
      .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    expect(selectedTab?.textContent).toBe("All");
    expect(selectedTab?.getAttribute("tabindex")).toBe("0");
  });

  it("supports automatic roving-tab keyboard selection", async () => {
    const { dom, lookup, reader } = createLookupHarness();
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Alpha", glossary: "alpha" },
        { dictionary: "Beta", glossary: "beta" },
        { dictionary: "Gamma", glossary: "gamma" }
      ])
    );

    const tabs = Array.from(
      popup.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    );
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);

    tabs[0]?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowRight"
      })
    );
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(dom.window.document.activeElement).toBe(tabs[1]);

    tabs[1]?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "End" })
    );
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");

    tabs[3]?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Home" })
    );
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    tabs[0]?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowLeft"
      })
    );
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, -1, 0]);
  });

  it("bounds the tab strip to the 64 normalized glossary dictionaries", async () => {
    const { dom, lookup, reader } = createLookupHarness();
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(
        requestId,
        Array.from({ length: 64 }, (_, index) => ({
          dictionary: `Dictionary ${index + 1}`,
          glossary: `Definition ${index + 1}`
        }))
      );
      response.dictionaryCount = 256;
      return response;
    });

    const labels = Array.from(
      popup.querySelectorAll<HTMLElement>('[role="tab"]'),
      (tab) => tab.textContent
    );
    expect(labels).toHaveLength(65);
    expect(labels.slice(0, 3)).toEqual(["All", "Dictionary 1", "Dictionary 2"]);
    expect(labels.at(-1)).toBe("Dictionary 64");

    const tablist = popup.querySelector<HTMLElement>('[role="tablist"]')!;
    Object.defineProperties(tablist, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 1000 }
    });
    const scrollAcrossTabs = new dom.window.WheelEvent("wheel", {
      cancelable: true,
      deltaY: 100
    });
    tablist.dispatchEvent(scrollAcrossTabs);
    expect(tablist.scrollLeft).toBe(100);
    expect(scrollAcrossTabs.defaultPrevented).toBe(true);

    tablist.scrollLeft = 900;
    const scrollPastEnd = new dom.window.WheelEvent("wheel", {
      cancelable: true,
      deltaY: 100
    });
    tablist.dispatchEvent(scrollPastEnd);
    expect(tablist.scrollLeft).toBe(900);
    expect(scrollPastEnd.defaultPrevented).toBe(false);
  });

  it("keeps the default capsule frequency-only and the tablist semantically pure", async () => {
    const { lookup, reader } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: true },
        { title: "Backup", favorite: true }
      ]
    });
    const { popup } = await lookup((requestId) =>
      lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main definition" },
        { dictionary: "Backup", glossary: "backup definition" }
      ])
    );

    const strip = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-metadata-strip"
    )!;
    const tablist = strip.querySelector<HTMLElement>('[role="tablist"]')!;
    const capsule = strip.querySelector<HTMLElement>(
      ".gsm-hoshidicts-primary-metadata-capsule"
    )!;
    expect(reader.getPreferences().hidePopupGrammarTags).toBe(true);
    expect(strip.hidden).toBe(false);
    expect(capsule.parentElement).toBe(strip);
    expect(tablist.contains(capsule)).toBe(false);
    expect(Array.from(tablist.children).every((child) =>
      child.getAttribute("role") === "tab"
    )).toBe(true);
    expect(capsule.querySelector(".gsm-hoshidicts-frequency-value")?.textContent)
      .toBe("123 ★");
    expect(capsule.querySelector(".gsm-hoshidicts-primary-grammar")).toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-entry .gsm-hoshidicts-tags"))
      .toBeNull();
  });

  it("shows deduplicated grammar in the capsule live without lookup or autoplay", async () => {
    const audioController = createAudioControllerStub();
    const { lookup, reader, socket } = createLookupHarness({
      audioController,
      dictionaryPresentation: [{ title: "Main", favorite: false }]
    });
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [
        { dictionary: "Main", glossary: "main definition" }
      ]);
      response.results[0].trace = [
        { name: "past", description: "Past tense" },
        { name: "past", description: "Duplicate past tense" }
      ];
      response.results[0].term.rules = "v1 adj-na";
      response.results[0].term.glossaries[0].termTags = "adj-na n v1";
      return response;
    });
    const sentBeforeToggle = socket.sent.length;
    const audioCallsBeforeToggle =
      audioController.setRenderedResults.mock.calls.length;

    reader.updatePreferences({ hidePopupGrammarTags: false });

    expect(socket.sent).toHaveLength(sentBeforeToggle);
    expect(reader.getPreferences().hidePopupGrammarTags).toBe(false);
    const capsule = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-primary-metadata-capsule"
    )!;
    expect(Array.from(
      capsule.querySelectorAll<HTMLElement>(
        ".gsm-hoshidicts-primary-grammar-tag"
      ),
      (tag) => tag.textContent
    )).toEqual(["past", "v1", "adj-na", "n"]);
    expect(capsule.querySelector(
      ".gsm-hoshidicts-primary-grammar-tag-deinflection"
    )?.getAttribute("title")).toBe("Past tense");
    expect(capsule.querySelector(".gsm-hoshidicts-frequency-value")?.textContent)
      .toBe("123 ★");
    expect(popup.querySelector(".gsm-hoshidicts-entry .gsm-hoshidicts-tags"))
      .toBeNull();
    expect(audioController.setRenderedResults.mock.calls).toHaveLength(
      audioCallsBeforeToggle + 1
    );
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: false });

    reader.updatePreferences({ hidePopupGrammarTags: true });
    expect(socket.sent).toHaveLength(sentBeforeToggle);
    expect(popup.querySelector(
      ".gsm-hoshidicts-primary-grammar"
    )).toBeNull();
    expect(popup.querySelector(
      ".gsm-hoshidicts-primary-metadata-capsule " +
      ".gsm-hoshidicts-frequency-value"
    )?.textContent).toBe("123 ★");
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: false });
  });

  it("refreshes frequency and grammar when a dictionary tab changes the primary result", async () => {
    const { lookup, reader } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: true },
        { title: "Backup", favorite: true }
      ],
      hidePopupGrammarTags: false
    });
    const { popup } = await lookup((requestId) => {
      const response = lookupResult(requestId, "食べる");
      const mainResult = response.results[0];
      mainResult.trace = [{ name: "main-rule", description: "Main rule" }];
      mainResult.term.glossaries = [{
        dictionary: "Main",
        glossary: "main definition",
        definitionTags: "",
        termTags: "main-tag"
      }];
      mainResult.term.frequencies = [{
        dictionary: "Main frequency",
        frequencies: [{ value: 111, displayValue: "111" }]
      }];
      const backupResult = {
        ...mainResult,
        matched: "食う",
        deinflected: "食う",
        trace: [{ name: "backup-rule", description: "Backup rule" }],
        term: {
          ...mainResult.term,
          expression: "食う",
          reading: "くう",
          glossaries: [{
            dictionary: "Backup",
            glossary: "backup definition",
            definitionTags: "",
            termTags: "backup-tag"
          }],
          frequencies: [{
            dictionary: "Backup frequency",
            frequencies: [{ value: 222, displayValue: "222" }]
          }]
        }
      };
      response.results = [mainResult, backupResult];
      return response;
    });
    const capsuleText = () => popup.querySelector(
      ".gsm-hoshidicts-primary-metadata-capsule"
    )?.textContent;

    expect(capsuleText()).toContain("Main frequency111");
    expect(capsuleText()).toContain("main-rule");
    Array.from(popup.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "Backup")
      ?.click();
    expect(capsuleText()).toContain("Backup frequency222");
    expect(capsuleText()).toContain("backup-rule");
    expect(capsuleText()).not.toContain("main-rule");
    expect(popup.querySelector(
      '[role="tab"][aria-selected="true"]'
    )?.textContent).toBe("Backup");
  });

  it("collapses an empty metadata strip without affecting pitch metadata", async () => {
    const audioController = createAudioControllerStub();
    const harness = createReaderHarness({
      audioController,
      lookupMode: "hover",
      showPitchAccentBadge: true
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results[0].term.frequencies = [];
      }
    });
    const popup = harness.reader.getPopupElement();
    const strip = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-metadata-strip"
    )!;
    expect(strip.hidden).toBe(true);
    expect(popup.querySelector(".gsm-hoshidicts-primary-metadata-capsule")
      ?.hasAttribute("hidden")).toBe(true);
    expect(popup.querySelector(".gsm-hoshidicts-tag-pitch")).not.toBeNull();

    const sentBeforeToggle = harness.socket.sent.length;
    harness.reader.updatePreferences({ hidePopupGrammarTags: false });
    expect(harness.socket.sent).toHaveLength(sentBeforeToggle);
    expect(strip.isConnected).toBe(false);
    const rerenderedStrip = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-metadata-strip"
    )!;
    expect(rerenderedStrip.hidden).toBe(false);
    expect(rerenderedStrip.querySelector(
      ".gsm-hoshidicts-primary-grammar"
    )?.textContent).toBe("pastv1uk");
    expect(popup.querySelector(".gsm-hoshidicts-tag-pitch")).not.toBeNull();
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: false });
  });

  it("toggles the inline contour and pitch badge independently", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, { shiftKey: false });
    const popup = harness.reader.getPopupElement();

    expect(popup.querySelector(".gsm-hoshidicts-pitch-reading")).not.toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-tag-pitch")).toBeNull();

    const sentBeforeToggle = harness.socket.sent.length;
    harness.reader.updatePreferences({
      showPitchAccentFurigana: false,
      showPitchAccentBadge: true
    });

    expect(harness.socket.sent).toHaveLength(sentBeforeToggle);
    expect(popup.querySelector(".gsm-hoshidicts-pitch-reading")).toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-tag-pitch")).not.toBeNull();

    harness.reader.updatePreferences({ showPitchAccentBadge: false });
    expect(popup.querySelector(".gsm-hoshidicts-tag-pitch")).toBeNull();
  });
});

describe("Hoshidicts Shift-hover scanner", () => {
  it("ignores a collapsed click selection", async () => {
    const harness = createReaderHarness({ lookupMode: "shift" });
    const range = harness.dom.window.document.createRange();
    range.setStart(harness.first.firstChild!, 0);
    range.collapse(true);
    const selection = harness.dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    dispatchMouse(harness.dom, harness.first, "mousedown", { button: 0 });
    dispatchMouse(harness.dom, harness.first, "mouseup", { button: 0 });
    await vi.advanceTimersByTimeAsync(20);

    expect(harness.socket.sent.map((message) => JSON.parse(message).type))
      .not.toContain("hoshidicts_lookup");
  });

  it("looks up an exact OCR-box selection immediately and pauses hover while dragging", async () => {
    const harness = createReaderHarness({ lookupMode: "shift" });
    const second = harness.dom.window.document.getElementById("second")!;
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    Object.defineProperty(harness.dom.window.Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: vi.fn(() => ({
        x: 200,
        y: 100,
        left: 200,
        top: 100,
        right: 260,
        bottom: 120,
        width: 60,
        height: 20,
        toJSON: () => ({})
      }))
    });

    dispatchMouse(harness.dom, harness.first, "mousedown", {
      button: 0,
      clientX: 11,
      clientY: 11
    });
    await hover(harness.dom, second, { shiftKey: true, clientX: 31 });
    expect(harness.socket.sent.map((message) => JSON.parse(message).type))
      .not.toContain("hoshidicts_lookup");

    const range = harness.dom.window.document.createRange();
    range.setStart(harness.first.firstChild!, 0);
    range.setEnd(second.firstChild!, 1);
    const selection = harness.dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    dispatchMouse(harness.dom, second, "mouseup", { button: 0, clientX: 31, clientY: 11 });

    const request = lastRequest(harness.socket);
    expect(request).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べ",
      scanLength: 2
    });

    const response = lookupResult(request.requestId, "食べる", "exact match");
    response.results[0].matched = "食べ";
    response.results[0].deinflected = "食べる";
    response.results.unshift({
      ...lookupResult(request.requestId, "食", "short prefix").results[0]
    });
    await respond(harness.socket, response);

    const popup = harness.reader.getPopupElement();
    expect(popup.querySelectorAll(".gsm-hoshidicts-entry")).toHaveLength(1);
    expect(popup.textContent).toContain("exact match");
    expect(popup.textContent).not.toContain("short prefix");
    expect(popup.style.left).toBe("200px");
    expect(popup.style.top).toBe("124px");

    dispatchMouse(harness.dom, harness.dom.window.document.body, "mousemove", {
      clientX: 500,
      clientY: 500
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.reader.isVisible()).toBe(true);
  });

  it("shows not found and prefills Note when only a shorter prefix matches", async () => {
    const harness = createReaderHarness({
      lookupMode: "shift"
    });
    const second = harness.dom.window.document.getElementById("second")!;
    // Anchor the selection near the viewport bottom so the notice opens above
    // the word, which automatically pins its toolbar to the bottom.
    setRect(harness.first, { left: 10, top: 700, right: 30, bottom: 720 });
    setRect(second, { left: 30, top: 700, right: 90, bottom: 720 });

    dispatchMouse(harness.dom, harness.first, "mousedown", { button: 0 });
    const range = harness.dom.window.document.createRange();
    range.setStart(harness.first.firstChild!, 0);
    range.setEnd(second.firstChild!, 1);
    const selection = harness.dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    dispatchMouse(harness.dom, second, "mouseup", { button: 0 });

    const request = lastRequest(harness.socket);
    await respond(harness.socket, lookupResult(request.requestId, "食", "short prefix"));

    const popup = harness.reader.getPopupElement();
    expect(popup.dataset.toolbarPosition).toBe("bottom");
    expect(popup.textContent).toContain("No definitions found");
    expect(popup.textContent).not.toContain("short prefix");
    expect(popup.querySelector<HTMLInputElement>(".gsm-hoshidicts-note-term")?.value)
      .toBe("食べ");
    expect(popup.lastElementChild?.classList.contains(
      "gsm-hoshidicts-result-chrome"
    )).toBe(true);
  });

  it("records the first canonical result exactly once after rendering", async () => {
    const onLookup = vi.fn();
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      onLookup,
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    const response = lookupResult(request.requestId, "食べる");
    response.results.push({
      ...response.results[0],
      term: {
        ...response.results[0].term,
        expression: "食う",
        reading: "くう"
      }
    });

    await respond(socket, response);

    expect(reader.isVisible()).toBe(true);
    expect(onLookup).toHaveBeenCalledTimes(1);
    expect(onLookup).toHaveBeenCalledWith({
      term: "食べる",
      reading: "たべる"
    });
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBeUndefined();
  });

  it("keeps zero-value seen and lookup counts visible without blocking the popup", async () => {
    const onLookup = vi.fn(() => lookupStats.promise);
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      onLookup,
    });
    const lookupStats = deferred<Record<string, unknown>>();
    await hover(dom, first);
    const request = lastRequest(socket);
    const response = lookupResult(request.requestId, "食べる");
    response.results.push({
      ...response.results[0],
      term: {
        ...response.results[0].term,
        expression: "食う",
        reading: "くう"
      }
    });
    socket.receive(response);

    const popup = reader.getPopupElement();
    let entries = popup.querySelectorAll(
      ".gsm-hoshidicts-entry"
    );
    expect(reader.isVisible()).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].querySelector(".gsm-hoshidicts-lookup-stats")?.hidden)
      .toBe(true);
    (popup.querySelector(".gsm-hoshidicts-show-more") as HTMLButtonElement | null)
      ?.click();
    await vi.advanceTimersByTimeAsync(0);
    entries = popup.querySelectorAll(".gsm-hoshidicts-entry");
    expect(entries).toHaveLength(2);
    expect(entries[1].querySelector(".gsm-hoshidicts-lookup-stats")).toBeNull();

    lookupStats.resolve({ success: true, seenCount: 0, lookupCount: 0 });
    await flushPromises();

    const countLine = entries[0].querySelector<HTMLElement>(
      ".gsm-hoshidicts-lookup-stats"
    );
    expect(countLine?.hidden).toBe(false);
    expect(countLine?.textContent).toBe("Seen 0 times · Looked up 0 times");
    expect(countLine?.getAttribute("role")).toBe("status");
    expect(countLine?.getAttribute("aria-live")).toBe("polite");
    expect(onLookup).toHaveBeenCalledTimes(1);
  });

  it("does not record or mount lookup counts when disabled", async () => {
    const onLookup = vi.fn();
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      showLookupCounts: false,
      onLookup,
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "食べる"));

    expect(onLookup).not.toHaveBeenCalled();
    expect(reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-lookup-stats"
    )).toBeNull();
  });

  it("removes counts and suppresses an in-flight response when disabled live", async () => {
    const onLookup = vi.fn(() => lookupStats.promise);
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      onLookup,
    });
    const lookupStats = deferred<Record<string, unknown>>();
    await hover(dom, first);
    const request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "食べる"));
    expect(onLookup).toHaveBeenCalledTimes(1);

    reader.updatePreferences({ showLookupCounts: false });
    expect(reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-lookup-stats"
    )).toBeNull();
    lookupStats.resolve({ success: true, seenCount: 8, lookupCount: 3 });
    await flushPromises();
    expect(reader.getPopupElement().textContent).not.toContain("Seen 8 times");
  });

  it("ignores lookup counts that resolve after a newer popup renders", async () => {
    const onLookup = vi.fn()
      .mockImplementationOnce(() => firstStats.promise)
      .mockImplementationOnce(() => secondStats.promise);
    const { api, dom, first, reader, second, socket } = createReaderHarness({
      lookupMode: "hover",
      onLookup,
    });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const firstStats = deferred<Record<string, unknown>>();
    const secondStats = deferred<Record<string, unknown>>();

    await hover(dom, first);
    const firstRequest = lastRequest(socket);
    await respond(socket, lookupResult(firstRequest.requestId, "食べる"));

    await hover(dom, second, { clientX: 31 });
    const secondRequest = lastRequest(socket);
    await respond(socket, lookupResult(secondRequest.requestId, "べる", "new result"));

    firstStats.resolve({ success: true, seenCount: 99, lookupCount: 99 });
    await flushPromises();
    const countLine = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-lookup-stats"
    );
    expect(reader.getPopupElement().textContent).toContain("new result");
    expect(countLine?.textContent).toBe("");

    secondStats.resolve({ success: true, seenCount: 2, lookupCount: 3 });
    await flushPromises();
    expect(countLine?.textContent).toBe("Seen 2 times · Looked up 3 times");
  });

  it("does not record stale, failed, or empty lookup responses", async () => {
    const onLookup = vi.fn();
    const { api, dom, first, reader, second, socket } = createReaderHarness({
      lookupMode: "hover",
      onLookup,
    });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });

    await hover(dom, first);
    const firstRequest = lastRequest(socket);
    socket.receive(lookupResult("stale-request", "古い"));
    socket.receive({
      type: "hoshidicts_lookup_result",
      requestId: firstRequest.requestId,
      success: false,
      error: "failed",
      results: []
    });

    await hover(dom, second, { clientX: 31 });
    const secondRequest = lastRequest(socket);
    await respond(socket, {
      type: "hoshidicts_lookup_result",
      requestId: secondRequest.requestId,
      success: true,
      error: null,
      results: []
    });

    expect(onLookup).not.toHaveBeenCalled();
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("write failed");
      }
    ],
    ["rejects", () => Promise.reject(new Error("write failed"))]
  ])(
    "keeps the popup visible when lookup recording %s",
    async (_name, onLookup) => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const { api, dom, first, reader, socket } = createReaderHarness({
        lookupMode: "hover",
        onLookup,
        logger
      });
      await hover(dom, first);
      const request = lastRequest(socket);

      expect(() =>
        socket.receive(lookupResult(request.requestId, "食べる"))
      ).not.toThrow();
      await flushPromises();

      expect(reader.isVisible()).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[HoshidictsReader] lookup.record-failed")
      );
      reader.destroy();
    }
  );

  it("looks up immediately without a modifier in hover mode and reports its activation mode", () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    };

    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      logger
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    dispatchMouse(dom, first, "mousemove", { clientX: 11, clientY: 11 });
    expect(lastRequest(socket)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる",
      scanLength: 16,
      maxResults: 32,
      sortFrequencyDictionary: null,
      sortFrequencyDictionaryOrder: "descending"
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('"requiresShift":false')
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] hover.activation-key-required")
    );
  });

  it("requires the hovered token to be entirely Japanese when enabled", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      onlyScanJapaneseText: true
    });
    harness.first.textContent = "食べるabc";
    harness.dom.window.document.getElementById("second")!.textContent = "";

    await hover(harness.dom, harness.first);
    expect(
      harness.socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("hoshidicts_lookup");

    await hover(harness.dom, harness.first, { shiftKey: true });
    expect(
      harness.socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("hoshidicts_lookup");

    harness.first.textContent = "食べる。";
    harness.dom.window.document.getElementById("second")!.textContent = "next";
    await hover(harness.dom, harness.first);
    expect(lastRequest(harness.socket).text).toBe("食べる。next");

    harness.reader.updatePreferences({ onlyScanJapaneseText: false });
    harness.first.textContent = "hello";
    harness.dom.window.document.getElementById("second")!.textContent = " world";
    await hover(harness.dom, harness.first);
    expect(lastRequest(harness.socket).text).toBe("hello world");
  });

  it("does not let the activation key bypass Japanese-only scanning", async () => {
    const harness = createReaderHarness({
      lookupMode: "shift",
      onlyScanJapaneseText: true
    });
    harness.first.textContent = "hello";
    harness.dom.window.document.getElementById("second")!.textContent = " world";

    await hover(harness.dom, harness.first, { shiftKey: true });

    expect(
      harness.socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("hoshidicts_lookup");
  });

  it("starts an unmodified hover lookup when live preferences disable Shift", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "shift",
    });

    await hover(dom, first);
    expect(socket.sent).toHaveLength(1);

    reader.updatePreferences({ lookupMode: "hover" });
    await vi.advanceTimersByTimeAsync(20);

    expect(lastRequest(socket)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
  });

  it("logs initialization, the Shift requirement, socket state, and lookup outcome", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    };

    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      serverUrl: "ws://127.0.0.1:7276",
      logger
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] reader.initialized")
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] socket.connecting")
    );

    dispatchMouse(dom, first, "mousemove", { clientX: 11, clientY: 11 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] hover.activation-key-required")
    );

    const socket = FakeWebSocket.instances[0];
    socket.open();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] socket.open")
    );

    await hover(dom, first, { shiftKey: true });
    const request = lastRequest(socket);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] lookup.sent")
    );

    socket.receive(lookupResult(request.requestId, "食べる"));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] lookup.rendered")
    );
  });

  it("keeps text lookups working with a legacy server that omits generation", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const { api, dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:unused"),
      revokeObjectURL: vi.fn(),
      logger
    }));

    await hover(dom, first);
    const request = lastRequest(socket);
    const legacyResponse = lookupResult(
      request.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: [
          { tag: "span", content: "Legacy definition" },
          { tag: "img", path: "img/unavailable.jpg" }
        ]
      })
    );
    delete (legacyResponse as Partial<typeof legacyResponse>).generation;
    socket.receive(legacyResponse);

    expect(reader.isVisible()).toBe(true);
    expect(reader.getPopupElement().textContent).toContain("Legacy definition");
    expect(reader.getPopupElement().querySelector("img")).toBeNull();
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("lookup.media-generation-unavailable")
    );
  });

  it("renders a Yomitan-style ruby header with no default tabs and a reusable popup lifecycle", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    Object.defineProperty(dom.window, "innerWidth", { value: 1280 });
    Object.defineProperty(dom.window, "innerHeight", { value: 720 });
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 120, top: 100, right: 160, bottom: 140 });
    const states: boolean[] = [];

    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      serverUrl: "ws://127.0.0.1:7276",
      onPopupStateChange: (visible: boolean) => states.push(visible),
      logger: { debug() {}, warn() {} }
    });
    expect(dom.window.document.documentElement.dataset.gsmHoshidictsEnabled).toBe(
      "true"
    );
    const socket = FakeWebSocket.instances[0];
    socket.open();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "configure_features",
      features: ["hoshidicts"]
    });

    dispatchKey(dom, dom.window.document, "keydown", { key: "Shift" });
    dispatchMouse(dom, first, "mousemove", { shiftKey: true, clientX: 130, clientY: 110 });

    expect(socket.sent).toHaveLength(2);
    dispatchMouse(dom, first, "mousemove", { shiftKey: true, clientX: 130, clientY: 110 });
    expect(socket.sent).toHaveLength(2);
    const request = JSON.parse(socket.sent[1]);
    expect(request).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });

    await respond(socket, lookupResult(request.requestId, "食べる"));

    const popup = reader.getPopupElement();
    expect(reader.isVisible()).toBe(true);
    const chrome = popup.querySelector(".gsm-hoshidicts-result-chrome");
    const primaryHeader = chrome?.querySelector(
      ".gsm-hoshidicts-primary-header"
    );
    const metadataStrip = chrome?.querySelector(
      ".gsm-hoshidicts-metadata-strip"
    );
    const tablist = chrome?.querySelector('[role="tablist"]');
    const noteForm = popup.querySelector(".gsm-hoshidicts-note-form");
    const tabPanel = popup.querySelector(".gsm-hoshidicts-tab-panel");
    expect(popup.firstElementChild === chrome).toBe(true);
    expect(chrome?.firstElementChild === primaryHeader).toBe(true);
    expect(primaryHeader?.nextElementSibling === metadataStrip).toBe(true);
    expect(tablist).toBeNull();
    expect(metadataStrip?.querySelector(
      ".gsm-hoshidicts-primary-metadata-capsule"
    )).not.toBeNull();
    expect(tabPanel?.getAttribute("role")).toBeNull();
    const feedback = popup.querySelector(".gsm-hoshidicts-mining-feedback");
    expect(chrome?.nextElementSibling === feedback).toBe(true);
    expect(feedback?.nextElementSibling === noteForm).toBe(true);
    expect(noteForm?.nextElementSibling === tabPanel).toBe(true);
    expect(primaryHeader?.querySelector("ruby")).not.toBeNull();
    const pitchReading = primaryHeader?.querySelector<HTMLElement>(
      ".gsm-hoshidicts-pitch-reading"
    );
    expect(pitchReading?.textContent).toBe("たべる");
    expect(pitchReading?.dataset.pitchPosition).toBe("2");
    expect(pitchReading?.dataset.pitchDictionary).toBe("Pitch");
    expect(popup.querySelector(".gsm-hoshidicts-tag-pitch")).toBeNull();
    expect(
      Array.from(
        pitchReading?.querySelectorAll<HTMLElement>(
          ".gsm-hoshidicts-pitch-mora"
        ) || [],
        (mora) => ({
          level: mora.dataset.pitchLevel,
          text: mora.textContent,
          transition: mora.dataset.pitchTransition,
        })
      )
    ).toEqual([
      { level: "low", text: "た", transition: "rise" },
      { level: "high", text: "べ", transition: "drop" },
      { level: "low", text: "る", transition: undefined }
    ]);
    expect(primaryHeader?.querySelector(".gsm-hoshidicts-kanji-link")?.textContent)
      .toBe("食");
    expect(
      primaryHeader?.querySelector(".gsm-hoshidicts-expression")
        ?.getAttribute("aria-label")
    ).toBe("食べる, たべる");
    expect(primaryHeader?.querySelector(".gsm-hoshidicts-reading")).toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-tag-deinflection")).toBeNull();
    expect(popup.textContent).toContain("JMdict");
    expect(popup.textContent).toContain("to eat");
    expect(popup.querySelector("details")?.open).toBe(true);
    const actions = primaryHeader?.querySelector(".gsm-hoshidicts-entry-actions");
    expect(actions?.querySelector(".gsm-hoshidicts-audio-button")).not.toBeNull();
    expect(actions?.querySelector(".gsm-hoshidicts-mine-button")).not.toBeNull();
    const noteButton = actions?.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-note-button"
    );
    expect(noteButton?.textContent).toBe("✎");
    expect(noteButton?.title).toBe("Add a custom definition");
    expect(noteButton?.getAttribute("aria-label")).toBe(
      "Add a custom definition"
    );
    expect(noteButton?.getAttribute("aria-expanded")).toBe("false");
    expect(
      actions?.querySelector<HTMLButtonElement>(".gsm-hoshidicts-audio-button")
        ?.textContent
    ).toBe("");
    expect(
      Array.from(actions?.children || [], (action) => action.className)
    ).toEqual([
      "gsm-hoshidicts-mine-button",
      "gsm-hoshidicts-audio-button",
      "gsm-hoshidicts-note-button"
    ]);
    expect(states).toEqual([true]);

    reader.hide("test");
    expect(states).toEqual([true, false]);
    reader.destroy();
    expect(dom.window.document.documentElement.dataset.gsmHoshidictsEnabled).toBe(
      undefined
    );
  });

  it("keeps the audio action hidden when the configured source list is empty", async () => {
    const harness = createReaderHarness({
      audioPreferences: {
        enabled: true,
        sources: []
      }
    });
    await renderFirstLookup(harness);

    const audioButton = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-audio-button");
    expect(audioButton).not.toBeNull();
    expect(audioButton?.hidden).toBe(true);
  });

  it("updates audio action visibility when the configured source list changes", async () => {
    const harness = createReaderHarness({
      audioPreferences: {
        enabled: true,
        sources: [{ id: "jisho", type: "jisho", url: "", voice: "" }]
      }
    });
    await renderFirstLookup(harness);

    const audioButton = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-audio-button")!;
    expect(audioButton.hidden).toBe(false);

    harness.reader.updateAudioPreferences({ sources: [] });
    expect(audioButton.hidden).toBe(true);

    harness.reader.updateAudioPreferences({
      sources: [{ id: "jisho", type: "jisho", url: "", voice: "" }]
    });
    expect(audioButton.hidden).toBe(false);
  });

  it("opens clicked kanji details and restores the cached term view", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      dictionaryPresentation: [
        {
          title: "KANJIDIC (English)",
          favorite: false,
          displayName: "My kanji dictionary"
        }
      ],
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    await respond(socket, lookupResult(termRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    const kanjiLink = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-kanji-link"
    );
    expect(kanjiLink?.textContent).toBe("食");
    kanjiLink?.click();
    const directRequest = lastRequest(socket);
    expect(directRequest).toMatchObject({ text: "食", mode: "kanji" });

    socket.receive(kanjiResult(directRequest.requestId));
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-result-chrome"))
      .toBe(true);
    expect(first.classList.contains("gsm-hoshidicts-source-match")).toBe(false);
    expect(popup.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent).toBe("食");
    expect(popup.textContent).toContain("My kanji dictionary");
    expect(
      popup.querySelector<HTMLElement>(".gsm-hoshidicts-kanji-dictionary")?.title
    ).toBe("KANJIDIC (English)");
    expect(popup.textContent).toContain("ショク · ジキ");
    expect(popup.textContent).toContain("eat");
    expect(popup.querySelector(".gsm-hoshidicts-mine-button")).toBeNull();

    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-back")?.click();
    expect(popup.textContent).toContain("to eat");
    expect(popup.querySelector(".gsm-hoshidicts-entry")).not.toBeNull();
  });

  it("shows only the selected dictionary when a kanji is clicked", async () => {
    const harness = createReaderHarness({
      kanjiClickDictionary: "My dictionary"
    } as Parameters<typeof createReaderHarness>[0]);

    await hover(harness.dom, harness.first, { shiftKey: true });
    const termRequest = lastRequest(harness.socket);
    harness.socket.receive(lookupResult(termRequest.requestId, "食べる"));
    harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = lastRequest(harness.socket);
    const response = kanjiResult(directRequest.requestId);
    response.kanji.entries.push({
      ...response.kanji.entries[0],
      dictionary: "My dictionary",
      definitions: ["preferred"]
    });
    harness.socket.receive(response);

    expect(
      harness.reader.getPopupElement()
        .querySelector<HTMLElement>(".gsm-hoshidicts-kanji-dictionary")?.title
    ).toBe("My dictionary");
    expect(
      harness.reader.getPopupElement()
        .querySelectorAll(".gsm-hoshidicts-kanji-entry")
    ).toHaveLength(1);
  });

  it("defaults clicked kanji to KANJIDIC when it is installed", async () => {
    const harness = createReaderHarness();

    await hover(harness.dom, harness.first, { shiftKey: true });
    const termRequest = lastRequest(harness.socket);
    harness.socket.receive(lookupResult(termRequest.requestId, "食べる"));
    harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = lastRequest(harness.socket);
    const response = kanjiResult(directRequest.requestId);
    response.kanji.entries.unshift({
      ...response.kanji.entries[0],
      dictionary: "Another dictionary",
      definitions: ["other"]
    });
    harness.socket.receive(response);

    expect(
      harness.reader.getPopupElement()
        .querySelector<HTMLElement>(".gsm-hoshidicts-kanji-dictionary")?.title
    ).toBe("KANJIDIC (English)");
    expect(
      harness.reader.getPopupElement()
        .querySelectorAll(".gsm-hoshidicts-kanji-entry")
    ).toHaveLength(1);
    expect(
      response.kanji.entries.map((entry: { dictionary: string }) => entry.dictionary)
    ).toEqual([
      "Another dictionary",
      "KANJIDIC (English)"
    ]);
  });

  it("keeps a clicked kanji lookup active when Shift is released inside the popup", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness();

    dispatchKey(dom, dom.window.document, "keydown", { key: "Shift" });
    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    socket.receive(lookupResult(termRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    popup.dispatchEvent(new dom.window.Event("pointerenter"));
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = lastRequest(socket);
    expect(directRequest).toMatchObject({ text: "食", mode: "kanji" });

    dispatchKey(dom, dom.window.document, "keyup", { key: "Shift" });
    socket.receive(kanjiResult(directRequest.requestId));

    expect(popup.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent).toBe("食");
    expect(reader.isVisible()).toBe(true);
  });

  it("restores cached term results after direct kanji misses, failures, and timeouts", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupTimeoutMs: 50,
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    socket.receive(lookupResult(termRequest.requestId, "食べる"));
    const popup = reader.getPopupElement();
    const clickKanji = () => {
      popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
      return lastRequest(socket);
    };
    const expectTermView = () => {
      expect(reader.isVisible()).toBe(true);
      expect(popup.querySelector(".gsm-hoshidicts-entry")).not.toBeNull();
      expect(popup.textContent).toContain("to eat");
    };

    const emptyRequest = clickKanji();
    socket.receive({
      type: "hoshidicts_lookup_result",
      requestId: emptyRequest.requestId,
      success: true,
      dictionaryCount: 1,
      featureDisabled: false,
      error: null,
      results: [],
      kanji: null
    });
    expectTermView();

    const failedRequest = clickKanji();
    socket.receive({
      type: "hoshidicts_lookup_result",
      requestId: failedRequest.requestId,
      success: false,
      dictionaryCount: 1,
      featureDisabled: false,
      error: "kanji lookup failed",
      results: [],
      kanji: null
    });
    expectTermView();

    clickKanji();
    await vi.advanceTimersByTimeAsync(50);
    expectTermView();
  });

  it("reconnects with the term query after returning from kanji details", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    socket.receive(lookupResult(termRequest.requestId, "食べる"));
    const popup = reader.getPopupElement();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = lastRequest(socket);
    socket.receive(kanjiResult(directRequest.requestId));
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-back")?.click();
    expect(popup.textContent).toContain("to eat");

    socket.close();
    await vi.advanceTimersByTimeAsync(1);
    const reconnected = FakeWebSocket.instances[1];
    reconnected.open();
    const retry = lastRequest(reconnected);

    expect(retry).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    expect(retry.mode).toBeUndefined();
  });

  it("renders a term-first kanji fallback without a Back action", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness();
    await hover(dom, first, { shiftKey: true });
    const request = lastRequest(socket);
    expect(request.mode).toBeUndefined();

    socket.receive(kanjiResult(request.requestId));
    const popup = reader.getPopupElement();
    expect(popup.querySelector(".gsm-hoshidicts-kanji-entry")).not.toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-kanji-back")).toBeNull();
  });

  it("queries a generic term dictionary for a clicked kanji and shows only its definition", async () => {
    const { dom, first, reader, socket } = createReaderHarness({
      kanjiClickDictionary: "ゴブリンじゃない人のJPDB漢字辞典",
      dictionaryPresentation: [
        {
          title: "ゴブリンじゃない人のJPDB漢字辞典",
          favorite: false,
          termCount: 20409,
          kanjiCount: 0
        },
        { title: "JMdict", favorite: false, termCount: 1000, kanjiCount: 0 }
      ]
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    await respond(socket, lookupResult(termRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();

    // A term-only selected dictionary has no kanji bank, so the clicked kanji
    // must go through the term path, never the empty Kanji lookup.
    const directRequest = lastRequest(socket);
    expect(directRequest).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食"
    });
    expect(directRequest.mode).toBeUndefined();

    await respond(
      socket,
      lookupResultWithDictionaries(
        directRequest.requestId,
        [
          {
            dictionary: "ゴブリンじゃない人のJPDB漢字辞典",
            glossary: "to eat (single character)"
          },
          { dictionary: "JMdict", glossary: "unselected definition" }
        ],
        "食"
      )
    );

    expect(popup.textContent).toContain("to eat (single character)");
    expect(popup.textContent).not.toContain("unselected definition");
    const glossaryText = [
      ...popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-glossary-content")
    ].map((node) => node.textContent);
    expect(glossaryText).toContain("to eat (single character)");
    expect(glossaryText).not.toContain("unselected definition");

    // Back returns to the cached pre-click term view.
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-back")?.click();
    expect(popup.textContent).toContain("to eat");
    expect(popup.querySelector(".gsm-hoshidicts-entry")).not.toBeNull();
  });

  it("keeps the Kanji lookup mode for an explicit kanji-bank dictionary", async () => {
    const { dom, first, reader, socket } = createReaderHarness({
      kanjiClickDictionary: "KANJIDIC (English)",
      dictionaryPresentation: [
        {
          title: "KANJIDIC (English)",
          favorite: false,
          termCount: 0,
          kanjiCount: 13108
        }
      ]
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    await respond(socket, lookupResult(termRequest.requestId, "食べる"));

    reader
      .getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")
      ?.click();
    expect(lastRequest(socket)).toMatchObject({ text: "食", mode: "kanji" });
  });

  it("keeps the Kanji lookup mode when no clicked-kanji dictionary is selected", async () => {
    const { dom, first, reader, socket } = createReaderHarness();

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    await respond(socket, lookupResult(termRequest.requestId, "食べる"));

    reader
      .getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")
      ?.click();
    expect(lastRequest(socket)).toMatchObject({ text: "食", mode: "kanji" });
  });

  it("restores the cached term view when the generic dictionary has no entry for the kanji", async () => {
    const { dom, first, reader, socket } = createReaderHarness({
      kanjiClickDictionary: "ゴブリンじゃない人のJPDB漢字辞典",
      dictionaryPresentation: [
        {
          title: "ゴブリンじゃない人のJPDB漢字辞典",
          favorite: false,
          termCount: 20409,
          kanjiCount: 0
        }
      ]
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    await respond(socket, lookupResult(termRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = lastRequest(socket);

    // The dictionary returns a match for another dictionary only, so the
    // selection projects to nothing and must not leak an unselected result.
    await respond(
      socket,
      lookupResultWithDictionaries(
        directRequest.requestId,
        [{ dictionary: "JMdict", glossary: "unselected only" }],
        "食"
      )
    );

    expect(popup.textContent).not.toContain("unselected only");
    expect(popup.textContent).toContain("to eat");
    expect(popup.querySelector(".gsm-hoshidicts-entry")).not.toBeNull();
  });

  it("ignores a late generic clicked-kanji response after a newer lookup", async () => {
    const { dom, first, second, reader, socket } = createReaderHarness({
      kanjiClickDictionary: "ゴブリンじゃない人のJPDB漢字辞典",
      dictionaryPresentation: [
        {
          title: "ゴブリンじゃない人のJPDB漢字辞典",
          favorite: false,
          termCount: 20409,
          kanjiCount: 0
        }
      ]
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    await respond(socket, lookupResult(termRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const staleRequest = lastRequest(socket);

    // A newer lookup supersedes the pending clicked-kanji request.
    setRect(second, { left: 40, top: 40, right: 60, bottom: 60 });
    await hover(dom, second, { shiftKey: true, clientX: 41, clientY: 41 });
    const freshRequest = lastRequest(socket);
    expect(freshRequest.requestId).not.toBe(staleRequest.requestId);

    await respond(
      socket,
      lookupResultWithDictionaries(
        staleRequest.requestId,
        [
          {
            dictionary: "ゴブリンじゃない人のJPDB漢字辞典",
            glossary: "stale definition"
          }
        ],
        "食"
      )
    );

    expect(popup.textContent).not.toContain("stale definition");
  });

  it("does not mutate the cached term result arrays when projecting a clicked kanji", async () => {
    const { dom, first, reader, socket } = createReaderHarness({
      kanjiClickDictionary: "ゴブリンじゃない人のJPDB漢字辞典",
      dictionaryPresentation: [
        {
          title: "ゴブリンじゃない人のJPDB漢字辞典",
          favorite: false,
          termCount: 20409,
          kanjiCount: 0
        }
      ]
    });

    await hover(dom, first, { shiftKey: true });
    const termRequest = lastRequest(socket);
    await respond(socket, lookupResult(termRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = lastRequest(socket);
    const response = lookupResultWithDictionaries(
      directRequest.requestId,
      [
        {
          dictionary: "ゴブリンじゃない人のJPDB漢字辞典",
          glossary: "selected"
        },
        { dictionary: "JMdict", glossary: "unselected" }
      ],
      "食"
    );
    const sourceGlossaries = response.results[0].term.glossaries;
    await respond(socket, response);

    // The overlay projects a copy; the response arrays it received are intact.
    expect(response.results[0].term.glossaries).toBe(sourceGlossaries);
    expect(response.results[0].term.glossaries).toHaveLength(2);
  });


  it("keeps the popup open while choosing an audio source", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      popupHideDelayMs: 50,
      audioClient: {
        getCandidates: vi.fn(async () => [{ index: 0, name: "Default" }]),
        getMedia: vi.fn()
      },
      audioPreferences: {
        version: 1,
        enabled: true,
        autoPlay: false,
        volume: 100,
        sources: [{ id: "jisho", type: "jisho", url: "", voice: "" }]
      }
    });
    const { dom, reader } = harness;
    await renderFirstLookup(harness, { shiftKey: false });

    const popup = reader.getPopupElement();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-audio-button")!
      .dispatchEvent(new dom.window.MouseEvent("click", {
        bubbles: true,
        shiftKey: true
      }));
    await flushPromises();
    const menu = dom.window.document.querySelector<HTMLElement>(
      ".gsm-hoshidicts-audio-menu"
    )!;
    expect(menu).not.toBeNull();

    popup.dispatchEvent(new dom.window.Event("pointerleave"));
    dispatchMouse(dom, menu, "mousemove");
    await vi.advanceTimersByTimeAsync(100);

    expect(reader.isVisible()).toBe(true);
    expect(menu.isConnected).toBe(true);
  });

  it("keeps a persistent top Note action and refreshes the lookup after saving", async () => {
    const addCustomEntry = vi.fn(async () => await pendingSave);
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      onAddCustomEntry: addCustomEntry,
    });
    let finishSave!: (value: { saved: boolean }) => void;
    const pendingSave = new Promise<{ saved: boolean }>((resolve) => {
      finishSave = resolve;
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "食べる"));

    const popup = reader.getPopupElement();
    const noteButton = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-note-button"
    )!;
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-result-chrome"))
      .toBe(true);
    expect(noteButton.textContent).toBe("✎");
    expect(noteButton.getAttribute("aria-label")).toBe(
      "Add a custom definition"
    );
    expect(noteButton.closest(".gsm-hoshidicts-entry-actions")).not.toBeNull();
    expect(popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-mine-button"
    )?.hidden).toBe(true);
    expect(noteButton.hidden).toBe(false);
    noteButton.click();
    const form = popup.querySelector<HTMLFormElement>(
      ".gsm-hoshidicts-note-form"
    )!;
    const term = form.querySelector<HTMLInputElement>(
      ".gsm-hoshidicts-note-term"
    )!;
    const reading = form.querySelector<HTMLInputElement>(
      ".gsm-hoshidicts-note-reading"
    )!;
    const definition = form.querySelector<HTMLTextAreaElement>(
      ".gsm-hoshidicts-note-definition"
    )!;
    expect(form.hidden).toBe(false);
    expect(term.value).toBe("食べる");
    expect(reading.value).toBe("たべる");
    definition.value = "A personal definition";
    dispatchPlain(dom, form, "submit", { cancelable: true });
    await flushPromises();

    expect(addCustomEntry).toHaveBeenCalledWith({
      term: "食べる",
      reading: "たべる",
      definition: "A personal definition"
    });
    expect(term.disabled).toBe(true);
    expect(reading.disabled).toBe(true);
    expect(definition.disabled).toBe(true);
    const cancel = form.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-note-cancel"
    )!;
    expect(cancel.disabled).toBe(true);
    cancel.click();
    expect(form.hidden).toBe(false);

    finishSave({ saved: true });
    await flushPromises();
    expect(form.hidden).toBe(true);
    const repeatedRequest = lastRequest(socket);
    expect(repeatedRequest).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    expect(repeatedRequest.requestId).not.toBe(request.requestId);

    socket.receive(lookupResult(
      repeatedRequest.requestId,
      "食べる",
      "A personal definition"
    ));
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-result-chrome"))
      .toBe(true);
    expect(popup.textContent).toContain("A personal definition");
  });

  it("validates and preserves a Note draft while failures suspend auto-hide", async () => {
    const addCustomEntry = vi.fn(async () => {
      throw new Error("Custom dictionary is read-only.");
    });
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      onAddCustomEntry: addCustomEntry,
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    socket.receive(lookupResult(request.requestId, "食べる"));

    const popup = reader.getPopupElement();
    const noteButton = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-note-button"
    )!;
    noteButton.click();
    const form = popup.querySelector<HTMLFormElement>(
      ".gsm-hoshidicts-note-form"
    )!;
    const term = form.querySelector<HTMLInputElement>(
      ".gsm-hoshidicts-note-term"
    )!;
    form.querySelector<HTMLButtonElement>(".gsm-hoshidicts-note-cancel")!.click();
    expect(form.hidden).toBe(true);
    noteButton.click();
    const definition = form.querySelector<HTMLTextAreaElement>(
      ".gsm-hoshidicts-note-definition"
    )!;
    dispatchPlain(dom, form, "submit", { cancelable: true });
    expect(addCustomEntry).not.toHaveBeenCalled();
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("required");

    definition.value = "\\".repeat(1_025);
    dispatchPlain(dom, form, "submit", { cancelable: true });
    expect(addCustomEntry).not.toHaveBeenCalled();
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("2 KiB");

    definition.value = "Visible definition";
    term.value = "#hidden";
    dispatchPlain(dom, form, "submit", { cancelable: true });
    expect(addCustomEntry).not.toHaveBeenCalled();
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("cannot begin with #");

    term.value = "食べる";
    definition.value = "Keep this draft";
    dispatchPlain(dom, form, "submit", { cancelable: true });
    await flushPromises();
    expect(addCustomEntry).toHaveBeenCalledOnce();
    expect(form.hidden).toBe(false);
    expect(definition.value).toBe("Keep this draft");
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("read-only");

    popup.dispatchEvent(new dom.window.Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.isVisible()).toBe(true);
    dispatchKey(dom, definition, "keydown", { key: "Escape" });
    expect(form.hidden).toBe(true);
    popup.dispatchEvent(new dom.window.Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(300);
    expect(reader.isVisible()).toBe(false);
  });

  it("defers result construction, media, and audio wiring until Show more", async () => {
    const audioController = createAudioControllerStub();
    const harness = createReaderHarness({
      audioController,
      createObjectURL: vi.fn(() => "blob:deferred"),
      lookupMode: "hover"
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        const firstResult = response.results[0];
        response.results = Array.from({ length: 7 }, (_, index) => ({
          ...firstResult,
          matched: `語${index}`,
          deinflected: `語${index}`,
          term: {
            ...firstResult.term,
            expression: `語${index}`,
            glossaries: firstResult.term.glossaries.map((glossary) => ({
              ...glossary,
              glossary: index === 6
                ? JSON.stringify({
                    type: "structured-content",
                    content: [{
                      tag: "img",
                      path: "img/deferred.jpg",
                      width: 67,
                      height: 100
                    }]
                  })
                : glossary.glossary
            }))
          }
        }));
      }
    });

    const popup = harness.reader.getPopupElement();
    expect(popup.querySelectorAll(".gsm-hoshidicts-entry")).toHaveLength(1);
    expect(sentRequests(harness.socket).filter(
      (value) => value.type === "hoshidicts_media"
    )).toHaveLength(0);
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[0])
      .toHaveLength(1);
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: true });

    const showMore = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-show-more"
    )!;
    expect(showMore.textContent).toBe("Show 6 more");
    showMore.click();
    // The expanded entries fill their glossaries on the next task.
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(popup.querySelectorAll(".gsm-hoshidicts-entry")).toHaveLength(7);
    expect(sentRequests(harness.socket).filter(
      (value) => value.type === "hoshidicts_media"
    )).toEqual([
      expect.objectContaining({
        generation: 1,
        dictionary: "JMdict",
        path: "img/deferred.jpg"
      })
    ]);
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[0])
      .toHaveLength(7);
    expect(audioController.setRenderedResults.mock.calls.at(-1)?.[1])
      .toEqual({ autoPlay: false });
  });

  it("deduplicates media requests and revokes cached Blob URLs on generation changes", async () => {
    const createObjectURL = vi.fn(() => "blob:portrait-1");
    const revokeObjectURL = vi.fn();
    const { api, dom, first, reader, second, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL,
    }));
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const glossary = JSON.stringify({
      type: "structured-content",
      content: [
        { tag: "img", path: "img/c35252.jpg", width: 67, height: 100 },
        { tag: "img", path: "img/c35252.jpg", width: 67, height: 100 },
        { tag: "span", content: "Kurisu Makise" }
      ]
    });

    await hover(dom, first);
    const lookup = lastRequest(socket);
    socket.receive(lookupResult(lookup.requestId, "食べる", glossary, 7));
    const mediaRequests = requestsOfType(socket, "hoshidicts_media");
    expect(mediaRequests).toEqual([
      expect.objectContaining({
        generation: 7,
        dictionary: "JMdict",
        path: "img/c35252.jpg"
      })
    ]);

    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: mediaRequests[0].requestId,
      success: true,
      generation: 7,
      dictionary: "JMdict",
      path: "img/c35252.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });

    const images = Array.from(
      reader.getPopupElement().querySelectorAll<HTMLImageElement>("img")
    );
    expect(images).toHaveLength(2);
    expect(images.every((image) => image.src === "blob:portrait-1")).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(dom.window.Blob);

    await hover(dom, second, { clientX: 31 });
    const secondLookup = lastRequest(socket);
    socket.receive(lookupResult(secondLookup.requestId, "べる", glossary, 8));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:portrait-1");
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(2);
    expect(lastRequest(socket)).toMatchObject({
      type: "hoshidicts_media",
      generation: 8
    });

    reader.destroy();
    await flushPromises();
  });

  it("renders the AVIF and SVG media used by current Jitendex", async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:jitendex-avif")
      .mockReturnValueOnce("blob:jitendex-svg");
    const { api, dom, first, reader } = createReaderHarness((dom) => ({
      openSocket: false,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    }));
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    await hover(dom, first);
    const lookup = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(lookupResult(
      lookup.requestId,
      "麻の葉",
      JSON.stringify({
        type: "structured-content",
        content: [
          { tag: "img", path: "jitendex/pattern.avif", width: 153, height: 250 },
          {
            tag: "img",
            path: "jitendex/glyph.svg",
            width: 1,
            height: 1,
            sizeUnits: "em",
            appearance: "monochrome"
          }
        ]
      }),
      21
    ));
    const requests = requestsOfType(socket, "hoshidicts_media");
    expect(requests).toHaveLength(2);

    const avif = Buffer.from([
      0, 0, 0, 24,
      0x66, 0x74, 0x79, 0x70,
      0x61, 0x76, 0x69, 0x66,
      0, 0, 0, 0,
      0x61, 0x76, 0x69, 0x66,
      0x6d, 0x69, 0x66, 0x31
    ]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
    for (const [request, mediaType, bytes] of [
      [requests[0], "image/avif", avif],
      [requests[1], "image/svg+xml", svg]
    ] as const) {
      socket.receive({
        type: "hoshidicts_media_result",
        requestId: request.requestId,
        success: true,
        generation: 21,
        dictionary: "JMdict",
        path: request.path,
        mediaType,
        byteLength: bytes.byteLength,
        dataBase64: bytes.toString("base64"),
        featureDisabled: false,
        staleGeneration: false,
        error: null
      });
    }
    await flushPromises();

    const images = Array.from(
      reader.getPopupElement().querySelectorAll<HTMLImageElement>("img.gloss-image")
    );
    expect(images.map((image) => image.src)).toEqual([
      "blob:jitendex-avif",
      "blob:jitendex-svg"
    ]);
    expect(createObjectURL.mock.calls.map(([blob]) => blob.type)).toEqual([
      "image/avif",
      "image/svg+xml"
    ]);
    expect(images[1].closest<HTMLElement>(".gloss-image-link")?.dataset.appearance)
      .toBe("monochrome");
  });

  it("stops queued media work when the feature is disabled", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:unused"),
      revokeObjectURL: vi.fn(),
    }));

    await hover(dom, first);
    const lookup = lastRequest(socket);
    socket.receive(lookupResult(
      lookup.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: Array.from({ length: 6 }, (_, index) => ({
          tag: "img",
          path: `img/${index}.jpg`
        }))
      }),
      10
    ));
    const requests = requestsOfType(socket, "hoshidicts_media");
    expect(requests).toHaveLength(4);
    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: requests[0].requestId,
      success: false,
      generation: requests[0].generation,
      dictionary: requests[0].dictionary,
      path: requests[0].path,
      mediaType: null,
      byteLength: 0,
      dataBase64: null,
      featureDisabled: true,
      staleGeneration: false,
      error: "feature_disabled"
    });

    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(4);
  });

  it("keeps surrounding text when media decoding fails or times out", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      mediaRequestTimeoutMs: 50,
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:late"),
      revokeObjectURL: vi.fn(),
    }));
    await hover(dom, first);
    const request = lastRequest(socket);
    socket.receive(lookupResult(
      request.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: [
          { tag: "img", path: "img/broken.jpg" },
          { tag: "img", path: "img/missing.jpg" },
          { tag: "span", content: "Definition remains readable" }
        ]
      }),
      3
    ));
    const mediaRequests = requestsOfType(socket, "hoshidicts_media");
    expect(mediaRequests).toHaveLength(2);
    socket.receive({
      type: "hoshidicts_media_result",
      requestId: mediaRequests[0].requestId,
      success: true,
      generation: 3,
      dictionary: "JMdict",
      path: "img/broken.jpg",
      mediaType: "image/jpeg",
      byteLength: 3,
      dataBase64: "AAAA",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });
    await vi.advanceTimersByTimeAsync(50);
    await flushPromises();

    const popup = reader.getPopupElement();
    expect(popup.textContent).toContain("Definition remains readable");
    expect(
      Array.from(popup.querySelectorAll<HTMLImageElement>("img"))
        .every((image) => image.hidden)
    ).toBe(true);
  });

  it("cancels pending media when the popup is dismissed", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:portrait"),
      revokeObjectURL: vi.fn(),
    }));
    const glossary = JSON.stringify({
      type: "structured-content",
      content: [{ tag: "img", path: "img/pending.jpg" }]
    });

    await hover(dom, first);
    const firstLookup = lastRequest(socket);
    socket.receive(lookupResult(firstLookup.requestId, "食べる", glossary, 5));
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(1);

    reader.hide("test-dismissal");
    await hover(dom, first);
    const secondLookup = lastRequest(socket);
    socket.receive(lookupResult(secondLookup.requestId, "食べる", glossary, 5));
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(2);

    reader.destroy();
    await flushPromises();
  });

  it("bounds unique media work for an image-heavy definition", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:unused"),
      revokeObjectURL: vi.fn(),
    }));

    await hover(dom, first);
    const lookup = lastRequest(socket);
    socket.receive(lookupResult(
      lookup.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: Array.from({ length: 132 }, (_, index) => ({
          tag: "img",
          path: `img/${index}.jpg`
        }))
      }),
      6
    ));

    let processed = 0;
    while (true) {
      const requests = requestsOfType(socket, "hoshidicts_media");
      if (processed >= requests.length) {
        expect(requests).toHaveLength(128);
        break;
      }
      const request = requests[processed];
      processed += 1;
      socket.receive({
        type: "hoshidicts_media_result",
        requestId: request.requestId,
        success: false,
        generation: request.generation,
        dictionary: request.dictionary,
        path: request.path,
        mediaType: null,
        byteLength: 0,
        dataBase64: null,
        featureDisabled: false,
        staleGeneration: false,
        error: "not_found"
      });
    }

    await flushPromises();
  });

  it("ignores stale responses so the latest hover request wins", async () => {
    const { api, dom, first, reader, second, socket } = createReaderHarness();
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });

    await hover(dom, first, { shiftKey: true });
    const firstRequest = lastRequest(socket);

    await hover(dom, second, { shiftKey: true, clientX: 31 });
    const secondRequest = lastRequest(socket);
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    expect(secondRequest.text).toBe("べる");

    socket.receive(lookupResult(firstRequest.requestId, "stale"));
    expect(reader.isVisible()).toBe(false);
    socket.receive(lookupResult(secondRequest.requestId, "食べる"));
    expect(
      reader
        .getPopupElement()
        .querySelector(".gsm-hoshidicts-entry")
        ?.getAttribute("data-expression")
    ).toBe("食べる");
  });

  it("starts one immediate lookup when local and global Shift edges overlap", () => {
    const { api, dom, first, reader, socket } = createReaderHarness();

    dispatchMouse(dom, first, "mousemove", { clientX: 11, clientY: 11 });
    expect(socket.sent).toHaveLength(1);

    dispatchKey(dom, dom.window.document, "keydown", { key: "Shift" });
    expect(reader.setActivationKeyPressed(true)).toBe(true);

    expect(lastRequest(socket)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    expect(socket.sent.map((message) => JSON.parse(message).type).filter(
      (type) => type === "hoshidicts_lookup"
    )).toHaveLength(1);
  });

  it("uses global pressed and released edges for a custom activation key", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      activationKey: "F8",
      popupHideDelayMs: 300,
    });

    await hover(dom, first);
    expect(socket.sent).toHaveLength(1);

    expect(reader.setActivationKeyPressed(true)).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    const request = lastRequest(socket);
    expect(request).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    await respond(socket, lookupResult(request.requestId, "食べる"));
    expect(reader.isVisible()).toBe(true);

    expect(reader.setActivationKeyPressed(false)).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(reader.isVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(reader.isVisible()).toBe(false);
  });

  it("dismisses naturally after the configured delay and pauses while hovered", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupHideDelayMs: 300,
    });

    await hover(dom, first);
    const request = lastRequest(socket);
    socket.receive(lookupResult(request.requestId, "食べる"));
    expect(reader.isVisible()).toBe(true);

    dispatchMouse(dom, dom.window.document.body, "mousemove", { clientX: 200, clientY: 200 });
    await vi.advanceTimersByTimeAsync(299);
    expect(reader.isVisible()).toBe(true);

    dispatchKey(dom, dom.window.document, "keydown", { key: "Escape" });
    dispatchMouse(dom, dom.window.document.body, "pointerdown");
    expect(reader.isVisible()).toBe(true);

    reader.getPopupElement().dispatchEvent(new dom.window.Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.isVisible()).toBe(true);

    reader.getPopupElement().dispatchEvent(new dom.window.Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(299);
    expect(reader.isVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(reader.isVisible()).toBe(false);
  });

  it("immediately replaces yomu with kiku and never restores the stale popup", async () => {
    vi.useFakeTimers();
    const dom = createDomFrom(`
        <p class="text-block-container">
          <span id="yomu" class="text-box" data-selectable="true">読む</span><span id="kiku" class="text-box" data-selectable="true">聞く</span>
        </p>`);
    const api = loadReaderModule(dom.window as unknown as Window);
    const yomu = dom.window.document.getElementById("yomu")!;
    const kiku = dom.window.document.getElementById("kiku")!;
    setRect(yomu, { left: 10, top: 10, right: 70, bottom: 30 });
    setRect(kiku, { left: 70, top: 10, right: 130, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 5000,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    await hover(dom, yomu);
    const yomuRequest = lastRequest(socket);
    socket.receive(lookupResult(yomuRequest.requestId, "読む", "to read"));
    expect(reader.getPopupElement().textContent).toContain("to read");
    reader.getPopupElement().scrollTop = 120;

    dispatchMouse(dom, kiku, "mousemove", { clientX: 71, clientY: 11 });
    expect(reader.isVisible()).toBe(false);
    expect(reader.getPopupElement().childElementCount).toBe(0);
    expect(yomu.classList.contains("gsm-hoshidicts-source-match")).toBe(false);

    socket.receive(lookupResult(yomuRequest.requestId, "読む", "stale"));
    expect(reader.isVisible()).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    const kikuRequest = lastRequest(socket);
    socket.receive(lookupResult(kikuRequest.requestId, "聞く", "to listen"));

    expect(reader.isVisible()).toBe(true);
    expect(reader.getPopupElement().textContent).toContain("to listen");
    expect(reader.getPopupElement().textContent).not.toContain("stale");
    expect(reader.getPopupElement().scrollTop).toBe(0);
    expect(kiku.classList.contains("gsm-hoshidicts-source-match")).toBe(true);
  });

  it("keeps source highlighting off by default and spans every matched source element", async () => {
    vi.useFakeTimers();
    const dom = createDomFrom(`
        <p class="text-block-container" data-block-id="0">
          <span id="first" class="text-box" data-selectable="true">前<strong>食</strong></span>
          <span id="second" class="text-box" data-selectable="true">べ</span>
          <span id="third" class="text-box" data-selectable="true">る後</span>
        </p>`);
    const highlights = {
      delete: vi.fn(),
      set: vi.fn()
    };
    class TestHighlight {
      readonly ranges: Range[];

      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    Object.defineProperty(dom.window, "CSS", {
      configurable: true,
      value: { highlights }
    });
    Object.defineProperty(dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight
    });
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    await hover(dom, first, { clientX: 21 });
    const request = lastRequest(socket);
    await respond(socket, lookupResult(request.requestId, "食べる"));

    expect(reader.getPreferences().sourceHighlightEnabled).toBe(false);
    expect(highlights.set).not.toHaveBeenCalled();
    expect(
      dom.window.document.querySelectorAll(".gsm-hoshidicts-source-match")
    ).toHaveLength(0);

    reader.updatePreferences({ sourceHighlightEnabled: true });
    expect(highlights.set).toHaveBeenCalledTimes(1);
    const highlight = highlights.set.mock.calls[0][1] as TestHighlight;
    expect(highlight.ranges.map((range) => range.toString())).toEqual([
      "食",
      "べ",
      "る"
    ]);

    const deletesBeforeDisable = highlights.delete.mock.calls.length;
    reader.updatePreferences({ sourceHighlightEnabled: false });
    expect(highlights.delete).toHaveBeenCalledTimes(deletesBeforeDisable + 1);
    expect(
      dom.window.document.querySelectorAll(".gsm-hoshidicts-source-match")
    ).toHaveLength(0);

    first.firstChild!.nodeValue = "別";
    reader.updatePreferences({ sourceHighlightEnabled: true });
    expect(highlights.set).toHaveBeenCalledTimes(1);

    reader.updatePreferences({ sourceHighlightEnabled: false });
    first.firstChild!.nodeValue = "前";
    first.remove();
    reader.updatePreferences({ sourceHighlightEnabled: true });
    expect(highlights.set).toHaveBeenCalledTimes(1);
    expect(
      dom.window.document.querySelectorAll(".gsm-hoshidicts-source-match")
    ).toHaveLength(0);
  });

  it("exposes one complete set of default reader preferences", () => {
    const { reader } = createReaderHarness({ fakeTimers: false, openSocket: false });

    expect(reader.getPreferences()).toEqual(readerPreferences());
  });

  it("applies live reader preferences to the DOM", () => {
    const { dom, reader } = createReaderHarness({
      fakeTimers: false,
      openSocket: false,
    });
    // Every out-of-range field below is clamped instead of rejected.
    const applied = readerPreferences({
      lookupMode: "hover",
      scanLength: 24,
      maxResults: 48,
      sortFrequencyDictionary: "Frequency",
      sortFrequencyDictionaryOrder: "ascending",
      activationKey: "F24",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 1_000_000,
        revealMode: "hover",
        revealDelayMs: 1000
      },
      sourceHighlightEnabled: true,
      popupHideDelayMs: 5000,
      showPitchAccentBadge: true,
      popupNestingMaxDepth: 2,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupColumns: 3,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "cyberpunk"
    });

    expect(reader.updatePreferences({
      lookupMode: "hover",
      scanLength: 24,
      maxResults: 48,
      sortFrequencyDictionary: "Frequency",
      sortFrequencyDictionaryOrder: "ascending",
      activationKey: "F24",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 5000,
      popupNestingMaxDepth: 2,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupColumns: 3,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "cyberpunk",
      showPitchAccentBadge: true,
      definitionBlur: {
        enabled: true,
        lookupThreshold: 1_000_000,
        revealMode: "hover",
        revealDelayMs: 1000
      }
    })).toEqual(applied);
    expect(dom.window.document.documentElement.dataset.hoshidictsTheme).toBe(
      "cyberpunk"
    );
    expect(
      dom.window.document.documentElement.style.getPropertyValue(
        "--gsm-hoshidicts-popup-columns"
      )
    ).toBe("3");
  });

  it("retries the active lookup with live scan, result, and frequency sort preferences", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      scanLength: 3,
      maxResults: 4
    });
    harness.first.textContent = "食べる日本";
    harness.dom.window.document.getElementById("second")!.textContent = "";

    await hover(harness.dom, harness.first);
    const firstRequest = lastRequest(harness.socket);
    expect(firstRequest).toMatchObject({
      text: "食べる",
      scanLength: 3,
      maxResults: 4,
      sortFrequencyDictionary: null,
      sortFrequencyDictionaryOrder: "descending"
    });

    harness.reader.updatePreferences({
      scanLength: 5,
      maxResults: 7,
      sortFrequencyDictionary: "Frequency",
      sortFrequencyDictionaryOrder: "ascending"
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(lastRequest(harness.socket)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる日本",
      scanLength: 5,
      maxResults: 7,
      sortFrequencyDictionary: "Frequency",
      sortFrequencyDictionaryOrder: "ascending"
    });
    expect(lastRequest(harness.socket).requestId)
      .not.toBe(firstRequest.requestId);
  });

  it("applies every supported theme inside the reader runtime", () => {
    const { api, dom, reader } = createReaderHarness({
      fakeTimers: false,
      openSocket: false,
    });

    for (const theme of HOSHIDICTS_THEMES) {
      expect(reader.updatePreferences({ theme }).theme).toBe(theme);
      expect(dom.window.document.documentElement.dataset.hoshidictsTheme).toBe(
        theme
      );
    }
  });

  it("opens one child from definition text, preserves its parent, and prunes live", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      sourceHighlightEnabled: true,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事を口に入れる"));

    const rootPopup = reader.getPopupElement();
    const definition = rootPopup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const definitionText = definition.firstChild!;
    const caret = dom.window.document.createRange();
    caret.setStart(definitionText, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });

    await hover(dom, definition, { clientX: 40, clientY: 40 });
    const childRequest = lastRequest(socket);
    expect(childRequest).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食事を口に入れる"
    });
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));

    expect(reader.getPopupElements()).toHaveLength(2);
    expect(reader.getPopupElements()[0]).toBe(rootPopup);
    expect(rootPopup.textContent).toContain("食事を口に入れる");
    expect(reader.getPopupElements()[1].textContent).toContain("meal");
    for (const popup of reader.getPopupElements()) {
      expect(popup.style.width).toBe("560px");
      expect(popup.style.height).toBe("420px");
    }
    reader.updatePreferences({
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      theme: "autumn"
    });
    for (const popup of reader.getPopupElements()) {
      expect(popup.style.width).toBe("720px");
      expect(popup.style.height).toBe("520px");
    }
    expect(
      dom.window.document.documentElement.style.getPropertyValue(
        "--gsm-hoshidicts-popup-opacity"
      )
    ).toBe("70%");
    expect(
      dom.window.document.documentElement.style.getPropertyValue(
        "--gsm-hoshidicts-popup-columns"
      )
    ).toBe("1");
    expect(dom.window.document.documentElement.dataset.hoshidictsTheme).toBe(
      "autumn"
    );
    expect(first.classList.contains("gsm-hoshidicts-source-match")).toBe(true);
    expect(definition.classList.contains("gsm-hoshidicts-source-match")).toBe(true);

    dispatchMouse(dom, rootPopup, "mousemove", { clientX: 200, clientY: 200 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.getPopupElements()).toHaveLength(2);

    dispatchMouse(dom, dom.window.document.body, "mousemove", { clientX: 200, clientY: 200 });
    await vi.advanceTimersByTimeAsync(299);
    reader.getPopupElements()[1].dispatchEvent(new dom.window.Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.getPopupElements()).toHaveLength(2);
    reader.getPopupElements()[1].dispatchEvent(new dom.window.Event("pointerleave"));
    dispatchMouse(dom, definition, "mousemove", { clientX: 40, clientY: 40 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.getPopupElements()).toHaveLength(2);

    reader.updatePreferences({ popupNestingMaxDepth: 0 });
    expect(reader.getPopupElements()).toHaveLength(1);
    expect(reader.isVisible()).toBe(true);
    expect(rootPopup.textContent).toContain("食事を口に入れる");
    expect(first.classList.contains("gsm-hoshidicts-source-match")).toBe(true);
    expect(definition.classList.contains("gsm-hoshidicts-source-match")).toBe(false);
  });

  it("isolates nested tab IDs and resets descendant media on a parent tab switch", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      dictionaryPresentation: [
        { title: "Visual", favorite: true },
        { title: "Text", favorite: true },
        { title: "Child A", favorite: true },
        { title: "Child B", favorite: true }
      ],
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:root-image"),
      revokeObjectURL: vi.fn(),
    }));

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResultWithDictionaries(rootRequest.requestId, [
      {
        dictionary: "Visual",
        glossary: JSON.stringify({
          type: "structured-content",
          content: [
            { tag: "span", content: "食事" },
            { tag: "img", path: "img/root.jpg" }
          ]
        })
      },
      { dictionary: "Text", glossary: "plain definition" }
    ]));

    const rootPopup = reader.getPopupElement();
    const definition = rootPopup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.querySelector("span")!.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    await hover(dom, definition, { clientX: 40, clientY: 40 });
    const childRequest = lastRequest(socket);
    socket.receive(lookupResultWithDictionaries(childRequest.requestId, [
      { dictionary: "Child A", glossary: "meal" },
      { dictionary: "Child B", glossary: "food" }
    ], "食事"));

    const popups = reader.getPopupElements();
    expect(popups).toHaveLength(2);
    expect(popups[0].querySelector('[role="tabpanel"]')?.id)
      .toBe("gsm-hoshidicts-tab-panel");
    expect(popups[1].querySelector('[role="tabpanel"]')?.id)
      .toBe("gsm-hoshidicts-1-tab-panel");
    const tabIds = Array.from(
      dom.window.document.querySelectorAll<HTMLElement>(
        '.gsm-hoshidicts-popup [role="tab"], '
          + '.gsm-hoshidicts-popup [role="tabpanel"]'
      ),
      (element) => element.id
    );
    expect(new Set(tabIds).size).toBe(tabIds.length);
    for (const popup of popups) {
      const panel = popup.querySelector<HTMLElement>('[role="tabpanel"]')!;
      for (const tab of popup.querySelectorAll<HTMLElement>('[role="tab"]')) {
        expect(tab.getAttribute("aria-controls")).toBe(panel.id);
      }
      expect(panel.getAttribute("aria-labelledby")).toBe(
        popup.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.id
      );
    }

    const mediaRequests = () => socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
    expect(mediaRequests()).toHaveLength(1);
    rootPopup.querySelector<HTMLButtonElement>('[role="tab"]')?.click();
    expect(reader.getPopupElements()).toEqual(popups);
    expect(mediaRequests()).toHaveLength(1);
    Array.from(rootPopup.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "Text")
      ?.click();
    expect(reader.getPopupElements()).toEqual([rootPopup]);
    expect(rootPopup.textContent).toContain("plain definition");
    expect(mediaRequests()).toHaveLength(1);

    rootPopup.querySelector<HTMLButtonElement>('[role="tab"]')?.click();
    expect(mediaRequests()).toHaveLength(2);
    expect(mediaRequests()[1].requestId).not.toBe(mediaRequests()[0].requestId);
  });

  it("keeps unresolved parent media alive while rendering a child popup", async () => {
    const createObjectURL = vi.fn(() => "blob:parent-image");
    const revokeObjectURL = vi.fn();
    const { api, dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL,
    }));

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(
      rootRequest.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: [
          { tag: "span", content: "食事" },
          { tag: "img", path: "img/parent.jpg" }
        ]
      }),
      7
    ));
    const parentMediaRequest = firstRequestOfType(socket, "hoshidicts_media");
    const definition = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const parentImage = definition.querySelector<HTMLImageElement>("img")!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.querySelector("span")!.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });

    await hover(dom, definition, { clientX: 40, clientY: 40 });
    const childRequest = lastRequest(socket);
    await respond(socket, lookupResult(
      childRequest.requestId,
      "食事",
      JSON.stringify({
        type: "structured-content",
        content: [
          { tag: "span", content: "meal" },
          { tag: "img", path: "img/parent.jpg" }
        ]
      }),
      7
    ));
    expect(parentImage.hidden).toBe(false);

    const childMediaRequest = requestsOfType(socket, "hoshidicts_media")
      .at(-1)!;
    expect(childMediaRequest.requestId).not.toBe(parentMediaRequest.requestId);

    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: parentMediaRequest.requestId,
      success: true,
      generation: 7,
      dictionary: "JMdict",
      path: "img/parent.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });
    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: childMediaRequest.requestId,
      success: true,
      generation: 7,
      dictionary: "JMdict",
      path: "img/parent.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });

    expect(parentImage.src).toBe("blob:parent-image");
    expect(
      reader.getPopupElements()[1].querySelector<HTMLImageElement>("img")?.src
    ).toBe("blob:parent-image");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("retains aggregate parent audio ownership while opening and pruning a child", async () => {
    const audioController = createAudioControllerStub();
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupHideDelayMs: 0,
      popupNestingMaxDepth: 1,
      audioController,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const rootPopup = reader.getPopupElement();
    const parentAudioButton = rootPopup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-audio-button"
    )!;
    const beginLookupCount = audioController.beginLookup.mock.calls.length;
    const definition = rootPopup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });

    await hover(dom, definition, { clientX: 40, clientY: 40 });
    expect(audioController.beginLookup).toHaveBeenCalledTimes(beginLookupCount);
    const childRequest = lastRequest(socket);
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));

    const childSync = audioController.setRenderedResults.mock.calls.at(-1)!;
    expect(childSync[0]).toHaveLength(2);
    expect(childSync[0][0].button.closest(".gsm-hoshidicts-popup")?.dataset
      .hoshidictsDepth).toBe("1");
    expect(childSync[1]).toEqual({ autoPlay: true });

    reader.updatePreferences({ popupNestingMaxDepth: 0 });
    const parentSync = audioController.setRenderedResults.mock.calls.at(-1)!;
    expect(reader.getPopupElements()).toEqual([rootPopup]);
    expect(parentSync[0]).toHaveLength(1);
    expect(parentSync[0][0].button).toBe(parentAudioButton);
    expect(parentSync[1]).toEqual({ autoPlay: false });
  });

  it("uses the hovered definition as child mining sentence context", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      getMiningStatus: async () => ({ available: true }),
      onMine: mine,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "説明：食事を選ぶ"));

    const definition = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 3);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    await hover(dom, definition, { clientX: 40, clientY: 40 });
    const childRequest = lastRequest(socket);
    await respond(socket, lookupResult(childRequest.requestId, "食事", "meal"));

    const childButton = reader.getPopupElements()[1]
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    expect(childButton.dataset.state).toBe("ready");
    childButton.click();
    await flushPromises();

    expect(mine).toHaveBeenCalledWith(expect.objectContaining({
      sentence: "説明：食事を選ぶ",
      matchOffset: 3,
      result: expect.objectContaining({
        term: expect.objectContaining({ expression: "食事" })
      })
    }));
  });

  it("allows exactly the configured number of child popup levels", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 2,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "第一"));

    for (const [expression, glossary] of [["第一", "第二"], ["第二", "第三"]]) {
      const definition = reader.getPopupElements().at(-1)!
        .querySelector<HTMLElement>(".gsm-hoshidicts-glossary-content")!;
      const caret = dom.window.document.createRange();
      caret.setStart(definition.firstChild!, 0);
      caret.collapse(true);
      Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
        configurable: true,
        value: vi.fn(() => caret.cloneRange())
      });
      await hover(dom, definition, { clientX: 40, clientY: 40 });
      const request = lastRequest(socket);
      expect(request.text).toBe(glossary === "第二" ? "第一" : "第二");
      socket.receive(lookupResult(request.requestId, expression, glossary));
    }

    expect(reader.getPopupElements()).toHaveLength(3);
    const sentCount = socket.sent.length;
    const deepestDefinition = reader.getPopupElements().at(-1)!
      .querySelector<HTMLElement>(".gsm-hoshidicts-glossary-content")!;
    const deepestCaret = dom.window.document.createRange();
    deepestCaret.setStart(deepestDefinition.firstChild!, 0);
    deepestCaret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => deepestCaret.cloneRange())
    });
    await hover(dom, deepestDefinition, { clientX: 40, clientY: 40 });

    expect(socket.sent).toHaveLength(sentCount);
    expect(reader.getPopupElements()).toHaveLength(3);
  });

  it("repositions child popups when a parent expands more results", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    const rootResult = lookupResult(rootRequest.requestId, "食べる", "食事");
    const firstResult = rootResult.results[0];
    rootResult.results = Array.from({ length: 7 }, (_, index) => ({
      ...firstResult,
      matched: `食${index}`,
      deinflected: `食${index}`,
      term: {
        ...firstResult.term,
        expression: `食${index}`,
        glossaries: firstResult.term.glossaries.map((glossary) => ({
          ...glossary
        }))
      }
    }));
    socket.receive(rootResult);

    const rootPopup = reader.getPopupElement();
    const definition = rootPopup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const definitionRect = vi.spyOn(definition, "getBoundingClientRect")
      .mockReturnValue({
        x: 40,
        y: 40,
        left: 40,
        top: 40,
        right: 100,
        bottom: 60,
        width: 60,
        height: 20,
        toJSON: () => ({})
      } as DOMRect);
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    await hover(dom, definition, { clientX: 40, clientY: 40 });
    const childRequest = lastRequest(socket);
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));

    const childPopup = reader.getPopupElements()[1];
    const originalTop = childPopup.style.top;
    definitionRect.mockReturnValue({
      x: 40,
      y: 140,
      left: 40,
      top: 140,
      right: 100,
      bottom: 160,
      width: 60,
      height: 20,
      toJSON: () => ({})
    } as DOMRect);
    rootPopup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")!
      .click();

    expect(childPopup.style.top).not.toBe(originalTop);
    expect(childPopup.style.top).toBe("140px");
  });

  it("keeps a nested child popup's toolbar at the top regardless of where it opens", async () => {
    const { dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      popupToolbarPosition: "auto",
    });

    // The root popup opens above the word (anchored near the viewport bottom),
    // so its toolbar correctly flips to the bottom.
    setRect(first, { left: 10, top: 700, right: 30, bottom: 720 });
    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const rootPopup = reader.getPopupElement();
    expect(rootPopup.dataset.toolbarPosition).toBe("bottom");

    // Opening a child popup from a definition anchors it BESIDE its parent, not
    // above/below the word, so the opposite-side flip never applies to nested
    // popups: the child keeps its configured (default top) toolbar.
    const definition = rootPopup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    vi.spyOn(definition, "getBoundingClientRect").mockReturnValue({
      x: 40,
      y: 700,
      left: 40,
      top: 700,
      right: 100,
      bottom: 720,
      width: 60,
      height: 20,
      toJSON: () => ({})
    } as DOMRect);
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    await hover(dom, definition, { clientX: 40, clientY: 700 });
    const childRequest = lastRequest(socket);
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));

    const childPopup = reader.getPopupElements()[1];
    expect(childPopup).toBeTruthy();
    expect(childPopup.dataset.toolbarPosition).toBe("top");
    expect(childPopup.firstElementChild?.classList.contains(
      "gsm-hoshidicts-result-chrome"
    )).toBe(true);
  });

  it("ignores a stale child response without replacing its parent", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const rootPopup = reader.getPopupElement();
    const definition = rootPopup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    await hover(dom, definition, { clientX: 40, clientY: 40 });
    const childRequest = lastRequest(socket);

    rootPopup.querySelector<HTMLElement>(".gsm-hoshidicts-entry-header")!
      .dispatchEvent(new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 40,
        clientY: 40
      }));
    socket.receive(lookupResult(childRequest.requestId, "食事", "stale child"));

    expect(reader.getPopupElements()).toEqual([rootPopup]);
    expect(rootPopup.textContent).toContain("食事");
    expect(rootPopup.textContent).not.toContain("stale child");
  });

  it("treats identical definition blocks as distinct child lookup sources", async () => {
    const { api, dom, first, reader, second, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      sourceHighlightEnabled: true,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    const rootResult = lookupResult(rootRequest.requestId, "食べる", "食事");
    rootResult.results[0].term.glossaries.push({
      ...rootResult.results[0].term.glossaries[0]
    });
    socket.receive(rootResult);
    const definitions = Array.from(
      reader.getPopupElement().querySelectorAll<HTMLElement>(
        ".gsm-hoshidicts-glossary-content"
      )
    );

    const hoverDefinition = async (definition: HTMLElement) => {
      const caret = dom.window.document.createRange();
      caret.setStart(definition.firstChild!, 0);
      caret.collapse(true);
      Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
        configurable: true,
        value: vi.fn(() => caret.cloneRange())
      });
      await hover(dom, definition, { clientX: 40, clientY: 40 });
    };

    await hoverDefinition(definitions[0]);
    const firstChildRequest = lastRequest(socket);
    socket.receive(lookupResult(firstChildRequest.requestId, "食事", "first child"));
    expect(definitions[0].classList.contains("gsm-hoshidicts-source-match"))
      .toBe(true);

    await hoverDefinition(definitions[1]);
    const secondChildRequest = lastRequest(socket);
    expect(secondChildRequest.requestId).not.toBe(firstChildRequest.requestId);
    socket.receive(lookupResult(secondChildRequest.requestId, "食事", "second child"));

    expect(definitions[0].classList.contains("gsm-hoshidicts-source-match"))
      .toBe(false);
    expect(definitions[1].classList.contains("gsm-hoshidicts-source-match"))
      .toBe(true);
    expect(reader.getPopupElements()[1].textContent).toContain("second child");
  });

  it("retries a timed-out child lookup at the same definition", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      lookupTimeoutMs: 50,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const rootPopup = reader.getPopupElement();
    const definition = rootPopup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    const hoverDefinition = () => dispatchMouse(dom, definition, "mousemove", { clientX: 40, clientY: 40 });

    hoverDefinition();
    await vi.advanceTimersByTimeAsync(20);
    const timedOutRequest = lastRequest(socket);
    await vi.advanceTimersByTimeAsync(50);
    expect(reader.getPopupElements()).toHaveLength(2);
    expect(reader.getPopupElements()[1].textContent).toContain("timed out");

    hoverDefinition();
    await vi.advanceTimersByTimeAsync(20);
    expect(lastRequest(socket).requestId).toBe(
      timedOutRequest.requestId
    );
    rootPopup.querySelector<HTMLElement>(".gsm-hoshidicts-entry-header")!
      .dispatchEvent(new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 40,
        clientY: 40
      }));
    hoverDefinition();
    await vi.advanceTimersByTimeAsync(20);
    const retryRequest = lastRequest(socket);
    expect(retryRequest.requestId).not.toBe(timedOutRequest.requestId);
    expect(reader.getPopupElements()[0]).toBe(rootPopup);
  });

  it("clears removed child pointer ownership after a live depth reduction", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupHideDelayMs: 0,
      popupNestingMaxDepth: 1,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const definition = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    await hover(dom, definition, { clientX: 40, clientY: 40 });
    const childRequest = lastRequest(socket);
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));
    const childPopup = reader.getPopupElements()[1];
    childPopup.dispatchEvent(new dom.window.Event("pointerenter"));

    reader.updatePreferences({ popupNestingMaxDepth: 0 });
    expect(reader.getPopupElements()).toHaveLength(1);
    reader.updatePreferences({ lookupMode: "shift" });
    expect(reader.isVisible()).toBe(false);
  });

  it("does not scan definition text when child popups are disabled", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      popupNestingMaxDepth: 0,
    });

    await hover(dom, first);
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const sentCount = socket.sent.length;
    const definition = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    await hover(dom, definition, { clientX: 40, clientY: 40 });

    expect(socket.sent).toHaveLength(sentCount);
    expect(reader.getPopupElements()).toHaveLength(1);
  });

  it("requires Shift for definition lookups when the reader uses Shift-hover", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      popupNestingMaxDepth: 1,
    });

    await hover(dom, first, { shiftKey: true });
    const rootRequest = lastRequest(socket);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const definition = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    const sentCount = socket.sent.length;
    await hover(dom, definition, { clientX: 40, clientY: 40 });
    expect(socket.sent).toHaveLength(sentCount);

    dispatchKey(dom, dom.window.document, "keydown", { key: "Shift" });
    await vi.advanceTimersByTimeAsync(20);
    expect(lastRequest(socket)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食事"
    });
  });

  it("moves primary frequency into the toolbar and hides grammar tags by default", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      showPitchAccentBadge: true,
      dictionaryPresentation: [
        { title: "Frequency", favorite: false, displayName: "Corpus rank" },
        { title: "Pitch", favorite: false, displayName: "Pitch accent" }
      ],
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    const response = lookupResult(request.requestId, "食べる");
    response.results = Array.from({ length: 8 }, (_, index) => ({
      ...response.results[0],
      term: {
        ...response.results[0].term,
        expression: `語${index}`,
        reading: `ご${index}`
      }
    }));
    response.results[0].term.frequencies = [
      {
        ...response.results[0].term.frequencies[0],
        frequencies: [
          { value: 1.25, displayValue: null },
          { value: 1.25, displayValue: null },
          { value: 1.25, displayValue: "" },
          { value: 1.25, displayValue: "1.25 ★" }
        ]
      }
    ];
    socket.receive(response);

    const popup = reader.getPopupElement();
    const entries = Array.from(popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry"));
    expect(entries).toHaveLength(1);
    expect(entries.filter((entry) => entry.hidden)).toHaveLength(0);
    expect(entries.every((entry) => entry.querySelector("details")?.open)).toBe(true);
    const metadataRows = entries[0].querySelectorAll<HTMLElement>(
      ".gsm-hoshidicts-metadata"
    );
    expect(reader.getPreferences().hidePopupGrammarTags).toBe(true);
    expect(metadataRows).toHaveLength(1);
    expect(metadataRows[0].querySelector(".gsm-hoshidicts-tag-pitch"))
      .not.toBeNull();
    expect(
      metadataRows[0].querySelector(".gsm-hoshidicts-pitch-source")?.textContent
    ).toBe("Pitch accent");
    const capsule = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-primary-metadata-capsule"
    )!;
    expect(capsule.hidden).toBe(false);
    expect(
      capsule.querySelector(".gsm-hoshidicts-frequency-source")?.textContent
    ).toBe("Corpus rank");
    expect(
      metadataRows[0].querySelector(".gsm-hoshidicts-pitch-body")?.textContent
    ).toBe("ご0 [2] LHL");
    expect(entries[0].querySelector(".gsm-hoshidicts-frequency-metadata"))
      .toBeNull();
    expect(entries[0].querySelector(".gsm-hoshidicts-tags")).toBeNull();
    expect(capsule.querySelector(".gsm-hoshidicts-primary-grammar")).toBeNull();
    expect(
      Array.from(
        capsule.querySelectorAll<HTMLElement>(".gsm-hoshidicts-tag-frequency")
      ).map((tag) =>
        tag.querySelector(".gsm-hoshidicts-frequency-body")?.textContent
      )
    ).toEqual(["1.25 · 1.25 ★"]);
    expect(popup.textContent).toContain("ご0 [2] LHL");

    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")!.click();
    const expandedEntries = Array.from(
      popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    );
    expect(expandedEntries).toHaveLength(8);
    expect(expandedEntries.some((entry) => entry.hidden)).toBe(false);
    expect(expandedEntries[1].querySelector(
      ".gsm-hoshidicts-frequency-metadata"
    )).not.toBeNull();
    expect(expandedEntries[1].querySelector(".gsm-hoshidicts-tags")).toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-show-more")).toBeNull();
  });

  it("shows ordered frequency ranks without repeating the headword", async () => {
    const harness = createReaderHarness();
    await renderFirstLookup(harness, {
      expression: "骨",
      transform(response) {
        response.results[0].term.reading = "ほね";
        response.results[0].term.frequencies = [
          {
            dictionary: "JPDB Frequency",
            frequencies: [
              { value: 1328, displayValue: null },
              { value: 2622, displayValue: "2622" },
              { value: 2020, displayValue: "2020" },
              { value: 9999, displayValue: "" }
            ]
          },
          {
            dictionary: "Styled Frequency",
            frequencies: [
              { value: 1234, displayValue: "1,234 ★" }
            ]
          }
        ];
      }
    });

    const tags = Array.from(
      harness.reader.getPopupElement()
        .querySelectorAll<HTMLElement>(".gsm-hoshidicts-tag-frequency")
    );
    expect(tags).toHaveLength(2);
    expect(
      tags[0].querySelector(".gsm-hoshidicts-frequency-source")?.textContent
    ).toBe("JPDB Frequency");
    expect(tags[0].querySelector(".gsm-hoshidicts-frequency-term")).toBeNull();
    expect(tags[0].querySelector(".gsm-hoshidicts-frequency-reading")).toBeNull();
    expect(
      Array.from(
        tags[0].querySelectorAll<HTMLElement>(
          ".gsm-hoshidicts-frequency-value"
        ),
        (value) => value.textContent
      )
    ).toEqual(["1.3k", "2.6k", "2k"]);
    expect(
      tags[0].querySelector(".gsm-hoshidicts-frequency-body")?.textContent
    ).toBe("1.3k · 2.6k · 2k");
    expect(tags[0].textContent).not.toContain("骨");
    expect(tags[0].textContent).not.toContain("ほね");
    expect(tags[0].title).toBe("JPDB Frequency");
    expect(tags[0].getAttribute("aria-label")).toBe(
      "JPDB Frequency: 1.3k, 2.6k, 2k"
    );
    expect(
      tags[0].querySelector<HTMLElement>(".gsm-hoshidicts-frequency-value")
        ?.title
    ).toBe("1328");
    expect(
      tags[1].querySelector(".gsm-hoshidicts-frequency-source")?.textContent
    ).toBe("Styled Frequency");
    expect(
      tags[1].querySelector(".gsm-hoshidicts-frequency-body")?.textContent
    ).toBe("1,234 ★");
    expect(
      tags[1].querySelector<HTMLElement>(".gsm-hoshidicts-frequency-value")
        ?.dataset.frequency
    ).toBe("1234");
  });

  it("collapses frequency dictionaries into one harmonic rank", async () => {
    const harness = createReaderHarness({ averageFrequency: true });
    await renderFirstLookup(harness, {
      expression: "骨",
      transform(response) {
        response.results[0].term.frequencies = [
          {
            dictionary: "Corpus A",
            frequencies: [
              { value: 12000, displayValue: "12000" },
              { value: 99999, displayValue: "99999" }
            ]
          },
          {
            dictionary: "Corpus B",
            frequencies: [{ value: 36000, displayValue: null }]
          }
        ];
      }
    });

    const popup = harness.reader.getPopupElement();
    const frequencyTags = () =>
      Array.from(
        popup.querySelectorAll<HTMLElement>(
          ".gsm-hoshidicts-tag-frequency"
        )
      );

    expect(harness.reader.getPreferences().averageFrequency).toBe(true);
    expect(frequencyTags()).toHaveLength(1);
    expect(
      frequencyTags()[0].querySelector(
        ".gsm-hoshidicts-frequency-source"
      )?.textContent
    ).toBe("Frequency:");
    expect(
      frequencyTags()[0].querySelector(
        ".gsm-hoshidicts-frequency-body"
      )?.textContent
    ).toBe("18k");
    expect(frequencyTags()[0].getAttribute("aria-label")).toBe(
      "Frequency: 18k"
    );

    harness.reader.updatePreferences({ averageFrequency: false });
    expect(frequencyTags()).toHaveLength(2);

    harness.reader.updatePreferences({ averageFrequency: true });
    expect(frequencyTags()).toHaveLength(1);
    expect(
      frequencyTags()[0].querySelector(
        ".gsm-hoshidicts-frequency-body"
      )?.textContent
    ).toBe("18k");

    harness.reader.updatePreferences({ showFrequencyDictionaryNames: false });
    expect(
      frequencyTags()[0].querySelector(
        ".gsm-hoshidicts-frequency-source"
      )
    ).toBeNull();
    expect(frequencyTags()[0].textContent).toBe("18k");
  });

  it("can show frequency values without dictionary names", async () => {
    const harness = createReaderHarness({
      showFrequencyDictionaryNames: false
    });
    await renderFirstLookup(harness, {
      expression: "骨",
      transform(response) {
        response.results[0].term.frequencies = [{
          dictionary: "JPDB Frequency",
          frequencies: [{ value: 18000, displayValue: null }]
        }];
      }
    });

    const popup = harness.reader.getPopupElement();
    const frequencyTag = () => popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-tag-frequency"
    );

    expect(
      harness.reader.getPreferences().showFrequencyDictionaryNames
    ).toBe(false);
    expect(
      frequencyTag()?.querySelector(".gsm-hoshidicts-frequency-source")
    ).toBeNull();
    expect(frequencyTag()?.textContent).toBe("18k");
    expect(frequencyTag()?.getAttribute("aria-label")).toBe("18k");

    harness.reader.updatePreferences({ showFrequencyDictionaryNames: true });
    expect(
      frequencyTag()?.querySelector(".gsm-hoshidicts-frequency-source")
        ?.textContent
    ).toBe("JPDB Frequency");

    harness.reader.updatePreferences({ showFrequencyDictionaryNames: false });
    expect(frequencyTag()?.textContent).toBe("18k");
  });

  it("shows Jiten kana frequency before kanji frequency with compact ranks", async () => {
    const harness = createReaderHarness();
    await renderFirstLookup(harness, {
      expression: "食べる",
      transform(response) {
        response.results[0].term.reading = "たべる";
        response.results[0].term.frequencies = [{
          dictionary: "Jiten",
          frequencies: [
            { value: 194, displayValue: "194" },
            { value: 13989, displayValue: "13989㋕" }
          ]
        }];
      }
    });

    const tag = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-tag-frequency"
    )!;
    expect(
      Array.from(
        tag.querySelectorAll<HTMLElement>(".gsm-hoshidicts-frequency-value"),
        (value) => ({
          frequency: value.dataset.frequency,
          text: value.textContent
        })
      )
    ).toEqual([
      { frequency: "13989", text: "14k㋕" },
      { frequency: "194", text: "194" }
    ]);
    expect(tag.querySelector(".gsm-hoshidicts-frequency-body")?.textContent)
      .toBe("14k㋕ · 194");
    expect(tag.getAttribute("aria-label")).toBe("Jiten: 14k㋕, 194");
  });

  it("opens every dictionary card in the All tab like the Hoshi reference", async () => {
    const harness = createReaderHarness();
    await renderFirstLookup(harness, {
      transform(response) {
        const baseGlossary = response.results[0].term.glossaries[0];
        response.results[0].term.glossaries = [
          { ...baseGlossary, dictionary: "Jitendex", glossary: "to eat" },
          { ...baseGlossary, dictionary: "JMdict", glossary: "to consume" },
          { ...baseGlossary, dictionary: "Meikyou", glossary: "eat a meal" }
        ];
      }
    });

    const cards = Array.from(
      harness.reader.getPopupElement()
        .querySelectorAll<HTMLDetailsElement>(".gsm-hoshidicts-glossary-card")
    );
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.open)).toBe(true);
  });

  it("keeps only finite numeric frequency values without truncating them", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const response = lookupResult("request", "食べる");
    response.results[0].term.frequencies[0].frequencies = [
      { value: 12.75, displayValue: null },
      { value: true, displayValue: "boolean" },
      { value: Number.NaN, displayValue: "nan" },
      { value: Number.POSITIVE_INFINITY, displayValue: "infinity" }
    ];

    const normalized = api.normalizeLookupResults(response);

    expect(normalized[0].term.frequencies[0].frequencies).toEqual([
      { value: 12.75, displayValue: null }
    ]);
  });

  it("caps normalized results and stably prioritizes a requested reading", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const response = lookupResult("request", "猫");
    const base = response.results[0];
    response.results = [
      { ...base, term: { ...base.term, expression: "one", reading: "other" } },
      { ...base, term: { ...base.term, expression: "two", reading: "ねこ" } },
      { ...base, term: { ...base.term, expression: "three", reading: "other" } }
    ];

    const normalized = api.normalizeLookupResults(response, 3);
    const prioritized = api.prioritizeLookupResultsByReading(normalized, "ねこ");

    expect(prioritized.map((result) => result.term.expression)).toEqual([
      "two",
      "one",
      "three"
    ]);
    expect(api.normalizeLookupResults(response, 2)).toHaveLength(2);
  });

  it("shows an actionable timeout and ignores the late response", async () => {
    const onLookup = vi.fn();
    const { api, dom, first, reader, socket } = createReaderHarness({
      lookupMode: "hover",
      lookupTimeoutMs: 50,
      onLookup,
    });
    await hover(dom, first);
    const request = lastRequest(socket);
    await vi.advanceTimersByTimeAsync(50);

    const popup = reader.getPopupElement();
    expect(popup.textContent).toContain("timed out");
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-result-chrome"))
      .toBe(true);
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-note-button")!.click();
    const term = popup.querySelector<HTMLInputElement>(
      ".gsm-hoshidicts-note-term"
    )!;
    expect(term.value).toBe("食べる");
    expect(term.selectionStart).toBe(0);
    expect(term.selectionEnd).toBe(term.value.length);
    socket.receive(lookupResult(request.requestId, "late"));
    expect(popup.textContent).toContain("timed out");
    expect(popup.textContent).not.toContain("late");
    expect(onLookup).not.toHaveBeenCalled();
  });

  it("bounds lookup time even while the socket is still connecting", async () => {
    const { api, dom, first, reader } = createReaderHarness({
      openSocket: false,
      lookupMode: "hover",
      lookupTimeoutMs: 50,
    });

    await hover(dom, first);
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);

    expect(reader.isVisible()).toBe(true);
    expect(reader.getPopupElement().textContent).toContain("timed out");
  });

  it("keeps the top Note action available after an empty lookup result", async () => {
    const states: boolean[] = [];
    const { api, dom, first, reader, second, socket } = createReaderHarness({
      onPopupStateChange: (visible: boolean) => states.push(visible),
    });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });

    await hover(dom, first, { shiftKey: true });
    const firstRequest = lastRequest(socket);
    socket.receive(lookupResult(firstRequest.requestId, "食べる"));
    expect(reader.isVisible()).toBe(true);

    await hover(dom, second, { shiftKey: true, clientX: 31 });
    const secondRequest = lastRequest(socket);
    socket.receive({
      type: "hoshidicts_lookup_result",
      requestId: secondRequest.requestId,
      generation: 1,
      success: true,
      error: null,
      results: []
    });

    const popup = reader.getPopupElement();
    expect(reader.isVisible()).toBe(true);
    expect(popup.hidden).toBe(false);
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-result-chrome"))
      .toBe(true);
    expect(popup.querySelector(".gsm-hoshidicts-note-button")).not.toBeNull();
    expect(popup.textContent).toContain("No definitions found");
    expect(states).toEqual([true, false, true]);
  });

  it("invalidates a pending lookup when the pointer leaves readable text", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness();

    await hover(dom, first, { shiftKey: true });
    const request = lastRequest(socket);
    dispatchMouse(dom, dom.window.document.body, "mousemove", {
      shiftKey: true,
      clientX: 100,
      clientY: 100
    });
    socket.receive(lookupResult(request.requestId, "stale"));

    expect(reader.isVisible()).toBe(false);
    expect(reader.getPopupElement().childElementCount).toBe(0);
  });

  it("text cleanup invalidates an in-flight response", async () => {
    const { api, dom, first, reader, socket } = createReaderHarness();

    await hover(dom, first, { shiftKey: true });
    const request = lastRequest(socket);
    reader.hide("text-cleared");
    socket.receive(lookupResult(request.requestId, "stale"));

    expect(reader.isVisible()).toBe(false);
    expect(reader.getPopupElement().childElementCount).toBe(0);
  });

  it("quietly hides mining controls when Anki mining is unavailable", async () => {
    const getMiningStatus = vi.fn(async () => ({
      available: false,
      error: "Open Hoshidicts Settings to choose a deck."
    }));
    const { api, dom, first, reader, second, socket } = createReaderHarness({
      lookupMode: "hover",
      getMiningStatus,
    });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });

    await hover(dom, first);
    const firstRequest = lastRequest(socket);
    socket.receive(lookupResult(firstRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    expect(
      Array.from(popup.querySelectorAll<HTMLButtonElement>(".gsm-hoshidicts-mine-button"))
        .every((button) => button.hidden)
    ).toBe(true);
    await flushPromises();
    expect(popup.querySelectorAll(".gsm-hoshidicts-mining-feedback")).toHaveLength(1);
    expect(popup.querySelector<HTMLDivElement>(".gsm-hoshidicts-mining-feedback")?.hidden)
      .toBe(true);
    expect(popup.querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toBe("");
    expect(
      Array.from(popup.querySelectorAll<HTMLButtonElement>(".gsm-hoshidicts-mine-button"))
        .every((button) => button.hidden)
    ).toBe(true);

    await hover(dom, second, { clientX: 31 });
    const secondRequest = lastRequest(socket);
    await respond(socket, lookupResult(secondRequest.requestId, "べる"));
    expect(getMiningStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps optional Anki field mappings out of the lookup UI", async () => {
    const harness = createReaderHarness({
      getMiningStatus: async () => ({
        available: true,
        unmappedFields: ["audio", "pitch"]
      }),
      onMine: async () => ({ success: true, noteId: 123 })
    });
    await renderFirstLookup(harness);
    await flushPromises();

    const popup = harness.reader.getPopupElement();
    const feedback = popup.querySelector<HTMLElement>(
      ".gsm-hoshidicts-mining-feedback"
    );
    expect(feedback?.hidden).toBe(true);
    expect(feedback?.textContent).toBe("");
    expect(
      popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
        ?.dataset.state
    ).toBe("ready");
  });

  it("disables an existing note when duplicate prevention is enabled", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicateBehavior: "prevent",
      results: payload.notes.map((note) =>
        note.result.term.expression === "食べる"
          ? {
              state: "duplicate",
              canAdd: false,
              duplicate: true
            }
          : {
              state: "addable",
              canAdd: true,
              duplicate: false
            }
      )
    }));
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: vi.fn()
    });
    await renderFirstLookup(harness, {
      transform(response) {
        response.results.push({
          ...response.results[0],
          matched: "食う",
          term: {
            ...response.results[0].term,
            expression: "食う",
            reading: "くう"
          }
        });
      }
    });
    (harness.reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-show-more"
    ) as HTMLButtonElement | null)?.click();
    await flushPromises();

    const buttons = miningButtonsInResultOrder(
      harness.reader.getPopupElement()
    );
    const button = buttons[0]!;
    expect(button.dataset.state).toBe("duplicate");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Note already exists");
    expect(buttons[1]!.dataset.state).toBe("ready");
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    expect(checkMiningNotes.mock.calls.map(([payload]) =>
      payload.notes[0].result.term.expression
    )).toEqual(["食べる", "食う"]);
    expect(checkMiningNotes).toHaveBeenNthCalledWith(1, {
      notes: [expect.objectContaining({
        sentence: "食べる",
        matchOffset: 0,
        result: expect.objectContaining({
          term: expect.objectContaining({ expression: "食べる" })
        })
      })]
    });
    expect(checkMiningNotes.mock.calls[0][0].notes[0])
      .not.toHaveProperty("audioSelection");
  });

  it("checks 33 mining buttons one at a time from the main headword downward", async () => {
    const checks = Array.from({ length: 33 }, () =>
      deferred<Record<string, unknown>>()
    );
    const checkedTerms: string[] = [];
    const checkMiningNotes = vi.fn((payload) => {
      expect(payload.notes).toHaveLength(1);
      checkedTerms.push(payload.notes[0].result.term.expression);
      return checks[checkedTerms.length - 1]!.promise;
    });
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      maxResults: 48,
      onMine: vi.fn()
    });
    await renderFirstLookup(harness, {
      transform(response) {
        const firstResult = response.results[0];
        response.results = Array.from({ length: 33 }, (_, index) => ({
          ...firstResult,
          matched: `語${index}`,
          deinflected: `語${index}`,
          term: {
            ...firstResult.term,
            expression: `語${index}`,
            glossaries: firstResult.term.glossaries.map((glossary) => ({
              ...glossary
            }))
          }
        }));
      }
    });

    let buttons = miningButtonsInResultOrder(
      harness.reader.getPopupElement()
    );
    expect(buttons).toHaveLength(1);
    expect(checkMiningNotes).toHaveBeenCalledTimes(1);
    expect(buttons[0]!.dataset.state).toBe("checking");
    const showMore = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")!;
    expect(showMore.textContent).toBe("Show 32 more");
    showMore.click();
    buttons = miningButtonsInResultOrder(harness.reader.getPopupElement());
    expect(buttons).toHaveLength(33);
    expect(checkMiningNotes).toHaveBeenCalledTimes(1);

    for (let index = 0; index < checks.length; index += 1) {
      checks[index]!.resolve({
        success: true,
        duplicateBehavior: "prevent",
        results: [{ state: "addable", canAdd: true, duplicate: false }]
      });
      await flushPromises();
      expect(buttons[index]!.dataset.state).toBe("ready");
      expect(checkMiningNotes).toHaveBeenCalledTimes(
        Math.min(index + 2, checks.length)
      );
      if (index + 1 < buttons.length) {
        expect(buttons[index + 1]!.dataset.state).toBe("checking");
      }
    }

    expect(checkedTerms).toEqual(
      Array.from({ length: 33 }, (_, index) => `語${index}`)
    );
    expect(buttons.every((button) => button.dataset.state === "ready"))
      .toBe(true);
  });

  it("continues after one note-specific duplicate-check result is invalid", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicateBehavior: "prevent",
      results: payload.notes.map((note) =>
        note.result.term.expression === "食べる"
          ? {
              state: "invalid",
              canAdd: false,
              duplicate: false,
              error: "The first Anki field is empty."
            }
          : { state: "addable", canAdd: true, duplicate: false }
      )
    }));
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: vi.fn()
    });
    await renderFirstLookup(harness, {
      transform(response) {
        response.results.push({
          ...response.results[0],
          matched: "食う",
          term: {
            ...response.results[0].term,
            expression: "食う",
            reading: "くう"
          }
        });
      }
    });
    (harness.reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-show-more"
    ) as HTMLButtonElement | null)?.click();
    await flushPromises();

    const buttons = miningButtonsInResultOrder(
      harness.reader.getPopupElement()
    );
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    expect(buttons[0]!.dataset.state).toBe("error");
    expect(buttons[0]!.title).toBe("The first Anki field is empty.");
    expect(buttons[1]!.dataset.state).toBe("ready");
  });

  it("continues after one note-specific duplicate-check request is rejected", async () => {
    const noteError = Object.assign(
      new Error('The first Anki field "Reading" is empty.'),
      { status: 422 }
    );
    const checkMiningNotes = vi.fn(async () => {
      if (checkMiningNotes.mock.calls.length === 1) {
        throw noteError;
      }
      return {
        success: true,
        duplicateBehavior: "prevent",
        results: [{ state: "addable", canAdd: true, duplicate: false }]
      };
    });
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: vi.fn()
    });
    await renderFirstLookup(harness, {
      transform(response) {
        response.results.push({
          ...response.results[0],
          matched: "食う",
          term: {
            ...response.results[0].term,
            expression: "食う",
            reading: "くう"
          }
        });
      }
    });
    (harness.reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-show-more"
    ) as HTMLButtonElement | null)?.click();
    await flushPromises();

    const buttons = miningButtonsInResultOrder(
      harness.reader.getPopupElement()
    );
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    expect(buttons[0]!.dataset.state).toBe("error");
    expect(buttons[0]!.title).toBe(
      'The first Anki field "Reading" is empty.'
    );
    expect(buttons[1]!.dataset.state).toBe("ready");
  });

  it("stops the remaining duplicate-check queue after an Anki configuration failure", async () => {
    const configurationError = Object.assign(
      new Error("The selected Anki note type is unavailable."),
      { status: 503 }
    );
    const checkMiningNotes = vi.fn(async () => {
      throw configurationError;
    });
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: vi.fn()
    });
    await renderFirstLookup(harness, {
      transform(response) {
        const firstResult = response.results[0];
        response.results = Array.from({ length: 3 }, (_, index) => ({
          ...firstResult,
          matched: `語${index}`,
          term: {
            ...firstResult.term,
            expression: `語${index}`
          }
        }));
      }
    });
    (harness.reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-show-more"
    ) as HTMLButtonElement | null)?.click();
    await flushPromises();

    const buttons = miningButtonsInResultOrder(
      harness.reader.getPopupElement()
    );
    expect(checkMiningNotes).toHaveBeenCalledTimes(1);
    expect(buttons.map((button) => button.dataset.state))
      .toEqual(["error", "error", "error"]);
    expect(buttons.every((button) =>
      button.title === "The selected Anki note type is unavailable."
    )).toBe(true);
  });

  it("keeps an existing note addable with a distinct duplicate state", async () => {
    const harness = createReaderHarness({
      checkMiningNotes: async () => ({
        success: true,
        duplicateBehavior: "new",
        results: [{
          state: "duplicate",
          canAdd: true,
          duplicate: true
        }]
      }),
      getMiningStatus: async () => ({ available: true }),
      onMine: vi.fn()
    });
    await renderFirstLookup(harness);

    const button = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    expect(button.dataset.state).toBe("add-duplicate");
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Add duplicate to Anki");
    expect(button.getAttribute("aria-label")).toBe("Add duplicate to Anki");
    expect(button.querySelector<HTMLElement>(".gsm-hoshidicts-mine-icon")
      ?.dataset.icon).toBe("add-duplicate-big-circle");
    expect(button.textContent).toBe("");
  });

  it("shows and submits Yomitan-style overwrite actions for duplicates", async () => {
    const checkMiningNotes = vi.fn(async () => ({
      success: true,
      checkForDuplicates: true,
      duplicateBehavior: "overwrite",
      results: [{
        state: "duplicate",
        canAdd: true,
        duplicate: true,
        action: "overwrite"
      }]
    }));
    const mine = vi.fn(async () => ({
      success: true,
      noteId: 123,
      overwritten: true,
      audio: { status: "preserved" }
    }));
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    await renderFirstLookup(harness);

    const popup = harness.reader.getPopupElement();
    const button = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-mine-button"
    )!;
    expect(button.dataset.state).toBe("overwrite");
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Overwrite note in Anki");
    expect(button.querySelector<HTMLElement>(".gsm-hoshidicts-mine-icon")
      ?.dataset.icon).toBe("overwrite-big-circle");

    button.click();
    await flushPromises();

    expect(mine).toHaveBeenCalledTimes(1);
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    expect(popup.querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toBe("Overwritten in Anki.");
  });

  it("uses structured duplicate errors instead of matching English text", async () => {
    const duplicateError = Object.assign(
      new Error("The card was rejected."),
      { code: "duplicate" }
    );
    const checkMiningNotes = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        duplicateBehavior: "prevent",
        results: [{ state: "addable", canAdd: true, duplicate: false }]
      })
      .mockResolvedValueOnce({
        success: true,
        duplicateBehavior: "prevent",
        results: [{ state: "duplicate", canAdd: false, duplicate: true }]
      });
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: vi.fn(async () => { throw duplicateError; })
    });
    await renderFirstLookup(harness);

    const popup = harness.reader.getPopupElement();
    const button = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-mine-button"
    )!;
    button.click();
    await flushPromises();

    expect(button.dataset.state).toBe("duplicate");
    expect(button.disabled).toBe(true);
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    expect(popup.querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toBe("Already in Anki.");
  });

  it("does not infer duplicates from an unstructured error message", async () => {
    const harness = createReaderHarness({
      getMiningStatus: async () => ({ available: true }),
      onMine: vi.fn(async () => {
        throw new Error("The duplicate-check service stopped responding.");
      })
    });
    await renderFirstLookup(harness);

    const button = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    button.click();
    await flushPromises();

    expect(button.dataset.state).toBe("error");
    expect(button.disabled).toBe(false);
  });

  it("ignores duplicate-check results from a replaced lookup", async () => {
    const firstCheck = deferred<Record<string, unknown>>();
    const secondCheck = deferred<Record<string, unknown>>();
    const checkMiningNotes = vi.fn()
      .mockImplementationOnce(() => firstCheck.promise)
      .mockImplementationOnce(() => secondCheck.promise);
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      lookupMode: "hover",
      onMine: vi.fn()
    });
    const second = harness.dom.window.document.getElementById("second")!;
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        response.results.push({
          ...response.results[0],
          matched: "食う",
          term: {
            ...response.results[0].term,
            expression: "食う",
            reading: "くう"
          }
        });
      }
    });

    await hover(harness.dom, second, { clientX: 31 });
    const request = lastRequest(harness.socket);
    await respond(harness.socket, lookupResult(request.requestId, "べる"));

    secondCheck.resolve({
      success: true,
      duplicateBehavior: "prevent",
      results: [{ state: "addable", canAdd: true, duplicate: false }]
    });
    await flushPromises();
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    const currentButton = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    expect(currentButton.dataset.state).toBe("ready");

    firstCheck.resolve({
      success: true,
      duplicateBehavior: "prevent",
      results: [{ state: "duplicate", canAdd: false, duplicate: true }]
    });
    await flushPromises();
    expect(currentButton.dataset.state).toBe("ready");
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
  });

  it("submits one note for a direct double click and rechecks after success", async () => {
    const finishMine = deferred<{ success: boolean; noteId: number }>();
    const checkMiningNotes = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        duplicateBehavior: "prevent",
        results: [{ state: "addable", canAdd: true, duplicate: false }]
      })
      .mockResolvedValueOnce({
        success: true,
        duplicateBehavior: "prevent",
        results: [{ state: "duplicate", canAdd: false, duplicate: true }]
      });
    const mine = vi.fn(() => finishMine.promise);
    const harness = createReaderHarness({
      checkMiningNotes,
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    await renderFirstLookup(harness);

    const button = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    button.click();
    dispatchMouse(harness.dom, button, "click");
    await flushPromises();
    expect(mine).toHaveBeenCalledTimes(1);

    finishMine.resolve({ success: true, noteId: 123 });
    await flushPromises();
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    expect(button.dataset.state).toBe("duplicate");
    expect(harness.reader.getPopupElement()
      .querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toBe("Added to Anki.");
  });

  it("keeps optional fields out of successful mining feedback", async () => {
    const harness = createReaderHarness({
      getMiningStatus: async () => ({ available: true }),
      onMine: async () => ({
        success: true,
        noteId: 123,
        unmappedFields: ["pitch"]
      })
    });
    await renderFirstLookup(harness);
    await flushPromises();

    harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();

    const feedback = harness.reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-mining-feedback"
    )!;
    expect(feedback.textContent).toBe("Added to Anki.");
    expect(feedback.dataset.kind).toBe("success");
  });

  it("keeps transient mining failures readable and retryable", async () => {
    const mine = vi.fn()
      .mockRejectedValueOnce(new Error("AnkiConnect stopped responding."))
      .mockResolvedValueOnce({ success: true, noteId: 123 });
    const harness = createReaderHarness({
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { reader } = harness;
    await renderFirstLookup(harness);

    const popup = reader.getPopupElement();
    const button = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-mine-button"
    )!;
    button.click();
    await flushPromises();
    expect(button.dataset.state).toBe("error");
    expect(button.disabled).toBe(false);
    expect(popup.querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toContain("AnkiConnect stopped responding");

    button.click();
    await flushPromises();
    expect(mine).toHaveBeenCalledTimes(2);
    expect(button.dataset.state).toBe("success");
    expect(popup.querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toBe("Added to Anki.");
  });

  it("passes the validated term and sentence offset to one mining button", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const harness = createReaderHarness({
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { reader } = harness;
    await renderFirstLookup(harness);

    const button = reader
      .getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    expect(button.dataset.state).toBe("ready");
    button.click();
    await flushPromises();

    expect(mine).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledWith(
      expect.objectContaining({
        sentence: "食べる",
        matchOffset: 0,
        result: expect.objectContaining({
          term: expect.objectContaining({
            expression: "食べる",
            frequencies: [
              {
                dictionary: "Frequency",
                frequencies: [{ value: 123, displayValue: "123 ★" }]
              }
            ],
            pitches: [
              {
                dictionary: "Pitch",
                pitches: [
                  {
                    position: 2,
                    pattern: "LHL",
                    nasal: [1],
                    devoice: [2]
                  }
                ],
                transcriptions: ["tabeɾɯ"]
              }
            ]
          })
        })
      })
    );
    expect(button.dataset.state).toBe("success");
  });

  it("passes a successful pronunciation selection to mining", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const audioController = createAudioControllerStub({
      sourceId: "jpod101",
      candidateIndex: 2,
      candidateId: "a".repeat(64)
    });
    const harness = createReaderHarness({
      audioController,
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    const { reader } = harness;
    await renderFirstLookup(harness, {
      transform(response) {
        response.results[0].term.expression = "  食べる  ";
        response.results[0].term.reading = "  たべる  ";
      }
    });

    const renderedResult = audioController.setRenderedResults.mock.calls
      .find(([items]) => items.length > 0)![0][0].result;
    expect(renderedResult.term).toMatchObject({
      expression: "食べる",
      reading: "たべる"
    });

    reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();

    expect(mine).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        term: expect.objectContaining({
          expression: "食べる",
          reading: "たべる"
        })
      }),
      audioSelection: {
        sourceId: "jpod101",
        candidateIndex: 2,
        candidateId: "a".repeat(64)
      }
    }));
    expect(mine.mock.calls[0][0].result).toBe(renderedResult);
  });

  it("keeps mining successful while surfacing an audio enrichment warning", async () => {
    const harness = createReaderHarness({
      getMiningStatus: async () => ({ available: true }),
      onMine: async () => ({
        success: true,
        noteId: 123,
        unmappedFields: ["audio", "pitch"],
        audio: {
          status: "failed",
          warning: "The pronunciation provider did not respond."
        }
      })
    });
    const { reader } = harness;
    await renderFirstLookup(harness);

    reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();

    const feedback = reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-mining-feedback"
    );
    expect(feedback?.dataset.kind).toBe("warning");
    expect(feedback?.textContent).toContain(
      "The pronunciation provider did not respond."
    );
    expect(feedback?.textContent).not.toContain("Optional");
    expect(feedback?.textContent).not.toContain("pitch");
  });
});

describe("Hoshidicts popup image source gating", () => {
  const jitendexImage = JSON.stringify({
    type: "structured-content",
    content: [{ tag: "img", path: "img/jitendex.jpg", width: 40, height: 40 }],
  });
  const daijirinImage = JSON.stringify({
    type: "structured-content",
    content: [{ tag: "img", path: "img/daijirin.jpg", width: 40, height: 40 }],
  });

  function twoDictionaryLookup(requestId: string) {
    return lookupResultWithDictionaries(requestId, [
      { dictionary: "JMdict", glossary: "to eat" },
      { dictionary: "Jitendex", glossary: jitendexImage },
      { dictionary: "Daijirin", glossary: daijirinImage },
    ]);
  }

  async function mediaRequestsFor(readerOptions: Record<string, unknown>) {
    const { dom, first, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:img"),
      revokeObjectURL: vi.fn(),
      ...readerOptions,
    }));
    await hover(dom, first);
    const lookup = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(twoDictionaryLookup(lookup.requestId));
    await flushPromises();
    return {
      socket,
      dictionaries: requestsOfType(socket, "hoshidicts_media").map(
        (request) => request.dictionary
      ),
    };
  }

  it("Automatic (no source) requests media for every dictionary that has an image", async () => {
    const { dictionaries } = await mediaRequestsFor({ popupImageSource: null });
    expect(new Set(dictionaries)).toEqual(new Set(["Jitendex", "Daijirin"]));
  });

  it.each([
    [
      "requests media only from that dictionary",
      { kind: "dictionary", title: "Jitendex" },
      ["Jitendex"]
    ],
    [
      "with no image in the result shows no image",
      { kind: "dictionary", title: "JMdict" },
      []
    ],
    [
      "that is stale/deleted shows no image",
      { kind: "dictionary", title: "Removed Dictionary" },
      []
    ]
  ])(
    "an individual dictionary source %s",
    async (_label, popupImageSource, expected) => {
      const { dictionaries } = await mediaRequestsFor({ popupImageSource });
      expect(dictionaries).toEqual(expected);
    }
  );

  it("does not leak a compact-summary image from a dictionary outside the source", async () => {
    // Compact TEXT comes from JMdict; its image must be suppressed because the
    // image source is Jitendex, whose image is the only one permitted.
    const { dom, first, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      showCompactDefinitionSummary: true,
      compactDefinitionSummaryDictionary: "JMdict",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:img"),
      revokeObjectURL: vi.fn(),
      popupImageSource: { kind: "dictionary", title: "Jitendex" },
    }));
    await hover(dom, first);
    const lookup = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(
      lookupResultWithDictionaries(lookup.requestId, [
        {
          dictionary: "JMdict",
          glossary: JSON.stringify({
            type: "structured-content",
            content: [
              { type: "image", path: "img/jmdict.jpg", width: 40, height: 40 },
              { tag: "p", content: "to eat" },
            ],
          }),
        },
        { dictionary: "Jitendex", glossary: jitendexImage },
      ])
    );
    await flushPromises();
    expect(
      requestsOfType(socket, "hoshidicts_media").map((request) => request.dictionary)
    ).toEqual(["Jitendex"]);
    // No JMdict compact image request means no leak into the compact summary.
    expect(
      requestsOfType(socket, "hoshidicts_media").some(
        (request) => request.path === "img/jmdict.jpg"
      )
    ).toBe(false);
  });

  it("a tab-group source shows images only from the first group dictionary that has one", async () => {
    const { dictionaries } = await mediaRequestsFor({
      popupImageSource: { kind: "tabGroup", id: "grp" },
      dictionaryTabGroups: [
        {
          id: "grp",
          name: "Group",
          dictionaries: ["JMdict", "Jitendex", "Daijirin"],
        },
      ],
    });
    // JMdict has no image, so Jitendex (next in group order) is the sole winner.
    expect(dictionaries).toEqual(["Jitendex"]);
  });

  it("a tab-group source with no images in any member shows no image", async () => {
    const { dom, first, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:img"),
      revokeObjectURL: vi.fn(),
      popupImageSource: { kind: "tabGroup", id: "grp" },
      dictionaryTabGroups: [{ id: "grp", name: "Group", dictionaries: ["JMdict"] }],
    }));
    await hover(dom, first);
    const lookup = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(twoDictionaryLookup(lookup.requestId));
    await flushPromises();
    expect(requestsOfType(socket, "hoshidicts_media")).toHaveLength(0);
  });

  it("a missing/deleted tab-group source shows no image", async () => {
    const { dictionaries } = await mediaRequestsFor({
      popupImageSource: { kind: "tabGroup", id: "gone" },
      dictionaryTabGroups: [{ id: "grp", name: "Group", dictionaries: ["Jitendex"] }],
    });
    expect(dictionaries).toEqual([]);
  });

  it("rerenders a visible popup image when the source changes without a new lookup", async () => {
    let objectUrlCounter = 0;
    const { dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      popupImageSource: { kind: "dictionary", title: "Jitendex" },
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => `blob:img-${(objectUrlCounter += 1)}`),
      revokeObjectURL: vi.fn(),
    }));
    const popup = reader.getPopupElement();
    await hover(dom, first);
    const lookup = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(twoDictionaryLookup(lookup.requestId));
    await flushPromises();

    const jitendexRequest = requestsOfType(socket, "hoshidicts_media")[0];
    expect(jitendexRequest.dictionary).toBe("Jitendex");
    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: jitendexRequest.requestId,
      success: true,
      generation: jitendexRequest.generation,
      dictionary: "Jitendex",
      path: "img/jitendex.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null,
    });
    const jitendexImageUrl = popup
      .querySelector<HTMLImageElement>('img.gloss-image[src^="blob:"]')!.src;
    expect(jitendexImageUrl).toBeTruthy();

    const lookupsBefore = requestsOfType(socket, "hoshidicts_lookup").length;
    reader.updatePreferences({
      popupImageSource: { kind: "dictionary", title: "Daijirin" },
    });
    await flushPromises();

    expect(requestsOfType(socket, "hoshidicts_lookup")).toHaveLength(lookupsBefore);
    const daijirinRequest = requestsOfType(socket, "hoshidicts_media").find(
      (request) => request.dictionary === "Daijirin"
    );
    expect(daijirinRequest).toBeDefined();
    expect(
      requestsOfType(socket, "hoshidicts_media").some(
        (request) =>
          request.dictionary === "Jitendex" &&
          request.requestId !== jitendexRequest.requestId
      )
    ).toBe(false);
    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: daijirinRequest!.requestId,
      success: true,
      generation: daijirinRequest!.generation,
      dictionary: "Daijirin",
      path: "img/daijirin.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null,
    });
    const loaded = popup.querySelectorAll<HTMLImageElement>(
      'img.gloss-image[src^="blob:"]'
    );
    expect(loaded).toHaveLength(1);
    expect(loaded[0].src).toBe("blob:img-2");
    expect(loaded[0].src).not.toBe(jitendexImageUrl);
  });

  it("ignores a stale media resolution after the source changes", async () => {
    let objectUrlCounter = 0;
    const { dom, first, reader, socket } = createReaderHarness((dom) => ({
      lookupMode: "hover",
      popupImageSource: { kind: "dictionary", title: "Jitendex" },
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => `blob:img-${(objectUrlCounter += 1)}`),
      revokeObjectURL: vi.fn(),
    }));
    const popup = reader.getPopupElement();
    await hover(dom, first);
    const lookup = lastRequestOfType(socket, "hoshidicts_lookup");
    socket.receive(twoDictionaryLookup(lookup.requestId));
    await flushPromises();
    const jitendexRequest = requestsOfType(socket, "hoshidicts_media")[0];
    expect(jitendexRequest.dictionary).toBe("Jitendex");

    reader.updatePreferences({
      popupImageSource: { kind: "dictionary", title: "Daijirin" },
    });
    await flushPromises();
    const daijirinRequest = requestsOfType(socket, "hoshidicts_media").find(
      (request) => request.dictionary === "Daijirin"
    );
    expect(daijirinRequest).toBeDefined();

    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: jitendexRequest.requestId,
      success: true,
      generation: jitendexRequest.generation,
      dictionary: "Jitendex",
      path: "img/jitendex.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null,
    });
    await respond(socket, {
      type: "hoshidicts_media_result",
      requestId: daijirinRequest!.requestId,
      success: true,
      generation: daijirinRequest!.generation,
      dictionary: "Daijirin",
      path: "img/daijirin.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null,
    });
    const loaded = popup.querySelectorAll<HTMLImageElement>(
      'img.gloss-image[src^="blob:"]'
    );
    expect(loaded).toHaveLength(1);
    expect(loaded[0].src).toBe("blob:img-1");
  });
});

describe("Hoshidicts deinflection disclosure", () => {
  const COMPOUND_TRACE = [
    { name: "-た", description: "" },
    { name: "potential or passive", description: "" },
    { name: "causative", description: "" }
  ];

  function makeCompound(response: ReturnType<typeof lookupResult>) {
    response.results[0].matched = "食べさせられた";
    response.results[0].deinflected = "食べる";
    response.results[0].trace = COMPOUND_TRACE.map((step) => ({ ...step }));
    response.results[0].term.expression = "食べる";
    response.results[0].term.reading = "たべる";
  }

  function disclosure(popup: Element, occurrence = 0) {
    return Array.from(
      popup.querySelectorAll<HTMLDetailsElement>(".gsm-hoshidicts-deinflection")
    )[occurrence] ?? null;
  }

  it("attaches one collapsed disclosure to the headword showing the endpoint path", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, { shiftKey: false, transform: makeCompound });

    const popup = harness.reader.getPopupElement();
    const details = disclosure(popup)!;
    expect(details).not.toBeNull();
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    const summary = details.querySelector("summary")!;
    expect(summary.textContent?.trim()).toBe("食べさせられた → 食べる");
    expect(summary.textContent).not.toContain("Why this matched");
    expect(
      summary.querySelector(".gsm-hoshidicts-deinflection-label")
    ).toBeNull();
    const path = summary.querySelector(".gsm-hoshidicts-deinflection-path")!;
    expect(path).not.toBeNull();
    expect(path.textContent).toContain("食べさせられた");
    expect(path.textContent).toContain("食べる");
    expect(summary.getAttribute("aria-label")).toBe(
      "Why this matched: 食べさせられた became 食べる"
    );
    expect(
      harness.reader
        .getPopupElement()
        .querySelectorAll(".gsm-hoshidicts-deinflection")
    ).toHaveLength(1);
  });

  it("lists the backend steps in exact order using text nodes", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, { shiftKey: false, transform: makeCompound });

    const details = disclosure(harness.reader.getPopupElement())!;
    const items = Array.from(
      details.querySelectorAll<HTMLLIElement>("ol > li")
    );
    expect(items.map((item) => item.textContent)).toEqual([
      "-た",
      "potential or passive",
      "causative"
    ]);
  });

  it("shows a non-empty step description when the backend provides one", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        makeCompound(response);
        response.results[0].trace = [
          { name: "-た", description: "Past tense" }
        ];
      }
    });

    const item = disclosure(harness.reader.getPopupElement())!.querySelector(
      "ol > li"
    )!;
    expect(item.textContent).toContain("-た");
    expect(item.textContent).toContain("Past tense");
  });

  it("resets the disclosure to collapsed when a new lookup replaces it", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    setRect(harness.second, { left: 30, top: 10, right: 90, bottom: 30 });
    await renderFirstLookup(harness, { shiftKey: false, transform: makeCompound });
    const first = disclosure(harness.reader.getPopupElement())!;
    first.open = true;

    await hover(harness.dom, harness.second, { clientX: 31, shiftKey: false });
    const request = lastRequest(harness.socket);
    const response = lookupResult(request.requestId, "見る");
    response.results[0].matched = "見られた";
    response.results[0].deinflected = "見る";
    response.results[0].trace = [
      { name: "-た", description: "" },
      { name: "potential or passive", description: "" }
    ];
    await respond(harness.socket, response);

    const next = disclosure(harness.reader.getPopupElement())!;
    expect(next.open).toBe(false);
    expect(next.querySelector("summary")!.textContent).toContain("見られた");
    expect(next.querySelector("summary")!.textContent).not.toContain(
      "食べさせられた"
    );
  });

  it("gives each result its own disclosure in result order", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        makeCompound(response);
        const second = JSON.parse(JSON.stringify(response.results[0]));
        second.matched = "書かれた";
        second.deinflected = "書く";
        second.trace = [{ name: "-た", description: "" }];
        second.term.expression = "書く";
        second.term.reading = "かく";
        response.results.push(second);
      }
    });

    const popup = harness.reader.getPopupElement();
    const showMore = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-show-more"
    );
    showMore?.click();
    await vi.advanceTimersByTimeAsync(0);

    const disclosures = Array.from(
      popup.querySelectorAll<HTMLDetailsElement>(".gsm-hoshidicts-deinflection")
    );
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0].querySelector("summary")!.textContent).toContain(
      "食べさせられた"
    );
    expect(
      Array.from(disclosures[0].querySelectorAll("ol > li"), (li) => li.textContent)
    ).toEqual(["-た", "potential or passive", "causative"]);
    expect(disclosures[1].querySelector("summary")!.textContent).toContain(
      "書かれた"
    );
    expect(
      Array.from(disclosures[1].querySelectorAll("ol > li"), (li) => li.textContent)
    ).toEqual(["-た"]);
  });

  it("suppresses the disclosure for a direct match with equal endpoints", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, { shiftKey: false });
    expect(disclosure(harness.reader.getPopupElement())).toBeNull();
  });

  it.each([
    [
      "an empty trace",
      (response: ReturnType<typeof lookupResult>) => {
        makeCompound(response);
        response.results[0].trace = [];
      }
    ],
    [
      "a missing trace",
      (response: ReturnType<typeof lookupResult>) => {
        makeCompound(response);
        delete (response.results[0] as Record<string, unknown>).trace;
      }
    ],
    [
      "a malformed trace",
      (response: ReturnType<typeof lookupResult>) => {
        makeCompound(response);
        (response.results[0] as Record<string, unknown>).trace = [
          { name: "", description: "" },
          { description: "no name" },
          "not an object"
        ];
      }
    ],
    [
      "a missing deinflected endpoint",
      (response: ReturnType<typeof lookupResult>) => {
        makeCompound(response);
        response.results[0].deinflected = "";
      }
    ],
    [
      "equal endpoints with a trace",
      (response: ReturnType<typeof lookupResult>) => {
        makeCompound(response);
        response.results[0].deinflected = response.results[0].matched;
      }
    ]
  ])("suppresses the disclosure for %s", async (_name, transform) => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    await renderFirstLookup(harness, { shiftKey: false, transform });
    expect(disclosure(harness.reader.getPopupElement())).toBeNull();
  });

  it.each([
    [
      "ja",
      "一致した理由",
      "一致した理由: 食べさせられた から 食べる に戻しました"
    ],
    [
      "ukr",
      "Чому це збіглося",
      "Чому це збіглося: 食べさせられた перетворено на 食べる"
    ]
  ])(
    "localizes only its own copy for %s and keeps backend step names verbatim",
    async (locale, summaryLabel, ariaLabel) => {
      const harness = createReaderHarness({ lookupMode: "hover", locale });
      await renderFirstLookup(harness, {
        shiftKey: false,
        transform: makeCompound
      });

      const details = disclosure(harness.reader.getPopupElement())!;
      const summary = details.querySelector("summary")!;
      expect(summary.textContent?.trim()).toBe("食べさせられた → 食べる");
      expect(summary.textContent).not.toContain(summaryLabel);
      expect(summary.getAttribute("aria-label")).toBe(ariaLabel);
      expect(
        Array.from(details.querySelectorAll("ol > li"), (li) => li.textContent)
      ).toEqual(["-た", "potential or passive", "causative"]);
    }
  );

  it("applies a locale pushed after the reader already exists on the next lookup", async () => {
    const harness = createReaderHarness({ lookupMode: "hover" });
    harness.reader.updateLocale("ja");
    await renderFirstLookup(harness, { shiftKey: false, transform: makeCompound });

    const summary = disclosure(harness.reader.getPopupElement())!.querySelector(
      "summary"
    )!;
    expect(summary.textContent).not.toContain("一致した理由");
    expect(summary.getAttribute("aria-label")).toBe(
      "一致した理由: 食べさせられた から 食べる に戻しました"
    );
  });

  it("passes the unmodified backend trace to the mining payload with no disclosure state", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 1 }));
    const harness = createReaderHarness({
      lookupMode: "hover",
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    await renderFirstLookup(harness, { shiftKey: false, transform: makeCompound });
    await flushPromises();

    harness.reader
      .getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();
    await flushPromises();

    const payload = mine.mock.calls[0][0];
    expect(payload.result.trace).toEqual(COMPOUND_TRACE);
    expect(payload.result.matched).toBe("食べさせられた");
    expect(payload.result.deinflected).toBe("食べる");
    expect(payload).not.toHaveProperty("disclosureOpen");
    expect(payload.result).not.toHaveProperty("disclosureOpen");
  });

  it("renders endpoint and step text exactly as the backend sent it, matching the mining payload", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 1 }));
    const harness = createReaderHarness({
      lookupMode: "hover",
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response: ReturnType<typeof lookupResult>) {
        response.results[0].matched = " 食べさせられた ";
        response.results[0].deinflected = " 食べる ";
        response.results[0].trace = [
          { name: " -た ", description: " Past tense " },
          { name: "potential or passive", description: "" }
        ];
        response.results[0].term.expression = "食べる";
        response.results[0].term.reading = "たべる";
      }
    });
    await flushPromises();

    const popup = harness.reader.getPopupElement();
    const details = disclosure(popup)!;
    const endpoints = Array.from(
      details.querySelectorAll(".gsm-hoshidicts-deinflection-endpoint"),
      (node) => node.textContent
    );
    expect(endpoints).toEqual([" 食べさせられた ", " 食べる "]);
    expect(
      Array.from(details.querySelectorAll("ol > li > .gsm-hoshidicts-deinflection-step-name"), (node) => node.textContent)
    ).toEqual([" -た ", "potential or passive"]);
    expect(
      details.querySelector(".gsm-hoshidicts-deinflection-step-description")!.textContent
    ).toBe(" Past tense ");

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();
    await flushPromises();

    const payload = mine.mock.calls[0][0];
    expect(endpoints).toEqual([payload.result.matched, payload.result.deinflected]);
    expect(
      Array.from(details.querySelectorAll("ol > li > .gsm-hoshidicts-deinflection-step-name"), (node) => node.textContent)
    ).toEqual(payload.result.trace.map((step: { name: string }) => step.name));
  });

  it("keeps a whitespace-only step name so the rule path stays consistent with mining", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 1 }));
    const harness = createReaderHarness({
      lookupMode: "hover",
      getMiningStatus: async () => ({ available: true }),
      onMine: mine
    });
    await renderFirstLookup(harness, {
      shiftKey: false,
      transform(response) {
        makeCompound(response);
        response.results[0].trace = [
          { name: "-た", description: "" },
          { name: "  ", description: "" },
          { name: "causative", description: "" }
        ];
      }
    });
    await flushPromises();

    const popup = harness.reader.getPopupElement();
    const details = disclosure(popup)!;
    const steps = Array.from(
      details.querySelectorAll("ol > li > .gsm-hoshidicts-deinflection-step-name"),
      (node) => node.textContent
    );
    expect(steps).toEqual(["-た", "  ", "causative"]);

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!
      .click();
    await flushPromises();
    await flushPromises();

    const payload = mine.mock.calls[0][0];
    expect(steps).toEqual(payload.result.trace.map((step: { name: string }) => step.name));
  });

  it("styles the disclosure to wrap without clipping long paths or descriptions", () => {
    const rule = readerCssRule(".gsm-hoshidicts-deinflection") ?? "";
    expect(rule).not.toBe("");
    const endpoint =
      readerCssRule(".gsm-hoshidicts-deinflection-endpoint") ??
      readerCssRule(".gsm-hoshidicts-deinflection-path") ??
      "";
    expect(endpoint).toMatch(/overflow-wrap\s*:\s*anywhere/);
    const steps = readerCssRule(".gsm-hoshidicts-deinflection-steps") ?? "";
    const combined = `${rule};${endpoint};${steps}`;
    expect(combined).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(combined).not.toMatch(/white-space\s*:\s*nowrap/);
  });

  it("makes the disclosure summary focus visible for keyboard users", () => {
    const focus = readerCssRule(".gsm-hoshidicts-deinflection summary:focus-visible");
    expect(focus).toBeTruthy();
    expect(focus).toMatch(/outline/);
  });
});
