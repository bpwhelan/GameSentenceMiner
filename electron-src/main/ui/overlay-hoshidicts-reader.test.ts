import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HOSHIDICTS_THEMES } from "../../shared/features/hoshidicts";
import { GSM_THEME_DEFINITIONS } from "../../shared/themes";

function loadReaderModule(window: Window) {
  const audioSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "GSM_Overlay/features/hoshidicts/audio.js"
    ),
    "utf8"
  );
  const popupSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "GSM_Overlay/features/hoshidicts/popup.js"
    ),
    "utf8"
  );
  const source = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "GSM_Overlay/features/hoshidicts/reader.js"
    ),
    "utf8"
  );
  const context = {
    AbortController,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    globalThis: window,
    setTimeout,
    window
  } as Record<string, any>;
  const audioModule = { exports: {} as any };
  context.module = audioModule;
  context.exports = audioModule.exports;
  vm.runInNewContext(audioSource, context, {
    filename: "GSM_Overlay/features/hoshidicts/audio.js"
  });
  const popupModule = { exports: {} as any };
  context.module = popupModule;
  context.exports = popupModule.exports;
  vm.runInNewContext(popupSource, context, {
    filename: "GSM_Overlay/features/hoshidicts/popup.js"
  });

  const readerModule = { exports: {} as any };
  context.module = readerModule;
  context.exports = readerModule.exports;
  vm.runInNewContext(source, context, {
    filename: "GSM_Overlay/features/hoshidicts/reader.js"
  });
  return readerModule.exports;
}

function runOverlayFeatureBootstrap(
  enabled: boolean,
  lookupMode?: string,
  activationKey?: string,
  sourceHighlightEnabled?: string,
  popupNestingMaxDepth?: string,
  definitionBlurEnv: Record<string, string | undefined> = {},
  showLookupCounts?: string
) {
  const html = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/index.html"),
    "utf8"
  );
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
    .map((match) => match[1])
    .find((source) => source.includes("gsmHoshidictsReaderEnabled"));
  if (!script) {
    throw new Error("Unable to find the Hoshidicts feature bootstrap script");
  }
  const addClass = vi.fn();
  const documentElement = {
    classList: { add: addClass },
    dataset: {} as Record<string, string>,
    style: { setProperty: vi.fn() }
  };
  const window = {} as Record<string, unknown>;
  vm.runInNewContext(script, {
    document: { documentElement },
    process: {
      env: {
        GSM_HOSHIDICTS_ENABLED: enabled ? "1" : "0",
        GSM_HOSHIDICTS_LOOKUP_MODE: lookupMode,
        GSM_HOSHIDICTS_ACTIVATION_KEY: activationKey,
        GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED: sourceHighlightEnabled,
        GSM_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH: popupNestingMaxDepth,
        GSM_HOSHIDICTS_SHOW_LOOKUP_COUNTS: showLookupCounts,
        ...definitionBlurEnv
      }
    },
    window
  });
  return { addClass, documentElement, window };
}

function runHoshidictsReaderConfiguration(
  lookupMode: string,
  activationKey: string = "Shift",
  sourceHighlightEnabled: boolean = false,
  popupNestingMaxDepth = 10,
  definitionBlur: Record<string, unknown> = {
    enabled: false,
    lookupThreshold: 5,
    revealMode: "timed",
    revealDelayMs: 5000
  },
  showLookupCounts = true
) {
  const html = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/index.html"),
    "utf8"
  );
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
    .map((match) => match[1])
    .find((source) => source.includes("configureHoshidictsReader(settings)"));
  if (!script) {
    throw new Error("Unable to find the Hoshidicts reader configuration script");
  }

  const setActivationKeyPressed = vi.fn();
  const updateAudioPreferences = vi.fn();
  const updatePreferences = vi.fn();
  const reader = {
    setActivationKeyPressed,
    updateAudioPreferences,
    updatePreferences
  };
  const createHoshidictsReader = vi.fn(() => reader);
  const createHoshidictsAudioClient = vi.fn(() => ({ kind: "audio" }));
  const checkMining = vi.fn(async () => ({ success: true, results: [] }));
  const browseMining = vi.fn(async () => ({ success: true }));
  const createHoshidictsMiningClient = vi.fn(() => ({
    browse: browseMining,
    check: checkMining,
    getStatus: vi.fn(),
    mine: vi.fn()
  }));
  const recordLookup = vi.fn();
  const createHoshidictsLookupStatsClient = vi.fn(() => ({
    record: recordLookup
  }));
  const normalizeActivationKey = vi.fn((value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : "Shift"
  );
  const invoke = vi.fn(async () => ({ saved: true }));
  const window = {
    gsmHoshidictsActivationKey: activationKey,
    gsmHoshidictsActivationKeyPressed: false,
    gsmHoshidictsDefinitionBlur: definitionBlur,
    gsmHoshidictsLookupMode: lookupMode,
    gsmHoshidictsShowLookupCounts: showLookupCounts,
    gsmHoshidictsSourceHighlightEnabled: sourceHighlightEnabled,
    gsmHoshidictsPopupNestingMaxDepth: popupNestingMaxDepth,
    gsmHoshidictsPopupWidthPx: 560,
    gsmHoshidictsPopupHeightPx: 420,
    gsmHoshidictsPopupOpacityPercent: 85,
    gsmHoshidictsPopupToolbarPosition: "top",
    gsmHoshidictsTheme: "default",
    gsmHoshidictsDictionaryTabGroups: [],
    gsmHoshidictsPopupButtons: {
      addToAnki: true,
      audio: true,
      customDefinition: true,
      viewInAnki: false,
      customLinks: []
    },
    gsmHoshidictsReaderEnabled: true,
    GSMHoshidictsReader: {
      createHoshidictsAudioClient,
      createHoshidictsMiningClient,
      createHoshidictsLookupStatsClient,
      createHoshidictsReader,
      normalizeActivationKey,
      normalizePopupButtons: vi.fn((value: unknown) => value),
      resolveGsmApiBaseUrl: vi.fn(() => "http://127.0.0.1:7275")
    }
  } as Record<string, any>;
  const ipcListeners = new Map<string, (...args: any[]) => void>();
  const ipcOn = vi.fn(
    (channel: string, listener: (...args: any[]) => void) => {
      ipcListeners.set(channel, listener);
    }
  );
  const context = {
    console,
    document: {
      documentElement: { dataset: {}, style: { setProperty: vi.fn() } }
    },
    ipcRenderer: { invoke, on: ipcOn },
    process: { env: {} },
    window
  } as Record<string, any>;
  vm.runInNewContext(script, context, {
    filename: "GSM_Overlay/index.html#configureHoshidictsReader"
  });
  context.configureHoshidictsReader({ gamepadServerPort: 7276 });

  return {
    browseMining,
    checkMining,
    createHoshidictsAudioClient,
    createHoshidictsLookupStatsClient,
    createHoshidictsMiningClient,
    createHoshidictsReader,
    emitPreferences(preferences: unknown) {
      ipcListeners.get("hoshidicts-reader-preferences")?.({}, preferences);
    },
    invoke,
    ipcListeners,
    ipcOn,
    normalizeActivationKey,
    recordLookup,
    reader,
    setActivationKeyPressed,
    updatePreferences,
    window
  };
}

function loadOverlayMainReaderPreferencesNormalizer() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/main.js"),
    "utf8"
  );
  const start = source.indexOf(
    "function normalizeHoshidictsReaderPreferencesWithDefinitionBlur"
  );
  const end = source.indexOf("\n\nconst IN_PROCESS_OVERLAY", start);
  if (start < 0 || end < 0) {
    throw new Error("Unable to find the overlay reader preference normalizer");
  }
  const context = {
    normalizeHoshidictsReaderPreferences: (preferences: unknown) => preferences
  } as Record<string, any>;
  vm.runInNewContext(source.slice(start, end), context, {
    filename: "GSM_Overlay/main.js#normalizeHoshidictsReaderPreferences"
  });
  return context.normalizeHoshidictsReaderPreferencesWithDefinitionBlur as (
    preferences: unknown
  ) => unknown;
}

function loadHoshidictsSettingsLinkWiring() {
  const settingsHtml = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/settings.html"),
    "utf8"
  );
  const start = settingsHtml.indexOf(
    'document.getElementById("openHoshidictsSettings")'
  );
  const end = settingsHtml.indexOf(
    '\n\n    document.getElementById("openYomitanSettings")',
    start
  );
  if (start < 0 || end < 0) {
    throw new Error("Unable to find the Hoshidicts settings link wiring");
  }

  let clickListener: (() => void) | null = null;
  const invoke = vi.fn(async () => ({ opened: true }));
  const button = {
    addEventListener: vi.fn(
      (event: string, listener: () => void) => {
        if (event === "click") clickListener = listener;
      }
    )
  };
  vm.runInNewContext(
    settingsHtml.slice(start, end),
    {
      console,
      document: {
        getElementById: (id: string) =>
          id === "openHoshidictsSettings" ? button : null
      },
      ipcRenderer: { invoke }
    },
    { filename: "GSM_Overlay/settings.html#openHoshidictsSettings" }
  );
  return {
    button,
    click: () => clickListener?.(),
    invoke,
    overlayHtml: fs.readFileSync(
      path.resolve(process.cwd(), "GSM_Overlay/index.html"),
      "utf8"
    ),
    settingsHtml
  };
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  send(value: string) {
    this.sent.push(value);
  }

  receive(value: unknown) {
    this.emit("message", {
      data: typeof value === "string" ? value : JSON.stringify(value)
    });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  private emit(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createDom() {
  return new JSDOM(
    `<!doctype html><html><body>
      <p class="text-block-container" data-block-id="0">
        <span id="first" class="text-box" data-selectable="true">食</span>
        <span id="second" class="text-box" data-selectable="true">べる</span>
      </p>
    </body></html>`,
    {
      pretendToBeVisual: true,
      url: "file:///overlay/index.html"
    }
  );
}

function setRect(
  element: Element,
  rect: Partial<DOMRect> & Pick<DOMRect, "left" | "top" | "right" | "bottom">
) {
  const width = rect.width ?? rect.right - rect.left;
  const height = rect.height ?? rect.bottom - rect.top;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width,
    height,
    toJSON: () => ({})
  } as DOMRect);
}

function lookupResult(
  requestId: string,
  expression: string,
  glossary: string = "to eat",
  generation: number = 1
) {
  return {
    type: "hoshidicts_lookup_result",
    requestId,
    generation,
    success: true,
    dictionaryCount: 1,
    featureDisabled: false,
    error: null,
    results: [
      {
        matched: expression,
        deinflected: expression,
        preprocessorSteps: 0,
        trace: [{ name: "past", description: "Past tense" }],
        term: {
          expression,
          reading: "たべる",
          rules: "v1",
          score: 10,
          glossaries: [
            {
              dictionary: "JMdict",
              glossary,
              definitionTags: "common",
              termTags: "uk"
            }
          ],
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
        }
      }
    ]
  };
}

function kanjiResult(requestId: string, character: string = "食") {
  return {
    type: "hoshidicts_lookup_result",
    requestId,
    success: true,
    dictionaryCount: 1,
    featureDisabled: false,
    error: null,
    results: [],
    kanji: {
      character,
      entries: [
        {
          dictionary: "KANJIDIC (English)",
          onyomi: "ショク ジキ",
          kunyomi: "く.う た.べる",
          tags: "jouyou",
          definitions: ["eat", "food"],
          stats: [
            { name: "grade", value: "2" },
            { name: "strokes", value: "9" }
          ]
        }
      ]
    }
  };
}

