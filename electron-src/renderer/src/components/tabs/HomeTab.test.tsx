// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../i18n";
import { HomeTab } from "./HomeTab";
import type { GsmStatus, ObsWindow } from "../../types/models";

const invokeMock = vi.fn();
const sendMock = vi.fn();
const STATUS_POLL_MS = 1000;
const ANKI_BEACON_NUDGE_DELAY_MS = 15_000;
const ANKI_BEACON_WARNING_TEXT = "AnkiBeacon ⚠️";

const okStatus: GsmStatus = {
  ready: true,
  status: "Running",
  websockets_connected: {},
  obs_connected: true,
  anki_connected: true,
  anki_beacon_connected: true,
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

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await flushAsyncWork();
  });
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

    Object.defineProperty(window, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn(() => ""),
        writeText: vi.fn(),
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
      setupCard!.compareDocumentPosition(overlayCard!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      overlayCard!.compareDocumentPosition(utilities!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      utilities!.compareDocumentPosition(statusCard!) &
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

  it("starts the AnkiBeacon nudge delay only after Anki connects", async () => {
    let ankiConnected = false;
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") {
        return {
          ...okStatus,
          anki_connected: ankiConnected,
          anki_beacon_connected: false,
        };
      }
      if (channel === "settings.getSettings") return { runOverlayOnStartup: false };
      if (channel === "obs.getScenes") return [];
      if (channel === "obs.getActiveScene") return null;
      if (channel === "obs.getCaptureCardProbeEnabled") return false;
      if (channel === "obs.getWindows") return [];
      return null;
    });

    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    await advanceTimers(ANKI_BEACON_NUDGE_DELAY_MS);
    expect(container.textContent).not.toContain(ANKI_BEACON_WARNING_TEXT);

    ankiConnected = true;
    await advanceTimers(STATUS_POLL_MS);
    expect(container.textContent).not.toContain(ANKI_BEACON_WARNING_TEXT);

    await advanceTimers(ANKI_BEACON_NUDGE_DELAY_MS - 1);
    expect(container.textContent).not.toContain(ANKI_BEACON_WARNING_TEXT);

    await advanceTimers(1);
    expect(container.textContent).toContain(ANKI_BEACON_WARNING_TEXT);
  });

  it("opens AnkiBeacon install guidance from the yellow Anki status pill", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") {
        return {
          ...okStatus,
          anki_connected: true,
          anki_beacon_connected: false,
        };
      }
      if (channel === "settings.getSettings") return { runOverlayOnStartup: false };
      if (channel === "obs.getScenes") return [];
      if (channel === "obs.getActiveScene") return null;
      if (channel === "obs.getCaptureCardProbeEnabled") return false;
      if (channel === "obs.getWindows") return [];
      if (channel === "ankiBeacon.install") {
        return { success: false, error: "No application is associated with the file." };
      }
      return null;
    });

    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    expect(container.textContent).not.toContain(ANKI_BEACON_WARNING_TEXT);

    await advanceTimers(ANKI_BEACON_NUDGE_DELAY_MS - 1);
    expect(container.textContent).not.toContain(ANKI_BEACON_WARNING_TEXT);

    await advanceTimers(1);

    const ankiStatusButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(ANKI_BEACON_WARNING_TEXT),
    );
    expect(ankiStatusButton).toBeInstanceOf(HTMLButtonElement);
    expect(ankiStatusButton?.className).toContain("home-status-pill--warning");

    await act(async () => {
      (ankiStatusButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Install AnkiBeacon");

    const ankiWebLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent === "AnkiWeb",
    );
    const githubLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent === "GitHub",
    );
    expect(ankiWebLink).toBeInstanceOf(HTMLAnchorElement);
    expect(githubLink).toBeInstanceOf(HTMLAnchorElement);

    await act(async () => {
      (ankiWebLink as HTMLAnchorElement).click();
      (githubLink as HTMLAnchorElement).click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "open-external-link",
      "https://ankiweb.net/shared/info/1577021707",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "open-external-link",
      "https://github.com/bpwhelan/AnkiBeacon",
    );

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Install Now",
    );
    expect(installButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (installButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith("ankiBeacon.install");
    expect(container.textContent).toContain("AnkiWeb code");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Close"),
    ).toBe(true);

    const copyCodeButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("1577021707"),
    );
    expect(copyCodeButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (copyCodeButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(window.clipboard.writeText).toHaveBeenCalledWith("1577021707");

    const closeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Close",
    );
    expect(closeButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (closeButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(container.textContent).not.toContain("Install AnkiBeacon");
  });

  it("shows AnkiBeacon waiting state and closes the dialog when a heartbeat arrives", async () => {
    let ankiBeaconConnected = false;
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") {
        return {
          ...okStatus,
          anki_connected: true,
          anki_beacon_connected: ankiBeaconConnected,
        };
      }
      if (channel === "settings.getSettings") return { runOverlayOnStartup: false };
      if (channel === "obs.getScenes") return [];
      if (channel === "obs.getActiveScene") return null;
      if (channel === "obs.getCaptureCardProbeEnabled") return false;
      if (channel === "obs.getWindows") return [];
      if (channel === "ankiBeacon.install") return { success: true, filePath: "Anki.Beacon.ankiaddon" };
      return null;
    });

    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    await advanceTimers(ANKI_BEACON_NUDGE_DELAY_MS);

    const ankiStatusButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(ANKI_BEACON_WARNING_TEXT),
    );
    expect(ankiStatusButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (ankiStatusButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Install Now",
    );
    expect(installButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (installButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Waiting for AnkiBeacon signal");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Close"),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Install Now"),
    ).toBe(false);

    ankiBeaconConnected = true;
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("AnkiBeacon signal received");

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        root.render(<HomeTab active />);
        vi.advanceTimersByTime(300);
        await flushAsyncWork();
      });
    }

    expect(container.textContent).not.toContain("Install AnkiBeacon");
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

  it("opens the text capture wizard for the selected active scene", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") return okStatus;
      if (channel === "settings.getSettings") return { runOverlayOnStartup: false };
      if (channel === "obs.getScenes") return [scene];
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "obs.getSceneCaptureMode") return "window_capture";
      if (channel === "obs.getScenePreviewSnapshot") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          sourceName: "Example Game",
          captureMode: "window_capture",
          imageData: null,
        };
      }
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          exeName: "ExampleGame.exe",
        };
      }
      if (channel === "obs.getCaptureCardProbeEnabled") return false;
      if (channel === "obs.getWindows") return [];
      return null;
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <HomeTab active />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });

    const wizardButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Run Capture Wizard",
    );
    expect(wizardButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (wizardButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Text Capture Wizard");
    expect(invokeMock).toHaveBeenCalledWith("obs.getScenePreviewSnapshot", "scene-1");
  });
});
