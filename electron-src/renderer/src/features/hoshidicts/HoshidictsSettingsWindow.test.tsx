// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultHoshidictsAudioProfile,
  createDefaultHoshidictsFieldOverwriteModes,
  createDefaultHoshidictsPopupButtons,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  DEFAULT_HOSHIDICTS_THEME,
  HOSHIDICTS_CHANNELS,
  HOSHIDICTS_THEMES,
  type HoshidictsActionResult,
  type HoshidictsCustomDictionaryDocument,
  type HoshidictsDesktopSnapshot,
  type HoshidictsMiningOptions,
  type HoshidictsReaderPreferences
} from "../../../../shared/features/hoshidicts";
import { I18nProvider } from "../../i18n";
import {
  HoshidictsSettingsWindow,
  normalizeHoshidictsDesktopState
} from "./HoshidictsSettingsWindow";
import {
  activationKeyFromKeyboardCode,
  getReadiness
} from "./hoshidictsSettingsModel";

const hoshidictsStyles = readFileSync(
  resolve(
    process.cwd(),
    "electron-src/renderer/src/features/hoshidicts/hoshidicts.css"
  ),
  "utf8"
);

const EXPECTED_HOSHIDICTS_THEME_GROUPS = [
  [
    "default",
    "catppuccin-mocha",
    "solarized-dark",
    "dark",
    "synthwave",
    "halloween",
    "forest",
    "aqua",
    "black",
    "luxury",
    "dracula",
    "business",
    "night",
    "coffee",
    "dim",
    "sunset",
    "abyss"
  ],
  [
    "girlypop",
    "solarized-light",
    "light",
    "cupcake",
    "bumblebee",
    "emerald",
    "corporate",
    "retro",
    "cyberpunk",
    "valentine",
    "garden",
    "lofi",
    "pastel",
    "fantasy",
    "wireframe",
    "cmyk",
    "autumn",
    "acid",
    "lemonade",
    "winter",
    "nord",
    "caramellatte",
    "silk"
  ],
  ["high-contrast"]
] as const;

const EXPECTED_HOSHIDICTS_THEMES = EXPECTED_HOSHIDICTS_THEME_GROUPS.flat();

const invokeMock = vi.fn();
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL"
);
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL"
);

const baseState: HoshidictsDesktopSnapshot = {
  revision: 10,
  effectiveEnabled: true,
  dictionaries: [
    {
      id: "jmdict-id",
      title: "JMdict",
      displayName: null,
      enabled: true,
      favorite: false,
      revision: "2026-08-06",
      isUpdatable: true,
      indexUrl: "https://example.test/jmdict.json",
      downloadUrl: "https://example.test/jmdict.zip",
      language: "ja",
      termCount: 123,
      frequencyCount: 12,
      pitchCount: 3,
      kanjiCount: 4,
      frequencyMode: null,
      installedAt: "2026-08-06T10:00:00.000Z",
      updateScheduleOverride: null,
      lastUpdateCheck: "2026-08-06T10:00:00.000Z"
    },
    {
      id: "custom-id",
      title: "Custom",
      displayName: null,
      enabled: false,
      favorite: false,
      revision: "one",
      isUpdatable: false,
      indexUrl: null,
      downloadUrl: null,
      language: "ja",
      termCount: 0,
      frequencyCount: 456,
      pitchCount: 0,
      kanjiCount: 0,
      frequencyMode: "rank-based",
      installedAt: "2026-08-06T11:00:00.000Z",
      updateScheduleOverride: null,
      lastUpdateCheck: null
    }
  ],
  tabGroups: [],
  customDictionaryActive: false,
  recommendedDictionaries: [
    { id: "jmdict", installed: true },
    { id: "jmnedict", installed: false }
  ],
  miningProfile: {
    version: 3,
    enabled: true,
    deck: "Default",
    model: "",
    fields: {
      expression: "",
      reading: "",
      definition: "",
      sentence: "",
      frequency: "",
      pitch: "",
      audio: ""
    },
    disabledFields: [],
    tags: ["hoshidicts"],
    checkForDuplicates: true,
    duplicateScope: "collection",
    duplicateScopeCheckAllModels: false,
    duplicateBehavior: "prevent",
    fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes(),
    fieldTemplates: null
  },
  audioProfile: createDefaultHoshidictsAudioProfile(),
  lookupMode: "shift",
  activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  sourceHighlightEnabled: false,
  onlyScanJapaneseText: true,
  popupHideDelayMs: 300,
  showLookupCounts: true,
  definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
  popupNestingMaxDepth: 10,
  popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  theme: DEFAULT_HOSHIDICTS_THEME,
  popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
  popupButtons: createDefaultHoshidictsPopupButtons(),
  schedule: "weekly",
  lastCheck: "2026-08-06T10:00:00.000Z",
  nextCheck: "2026-08-13T10:00:00.000Z",
  lastError: null,
  busy: false,
  progress: { phase: "idle" },
  overlay: { running: true, restartRequired: false }
};

const miningOptions: HoshidictsMiningOptions = {
  connected: true,
  gsmAnkiEnabled: true,
  decks: ["Default", "Mining"],
  noteTypes: ["Kiku", "Lapis"],
  selectedNoteType: "Kiku",
  fields: [
    "Expression",
    "ExpressionReading",
    "Glossary",
    "Sentence",
    "Frequency",
    "PitchPosition",
    "WordAudio",
    "Front"
  ],
  suggestedFields: {
    expression: "Expression",
    reading: "ExpressionReading",
    definition: "Glossary",
    sentence: "Sentence",
    frequency: "Frequency",
    pitch: "PitchPosition",
    audio: "WordAudio"
  },
  resolvedFields: {
    expression: "Expression",
    reading: "ExpressionReading",
    definition: "Glossary",
    sentence: "Sentence",
    frequency: "Frequency",
    pitch: "PitchPosition",
    audio: "WordAudio"
  },
  suggestedFieldTemplates: {
    Expression: "{expression}",
    ExpressionReading: "{reading}",
    Glossary: "{definition}",
    Sentence: "{sentence}",
    Frequency: "{frequency}",
    PitchPosition: "{pitch-position}",
    WordAudio: "{audio}",
    Front: ""
  },
  resolvedFieldTemplates: {
    Expression: { value: "{expression}", overwriteMode: "coalesce" },
    ExpressionReading: { value: "{reading}", overwriteMode: "coalesce" },
    Glossary: { value: "{definition}", overwriteMode: "coalesce" },
    Sentence: { value: "{sentence}", overwriteMode: "coalesce" },
    Frequency: { value: "{frequency}", overwriteMode: "coalesce" },
    PitchPosition: {
      value: "{pitch-position}",
      overwriteMode: "coalesce"
    },
    WordAudio: { value: "{audio}", overwriteMode: "coalesce" },
    Front: { value: "", overwriteMode: "coalesce" }
  },
  warnings: [],
  error: null
};

