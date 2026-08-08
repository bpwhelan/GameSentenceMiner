// @vitest-environment jsdom
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  HOSHIDICTS_CHANNELS,
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
      termCount: 20,
      installedAt: "2026-08-06T11:00:00.000Z"
    }
  ],
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
      pitch: ""
    },
    disabledFields: [],
    tags: ["hoshidicts"],
    duplicatePolicy: "prevent"
  },
  lookupMode: "shift",
  activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  sourceHighlightEnabled: false,
  popupHideDelayMs: 300,
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
    "Front"
  ],
  suggestedFields: {
    expression: "Expression",
    reading: "ExpressionReading",
    definition: "Glossary",
    sentence: "Sentence",
    frequency: "Frequency",
    pitch: "PitchPosition"
  },
  resolvedFields: {
    expression: "Expression",
    reading: "ExpressionReading",
    definition: "Glossary",
    sentence: "Sentence",
    frequency: "Frequency",
    pitch: "PitchPosition"
  },
  warnings: [],
  error: null
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

  async function openMining() {
    const miningTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Anki Mining"
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
    expect(getReadiness(baseState).kind).toBe("ready");
  });

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
      buttonContaining("Install JMdict + JMnedict")?.click();
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
      { id: "jmnedict" }
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

    await act(async () => {
      hover?.click();
      setInputValue(delay, "850");
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setReaderPreferences,
      {
        lookupMode: "hover",
        activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
        sourceHighlightEnabled: false,
        popupHideDelayMs: 850
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
        popupHideDelayMs: 300
      }
    );
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
        popupHideDelayMs: 300
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
        popupHideDelayMs: 300
      }
    );
  });

  it("loads Anki on entry without dirtying or pinning automatic mappings", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();
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
    expect(container.textContent).toContain("6 of 6 fields mapped");
  });

  it("auto-saves automatic, disabled, and explicit field choices", async () => {
    vi.useFakeTimers();
    await render();
    await openMining();

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
      await vi.advanceTimersByTimeAsync(450);
      await Promise.resolve();
      await Promise.resolve();
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
    await openMining();
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
      "辞書とマイニングの設定",
      "おすすめの辞書",
      "キーを変更",
      "Shiftに戻す",
      "検索語をハイライト"
    ],
    [
      "ukr",
      "Налаштування словників і видобування",
      "Рекомендовані словники",
      "Змінити клавішу",
      "Скинути до Shift",
      "Підсвічувати знайдене слово"
    ]
  ])("localizes the standalone window in %s", async (
    locale,
    subtitle,
    recommended,
    changeKey,
    resetKey,
    sourceHighlight
  ) => {
    await render(locale);
    expect(container.textContent).toContain(subtitle);
    expect(container.textContent).toContain(recommended);
    expect(container.textContent).toContain(changeKey);
    expect(container.textContent).toContain(resetKey);
    expect(container.textContent).toContain(sourceHighlight);
  });

  it("normalizes legacy snapshots without dirtying new preferences", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...baseState,
      revision: undefined,
      activationKey: undefined,
      sourceHighlightEnabled: undefined,
      popupHideDelayMs: undefined,
      dictionaries: [{ ...baseState.dictionaries[0], enabled: undefined }],
      miningProfile: {
        ...baseState.miningProfile,
        disabledFields: undefined
      }
    });
    expect(normalized.revision).toBe(0);
    expect(normalized.activationKey).toBe(DEFAULT_HOSHIDICTS_ACTIVATION_KEY);
    expect(normalized.sourceHighlightEnabled).toBe(false);
    expect(normalized.popupHideDelayMs).toBe(300);
    expect(normalized.dictionaries[0].enabled).toBe(true);
    expect(normalized.miningProfile.disabledFields).toEqual([]);
  });
});
