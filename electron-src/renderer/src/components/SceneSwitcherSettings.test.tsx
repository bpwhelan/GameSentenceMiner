// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "../i18n";
import { SceneSwitcherSettings } from "./SceneSwitcherSettings";

const invokeMock = vi.fn();

describe("SceneSwitcherSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "scene-switcher.getState") {
        return {
          supported: true,
          hookStatus: "running",
          obsConnected: true,
          collectionName: "Games",
          migrationReady: true,
          rule: null,
          foreground: null
        };
      }
      if (channel === "scene-switcher.suggestRule") {
        return { titlePattern: ".*Game Title.*", executableName: "game.exe" };
      }
      return { success: true };
    });

    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke: invokeMock,
        on: () => () => {}
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

  it("adds the generated default regular expression from the capture source", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <SceneSwitcherSettings scene={{ id: "scene-1", name: "Game" }} />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const addDefaultRegexButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Use Capture Source"
    );
    expect(addDefaultRegexButton).toBeDefined();

    await act(async () => {
      addDefaultRegexButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("scene-switcher.suggestRule", "scene-1");
    expect(
      (container.querySelector("#scene-switcher-pattern-scene-1") as HTMLInputElement).value
    ).toBe(".*Game Title.*");
    expect(container.textContent).toContain("Loaded the current OBS capture source.");
  });

  it("enables a GSM rule without a separate collection switch", async () => {
    let enabled = false;
    invokeMock.mockImplementation(async (channel: string, payload?: { enabled: boolean }) => {
      if (channel === "scene-switcher.getState") {
        return {
          supported: true,
          hookStatus: "running",
          obsConnected: true,
          collectionName: "Games",
          migrationReady: true,
          rule: { titlePattern: ".*Game Title.*", enabled },
          foreground: null
        };
      }
      if (channel === "scene-switcher.saveRule") {
        enabled = payload?.enabled === true;
        return { success: true };
      }
      throw new Error(`Unexpected channel: ${channel}`);
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <SceneSwitcherSettings scene={{ id: "scene-1", name: "Game" }} />
        </I18nProvider>
      );
    });

    const toggle = container.querySelector("#scene-switcher-rule-scene-1") as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await act(async () => {
      toggle.click();
    });

    expect(invokeMock).toHaveBeenCalledWith("scene-switcher.saveRule", {
      sceneUuid: "scene-1",
      sceneName: "Game",
      titlePattern: ".*Game Title.*",
      enabled: true
    });
    expect(enabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(container.textContent).not.toContain("Failed to save");
  });
});