function lookupResultWithDictionaries(
  requestId: string,
  dictionaries: Array<{ dictionary: string; glossary: string }>,
  expression: string = "食べる"
) {
  const response = lookupResult(requestId, expression);
  response.results[0].term.glossaries = dictionaries.map(
    ({ dictionary, glossary }) => ({
      dictionary,
      glossary,
      definitionTags: "",
      termTags: ""
    })
  );
  return response;
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createAudioControllerStub(
  selection: {
    sourceId: string;
    candidateIndex: number;
    candidateId: string;
  } | null = null
) {
  return {
    beginLookup: vi.fn(),
    destroy: vi.fn(),
    dismissPopup: vi.fn(),
    getPreferences: vi.fn(() => ({
      version: 1,
      enabled: true,
      autoPlay: false,
      volume: 100,
      sources: []
    })),
    getSelection: vi.fn(() => selection),
    setRenderedResults: vi.fn(),
    updatePreferences: vi.fn((profile) => profile)
  };
}

function createReaderHarness(options: Record<string, any> = {}) {
  vi.useFakeTimers();
  const dom = createDom();
  const api = loadReaderModule(dom.window as unknown as Window);
  const first = dom.window.document.getElementById("first")!;
  setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
  const reader = api.createHoshidictsReader({
    window: dom.window,
    document: dom.window.document,
    WebSocket: FakeWebSocket,
    logger: { debug() {}, warn() {} },
    ...options
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  return { dom, first, reader, socket };
}

async function renderFirstLookup(
  harness: ReturnType<typeof createReaderHarness>,
  options: {
    expression?: string;
    shiftKey?: boolean;
    transform?: (response: ReturnType<typeof lookupResult>) => void;
  } = {}
) {
  harness.first.dispatchEvent(new harness.dom.window.MouseEvent("mousemove", {
    bubbles: true,
    shiftKey: options.shiftKey ?? true,
    clientX: 11,
    clientY: 11
  }));
  await vi.advanceTimersByTimeAsync(20);
  const request = JSON.parse(harness.socket.sent.at(-1)!);
  const response = lookupResult(request.requestId, options.expression ?? "食べる");
  options.transform?.(response);
  harness.socket.receive(response);
  await flushPromises();
  return response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  FakeWebSocket.instances = [];
});

describe("Hoshidicts safe popup rendering", () => {
  it("uses stable dimensions and complete semantic theme palettes", () => {
    const css = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "GSM_Overlay/features/hoshidicts/reader.css"
      ),
      "utf8"
    );
    const cssRules = Array.from(
      css.matchAll(/(?<selectors>[^{}]+)\{(?<declarations>[^{}]*)\}/gu)
    );
    const declarationsForSelector = (selector: string) =>
      cssRules.find((rule) =>
        rule.groups?.selectors
          .split(",")
          .map((candidate) =>
            candidate.replace(/\/\*[\s\S]*?\*\//gu, "").trim()
          )
          .includes(selector)
      )?.groups?.declarations;
    const popupRule = /\.gsm-hoshidicts-popup\s*\{(?<declarations>[^}]*)\}/.exec(
      css
    )?.groups?.declarations;
    const popupScrollbarRule =
      /\.gsm-hoshidicts-popup::\-webkit-scrollbar\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const popupScrollbarThumbRule =
      /\.gsm-hoshidicts-popup::\-webkit-scrollbar-thumb\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const chromeRule =
      /\.gsm-hoshidicts-result-chrome\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const bottomChromeRule = declarationsForSelector(
      '.gsm-hoshidicts-popup[data-toolbar-position="bottom"] .gsm-hoshidicts-result-chrome'
    );
    const tabListRule =
      /\.gsm-hoshidicts-tab-list\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const actionRule =
      /\.gsm-hoshidicts-audio-button,\s*\.gsm-hoshidicts-mine-button,\s*\.gsm-hoshidicts-note-button\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const audioActionRule =
      /\.gsm-hoshidicts-audio-button\s*\{(?<declarations>[^}]*)\}/.exec(css)
        ?.groups?.declarations;
    const mineIconRule =
      /\.gsm-hoshidicts-mine-icon\s*\{(?<declarations>[^}]*)\}/.exec(css)
        ?.groups?.declarations;
    const readyMineIconRule =
      /\.gsm-hoshidicts-mine-icon\[data-icon="big-circle"\]\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const duplicateMineIconRule =
      /\.gsm-hoshidicts-mine-icon\[data-icon="add-duplicate-big-circle"\]\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const rubyReadingRule =
      /\.gsm-hoshidicts-expression\s+rt\s*\{(?<declarations>[^}]*)\}/.exec(css)
        ?.groups?.declarations;
    const tagRule =
      /\.gsm-hoshidicts-tag\s*\{(?<declarations>[^}]*)\}/.exec(css)
        ?.groups?.declarations;
    const lookupStatsRule =
      /\.gsm-hoshidicts-lookup-stats\s*\{(?<declarations>[^}]*)\}/.exec(css)
        ?.groups?.declarations;
    const glossaryRule =
      /\.gsm-hoshidicts-glossary-card\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const glossarySummaryRule =
      /\.gsm-hoshidicts-glossary-card\s*>\s*summary\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;

    expect(popupRule).toContain(
      "width: var(--gsm-hoshidicts-popup-width, 560px)"
    );
    expect(popupRule).toContain(
      "height: var(--gsm-hoshidicts-popup-height, 420px)"
    );
    expect(popupRule).toContain("--hoshidicts-popup-background:");
    expect(popupRule).toContain("--gsm-hoshidicts-popup-opacity");
    expect(popupRule).toContain("85%");
    expect(popupRule).toContain("var(--hoshidicts-background-opacity)");
    expect(popupRule).toContain("var(--hoshidicts-palette-base-100)");
    expect(popupRule).toContain("background: var(--hoshidicts-popup-background)");
    expect(popupRule).toContain("backdrop-filter: blur(16px) saturate(1.08)");
    expect(popupRule).toContain("border-radius: 14px");
    expect(popupRule).toContain(
      "border: 1px solid var(--hoshidicts-border-strong)"
    );
    expect(popupRule).toContain("0 18px 48px rgba(0, 0, 0, 0.6)");
    expect(popupRule).not.toContain("0 0 10px rgba(255, 255, 255, 0.5)");
    expect(popupRule).toContain("color: var(--text-color)");
    expect(popupRule).not.toContain("color-scheme: dark");
    expect(popupRule).toContain("overflow-y: auto");
    expect(popupRule).toContain("scrollbar-width: thin");
    expect(popupRule).toContain("font-size: 16px");
    expect(popupRule).toContain("line-height: 1.5");
    expect(popupRule).toContain('"Noto Sans CJK JP"');
    expect(popupRule).not.toMatch(/(?:^|;)\s*opacity\s*:/);
    expect(popupScrollbarRule).toContain("width: 8px");
    expect(popupScrollbarThumbRule).toContain("border-radius: 999px");
    expect(chromeRule).toContain("position: sticky");
    expect(chromeRule).toContain(
      "border-bottom: 1px solid var(--hoshidicts-border)"
    );
    expect(chromeRule).toContain(
      "background: var(--hoshidicts-chrome-background)"
    );
    expect(bottomChromeRule).toContain("top: auto");
    expect(bottomChromeRule).toContain("bottom: -11px");
    expect(bottomChromeRule).toContain(
      "border-top: 1px solid var(--hoshidicts-border)"
    );
    expect(tabListRule).toContain("width: 100%");
    expect(tabListRule).toContain("overflow-x: auto");
    expect(actionRule).toContain("width: 36px");
    expect(actionRule).toContain("height: 36px");
    expect(mineIconRule).toContain("display: inline-flex");
    expect(mineIconRule).toContain("align-items: center");
    expect(mineIconRule).toContain("justify-content: center");
    expect(mineIconRule).toContain("width: 16px");
    expect(mineIconRule).toContain("height: 16px");
    expect(mineIconRule).not.toContain("transform:");
    expect(readyMineIconRule).toContain(
      'url("icons/big-circle.svg")'
    );
    expect(duplicateMineIconRule).toContain(
      'url("icons/add-duplicate-big-circle.svg")'
    );
    expect(fs.existsSync(path.resolve(
      process.cwd(),
      "GSM_Overlay/features/hoshidicts/icons/big-circle.svg"
    ))).toBe(true);
    expect(fs.existsSync(path.resolve(
      process.cwd(),
      "GSM_Overlay/features/hoshidicts/icons/add-duplicate-big-circle.svg"
    ))).toBe(true);
    expect(audioActionRule).toContain("border: 1px solid transparent");
    expect(rubyReadingRule).toContain("color: var(--text-color-light1)");
    expect(rubyReadingRule).toContain("font-size: 15px");
    expect(tagRule).toContain("font-size: 12px");
    expect(lookupStatsRule).toContain("color: var(--hoshidicts-text)");
    expect(lookupStatsRule).toContain("font-size: 13px");
    expect(lookupStatsRule).toContain("font-weight: 600");
    expect(glossaryRule).toContain("border-radius: 10px");
    expect(glossaryRule).toContain(
      "background: var(--hoshidicts-card-background)"
    );
    expect(glossarySummaryRule).toContain("font-size: 13px");
    const corePaletteTokenPairs = [
      ["color-scheme", "--hoshidicts-palette-color-scheme"],
      ["--color-base-100", "--hoshidicts-palette-base-100"],
      ["--color-base-200", "--hoshidicts-palette-base-200"],
      ["--color-base-300", "--hoshidicts-palette-base-300"],
      ["--color-base-content", "--hoshidicts-palette-base-content"],
      ["--color-primary", "--hoshidicts-palette-primary"],
      ["--color-primary-content", "--hoshidicts-palette-primary-content"],
      ["--color-secondary", "--hoshidicts-palette-secondary"],
      ["--color-secondary-content", "--hoshidicts-palette-secondary-content"],
      ["--color-accent", "--hoshidicts-palette-accent"],
      ["--color-accent-content", "--hoshidicts-palette-accent-content"],
      ["--color-neutral", "--hoshidicts-palette-neutral"],
      ["--color-neutral-content", "--hoshidicts-palette-neutral-content"],
      ["--color-info", "--hoshidicts-palette-info"],
      ["--color-info-content", "--hoshidicts-palette-info-content"],
      ["--color-success", "--hoshidicts-palette-success"],
      ["--color-success-content", "--hoshidicts-palette-success-content"],
      ["--color-warning", "--hoshidicts-palette-warning"],
      ["--color-warning-content", "--hoshidicts-palette-warning-content"],
      ["--color-error", "--hoshidicts-palette-error"],
      ["--color-error-content", "--hoshidicts-palette-error-content"]
    ] as const;
    const corePaletteTokens = corePaletteTokenPairs.map(([, target]) => target);
    const defaultPalette =
      declarationsForSelector('html[data-hoshidicts-theme="default"]') ??
      declarationsForSelector(":root") ??
      declarationsForSelector("html");
    expect(defaultPalette).toBeDefined();
    for (const token of corePaletteTokens) {
      expect(defaultPalette, `default palette is missing ${token}`).toContain(
        `${token}:`
      );
    }
    for (const theme of HOSHIDICTS_THEMES.filter(
      (candidate) => candidate !== "default"
    )) {
      const declarations = declarationsForSelector(
        `html[data-hoshidicts-theme="${theme}"]`
      );
      expect(declarations, `${theme} needs a root palette`).toBeDefined();
      for (const token of corePaletteTokens) {
        expect(declarations, `${theme} palette is missing ${token}`).toContain(
          `${token}:`
        );
      }
    }

    const parseDeclarations = (declarations: string) =>
      Object.fromEntries(
        Array.from(
          declarations.matchAll(
            /(?<name>(?:--)?[a-z0-9-]+)\s*:\s*(?<value>[^;]+);/gu
          ),
          (match) => [
            match.groups?.name ?? "",
            match.groups?.value?.trim() ?? ""
          ]
        )
      );
    const normalizeColorToken = (value: string | undefined) =>
      value
        ?.replace(/\s+/gu, " ")
        .replace(/(^|[ (])0\./gu, "$1.")
        .trim();
    const targetPalette = (theme: string) =>
      parseDeclarations(
        declarationsForSelector(`html[data-hoshidicts-theme="${theme}"]`) ??
          ""
      );
    const customThemeIds = new Set([
      "gsm-dark",
      "catppuccin-mocha",
      "solarized-dark",
      "solarized-light",
      "high-contrast"
    ]);

    for (const theme of GSM_THEME_DEFINITIONS.filter(
      ({ id }) => !customThemeIds.has(id)
    )) {
      const source = fs.readFileSync(
        path.resolve(
          process.cwd(),
          `node_modules/daisyui/theme/${theme.id}/object.js`
        ),
        "utf8"
      );
      const sourcePalette = JSON.parse(
        source.replace(/^export default\s+/u, "").replace(/;\s*$/u, "")
      ) as Record<string, string>;
      const target = targetPalette(theme.id);
      for (const [sourceToken, targetToken] of corePaletteTokenPairs) {
        expect(
          normalizeColorToken(target[targetToken]),
          `${theme.id} ${targetToken} must match daisyUI`
        ).toBe(normalizeColorToken(sourcePalette[sourceToken]));
      }
    }

    const rendererThemeCss = fs.readFileSync(
      path.resolve(process.cwd(), "electron-src/renderer/src/styles.css"),
      "utf8"
    );
    const rendererThemeBlocks = Array.from(
      rendererThemeCss.matchAll(
        /@plugin\s+"daisyui\/theme"\s*\{(?<declarations>[\s\S]*?)\n\}/gu
      )
    ).map((match) => parseDeclarations(match.groups?.declarations ?? ""));
    for (const gsmTheme of customThemeIds) {
      const sourcePalette = rendererThemeBlocks.find(
        (palette) => palette.name?.replaceAll('"', "") === gsmTheme
      );
      const hoshidictsTheme = gsmTheme === "gsm-dark" ? "default" : gsmTheme;
      const target = targetPalette(hoshidictsTheme);
      expect(sourcePalette, `${gsmTheme} needs a renderer palette`).toBeDefined();
      for (const [sourceToken, targetToken] of corePaletteTokenPairs) {
        expect(
          normalizeColorToken(target[targetToken]),
          `${hoshidictsTheme} ${targetToken} must match GSM`
        ).toBe(normalizeColorToken(sourcePalette?.[sourceToken]));
      }
    }

    const semanticThemeTokens = [
      "--hoshidicts-popup-background",
      "--hoshidicts-chrome-background",
      "--hoshidicts-surface",
      "--hoshidicts-surface-raised",
      "--hoshidicts-card-base",
      "--hoshidicts-text",
      "--hoshidicts-text-muted",
      "--hoshidicts-text-faint",
      "--hoshidicts-border",
      "--hoshidicts-border-strong",
      "--hoshidicts-accent",
      "--hoshidicts-accent-contrast",
      "--hoshidicts-accent-soft",
      "--hoshidicts-success",
      "--hoshidicts-warning",
      "--hoshidicts-danger",
      "--hoshidicts-link",
      "--hoshidicts-link-hover",
      "--hoshidicts-scrollbar",
      "--hoshidicts-frequency",
      "--hoshidicts-frequency-text",
      "--hoshidicts-pitch",
      "--hoshidicts-pitch-text",
      "--hoshidicts-tag-text",
      "--hoshidicts-tag-expression-text",
      "--hoshidicts-tag-part-of-speech-text",
      "--tag-default-background-color",
      "--tag-expression-background-color",
      "--tag-part-of-speech-background-color"
    ];
    for (const token of semanticThemeTokens) {
      const declaration = new RegExp(
        `${token}:\\s*([^;]+)`,
        "u"
      ).exec(popupRule ?? "")?.[1];
      expect(declaration, `${token} needs a semantic bridge`).toContain(
        "--hoshidicts-palette-"
      );
    }
    expect(
      new RegExp("--hoshidicts-card-background:\\s*([^;]+)", "u").exec(
        popupRule ?? ""
      )?.[1]
    ).toContain("--hoshidicts-card-base");
  });

  it("blurs glossary content without obscuring definition tags", () => {
    const css = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "GSM_Overlay/features/hoshidicts/reader.css"
      ),
      "utf8"
    );
    const blurRule =
      /\.gsm-hoshidicts-definitions\[data-definition-blur-state="pending"\]\s+\.gsm-hoshidicts-glossary-content,\s*\.gsm-hoshidicts-definitions\[data-definition-blur-state="blurred"\]\s+\.gsm-hoshidicts-glossary-content\s*\{(?<declarations>[^}]*)\}/u.exec(
        css
      );

    expect(blurRule?.groups?.declarations).toContain("filter: blur(5px)");
    expect(blurRule?.groups?.declarations).toContain("user-select: none");
    expect(blurRule?.[0]).not.toContain("definition-tags");
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

  it("links to dedicated settings from Overlay Settings instead of the overlay toolbar", async () => {
    const { button, click, invoke, overlayHtml, settingsHtml } =
      loadHoshidictsSettingsLinkWiring();
    const document = new JSDOM(settingsHtml).window.document;
    const settingsButton = document.querySelector(
      "#openHoshidictsSettings"
    );

    expect(overlayHtml).not.toContain('id="btn-hoshidicts-settings"');
    expect(overlayHtml.indexOf("features/hoshidicts/audio.js")).toBeLessThan(
      overlayHtml.indexOf("features/hoshidicts/popup.js")
    );
    expect(overlayHtml.indexOf("features/hoshidicts/popup.js")).toBeLessThan(
      overlayHtml.indexOf("features/hoshidicts/reader.js")
    );
    expect(settingsButton).not.toBeNull();
    expect(settingsButton?.textContent?.trim()).toBe("Hoshidicts Settings");
    expect(button.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function)
    );

    click();
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("open-hoshidicts-settings");
  });

  it("sets the scanner-suppression marker before the overlay scripts load", () => {
    const enabled = runOverlayFeatureBootstrap(true);
    expect(enabled.window.gsmHoshidictsReaderEnabled).toBe(true);
    expect(enabled.window.gsmHoshidictsLookupMode).toBe("shift");
    expect(enabled.window.gsmHoshidictsActivationKey).toBe("Shift");
    expect(enabled.window.gsmHoshidictsActivationKeyPressed).toBe(false);
    expect(enabled.window.gsmHoshidictsSourceHighlightEnabled).toBe(false);
    expect(enabled.window.gsmHoshidictsPopupNestingMaxDepth).toBe(10);
    expect(enabled.window.gsmHoshidictsPopupWidthPx).toBe(560);
    expect(enabled.window.gsmHoshidictsPopupHeightPx).toBe(420);
    expect(enabled.window.gsmHoshidictsTheme).toBe("default");
    expect(enabled.window.gsmHoshidictsPopupOpacityPercent).toBe(85);
    expect(enabled.window.gsmHoshidictsPopupToolbarPosition).toBe("top");
    expect(enabled.documentElement.dataset.hoshidictsTheme).toBe("default");
    expect(enabled.documentElement.style.setProperty).toHaveBeenCalledWith(
      "--gsm-hoshidicts-popup-opacity",
      "85%"
    );
    expect(enabled.window.gsmHoshidictsShowLookupCounts).toBe(true);
    expect(enabled.window.gsmHoshidictsPopupButtons).toEqual({
      addToAnki: true,
      audio: true,
      customDefinition: true,
      viewInAnki: false,
      customLinks: []
    });
    expect(enabled.addClass).toHaveBeenCalledWith("gsm-hoshidicts-enabled");
    expect(enabled.documentElement.dataset.gsmHoshidictsEnabled).toBe("true");

    const disabled = runOverlayFeatureBootstrap(false);
    expect(disabled.window.gsmHoshidictsReaderEnabled).toBe(false);
    expect(disabled.window.gsmHoshidictsShowLookupCounts).toBe(true);
    expect(disabled.addClass).not.toHaveBeenCalled();
    expect(disabled.documentElement.dataset.gsmHoshidictsEnabled).toBeUndefined();

    expect(
      runOverlayFeatureBootstrap(true, "hover", "F8", "1")
        .window.gsmHoshidictsSourceHighlightEnabled
    ).toBe(true);
    expect(
      runOverlayFeatureBootstrap(
        true,
        "hover",
        undefined,
        undefined,
        undefined,
        {},
        "0"
      ).window.gsmHoshidictsShowLookupCounts
    ).toBe(false);
    const themed = runOverlayFeatureBootstrap(
      true,
      "shift",
      undefined,
      undefined,
      undefined,
      {
        GSM_HOSHIDICTS_POPUP_WIDTH_PX: "720",
        GSM_HOSHIDICTS_POPUP_HEIGHT_PX: "520",
        GSM_HOSHIDICTS_THEME: "cyberpunk",
        GSM_HOSHIDICTS_POPUP_OPACITY_PERCENT: "70",
        GSM_HOSHIDICTS_POPUP_TOOLBAR_POSITION: "bottom"
      }
    );
    expect(themed.window.gsmHoshidictsPopupWidthPx).toBe(720);
    expect(themed.window.gsmHoshidictsPopupHeightPx).toBe(520);
    expect(themed.window.gsmHoshidictsTheme).toBe("cyberpunk");
    expect(themed.window.gsmHoshidictsPopupOpacityPercent).toBe(70);
    expect(themed.window.gsmHoshidictsPopupToolbarPosition).toBe("bottom");
    expect(themed.documentElement.dataset.hoshidictsTheme).toBe("cyberpunk");
    expect(themed.documentElement.style.setProperty).toHaveBeenCalledWith(
      "--gsm-hoshidicts-popup-opacity",
      "70%"
    );
  });

  it("accepts every supported popup theme from the launch environment", () => {
    expect(HOSHIDICTS_THEMES).toHaveLength(41);
    for (const theme of HOSHIDICTS_THEMES) {
      const configured = runOverlayFeatureBootstrap(
        true,
        "shift",
        undefined,
        undefined,
        undefined,
        { GSM_HOSHIDICTS_THEME: theme }
      );
      expect(configured.window.gsmHoshidictsTheme).toBe(theme);
      expect(configured.documentElement.dataset.hoshidictsTheme).toBe(theme);
    }

    const invalid = runOverlayFeatureBootstrap(
      true,
      "shift",
      undefined,
      undefined,
      undefined,
      { GSM_HOSHIDICTS_THEME: "not-a-theme" }
    );
    expect(invalid.window.gsmHoshidictsTheme).toBe("default");
    expect(invalid.documentElement.dataset.hoshidictsTheme).toBe("default");
  });

  it("normalizes the lookup mode and wires custom entries through overlay IPC", async () => {
    expect(
      runOverlayFeatureBootstrap(true, "hover").window.gsmHoshidictsLookupMode
    ).toBe("hover");
    expect(
      runOverlayFeatureBootstrap(true, "invalid").window.gsmHoshidictsLookupMode
    ).toBe("shift");

    expect(runOverlayFeatureBootstrap(true, "hover", undefined, undefined, "0").window
      .gsmHoshidictsPopupNestingMaxDepth).toBe(0);
    expect(runOverlayFeatureBootstrap(true, "hover", undefined, undefined, "invalid").window
      .gsmHoshidictsPopupNestingMaxDepth).toBe(10);

    const configured = runHoshidictsReaderConfiguration("hover", "F8", true, 4);
    expect(configured.createHoshidictsReader).toHaveBeenCalledWith(
      expect.objectContaining({
        lookupMode: "hover",
        activationKey: "F8",
        activationKeyPressed: false,
        audioClient: { kind: "audio" },
        sourceHighlightEnabled: true,
        showLookupCounts: true,
        popupNestingMaxDepth: 4,
        popupWidthPx: 560,
        popupHeightPx: 420,
        popupOpacityPercent: 85,
        popupToolbarPosition: "top",
        theme: "default",
        popupButtons: {
          addToAnki: true,
          audio: true,
          customDefinition: true,
          viewInAnki: false,
          customLinks: []
        },
        definitionBlur: {
          enabled: false,
          lookupThreshold: 5,
          revealMode: "timed",
          revealDelayMs: 5000
        }
      })
    );
    expect(configured.createHoshidictsLookupStatsClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:7275"
    });
    expect(configured.createHoshidictsAudioClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:7275"
    });
    expect(configured.createHoshidictsMiningClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:7275"
    });
    const options = configured.createHoshidictsReader.mock.calls[0][0];
    const duplicateCheck = { notes: [{ sentence: "食べる" }] };
    await options.checkMiningNotes(duplicateCheck);
    expect(configured.checkMining).toHaveBeenCalledWith(duplicateCheck);
    options.onLookup({ term: "食べる", reading: "たべる" });
    expect(configured.recordLookup).toHaveBeenCalledWith({
      term: "食べる",
      reading: "たべる"
    });
    await options.onBrowse({ word: "食べる" });
    expect(configured.browseMining).toHaveBeenCalledWith({ word: "食べる" });
    await options.onOpenExternalLink("https://jisho.org/search/test");
    expect(configured.invoke).toHaveBeenCalledWith(
      "hoshidicts-open-external",
      { url: "https://jisho.org/search/test" }
    );
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

  it("parses definition blur launch preferences with safe defaults", () => {
    const configured = runOverlayFeatureBootstrap(
      true,
      "shift",
      undefined,
      undefined,
      undefined,
      {
        GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED: "1",
        GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD: "12",
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE: "hover",
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS: "9000"
      }
    );
    expect(configured.window.gsmHoshidictsDefinitionBlur).toEqual({
      enabled: true,
      lookupThreshold: 12,
      revealMode: "hover",
      revealDelayMs: 9000
    });

    const invalid = runOverlayFeatureBootstrap(
      true,
      "shift",
      undefined,
      undefined,
      undefined,
      {
        GSM_HOSHIDICTS_DEFINITION_BLUR_ENABLED: "yes",
        GSM_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD: "12invalid",
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_MODE: "invalid",
        GSM_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS: "3600001"
      }
    );
    expect(invalid.window.gsmHoshidictsDefinitionBlur).toEqual({
      enabled: false,
      lookupThreshold: 5,
      revealMode: "timed",
      revealDelayMs: 5000
    });
  });

  it("applies only valid live definition blur preferences", () => {
    const configured = runHoshidictsReaderConfiguration("shift");
    const validPreferences = {
      lookupMode: "hover",
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
      dictionaryPresentation: [
        { title: "Primary", favorite: false, displayName: "Main dictionary" },
        { title: "Backup", favorite: true }
      ],
      dictionaryTabGroups: [
        { id: "reference", name: "Reference", dictionaries: ["Primary"] }
      ],
      popupButtons: {
        addToAnki: false,
        audio: true,
        customDefinition: false,
        viewInAnki: true,
        customLinks: [
          { label: "Jisho", url: "https://jisho.org/search/%w" }
        ]
      },
      definitionBlur: {
        enabled: true,
        lookupThreshold: 7,
        revealMode: "hover",
        revealDelayMs: 6000
      }
    };
    configured.emitPreferences(validPreferences);
    expect(configured.updatePreferences).toHaveBeenLastCalledWith(
      validPreferences
    );

    configured.emitPreferences({
      ...validPreferences,
      definitionBlur: {
        ...validPreferences.definitionBlur,
        lookupThreshold: 0
      }
    });
    expect(configured.updatePreferences).toHaveBeenCalledTimes(1);
    configured.emitPreferences({
      ...validPreferences,
      dictionaryPresentation: [
        { title: "Primary", favorite: false, displayName: "   " }
      ]
    });
    expect(configured.updatePreferences).toHaveBeenCalledTimes(1);
  });

  it("accepts every supported popup theme in live preferences", () => {
    const configured = runHoshidictsReaderConfiguration("shift");
    const preferences = {
      lookupMode: "hover",
      activationKey: "F9",
      sourceHighlightEnabled: true,
      onlyScanJapaneseText: true,
      popupHideDelayMs: 800,
      showLookupCounts: true,
      popupNestingMaxDepth: 3,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "top",
      dictionaryPresentation: [],
      definitionBlur: {
        enabled: false,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      }
    };

    for (const theme of HOSHIDICTS_THEMES) {
      configured.emitPreferences({ ...preferences, theme });
      expect(configured.updatePreferences).toHaveBeenLastCalledWith({
        ...preferences,
        dictionaryTabGroups: [],
        theme
      });
    }
    expect(configured.updatePreferences).toHaveBeenCalledTimes(
      HOSHIDICTS_THEMES.length
    );

    configured.emitPreferences({ ...preferences, theme: "not-a-theme" });
    expect(configured.updatePreferences).toHaveBeenCalledTimes(
      HOSHIDICTS_THEMES.length
    );
  });

  it("validates definition blur preferences in overlay main", () => {
    const normalize = loadOverlayMainReaderPreferencesNormalizer();
    const preferences = {
      lookupMode: "hover",
      activationKey: "F9",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 800,
      showLookupCounts: true,
      popupNestingMaxDepth: 3,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "autumn",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      }
    };
    expect(normalize(preferences)).toEqual(preferences);
    expect(() => normalize({
      ...preferences,
      definitionBlur: { ...preferences.definitionBlur, lookupThreshold: 0 }
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalize({
      ...preferences,
      definitionBlur: { ...preferences.definitionBlur, revealDelayMs: 3_600_001 }
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalize({
      ...preferences,
      showLookupCounts: "false"
    })).toThrow("Hoshidicts reader preferences are invalid.");
  });

  it("sender-validates overlay custom-entry IPC before using the desktop bridge", () => {
    const mainSource = fs.readFileSync(
      path.resolve(process.cwd(), "GSM_Overlay/main.js"),
      "utf8"
    );
    expect(mainSource).toContain(
      'ipcMain.handle("hoshidicts-add-custom-entry", async (event, payload)'
    );
    expect(mainSource).toContain("event.sender !== mainWindow.webContents");
    expect(mainSource).toContain(
      "hoshidictsReaderPreferencesBridge.requestAddCustomEntry"
    );
  });

  it("sender-validates custom website IPC and only opens external URLs", () => {
    const mainSource = fs.readFileSync(
      path.resolve(process.cwd(), "GSM_Overlay/main.js"),
      "utf8"
    );
    expect(mainSource).toContain(
      'ipcMain.handle("hoshidicts-open-external", async (event, payload)'
    );
    expect(mainSource).toContain("event.sender !== mainWindow.webContents");
    expect(mainSource).toContain("shell.openExternal");
  });

  it("applies complete audio profiles delivered by the desktop bridge", () => {
    const configured = runHoshidictsReaderConfiguration("hover");
    const registration = configured.ipcOn.mock.calls.find(
      ([channel]) => channel === "hoshidicts-audio-preferences"
    );
    expect(registration).toBeDefined();
    const profile = {
      version: 1,
      enabled: true,
      autoPlay: true,
      volume: 60,
      sources: [{
        id: "jisho",
        type: "jisho",
        url: "",
        voice: ""
      }]
    };

    registration![1]({}, profile);

    expect(configured.window.gsmHoshidictsAudioPreferences).toBe(profile);
    expect(configured.reader.updateAudioPreferences).toHaveBeenCalledWith(profile);
  });

  it("relays live activation-key preferences and global press edges", () => {
    const configured = runHoshidictsReaderConfiguration("shift", "Shift");
    configured.ipcListeners.get("hoshidicts-reader-preferences")?.({}, {
      lookupMode: "shift",
      activationKey: "F9",
      popupHideDelayMs: 450,
      showLookupCounts: false,
      popupNestingMaxDepth: 10,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "cyberpunk",
      dictionaryPresentation: [],
      sourceHighlightEnabled: true,
      definitionBlur: {
        enabled: false,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      }
    });
    expect(configured.updatePreferences).toHaveBeenCalledWith({
      lookupMode: "shift",
      activationKey: "F9",
      definitionBlur: {
        enabled: false,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      popupHideDelayMs: 450,
      showLookupCounts: false,
      popupNestingMaxDepth: 10,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "cyberpunk",
      dictionaryPresentation: [],
      dictionaryTabGroups: [],
      sourceHighlightEnabled: true,
      onlyScanJapaneseText: true
    });

    configured.ipcListeners.get("hoshidicts-activation-key-state")?.({}, true);
    expect(configured.setActivationKeyPressed).toHaveBeenCalledWith(true);
    expect(configured.window.gsmHoshidictsActivationKeyPressed).toBe(true);
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
    vi.useFakeTimers();
    const dom = createDom();
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
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const lookupRequest = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_lookup");
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

    const stylesRequest = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_styles");
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

    reader.destroy();
    expect(style?.isConnected).toBe(false);
  });

  it("opens a Jitendex internal definition link in a child popup", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupHideDelayMs: 0,
      popupNestingMaxDepth: 2,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const parentRequest = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_lookup");
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
    link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const childRequest = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_lookup");
    expect(childRequest.text).toBe("猫");
    expect(childRequest.primaryReading).toBe("ねこ");
    expect(childRequest.requestId).not.toBe(parentRequest.requestId);
    const childResponse = lookupResult(childRequest.requestId, "猫", "cat", 4);
    childResponse.results[0].term.reading = "ねこ";
    socket.receive(childResponse);

    const popups = reader.getPopupElements();
    expect(popups).toHaveLength(2);
    expect(popups[0].textContent).toContain("猫");
    expect(popups[1].textContent).toContain("cat");

    setRect(popups[0], { left: 100, top: 100, right: 200, bottom: 300 });
    setRect(popups[1], { left: 206, top: 110, right: 306, bottom: 310 });
    popups[0].dispatchEvent(new dom.window.MouseEvent("pointerenter"));
    popups[0].dispatchEvent(new dom.window.MouseEvent("pointerleave"));
    expect(reader.isVisible()).toBe(true);
    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 203,
      clientY: 150
    }));
    await vi.advanceTimersByTimeAsync(500);
    expect(reader.getPopupElements()).toHaveLength(2);
    popups[1].dispatchEvent(new dom.window.MouseEvent("pointerenter"));
    popups[1].dispatchEvent(new dom.window.MouseEvent("pointerleave"));
    popups[0].dispatchEvent(new dom.window.MouseEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(500);
    expect(reader.getPopupElements()).toHaveLength(2);

    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 400,
      clientY: 400
    }));
    expect(reader.isVisible()).toBe(false);
    reader.destroy();
  });

  it("clamps the popup beside the anchor inside the viewport", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);

    expect(
      api.calculatePopupPosition(
        { left: 780, right: 800, top: 570, bottom: 590 },
        { width: 420, height: 300 },
        { width: 800, height: 600 }
      )
    ).toEqual({
      left: 374,
      top: 266,
      width: 420,
      height: 300
    });

    expect(
      api.calculatePopupPosition(
        { left: 10, right: 30, top: 20, bottom: 80 },
        { width: 300, height: 500 },
        { width: 800, height: 600 },
        { vertical: true }
      )
    ).toEqual({
      left: 34,
      top: 20,
      width: 300,
      height: 500
    });
  });

  it("preserves the configured popup size while clamping only its placement", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);

    expect(
      api.calculatePopupPosition(
        { left: 320, right: 380, top: 650, bottom: 680 },
        { width: 420, height: 80 },
        { width: 1280, height: 720 }
      )
    ).toEqual({
      left: 320,
      top: 566,
      width: 420,
      height: 80
    });

    expect(
      api.calculatePopupPosition(
        { left: 100, right: 140, top: 130, bottom: 150 },
        { width: 200, height: 250 },
        { width: 500, height: 300 }
      )
    ).toEqual({
      left: 100,
      top: 44,
      width: 200,
      height: 250
    });
  });

  it("fits the stable popup size inside viewports smaller than the preference", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);

    expect(
      api.calculatePopupPosition(
        { left: 120, right: 160, top: 100, bottom: 130 },
        { width: 560, height: 420 },
        { width: 320, height: 240 }
      )
    ).toEqual({
      left: 6,
      top: 6,
      width: 308,
      height: 228
    });
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

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      shiftKey: true,
      clientX: 321,
      clientY: 651
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "食べる"));
    await flushPromises();

    expect(popup.style.top).toBe("226px");
    expect(popup.style.width).toBe("560px");
    expect(popup.style.height).toBe("420px");
    expect(popup.style.maxHeight).toBe("none");
    expect(popup.style.minHeight).toBe("0px");
    reader.destroy();
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
            duplicatePolicy: "prevent",
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
      duplicatePolicy: "prevent"
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

