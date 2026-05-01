// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeTab } from "./HomeTab";
import type { GsmStatus, ObsWindow } from "../../types/models";

const invokeMock = vi.fn();
const sendMock = vi.fn();

const okStatus: GsmStatus = {
  ready: true,
  status: "Running",
  websockets_connected: {},
  obs_connected: true,
  anki_connected: true,
  clipboard_enabled: true,
};

function setElementValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  eventName: "input" | "change",
) {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("HomeTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let windowFetchCount: number;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invokeMock.mockReset();
    sendMock.mockReset();
    windowFetchCount = 0;

    const firstWindowList: ObsWindow[] = [
      {
        title: "Original Window Title",
        value: "window-1",
        targetKind: "window",
      },
    ];
    const refreshedWindowList: ObsWindow[] = [
      {
        title: "Refreshed Window Title",
        value: "window-1",
        targetKind: "window",
      },
    ];

    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") {
        return okStatus;
      }
      if (channel === "settings.getSettings") {
        return { runOverlayOnStartup: false };
      }
      if (channel === "settings.saveSettings") {
        return { success: true, settings: { runOverlayOnStartup: true } };
      }
      if (channel === "obs.getScenes") {
        return [];
      }
      if (channel === "obs.getActiveScene") {
        return null;
      }
      if (channel === "obs.getCaptureCardProbeEnabled") {
        return false;
      }
      if (channel === "obs.getWindows") {
        windowFetchCount += 1;
        return windowFetchCount === 1 ? firstWindowList : refreshedWindowList;
      }
      return null;
    });

    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke: invokeMock,
        send: sendMock,
        on: () => () => {},
        once: () => {},
        removeListener: () => {},
        removeAllListeners: () => {},
      },
    });

    Object.defineProperty(window, "gsmEnv", {
      configurable: true,
      value: {
        platform: "win32",
      },
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
    vi.useRealTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("does not overwrite a manually edited override scene name during window refresh polling", async () => {
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const windowSelect = container.querySelector("#home-window-select");
    expect(windowSelect).toBeInstanceOf(HTMLSelectElement);

    await act(async () => {
      setElementValue(windowSelect as HTMLSelectElement, "window-1", "change");
      await flushAsyncWork();
    });

    const overrideInput = container.querySelector("#home-scene-name-override");
    expect(overrideInput).toBeInstanceOf(HTMLInputElement);
    expect((overrideInput as HTMLInputElement).value).toBe("Original Window Title");

    await act(async () => {
      setElementValue(overrideInput as HTMLInputElement, "My Custom Scene", "input");
      await flushAsyncWork();
    });

    expect((overrideInput as HTMLInputElement).value).toBe("My Custom Scene");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await flushAsyncWork();
    });

    const overrideInputAfterRefresh = container.querySelector("#home-scene-name-override");
    expect(overrideInputAfterRefresh).toBeInstanceOf(HTMLInputElement);
    expect((overrideInputAfterRefresh as HTMLInputElement).value).toBe("My Custom Scene");
  });

  it("renders overlay as a dedicated card between setup capture and utilities", async () => {
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const setupCard = container.querySelector(".home-setup-card");
    const overlayCard = container.querySelector(".home-overlay-card");
    const utilities = container.querySelector(".home-quick-actions");
    const statusCard = container.querySelector(".home-status-card");

    expect(setupCard).not.toBeNull();
    expect(overlayCard).not.toBeNull();
    expect(utilities).not.toBeNull();
    expect(statusCard).not.toBeNull();

    expect(
      setupCard?.compareDocumentPosition(overlayCard as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      overlayCard?.compareDocumentPosition(utilities as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      utilities?.compareDocumentPosition(statusCard as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(overlayCard?.textContent).toContain("Overlay");
    expect(overlayCard?.textContent).toContain("Run Overlay");
    expect(overlayCard?.textContent).toContain("Run on startup");
    expect(utilities?.textContent).toContain("Utilities");
    expect(utilities?.textContent).not.toContain("Run Overlay");

    const guideButton = container.querySelector(".home-overlay-guide-btn");
    expect(guideButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (guideButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "open-external-link",
      "https://docs.gamesentenceminer.com/docs/features/overlay",
    );
  });

  it("persists the overlay startup toggle from the overlay card", async () => {
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const startupToggle = container.querySelector("#home-overlay-startup-toggle");
    expect(startupToggle).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      (startupToggle as HTMLInputElement).click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "settings.saveSettings",
      { runOverlayOnStartup: true },
    );
  });

  it("sends the selected capture mode when creating a scene", async () => {
    invokeMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "get_gsm_status") return okStatus;
      if (channel === "settings.getSettings") return { runOverlayOnStartup: false };
      if (channel === "obs.getScenes") return [];
      if (channel === "obs.getActiveScene") return null;
      if (channel === "obs.getCaptureCardProbeEnabled") return false;
      if (channel === "obs.getWindows") {
        return [
          {
            title: "Example Game",
            value: "example-window",
            targetKind: "window",
            captureValues: {
              window_capture: "Example Game:GameWindowClass:ExampleGame.exe",
              game_capture: "Example Game:GameWindowClass:ExampleGame.exe",
            },
          },
        ];
      }
      if (channel === "obs.createScene") return { ok: true, payload };
      return null;
    });

    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const windowSelect = container.querySelector("#home-window-select");
    expect(windowSelect).toBeInstanceOf(HTMLSelectElement);

    await act(async () => {
      setElementValue(windowSelect as HTMLSelectElement, "example-window", "change");
      await flushAsyncWork();
    });

    const windowCaptureRadio = container.querySelector(
      'input[name="home-capture-mode"][value="window_capture"]',
    );
    expect(windowCaptureRadio).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      (windowCaptureRadio as HTMLInputElement).click();
      await flushAsyncWork();
    });

    const setupButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Setup Capture",
    );
    expect(setupButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (setupButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "obs.createScene",
      expect.objectContaining({
        title: "Example Game",
        captureMode: "window_capture",
      }),
    );
  });

  it("shows and invokes the scene capture switch action", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") return okStatus;
      if (channel === "settings.getSettings") return { runOverlayOnStartup: false };
      if (channel === "obs.getScenes") return [scene];
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "obs.getSceneCaptureMode") return "window_capture";
      if (channel === "obs.switchSceneCaptureMode") return "game_capture";
      if (channel === "obs.getCaptureCardProbeEnabled") return false;
      if (channel === "obs.getWindows") return [];
      return null;
    });

    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const switchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Switch to Game Capture",
    );
    expect(switchButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (switchButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith("obs.switchSceneCaptureMode", {
      sceneUuid: "scene-1",
      targetMode: "game_capture",
    });
  });
});
