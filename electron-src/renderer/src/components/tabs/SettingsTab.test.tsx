// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../i18n";
import { SettingsTab } from "./SettingsTab";

const invokeMock = vi.fn();
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

describe("SettingsTab data folder controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    listeners.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "settings.getSettings") {
        return {};
      }
      if (channel === "settings.getUpdateStatus") {
        return null;
      }
      if (channel === "data.getCurrentDir") {
        return "C:\\Data\\GameSentenceMiner";
      }
      if (channel === "data.getDefaultDir") {
        return "C:\\Users\\Tester\\AppData\\Roaming\\GameSentenceMiner";
      }
      if (channel === "data.relocate") {
        return { success: false, canceled: true };
      }
      if (channel === "data.restoreDefault") {
        return { success: false, canceled: true };
      }
      return {};
    });

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
              (listeners.get(channel) ?? []).filter((entry) => entry !== callback)
            );
          };
        }
      }
    });
    Object.defineProperty(window, "gsmEnv", {
      configurable: true,
      value: { platform: "win32" }
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

  it("shows and starts data relocation from the Settings tab", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsTab active />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Data Folder");
    expect(container.textContent).toContain(
      "Current folder: C:\\Data\\GameSentenceMiner"
    );
    expect(container.textContent).toContain("desktop app settings, overlay settings");
    expect(container.textContent).toContain(
      "Chromium session/storage and Yomitan data are not copied"
    );
    expect(container.textContent).toContain(
      "Original AppData folder: C:\\Users\\Tester\\AppData\\Roaming\\GameSentenceMiner"
    );

    const relocateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Change Data Folder..."
    );
    expect(relocateButton).toBeDefined();

    await act(async () => {
      relocateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("data.relocate");
    expect(container.textContent).toContain("Data folder change cancelled.");
  });

  it("offers a one-click return to the original AppData folder", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsTab active />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const restoreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Use Original AppData Folder"
    );
    expect(restoreButton).toBeDefined();

    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("data.restoreDefault");
    expect(container.textContent).toContain(
      "Return to the original AppData folder cancelled."
    );
  });

  it("manages Hoshidicts imports, updates, schedules, and removal from one card", async () => {
    const hoshidictsState = {
      dictionaries: [
        {
          id: "dictionary-id",
          title: "JMdict",
          revision: "2026-08-05",
          isUpdatable: true,
          indexUrl: "https://example.test/index.json",
          downloadUrl: "https://example.test/dictionary.zip",
          language: "ja",
          termCount: 123,
          installedAt: "2026-08-05T10:00:00.000Z"
        }
      ],
      recommendedDictionaries: [
        { id: "jmdict", installed: false },
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
      lastCheck: "2026-08-05T10:00:00.000Z",
      nextCheck: "2026-08-12T10:00:00.000Z",
      lastError: null,
      busy: false,
      progress: { phase: "idle" },
      effectiveEnabled: true
    };
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "settings.getSettings") return {};
      if (channel === "settings.getUpdateStatus") return null;
      if (channel === "data.getCurrentDir") return "C:\\Data\\GameSentenceMiner";
      if (channel === "data.getDefaultDir") return "C:\\Data\\GameSentenceMiner";
      if (channel === "hoshidicts.getState") return hoshidictsState;
      if (channel === "hoshidicts.setMiningProfile") {
        return {
          success: true,
          state: { ...hoshidictsState, miningProfile: args[0] }
        };
      }
      if (channel.startsWith("hoshidicts.")) {
        return { success: true, state: hoshidictsState };
      }
      return {};
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsTab active />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Hoshidicts Dictionaries");
    expect(container.textContent).toContain("Reader enabled");
    expect(container.textContent).toContain("JMdict");
    expect(container.textContent).toContain("Revision: 2026-08-05");
    expect(container.textContent).toContain("Language: ja");
    expect(container.textContent).toContain("123 terms");
    expect(container.textContent).toContain("Anki mining profile");
    expect(container.textContent).toContain("Recommended dictionaries");
    expect(container.textContent).toContain(
      "JMdict English (without proper names)"
    );
    expect(container.textContent).toContain("JMnedict");
    expect(container.textContent).not.toContain("KANJIDIC");

    const importButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Import Dictionary..."
    );
    const checkButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Check for Updates Now"
    );
    const installRecommendedButton = Array.from(
      container.querySelectorAll("button")
    ).find((button) => button.textContent === "Install JMdict + JMnedict");
    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove"
    );
    const schedule = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-update-schedule"
    );
    const miningEnabled = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-enabled"
    );
    const miningDeck = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-deck"
    );
    const miningModel = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-model"
    );
    const miningTags = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-tags"
    );
    const miningExpression = container.querySelector<HTMLInputElement>(
      "#hoshidicts-mining-field-expression"
    );
    const miningDuplicates = container.querySelector<HTMLSelectElement>(
      "#hoshidicts-mining-duplicates"
    );
    const setInputValue = (input: HTMLInputElement | null, value: string) => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    };

    await act(async () => {
      importButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      checkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      installRecommendedButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (schedule) {
        schedule.value = "monthly";
        schedule.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      miningEnabled?.click();
      setInputValue(miningDeck, "Mining");
      setInputValue(miningModel, "Custom");
      setInputValue(miningTags, "hoshidicts, custom");
      setInputValue(miningExpression, "Front");
      if (miningDuplicates) {
        miningDuplicates.value = "allow";
        miningDuplicates.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });

    const saveMiningButton = Array.from(
      container.querySelectorAll("button")
    ).find((button) => button.textContent === "Save Mining Profile");
    await act(async () => {
      saveMiningButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("hoshidicts.import");
    expect(invokeMock).toHaveBeenCalledWith("hoshidicts.checkUpdates");
    expect(invokeMock).toHaveBeenCalledWith("hoshidicts.installRecommended");
    expect(invokeMock).toHaveBeenCalledWith(
      "hoshidicts.remove",
      "dictionary-id"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "hoshidicts.setSchedule",
      "monthly"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "hoshidicts.setMiningProfile",
      expect.objectContaining({
        version: 1,
        enabled: false,
        deck: "Mining",
        model: "Custom",
        fields: expect.objectContaining({ expression: "Front" }),
        tags: ["hoshidicts", "custom"],
        duplicatePolicy: "allow"
      })
    );
  });

  it.each([
    ["ja", "Hoshidicts辞書", "辞書をインポート...", "Ankiマイニングプロファイル"],
    [
      "ukr",
      "Словники Hoshidicts",
      "Імпортувати словник...",
      "Профіль видобування Anki"
    ]
  ])("localizes the Hoshidicts card in %s", async (
    locale,
    title,
    importLabel,
    miningTitle
  ) => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "settings.getSettings") return { locale };
      if (channel === "settings.getUpdateStatus") return null;
      if (channel === "data.getCurrentDir") return "C:\\Data\\GameSentenceMiner";
      if (channel === "data.getDefaultDir") return "C:\\Data\\GameSentenceMiner";
      if (channel === "hoshidicts.getState") return {};
      return {};
    });
    await act(async () => {
      root.render(
        <I18nProvider initialLocale={locale}>
          <SettingsTab active />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain(importLabel);
    expect(container.textContent).toContain(miningTitle);
  });
});