describe("Hoshidicts definition blur", () => {
  it("renders every definition pending and fails open below the lookup threshold", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const lookupRecord = deferred<{ success: boolean; lookupCount: number }>();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup: () => lookupRecord.promise,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    const definitions = Array.from<HTMLElement>(
      popup.querySelectorAll(".gsm-hoshidicts-definitions")
    );
    expect(definitions).toHaveLength(14);
    expect(popup.querySelectorAll(".gsm-hoshidicts-entry[hidden]")).toHaveLength(1);
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === "pending"
    )).toBe(true);
    expect(popup.querySelector(".gsm-hoshidicts-expression")).not.toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-expression")?.closest(
      ".gsm-hoshidicts-definitions"
    )).toBeNull();
    expect(popup.querySelector("summary")?.textContent).toBe("JMdict");

    lookupRecord.resolve({ success: true, lookupCount: 4 });
    await flushPromises();
    expect(definitions.every(
      (element) => element.dataset.definitionBlurState === undefined
    )).toBe(true);
    reader.destroy();
  });

  it("reveals at the timed deadline measured from popup display at the threshold", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const lookupRecord = deferred<{ success: boolean; lookupCount: number }>();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup: () => lookupRecord.promise,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const nextRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(nextRequest.requestId, "食べる"));
    await flushPromises();
    const nextDefinitions = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )!;
    expect(nextDefinitions.dataset.definitionBlurState).toBe("blurred");
    reader.updatePreferences({ definitionBlur: { enabled: false } });
    expect(nextDefinitions.dataset.definitionBlurState).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(nextDefinitions.dataset.definitionBlurState).toBeUndefined();
    reader.destroy();
  });

  it("lets the timed deadline win over a slow lookup-count response", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const lookupRecord = deferred<{ success: boolean; lookupCount: number }>();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 1000
      },
      onLookup: () => lookupRecord.promise,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("always reveals on hover while keeping the timed fallback optional", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup: async () => ({ success: true, lookupCount: 8 }),
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    const response = lookupResult(request.requestId, "食べる");
    response.results[0].term.glossaries.push({
      dictionary: "Second dictionary",
      glossary: "consume",
      definitionTags: "",
      termTags: ""
    });
    socket.receive(response);
    await flushPromises();

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
    definitions[1].dispatchEvent(
      new dom.window.Event("pointerover", { bubbles: true })
    );
    definitions[1].dispatchEvent(
      new dom.window.Event("pointerout", { bubbles: true })
    );
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
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const nextRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(nextRequest.requestId, "食べる"));
    await flushPromises();
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
    reader.destroy();
  });

  it("fails open on a lookup-stat error and ignores a stale popup response", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const staleRecord = deferred<{ success: boolean; lookupCount: number }>();
    const currentRecord = deferred<{ success: boolean; lookupCount: number }>();
    const onLookup = vi.fn()
      .mockReturnValueOnce(staleRecord.promise)
      .mockReturnValueOnce(currentRecord.promise);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      onLookup,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const moveToFirst = () => first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));

    moveToFirst();
    await vi.advanceTimersByTimeAsync(20);
    let request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "old"));
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBe("pending");

    reader.hide("replaced");
    moveToFirst();
    await vi.advanceTimersByTimeAsync(20);
    request = JSON.parse(socket.sent.at(-1)!);
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
    request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "error"));
    await flushPromises();
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBeUndefined();

    reader.hide("invalid-response");
    onLookup.mockResolvedValueOnce({ success: true, lookupCount: "five" });
    moveToFirst();
    await vi.advanceTimersByTimeAsync(20);
    request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "invalid"));
    await flushPromises();
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBeUndefined();
    reader.destroy();
  });

});

