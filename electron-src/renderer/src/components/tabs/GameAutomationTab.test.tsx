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

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    runOverlayOnStartup = false;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "settings.getSettings") return { runOverlayOnStartup };
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
});
