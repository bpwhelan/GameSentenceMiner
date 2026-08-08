import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const API_TOKEN = "a".repeat(64);

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
  sourceHighlightEnabled?: string
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
    dataset: {} as Record<string, string>
  };
  const window = {} as Record<string, unknown>;
  vm.runInNewContext(script, {
    document: { documentElement },
    process: {
      env: {
        GSM_HOSHIDICTS_ENABLED: enabled ? "1" : "0",
        GSM_HOSHIDICTS_LOOKUP_MODE: lookupMode,
        GSM_HOSHIDICTS_ACTIVATION_KEY: activationKey,
        GSM_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED: sourceHighlightEnabled
      }
    },
    window
  });
  return { addClass, documentElement, window };
}

function runHoshidictsReaderConfiguration(
  lookupMode: string,
  activationKey: string = "Shift",
  sourceHighlightEnabled: boolean = false
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
  const createHoshidictsMiningClient = vi.fn(() => ({
    getStatus: vi.fn(),
    mine: vi.fn()
  }));
  const normalizeActivationKey = vi.fn((value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : "Shift"
  );
  const invoke = vi.fn(async () => ({ saved: true }));
  const window = {
    gsmHoshidictsActivationKey: activationKey,
    gsmHoshidictsActivationKeyPressed: false,
    gsmHoshidictsLookupMode: lookupMode,
    gsmHoshidictsSourceHighlightEnabled: sourceHighlightEnabled,
    gsmHoshidictsReaderEnabled: true,
    GSMHoshidictsReader: {
      createHoshidictsAudioClient,
      createHoshidictsMiningClient,
      createHoshidictsReader,
      normalizeActivationKey,
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
    ipcRenderer: { invoke, on: ipcOn },
    process: { env: { GSM_BROKER_TOKEN: API_TOKEN } },
    window
  } as Record<string, any>;
  vm.runInNewContext(script, context, {
    filename: "GSM_Overlay/index.html#configureHoshidictsReader"
  });
  context.configureHoshidictsReader({ gamepadServerPort: 7276 });

  return {
    createHoshidictsAudioClient,
    createHoshidictsMiningClient,
    createHoshidictsReader,
    invoke,
    ipcListeners,
    ipcOn,
    normalizeActivationKey,
    reader,
    setActivationKeyPressed,
    updatePreferences,
    window
  };
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

function createAudioControllerStub(
  selection: {
    sourceId: string;
    candidateIndex: number;
    candidateToken: string;
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
  it("uses the GSM Yomitan glass-dark appearance by default", () => {
    const css = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "GSM_Overlay/features/hoshidicts/reader.css"
      ),
      "utf8"
    );
    const popupRule = /\.gsm-hoshidicts-popup\s*\{(?<declarations>[^}]*)\}/.exec(
      css
    )?.groups?.declarations;
    const popupScrollbarRule =
      /\.gsm-hoshidicts-popup::\-webkit-scrollbar\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;
    const glossaryRule =
      /\.gsm-hoshidicts-glossary-card\s*\{(?<declarations>[^}]*)\}/.exec(
        css
      )?.groups?.declarations;

    expect(popupRule).toContain("background: rgba(45, 45, 55, 0.85)");
    expect(popupRule).toContain("backdrop-filter: blur(6px)");
    expect(popupRule).toContain("-webkit-backdrop-filter: blur(6px)");
    expect(popupRule).toContain("border-radius: 12px");
    expect(popupRule).toContain(
      "border: 1px solid rgba(255, 255, 255, 0.2)"
    );
    expect(popupRule).toContain("color: var(--text-color)");
    expect(popupRule).toContain("color-scheme: dark");
    expect(popupRule).toContain("overflow-y: auto");
    expect(popupRule).toContain("scrollbar-width: none");
    expect(popupRule).not.toMatch(/(?:^|;)\s*opacity\s*:/);
    expect(popupScrollbarRule).toContain("display: none");
    expect(glossaryRule).toContain("background: rgba(10, 10, 14, 0.42)");
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
    expect(enabled.addClass).toHaveBeenCalledWith("gsm-hoshidicts-enabled");
    expect(enabled.documentElement.dataset.gsmHoshidictsEnabled).toBe("true");

    const disabled = runOverlayFeatureBootstrap(false);
    expect(disabled.window.gsmHoshidictsReaderEnabled).toBe(false);
    expect(disabled.addClass).not.toHaveBeenCalled();
    expect(disabled.documentElement.dataset.gsmHoshidictsEnabled).toBeUndefined();

    expect(
      runOverlayFeatureBootstrap(true, "hover", "F8", "1")
        .window.gsmHoshidictsSourceHighlightEnabled
    ).toBe(true);
  });

  it("normalizes the lookup mode and wires custom entries through overlay IPC", async () => {
    expect(
      runOverlayFeatureBootstrap(true, "hover").window.gsmHoshidictsLookupMode
    ).toBe("hover");
    expect(
      runOverlayFeatureBootstrap(true, "invalid").window.gsmHoshidictsLookupMode
    ).toBe("shift");

    const configured = runHoshidictsReaderConfiguration("hover", "F8", true);
    expect(configured.createHoshidictsReader).toHaveBeenCalledWith(
      expect.objectContaining({
        lookupMode: "hover",
        activationKey: "F8",
        activationKeyPressed: false,
        audioClient: { kind: "audio" },
        sourceHighlightEnabled: true
      })
    );
    expect(configured.createHoshidictsAudioClient).toHaveBeenCalledWith({
      apiToken: API_TOKEN,
      baseUrl: "http://127.0.0.1:7275"
    });
    expect(configured.createHoshidictsMiningClient).toHaveBeenCalledWith({
      apiToken: API_TOKEN,
      baseUrl: "http://127.0.0.1:7275"
    });
    const options = configured.createHoshidictsReader.mock.calls[0][0];
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
      sourceHighlightEnabled: true
    });
    expect(configured.updatePreferences).toHaveBeenCalledWith({
      lookupMode: "shift",
      activationKey: "F9",
      popupHideDelayMs: 450,
      sourceHighlightEnabled: true
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

  it("renders the reference structured subset while dropping active content and CSS", async () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const parent = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(parent);
    const resolveMedia = vi.fn(async () => "blob:reference-image");
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
            data: { id: "role-badge" },
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
              { tag: "ul", content: [{ tag: "li", content: "Example" }] }
            ]
          },
          { tag: "a", href: "https://example.test", content: "safe link text" },
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
            data: { alt: "Character portrait" }
          },
          { tag: "img", path: "https://example.test/tracker.png" },
          { tag: "img", path: "../outside.png" }
        ]
      }),
      {
        dictionary: "Character Names",
        generation: 7,
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
    expect(parent.querySelector("a")).toBeNull();
    expect(parent.textContent).toContain("safe link text");
    expect(parent.textContent).not.toContain("window.hacked");
    const hostile = Array.from(parent.querySelectorAll<HTMLElement>("div"))
      .find((element) => element.textContent === "still readable")!;
    expect(hostile.getAttribute("style")).toBeNull();
    expect(hostile.style.fontSize).toBe("");
    expect(hostile.style.marginTop).toBe("");
    const image = parent.querySelector<HTMLImageElement>("img")!;
    expect(image.alt).toBe("Character portrait");
    expect(image.style.width).toBe("67px");
    expect(image.style.height).toBe("100px");
    expect(image.src).toBe("blob:reference-image");
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(resolveMedia).toHaveBeenCalledWith({
      dictionary: "Character Names",
      generation: 7,
      path: "img/character.jpg"
    });

    parent.querySelector("details")!.dispatchEvent(new dom.window.Event("toggle"));
    image.dispatchEvent(new dom.window.Event("load"));
    image.dispatchEvent(new dom.window.Event("error"));
    expect(image.hidden).toBe(true);
    expect(parent.textContent).toContain("still readable");
    expect(onLayoutChange).toHaveBeenCalledTimes(3);
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

  it("uses the configured local GSM API without a Yomitan bridge", async () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/status")
          ? { available: true, model: "Mining" }
          : { success: true, noteId: 42, requestBody: init.body }
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
      apiToken: API_TOKEN,
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchMock
    });
    await expect(client.getStatus()).resolves.toMatchObject({
      available: true
    });
    await expect(client.mine({ sentence: "食べる" })).resolves.toMatchObject({
      success: true,
      noteId: 42
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8123/api/hoshidicts/mining/status",
      expect.objectContaining({
        headers: { "Authorization": `Bearer ${API_TOKEN}` },
        signal: expect.any(AbortSignal)
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8123/api/hoshidicts/mine",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sentence: "食べる" })
      })
    );
  });

  it("does not call the mining API without a broker credential", async () => {
    const dom = createDom();
    const api = loadReaderModule(dom.window as unknown as Window);
    const fetchMock = vi.fn();
    const client = api.createHoshidictsMiningClient({
      baseUrl: "http://127.0.0.1:8123",
      fetch: fetchMock
    });

    await expect(client.getStatus()).rejects.toThrow(/authentication/iu);
    expect(fetchMock).not.toHaveBeenCalled();
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
      socket.receive(response);
      return { popup: reader.getPopupElement(), request, response };
    }

    return { dom, first, lookup, reader, second, socket };
  }

  it("shows All and unique glossary dictionaries, excluding metadata-only sources", async () => {
    const { lookup, reader } = createLookupHarness();
    const { popup } = await lookup((requestId) => {
      const response = lookupResultWithDictionaries(requestId, [
        { dictionary: "JMdict", glossary: "to eat" },
        { dictionary: "Jitendex", glossary: "to consume" },
        { dictionary: "JMdict", glossary: "to live on" },
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
      '<img src=x onerror="window.hacked=true">'
    ]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tablist?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(tablist?.textContent).not.toContain("Frequency");
    expect(tablist?.textContent).not.toContain("Pitch");
    expect(tablist?.querySelector("img")).toBeNull();
    expect(tabs[2]?.title).toBe("Jitendex");
    expect(popup.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    const panel = popup.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
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

  it("mines only the selected dictionary glossaries while preserving metadata", async () => {
    const mine = vi.fn(async () => ({ success: true, noteId: 123 }));
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
    await flushPromises();
    expect(mine.mock.calls[0][0].result.term.glossaries).toEqual([
      expect.objectContaining({ dictionary: "JMdict", glossary: "to eat" }),
      expect.objectContaining({
        dictionary: "Jitendex",
        glossary: "to consume"
      })
    ]);

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

    expect(mine).toHaveBeenCalledTimes(2);
    const payload = mine.mock.calls[1][0];
    expect(payload.result.term.glossaries).toEqual([
      expect.objectContaining({
        dictionary: "Jitendex",
        glossary: "to consume"
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

  it("debounces lookup, renders ruby/tags/cards, and reuses popup lifecycle", async () => {
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
    expect(popup.querySelector("ruby")?.textContent).toContain("食");
    expect(
      popup.querySelector(".gsm-hoshidicts-tag-deinflection")?.getAttribute("title")
    ).toBe("Past tense");
    expect(popup.textContent).toContain("JMdict");
    expect(popup.textContent).toContain("to eat");
    expect(popup.querySelector("details")?.open).toBe(true);
    const actions = popup.querySelector(".gsm-hoshidicts-entry-actions");
    expect(actions?.querySelector(".gsm-hoshidicts-audio-button")).not.toBeNull();
    expect(actions?.querySelector(".gsm-hoshidicts-mine-button")).not.toBeNull();
    expect(states).toEqual([true]);

    reader.hide("test");
    expect(states).toEqual([true, false]);
    reader.destroy();
    expect(dom.window.document.documentElement.dataset.gsmHoshidictsEnabled).toBe(
      undefined
    );
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
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-toolbar"))
      .toBe(true);
    expect(popup.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent).toBe("食");
    expect(popup.textContent).toContain("KANJIDIC (English)");
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
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-toolbar"))
      .toBe(true);
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
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-toolbar"))
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
      activationKey: "Shift",
      sourceHighlightEnabled: false,
      popupHideDelayMs: 300
    });
    expect(reader.updatePreferences({
      lookupMode: "hover",
      activationKey: "f24",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 9000
    })).toEqual({
      lookupMode: "hover",
      activationKey: "F24",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 5000
    });
    expect(reader.updatePreferences({ popupHideDelayMs: -20 })).toEqual({
      lookupMode: "hover",
      activationKey: "F24",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 0
    });
    reader.destroy();
  });

  it("shows compact metadata, one open definition per result, and six results initially", async () => {
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
    expect(
      Array.from(
        entries[0].querySelectorAll<HTMLElement>(".gsm-hoshidicts-tag-frequency")
      ).map((tag) => tag.textContent)
    ).toEqual(["Freq 1.25", "Freq ", "Freq 1.25 ★"]);
    expect(popup.textContent).toContain("Pitch 2 LHL");

    popup.querySelector<HTMLButtonElement>(".gsm-hoshidicts-show-more")!.click();
    expect(entries.some((entry) => entry.hidden)).toBe(false);
    expect(popup.querySelector(".gsm-hoshidicts-show-more")).toBeNull();
    reader.destroy();
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
    const reader = api.createHoshidictsReader({
      window: dom.window,
      document: dom.window.document,
      WebSocket: FakeWebSocket,
      lookupMode: "hover",
      lookupTimeoutMs: 50,
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
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-toolbar"))
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
    expect(popup.firstElementChild?.classList.contains("gsm-hoshidicts-toolbar"))
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
      candidateToken: "a".repeat(64)
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

    const renderedResult = audioController.setRenderedResults.mock.calls[0][0][0].result;
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
        candidateToken: "a".repeat(64)
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
    expect(feedback?.textContent).toContain("Optional fields not filled: pitch.");
    expect(feedback?.textContent).toContain(
      "The pronunciation provider did not respond."
    );
    expect(feedback?.textContent).not.toContain("not filled: audio");
    reader.destroy();
  });
});