describe("Hoshidicts dictionary tabs", () => {
  function createLookupHarness(options: Record<string, unknown> = {}) {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    const second = dom.window.document.getElementById("second")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      logger: { debug() {}, warn() {} },
      ...options
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    async function lookup(
      buildResponse: (requestId: string) => ReturnType<typeof lookupResult>,
      target: Element = first
    ) {
      target.dispatchEvent(
        new dom.window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: target === second ? 31 : 11,
          clientY: 11
        })
      );
      await vi.advanceTimersByTimeAsync(20);
      const request = JSON.parse(socket.sent.at(-1)!);
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

  it("expands repeated word and sentence placeholders independently", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    expect(api.expandPopupButtonUrl(
      "https://example.test/?w=%w&w2=%w&s=%s&s2=%s",
      { word: "食べる/食う", sentence: "私は 食べる。" }
    )).toBe(
      "https://example.test/?w=%E9%A3%9F%E3%81%B9%E3%82%8B%2F%E9%A3%9F%E3%81%86" +
      "&w2=%E9%A3%9F%E3%81%B9%E3%82%8B%2F%E9%A3%9F%E3%81%86" +
      "&s=%E7%A7%81%E3%81%AF%20%E9%A3%9F%E3%81%B9%E3%82%8B%E3%80%82" +
      "&s2=%E7%A7%81%E3%81%AF%20%E9%A3%9F%E3%81%B9%E3%82%8B%E3%80%82"
    );
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
    reader.destroy();
  });

  it("normalizes optional dictionary aliases without changing canonical titles", () => {
    const { reader } = createLookupHarness({
      dictionaryPresentation: [
        { title: "Main", favorite: true, displayName: "  Friendly name  " },
        { title: "Backup", favorite: false, displayName: "   " }
      ]
    });

    expect(reader.getPreferences().dictionaryPresentation).toEqual([
      { title: "Main", favorite: true, displayName: "Friendly name" },
      { title: "Backup", favorite: false }
    ]);
    const longAlias = "長".repeat(5000);
    reader.updatePreferences({
      dictionaryPresentation: [
        { title: "Main", favorite: true, displayName: longAlias }
      ]
    });
    expect(
      reader.getPreferences().dictionaryPresentation[0].displayName
    ).toHaveLength(4096);
    expect(reader.getPreferences().dictionaryPresentation[0].title).toBe(
      "Main"
    );
    reader.destroy();
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
    expect(popup.querySelectorAll(".gsm-hoshidicts-glossary-card"))
      .toHaveLength(2);
    harness.reader.destroy();
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
    harness.reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
  });

  it("moves the complete toolbar to the bottom live and reveals its Note form", async () => {
    const { lookup, reader } = createLookupHarness({
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

    expect(popup.dataset.toolbarPosition).toBe("top");
    expect(popup.firstElementChild).toBe(chrome);
    expect(chrome.nextElementSibling).toBe(form);
    expect(form.nextElementSibling).toBe(panel);

    reader.updatePreferences({ popupToolbarPosition: "bottom" });

    expect(reader.getPreferences().popupToolbarPosition).toBe("bottom");
    expect(popup.dataset.toolbarPosition).toBe("bottom");
    expect(popup.firstElementChild).toBe(panel);
    expect(panel.nextElementSibling).toBe(form);
    expect(popup.lastElementChild).toBe(chrome);
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

    reader.updatePreferences({ popupToolbarPosition: "top" });
    expect(popup.dataset.toolbarPosition).toBe("top");
    expect(popup.firstElementChild).toBe(chrome);
    expect(chrome.nextElementSibling).toBe(form);
    expect(form.nextElementSibling).toBe(panel);
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    expect(entries).toHaveLength(8);
    expect(entries.filter((entry) => entry.hidden)).toHaveLength(2);
    expect(popup.querySelector(".gsm-hoshidicts-show-more")?.textContent).toBe(
      "Show 2 more"
    );
    expect(popup.scrollTop).toBe(0);
    expect(second.classList.contains("gsm-hoshidicts-source-match")).toBe(true);

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")
      ?.click();
    expect(entries.some((entry) => entry.hidden)).toBe(false);
    tabs[0]?.click();
    tabs.find((tab) => tab.textContent === "Jitendex")?.click();
    entries = Array.from(
      popup.querySelectorAll<HTMLElement>(".gsm-hoshidicts-entry")
    );
    expect(entries.filter((entry) => entry.hidden)).toHaveLength(2);
    reader.destroy();
  });

  it("mines selected glossaries with only their current dictionary styles", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicatePolicy: "prevent",
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
    const stylesRequest = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_styles");
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
    const mediaRequest = socket.sent
      .map((value) => JSON.parse(value))
      .find((value) => value.type === "hoshidicts_media");
    socket.receive({
      type: "hoshidicts_media_result",
      requestId: mediaRequest.requestId,
      success: true,
      generation: 1,
      dictionary: "Jitendex.org [2026-08-08]",
      path: "img/forms.jpeg",
      mediaType: "image/jpeg",
      byteLength: 5,
      width: 67,
      height: 100,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });
    await flushPromises();

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
      }],
      documentTitle: "GSM Kiku parity",
      popupSelectionText: "食",
      searchQuery: "食べる"
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
    }]);

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
    expect(mine.mock.calls[2][0]).not.toHaveProperty("dictionaryAliases");
    expect(checkMiningNotes.mock.calls.at(-1)?.[0].notes[0].dictionaryStyles)
      .toEqual([{
        dictionary: "JMdict",
        styles: ".jmdict-definition { color: blue; }"
      }]);
    reader.destroy();
  });

  it("clears mining styles on generation changes and ignores stale responses", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicatePolicy: "prevent",
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
    const generation17Request = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_styles");
    socket.receive({
      type: "hoshidicts_styles_result",
      requestId: generation17Request.requestId,
      generation: 17,
      success: true,
      featureDisabled: false,
      staleGeneration: false,
      error: null,
      styles: [{ dictionary: "JMdict", styles: ".old { color: red; }" }]
    });
    await flushPromises();

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
    const generation18Request = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_styles");

    socket.receive({
      type: "hoshidicts_styles_result",
      requestId: generation17Request.requestId,
      generation: 17,
      success: true,
      featureDisabled: false,
      staleGeneration: false,
      error: null,
      styles: [{ dictionary: "JMdict", styles: ".stale { color: orange; }" }]
    });
    await flushPromises();

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
    reader.destroy();
  });

  it("keeps complete dictionary styles in large mining requests", async () => {
    const checkMiningNotes = vi.fn(async (payload) => ({
      success: true,
      duplicatePolicy: "prevent",
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
    const stylesRequest = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_styles");
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
    await flushPromises();

    const duplicatePayload = checkMiningNotes.mock.calls.at(-1)?.[0];
    const styledNotes = duplicatePayload.notes.filter(
      (note) => Object.hasOwn(note, "dictionaryStyles")
    );
    expect(new TextEncoder().encode(JSON.stringify(duplicatePayload)).length)
      .toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(styledNotes).toHaveLength(16);
    expect(duplicatePayload.notes.every(
      (note) => note.dictionaryStyles?.[0]?.styles.length === 256 * 1024
    )).toBe(true);

    popup
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")
      ?.click();
    await flushPromises();
    expect(mine.mock.calls.at(-1)?.[0].dictionaryStyles?.[0]?.styles)
      .toHaveLength(256 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(mine.mock.calls.at(-1)?.[0])).length)
      .toBeLessThanOrEqual(64 * 1024 * 1024);
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
  });
});