const customDocument: HoshidictsCustomDictionaryDocument = {
  text: "螺旋丸, らせんがん, Rotating chakra sphere attack\n",
  revision: "source-one",
  exists: true,
  filePath: "/data/dictionaries/hoshidicts/custom-dictionary.txt"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setInputValue(input: HTMLInputElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input?.dispatchEvent(new Event("input", { bubbles: true }));
  input?.dispatchEvent(new Event("change", { bubbles: true }));
}

function setTextareaValue(input: HTMLTextAreaElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input?.dispatchEvent(new Event("input", { bubbles: true }));
  input?.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSelectValue(input: HTMLSelectElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input?.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("HoshidictsSettingsWindow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let revision: number;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    listeners.clear();
    revision = baseState.revision;
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return baseState;
        if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
          return miningOptions;
        }
        if (channel === HOSHIDICTS_CHANNELS.getCustomDictionary) {
          return customDocument;
        }
        if (channel === HOSHIDICTS_CHANNELS.saveCustomDictionary) {
          const request = args[0] as { text: string };
          return {
            success: true,
            outcome: { code: "customDictionarySaved" },
            document: {
              ...customDocument,
              text: request.text,
              revision: "source-two"
            },
            state: {
              ...baseState,
              revision: ++revision,
              customDictionaryActive: true
            }
          };
        }
        if (channel === HOSHIDICTS_CHANNELS.setReaderPreferences) {
          const preferences = args[0] as HoshidictsReaderPreferences;
          return {
            success: true,
            outcome: { code: "preferencesSaved" },
            state: { ...baseState, ...preferences, revision: ++revision }
          };
        }
        if (channel === HOSHIDICTS_CHANNELS.setMiningProfile) {
          return {
            success: true,
            outcome: { code: "miningProfileSaved" },
            state: {
              ...baseState,
              revision: ++revision,
              miningProfile: args[0]
            }
          };
        }
        if (channel === HOSHIDICTS_CHANNELS.setAudioProfile) {
          return {
            success: true,
            outcome: { code: "audioProfileSaved" },
            state: {
              ...baseState,
              revision: ++revision,
              audioProfile: args[0]
            }
          };
        }
        return {
          success: true,
          outcome: { code: "dictionaryChanged" },
          state: { ...baseState, revision: ++revision }
        };
      }
    );
    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke: invokeMock,
        send: vi.fn(),
        on: (channel: string, callback: (...args: unknown[]) => void) => {
          const callbacks = listeners.get(channel) ?? [];
          callbacks.push(callback);
          listeners.set(channel, callbacks);
          return () => {
            listeners.set(
              channel,
              (listeners.get(channel) ?? []).filter(
                (entry) => entry !== callback
              )
            );
          };
        }
      }
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    if (originalCreateObjectUrl) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (originalRevokeObjectUrl) {
      Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
    vi.unstubAllGlobals();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function render(locale = "en") {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale={locale}>
          <HoshidictsSettingsWindow />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function openView(label: string) {
    const tab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === label
    );
    await act(async () => {
      tab?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function openMining() {
    const miningTab = container.querySelector<HTMLButtonElement>(
      ".hoshidicts-window__tabs button:last-child"
    );
    await act(async () => {
      miningTab?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("owns viewport scrolling even though the shared renderer body is fixed", () => {
    const rootRule =
      /\.hoshidicts-window\s*\{(?<declarations>[^}]*)\}/.exec(
        hoshidictsStyles
      )?.groups?.declarations ?? "";

    expect(rootRule).toMatch(/\bheight:\s*100vh\s*;/);
    expect(rootRule).toMatch(/\boverflow-y:\s*auto\s*;/);
  });

  it("shows dictionary import progress beside the dictionary import controls", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) {
        return {
          ...baseState,
          busy: true,
          progress: { phase: "importing", completed: 1, total: 3 }
        };
      }
      if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
        return miningOptions;
      }
      return {
        success: true,
        state: { ...baseState, revision: ++revision }
      };
    });

    await render();

    const localProgress = container.querySelector(
      ".hoshidicts-dictionary-import-progress"
    );
    expect(localProgress?.textContent).toContain("Importing dictionaries...");
    expect(localProgress?.textContent).toContain("1 / 3");
    expect(localProgress?.closest(".hoshidicts-section--toolbar")).not.toBeNull();
    expect(
      container.querySelector(":scope .hoshidicts-window__content > .hoshidicts-window__progress")
    ).toBeNull();
  });

  it.each([
    ["KeyA", "A"],
    ["Digit1", "1"],
    ["Numpad7", "7"],
    ["ControlRight", "Ctrl"],
    ["NumpadEnter", "Return"],
    ["ArrowUp", "Up"],
    ["Semicolon", ";"],
    ["F24", "F24"],
    ["CapsLock", null],
    ["F25", null]
  ] as const)("maps physical key code %s to %s", (code, expected) => {
    expect(activationKeyFromKeyboardCode(code)).toBe(expected);
  });

  async function flushAutosave() {
    await vi.advanceTimersByTimeAsync(450);
    await Promise.resolve();
    await Promise.resolve();
  }

  function callsFor(channel: string): unknown[][] {
    return invokeMock.mock.calls.filter(
      ([calledChannel]) => calledChannel === channel
    );
  }

  async function openCustom() {
    const customTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Custom"
    );
    await act(async () => {
      customTab?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("shows loading instead of flashing a false disabled state", async () => {
    const pendingState = deferred<HoshidictsDesktopSnapshot>();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) {
        return await pendingState.promise;
      }
      return {};
    });

    await render();
    expect(container.textContent).toContain("Loading Hoshidicts settings");
    expect(container.textContent).not.toContain("Feature off");
    expect(container.textContent).not.toContain("No enabled dictionaries");

    await act(async () => {
      pendingState.resolve(baseState);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("2 installed · 1 enabled");
    expect(container.textContent).toContain("Ready");
  });

  it("derives every readiness state in priority order", () => {
    expect(getReadiness({ ...baseState, effectiveEnabled: false }).kind).toBe(
      "featureOff"
    );
    expect(
      getReadiness({
        ...baseState,
        overlay: { running: false, restartRequired: true }
      }).kind
    ).toBe("overlayStopped");
    expect(
      getReadiness({
        ...baseState,
        overlay: { running: true, restartRequired: true }
      }).kind
    ).toBe("restartRequired");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: baseState.dictionaries.map((dictionary) => ({
          ...dictionary,
          enabled: false
        }))
      }).kind
    ).toBe("noEnabledDictionaries");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            termCount: 0,
            frequencyCount: 500,
            kanjiCount: 0
          }
        ]
      }).kind
    ).toBe("noEnabledLookupDictionary");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            termCount: 0,
            frequencyCount: 0,
            kanjiCount: 1
          }
        ]
      }).kind
    ).toBe("ready");
    expect(
      getReadiness({
        ...baseState,
        dictionaries: [],
        customDictionaryActive: true
      })
    ).toEqual({ kind: "ready", installed: 1, enabled: 1 });
    expect(getReadiness(baseState).kind).toBe("ready");
  });

  it("shows localized term and frequency capabilities and modes", async () => {
    await render();

    expect(container.textContent).toContain("123 terms");
    expect(
      container.textContent?.match(/12 frequency entries/g) ?? []
    ).toHaveLength(1);
    expect(container.textContent).toContain("3 pitch accents");
    expect(container.textContent).toContain("4 kanji");
    expect(container.textContent).toContain("Frequency mode: Automatic");
    expect(
      container.textContent?.match(/456 frequency entries/g) ?? []
    ).toHaveLength(1);
    expect(container.textContent).toContain("Frequency mode: Rank-based");
    expect(
      container.textContent?.match(/Frequency mode:/g) ?? []
    ).toHaveLength(2);
  });

  it("configures favourites only for term dictionaries", async () => {
    await render();

    const favorite = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add JMdict to favourites"]'
    );
    expect(favorite?.getAttribute("aria-pressed")).toBe("false");
    expect(
      container.querySelector('button[aria-label="Add Custom to favourites"]')
    ).toBeNull();

    expect(
      container.querySelectorAll(".hoshidicts-dictionary-favorite-placeholder")
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("Always show");
    expect(container.textContent).not.toContain("Fallback");

    await act(async () => {
      favorite?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionaryPresentation,
      {
        id: "jmdict-id",
        favorite: true
      }
    );
  });

  it("renders a favourited dictionary with a filled star", async () => {
    const state = {
      ...baseState,
      dictionaries: [
        {
          ...baseState.dictionaries[0],
          favorite: true
        },
        baseState.dictionaries[1]
      ]
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) return state;
      return {
        success: true,
        outcome: { code: "dictionaryChanged" },
        state
      };
    });

    await render();

    const favorite = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove JMdict from favourites"]'
    );
    expect(favorite?.getAttribute("aria-pressed")).toBe("true");
    expect(favorite?.querySelector("svg")?.getAttribute("fill")).toBe(
      "currentColor"
    );
  });

  it("shows ordered search positions before favourites and renumbers after reorder", async () => {
    const reorderedState: HoshidictsDesktopSnapshot = {
      ...baseState,
      revision: baseState.revision + 1,
      dictionaries: [baseState.dictionaries[1], baseState.dictionaries[0]]
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) return baseState;
      if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
        return miningOptions;
      }
      if (channel === HOSHIDICTS_CHANNELS.getCustomDictionary) {
        return customDocument;
      }
      if (channel === HOSHIDICTS_CHANNELS.moveDictionary) {
        return {
          success: true,
          outcome: { code: "dictionaryChanged" },
          state: reorderedState
        };
      }
      return {
        success: true,
        outcome: { code: "dictionaryChanged" },
        state: baseState
      };
    });

    await render();

    const rows = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".hoshidicts-dictionary-row")
      );
    const position = (row: HTMLElement) =>
      row.querySelector<HTMLElement>(".hoshidicts-dictionary-search-position");
    expect(position(rows()[0])?.textContent).toBe("1");
    expect(position(rows()[0])?.getAttribute("aria-label")).toBe(
      "Search position 1 of 2 for JMdict"
    );
    expect(position(rows()[0])?.nextElementSibling).toBe(
      rows()[0].querySelector(".hoshidicts-dictionary-favorite")
    );
    expect(position(rows()[1])?.textContent).toBe("2");
    expect(position(rows()[1])?.nextElementSibling).toBe(
      rows()[1].querySelector(".hoshidicts-dictionary-favorite-placeholder")
    );

    await act(async () => {
      rows()[0]
        .querySelector<HTMLElement>(
          '[aria-label="Dictionary actions for JMdict"]'
        )
        ?.click();
      await Promise.resolve();
    });
    const moveDown = Array.from(
      rows()[0].querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent?.trim() === "Move down");
    await act(async () => {
      moveDown?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.moveDictionary, {
      id: "jmdict-id",
      direction: 1
    });
    expect(rows()[0].textContent).toContain("Custom");
    expect(position(rows()[0])?.getAttribute("aria-label")).toBe(
      "Search position 1 of 2 for Custom"
    );
    expect(rows()[1].textContent).toContain("JMdict");
    expect(position(rows()[1])?.getAttribute("aria-label")).toBe(
      "Search position 2 of 2 for JMdict"
    );
  });

  it.each([
    ["ja", "JMdictの検索順: 2件中1番目"],
    ["ukr", "Позиція пошуку для JMdict: 1 з 2"]
  ])("localizes dictionary search positions in %s", async (locale, label) => {
    await render(locale);

    expect(
      container
        .querySelector(".hoshidicts-dictionary-search-position")
        ?.getAttribute("aria-label")
    ).toBe(label);
  });

  it.each([
    {
      name: "enables the first lookup-capable dictionary, including kanji",
      label: "Enable a Dictionary",
      dictionaries: [
        { ...baseState.dictionaries[1], enabled: true },
        {
          ...baseState.dictionaries[0],
          enabled: false,
          termCount: 0,
          kanjiCount: 1
        }
      ],
      invocation: [
        HOSHIDICTS_CHANNELS.setDictionaryEnabled,
        { id: "jmdict-id", enabled: true }
      ]
    },
    {
      name: "offers the default set when only frequency data is installed",
      label: "Install default set",
      dictionaries: [{ ...baseState.dictionaries[1], enabled: true }],
      invocation: [HOSHIDICTS_CHANNELS.installAllRecommended]
    }
  ])(
    "$name from the readiness action",
    async ({ dictionaries, label, invocation }) => {
      const state: HoshidictsDesktopSnapshot = { ...baseState, dictionaries };
      invokeMock.mockImplementation(async (channel: string) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return state;
        if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
          return miningOptions;
        }
        return { success: true, state };
      });

      await render();
      const action = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === label
      );
      expect(action).toBeDefined();

      await act(async () => {
        action?.click();
        await Promise.resolve();
      });

      expect(invokeMock.mock.calls).toContainEqual(invocation);
    }
  );

  it("ignores progress snapshots older than the displayed revision", async () => {
    await render();
    const progressListener = listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0];
    await act(async () => {
      progressListener?.({}, {
        ...baseState,
        revision: baseState.revision - 1,
        effectiveEnabled: false,
        dictionaries: []
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2 installed · 1 enabled");
    expect(container.textContent).not.toContain("Feature off");
  });

  it("keeps dictionary actions independently wired", async () => {
    await render();
    const buttons = Array.from(container.querySelectorAll("button"));
    const buttonContaining = (text: string) =>
      buttons.find((button) => button.textContent?.includes(text));
    const schedule = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-update-schedule"
    );

    await act(async () => {
      buttonContaining("Import Dictionaries")?.click();
      buttonContaining("Import dictionaries from Yomitan")?.click();
      buttonContaining("Import settings from Yomitan")?.click();
      buttonContaining("Check for Updates")?.click();
      buttonContaining("Install default set")?.click();
      buttons.find((button) => button.textContent?.trim() === "Install")?.click();
      container.querySelectorAll<HTMLInputElement>(
        ".hoshidicts-dictionary-row__toggle input"
      )[1]?.click();
      setSelectValue(schedule, "monthly");
      await Promise.resolve();
      await Promise.resolve();
    });

    const clickDictionaryMenuItem = async (label: string) => {
      await act(async () => {
        container
          .querySelector<HTMLElement>(
            '[aria-label="Dictionary actions for JMdict"]'
          )
          ?.click();
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        )
          .find((button) => button.textContent?.trim() === label)
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await clickDictionaryMenuItem("Move down");
    await clickDictionaryMenuItem("Remove");

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.importDictionary
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.importYomitanDictionaries
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.importYomitanSettings
    );
    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.checkUpdates);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.installAllRecommended
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.installRecommended,
      { id: "jitendex" }
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.moveDictionary,
      { id: "jmdict-id", direction: 1 }
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.removeDictionary,
      "jmdict-id"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionaryEnabled,
      { id: "custom-id", enabled: true }
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setSchedule,
      "monthly"
    );

    const sections = Array.from(
      container.querySelectorAll<HTMLElement>(".hoshidicts-section")
    );
    expect(sections.at(-1)?.textContent).toContain("Backups");
  });

  it("keeps complete backup actions together with local busy feedback", async () => {
    const exportJob = deferred<HoshidictsActionResult>();
    invokeMock.mockImplementation(
      async (channel: string): Promise<unknown> => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return baseState;
        if (channel === HOSHIDICTS_CHANNELS.exportBackup) {
          return exportJob.promise;
        }
        if (channel === HOSHIDICTS_CHANNELS.restoreBackup) {
          return {
            success: true,
            outcome: { code: "backupRestored" },
            state: { ...baseState, revision: baseState.revision + 2 }
          } satisfies HoshidictsActionResult;
        }
        throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    );
    await render();

    const sections = Array.from(
      container.querySelectorAll<HTMLElement>(".hoshidicts-section")
    );
    const backups = sections.at(-1);
    const backupButton = (label: string) =>
      Array.from(backups?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .find((button) => button.textContent?.trim() === label);

    await act(async () => {
      backupButton("Export Hoshidicts backup...")?.click();
      await Promise.resolve();
    });

    expect(backups?.textContent).toContain("Exporting Hoshidicts backup...");
    expect(
      Array.from(backups?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .every((button) => button.disabled)
    ).toBe(true);

    await act(async () => {
      exportJob.resolve({
        success: true,
        outcome: { code: "backupExported" },
        state: { ...baseState, revision: baseState.revision + 1 }
      });
      await exportJob.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Hoshidicts backup exported.");
    await act(async () => {
      backupButton("Restore Hoshidicts backup...")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.exportBackup
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.restoreBackup
    );
    expect(container.textContent).toContain("Hoshidicts backup restored.");
  });

  it("shows each Yomitan import beside the backup controls", async () => {
    const dictionariesJob = deferred<HoshidictsActionResult>();
    const settingsJob = deferred<HoshidictsActionResult>();
    invokeMock.mockImplementation(
      async (channel: string): Promise<unknown> => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return baseState;
        if (channel === HOSHIDICTS_CHANNELS.importYomitanDictionaries) {
          return dictionariesJob.promise;
        }
        if (channel === HOSHIDICTS_CHANNELS.importYomitanSettings) {
          return settingsJob.promise;
        }
        throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    );
    await render();

    const sections = Array.from(
      container.querySelectorAll<HTMLElement>(".hoshidicts-section")
    );
    const backups = sections[sections.length - 1];
    const backupButton = (label: string) =>
      Array.from(backups?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .find((button) => button.textContent?.trim() === label);
    const backupStatus = () =>
      backups?.querySelector<HTMLElement>(
        '.hoshidicts-backups__status[role="status"]'
      );

    await act(async () => {
      backupButton("Import dictionaries from Yomitan...")?.click();
      await Promise.resolve();
    });

    expect(backupStatus()?.textContent).toBe(
      "Importing dictionaries from Yomitan…"
    );
    expect(backupStatus()?.getAttribute("aria-live")).toBe("polite");
    expect(backupStatus()?.getAttribute("aria-atomic")).toBe("true");
    expect(
      backupStatus()?.querySelector(".hoshidicts-backups__progress")
    ).toBeNull();
    expect(
      Array.from(backups?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .every((button) => button.disabled)
    ).toBe(true);

    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.yomitanImportProgress)?.[0]?.({}, {
        phase: "reading",
        completedBytes: 0,
        totalBytes: 400,
        estimatedSecondsRemaining: null
      });
      await Promise.resolve();
    });
    expect(backupStatus()?.textContent).toContain("0%");
    expect(
      backupStatus()?.querySelector<HTMLProgressElement>(
        ".hoshidicts-backups__reading-meter"
      )?.value
    ).toBe(0);

    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.yomitanImportProgress)?.[0]?.({}, {
        phase: "reading",
        completedBytes: 100,
        totalBytes: 400,
        estimatedSecondsRemaining: 18
      });
      await Promise.resolve();
    });
    expect(backupStatus()?.textContent).toContain(
      "Reading Yomitan backup…"
    );
    expect(backupStatus()?.textContent).toContain("25% · ~18s left");
    const readingMeter = backupStatus()?.querySelector<HTMLProgressElement>(
      ".hoshidicts-backups__reading-meter"
    );
    expect(readingMeter?.value).toBe(25);
    expect(readingMeter?.max).toBe(100);

    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.yomitanImportProgress)?.[0]?.({}, {
        phase: "preparing",
        current: 1,
        total: 3,
        title: "Jitendex"
      });
      await Promise.resolve();
    });
    expect(backupStatus()?.textContent).toContain(
      "Preparing dictionary 1 of 3: Jitendex"
    );
    expect(
      backupStatus()?.querySelector(".hoshidicts-backups__reading-meter")
    ).toBeNull();

    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.yomitanImportProgress)?.[0]?.({}, {
        phase: "importing",
        current: 2,
        total: 3,
        title: "JMdict"
      });
      await Promise.resolve();
    });
    expect(backupStatus()?.textContent).toContain(
      "Importing dictionaries from Yomitan…"
    );
    expect(backupStatus()?.textContent).toContain(
      "Importing dictionary 2 of 3: JMdict"
    );
    expect(
      container.querySelector(".hoshidicts-dictionary-import-progress")
    ).toBeNull();

    await act(async () => {
      dictionariesJob.resolve({
        success: true,
        outcome: { code: "yomitanDictionariesImported" },
        yomitanReport: {
          imported: 2,
          replaced: 0,
          failed: 0,
          settings: [],
          warnings: []
        },
        state: { ...baseState, revision: baseState.revision + 2 }
      });
      await dictionariesJob.promise;
      await Promise.resolve();
    });
    expect(backupStatus()).toBeNull();

    await act(async () => {
      backupButton("Import settings from Yomitan...")?.click();
      await Promise.resolve();
    });
    expect(backupStatus()?.textContent).toBe(
      "Importing settings from Yomitan…"
    );
    expect(
      backupStatus()?.querySelector(".hoshidicts-backups__progress")
    ).toBeNull();

    await act(async () => {
      settingsJob.resolve({
        success: true,
        outcome: { code: "yomitanSettingsImported" },
        yomitanReport: {
          imported: 0,
          replaced: 0,
          failed: 0,
          settings: [],
          warnings: []
        },
        state: { ...baseState, revision: baseState.revision + 3 }
      });
      await settingsJob.promise;
      await Promise.resolve();
    });
    expect(backupStatus()).toBeNull();
  });

  it("collapses recommended dictionaries when dictionaries are installed", async () => {
    await render();
    const recommendedList = container.querySelector<HTMLElement>(
      "#hoshidicts-recommended-list"
    );
    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand recommended dictionaries"]'
    );

    expect(recommendedList?.hidden).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    expect(
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Install default set")
      )
    ).toBeTruthy();

    await act(async () => {
      expand?.click();
      await Promise.resolve();
    });
    expect(recommendedList?.hidden).toBe(false);

    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0]?.({}, {
        ...baseState,
        revision: baseState.revision + 1
      });
      await Promise.resolve();
    });
    expect(recommendedList?.hidden).toBe(false);
  });

  it("expands recommended dictionaries when none are installed", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) {
        return { ...baseState, dictionaries: [] };
      }
      if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
        return miningOptions;
      }
      return { success: true, state: { ...baseState, dictionaries: [] } };
    });

    await render();
    const recommendedList = container.querySelector<HTMLElement>(
      "#hoshidicts-recommended-list"
    );
    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse recommended dictionaries"]'
    );

    expect(recommendedList?.hidden).toBe(false);
    expect(collapse?.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses recommended dictionaries when the custom dictionary is active", async () => {
    const state = {
      ...baseState,
      dictionaries: [],
      customDictionaryActive: true
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) return state;
      if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
        return miningOptions;
      }
      return { success: true, state };
    });

    await render();
    const recommendedList = container.querySelector<HTMLElement>(
      "#hoshidicts-recommended-list"
    );
    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand recommended dictionaries"]'
    );

    expect(recommendedList?.hidden).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      expand?.click();
      await Promise.resolve();
    });
    expect(recommendedList?.hidden).toBe(false);
  });

  it("keeps tab groups collapsed by default and wires group management actions", async () => {
    const groupState: HoshidictsDesktopSnapshot = {
      ...baseState,
      tabGroups: [
        {
          id: "grammar",
          name: "Grammar",
          dictionaryIds: ["jmdict-id"]
        },
        { id: "games", name: "Games", dictionaryIds: [] }
      ]
    };
    invokeMock.mockImplementation(
      async (channel: string): Promise<unknown> => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return groupState;
        if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
          return miningOptions;
        }
        return {
          success: true,
          outcome: { code: "dictionaryChanged" },
          state: { ...groupState, revision: ++revision }
        };
      }
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand tab groups (2)"]'
    );
    const panel = container.querySelector<HTMLElement>(
      "#hoshidicts-tab-groups-panel"
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hidden).toBe(true);

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    expect(panel?.hidden).toBe(false);
    expect(panel?.textContent).toContain("Grammar");
    expect(panel?.textContent).toContain("Dictionaries: 1");

    const createName = panel?.querySelector<HTMLInputElement>(
      'input[aria-label="Tab group name"]'
    );
    setInputValue(createName ?? null, "Study");
    await act(async () => {
      createName?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.createTabGroup,
      { name: "Study" }
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Move Grammar down"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.moveTabGroup, {
      groupId: "grammar",
      direction: 1
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Rename Grammar"]')
        ?.click();
      await Promise.resolve();
    });
    const renameName = container.querySelector<HTMLInputElement>(
      'input[aria-label="New name for Grammar"]'
    );
    setInputValue(renameName, "Language");
    await act(async () => {
      renameName?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.renameTabGroup,
      { groupId: "grammar", name: "Language" }
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Delete Games"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledWith(
      "Delete the Games tab group? Its dictionaries will not be deleted."
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.deleteTabGroup,
      { groupId: "games" }
    );
    confirm.mockRestore();
  });

  it("keeps a rejected tab group rename open with the entered name", async () => {
    const groupState: HoshidictsDesktopSnapshot = {
      ...baseState,
      tabGroups: [
        {
          id: "grammar",
          name: "Grammar",
          dictionaryIds: ["jmdict-id"]
        }
      ]
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) return groupState;
      if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
        return miningOptions;
      }
      if (channel === HOSHIDICTS_CHANNELS.renameTabGroup) {
        return {
          success: false,
          error: "That tab group name is already in use.",
          state: groupState
        };
      }
      return {
        success: true,
        outcome: { code: "dictionaryChanged" },
        state: groupState
      };
    });

    await render();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Expand tab groups (1)"]'
        )
        ?.click();
      await Promise.resolve();
      container
        .querySelector<HTMLButtonElement>('[aria-label="Rename Grammar"]')
        ?.click();
      await Promise.resolve();
    });
    const renameName = container.querySelector<HTMLInputElement>(
      'input[aria-label="New name for Grammar"]'
    );
    setInputValue(renameName, "Games");
    await act(async () => {
      renameName?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="New name for Grammar"]'
      )?.value
    ).toBe("Games");
    expect(container.textContent).toContain(
      "That tab group name is already in use."
    );
  });

  it("assigns only term dictionaries to one or more tab groups from the action menu", async () => {
    const groupState: HoshidictsDesktopSnapshot = {
      ...baseState,
      tabGroups: [
        {
          id: "grammar",
          name: "Grammar",
          dictionaryIds: ["jmdict-id"]
        },
        { id: "games", name: "Games", dictionaryIds: [] }
      ]
    };
    invokeMock.mockImplementation(
      async (channel: string): Promise<unknown> => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return groupState;
        if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
          return miningOptions;
        }
        return {
          success: true,
          outcome: { code: "dictionaryChanged" },
          state: { ...groupState, revision: ++revision }
        };
      }
    );

    await render();
    const summary = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for JMdict"]'
    );
    await act(async () => {
      summary?.click();
      await Promise.resolve();
    });
    const menu = summary?.closest<HTMLDetailsElement>("details");
    expect(menu?.open).toBe(true);

    await act(async () => {
      container.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
    expect(menu?.open).toBe(false);

    await act(async () => {
      summary?.click();
      await Promise.resolve();
    });
    let addToGroup = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent?.includes("Add to Tab Group"));
    await act(async () => {
      addToGroup?.click();
      await Promise.resolve();
    });

    const initialGrammar = container.querySelector<HTMLInputElement>(
      'input[aria-label="Remove JMdict from Grammar"]'
    );
    expect(document.activeElement).toBe(initialGrammar);
    const picker = container.querySelector<HTMLElement>(
      '.hoshidicts-dictionary-tab-groups[role="group"]'
    );
    const pickerHeading = document.getElementById(
      picker?.getAttribute("aria-labelledby") ?? ""
    );
    expect(pickerHeading?.textContent).toBe("Add to tab group");
    expect(
      Array.from(picker?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .some((button) => button.textContent?.trim() === "Back")
    ).toBe(false);

    await act(async () => {
      container.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
    expect(menu?.open).toBe(false);
    expect(
      container.querySelector(".hoshidicts-dictionary-tab-groups")
    ).toBeNull();

    await act(async () => {
      summary?.click();
      await Promise.resolve();
    });
    addToGroup = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((button) => button.textContent?.includes("Add to Tab Group"));
    await act(async () => {
      addToGroup?.click();
      await Promise.resolve();
    });
    const grammar = container.querySelector<HTMLInputElement>(
      'input[aria-label="Remove JMdict from Grammar"]'
    );
    let games = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add JMdict to Games"]'
    );
    expect(grammar?.checked).toBe(true);
    expect(games?.checked).toBe(false);

    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0]?.({}, {
        ...groupState,
        revision: ++revision,
        busy: true,
        progress: { phase: "saving", scope: "dictionary" }
      });
      await Promise.resolve();
    });
    games = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add JMdict to Games"]'
    );
    expect(games?.disabled).toBe(true);
    expect(games?.closest("label")?.classList.contains("is-disabled")).toBe(
      true
    );

    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0]?.({}, {
        ...groupState,
        revision: ++revision,
        busy: false,
        progress: { phase: "idle", scope: "dictionary" }
      });
      await Promise.resolve();
    });
    games = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add JMdict to Games"]'
    );
    await act(async () => {
      games?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setTabGroupMembership,
      { groupId: "games", dictionaryId: "jmdict-id", member: true }
    );

    const newGroupName = container.querySelector<HTMLInputElement>(
      'input[aria-label="New tab group name"]'
    );
    setInputValue(newGroupName, "Vocabulary");
    await act(async () => {
      newGroupName?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.createTabGroup,
      { name: "Vocabulary", dictionaryId: "jmdict-id" }
    );

    await act(async () => {
      summary?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      summary?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector(".hoshidicts-dictionary-tab-groups")
    ).toBeNull();

    const frequencyRow = Array.from(
      container.querySelectorAll<HTMLElement>(".hoshidicts-dictionary-row")
    ).find((row) => row.textContent?.includes("Custom"));
    await act(async () => {
      frequencyRow?.querySelector<HTMLElement>("summary")?.click();
      await Promise.resolve();
    });
    expect(
      frequencyRow?.querySelector(".hoshidicts-dictionary-menu__items")
        ?.textContent
    ).not.toContain("Add to Tab Group");
  });

  it.each([
    [
      "ja",
      "タブグループを展開（1件）",
      "JMdictの辞書操作",
      "タブグループに追加…"
    ],
    [
      "ukr",
      "Розгорнути групи вкладок (1)",
      "Дії зі словником JMdict",
      "Додати до групи вкладок…"
    ]
  ])(
    "localizes tab group controls in %s",
    async (locale, expandLabel, menuLabel, actionLabel) => {
      invokeMock.mockImplementation(async (channel: string) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) {
          return {
            ...baseState,
            tabGroups: [
              { id: "grammar", name: "Grammar", dictionaryIds: [] }
            ]
          };
        }
        if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
          return miningOptions;
        }
        return { success: true, state: { ...baseState, revision: ++revision } };
      });

      await render(locale);
      expect(
        container.querySelector(`[aria-label="${expandLabel}"]`)
      ).not.toBeNull();
      await act(async () => {
        container
          .querySelector<HTMLElement>(`[aria-label="${menuLabel}"]`)
          ?.click();
        await Promise.resolve();
      });
      expect(
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        ).some((button) => button.textContent?.trim() === actionLabel)
      ).toBe(true);
    }
  );

  it("moves a dictionary directly to a selected search position", async () => {
    await render();
    const menu = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for JMdict"]'
    );

    await act(async () => {
      menu?.click();
      await Promise.resolve();
    });
    const moveToPosition = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Move dict to position")
    );
    await act(async () => {
      moveToPosition?.click();
      await Promise.resolve();
    });

    const position = container.querySelector<HTMLInputElement>(
      '.hoshidicts-dictionary-position input[type="number"]'
    );
    setInputValue(position, "2");
    await act(async () => {
      position?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "hoshidicts.moveDictionaryToPosition",
      { id: "jmdict-id", position: 2 }
    );
  });

  it("configures an updatable dictionary schedule from its action menu", async () => {
    await render();

    const globalSchedule = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-update-schedule"
    );
    expect(
      Array.from(globalSchedule?.options ?? []).map((option) => option.text)
    ).toContain("Every hour");

    const openScheduleEditor = async () => {
      await act(async () => {
        container
          .querySelector<HTMLElement>(
            '[aria-label="Dictionary actions for JMdict"]'
          )
          ?.click();
        await Promise.resolve();
      });
      const updateSchedule = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      ).find((button) => button.textContent?.includes("Update schedule"));
      await act(async () => {
        updateSchedule?.click();
        await Promise.resolve();
      });
      return container.querySelector<HTMLFormElement>(
        ".hoshidicts-dictionary-schedule"
      );
    };

    let form = await openScheduleEditor();
    expect(form?.getAttribute("aria-label")).toBe(
      "Update schedule for JMdict"
    );
    let select = form?.querySelector<HTMLSelectElement>("select") ?? null;
    expect(select?.value).toBe("global");
    expect(Array.from(select?.options ?? []).map((option) => option.text)).toEqual(
      ["Use global (Weekly)", "Off", "Every hour", "Daily", "Weekly", "Monthly"]
    );
    expect(
      Array.from(form?.querySelectorAll("button") ?? []).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["Save", "Cancel"]);
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionarySchedule,
      { id: "jmdict-id", schedule: null }
    );

    form = await openScheduleEditor();
    select = form?.querySelector<HTMLSelectElement>("select") ?? null;
    setSelectValue(select, "hourly");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionarySchedule,
      { id: "jmdict-id", schedule: "hourly" }
    );

    const scheduleCalls = () =>
      invokeMock.mock.calls.filter(
        ([channel]) => channel === HOSHIDICTS_CHANNELS.setDictionarySchedule
      );
    expect(scheduleCalls()).toHaveLength(2);
    form = await openScheduleEditor();
    const cancel = Array.from(form?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Cancel"
    );
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector(".hoshidicts-dictionary-schedule")
    ).toBeNull();
    expect(scheduleCalls()).toHaveLength(2);

    const manualRow = Array.from(
      container.querySelectorAll<HTMLElement>(".hoshidicts-dictionary-row")
    ).find((row) => row.textContent?.includes("Custom"));
    await act(async () => {
      manualRow?.querySelector<HTMLElement>("summary")?.click();
      await Promise.resolve();
    });
    expect(manualRow?.textContent).not.toContain("Update schedule");
  });

  it.each([
    ["ja", "アップデート間隔を変更...", "毎時"],
    ["ukr", "Змінити розклад оновлень...", "Щогодини"]
  ])(
    "localizes dictionary schedules in %s",
    async (locale, actionLabel, hourlyLabel) => {
      await render(locale);
      await act(async () => {
        container
          .querySelector<HTMLElement>(
            `[aria-label="${locale === "ja" ? "JMdictの辞書操作" : "Дії зі словником JMdict"}"]`
          )
          ?.click();
        await Promise.resolve();
      });
      const action = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      ).find((button) => button.textContent?.includes(actionLabel));
      expect(action).toBeDefined();
      await act(async () => {
        action?.click();
        await Promise.resolve();
      });
      expect(
        Array.from(
          container.querySelectorAll<HTMLSelectElement>(
            ".hoshidicts-dictionary-schedule select"
          )[0]?.options ?? []
        ).map((option) => option.text)
      ).toContain(hourlyLabel);
    }
  );

  it("shows a dictionary alias and saves a renamed display name", async () => {
    await render();
    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0]?.({}, {
        ...baseState,
        revision: baseState.revision + 1,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            displayName: "Core Japanese"
          },
          baseState.dictionaries[1]
        ]
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Core Japanese");
    expect(container.textContent).toContain("Original name: JMdict");
    expect(
      container.querySelector('strong[title="Original name: JMdict"]')
        ?.textContent
    ).toBe("Core Japanese");

    const menu = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for Core Japanese"]'
    );
    await act(async () => {
      menu?.click();
      await Promise.resolve();
    });
    const rename = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Rename dictionary")
    );
    await act(async () => {
      rename?.click();
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>(
      '.hoshidicts-dictionary-rename input[type="text"]'
    );
    const renameForm = input?.closest("form");
    expect(input?.value).toBe("Core Japanese");
    expect(input?.getAttribute("aria-describedby")).toBe(
      "hoshidicts-dictionary-rename-original-jmdict-id"
    );
    expect(renameForm?.getAttribute("aria-label")).toBe(
      "Rename Core Japanese"
    );
    expect(
      Array.from(renameForm?.querySelectorAll("button") ?? []).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["Save", "Cancel", "Reset original name"]);
    setInputValue(input, "Friendly Lexicon");
    await act(async () => {
      input?.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.renameDictionary,
      { id: "jmdict-id", displayName: "Friendly Lexicon" }
    );
  });

  it("resets a dictionary alias to its original name", async () => {
    await render();
    await act(async () => {
      listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0]?.({}, {
        ...baseState,
        revision: baseState.revision + 1,
        dictionaries: [
          {
            ...baseState.dictionaries[0],
            displayName: "Core Japanese"
          },
          baseState.dictionaries[1]
        ]
      });
      await Promise.resolve();
    });

    const menu = container.querySelector<HTMLElement>(
      '[aria-label="Dictionary actions for Core Japanese"]'
    );
    await act(async () => {
      menu?.click();
      await Promise.resolve();
    });
    const rename = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Rename dictionary")
    );
    await act(async () => {
      rename?.click();
      await Promise.resolve();
    });
    const reset = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reset original name")
    );
    await act(async () => {
      reset?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.renameDictionary,
      { id: "jmdict-id", displayName: null }
    );
  });

  it("auto-saves reader preferences atomically", async () => {
    vi.useFakeTimers();
    await render();
    const hover = container.querySelector<HTMLInputElement>(
      "#hoshidicts-reader-mode-hover"
    );
    const delay = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-hide-delay"
    );
    const maxDepth = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-nesting-max-depth"
    );
    const showLookupCounts = container.querySelector<HTMLInputElement>(
      "#hoshidicts-show-lookup-counts"
    );
    const onlyScanJapaneseText = container.querySelector<HTMLInputElement>(
      "#hoshidicts-only-scan-japanese-text"
    );

    expect(showLookupCounts?.checked).toBe(true);
    expect(onlyScanJapaneseText?.checked).toBe(true);
    expect(container.textContent).toContain(
      "Only scan words written entirely in Japanese"
    );
    expect(container.textContent).toContain("Show seen and lookup counts");

    await act(async () => {
      hover?.click();
      setInputValue(delay, "850");
      setInputValue(maxDepth, "12");
      showLookupCounts?.click();
      onlyScanJapaneseText?.click();
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "hover",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: false,
        onlyScanJapaneseText: false,
        popupHideDelayMs: 850,
        showLookupCounts: false,
        popupNestingMaxDepth: 12,
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: DEFAULT_HOSHIDICTS_THEME,
        popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        popupButtons: createDefaultHoshidictsPopupButtons(),
        definitionBlur: DEFAULT_HOSHIDICTS_DEFINITION_BLUR
      }
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setLookupMode,
      expect.anything()
    );
    expect(container.textContent).toContain("Saved");
  });

  it("keeps lookup counts with the reader settings", async () => {
    await render();
    const countsToggle = container.querySelector<HTMLInputElement>(
      "#hoshidicts-show-lookup-counts"
    );
    const hideDelay = container.querySelector(
      ".hoshidicts-reader-delay"
    );

    expect(countsToggle).not.toBeNull();
    expect(hideDelay).not.toBeNull();
    expect(countsToggle?.closest(".hoshidicts-section")).toBe(
      hideDelay?.closest(".hoshidicts-section")
    );
  });

  it("offers every GSM popup theme plus Girlypop in stable groups", async () => {
    await render();
    const theme = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-popup-theme"
    );
    const groups = Array.from(theme?.querySelectorAll("optgroup") ?? []);

    expect(HOSHIDICTS_THEMES).toEqual(EXPECTED_HOSHIDICTS_THEMES);
    expect(Array.from(theme?.options ?? []).map((option) => option.value)).toEqual(
      EXPECTED_HOSHIDICTS_THEMES
    );
    expect(groups).toHaveLength(EXPECTED_HOSHIDICTS_THEME_GROUPS.length);
    expect(
      groups.map((group) =>
        Array.from(group.querySelectorAll("option"), (option) => option.value)
      )
    ).toEqual(EXPECTED_HOSHIDICTS_THEME_GROUPS);
    expect(groups.every((group) => group.label.trim().length > 0)).toBe(true);
    expect(
      Array.from(theme?.options ?? []).find(
        (option) => option.value === "girlypop"
      )?.text.trim()
    ).toBe("Girlypop");
  });

  it("auto-saves whether the popup toolbar is at the top or bottom", async () => {
    vi.useFakeTimers();
    await render();
    const toolbarPosition = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-popup-toolbar-position"
    );

    expect(toolbarPosition?.value).toBe("top");
    expect(
      Array.from(toolbarPosition?.options ?? [], (option) => ({
        text: option.text.trim(),
        value: option.value
      }))
    ).toEqual([
      { text: "Top", value: "top" },
      { text: "Bottom", value: "bottom" }
    ]);

    await act(async () => {
      setSelectValue(toolbarPosition, "bottom");
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({ popupToolbarPosition: "bottom" })
    );
  });

  it("controls the popup buttons and custom links", async () => {
    vi.useFakeTimers();
    await render();

    const addToAnki = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-add-to-anki"
    );
    const audio = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-audio"
    );
    const customDefinition = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-custom-definition"
    );
    const viewInAnki = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-button-view-in-anki"
    );

    expect(addToAnki?.checked).toBe(true);
    expect(audio?.checked).toBe(true);
    expect(customDefinition?.checked).toBe(true);
    expect(viewInAnki?.checked).toBe(false);

    await act(async () => {
      audio?.click();
      viewInAnki?.click();
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-label"),
        "Jisho"
      );
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-url"),
        "https://jisho.org/search/%w?sentence=%s"
      );
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-popup-link-submit")
        ?.click();
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupButtons: {
          addToAnki: true,
          audio: false,
          customDefinition: true,
          viewInAnki: true,
          customLinks: [
            {
              label: "Jisho",
              url: "https://jisho.org/search/%w?sentence=%s"
            }
          ]
        }
      })
    );
    expect(container.textContent).toContain("Jisho");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Edit custom popup link Jisho"]'
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-popup-link-label")
        ?.value
    ).toBe("Jisho");

    await act(async () => {
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-url"),
        "https://jisho.org/search/%s"
      );
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-popup-link-submit")
        ?.click();
      await flushAutosave();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupButtons: expect.objectContaining({
          customLinks: [
            { label: "Jisho", url: "https://jisho.org/search/%s" }
          ]
        })
      })
    );

    await act(async () => {
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-label"),
        "Weblio"
      );
      setInputValue(
        container.querySelector("#hoshidicts-popup-link-url"),
        "https://example.test/%w"
      );
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-popup-link-submit")
        ?.click();
      await flushAutosave();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Edit custom popup link Weblio"]'
        )
        ?.click();
      await Promise.resolve();
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Delete custom popup link Jisho"]'
        )
        ?.click();
      await flushAutosave();
    });
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-popup-link-label")
        ?.value
    ).toBe("");
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupButtons: expect.objectContaining({
          customLinks: [
            { label: "Weblio", url: "https://example.test/%w" }
          ]
        })
      })
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Delete custom popup link Weblio"]'
        )
        ?.click();
      await flushAutosave();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupButtons: expect.objectContaining({ customLinks: [] })
      })
    );
  });

  it.each([
    ["ja", ["ダーク", "ライト", "ハイコントラスト"], "ガーリーポップ"],
    ["ukr", ["Темні", "Світлі", "Високий контраст"], "Ґерліпоп"]
  ])(
    "localizes popup theme groups and Girlypop in %s",
    async (locale, groupLabels, girlypopLabel) => {
      await render(locale);
      const theme = container.querySelector<HTMLSelectElement>(
        "#hoshidicts-popup-theme"
      );

      expect(
        Array.from(theme?.querySelectorAll("optgroup") ?? [], (group) =>
          group.label.trim()
        )
      ).toEqual(groupLabels);
      expect(
        Array.from(theme?.options ?? []).find(
          (option) => option.value === "girlypop"
        )?.text.trim()
      ).toBe(girlypopLabel);
    }
  );

  it("auto-saves Girlypop with popup dimensions and keeps it on size reset", async () => {
    vi.useFakeTimers();
    await render();
    const theme = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-popup-theme"
    );
    const opacity = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-opacity"
    );
    const width = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-width"
    );
    const height = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-height"
    );
    const reset = container.querySelector<HTMLButtonElement>(
      ".hoshidicts-reader-appearance__reset"
    );

    expect(theme?.value).toBe("default");
    expect(opacity?.value).toBe("85");
    expect(width?.value).toBe("560");
    expect(height?.value).toBe("420");
    expect(reset?.disabled).toBe(true);

    await act(async () => {
      setSelectValue(theme, "girlypop");
      setInputValue(opacity, "70");
      setInputValue(width, "720");
      setInputValue(height, "520");
      await flushAutosave();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupWidthPx: 720,
        popupHeightPx: 520,
        theme: "girlypop",
        popupOpacityPercent: 70
      })
    );
    expect(reset?.disabled).toBe(false);

    await act(async () => {
      reset?.click();
      await flushAutosave();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: "girlypop",
        popupOpacityPercent: 70
      })
    );
  });

  it("keeps source highlighting off by default and auto-saves when enabled", async () => {
    vi.useFakeTimers();
    await render();
    const sourceHighlight = container.querySelector<HTMLInputElement>(
      "#hoshidicts-source-highlight-enabled"
    );

    expect(sourceHighlight?.checked).toBe(false);
    expect(container.textContent).toContain("Highlight looked-up word");

    await act(async () => {
      sourceHighlight?.click();
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sourceHighlight?.checked).toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "shift",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: true,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 300,
        showLookupCounts: true,
        popupNestingMaxDepth: 10,
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: DEFAULT_HOSHIDICTS_THEME,
        popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        popupButtons: createDefaultHoshidictsPopupButtons(),
        definitionBlur: DEFAULT_HOSHIDICTS_DEFINITION_BLUR
      }
    );
  });

  it("auto-saves definition blur preferences as one nested setting", async () => {
    vi.useFakeTimers();
    await render();

    const enabled = container.querySelector<HTMLInputElement>(
      "#hoshidicts-definition-blur-enabled"
    );
    const threshold = container.querySelector<HTMLInputElement>(
      "#hoshidicts-definition-blur-threshold"
    );
    const revealMode = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-definition-blur-reveal-mode"
    );

    expect(
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-definition-blur-reveal-delay"
      )?.value
    ).toBe("5");

    await act(async () => {
      enabled?.click();
      setInputValue(threshold, "12");
      setSelectValue(revealMode, "hover");
      await flushAutosave();
    });

    expect(
      container.querySelector("#hoshidicts-definition-blur-reveal-delay")
    ).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "shift",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: false,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 300,
        showLookupCounts: true,
        popupNestingMaxDepth: 10,
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: DEFAULT_HOSHIDICTS_THEME,
        popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        popupButtons: createDefaultHoshidictsPopupButtons(),
        definitionBlur: {
          enabled: true,
          lookupThreshold: 12,
          revealMode: "hover",
          revealDelayMs: 5000
        }
      }
    );
  });

  it("restores and updates the preserved reveal duration in timed mode", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementationOnce(async () => ({
      ...baseState,
      definitionBlur: {
        enabled: true,
        lookupThreshold: 7,
        revealMode: "hover",
        revealDelayMs: 9000
      }
    }));
    await render();

    expect(
      container.querySelector("#hoshidicts-definition-blur-reveal-delay")
    ).toBeNull();
    await act(async () => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-definition-blur-reveal-mode"
        ),
        "timed"
      );
      await Promise.resolve();
    });
    const revealDelay = container.querySelector<HTMLInputElement>(
      "#hoshidicts-definition-blur-reveal-delay"
    );
    expect(revealDelay?.value).toBe("9");

    await act(async () => {
      setInputValue(revealDelay, "8");
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        definitionBlur: {
          enabled: true,
          lookupThreshold: 7,
          revealMode: "timed",
          revealDelayMs: 8000
        }
      })
    );
  });

  it("clamps definition blur inputs to the supported bounds", async () => {
    vi.useFakeTimers();
    await render();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          "#hoshidicts-definition-blur-threshold"
        ),
        "0"
      );
      setInputValue(
        container.querySelector<HTMLInputElement>(
          "#hoshidicts-definition-blur-reveal-delay"
        ),
        "7200"
      );
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      expect.objectContaining({
        definitionBlur: {
          enabled: false,
          lookupThreshold: 1,
          revealMode: "timed",
          revealDelayMs: 3_600_000
        }
      })
    );
  });

  it("toggles popup-content scanning and restores one child level", async () => {
    vi.useFakeTimers();
    await render();

    const toggle = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-content-scanning"
    );
    const initialDepth = container.querySelector<HTMLInputElement>(
      "#hoshidicts-popup-nesting-max-depth"
    );
    expect(toggle?.checked).toBe(true);
    expect(initialDepth?.value).toBe("10");
    expect(initialDepth?.min).toBe("1");
    expect(initialDepth?.step).toBe("1");
    expect(initialDepth?.hasAttribute("max")).toBe(false);

    await act(async () => {
      toggle?.click();
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "shift",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: false,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 300,
        showLookupCounts: true,
        popupNestingMaxDepth: 0,
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: DEFAULT_HOSHIDICTS_THEME,
        popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        popupButtons: createDefaultHoshidictsPopupButtons(),
        definitionBlur: DEFAULT_HOSHIDICTS_DEFINITION_BLUR
      }
    );
    expect(
      container.querySelector("#hoshidicts-popup-nesting-max-depth")
    ).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLInputElement>("#hoshidicts-popup-content-scanning")
        ?.click();
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "shift",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: false,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 300,
        showLookupCounts: true,
        popupNestingMaxDepth: 1,
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: DEFAULT_HOSHIDICTS_THEME,
        popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        popupButtons: createDefaultHoshidictsPopupButtons(),
        definitionBlur: DEFAULT_HOSHIDICTS_DEFINITION_BLUR
      }
    );
    expect(
      container.querySelector<HTMLInputElement>(
        "#hoshidicts-popup-nesting-max-depth"
      )?.value
    ).toBe("1");
  });

  it("captures a single physical key and can reset it to Shift", async () => {
    vi.useFakeTimers();
    await render();
    const capture = container.querySelector<HTMLButtonElement>(
      "#hoshidicts-activation-key-capture"
    );

    await act(async () => {
      capture?.click();
      await Promise.resolve();
    });
    await act(async () => {
      capture?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: "CapsLock",
          key: "CapsLock"
        })
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("That key cannot be used");

    const shiftedDigit = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit1",
      key: "!",
      shiftKey: true
    });
    await act(async () => {
      capture?.dispatchEvent(shiftedDigit);
      await Promise.resolve();
    });
    expect(shiftedDigit.defaultPrevented).toBe(true);
    expect(container.textContent).toContain("Hold 1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "shift",
        activationKey: "1",
        sourceHighlightEnabled: false,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 300,
        showLookupCounts: true,
        popupNestingMaxDepth: 10,
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: DEFAULT_HOSHIDICTS_THEME,
        popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        popupButtons: createDefaultHoshidictsPopupButtons(),
        definitionBlur: DEFAULT_HOSHIDICTS_DEFINITION_BLUR
      }
    );

    const reset = container.querySelector<HTMLButtonElement>(
      "#hoshidicts-activation-key-reset"
    );
    await act(async () => {
      reset?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Hold Shift");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "shift",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: false,
        onlyScanJapaneseText: true,
        popupHideDelayMs: 300,
        showLookupCounts: true,
        popupNestingMaxDepth: 10,
        popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
        popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
        theme: DEFAULT_HOSHIDICTS_THEME,
        popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
        popupButtons: createDefaultHoshidictsPopupButtons(),
        definitionBlur: DEFAULT_HOSHIDICTS_DEFINITION_BLUR
      }
    );
  });

  it("loads the custom source lazily and saves the explicit draft", async () => {
    await render();
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getCustomDictionary
    );

    await openCustom();
    const editor = container.querySelector<HTMLTextAreaElement>(
      "#hoshidicts-custom-dictionary-editor"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getCustomDictionary
    );
    expect(editor?.value).toBe(customDocument.text);
    expect(container.textContent).toContain(customDocument.filePath);

    const draft = [
      customDocument.text.trimEnd(),
      "bad line",
      "千鳥, ちどり, Lightning thrust, with chakra"
    ].join("\n");
    await act(async () => {
      setTextareaValue(editor, draft);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("2 valid entries");
    expect(container.textContent).toContain(
      "Malformed lines will be preserved but skipped (1 total; first lines: 2)."
    );
    expect(container.textContent).toContain("Unsaved changes");
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.saveCustomDictionary,
      expect.anything()
    );

    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Save Dictionary")
    );
    await act(async () => {
      save?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.saveCustomDictionary,
      { text: draft, expectedRevision: customDocument.revision }
    );
    expect(container.textContent).toContain("Custom dictionary saved.");
    expect(container.textContent).toContain("Saved");
  });

  it("preserves the custom draft when saving fails", async () => {
    const originalImplementation = invokeMock.getMockImplementation();
    const reloadedDocument = {
      ...customDocument,
      text: `${customDocument.text}千鳥, ちどり, External definition\n`,
      revision: "external-revision"
    };
    let customReadCount = 0;
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getCustomDictionary) {
          customReadCount += 1;
          return customReadCount === 1 ? customDocument : reloadedDocument;
        }
        if (channel === HOSHIDICTS_CHANNELS.saveCustomDictionary) {
          return {
            success: false,
            error: "The custom dictionary changed after it was opened.",
            state: { ...baseState, revision: ++revision }
          };
        }
        return await originalImplementation?.(channel, ...args);
      }
    );
    await render();
    await openCustom();
    const editor = container.querySelector<HTMLTextAreaElement>(
      "#hoshidicts-custom-dictionary-editor"
    );
    const draft = `${customDocument.text}影分身の術, かげぶんしんのじゅつ, Creates solid shadow clones\n`;
    await act(async () => {
      setTextareaValue(editor, draft);
      await Promise.resolve();
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Save Dictionary"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editor?.value).toBe(draft);
    expect(container.textContent).toContain(
      "The custom dictionary changed after it was opened."
    );
    expect(container.textContent).toContain("Save failed");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Reload from File"))
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledWith(
      "Reloading will discard your unsaved custom dictionary changes. Continue?"
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(
        "#hoshidicts-custom-dictionary-editor"
      )?.value
    ).toBe(reloadedDocument.text);
    expect(
      invokeMock.mock.calls.filter(
        ([channel]) => channel === HOSHIDICTS_CHANNELS.getCustomDictionary
      )
    ).toHaveLength(2);
    confirm.mockRestore();
  });

  it("loads every Anki field on entry without dirtying automatic mappings", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Anki Mining");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      undefined
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.anything()
    );
    const values = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        ".hoshidicts-mining-field-value"
      )
    ).map((input) => [input.dataset.ankiField, input.value]);
    expect(values).toEqual([
      ["Expression", "{expression}"],
      ["ExpressionReading", "{reading}"],
      ["Glossary", "{definition}"],
      ["Sentence", "{sentence}"],
      ["Frequency", "{frequency}"],
      ["PitchPosition", "{pitch-position}"],
      ["WordAudio", "{audio}"],
      ["Front", ""]
    ]);
    expect(container.textContent).toContain("7 of 8 fields mapped");
    expect(container.textContent).toContain(
      "All fields from the selected Anki note type are shown"
    );
  });

  it("falls back to persisted target fields offline and preserves explicit blanks", async () => {
    const offlineState: HoshidictsDesktopSnapshot = {
      ...baseState,
      miningProfile: {
        ...baseState.miningProfile,
        model: "Offline",
        fieldTemplates: {
          Front: { value: "", overwriteMode: "coalesce" },
          Note: { value: "x", overwriteMode: "append" }
        }
      }
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) return offlineState;
      if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
        return {
          ...miningOptions,
          connected: false,
          selectedNoteType: "Offline",
          fields: [],
          suggestedFieldTemplates: {},
          resolvedFieldTemplates: {},
          error: "Anki is offline."
        } satisfies HoshidictsMiningOptions;
      }
      return { success: true, state: offlineState };
    });

    await render();
    await openMining();

    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          ".hoshidicts-mining-field-value"
        )
      ).map((input) => [input.dataset.ankiField, input.value])
    ).toEqual([
      ["Front", ""],
      ["Note", "x"]
    ]);
    expect(container.textContent).toContain("1 of 2 fields mapped");
    expect(callsFor(HOSHIDICTS_CHANNELS.setMiningProfile)).toHaveLength(0);
  });

  it("shows normalized legacy target fields while Anki is offline", async () => {
    const offlineState: HoshidictsDesktopSnapshot = {
      ...baseState,
      miningProfile: {
        ...baseState.miningProfile,
        model: "Offline legacy",
        fields: {
          ...baseState.miningProfile.fields,
          expression: "Front",
          reading: "Reading",
          definition: "Front",
          sentence: "Context"
        },
        disabledFields: ["reading"],
        fieldOverwriteModes: {
          ...baseState.miningProfile.fieldOverwriteModes,
          expression: "append",
          definition: "overwrite"
        },
        fieldTemplates: null
      }
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) return offlineState;
      if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
        return {
          ...miningOptions,
          connected: false,
          selectedNoteType: "Offline legacy",
          fields: [],
          suggestedFieldTemplates: {},
          resolvedFieldTemplates: {},
          error: "Anki is offline."
        } satisfies HoshidictsMiningOptions;
      }
      return { success: true, state: offlineState };
    });

    await render();
    await openMining();

    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          ".hoshidicts-mining-field-value"
        )
      ).map((input) => [input.dataset.ankiField, input.value])
    ).toEqual([
      ["Front", "{expression}<br>{definition}"],
      ["Context", "{sentence}"]
    ]);
    expect(
      container.querySelector<HTMLSelectElement>(
        '[data-anki-field="Front"][data-field-control="overwrite"]'
      )?.value
    ).toBeUndefined();
    expect(container.textContent).toContain("2 of 2 fields mapped");
  });

  it("preserves a saved mapping when Anki changes only the field casing", async () => {
    vi.useFakeTimers();
    const caseChangedState: HoshidictsDesktopSnapshot = {
      ...baseState,
      miningProfile: {
        ...baseState.miningProfile,
        model: "Case changed",
        fieldTemplates: {
          front: { value: "x", overwriteMode: "append" }
        }
      }
    };
    const caseChangedOptions: HoshidictsMiningOptions = {
      ...miningOptions,
      selectedNoteType: "Case changed",
      fields: ["Front", "Back"],
      suggestedFieldTemplates: { Front: "", Back: "" },
      resolvedFieldTemplates: {
        Front: { value: "x", overwriteMode: "append" },
        Back: { value: "", overwriteMode: "coalesce" }
      }
    };
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return caseChangedState;
        if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
          return caseChangedOptions;
        }
        if (channel === HOSHIDICTS_CHANNELS.setMiningProfile) {
          return {
            success: true,
            state: {
              ...caseChangedState,
              revision: ++revision,
              miningProfile: args[0]
            }
          };
        }
        return { success: true, state: caseChangedState };
      }
    );

    await render();
    await openMining();
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-anki-field="Front"][data-field-control="value"]'
      )?.value
    ).toBe("x");
    expect(
      container.querySelector(".hoshidicts-mining-fields__warning")
    ).toBeNull();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Back"][data-field-control="value"]'
        ),
        "y"
      );
      await flushAutosave();
    });

    expect(
      callsFor(HOSHIDICTS_CHANNELS.setMiningProfile).at(-1)?.[1]
    ).toMatchObject({
      fieldTemplates: {
        Front: { value: "x", overwriteMode: "append" },
        Back: { value: "y", overwriteMode: "coalesce" }
      }
    });
  });

  it("edits and auto-saves ordered pronunciation sources", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Audio");

    expect(container.textContent).toContain("JapanesePod101");
    expect(container.textContent).toContain("LanguagePod101");
    expect(container.textContent).toContain("Jisho");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Move LanguagePod101 up"]'
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>("#hoshidicts-audio-add-source")
        ?.click();
      const rows = container.querySelectorAll<HTMLElement>(
        ".hoshidicts-audio-source"
      );
      const customRow = rows[rows.length - 1];
      setSelectValue(
        customRow?.querySelector<HTMLSelectElement>("select"),
        "custom-json"
      );
      setInputValue(
        customRow?.querySelector<HTMLInputElement>('input[type="text"]'),
        "http://127.0.0.1:9000/audio"
      );
      const autoplay = container.querySelector<HTMLInputElement>(
        "#hoshidicts-audio-autoplay"
      );
      autoplay?.click();
      const volume = container.querySelector<HTMLInputElement>(
        "#hoshidicts-audio-volume"
      );
      setInputValue(volume, "65");
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setAudioProfile,
      expect.objectContaining({
        enabled: true,
        autoPlay: true,
        volume: 65,
        sources: expect.arrayContaining([
          expect.objectContaining({
            type: "custom-json",
            url: "http://127.0.0.1:9000/audio"
          })
        ])
      })
    );
    const savedProfile = invokeMock.mock.calls.find(
      ([channel]) => channel === HOSHIDICTS_CHANNELS.setAudioProfile
    )?.[1] as typeof baseState.audioProfile;
    expect(savedProfile.sources[0].type).toBe("language-pod-101");
    expect(container.textContent).toContain("Saved");
  });

  it("tests every downloadable audio row with the current draft and plays the returned bytes", async () => {
    const createObjectUrl = vi.fn((_blob: Blob) => "blob:hoshidicts-kiku");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });

    class FakeAudio {
      static instances: FakeAudio[] = [];
      volume = 1;
      onended: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      play = vi.fn(async () => undefined);
      pause = vi.fn();

      constructor(readonly src: string) {
        FakeAudio.instances.push(this);
      }
    }
    vi.stubGlobal("Audio", FakeAudio);

    const pendingTest = deferred<unknown>();
    const defaultInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.testAudioSource) {
          return await pendingTest.promise;
        }
        return await defaultInvoke?.(channel, ...args);
      }
    );

    await render();
    await openView("Audio");

    const testButtons = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "[data-audio-test-source]"
        )
      );
    expect(testButtons()).toHaveLength(baseState.audioProfile.sources.length);
    expect(
      testButtons().every((button) =>
        button.getAttribute("aria-label")?.includes("聞く（きく）")
      )
    ).toBe(true);
    const firstActions = testButtons()[0]?.closest(
      ".hoshidicts-audio-source__actions"
    );
    expect(
      firstActions?.querySelector("[data-audio-test-source]")
    ).toBe(testButtons()[0]);
    expect(firstActions?.querySelector("button.danger")).not.toBeNull();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>("#hoshidicts-audio-volume"),
        "65"
      );
      await Promise.resolve();
    });
    const firstButton = container.querySelector<HTMLButtonElement>(
      '[data-audio-test-source="jpod101"]'
    );
    await act(async () => {
      firstButton?.click();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.testAudioSource,
      {
        profile: expect.objectContaining({ volume: 65 }),
        sourceId: "jpod101"
      }
    );
    expect(container.textContent).toContain("Testing 聞く（きく）");
    expect(testButtons().every((button) => button.disabled)).toBe(true);

    await act(async () => {
      pendingTest.resolve({
        success: true,
        audio: {
          bytes: Uint8Array.from([0x49, 0x44, 0x33]),
          contentType: "audio/mpeg",
          candidateName: "Kiku recording"
        },
        state: baseState
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createObjectUrl).toHaveBeenCalledOnce();
    const blob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe(3);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.src).toBe("blob:hoshidicts-kiku");
    expect(FakeAudio.instances[0]?.volume).toBe(0.65);
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Playing Kiku recording");

    await act(async () => {
      FakeAudio.instances[0]?.onended?.(new Event("ended"));
      await Promise.resolve();
    });

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:hoshidicts-kiku");
    expect(container.textContent).toContain("Played Kiku recording");
    expect(testButtons().every((button) => !button.disabled)).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-audio-test-source="language-pod-101"]'
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(FakeAudio.instances).toHaveLength(2);

    await act(async () => root.unmount());
    expect(FakeAudio.instances[1]?.pause).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });

  it("uses the same per-row test control to speak expression and reading TTS", async () => {
    class FakeUtterance {
      lang = "";
      volume = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: ((event: Event) => void) | null = null;
      onend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly text: string) {}
    }
    const spoken: FakeUtterance[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel,
      speak: (utterance: FakeUtterance) => spoken.push(utterance)
    });

    const ttsState: HoshidictsDesktopSnapshot = {
      ...baseState,
      audioProfile: {
        ...baseState.audioProfile,
        volume: 40,
        sources: [
          {
            id: "expression-tts",
            type: "text-to-speech",
            url: "",
            voice: ""
          },
          {
            id: "reading-tts",
            type: "text-to-speech-reading",
            url: "",
            voice: ""
          }
        ]
      }
    };
    const defaultInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return ttsState;
        return await defaultInvoke?.(channel, ...args);
      }
    );

    await render();
    await openView("Audio");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-audio-test-source="expression-tts"]'
        )
        ?.click();
      await Promise.resolve();
    });
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({
      text: "聞く",
      lang: "ja-JP",
      volume: 0.4
    });
    expect(container.textContent).toContain("Playing 聞く");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-audio-test-source="reading-tts"]'
      )?.disabled
    ).toBe(true);

    await act(async () => {
      spoken[0]?.onend?.(new Event("end"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Played 聞く");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-audio-test-source="reading-tts"]'
        )
        ?.click();
      await Promise.resolve();
    });
    expect(spoken).toHaveLength(2);
    expect(spoken[1]?.text).toBe("きく");
    expect(cancel).toHaveBeenCalled();
    expect(
      callsFor(HOSHIDICTS_CHANNELS.testAudioSource)
    ).toHaveLength(0);
  });

  it("shows a per-row error and re-enables source tests after a failed probe", async () => {
    const defaultInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.testAudioSource) {
          return {
            success: false,
            error: "The recording service is unavailable.",
            state: baseState
          };
        }
        return await defaultInvoke?.(channel, ...args);
      }
    );

    await render();
    await openView("Audio");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-audio-test-source="jisho"]'
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const error = container.querySelector<HTMLElement>(
      '.hoshidicts-audio-source__test-status[data-phase="error"]'
    );
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe(
      "Test failed: The recording service is unavailable."
    );
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "[data-audio-test-source]"
        )
      ).every((button) => !button.disabled)
    ).toBe(true);
  });

  it("locks the full audio profile and times out stalled media and TTS tests", async () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.fn((_blob: Blob) => "blob:stalled-kiku");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });

    class FakeAudio {
      static instances: FakeAudio[] = [];
      volume = 1;
      onended: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      play = vi.fn(async () => undefined);
      pause = vi.fn();

      constructor(readonly src: string) {
        FakeAudio.instances.push(this);
      }
    }
    class FakeUtterance {
      lang = "";
      volume = 1;
      voice: SpeechSynthesisVoice | null = null;
      onend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly text: string) {}
    }
    const spoken: FakeUtterance[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel,
      speak: (utterance: FakeUtterance) => spoken.push(utterance)
    });

    const timeoutState: HoshidictsDesktopSnapshot = {
      ...baseState,
      audioProfile: {
        ...baseState.audioProfile,
        sources: [
          {
            id: "custom-test",
            type: "custom",
            url: "https://example.test/{term}/{reading}.mp3",
            voice: ""
          },
          {
            id: "expression-tts",
            type: "text-to-speech",
            url: "",
            voice: ""
          }
        ]
      }
    };
    const defaultInvoke = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) return timeoutState;
        if (channel === HOSHIDICTS_CHANNELS.testAudioSource) {
          return {
            success: true,
            audio: {
              bytes: Uint8Array.from([1, 2, 3]),
              contentType: "audio/mpeg",
              candidateName: "Stalled recording"
            },
            state: timeoutState
          };
        }
        return await defaultInvoke?.(channel, ...args);
      }
    );

    await render();
    await openView("Audio");
    const customTest = container.querySelector<HTMLButtonElement>(
      '[data-audio-test-source="custom-test"]'
    );
    const customRow = customTest?.closest<HTMLElement>(
      ".hoshidicts-audio-source"
    );
    await act(async () => {
      customTest?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const profileControls = Array.from(
      container.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >(
        ".hoshidicts-audio input, .hoshidicts-audio select, " +
          ".hoshidicts-actions button, .hoshidicts-audio-source__order button, " +
          ".hoshidicts-audio-source__actions button"
      )
    );
    expect(profileControls.length).toBeGreaterThan(10);
    expect(profileControls.every((control) => control.disabled)).toBe(true);
    expect(customRow?.textContent).toContain("Playing Stalled recording");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(FakeAudio.instances[0]?.pause).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:stalled-kiku");
    expect(
      customRow?.querySelector<HTMLElement>(
        '.hoshidicts-audio-source__test-status[data-phase="error"]'
      )?.textContent
    ).toBe("Test failed: Audio source test timed out.");
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-audio-enabled")
        ?.disabled
    ).toBe(false);
    expect(
      customRow?.querySelector<HTMLInputElement>('input[type="text"]')
        ?.disabled
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        "#hoshidicts-audio-add-source"
      )?.disabled
    ).toBe(false);

    const ttsTest = container.querySelector<HTMLButtonElement>(
      '[data-audio-test-source="expression-tts"]'
    );
    await act(async () => {
      ttsTest?.click();
      await Promise.resolve();
    });
    expect(spoken).toHaveLength(1);
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-audio-volume")
        ?.disabled
    ).toBe(true);
    const cancelsBeforeTimeout = cancel.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(cancel.mock.calls.length).toBeGreaterThan(cancelsBeforeTimeout);
    expect(
      ttsTest
        ?.closest(".hoshidicts-audio-source")
        ?.querySelector<HTMLElement>(
          '.hoshidicts-audio-source__test-status[data-phase="error"]'
        )?.textContent
    ).toBe("Test failed: Audio source test timed out.");
    expect(ttsTest?.disabled).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>("#hoshidicts-audio-volume")
        ?.disabled
    ).toBe(false);
  });

  it("blocks a failed audio version until the next edit", async () => {
    vi.useFakeTimers();
    const defaultInvoke = invokeMock.getMockImplementation();
    let rejectNextAudioSave = true;
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (
          channel === HOSHIDICTS_CHANNELS.setAudioProfile &&
          rejectNextAudioSave
        ) {
          rejectNextAudioSave = false;
          return {
            success: false,
            error: "Audio profile was rejected.",
            state: { ...baseState, revision: ++revision }
          };
        }
        return await defaultInvoke?.(channel, ...args);
      }
    );
    await render();
    await openView("Audio");

    await act(async () => {
      container
        .querySelector<HTMLInputElement>("#hoshidicts-audio-autoplay")
        ?.click();
      await flushAutosave();
    });
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(1);
    expect(container.textContent).toContain("Save failed");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(1);

    await act(async () => {
      container
        .querySelector<HTMLInputElement>("#hoshidicts-audio-enabled")
        ?.click();
      await flushAutosave();
    });
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(2);
    expect(container.textContent).toContain("Saved");
  });

  it("queues edits made while an audio save is in flight", async () => {
    vi.useFakeTimers();
    const pendingSave = deferred<HoshidictsActionResult>();
    const defaultInvoke = invokeMock.getMockImplementation();
    let firstAudioSave = true;
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (
          channel === HOSHIDICTS_CHANNELS.setAudioProfile &&
          firstAudioSave
        ) {
          firstAudioSave = false;
          return await pendingSave.promise;
        }
        return await defaultInvoke?.(channel, ...args);
      }
    );
    await render();
    await openView("Audio");

    await act(async () => {
      container
        .querySelector<HTMLInputElement>("#hoshidicts-audio-autoplay")
        ?.click();
      await flushAutosave();
    });
    const firstRequest = callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)[0]?.[1] as
      | typeof baseState.audioProfile
      | undefined;
    expect(firstRequest?.autoPlay).toBe(true);

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>("#hoshidicts-audio-volume"),
        "65"
      );
      pendingSave.resolve({
        success: true,
        state: {
          ...baseState,
          revision: ++revision,
          audioProfile: firstRequest ?? baseState.audioProfile
        }
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await flushAutosave();
    });

    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)).toHaveLength(2);
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)[1]?.[1]).toMatchObject({
      autoPlay: true,
      volume: 65
    });
  });

  it("does not overwrite a dirty audio draft with progress snapshots", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Audio");
    const volume = container.querySelector<HTMLInputElement>(
      "#hoshidicts-audio-volume"
    );

    await act(async () => {
      setInputValue(volume, "65");
      listeners.get(HOSHIDICTS_CHANNELS.progress)?.[0]?.({}, {
        ...baseState,
        revision: ++revision,
        audioProfile: { ...baseState.audioProfile, volume: 5 }
      });
      await Promise.resolve();
    });
    expect(volume?.value).toBe("65");

    await act(async () => {
      await flushAutosave();
    });
    expect(callsFor(HOSHIDICTS_CHANNELS.setAudioProfile)[0]?.[1]).toMatchObject({
      volume: 65
    });
  });

  it("renders every Anki field with accessible editable marker inputs", async () => {
    await render();
    await openMining();

    const grid = container.querySelector(".hoshidicts-mining-field-grid");
    expect(grid).not.toBeNull();
    expect(
      Array.from(
        grid?.querySelectorAll(".hoshidicts-mining-field-grid__header") ?? []
      ).map((header) => header.textContent)
    ).toEqual(["Field", "Value"]);

    const rows = Array.from(
      grid?.querySelectorAll<HTMLElement>(".hoshidicts-mining-field-row") ?? []
    );
    const labels = rows.map((row) => row.querySelector("label"));
    const inputs = rows.map((row) =>
      row.querySelector<HTMLInputElement>(".hoshidicts-mining-field-value")
    );
    expect(labels.map((label) => label?.textContent)).toEqual([
      "Expression",
      "ExpressionReading",
      "Glossary",
      "Sentence",
      "Frequency",
      "PitchPosition",
      "WordAudio",
      "Front"
    ]);
    expect(inputs).toHaveLength(8);
    expect(labels.map((label) => label?.htmlFor)).toEqual(
      inputs.map((input) => input?.id)
    );
    expect(
      inputs.every(
        (input) =>
          input?.getAttribute("list") === "hoshidicts-mining-field-values"
      )
    ).toBe(true);
    expect(
      Array.from(
        container.querySelectorAll<HTMLOptionElement>(
          "#hoshidicts-mining-field-values option"
        )
      ).map((option) => option.value)
    ).toEqual([
      "{expression}",
      "{reading}",
      "{furigana}",
      "{furigana-plain}",
      "{definition}",
      "{main-definition}",
      "{glossary}",
      "{dictionary}",
      "{sentence}",
      "{sentence-furigana}",
      "{sentence-furigana-plain}",
      "{frequency}",
      "{pitch}",
      "{pitch-position}",
      "{audio}"
    ]);
    expect(
      Object.fromEntries(
        Array.from(
          container.querySelectorAll<HTMLOptionElement>(
            "#hoshidicts-mining-field-values option"
          )
        ).map((option) => [option.value, option.textContent])
      )
    ).toMatchObject({
      "{furigana}": "Furigana",
      "{furigana-plain}": "Furigana (Anki bracket syntax)",
      "{main-definition}": "Main definition",
      "{glossary}": "Glossary",
      "{dictionary}": "Dictionary name",
      "{sentence-furigana}": "Sentence with furigana",
      "{sentence-furigana-plain}":
        "Sentence with furigana (Anki bracket syntax)"
    });
  });

  it("auto-saves duplicate scope, note-type checks, behavior, and field overwrite modes", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();

    const checkAllNoteTypes = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-check-all-note-types"
    );
    await act(async () => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-duplicate-scope"
        ),
        "deck-root"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-duplicate-behavior"
        ),
        "overwrite"
      );
      checkAllNoteTypes?.click();
      await Promise.resolve();
    });

    expect(
      Array.from(
        container.querySelectorAll(".hoshidicts-mining-field-grid__header")
      ).map((header) => header.textContent)
    ).toEqual(["Field", "Value", "On overwrite"]);
    expect(
      container.querySelectorAll('[id^="hoshidicts-mining-overwrite-"]')
    ).toHaveLength(8);

    await act(async () => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          '[data-anki-field="Expression"][data-field-control="overwrite"]'
        ),
        "overwrite"
      );
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.objectContaining({
        checkForDuplicates: true,
        duplicateScope: "deck-root",
        duplicateScopeCheckAllModels: true,
        duplicateBehavior: "overwrite",
        fieldTemplates: expect.objectContaining({
          Expression: {
            value: "{expression}",
            overwriteMode: "overwrite"
          },
          Front: { value: "", overwriteMode: "coalesce" }
        })
      })
    );
  });

  it("auto-saves marker choices, blanks, and arbitrary literal values", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Anki Mining");

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Glossary"][data-field-control="value"]'
        ),
        "{sentence}"
      );
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="WordAudio"][data-field-control="value"]'
        ),
        ""
      );
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.objectContaining({
        fieldTemplates: {
          Expression: { value: "{expression}", overwriteMode: "coalesce" },
          ExpressionReading: {
            value: "{reading}",
            overwriteMode: "coalesce"
          },
          Glossary: { value: "{sentence}", overwriteMode: "coalesce" },
          Sentence: { value: "{sentence}", overwriteMode: "coalesce" },
          Frequency: { value: "{frequency}", overwriteMode: "coalesce" },
          PitchPosition: {
            value: "{pitch-position}",
            overwriteMode: "coalesce"
          },
          WordAudio: { value: "", overwriteMode: "coalesce" },
          Front: { value: "x", overwriteMode: "coalesce" }
        }
      })
    );
    expect(container.querySelector("button")?.textContent).not.toBe(
      "Save Mining Profile"
    );
  });

  it("resets mappings for a new note type and ignores stale discovery", async () => {
    const lapisRequest = deferred<HoshidictsMiningOptions>();
    const kikuRequest = deferred<HoshidictsMiningOptions>();
    const originalImplementation = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (
          channel === HOSHIDICTS_CHANNELS.getMiningOptions &&
          args[0] === "Lapis"
        ) {
          return await lapisRequest.promise;
        }
        if (
          channel === HOSHIDICTS_CHANNELS.getMiningOptions &&
          args[0] === "Kiku"
        ) {
          return await kikuRequest.promise;
        }
        return await originalImplementation?.(channel, ...args);
      }
    );

    await render();
    await openView("Anki Mining");
    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Lapis"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Kiku"
      );
      kikuRequest.resolve(miningOptions);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      lapisRequest.resolve({
        ...miningOptions,
        selectedNoteType: "Lapis",
        fields: ["Expression", "MainDefinition"],
        suggestedFields: {
          ...miningOptions.suggestedFields,
          definition: "MainDefinition"
        },
        resolvedFields: {
          ...miningOptions.resolvedFields,
          definition: "MainDefinition"
        },
        suggestedFieldTemplates: {
          Expression: "{expression}",
          MainDefinition: "{definition}"
        },
        resolvedFieldTemplates: {
          Expression: { value: "{expression}", overwriteMode: "coalesce" },
          MainDefinition: {
            value: "{definition}",
            overwriteMode: "coalesce"
          }
        }
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model")
        ?.value
    ).toBe("Kiku");
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-anki-field="Front"][data-field-control="value"]'
      )?.value
    ).toBe("");
    expect(container.textContent).toContain("Glossary");
    expect(container.textContent).not.toContain("MainDefinition");
  });

  it("saves a note-type change with fresh automatic mappings", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Lapis"
      );
      await Promise.resolve();
    });
    await act(flushAutosave);

    const saved = callsFor(HOSHIDICTS_CHANNELS.setMiningProfile).at(-1)?.[1];
    expect(saved).toMatchObject({
      model: "Lapis",
      fieldTemplates: null,
      disabledFields: [],
      fields: {
        expression: "",
        reading: "",
        definition: "",
        sentence: "",
        frequency: "",
        pitch: "",
        audio: ""
      },
      fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes()
    });
  });

  it("preserves mappings when explicit and Automatic select the same note type", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      await flushAutosave();
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        "Kiku"
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(flushAutosave);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      "Kiku"
    );
    expect(
      callsFor(HOSHIDICTS_CHANNELS.setMiningProfile).at(-1)?.[1]
    ).toMatchObject({
      model: "Kiku",
      fieldTemplates: {
        Front: { value: "x", overwriteMode: "coalesce" }
      }
    });

    await act(async () => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        ""
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(flushAutosave);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      ""
    );
    expect(
      callsFor(HOSHIDICTS_CHANNELS.setMiningProfile).at(-1)?.[1]
    ).toMatchObject({
      model: "",
      fieldTemplates: {
        Front: { value: "x", overwriteMode: "coalesce" }
      }
    });
  });

  it("resets mappings when Automatic resolves to a different note type", async () => {
    const automaticRequest = deferred<HoshidictsMiningOptions>();
    const originalImplementation = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) {
          return {
            ...baseState,
            miningProfile: { ...baseState.miningProfile, model: "Lapis" }
          };
        }
        if (
          channel === HOSHIDICTS_CHANNELS.getMiningOptions &&
          args[0] === ""
        ) {
          return await automaticRequest.promise;
        }
        if (channel === HOSHIDICTS_CHANNELS.getMiningOptions) {
          return {
            ...miningOptions,
            selectedNoteType: "Lapis"
          };
        }
        return await originalImplementation?.(channel, ...args);
      }
    );
    vi.useFakeTimers();
    await render();
    await openMining();

    await act(async () => {
      setInputValue(
        container.querySelector<HTMLInputElement>(
          '[data-anki-field="Front"][data-field-control="value"]'
        ),
        "x"
      );
      await flushAutosave();
    });
    const savesBeforeSwitch = callsFor(
      HOSHIDICTS_CHANNELS.setMiningProfile
    ).length;

    await act(async () => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>("#hoshidicts-mining-model"),
        ""
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLInputElement>(
        '[data-anki-field="Front"][data-field-control="value"]'
      )?.disabled
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(callsFor(HOSHIDICTS_CHANNELS.setMiningProfile)).toHaveLength(
      savesBeforeSwitch
    );

    await act(async () => {
      automaticRequest.resolve(miningOptions);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(flushAutosave);

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.getMiningOptions,
      ""
    );
    expect(
      callsFor(HOSHIDICTS_CHANNELS.setMiningProfile).at(-1)?.[1]
    ).toMatchObject({ model: "", fieldTemplates: null });
  });

  it.each([
    [
      "ja",
      "辞書・音声・マイニングの設定",
      "おすすめの辞書",
      "キーを変更",
      "Shiftに戻す",
      "検索語をハイライト",
      "頻度モード: 順位順",
      "カスタム",
      "ポップアップの内容を検索可能にする",
      "繰り返し検索した定義をぼかす",
      "フィールド",
      "値",
      "選択したAnkiノートタイプのすべてのフィールドを表示します",
      "既出回数と検索回数を表示"
    ],
    [
      "ukr",
      "Налаштування словників, аудіо та видобування",
      "Рекомендовані словники",
      "Змінити клавішу",
      "Скинути до Shift",
      "Підсвічувати знайдене слово",
      "Режим частоти: За рангом",
      "Власний",
      "Дозволити пошук у вмісті спливних вікон",
      "Розмивати визначення після повторних пошуків",
      "Поле",
      "Значення",
      "Показано всі поля вибраного типу нотатки Anki",
      "Показувати кількість зустрічей і пошуків"
    ]
  ])(
    "localizes the standalone window in %s",
    async (
      locale,
      subtitle,
      recommended,
      changeKey,
      resetKey,
      sourceHighlight,
      frequencyMode,
      custom,
      popupScanning,
      definitionBlur,
      fieldHeader,
      valueHeader,
      mappingHint,
      lookupCounts
    ) => {
      await render(locale);
      expect(container.textContent).toContain(subtitle);
      expect(container.textContent).toContain(recommended);
      expect(container.textContent).toContain(changeKey);
      expect(container.textContent).toContain(resetKey);
      expect(container.textContent).toContain(sourceHighlight);
      expect(container.textContent).toContain(frequencyMode);
      expect(container.textContent).toContain(custom);
      expect(container.textContent).toContain(popupScanning);
      expect(container.textContent).toContain(definitionBlur);
      expect(container.textContent).toContain(lookupCounts);
      await openMining();
      expect(
        Array.from(
          container.querySelectorAll(".hoshidicts-mining-field-grid__header")
        ).map((header) => header.textContent)
      ).toEqual([fieldHeader, valueHeader]);
      expect(container.textContent).toContain(mappingHint);
    }
  );

  it("normalizes legacy snapshots without dirtying new preferences", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...baseState,
      revision: undefined,
      activationKey: undefined,
      sourceHighlightEnabled: undefined,
      onlyScanJapaneseText: undefined,
      popupHideDelayMs: undefined,
      showLookupCounts: undefined,
      popupNestingMaxDepth: undefined,
      popupButtons: undefined,
      definitionBlur: undefined,
      audioProfile: undefined,
      tabGroups: undefined,
      dictionaries: [
        {
          ...baseState.dictionaries[0],
          enabled: undefined,
          favorite: undefined,
          frequencyCount: undefined,
          pitchCount: undefined,
          kanjiCount: undefined,
          frequencyMode: "invalid",
          updateScheduleOverride: undefined,
          lastUpdateCheck: undefined
        }
      ],
      miningProfile: {
        ...baseState.miningProfile,
        version: 2,
        disabledFields: undefined,
        fieldTemplates: undefined
      }
    });
    expect(normalized.revision).toBe(0);
    expect(normalized.activationKey).toBe(DEFAULT_HOSHIDICTS_ACTIVATION_KEY);
    expect(normalized.sourceHighlightEnabled).toBe(false);
    expect(normalized.onlyScanJapaneseText).toBe(true);
    expect(normalized.popupHideDelayMs).toBe(300);
    expect(normalized.showLookupCounts).toBe(true);
    expect(normalized.definitionBlur).toEqual(
      DEFAULT_HOSHIDICTS_DEFINITION_BLUR
    );
    expect(normalized.popupNestingMaxDepth).toBe(10);
    expect(normalized.popupButtons).toEqual(
      createDefaultHoshidictsPopupButtons()
    );
    expect(normalized.dictionaries[0].enabled).toBe(true);
    expect(normalized.dictionaries[0]).toMatchObject({
      favorite: false,
      frequencyCount: 0,
      pitchCount: 0,
      kanjiCount: 0,
      frequencyMode: null,
      updateScheduleOverride: null,
      lastUpdateCheck: null
    });
    expect(normalized.recommendedDictionaries.map(({ id }) => id)).toEqual([
      "jitendex",
      "jmdict",
      "jmnedict",
      "bccwj",
      "jpdbv2-kana",
      "jiten",
      "kanjium-pitch",
      "kanjidic"
    ]);
    expect(normalized.miningProfile.disabledFields).toEqual([]);
    expect(normalized.miningProfile.fields.audio).toBe("");
    expect(normalized.miningProfile).toMatchObject({
      version: 3,
      fieldTemplates: null
    });
    expect(normalized.audioProfile).toEqual(baseState.audioProfile);
    expect(normalized.tabGroups).toEqual([]);
  });

  it("normalizes tab group membership without dropping orphan dictionary ids", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...baseState,
      tabGroups: [
        {
          id: "grammar",
          name: "Grammar",
          dictionaryIds: ["jmdict-id", "missing-id", "jmdict-id"]
        },
        { id: "", name: "Ignored", dictionaryIds: [] },
        null
      ]
    });

    expect(normalized.tabGroups).toEqual([
      {
        id: "grammar",
        name: "Grammar",
        dictionaryIds: ["jmdict-id", "missing-id"]
      }
    ]);
  });

  it("normalizes hourly global and dictionary schedules", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...baseState,
      schedule: "hourly",
      dictionaries: [
        {
          ...baseState.dictionaries[0],
          updateScheduleOverride: "hourly"
        }
      ]
    });

    expect(normalized.schedule).toBe("hourly");
    expect(normalized.dictionaries[0].updateScheduleOverride).toBe("hourly");
  });

  it("restores Girlypop from a persisted desktop snapshot", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...baseState,
      theme: "girlypop"
    });

    expect(normalized.theme).toBe("girlypop");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"])(
    "normalizes invalid popup nesting depth %s",
    (popupNestingMaxDepth) => {
      expect(
        normalizeHoshidictsDesktopState({
          ...baseState,
          popupNestingMaxDepth
        }).popupNestingMaxDepth
      ).toBe(10);
    }
  );

  it("preserves zero as the disabled popup nesting depth", () => {
    expect(
      normalizeHoshidictsDesktopState({
        ...baseState,
        popupNestingMaxDepth: 0
      }).popupNestingMaxDepth
    ).toBe(0);
  });

  it("normalizes malformed definition blur preferences", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...baseState,
      definitionBlur: {
        enabled: true,
        lookupThreshold: 0,
        revealMode: "click",
        revealDelayMs: 3_600_001
      }
    });

    expect(normalized.definitionBlur).toEqual({
      ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
      enabled: true
    });
  });
});
