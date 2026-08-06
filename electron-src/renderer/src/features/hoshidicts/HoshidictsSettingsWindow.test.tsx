// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOSHIDICTS_CHANNELS } from "../../../../shared/features/hoshidicts";
import { I18nProvider } from "../../i18n";
import {
  HoshidictsSettingsWindow,
  normalizeHoshidictsDesktopState
} from "./HoshidictsSettingsWindow";

const invokeMock = vi.fn();
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

const state = {
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
    tags: ["hoshidicts"],
    duplicatePolicy: "prevent"
  },
  schedule: "weekly",
  lastCheck: "2026-08-06T10:00:00.000Z",
  nextCheck: "2026-08-13T10:00:00.000Z",
  lastError: null,
  busy: false,
  progress: { phase: "idle" },
  overlay: {
    running: true,
    restartRequired: true
  }
} as const;

function setInputValue(input: HTMLInputElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input?.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("HoshidictsSettingsWindow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    listeners.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === HOSHIDICTS_CHANNELS.getState) {
          return state;
        }
        if (channel === HOSHIDICTS_CHANNELS.setMiningProfile) {
          return {
            success: true,
            state: { ...state, miningProfile: args[0] }
          };
        }
        if (channel.startsWith("hoshidicts.")) {
          return { success: true, state };
        }
        return {};
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
    await act(async () => {
      root.unmount();
    });
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

  it("owns dictionary, update, ordering, and restart controls", async () => {
    await render();

    expect(container.querySelector("h1")?.textContent).toBe("Hoshidicts");
    expect(container.textContent).toContain("Enabled in GSM Experimental");
    expect(container.textContent).toContain("Recommended dictionaries");
    expect(container.textContent).toContain("Installed dictionaries");
    expect(container.textContent).toContain("JMdict");
    expect(container.textContent).toContain("123 terms");
    expect(container.textContent).not.toContain("KANJIDIC");

    const buttons = Array.from(container.querySelectorAll("button"));
    const importButton = buttons.find((button) =>
      button.textContent?.includes("Import Dictionary")
    );
    const checkButton = buttons.find((button) =>
      button.textContent?.includes("Check for Updates")
    );
    const installButton = buttons.find(
      (button) => button.textContent?.trim() === "Install"
    );
    const restartButton = buttons.find((button) =>
      button.textContent?.includes("Restart Overlay")
    );
    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove"]'
    );
    const moveDownButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move down"]'
    );
    const schedule = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-update-schedule"
    );
    const dictionaryToggles = container.querySelectorAll<HTMLInputElement>(
      ".hoshidicts-dictionary-row__toggle input"
    );

    await act(async () => {
      importButton?.click();
      checkButton?.click();
      installButton?.click();
      restartButton?.click();
      removeButton?.click();
      moveDownButton?.click();
      dictionaryToggles[1]?.click();
      if (schedule) {
        schedule.value = "monthly";
        schedule.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.importDictionary
    );
    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.checkUpdates);
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.installRecommended,
      { id: "jmnedict" }
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.removeDictionary,
      "jmdict-id"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.moveDictionary,
      { id: "jmdict-id", direction: 1 }
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setDictionaryEnabled,
      { id: "custom-id", enabled: true }
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setSchedule,
      "monthly"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.restartOverlay
    );
  });

  it("keeps mining in a separate tab and saves a typed profile", async () => {
    await render();
    const miningTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Anki Mining"
    );
    await act(async () => {
      miningTab?.click();
    });

    const deck = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-deck"
    );
    const expression = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-field-expression"
    );
    const tags = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-tags"
    );
    const fields = container.querySelector("details");
    await act(async () => {
      if (fields) {
        fields.open = true;
      }
      setInputValue(deck, "Mining");
      setInputValue(expression, "Front");
      setInputValue(tags, "hoshidicts, custom");
      await Promise.resolve();
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Mining Profile"
    );
    expect(saveButton?.disabled).toBe(false);
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      HOSHIDICTS_CHANNELS.setMiningProfile,
      expect.objectContaining({
        deck: "Mining",
        fields: expect.objectContaining({ expression: "Front" }),
        tags: ["hoshidicts", "custom"]
      })
    );
  });

  it("refreshes the GSM Experimental status when the window regains focus", async () => {
    await render();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === HOSHIDICTS_CHANNELS.getState) {
        return { ...state, effectiveEnabled: false };
      }
      return { success: true, state };
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Disabled in GSM Experimental");
    expect(invokeMock).toHaveBeenCalledWith(HOSHIDICTS_CHANNELS.getState);
  });

  it.each([
    ["ja", "辞書とマイニングの設定", "おすすめの辞書"],
    ["ukr", "Налаштування словників і видобування", "Рекомендовані словники"]
  ])("localizes the standalone window in %s", async (locale, subtitle, recommended) => {
    await render(locale);
    expect(container.textContent).toContain(subtitle);
    expect(container.textContent).toContain(recommended);
  });

  it("normalizes legacy dictionaries as enabled", () => {
    const normalized = normalizeHoshidictsDesktopState({
      ...state,
      dictionaries: [{ ...state.dictionaries[0], enabled: undefined }]
    });
    expect(normalized.dictionaries[0].enabled).toBe(true);
  });
});
