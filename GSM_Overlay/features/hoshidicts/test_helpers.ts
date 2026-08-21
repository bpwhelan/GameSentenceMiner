/*
 * Test helpers for the Hoshidicts overlay feature.
 *
 * Kept beside the feature (and deliberately separate from GSM's own test
 * utilities) so the overlay suites share one harness without coupling to
 * unrelated GSM test infrastructure.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { JSDOM } from "jsdom";
import { vi } from "vitest";

const FEATURE_DIR = "GSM_Overlay/features/hoshidicts";

export function overlayPath(relativePath: string) {
  return path.resolve(process.cwd(), `GSM_Overlay/${relativePath}`);
}

export function readOverlayFile(relativePath: string) {
  return fs.readFileSync(overlayPath(relativePath), "utf8");
}

export function featurePath(relativePath: string) {
  return path.resolve(process.cwd(), `${FEATURE_DIR}/${relativePath}`);
}

export function readFeatureFile(relativePath: string) {
  return fs.readFileSync(featurePath(relativePath), "utf8");
}

function runFeatureModule(
  relativePath: string,
  context: Record<string, any>
): any {
  const module = { exports: {} as any };
  context.module = module;
  context.exports = module.exports;
  vm.runInNewContext(readFeatureFile(relativePath), context, {
    filename: `${FEATURE_DIR}/${relativePath}`
  });
  return module.exports;
}

function createModuleContext(window: Window) {
  return {
    AbortController,
    Blob,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    globalThis: window,
    setTimeout,
    window
  } as Record<string, any>;
}

export function loadAudioModule(window: Window) {
  const context = createModuleContext(window);
  runFeatureModule("constants.js", context);
  return runFeatureModule("audio.js", context);
}

/** Loads the overlay feature scripts into one shared overlay-like global scope. */
export function loadReaderModule(window: Window) {
  const context = createModuleContext(window);
  for (const script of ["constants.js", "preferences.js", "audio.js", "popup.js"]) {
    runFeatureModule(script, context);
  }
  return runFeatureModule("reader.js", context);
}

/**
 * Loads constants + preferences + bootstrap into a fresh fake overlay window so
 * each test gets isolated launch state.
 */
export function loadBootstrapModule(
  env: Record<string, string | undefined> = {}
) {
  const addClass = vi.fn();
  const setProperty = vi.fn();
  const documentElement = {
    classList: { add: addClass, remove: vi.fn() },
    dataset: {} as Record<string, string>,
    style: { setProperty }
  };
  const document = { documentElement };
  const window = { document } as Record<string, any>;
  const context = {
    URL,
    console,
    globalThis: window,
    process: { env },
    window
  } as Record<string, any>;
  for (const script of ["constants.js", "preferences.js", "bootstrap.js"]) {
    runFeatureModule(script, context);
  }
  return {
    addClass,
    api: window.GSMHoshidictsBootstrap,
    document,
    documentElement,
    setProperty,
    window
  };
}

/** Launch preferences the bootstrap derived from one overlay environment. */
export function launchBootstrap(env: Record<string, string | undefined> = {}) {
  const loaded = loadBootstrapModule({ GSM_HOSHIDICTS_ENABLED: "1", ...env });
  return { ...loaded, preferences: loaded.api.getPreferences() };
}

