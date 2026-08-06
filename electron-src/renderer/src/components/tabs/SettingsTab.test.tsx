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

});
