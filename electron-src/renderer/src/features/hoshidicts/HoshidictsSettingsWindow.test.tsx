// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultHoshidictsAudioProfile,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  HOSHIDICTS_CHANNELS,
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
  AUTO_FIELD_VALUE,
  DISABLED_FIELD_VALUE,
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

const invokeMock = vi.fn();
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

const baseState: HoshidictsDesktopSnapshot = {
  revision: 10,
  effectiveEnabled: true,
  dictionaries: [
    {
      id: "jmdict-id",
      title: "JMdict",
      enabled: true,
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
      installedAt: "2026-08-06T10:00:00.000Z"
    },
    {
      id: "custom-id",
      title: "Custom",
      enabled: false,
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
      installedAt: "2026-08-06T11:00:00.000Z"
    }
  ],
  customDictionaryActive: false,
  recommendedDictionaries: [
    { id: "jmdict", installed: true },
    { id: "jmnedict", installed: false }
  ],
  miningProfile: {
    version: 1,
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
    duplicatePolicy: "prevent"
  },
  audioProfile: createDefaultHoshidictsAudioProfile(),
  lookupMode: "shift",
  activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  sourceHighlightEnabled: false,
  popupHideDelayMs: 300,
  definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
  popupNestingMaxDepth: 10,
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
      buttonContaining("Import Dictionary")?.click();
      buttonContaining("Check for Updates")?.click();
      buttonContaining("Install default set")?.click();
      buttons.find((button) => button.textContent?.trim() === "Install")?.click();
      container.querySelector<HTMLButtonElement>('button[aria-label="Move down"]')
        ?.click();
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')
        ?.click();
      container.querySelectorAll<HTMLInputElement>(
        ".hoshidicts-dictionary-row__toggle input"
      )[1]?.click();
      setSelectValue(schedule, "monthly");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.importDictionary
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

    await act(async () => {
      hover?.click();
      setInputValue(delay, "850");
      setInputValue(maxDepth, "12");
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "hover",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: false,
        popupHideDelayMs: 850,
        popupNestingMaxDepth: 12,
        definitionBlur: DEFAULT_HOSHIDICTS_DEFINITION_BLUR
      }
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setLookupMode,
      expect.anything()
    );
    expect(container.textContent).toContain("Saved");
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
        popupHideDelayMs: 300,
        popupNestingMaxDepth: 10,
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
        popupHideDelayMs: 300,
        popupNestingMaxDepth: 10,
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
        popupHideDelayMs: 300,
        popupNestingMaxDepth: 0,
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
        popupHideDelayMs: 300,
        popupNestingMaxDepth: 1,
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
        popupHideDelayMs: 300,
        popupNestingMaxDepth: 10,
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
        popupHideDelayMs: 300,
        popupNestingMaxDepth: 10,
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

  it("loads Anki on entry without dirtying or pinning automatic mappings", async () => {
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
    expect(
      container.querySelector<HTMLSelectElement>(
        "#hoshidicts-mining-field-reading"
      )?.value
    ).toBe(AUTO_FIELD_VALUE);
    expect(container.textContent).toContain("Automatic → ExpressionReading");
    expect(container.textContent).toContain("7 of 7 fields mapped");
    expect(container.textContent).toContain("Automatic → WordAudio");
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

  it("renders compact field and value mapping rows with accessible labels", async () => {
    await render();
    await openMining();

    const grid = container.querySelector(".hoshidicts-mining-field-grid");
    expect(grid).not.toBeNull();
    expect(
      Array.from(
        grid?.querySelectorAll(".hoshidicts-mining-field-grid__header") ?? []
      ).map((header) => header.textContent)
    ).toEqual(["Field", "Value"]);

    const labels = Array.from(grid?.querySelectorAll("label") ?? []);
    const selects = Array.from(
      grid?.querySelectorAll<HTMLSelectElement>("select") ?? []
    );
    expect(labels.map((label) => label.textContent)).toEqual([
      "Expression",
      "Reading",
      "Definition",
      "Sentence",
      "Frequency",
      "Pitch accent",
      "Pronunciation audio"
    ]);
    expect(selects.map((select) => select.id)).toEqual([
      "hoshidicts-mining-field-expression",
      "hoshidicts-mining-field-reading",
      "hoshidicts-mining-field-definition",
      "hoshidicts-mining-field-sentence",
      "hoshidicts-mining-field-frequency",
      "hoshidicts-mining-field-pitch",
      "hoshidicts-mining-field-audio"
    ]);
    expect(labels.map((label) => label.htmlFor)).toEqual(
      selects.map((select) => select.id)
    );
  });

  it("auto-saves automatic, disabled, and explicit field choices", async () => {
    vi.useFakeTimers();
    await render();
    await openView("Anki Mining");

    await act(async () => {
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-field-expression"
        ),
        DISABLED_FIELD_VALUE
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-field-definition"
        ),
        "Front"
      );
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-field-pitch"
        ),
        AUTO_FIELD_VALUE
      );
      await flushAutosave();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.objectContaining({
        fields: expect.objectContaining({
          expression: "",
          definition: "Front",
          pitch: ""
        }),
        disabledFields: ["expression"]
      })
    );
    expect(container.querySelector("button")?.textContent).not.toBe(
      "Save Mining Profile"
    );
  });

  it("preserves overrides and ignores stale note-type discovery", async () => {
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
      setSelectValue(
        container.querySelector<HTMLSelectElement>(
          "#hoshidicts-mining-field-expression"
        ),
        "Front"
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
      container.querySelector<HTMLSelectElement>(
        "#hoshidicts-mining-field-expression"
      )?.value
    ).toBe("Front");
    expect(container.textContent).toContain("Automatic → Glossary");
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
      "値"
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
      "Значення"
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
      valueHeader
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
      await openMining();
      expect(
        Array.from(
          container.querySelectorAll(".hoshidicts-mining-field-grid__header")
        ).map((header) => header.textContent)
      ).toEqual([fieldHeader, valueHeader]);
    }
  );

  it("normalizes legacy snapshots without dirtying new preferences", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...baseState,
      revision: undefined,
      activationKey: undefined,
      sourceHighlightEnabled: undefined,
      popupHideDelayMs: undefined,
      popupNestingMaxDepth: undefined,
      definitionBlur: undefined,
      audioProfile: undefined,
      dictionaries: [
        {
          ...baseState.dictionaries[0],
          enabled: undefined,
          frequencyCount: undefined,
          pitchCount: undefined,
          kanjiCount: undefined,
          frequencyMode: "invalid"
        }
      ],
      miningProfile: {
        ...baseState.miningProfile,
        disabledFields: undefined
      }
    });
    expect(normalized.revision).toBe(0);
    expect(normalized.activationKey).toBe(DEFAULT_HOSHIDICTS_ACTIVATION_KEY);
    expect(normalized.sourceHighlightEnabled).toBe(false);
    expect(normalized.popupHideDelayMs).toBe(300);
    expect(normalized.definitionBlur).toEqual(
      DEFAULT_HOSHIDICTS_DEFINITION_BLUR
    );
    expect(normalized.popupNestingMaxDepth).toBe(10);
    expect(normalized.dictionaries[0].enabled).toBe(true);
    expect(normalized.dictionaries[0]).toMatchObject({
      frequencyCount: 0,
      pitchCount: 0,
      kanjiCount: 0,
      frequencyMode: null
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
    expect(normalized.audioProfile).toEqual(baseState.audioProfile);
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