/** Bootstrap wired to a stub reader API, an ipcRenderer and the GSM clients. */
export function configureBootstrapReader(
  options: {
    env?: Record<string, string | undefined>;
    onPopupStateChange?: (visible: boolean) => void;
    settings?: Record<string, unknown>;
  } = {}
) {
  const loaded = launchBootstrap(options.env);
  const reader = {
    destroy: vi.fn(),
    setActivationKeyPressed: vi.fn(),
    updateAudioPreferences: vi.fn(),
    updateLocale: vi.fn(),
    updatePreferences: vi.fn()
  };
  const mining = {
    browse: vi.fn(async () => ({ success: true })),
    check: vi.fn(async () => ({ success: true, results: [] })),
    getStatus: vi.fn(async () => ({ available: true })),
    mine: vi.fn(async () => ({ success: true }))
  };
  const recordLookup = vi.fn();
  const createHoshidictsReader = vi.fn(() => reader);
  const createHoshidictsAudioClient = vi.fn(() => ({ kind: "audio" }));
  const createHoshidictsMiningClient = vi.fn(() => mining);
  const createHoshidictsLookupStatsClient = vi.fn(() => ({ record: recordLookup }));
  loaded.window.GSMHoshidictsReader = {
    createHoshidictsAudioClient,
    createHoshidictsLookupStatsClient,
    createHoshidictsMiningClient,
    createHoshidictsReader,
    resolveGsmApiBaseUrl: vi.fn(() => "http://127.0.0.1:7275")
  };
  const listeners = new Map<string, (...args: any[]) => void>();
  const invoke = vi.fn(async () => ({ saved: true }));
  const ipcOn = vi.fn((channel: string, listener: (...args: any[]) => void) => {
    listeners.set(channel, listener);
  });
  loaded.api.attachDesktopBridge({
    document: loaded.document,
    ipcRenderer: { invoke, on: ipcOn },
    onPopupStateChange: options.onPopupStateChange
  });
  loaded.api.initialize(options.settings ?? { gamepadServerPort: 7276 });
  return {
    ...loaded,
    createHoshidictsAudioClient,
    createHoshidictsLookupStatsClient,
    createHoshidictsMiningClient,
    createHoshidictsReader,
    emit(channel: string, payload: unknown) {
      listeners.get(channel)?.({}, payload);
    },
    invoke,
    ipcOn,
    listeners,
    mining,
    reader,
    readerOptions: createHoshidictsReader.mock.calls[0]?.[0] as Record<string, any>,
    recordLookup
  };
}

export class FakeWebSocket {
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

/** Builds an overlay-like document around one body fragment. */
export function createDomFrom(bodyHtml: string) {
  return new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    pretendToBeVisual: true,
    url: "file:///overlay/index.html"
  });
}

export function parseDocument(html: string) {
  return new JSDOM(html).window.document;
}

export function createDom() {
  return createDomFrom(`
      <p class="text-block-container" data-block-id="0">
        <span id="first" class="text-box" data-selectable="true">食</span>
        <span id="second" class="text-box" data-selectable="true">べる</span>
      </p>`);
}

export function createPopupDom() {
  return new JSDOM(
    "<!doctype html><html><body><section id=popup></section></body></html>",
    { pretendToBeVisual: true, url: "file:///overlay/index.html" }
  );
}

export function setRect(
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

export function lookupResult(
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
              pitches: [{ position: 2, pattern: "LHL", nasal: [1], devoice: [2] }],
              transcriptions: ["tabeɾɯ"]
            }
          ]
        }
      }
    ]
  };
}

export function kanjiResult(requestId: string, character: string = "食") {
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

export function lookupResultWithDictionaries(
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

export function miningButtonsInResultOrder(popup: Element) {
  const primary = popup.querySelector<HTMLButtonElement>(
    ".gsm-hoshidicts-primary-header .gsm-hoshidicts-mine-button"
  );
  const remaining = Array.from(popup.querySelectorAll<HTMLButtonElement>(
    ".gsm-hoshidicts-entry .gsm-hoshidicts-mine-button"
  ));
  return primary ? [primary, ...remaining] : remaining;
}

export async function flushPromises(iterations = 6) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function createAudioControllerStub(
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
      autoPlay: false,
      sources: []
    })),
    getSelection: vi.fn(() => selection),
    setRenderedResults: vi.fn(),
    updatePreferences: vi.fn((profile) => profile)
  };
}

const trackedReaders: Array<{ destroy: () => void }> = [];

export interface ReaderHarnessOptions extends Record<string, any> {
  /** Skip vi.useFakeTimers() for tests that need the real clock. */
  fakeTimers?: boolean;
  /** Leave the fake socket in its CONNECTING state. */
  openSocket?: boolean;
}

/**
 * Creates a reader over a two-box overlay DOM with a fake socket already open.
 * Readers are destroyed by resetReaderTestState() so tests only call destroy()
 * when the post-destroy behaviour itself is under test.
 */
