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

async function openAddGameDialog(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>(".home-add-game")!;
  await act(async () => { trigger.focus(); trigger.click(); await flushAsyncWork(); });
  return container.querySelector<HTMLElement>("#home-new-capture")!;
}

async function openGameMenu(container: HTMLElement, sceneId: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`[data-game-menu-id="${sceneId}"]`)!;
  await act(async () => { trigger.focus(); trigger.click(); await flushAsyncWork(); });
  return document.querySelector<HTMLElement>("#home-game-menu")!;
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

    await openAddGameDialog(container);
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

  it("keeps the overlay, utilities, and connection controls available on Home", async () => {
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const overlayCard = container.querySelector(".home-overlay-card");
    const utilities = container.querySelector(".home-quick-actions");
    const statusCard = container.querySelector(".home-status-card");

    expect(container.querySelector("#home-new-capture")).toBeNull();
    expect(container.querySelector("#home-empty-game-heading")?.textContent).toBe("No games added yet.");
    expect(overlayCard).not.toBeNull();
    expect(utilities).not.toBeNull();
    expect(statusCard).not.toBeNull();

    expect(overlayCard?.textContent).toContain("Overlay");
    expect(overlayCard?.textContent).toContain("Run Overlay");
    expect(overlayCard?.textContent).toContain("Run on startup");
    expect(utilities?.textContent).toContain("Text feed");
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

  it("keeps sidebar statuses visible and updates them without a disclosure", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    let status = okStatus;
    invokeMock.mockImplementation(async (channel: string) => channel === "get_gsm_status" ? status : fallback(channel));
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });
    const statuses = container.querySelector<HTMLElement>(".home-library .home-status-card")!;
    expect(statuses.querySelector("[aria-expanded]")).toBeNull();
    expect(statuses.querySelector(".home-status-grid")?.closest("[hidden]")).toBeNull();
    expect(statuses.querySelector(".home-last-line")).toBeNull();
    const obs = Array.from(statuses.querySelectorAll("button")).find(button => button.textContent?.includes("OBS"))!;
    expect(obs.textContent).toContain("Connected");

    status = { ...okStatus, obs_connected: false };
    await advanceTimers(STATUS_POLL_MS);
    expect(obs.textContent).toContain("Disconnected");
    await act(async () => obs.click());
    expect(invokeMock).toHaveBeenCalledWith("openOBS");
  });

  it("filters a library of 50 games without changing the capture and scrolls the selected game into view", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    const scenes = Array.from({ length: 50 }, (_, index) => ({ id: `game-${index}`, name: `Game ${String(index + 1).padStart(2, "0")}` }));
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return scenes;
      if (channel === "obs.getActiveScene") return scenes[49];
      return fallback(channel);
    });
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      await act(async () => {
        root.render(<HomeTab active />);
        await flushAsyncWork();
      });
      expect(container.querySelectorAll(".home-game-button")).toHaveLength(50);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      const search = container.querySelector<HTMLInputElement>(".home-library-search input")!;
      await act(async () => setElementValue(search, " gAmE 4 ", "input"));
      expect(container.querySelectorAll(".home-game-button")).toHaveLength(10);
      expect(container.querySelector("#home-current-game-heading")?.textContent).toBe("Game 50");
      expect(invokeMock).not.toHaveBeenCalledWith("obs.switchScene.id", expect.anything());
      await act(async () => setElementValue(search, "missing", "input"));
      expect(container.querySelector(".home-library-empty")?.textContent).toBe("No matching games.");
      await act(async () => setElementValue(search, "", "input"));
      expect(container.querySelectorAll(".home-game-button")).toHaveLength(50);
      expect(container.querySelector('[aria-current="true"]')?.textContent).toBe("Game 50");
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("opens a game dialog, contains keyboard focus, and retains edits across closing and polling", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    const scene = { id: "saved-game", name: "Saved Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return [scene];
      if (channel === "obs.getActiveScene") return scene;
      return fallback(channel);
    });
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const toggle = container.querySelector<HTMLButtonElement>(".home-add-game")!;
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle.getAttribute("aria-haspopup")).toBe("dialog");
    expect(container.querySelector("#home-new-capture")).toBeNull();

    const setup = await openAddGameDialog(container);
    expect(setup.getAttribute("role")).toBe("dialog");
    expect(setup.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(container.querySelector("#home-window-select"));
    expect(container.querySelector<HTMLElement>(".home-current-game")?.hidden).toBe(false);
    expect(container.querySelector('[aria-current="true"]')?.textContent).toBe("Saved Game");
    await act(async () => {
      setElementValue(container.querySelector<HTMLSelectElement>("#home-window-select")!, "window-1", "change");
    });
    await act(async () => {
      setElementValue(container.querySelector<HTMLInputElement>("#home-scene-name-override")!, "My Capture", "input");
    });
    const controls = Array.from(setup.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)'));
    await act(async () => {
      controls[0].focus();
      controls[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(controls[controls.length - 1]);
    await act(async () => controls[controls.length - 1].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(controls[0]);
    await act(async () => setup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("#home-new-capture")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    await advanceTimers(3000);
    const reopened = await openAddGameDialog(container);
    expect(container.querySelector<HTMLInputElement>("#home-scene-name-override")?.value).toBe("My Capture");
    await act(async () => reopened.click());
    expect(container.querySelector("#home-new-capture")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("switches games from the library and returns from add-game setup to that game's tools", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    const scenes = [{ id: "first", name: "First Game" }, { id: "second", name: "Second Game" }];
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return scenes;
      if (channel === "obs.getActiveScene") return scenes[0];
      return fallback(channel);
    });
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });
    const addGame = container.querySelector<HTMLButtonElement>(".home-library [aria-controls='home-new-capture']")!;
    expect(addGame?.textContent).toContain("Add a game");
    await act(async () => addGame.click());
    expect(container.querySelector("#home-new-capture")?.getAttribute("role")).toBe("dialog");
    await act(async () => container.querySelector<HTMLElement>("#home-new-capture")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-scene-id="second"]')!.click());
    expect(invokeMock).toHaveBeenCalledWith("obs.switchScene.id", "second");
    expect(container.querySelector("#home-new-capture")).toBeNull();
    expect(container.querySelector("#home-current-game-heading")?.textContent).toBe("Second Game");
  });

  it("returns to the add-game prompt after the last saved game is removed", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    let scenes = [{ id: "only-game", name: "Only Game" }];
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return scenes;
      if (channel === "obs.getActiveScene") return scenes[0] ?? null;
      if (channel === "obs.removeScene") { scenes = []; return null; }
      return fallback(channel);
    });
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });
    const menu = await openGameMenu(container, "only-game");
    await act(async () => {
      menu.querySelector<HTMLButtonElement>(".home-game-menu__remove")!.click();
      await flushAsyncWork();
    });
    expect(invokeMock).toHaveBeenCalledWith("obs.removeScene", "only-game");
    expect(container.querySelector("#home-new-capture")).toBeNull();
    expect(container.querySelector(".home-empty-game button")?.textContent).toBe("Add a game");
    expect(container.querySelector<HTMLElement>(".home-current-game")?.hidden).toBe(true);
    expect(container.querySelector(".home-library-empty")?.textContent).toBe("No games added yet.");
    await act(async () => container.querySelector<HTMLButtonElement>(".home-empty-game button")!.click());
    expect(container.querySelector("#home-new-capture")?.getAttribute("role")).toBe("dialog");
  });

  it("keeps creation errors in the dialog, blocks duplicate submissions, and closes after a successful retry", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    let createdScene: { id: string; name: string } | null = null;
    let attempt = 0;
    let finishCreate: () => void = () => {};
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "settings.getSettings") return { textCaptureWizardEnabled: false };
      if (channel === "obs.getScenes") return createdScene ? [createdScene] : [];
      if (channel === "obs.getActiveScene") return createdScene;
      if (channel === "obs.getWindows") return [{
        title: "Example Game", value: "example-window", targetKind: "window",
        captureValues: { window_capture: "Example Game:Game:game.exe" },
      }];
      if (channel === "obs.createScene") {
        attempt += 1;
        return new Promise((resolve, reject) => {
          finishCreate = () => {
            if (attempt === 1) reject(new Error("OBS unavailable"));
            else { createdScene = { id: "created", name: "My Game" }; resolve(null); }
          };
        });
      }
      return fallback(channel);
    });
    await act(async () => { root.render(<HomeTab active />); await flushAsyncWork(); });
    const dialog = await openAddGameDialog(container);
    await act(async () => setElementValue(dialog.querySelector<HTMLSelectElement>("select")!, "example-window", "change"));
    await act(async () => setElementValue(dialog.querySelector<HTMLInputElement>("#home-scene-name-override")!, "My Game", "input"));
    const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => submit.click());
    expect(submit.disabled).toBe(true);
    await act(async () => {
      dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(attempt).toBe(1);
    expect(container.contains(dialog)).toBe(true);
    await act(async () => { finishCreate(); await flushAsyncWork(); });
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Could not set up capture");
    expect(dialog.querySelector<HTMLInputElement>("#home-scene-name-override")?.value).toBe("My Game");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await act(async () => { finishCreate(); await flushAsyncWork(); });
    expect(attempt).toBe(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("#home-current-game-heading")?.textContent).toBe("My Game");
    expect(container.querySelector('[aria-current="true"]')?.textContent).toBe("My Game");
  });

  it("opens another game's menu without changing capture, supports keyboard navigation, and targets rename and capture type correctly", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    const scenes = [{ id: "current", name: "Current Game" }, { id: "other", name: "Other Game" }];
    invokeMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "obs.getScenes") return scenes;
      if (channel === "obs.getActiveScene") return scenes[0];
      if (channel === "obs.getSceneCaptureMode") return payload === "other" ? "game_capture" : "window_capture";
      if (channel === "obs.switchSceneCaptureMode") return "window_capture";
      return fallback(channel);
    });
    await act(async () => { root.render(<HomeTab active />); await flushAsyncWork(); });
    let menu = await openGameMenu(container, "other");
    expect(container.querySelector("#home-current-game-heading")?.textContent).toBe("Current Game");
    expect(invokeMock).not.toHaveBeenCalledWith("obs.switchScene.id", expect.anything());
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(document.activeElement).toBe(items[0]);
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(items[items.length - 1]);
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items[0]);
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("#home-game-menu")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-game-menu-id="other"]'));

    menu = await openGameMenu(container, "other");
    await act(async () => Array.from(menu.querySelectorAll("button")).find(button => button.textContent === "Rename")!.click());
    const rename = container.querySelector<HTMLInputElement>(".home-modal input")!;
    expect(rename.value).toBe("Other Game");
    await act(async () => setElementValue(rename, "Renamed Game", "input"));
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>(".home-modal button")).find(button => button.textContent === "Rename")!.click();
      await flushAsyncWork();
    });
    expect(invokeMock).toHaveBeenCalledWith("obs.renameScene", { sceneUuid: "other", newSceneName: "Renamed Game" });

    menu = await openGameMenu(container, "other");
    await act(async () => {
      Array.from(menu.querySelectorAll("button")).find(button => button.textContent === "Switch to Window Capture")!.click();
      await flushAsyncWork();
    });
    expect(invokeMock).toHaveBeenCalledWith("obs.switchSceneCaptureMode", { sceneUuid: "other", targetMode: "window_capture" });
    expect(container.querySelector("#home-current-game-heading")?.textContent).toBe("Current Game");
    expect(invokeMock).not.toHaveBeenCalledWith("obs.switchScene.id", expect.anything());
  });

  it("removes an unselected game from its own menu and preserves the current game", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    let scenes = [{ id: "current", name: "Current Game" }, { id: "other", name: "Other Game" }];
    invokeMock.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "obs.getScenes") return scenes;
      if (channel === "obs.getActiveScene") return scenes[0];
      if (channel === "obs.removeScene") { scenes = scenes.filter(scene => scene.id !== payload); return null; }
      return fallback(channel);
    });
    await act(async () => { root.render(<HomeTab active />); await flushAsyncWork(); });
    const menu = await openGameMenu(container, "other");
    await act(async () => { menu.querySelector<HTMLButtonElement>(".home-game-menu__remove")!.click(); await flushAsyncWork(); });
    expect(invokeMock).toHaveBeenCalledWith("obs.removeScene", "other");
    expect(container.querySelectorAll(".home-game-button")).toHaveLength(1);
    expect(container.querySelector('[aria-current="true"]')?.textContent).toBe("Current Game");
    expect(document.querySelector("#home-game-menu")).toBeNull();
  });

  it("allows retrying a failed menu action and dismisses the menu when the library scrolls", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    const scene = { id: "game", name: "Game" };
    let fail = true;
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return [scene];
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "obs.getSceneCaptureMode") return "window_capture";
      if (channel === "obs.switchSceneCaptureMode") { if (fail) throw new Error("OBS unavailable"); return "game_capture"; }
      return fallback(channel);
    });
    await act(async () => { root.render(<HomeTab active />); await flushAsyncWork(); });
    let menu = await openGameMenu(container, "game");
    const switchButton = Array.from(menu.querySelectorAll("button")).find(button => button.textContent === "Switch to Game Capture")!;
    await act(async () => { switchButton.click(); await flushAsyncWork(); });
    expect(menu.querySelector('[role="alert"]')?.textContent).toContain("Could not update this game");
    expect(switchButton.disabled).toBe(false);
    fail = false;
    await act(async () => { switchButton.click(); await flushAsyncWork(); });
    expect(document.querySelector("#home-game-menu")).toBeNull();
    menu = await openGameMenu(container, "game");
    expect(menu).not.toBeNull();
    await act(async () => container.querySelector(".home-game-list")!.dispatchEvent(new Event("scroll")));
    expect(document.querySelector("#home-game-menu")).toBeNull();
  });

  it("does not close a newly opened menu when an earlier game's action finishes", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    const scenes = [{ id: "first", name: "First Game" }, { id: "second", name: "Second Game" }];
    let finishSwitch: (mode: string) => void = () => {};
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return scenes;
      if (channel === "obs.getActiveScene") return scenes[0];
      if (channel === "obs.getSceneCaptureMode") return "window_capture";
      if (channel === "obs.switchSceneCaptureMode") return new Promise(resolve => { finishSwitch = resolve; });
      return fallback(channel);
    });
    await act(async () => { root.render(<HomeTab active />); await flushAsyncWork(); });
    const firstMenu = await openGameMenu(container, "first");
    await act(async () => Array.from(firstMenu.querySelectorAll("button")).find(button => button.textContent === "Switch to Game Capture")!.click());
    await act(async () => firstMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const nextMenu = await openGameMenu(container, "second");
    await act(async () => { finishSwitch("game_capture"); await flushAsyncWork(); });
    expect(document.querySelector("#home-game-menu")).toBe(nextMenu);
    expect(nextMenu.contains(document.activeElement)).toBe(true);
  });

  it("switches between mutually exclusive overlay modes and restores both after a failed save", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    let saved = { runOverlayOnStartup: true, runOverlayWithActiveGame: false };
    let failSave = false;
    invokeMock.mockImplementation(async (channel: string, patch: Partial<typeof saved>) => {
      if (channel === "settings.getSettings") return saved;
      if (channel === "settings.saveSettings") {
        if (failSave) return { success: false };
        saved = { ...saved, ...patch };
        if (patch.runOverlayOnStartup) saved.runOverlayWithActiveGame = false;
        if (patch.runOverlayWithActiveGame) saved.runOverlayOnStartup = false;
        return { success: true, settings: saved };
      }
      return fallback(channel);
    });
    await act(async () => root.render(<I18nProvider><HomeTab active /></I18nProvider>));
    const startup = container.querySelector<HTMLInputElement>("#home-overlay-startup-toggle")!;
    const activeGame = container.querySelector<HTMLInputElement>("#home-overlay-active-game-toggle")!;
    expect(startup.checked).toBe(true);
    expect(activeGame.checked).toBe(false);
    await act(async () => activeGame.click());
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSettings", { runOverlayWithActiveGame: true });
    expect(startup.checked).toBe(false);
    expect(activeGame.checked).toBe(true);
    failSave = true;
    await act(async () => startup.click());
    expect(startup.checked).toBe(false);
    expect(activeGame.checked).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load or save");
    failSave = false;
    await act(async () => startup.click());
    expect(startup.checked).toBe(true);
    expect(activeGame.checked).toBe(false);
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
    expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);

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
      closeButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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

  it("groups monitors separately and creates a monitor scene without a window capture mode", async () => {
    const monitor: ObsWindow = {
      title: "Display 2: 2560x1440 @ 1920,0",
      value: '["monitor","display-2"]',
      targetKind: "monitor",
      monitorId: "display-2",
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") return okStatus;
      if (channel === "settings.getSettings") return { textCaptureWizardEnabled: false };
      if (channel === "obs.getScenes") return [];
      if (channel === "obs.getWindows") return [
        { title: "Game", value: "game", targetKind: "window" },
        { title: "Card", value: "card", targetKind: "capture_card" },
        monitor,
      ];
      return null;
    });

    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    await openAddGameDialog(container);
    const select = container.querySelector<HTMLSelectElement>("#home-window-select")!;
    const monitorGroup = select.querySelector('optgroup[label="Monitor Capture"]');
    expect(monitorGroup?.textContent).toContain(monitor.title);
    expect(select.querySelector('optgroup[label="Windows / Games"]')?.textContent).not.toContain(monitor.title);

    await act(async () => {
      setElementValue(select, monitor.value, "change");
      await flushAsyncWork();
    });

    expect(container.querySelector('input[name="home-capture-mode"]')).toBeNull();
    const setupButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Setup Capture",
    )!;
    expect(setupButton.disabled).toBe(false);

    await act(async () => {
      setElementValue(container.querySelector<HTMLInputElement>("#home-scene-name-override")!, "Freeflow", "input");
      await flushAsyncWork();
    });
    await act(async () => {
      setupButton.click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith("obs.createScene", expect.objectContaining({
      targetKind: "monitor", monitorId: "display-2", sceneName: "Freeflow", captureMode: undefined,
    }));
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
      root.render(
        <I18nProvider>
          <HomeTab active />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });

    await openAddGameDialog(container);
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

    const menu = await openGameMenu(container, scene.id);
    const switchButton = Array.from(menu.querySelectorAll("button")).find(
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

    const menu = await openGameMenu(container, scene.id);
    const wizardButton = Array.from(menu.querySelectorAll("button")).find(
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
