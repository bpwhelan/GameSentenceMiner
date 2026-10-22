// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { GameAutomationTab } from "./GameAutomationTab";

const invokeMock = vi.fn();
const scene = { id: "scene-1", name: "Game" };

describe("GameAutomationTab overlay automation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let runOverlayOnStartup: boolean;
  let runOverlayWithActiveGame: boolean;

  beforeEach(() => {
    window.localStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    runOverlayOnStartup = false;
    runOverlayWithActiveGame = false;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "settings.getSettings") return { runOverlayOnStartup, runOverlayWithActiveGame };
      if (channel === "obs.getScenes") return [scene];
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "settings.getSceneLaunchProfile") return { launchOverlay: true };
      if (channel === "scene-switcher.getState") return {};
      return null;
    });
    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: { invoke: invokeMock, on: () => () => {} }
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function render(active = true) {
    await act(async () => {
      root.render(<I18nProvider><GameAutomationTab active={active} /></I18nProvider>);
    });
    return container.querySelector<HTMLInputElement>("#scene-launch-overlay-scene-1")!;
  }

  it("disables scene overlay automation when the Home startup option is enabled without clearing the saved choice", async () => {
    runOverlayOnStartup = true;
    const toggle = await render();

    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(toggle.dataset.tip).toContain("Run on startup");
    expect(container.querySelector("[title]")).toBeNull();
    await act(async () => toggle.click());
    expect(invokeMock).not.toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.anything());
  });

  it("refreshes the Home setting on tab activation and enables editing when startup is off", async () => {
    runOverlayOnStartup = true;
    await render();
    await render(false);
    runOverlayOnStartup = false;
    const toggle = await render();

    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(true);
    expect(toggle.dataset.tip).toContain("switching to an OBS scene");
    await act(async () => toggle.click());
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining({
      scene,
      launchOverlay: false
    }));
  });

  it("retains per-game preferences while universal active-game mode is enabled", async () => {
    runOverlayWithActiveGame = true;
    const toggle = await render();
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(toggle.dataset.tip).toContain("Open and close with active game");
    await act(async () => toggle.click());
    expect(invokeMock).not.toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.anything());
    await render(false);
    runOverlayWithActiveGame = false;
    expect((await render()).disabled).toBe(false);
  });

  it("keeps legacy launchers secondary and tool paths behind the shared-settings disclosure", async () => {
    await render();
    expect(container.querySelector<HTMLDetailsElement>(".launcher-legacy-details")?.open).toBe(false);
    expect(container.querySelector("#agent-path-input")).toBeNull();
    const shared = container.querySelector<HTMLButtonElement>("#automation-nav-shared")!;
    await act(async () => shared.click());
    expect(container.querySelector<HTMLElement>("#automation-view-scene")?.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>("#automation-view-shared")?.hidden).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-controls="tool-paths-legacy-panel"]')!.click());
    expect(container.querySelector("#agent-path-input")).not.toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.anything());
  });

  it("keeps an existing legacy profile editable without opening it for another scene", async () => {
    const otherScene = { id: "scene-2", name: "Other game" };
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel: string, payload: any) => {
      if (channel === "obs.getScenes") return [scene, otherScene];
      if (channel === "settings.getSceneLaunchProfile") return {
        textHookMode: payload.id === scene.id ? "agent" : "none",
        agentScriptPath: payload.id === scene.id ? "C:/scripts/game.js" : "",
      };
      return original(channel, payload);
    });
    await render();
    expect(container.querySelector<HTMLDetailsElement>(".launcher-legacy-details")?.open).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#scene-agent-script-scene-1")?.value).toBe("C:/scripts/game.js");
    await act(async () => {
      const selector = container.querySelector<HTMLSelectElement>("#launcher-scene-selector")!;
      selector.value = otherScene.id;
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector<HTMLDetailsElement>(".launcher-legacy-details")?.open).toBe(false);
    const autoOcr = container.querySelectorAll<HTMLInputElement>('input[name="ocr-mode-scene-2"]')[1];
    await act(async () => autoOcr.click());
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining({
      scene: otherScene, ocrMode: "auto", textHookMode: "none",
    }));
  });
});