export function createReaderHarness(
  options: ReaderHarnessOptions | ((dom: JSDOM) => ReaderHarnessOptions) = {}
) {
  const pendingDom = createDom();
  const {
    fakeTimers = true,
    openSocket = true,
    ...readerOptions
  } = typeof options === "function" ? options(pendingDom) : options;
  if (fakeTimers) vi.useFakeTimers();
  const dom = pendingDom;
  const document = dom.window.document;
  const api = loadReaderModule(dom.window as unknown as Window);
  const first = document.getElementById("first")!;
  const second = document.getElementById("second")!;
  setRect(first, { left: 10, top: 10, right: 30, bottom: 30 });
  const socketIndex = FakeWebSocket.instances.length;
  const reader = api.createHoshidictsReader({
    window: dom.window,
    document,
    WebSocket: FakeWebSocket,
    logger: { debug() {}, info() {}, warn() {} },
    ...readerOptions
  });
  trackedReaders.push(reader);
  const socket = FakeWebSocket.instances[socketIndex];
  if (socket && openSocket) socket.open();
  return { api, document, dom, first, reader, second, socket };
}

export type ReaderHarness = ReturnType<typeof createReaderHarness>;

/** Dispatches one bubbling event of the requested constructor. */
export function dispatchDomEvent(
  dom: JSDOM,
  target: EventTarget,
  constructorName: "Event" | "KeyboardEvent" | "MouseEvent",
  type: string,
  init: Record<string, unknown> = {}
) {
  const EventConstructor = (dom.window as any)[constructorName];
  target.dispatchEvent(new EventConstructor(type, { bubbles: true, ...init }));
}

export function dispatchMouse(
  dom: JSDOM,
  target: EventTarget,
  type: string,
  init: Record<string, unknown> = {}
) {
  dispatchDomEvent(dom, target, "MouseEvent", type, init);
}

export function dispatchKey(
  dom: JSDOM,
  target: EventTarget,
  type: string,
  init: Record<string, unknown> = {}
) {
  dispatchDomEvent(dom, target, "KeyboardEvent", type, init);
}

export function dispatchPlain(
  dom: JSDOM,
  target: EventTarget,
  type: string,
  init: Record<string, unknown> = {}
) {
  dispatchDomEvent(dom, target, "Event", type, init);
}

/** Hovers a text box at the default probe point and lets the scan debounce elapse. */
export async function hover(
  dom: JSDOM,
  target: EventTarget,
  init: Record<string, unknown> = {},
  advanceMs = 20
) {
  dispatchMouse(dom, target, "mousemove", { clientX: 11, clientY: 11, ...init });
  if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
}

export function lastRequest(socket: FakeWebSocket) {
  return JSON.parse(socket.sent.at(-1)!);
}

export function sentRequests(socket: FakeWebSocket) {
  return socket.sent.map((value) => JSON.parse(value));
}

export function requestsOfType(socket: FakeWebSocket, type: string) {
  return sentRequests(socket).filter((value) => value.type === type);
}

export function firstRequestOfType(socket: FakeWebSocket, type: string) {
  return sentRequests(socket).find((value) => value.type === type);
}

export function lastRequestOfType(socket: FakeWebSocket, type: string) {
  return sentRequests(socket).findLast((value) => value.type === type);
}

/** Delivers a socket response and drains the reader's microtask work. */
export async function respond(socket: FakeWebSocket, response: unknown) {
  socket.receive(response);
  await flushPromises();
}

/** Hovers the first text box and answers with one standard lookup result. */
export async function renderFirstLookup(
  harness: ReaderHarness,
  options: {
    expression?: string;
    shiftKey?: boolean;
    transform?: (response: ReturnType<typeof lookupResult>) => void;
  } = {}
) {
  await hover(harness.dom, harness.first, { shiftKey: options.shiftKey ?? true });
  const request = lastRequest(harness.socket);
  const response = lookupResult(request.requestId, options.expression ?? "食べる");
  options.transform?.(response);
  await respond(harness.socket, response);
  return response;
}

/** afterEach body for the overlay suites. */
export function resetReaderTestState() {
  for (const reader of trackedReaders.splice(0)) {
    try {
      reader.destroy();
    } catch {
      // A test may already have torn the reader's DOM down.
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  FakeWebSocket.instances = [];
}