describe("Hoshidicts Shift-hover scanner", () => {
  it("records the first canonical result exactly once after rendering", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const onLookup = vi.fn();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      onLookup,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    await flushPromises();

    expect(reader.isVisible()).toBe(true);
    expect(onLookup).toHaveBeenCalledTimes(1);
    expect(onLookup).toHaveBeenCalledWith({
      term: "食べる",
      reading: "たべる"
    });
    expect(reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-definitions"
    )?.dataset.definitionBlurState).toBeUndefined();
    reader.destroy();
  });

  it("keeps zero-value seen and lookup counts visible without blocking the popup", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const lookupStats = deferred<Record<string, unknown>>();
    const onLookup = vi.fn(() => lookupStats.promise);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      onLookup,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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

    const entries = reader.getPopupElement().querySelectorAll(
      ".gsm-hoshidicts-entry"
    );
    expect(reader.isVisible()).toBe(true);
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector(".gsm-hoshidicts-lookup-stats")?.hidden)
      .toBe(true);
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
    reader.destroy();
  });

  it("does not record or mount lookup counts when disabled", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const onLookup = vi.fn();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      showLookupCounts: false,
      onLookup,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "食べる"));
    await flushPromises();

    expect(onLookup).not.toHaveBeenCalled();
    expect(reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-lookup-stats"
    )).toBeNull();
    reader.destroy();
  });

  it("removes counts and suppresses an in-flight response when disabled live", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const lookupStats = deferred<Record<string, unknown>>();
    const onLookup = vi.fn(() => lookupStats.promise);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      onLookup,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "食べる"));
    await flushPromises();
    expect(onLookup).toHaveBeenCalledTimes(1);

    reader.updatePreferences({ showLookupCounts: false });
    expect(reader.getPopupElement().querySelector(
      ".gsm-hoshidicts-lookup-stats"
    )).toBeNull();
    lookupStats.resolve({ success: true, seenCount: 8, lookupCount: 3 });
    await flushPromises();
    expect(reader.getPopupElement().textContent).not.toContain("Seen 8 times");
    reader.destroy();
  });

  it("ignores lookup counts that resolve after a newer popup renders", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    const second = dom.window.document.getElementById("second")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const firstStats = deferred<Record<string, unknown>>();
    const secondStats = deferred<Record<string, unknown>>();
    const onLookup = vi.fn()
      .mockImplementationOnce(() => firstStats.promise)
      .mockImplementationOnce(() => secondStats.promise);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      onLookup,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const firstRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(firstRequest.requestId, "食べる"));
    await flushPromises();

    second.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 31,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const secondRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(secondRequest.requestId, "べる", "new result"));
    await flushPromises();

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
    reader.destroy();
  });

  it("does not record stale, failed, or empty lookup responses", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    const second = dom.window.document.getElementById("second")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const onLookup = vi.fn();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      onLookup,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const firstRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult("stale-request", "古い"));
    socket.receive({
      type: "hoshidicts_lookup_result",
      requestId: firstRequest.requestId,
      success: false,
      error: "failed",
      results: []
    });

    second.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 31,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const secondRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive({
      type: "hoshidicts_lookup_result",
      requestId: secondRequest.requestId,
      success: true,
      error: null,
      results: []
    });
    await flushPromises();

    expect(onLookup).not.toHaveBeenCalled();
    reader.destroy();
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
      vi.useFakeTimers();
      const dom = createDom();
      const api = loadReaderModule(dom.window as unknown as Window);
      const first = dom.window.document.getElementById("first")!;
      setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const reader = api.createHoshidictsReader({
        window: dom.window,
        document: dom.window.document,
        WebSocket: FakeWebSocket,
        lookupMode: "hover",
        onLookup,
        logger
      });
      const socket = FakeWebSocket.instances[0];
      socket.open();
      first.dispatchEvent(
        new dom.window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 11,
          clientY: 11
        })
      );
      await vi.advanceTimersByTimeAsync(20);
      const request = JSON.parse(socket.sent.at(-1)!);

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

  it("looks up without a modifier in hover mode and reports its activation mode", async () => {
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

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('"requiresShift":false')
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] hover.activation-key-required")
    );
    reader.destroy();
  });

  it("requires the hovered token to be entirely Japanese when enabled", async () => {
    const harness = createReaderHarness({
      lookupMode: "hover",
      onlyScanJapaneseText: true
    });
    harness.first.textContent = "食べるabc";
    harness.dom.window.document.getElementById("second")!.textContent = "";

    harness.first.dispatchEvent(new harness.dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(
      harness.socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("hoshidicts_lookup");

    harness.first.dispatchEvent(new harness.dom.window.MouseEvent("mousemove", {
      bubbles: true,
      shiftKey: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(
      harness.socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("hoshidicts_lookup");

    harness.first.textContent = "食べる。";
    harness.dom.window.document.getElementById("second")!.textContent = "next";
    harness.first.dispatchEvent(new harness.dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.parse(harness.socket.sent.at(-1)!).text).toBe("食べる。next");

    harness.reader.updatePreferences({ onlyScanJapaneseText: false });
    harness.first.textContent = "hello";
    harness.dom.window.document.getElementById("second")!.textContent = " world";
    harness.first.dispatchEvent(new harness.dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.parse(harness.socket.sent.at(-1)!).text).toBe("hello worl");
  });

  it("does not let the activation key bypass Japanese-only scanning", async () => {
    const harness = createReaderHarness({
      lookupMode: "shift",
      onlyScanJapaneseText: true
    });
    harness.first.textContent = "hello";
    harness.dom.window.document.getElementById("second")!.textContent = " world";

    harness.first.dispatchEvent(new harness.dom.window.MouseEvent("mousemove", {
      bubbles: true,
      shiftKey: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);

    expect(
      harness.socket.sent.map((message) => JSON.parse(message).type)
    ).not.toContain("hoshidicts_lookup");
  });

  it("starts an unmodified hover lookup when live preferences disable Shift", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "shift",
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.sent).toHaveLength(1);

    reader.updatePreferences({ lookupMode: "hover" });
    await vi.advanceTimersByTimeAsync(20);

    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    reader.destroy();
  });

  it("treats an invalid lookup mode as Shift activation", async () => {
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
      lookupMode: "invalid",
      logger
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(socket.sent).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('"requiresShift":true')
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] hover.activation-key-required")
    );
    reader.destroy();
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

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] hover.activation-key-required")
    );

    const socket = FakeWebSocket.instances[0];
    socket.open();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] socket.open")
    );

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] lookup.sent")
    );

    socket.receive(lookupResult(request.requestId, "食べる"));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[HoshidictsReader] lookup.rendered")
    );
    reader.destroy();
  });

  it("keeps text lookups working with a legacy server that omits generation", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:unused"),
      revokeObjectURL: vi.fn(),
      logger
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
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

    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Shift", bubbles: true })
    );
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 130,
        clientY: 110
      })
    );

    await vi.advanceTimersByTimeAsync(19);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(2);
    const request = JSON.parse(socket.sent[1]);
    expect(request).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });

    socket.receive(lookupResult(request.requestId, "食べる"));
    await flushPromises();

    const popup = reader.getPopupElement();
    expect(reader.isVisible()).toBe(true);
    const chrome = popup.querySelector(".gsm-hoshidicts-result-chrome");
    const primaryHeader = chrome?.querySelector(
      ".gsm-hoshidicts-primary-header"
    );
    const tablist = chrome?.querySelector('[role="tablist"]');
    const noteForm = popup.querySelector(".gsm-hoshidicts-note-form");
    const tabPanel = popup.querySelector(".gsm-hoshidicts-tab-panel");
    expect(popup.firstElementChild === chrome).toBe(true);
    expect(chrome?.firstElementChild === primaryHeader).toBe(true);
    expect(primaryHeader?.nextElementSibling === tablist).toBe(true);
    expect(tablist).toBeNull();
    expect(tabPanel?.getAttribute("role")).toBeNull();
    expect(chrome?.nextElementSibling === noteForm).toBe(true);
    expect(noteForm?.nextElementSibling === tabPanel).toBe(true);
    expect(primaryHeader?.querySelector("ruby")).not.toBeNull();
    expect(primaryHeader?.querySelector("rt")?.textContent).toBe("た");
    expect(primaryHeader?.querySelector(".gsm-hoshidicts-kanji-link")?.textContent)
      .toBe("食");
    expect(
      primaryHeader?.querySelector(".gsm-hoshidicts-expression")
        ?.getAttribute("aria-label")
    ).toBe("食べる, たべる");
    expect(primaryHeader?.querySelector(".gsm-hoshidicts-reading")).toBeNull();
    expect(
      popup.querySelector(".gsm-hoshidicts-tag-deinflection")?.getAttribute("title")
    ).toBe("Past tense");
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
    harness.reader.destroy();
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
    harness.reader.destroy();
  });

  it("opens clicked kanji details and restores the cached term view", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      dictionaryPresentation: [
        {
          title: "KANJIDIC (English)",
          favorite: false,
          displayName: "My kanji dictionary"
        }
      ],
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const termRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(termRequest.requestId, "食べる"));
    await flushPromises();

    const popup = reader.getPopupElement();
    const kanjiLink = popup.querySelector<HTMLButtonElement>(
      ".gsm-hoshidicts-kanji-link"
    );
    expect(kanjiLink?.textContent).toBe("食");
    kanjiLink?.click();
    const directRequest = JSON.parse(socket.sent.at(-1)!);
    expect(directRequest).toMatchObject({ text: "食", mode: "kanji" });

    socket.receive(kanjiResult(directRequest.requestId));
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-result-chrome"))
      .toBe(true);
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
    reader.destroy();
  });

  it("keeps a clicked kanji lookup active when Shift is released inside the popup", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Shift", bubbles: true })
    );
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const termRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(termRequest.requestId, "食べる"));

    const popup = reader.getPopupElement();
    popup.dispatchEvent(new dom.window.Event("pointerenter"));
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = JSON.parse(socket.sent.at(-1)!);
    expect(directRequest).toMatchObject({ text: "食", mode: "kanji" });

    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keyup", { key: "Shift", bubbles: true })
    );
    socket.receive(kanjiResult(directRequest.requestId));

    expect(popup.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent).toBe("食");
    expect(reader.isVisible()).toBe(true);
    reader.destroy();
  });

  it("restores cached term results after direct kanji misses, failures, and timeouts", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupTimeoutMs: 50,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const termRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(termRequest.requestId, "食べる"));
    const popup = reader.getPopupElement();
    const clickKanji = () => {
      popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
      return JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("reconnects with the term query after returning from kanji details", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const termRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(termRequest.requestId, "食べる"));
    const popup = reader.getPopupElement();
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-link")?.click();
    const directRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(kanjiResult(directRequest.requestId));
    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-kanji-back")?.click();
    expect(popup.textContent).toContain("to eat");

    socket.close();
    await vi.advanceTimersByTimeAsync(1);
    const reconnected = FakeWebSocket.instances[1];
    reconnected.open();
    const retry = JSON.parse(reconnected.sent.at(-1)!);

    expect(retry).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    expect(retry.mode).toBeUndefined();
    reader.destroy();
  });

  it("renders a term-first kanji fallback without a Back action", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    expect(request.mode).toBeUndefined();

    socket.receive(kanjiResult(request.requestId));
    const popup = reader.getPopupElement();
    expect(popup.querySelector(".gsm-hoshidicts-kanji-entry")).not.toBeNull();
    expect(popup.querySelector(".gsm-hoshidicts-kanji-back")).toBeNull();
    reader.destroy();
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
    menu.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);

    expect(reader.isVisible()).toBe(true);
    expect(menu.isConnected).toBe(true);
    reader.destroy();
  });

  it("keeps a persistent top Note action and refreshes the lookup after saving", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    let finishSave!: (value: { saved: boolean }) => void;
    const pendingSave = new Promise<{ saved: boolean }>((resolve) => {
      finishSave = resolve;
    });
    const addCustomEntry = vi.fn(async () => await pendingSave);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      onAddCustomEntry: addCustomEntry,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "食べる"));
    await flushPromises();

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
    form.dispatchEvent(new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
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
    const repeatedRequest = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("validates and preserves a Note draft while failures suspend auto-hide", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const addCustomEntry = vi.fn(async () => {
      throw new Error("Custom dictionary is read-only.");
    });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      onAddCustomEntry: addCustomEntry,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    form.dispatchEvent(new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    expect(addCustomEntry).not.toHaveBeenCalled();
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("required");

    definition.value = "\\".repeat(1_025);
    form.dispatchEvent(new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    expect(addCustomEntry).not.toHaveBeenCalled();
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("2 KiB");

    definition.value = "Visible definition";
    term.value = "#hidden";
    form.dispatchEvent(new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    expect(addCustomEntry).not.toHaveBeenCalled();
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("cannot begin with #");

    term.value = "食べる";
    definition.value = "Keep this draft";
    form.dispatchEvent(new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    await flushPromises();
    expect(addCustomEntry).toHaveBeenCalledOnce();
    expect(form.hidden).toBe(false);
    expect(definition.value).toBe("Keep this draft");
    expect(form.querySelector(".gsm-hoshidicts-note-error")?.textContent)
      .toContain("read-only");

    popup.dispatchEvent(new dom.window.Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.isVisible()).toBe(true);
    definition.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "Escape"
    }));
    expect(form.hidden).toBe(true);
    popup.dispatchEvent(new dom.window.Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(300);
    expect(reader.isVisible()).toBe(false);
    reader.destroy();
  });

  it("deduplicates media requests and revokes cached Blob URLs on generation changes", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    const second = dom.window.document.getElementById("second")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const createObjectURL = vi.fn(() => "blob:portrait-1");
    const revokeObjectURL = vi.fn();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const glossary = JSON.stringify({
      type: "structured-content",
      content: [
        { tag: "img", path: "img/c35252.jpg", width: 67, height: 100 },
        { tag: "img", path: "img/c35252.jpg", width: 67, height: 100 },
        { tag: "span", content: "Kurisu Makise" }
      ]
    });

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const lookup = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(lookup.requestId, "食べる", glossary, 7));
    const mediaRequests = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
    expect(mediaRequests).toEqual([
      expect.objectContaining({
        generation: 7,
        dictionary: "JMdict",
        path: "img/c35252.jpg"
      })
    ]);

    socket.receive({
      type: "hoshidicts_media_result",
      requestId: mediaRequests[0].requestId,
      success: true,
      generation: 7,
      dictionary: "JMdict",
      path: "img/c35252.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      width: 67,
      height: 100,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });
    await flushPromises();

    const images = Array.from(
      reader.getPopupElement().querySelectorAll<HTMLImageElement>("img")
    );
    expect(images).toHaveLength(2);
    expect(images.every((image) => image.src === "blob:portrait-1")).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(dom.window.Blob);

    second.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 31,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const secondLookup = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(secondLookup.requestId, "べる", glossary, 8));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:portrait-1");
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(2);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "hoshidicts_media",
      generation: 8
    });

    reader.destroy();
    await flushPromises();
  });

  it("renders the AVIF and SVG media used by current Jitendex", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:jitendex-avif")
      .mockReturnValueOnce("blob:jitendex-svg");
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const lookup = socket.sent
      .map((value) => JSON.parse(value))
      .findLast((value) => value.type === "hoshidicts_lookup");
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
    const requests = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
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
    for (const [request, mediaType, bytes, width, height] of [
      [requests[0], "image/avif", avif, 153, 250],
      [requests[1], "image/svg+xml", svg, 1, 1]
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
        width,
        height,
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
    reader.destroy();
  });

  it("enforces an aggregate decoded-pixel budget for the active popup", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    let blobSequence = 0;
    const createObjectURL = vi.fn(() => `blob:large-${++blobSequence}`);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const lookup = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(
      lookup.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: [0, 1, 2].map((index) => ({
          tag: "img",
          path: `img/large-${index}.jpg`
        }))
      }),
      9
    ));
    const requests = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
    expect(requests).toHaveLength(3);

    for (const request of requests) {
      socket.receive({
        type: "hoshidicts_media_result",
        requestId: request.requestId,
        success: true,
        generation: request.generation,
        dictionary: request.dictionary,
        path: request.path,
        mediaType: "image/jpeg",
        byteLength: 5,
        width: 4096,
        height: 4096,
        dataBase64: "/9j/4AA=",
        featureDisabled: false,
        staleGeneration: false,
        error: null
      });
    }
    await flushPromises();

    const images = Array.from(
      reader.getPopupElement().querySelectorAll<HTMLImageElement>("img")
    );
    expect(images).toHaveLength(3);
    expect(images.filter((image) => image.src.startsWith("blob:"))).toHaveLength(2);
    expect(images.filter((image) => image.hidden)).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    reader.destroy();
  });

  it("stops decoding and pumping requests when the popup pixel budget is full", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const atobSpy = vi.spyOn(dom.window, "atob");
    let blobSequence = 0;
    const createObjectURL = vi.fn(() => `blob:budget-${++blobSequence}`);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const lookup = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(
      lookup.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: Array.from({ length: 8 }, (_, index) => ({
          tag: "img",
          path: `img/budget-${index}.jpg`
        }))
      }),
      10
    ));

    const mediaRequests = () => socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
    const respondWithLargeImage = (
      request: Record<string, unknown>,
      dataBase64 = "/9j/4AA=",
      byteLength = 5
    ) => {
      socket.receive({
        type: "hoshidicts_media_result",
        requestId: request.requestId,
        success: true,
        generation: request.generation,
        dictionary: request.dictionary,
        path: request.path,
        mediaType: "image/jpeg",
        byteLength,
        width: 4096,
        height: 4096,
        dataBase64,
        featureDisabled: false,
        staleGeneration: false,
        error: null
      });
    };

    const initialRequests = mediaRequests();
    expect(initialRequests).toHaveLength(4);
    respondWithLargeImage(initialRequests[0], "AAAA", 3);
    expect(mediaRequests()).toHaveLength(5);

    respondWithLargeImage(initialRequests[1]);
    expect(mediaRequests()).toHaveLength(6);

    respondWithLargeImage(initialRequests[2]);
    const requestsAfterBudgetFilled = mediaRequests();
    expect(requestsAfterBudgetFilled).toHaveLength(6);

    for (const request of requestsAfterBudgetFilled.slice(3)) {
      respondWithLargeImage(request);
    }
    await flushPromises();

    expect(mediaRequests()).toHaveLength(6);
    expect(atobSpy).toHaveBeenCalledTimes(3);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    const images = Array.from(
      reader.getPopupElement().querySelectorAll<HTMLImageElement>("img")
    );
    expect(images).toHaveLength(8);
    expect(images.filter((image) => image.src.startsWith("blob:"))).toHaveLength(2);
    expect(images.filter((image) => image.hidden)).toHaveLength(6);
    reader.destroy();
  });

  it("stops queued media work when the feature is disabled", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:unused"),
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const lookup = JSON.parse(socket.sent.at(-1)!);
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
    const requests = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
    expect(requests).toHaveLength(4);
    socket.receive({
      type: "hoshidicts_media_result",
      requestId: requests[0].requestId,
      success: false,
      generation: requests[0].generation,
      dictionary: requests[0].dictionary,
      path: requests[0].path,
      mediaType: null,
      byteLength: 0,
      width: null,
      height: null,
      dataBase64: null,
      featureDisabled: true,
      staleGeneration: false,
      error: "feature_disabled"
    });
    await flushPromises();

    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(4);
    reader.destroy();
  });

  it("keeps surrounding text when media decoding fails or times out", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      mediaRequestTimeoutMs: 50,
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:late"),
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    const mediaRequests = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
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
      width: 1,
      height: 1,
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
    reader.destroy();
  });

  it("cancels pending media when the popup is dismissed", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:portrait"),
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const glossary = JSON.stringify({
      type: "structured-content",
      content: [{ tag: "img", path: "img/pending.jpg" }]
    });

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const firstLookup = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(firstLookup.requestId, "食べる", glossary, 5));
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media")
    ).toHaveLength(1);

    reader.hide("test-dismissal");
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const secondLookup = JSON.parse(socket.sent.at(-1)!);
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
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      Blob: dom.window.Blob,
      createObjectURL: vi.fn(() => "blob:unused"),
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const lookup = JSON.parse(socket.sent.at(-1)!);
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
      const requests = socket.sent
        .map((value) => JSON.parse(value))
        .filter((value) => value.type === "hoshidicts_media");
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
    reader.destroy();
  });

  it("ignores stale responses so the latest hover request wins", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    const second = dom.window.document.getElementById("second")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const firstRequest = JSON.parse(socket.sent.at(-1)!);

    second.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 31,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const secondRequest = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("starts a lookup when Shift is pressed over a stationary word", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    expect(socket.sent).toHaveLength(1);

    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Shift", bubbles: true })
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    reader.destroy();
  });

  it("uses global pressed and released edges for a custom activation key", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      activationKey: "F8",
      popupHideDelayMs: 300,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.sent).toHaveLength(1);

    expect(reader.setActivationKeyPressed(true)).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    expect(request).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食べる"
    });
    socket.receive(lookupResult(request.requestId, "食べる"));
    await flushPromises();
    expect(reader.isVisible()).toBe(true);

    expect(reader.setActivationKeyPressed(false)).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(reader.isVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(reader.isVisible()).toBe(false);
    reader.destroy();
  });

  it("dismisses naturally after the configured delay and pauses while hovered", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupHideDelayMs: 300,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "食べる"));
    expect(reader.isVisible()).toBe(true);

    dom.window.document.body.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 200,
        clientY: 200
      })
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(reader.isVisible()).toBe(true);

    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    dom.window.document.body.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true })
    );
    expect(reader.isVisible()).toBe(true);

    reader.getPopupElement().dispatchEvent(new dom.window.Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.isVisible()).toBe(true);

    reader.getPopupElement().dispatchEvent(new dom.window.Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(299);
    expect(reader.isVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(reader.isVisible()).toBe(false);
    reader.destroy();
  });

  it("immediately replaces yomu with kiku and never restores the stale popup", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <p class="text-block-container">
          <span id="yomu" class="text-box" data-selectable="true">読む</span><span id="kiku" class="text-box" data-selectable="true">聞く</span>
        </p>
      </body></html>`,
      { pretendToBeVisual: true, url: "file:///overlay/index.html" }
    );
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

    yomu.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const yomuRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(yomuRequest.requestId, "読む", "to read"));
    expect(reader.getPopupElement().textContent).toContain("to read");
    reader.getPopupElement().scrollTop = 120;

    kiku.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 71,
        clientY: 11
      })
    );
    expect(reader.isVisible()).toBe(false);
    expect(reader.getPopupElement().childElementCount).toBe(0);
    expect(yomu.classList.contains("gsm-hoshidicts-source-match")).toBe(false);

    socket.receive(lookupResult(yomuRequest.requestId, "読む", "stale"));
    expect(reader.isVisible()).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    const kikuRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(kikuRequest.requestId, "聞く", "to listen"));

    expect(reader.isVisible()).toBe(true);
    expect(reader.getPopupElement().textContent).toContain("to listen");
    expect(reader.getPopupElement().textContent).not.toContain("stale");
    expect(reader.getPopupElement().scrollTop).toBe(0);
    expect(kiku.classList.contains("gsm-hoshidicts-source-match")).toBe(true);
    reader.destroy();
  });

  it("keeps source highlighting off by default and spans every matched source element", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <p class="text-block-container" data-block-id="0">
          <span id="first" class="text-box" data-selectable="true">前<strong>食</strong></span>
          <span id="second" class="text-box" data-selectable="true">べ</span>
          <span id="third" class="text-box" data-selectable="true">る後</span>
        </p>
      </body></html>`,
      {
        pretendToBeVisual: true,
        url: "file:///overlay/index.html"
      }
    );
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

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 21,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(request.requestId, "食べる"));
    await flushPromises();

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
    reader.destroy();
  });

  it("updates and clamps live reader preferences", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, info() {}, warn() {} }
    });

    expect(reader.getPreferences()).toEqual({
      lookupMode: "shift",
      definitionBlur: {
        enabled: false,
        lookupThreshold: 5,
        revealMode: "timed",
        revealDelayMs: 5000
      },
      activationKey: "Shift",
      sourceHighlightEnabled: false,
      onlyScanJapaneseText: true,
      popupHideDelayMs: 300,
      showLookupCounts: true,
      popupNestingMaxDepth: 10,
      popupWidthPx: 560,
      popupHeightPx: 420,
      popupOpacityPercent: 85,
      popupToolbarPosition: "top",
      theme: "default",
      dictionaryPresentation: [],
      dictionaryTabGroups: [],
      popupButtons: {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: false,
        customLinks: []
      }
    });
    expect(reader.updatePreferences({
      lookupMode: "hover",
      activationKey: "f24",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 9000,
      popupNestingMaxDepth: 2,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "cyberpunk",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 2_000_000,
        revealMode: "hover",
        revealDelayMs: 20
      }
    })).toEqual({
      lookupMode: "hover",
      activationKey: "F24",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 1_000_000,
        revealMode: "hover",
        revealDelayMs: 1000
      },
      sourceHighlightEnabled: true,
      onlyScanJapaneseText: true,
      popupHideDelayMs: 5000,
      showLookupCounts: true,
      popupNestingMaxDepth: 2,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "cyberpunk",
      dictionaryPresentation: [],
      dictionaryTabGroups: [],
      popupButtons: {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: false,
        customLinks: []
      }
    });
    expect(reader.updatePreferences({ popupHideDelayMs: -20 })).toEqual({
      lookupMode: "hover",
      activationKey: "F24",
      definitionBlur: {
        enabled: true,
        lookupThreshold: 1_000_000,
        revealMode: "hover",
        revealDelayMs: 1000
      },
      sourceHighlightEnabled: true,
      onlyScanJapaneseText: true,
      popupHideDelayMs: 0,
      showLookupCounts: true,
      popupNestingMaxDepth: 2,
      popupWidthPx: 720,
      popupHeightPx: 520,
      popupOpacityPercent: 70,
      popupToolbarPosition: "bottom",
      theme: "cyberpunk",
      dictionaryPresentation: [],
      dictionaryTabGroups: [],
      popupButtons: {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: false,
        customLinks: []
      }
    });
    expect(reader.updatePreferences({ popupNestingMaxDepth: -1 }))
      .toEqual({
        lookupMode: "hover",
        activationKey: "F24",
        definitionBlur: {
          enabled: true,
          lookupThreshold: 1_000_000,
          revealMode: "hover",
          revealDelayMs: 1000
        },
        sourceHighlightEnabled: true,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 0,
        showLookupCounts: true,
        popupNestingMaxDepth: 2,
        popupWidthPx: 720,
        popupHeightPx: 520,
        popupOpacityPercent: 70,
        popupToolbarPosition: "bottom",
        theme: "cyberpunk",
        dictionaryPresentation: [],
        dictionaryTabGroups: [],
        popupButtons: {
          addToAnki: true,
          audio: true,
          customDefinition: true,
          viewInAnki: false,
          customLinks: []
        }
      });
    expect(dom.window.document.documentElement.dataset.hoshidictsTheme).toBe(
      "cyberpunk"
    );
    reader.destroy();
  });

  it("applies every supported theme inside the reader runtime", () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, info() {}, warn() {} }
    });

    for (const theme of HOSHIDICTS_THEMES) {
      expect(reader.updatePreferences({ theme }).theme).toBe(theme);
      expect(dom.window.document.documentElement.dataset.hoshidictsTheme).toBe(
        theme
      );
    }
    expect(reader.updatePreferences({ theme: "not-a-theme" }).theme).toBe(
      HOSHIDICTS_THEMES.at(-1)
    );
    reader.destroy();
  });

  it("opens one child from definition text, preserves its parent, and prunes live", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      sourceHighlightEnabled: true,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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

    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
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
    expect(dom.window.document.documentElement.dataset.hoshidictsTheme).toBe(
      "autumn"
    );
    expect(first.classList.contains("gsm-hoshidicts-source-match")).toBe(true);
    expect(definition.classList.contains("gsm-hoshidicts-source-match")).toBe(true);

    dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 200,
      clientY: 200
    }));
    await vi.advanceTimersByTimeAsync(299);
    reader.getPopupElements()[1].dispatchEvent(new dom.window.Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.getPopupElements()).toHaveLength(2);
    reader.getPopupElements()[1].dispatchEvent(new dom.window.Event("pointerleave"));
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reader.getPopupElements()).toHaveLength(2);

    reader.updatePreferences({ popupNestingMaxDepth: 0 });
    expect(reader.getPopupElements()).toHaveLength(1);
    expect(reader.isVisible()).toBe(true);
    expect(rootPopup.textContent).toContain("食事を口に入れる");
    expect(first.classList.contains("gsm-hoshidicts-source-match")).toBe(true);
    expect(definition.classList.contains("gsm-hoshidicts-source-match")).toBe(false);
    reader.destroy();
  });

  it("isolates nested tab IDs and resets descendant media on a parent tab switch", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
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
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("keeps unresolved parent media alive while rendering a child popup", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const createObjectURL = vi.fn(() => "blob:parent-image");
    const revokeObjectURL = vi.fn();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    const parentMediaRequest = socket.sent
      .map((value) => JSON.parse(value))
      .find((value) => value.type === "hoshidicts_media");
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

    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(
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
    await flushPromises();
    expect(parentImage.hidden).toBe(false);

    const childMediaRequest = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media")
      .at(-1)!;
    expect(childMediaRequest.requestId).not.toBe(parentMediaRequest.requestId);

    socket.receive({
      type: "hoshidicts_media_result",
      requestId: parentMediaRequest.requestId,
      success: true,
      generation: 7,
      dictionary: "JMdict",
      path: "img/parent.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      width: 64,
      height: 64,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });
    await flushPromises();
    socket.receive({
      type: "hoshidicts_media_result",
      requestId: childMediaRequest.requestId,
      success: true,
      generation: 7,
      dictionary: "JMdict",
      path: "img/parent.jpg",
      mediaType: "image/jpeg",
      byteLength: 5,
      width: 64,
      height: 64,
      dataBase64: "/9j/4AA=",
      featureDisabled: false,
      staleGeneration: false,
      error: null
    });
    await flushPromises();

    expect(parentImage.src).toBe("blob:parent-image");
    expect(
      reader.getPopupElements()[1].querySelector<HTMLImageElement>("img")?.src
    ).toBe("blob:parent-image");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    reader.destroy();
  });

  it("enforces the decoded-pixel budget across the visible popup chain", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    let blobSequence = 0;
    const createObjectURL = vi.fn(() => `blob:chain-${++blobSequence}`);
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      Blob: dom.window.Blob,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(
      rootRequest.requestId,
      "食べる",
      JSON.stringify({
        type: "structured-content",
        content: [
          { tag: "span", content: "食事" },
          { tag: "img", path: "img/root-1.jpg" },
          { tag: "img", path: "img/root-2.jpg" }
        ]
      }),
      8
    ));
    const rootMediaRequests = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
    expect(rootMediaRequests).toHaveLength(2);
    for (const request of rootMediaRequests) {
      socket.receive({
        type: "hoshidicts_media_result",
        requestId: request.requestId,
        success: true,
        generation: 8,
        dictionary: "JMdict",
        path: request.path,
        mediaType: "image/jpeg",
        byteLength: 5,
        width: 4096,
        height: 4096,
        dataBase64: "/9j/4AA=",
        featureDisabled: false,
        staleGeneration: false,
        error: null
      });
    }
    await flushPromises();

    const definition = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    const caret = dom.window.document.createRange();
    caret.setStart(definition.querySelector("span")!.firstChild!, 0);
    caret.collapse(true);
    Object.defineProperty(dom.window.document, "caretRangeFromPoint", {
      configurable: true,
      value: vi.fn(() => caret.cloneRange())
    });
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(
      childRequest.requestId,
      "食事",
      JSON.stringify({
        type: "structured-content",
        content: [
          { tag: "span", content: "料理" },
          { tag: "img", path: "img/child.jpg" }
        ]
      }),
      8
    ));
    await flushPromises();

    const allMediaRequests = socket.sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "hoshidicts_media");
    expect(allMediaRequests).toHaveLength(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(
      reader.getPopupElements()[1].querySelector<HTMLImageElement>("img")?.hidden
    ).toBe(true);
    reader.destroy();
  });

  it("retains aggregate parent audio ownership while opening and pruning a child", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const audioController = createAudioControllerStub();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupHideDelayMs: 0,
      popupNestingMaxDepth: 1,
      audioController,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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

    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(audioController.beginLookup).toHaveBeenCalledTimes(beginLookupCount);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));

    const childSync = audioController.setRenderedResults.mock.calls.at(-1)!;
    expect(childSync[0]).toHaveLength(2);
    expect(childSync[0][0].button.closest(".gsm-hoshidicts-popup")?.dataset
      .hoshidictsDepth).toBe("1");
    expect(childSync[1]).toEqual({ autoPlay: true });

    rootPopup.querySelector<HTMLElement>(".gsm-hoshidicts-entry-header")!
      .dispatchEvent(new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 40,
        clientY: 40
      }));
    const parentSync = audioController.setRenderedResults.mock.calls.at(-1)!;
    expect(reader.getPopupElements()).toEqual([rootPopup]);
    expect(parentSync[0]).toHaveLength(1);
    expect(parentSync[0][0].button).toBe(parentAudioButton);
    expect(parentSync[1]).toEqual({ autoPlay: false });
    reader.destroy();
  });

  it("uses the hovered definition as child mining sentence context", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      getMiningStatus: async () => ({ available: true }),
      onMine: mine,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));
    await flushPromises();

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
    reader.destroy();
  });

  it("allows exactly the configured number of child popup levels", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 2,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
      definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 40,
        clientY: 40
      }));
      await vi.advanceTimersByTimeAsync(20);
      const request = JSON.parse(socket.sent.at(-1)!);
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
    deepestDefinition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);

    expect(socket.sent).toHaveLength(sentCount);
    expect(reader.getPopupElements()).toHaveLength(3);
    reader.destroy();
  });

  it("repositions child popups when a parent expands more results", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("ignores a stale child response without replacing its parent", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);

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
    reader.destroy();
  });

  it("treats identical definition blocks as distinct child lookup sources", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      sourceHighlightEnabled: true,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
      definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 40,
        clientY: 40
      }));
      await vi.advanceTimersByTimeAsync(20);
    };

    await hoverDefinition(definitions[0]);
    const firstChildRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(firstChildRequest.requestId, "食事", "first child"));
    expect(definitions[0].classList.contains("gsm-hoshidicts-source-match"))
      .toBe(true);

    await hoverDefinition(definitions[1]);
    const secondChildRequest = JSON.parse(socket.sent.at(-1)!);
    expect(secondChildRequest.requestId).not.toBe(firstChildRequest.requestId);
    socket.receive(lookupResult(secondChildRequest.requestId, "食事", "second child"));

    expect(definitions[0].classList.contains("gsm-hoshidicts-source-match"))
      .toBe(false);
    expect(definitions[1].classList.contains("gsm-hoshidicts-source-match"))
      .toBe(true);
    expect(reader.getPopupElements()[1].textContent).toContain("second child");
    reader.destroy();
  });

  it("retries a timed-out child lookup at the same definition", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 1,
      lookupTimeoutMs: 50,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    const hoverDefinition = () => definition.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 40,
        clientY: 40
      })
    );

    hoverDefinition();
    await vi.advanceTimersByTimeAsync(20);
    const timedOutRequest = JSON.parse(socket.sent.at(-1)!);
    await vi.advanceTimersByTimeAsync(50);
    expect(reader.getPopupElements()).toHaveLength(2);
    expect(reader.getPopupElements()[1].textContent).toContain("timed out");

    hoverDefinition();
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.parse(socket.sent.at(-1)!).requestId).toBe(
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
    const retryRequest = JSON.parse(socket.sent.at(-1)!);
    expect(retryRequest.requestId).not.toBe(timedOutRequest.requestId);
    expect(reader.getPopupElements()[0]).toBe(rootPopup);
    reader.destroy();
  });

  it("clears removed child pointer ownership after a live depth reduction", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupHideDelayMs: 0,
      popupNestingMaxDepth: 1,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    const childRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(childRequest.requestId, "食事", "meal"));
    const childPopup = reader.getPopupElements()[1];
    childPopup.dispatchEvent(new dom.window.Event("pointerenter"));

    reader.updatePreferences({ popupNestingMaxDepth: 0 });
    expect(reader.getPopupElements()).toHaveLength(1);
    reader.updatePreferences({ lookupMode: "shift" });
    expect(reader.isVisible()).toBe(false);
    reader.destroy();
  });

  it("does not scan definition text when child popups are disabled", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      popupNestingMaxDepth: 0,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(rootRequest.requestId, "食べる", "食事"));
    const sentCount = socket.sent.length;
    const definition = reader.getPopupElement().querySelector<HTMLElement>(
      ".gsm-hoshidicts-glossary-content"
    )!;
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);

    expect(socket.sent).toHaveLength(sentCount);
    expect(reader.getPopupElements()).toHaveLength(1);
    reader.destroy();
  });

  it("requires Shift for definition lookups when the reader uses Shift-hover", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      popupNestingMaxDepth: 1,
      logger: { debug() {}, info() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      shiftKey: true,
      clientX: 11,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const rootRequest = JSON.parse(socket.sent.at(-1)!);
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
    definition.dispatchEvent(new dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 40,
      clientY: 40
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.sent).toHaveLength(sentCount);

    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "Shift"
    }));
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "hoshidicts_lookup",
      text: "食事"
    });
    reader.destroy();
  });

  it("shows Hoshi-style metadata before tags and six results initially", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      dictionaryPresentation: [
        { title: "Frequency", favorite: false, displayName: "Corpus rank" },
        { title: "Pitch", favorite: false, displayName: "Pitch accent" }
      ],
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    expect(entries).toHaveLength(8);
    expect(entries.filter((entry) => entry.hidden)).toHaveLength(2);
    expect(entries.every((entry) => entry.querySelector("details")?.open)).toBe(true);
    const metadataRows = entries[0].querySelectorAll<HTMLElement>(
      ".gsm-hoshidicts-metadata"
    );
    expect(metadataRows).toHaveLength(2);
    expect(metadataRows[0].querySelector(".gsm-hoshidicts-tag-frequency"))
      .not.toBeNull();
    expect(metadataRows[1].querySelector(".gsm-hoshidicts-tag-pitch"))
      .not.toBeNull();
    expect(
      metadataRows[1].querySelector(".gsm-hoshidicts-pitch-source")?.textContent
    ).toBe("Pitch accent");
    expect(
      metadataRows[0].querySelector(".gsm-hoshidicts-frequency-source")?.textContent
    ).toBe("Corpus rank");
    expect(
      metadataRows[1].querySelector(".gsm-hoshidicts-pitch-body")?.textContent
    ).toBe("ご0 [2] LHL");
    const children = Array.from(entries[0].children);
    expect(children.indexOf(metadataRows[0])).toBeLessThan(
      children.indexOf(entries[0].querySelector(".gsm-hoshidicts-tags")!)
    );
    expect(
      Array.from(
        entries[0].querySelectorAll<HTMLElement>(".gsm-hoshidicts-tag-frequency")
      ).map((tag) =>
        tag.querySelector(".gsm-hoshidicts-frequency-body")?.textContent
      )
    ).toEqual(["1.25 · 1.25 ★"]);
    expect(popup.textContent).toContain("ご0 [2] LHL");

    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")!.click();
    expect(entries.some((entry) => entry.hidden)).toBe(false);
    expect(popup.querySelector(".gsm-hoshidicts-show-more")).toBeNull();
    reader.destroy();
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
    harness.reader.destroy();
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
    harness.reader.destroy();
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
    harness.reader.destroy();
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

  it("shows an actionable timeout and ignores the late response", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const onLookup = vi.fn();
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      lookupTimeoutMs: 50,
      onLookup,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();
    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("bounds lookup time even while the socket is still connecting", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      lookupTimeoutMs: 50,
      logger: { debug() {}, warn() {} }
    });

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeWebSocket.instances[0].sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);

    expect(reader.isVisible()).toBe(true);
    expect(reader.getPopupElement().textContent).toContain("timed out");
    reader.destroy();
  });

  it("keeps the top Note action available after an empty lookup result", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    const second = dom.window.document.getElementById("second")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const states: boolean[] = [];
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      onPopupStateChange: (visible: boolean) => states.push(visible),
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const firstRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(firstRequest.requestId, "食べる"));
    expect(reader.isVisible()).toBe(true);

    second.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 31,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const secondRequest = JSON.parse(socket.sent.at(-1)!);
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
    reader.destroy();
  });

  it("invalidates a pending lookup when the pointer leaves readable text", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    dom.window.document.body.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 100,
        clientY: 100
      })
    );
    socket.receive(lookupResult(request.requestId, "stale"));

    expect(reader.isVisible()).toBe(false);
    expect(reader.getPopupElement().childElementCount).toBe(0);
    reader.destroy();
  });

  it("text cleanup invalidates an in-flight response", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        shiftKey: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(socket.sent.at(-1)!);
    reader.hide("text-cleared");
    socket.receive(lookupResult(request.requestId, "stale"));

    expect(reader.isVisible()).toBe(false);
    expect(reader.getPopupElement().childElementCount).toBe(0);
    reader.destroy();
  });

  it("quietly hides mining controls when Anki mining is unavailable", async () => {
    vi.useFakeTimers();
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const first = dom.window.document.getElementById("first")!;
    const second = dom.window.document.getElementById("second")!;
    setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
    setRect(second, { left: 30, top: 10, right: 90, bottom: 30 });
    const getMiningStatus = vi.fn(async () => ({
      available: false,
      error: "Open Hoshidicts Settings to choose a deck."
    }));
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      getMiningStatus,
      logger: { debug() {}, warn() {} }
    });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    first.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 11,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const firstRequest = JSON.parse(socket.sent.at(-1)!);
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

    second.dispatchEvent(
      new dom.window.MouseEvent("mousemove", {
        bubbles: true,
        clientX: 31,
        clientY: 11
      })
    );
    await vi.advanceTimersByTimeAsync(20);
    const secondRequest = JSON.parse(socket.sent.at(-1)!);
    socket.receive(lookupResult(secondRequest.requestId, "べる"));
    await flushPromises();
    expect(getMiningStatus).toHaveBeenCalledTimes(1);
    reader.destroy();
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
    harness.reader.destroy();
  });

  it("disables an existing note when duplicate prevention is enabled", async () => {
    const checkMiningNotes = vi.fn(async () => ({
      success: true,
      duplicatePolicy: "prevent",
      results: [{
        state: "duplicate",
        canAdd: false,
        duplicate: true
      }, {
        state: "addable",
        canAdd: true,
        duplicate: false
      }]
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

    const buttons = Array.from(harness.reader.getPopupElement()
      .querySelectorAll<HTMLButtonElement>(".gsm-hoshidicts-mine-button"));
    const button = buttons[0]!;
    expect(button.dataset.state).toBe("duplicate");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Note already exists");
    expect(buttons[1]!.dataset.state).toBe("ready");
    expect(checkMiningNotes).toHaveBeenCalledTimes(1);
    expect(checkMiningNotes).toHaveBeenCalledWith({
      notes: [expect.objectContaining({
        sentence: "食べる",
        matchOffset: 0,
        result: expect.objectContaining({
          term: expect.objectContaining({ expression: "食べる" })
        })
      }), expect.objectContaining({
        result: expect.objectContaining({
          term: expect.objectContaining({ expression: "食う" })
        })
      })]
    });
    expect(checkMiningNotes.mock.calls[0][0].notes[0])
      .not.toHaveProperty("audioSelection");
    harness.reader.destroy();
  });

  it("keeps an existing note addable with a distinct duplicate state", async () => {
    const harness = createReaderHarness({
      checkMiningNotes: async () => ({
        success: true,
        duplicatePolicy: "allow",
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
    harness.reader.destroy();
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
    harness.reader.destroy();
  });

  it("uses structured duplicate errors instead of matching English text", async () => {
    const duplicateError = Object.assign(
      new Error("The card was rejected."),
      { code: "duplicate" }
    );
    const checkMiningNotes = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        duplicatePolicy: "prevent",
        results: [{ state: "addable", canAdd: true, duplicate: false }]
      })
      .mockResolvedValueOnce({
        success: true,
        duplicatePolicy: "prevent",
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
    harness.reader.destroy();
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
    harness.reader.destroy();
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
    await renderFirstLookup(harness, { shiftKey: false });

    second.dispatchEvent(new harness.dom.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: 31,
      clientY: 11
    }));
    await vi.advanceTimersByTimeAsync(20);
    const request = JSON.parse(harness.socket.sent.at(-1)!);
    harness.socket.receive(lookupResult(request.requestId, "べる"));
    await flushPromises();

    secondCheck.resolve({
      success: true,
      duplicatePolicy: "prevent",
      results: [{ state: "addable", canAdd: true, duplicate: false }]
    });
    await flushPromises();
    const currentButton = harness.reader.getPopupElement()
      .querySelector<HTMLButtonElement>(".gsm-hoshidicts-mine-button")!;
    expect(currentButton.dataset.state).toBe("ready");

    firstCheck.resolve({
      success: true,
      duplicatePolicy: "prevent",
      results: [{ state: "duplicate", canAdd: false, duplicate: true }]
    });
    await flushPromises();
    expect(currentButton.dataset.state).toBe("ready");
    harness.reader.destroy();
  });

  it("submits one note for a direct double click and rechecks after success", async () => {
    const finishMine = deferred<{ success: boolean; noteId: number }>();
    const checkMiningNotes = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        duplicatePolicy: "prevent",
        results: [{ state: "addable", canAdd: true, duplicate: false }]
      })
      .mockResolvedValueOnce({
        success: true,
        duplicatePolicy: "prevent",
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
    button.dispatchEvent(new harness.dom.window.MouseEvent("click", {
      bubbles: true
    }));
    await flushPromises();
    expect(mine).toHaveBeenCalledTimes(1);

    finishMine.resolve({ success: true, noteId: 123 });
    await flushPromises();
    expect(checkMiningNotes).toHaveBeenCalledTimes(2);
    expect(button.dataset.state).toBe("duplicate");
    expect(harness.reader.getPopupElement()
      .querySelector(".gsm-hoshidicts-mining-feedback")?.textContent)
      .toBe("Added to Anki.");
    harness.reader.destroy();
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
    harness.reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
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
    reader.destroy();
  });
});
