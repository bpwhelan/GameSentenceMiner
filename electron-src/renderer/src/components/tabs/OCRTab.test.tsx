// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../i18n";
import { OCRTab } from "./OCRTab";

const invokeMock = vi.fn();
const sendMock = vi.fn();

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  }
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};

    loadAddon() {}
    open() {}
    onData() {}
    attachCustomKeyEventHandler() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    clearSelection() {}
    clear() {}
    writeln() {}
    write() {}
    dispose() {}
  }
}));

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OCRTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invokeMock.mockReset();
    sendMock.mockReset();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return {
          manualOcrHotkey: "A",
          manualOcrGamepad: "0",
          areaSelectOcrHotkey: "Ctrl+Shift+A",
          areaSelectOcrGamepad: "",
          wholeWindowOcrHotkey: "Ctrl+Shift+W",
          wholeWindowOcrGamepad: "",
          globalPauseHotkey: "Shift+A",
          globalPauseGamepad: "9"
        };
      }
      return null;
    });

    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke: invokeMock,
        send: sendMock,
        on: () => () => {}
      }
    });
    Object.defineProperty(window, "gsmEnv", {
      configurable: true,
      value: { platform: "win32" }
    });
    Object.defineProperty(window, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(() => ""), writeText: vi.fn() }
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
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("switches workspace views and sub-tabs without losing configured controls", async () => {
    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    const recognition = container.querySelector<HTMLElement>("#ocr-view-recognition")!;
    const filtering = container.querySelector<HTMLElement>("#ocr-view-filtering")!;
    const comparison = container.querySelector<HTMLElement>("#ocr-view-comparison")!;
    const shortcuts = container.querySelector<HTMLElement>("#ocr-view-shortcuts")!;
    const binding = container.querySelector<HTMLInputElement>("#manual-hotkey")!;
    const initialBinding = binding.value;
    expect(container.querySelector<HTMLElement>("#ocr-view-capture")!.hidden).toBe(false);
    expect(recognition.hidden).toBe(true);
    expect(filtering.hidden).toBe(true);
    expect(comparison.hidden).toBe(true);
    expect(shortcuts.hidden).toBe(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#ocr-nav-filtering")!.click();
    });
    expect(recognition.hidden).toBe(true);
    expect(filtering.hidden).toBe(false);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#ocr-nav-comparison")!.click();
    });
    expect(filtering.hidden).toBe(true);
    expect(comparison.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#ocr-comp-panel-primary")!.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#ocr-comp-panel-truncation")!.hidden).toBe(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#ocr-comp-tab-truncation")!.click();
    });
    expect(container.querySelector<HTMLElement>("#ocr-comp-panel-primary")!.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>("#ocr-comp-panel-truncation")!.hidden).toBe(false);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#ocr-nav-shortcuts")!.click();
    });
    expect(comparison.hidden).toBe(true);
    expect(shortcuts.hidden).toBe(false);
    expect(container.querySelector("#manual-hotkey")).toBe(binding);
    expect(binding.value).toBe(initialBinding);
    expect(container.querySelector("#ocr-nav-shortcuts")?.getAttribute("aria-selected")).toBe(
      "true"
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#ocr-nav-recognition")!.click();
    });
    expect(recognition.hidden).toBe(false);
    expect(shortcuts.hidden).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("#ocr-nav-recognition")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(container.querySelector<HTMLElement>("#ocr-view-capture")!.hidden).toBe(false);
    expect(document.activeElement?.id).toBe("ocr-nav-capture");
  });

  it.each([
    { view: "comparison", prefix: "ocr-comp", tabs: ["primary", "truncation", "subset"] },
    { view: "tools", prefix: "ocr-tools", tabs: ["diagnostics", "packages", "files"] }
  ])("supports keyboard navigation within the $view sub-tabs", async ({ view, prefix, tabs }) => {
    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#ocr-nav-" + view)!.click();
    });

    const tab = (index: number) =>
      container.querySelector<HTMLButtonElement>("#" + prefix + "-tab-" + tabs[index])!;
    const panel = (index: number) =>
      container.querySelector<HTMLElement>("#" + prefix + "-panel-" + tabs[index])!;
    tab(0).focus();
    const navigation = [
      ["ArrowRight", 1],
      ["End", 2],
      ["ArrowRight", 0],
      ["ArrowLeft", 2],
      ["Home", 0]
    ] as const;
    for (const [key, expected] of navigation) {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
      expect(document.activeElement).toBe(tab(expected));
      expect(tab(expected).tabIndex).toBe(0);
      expect(tab(expected).getAttribute("aria-selected")).toBe("true");
      expect(panel(expected).hidden).toBe(false);
      for (let index = 0; index < tabs.length; index++) {
        if (index !== expected) {
          expect(tab(index).tabIndex).toBe(-1);
          expect(panel(index).hidden).toBe(true);
        }
      }
    }
  });

  it("opens and closes the console without losing its terminal or the current settings page", async () => {
    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });
    const consolePanel = container.querySelector<HTMLElement>("#ocr-view-console")!;
    const terminal = container.querySelector("#ocr-console-output");
    const toggle = container.querySelector<HTMLButtonElement>("#ocr-console-toggle")!;
    expect(consolePanel.hidden).toBe(true);
    expect(terminal).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#ocr-nav-filtering")!.click();
    });
    for (const open of [true, false, true, false]) {
      await act(async () => {
        toggle.click();
      });
      expect(consolePanel.hidden).toBe(!open);
      expect(toggle.getAttribute("aria-expanded")).toBe(String(open));
      expect(container.querySelector<HTMLElement>("#ocr-view-filtering")!.hidden).toBe(open);
      expect(container.querySelector("#ocr-console-output")).toBe(terminal);
    }
    await act(async () => { toggle.click(); });
    await act(async () => {
      consolePanel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(consolePanel.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("ocr-nav-filtering");
  });

  it("runs quick-capture actions through the existing OCR commands", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-running-state") return { isRunning: true, mode: "manual" };
      return null;
    });
    await act(async () => {
      root.render(<OCRTab active />);
      await flushAsyncWork();
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>(".desk-quick-actions button");
    const channels = [
      "ocr.manual-ocr",
      "ocr.menu-ocr",
      "ocr.area-select-ocr",
      "ocr.whole-window-ocr"
    ];
    expect(buttons).toHaveLength(channels.length);
    for (let index = 0; index < channels.length; index++) {
      expect(buttons[index].disabled).toBe(false);
      await act(async () => {
        buttons[index].click();
      });
      expect(sendMock).toHaveBeenLastCalledWith(channels[index]);
    }
  });

  it.each([
    ["Start Auto OCR", "ocr.start-ocr"],
    ["Start Manual OCR", "ocr.start-ocr-ss-only"]
  ])("starts the requested session from %s", async (label, channel) => {
    await act(async () => {
      root.render(<I18nProvider><OCRTab active={false} /></I18nProvider>);
      await flushAsyncWork();
    });
    const start = [...container.querySelectorAll<HTMLButtonElement>(".desk-transport-actions button")]
      .find((button) => button.textContent === label)!;
    await act(async () => { start.click(); await flushAsyncWork(); });
    expect(sendMock).toHaveBeenLastCalledWith(channel);
    expect(container.querySelector(".desk-transport-actions")?.textContent).toContain("Stop OCR");
    expect(container.querySelector<HTMLElement>("#ocr-view-capture")!.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#ocr-view-console")!.hidden).toBe(true);
  });

  it("opens the existing area selector from the saved layout", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return [{ id: "scene-1", name: "Example Game" }];
      if (channel === "obs.getActiveScene") return { id: "scene-1", name: "Example Game" };
      if (channel === "ocr.getActiveOCRConfig") return { coordinate_system: "percentage", rectangles: [{ coordinates: [0.1, 0.7, 0.8, 0.2] }] };
      return null;
    });
    await act(async () => { root.render(<I18nProvider><OCRTab active /></I18nProvider>); await flushAsyncWork(); });
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(1);
    const map = container.querySelector<HTMLButtonElement>(".desk-map-canvas")!;
    expect(map.disabled).toBe(false);
    await act(async () => { map.click(); });
    expect(sendMock).toHaveBeenLastCalledWith("ocr.run-screen-selector");
  });

  it("saves each output-table checkbox to its own capture mode", async () => {
    await act(async () => {
      root.render(<OCRTab active />);
      await flushAsyncWork();
    });
    for (const [mode, clipboardKey, newlineKey] of [
      ["auto", "send_to_clipboard_auto", "keep_newline_auto"],
      ["menu", "send_to_clipboard_menu", "keep_newline_menu"],
      ["area-select", "send_to_clipboard_area_select", "keep_newline_area_select"]
    ]) {
      const clipboard = container.querySelector<HTMLInputElement>("#send-to-clipboard-" + mode)!;
      const newline = container.querySelector<HTMLInputElement>("#keep-newline-" + mode)!;
      const nextClipboard = !clipboard.checked;
      const nextNewline = !newline.checked;
      await act(async () => {
        clipboard.click();
        newline.click();
        await flushAsyncWork();
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
        await flushAsyncWork();
      });
      expect(sendMock).toHaveBeenLastCalledWith("ocr.save-ocr-config", expect.objectContaining({
        [clipboardKey]: nextClipboard,
        [newlineKey]: nextNewline
      }));
    }
  });

  it("loads and saves each autostart mode while preserving the latest game automation settings", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    let profile = {
      sceneId: scene.id,
      sceneName: scene.name,
      textHookMode: "agent",
      ocrMode: "manual",
      launchOverlay: true,
      agentScriptPath: "game.js",
      launchDelaySeconds: 3
    };
    invokeMock.mockImplementation(async (channel: string, payload: any) => {
      if (channel === "obs.getScenes") return [scene];
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "settings.getSceneLaunchProfile") return profile;
      if (channel === "settings.saveSceneLaunchProfile") {
        profile = { ...profile, ...payload };
        return { success: true };
      }
      return null;
    });

    await act(async () => {
      root.render(<I18nProvider><OCRTab active /></I18nProvider>);
      await flushAsyncWork();
    });

    const autostart = container.querySelector<HTMLSelectElement>("#ocr-autostart-mode");
    expect(autostart).toBeInstanceOf(HTMLSelectElement);
    expect(autostart!.value).toBe("manual");
    expect(autostart!.disabled).toBe(false);

    profile = { ...profile, agentScriptPath: "updated-game.js", launchDelaySeconds: 5 };
    for (const mode of ["auto", "manual", "none"]) {
      await act(async () => {
        autostart!.value = mode;
        autostart!.dispatchEvent(new Event("change", { bubbles: true }));
        await flushAsyncWork();
      });

      expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", {
        scene,
        textHookMode: "agent",
        ocrMode: mode,
        launchOverlay: true,
        agentScriptPath: "updated-game.js",
        launchDelaySeconds: 5
      });
      expect(autostart!.value).toBe(mode);
    }
  });

  it("refreshes autostart for the selected game and creates a profile when needed", async () => {
    const scenes = [
      { id: "scene-1", name: "First Game" },
      { id: "scene-2", name: "Second Game" }
    ];
    let activeScene = scenes[0];
    let secondMode = "none";
    invokeMock.mockImplementation(async (channel: string, payload: any) => {
      if (channel === "obs.getScenes") return scenes;
      if (channel === "obs.getActiveScene") return activeScene;
      if (channel === "obs.switchScene.id") {
        activeScene = scenes.find((scene) => scene.id === payload)!;
      }
      if (channel === "settings.getSceneLaunchProfile") {
        if (payload.id === scenes[0].id) return { ocrMode: "auto" };
        return secondMode === "none" ? null : { ocrMode: secondMode };
      }
      if (channel === "settings.saveSceneLaunchProfile") {
        secondMode = payload.ocrMode;
        return { success: true };
      }
      return null;
    });

    await act(async () => {
      root.render(<I18nProvider><OCRTab active /></I18nProvider>);
      await flushAsyncWork();
    });
    const autostart = container.querySelector<HTMLSelectElement>("#ocr-autostart-mode");
    expect(autostart?.value).toBe("auto");

    await act(async () => {
      const sceneSelect = container.querySelector<HTMLSelectElement>("#ocr-scene-select")!;
      sceneSelect.value = scenes[1].id;
      sceneSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });
    expect(autostart!.value).toBe("none");

    await act(async () => {
      autostart!.value = "manual";
      autostart!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", {
      scene: scenes[1],
      textHookMode: "none",
      ocrMode: "manual",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0
    });

    await act(async () => {
      root.render(<I18nProvider><OCRTab active={false} /></I18nProvider>);
      await flushAsyncWork();
    });
    secondMode = "auto";
    await act(async () => {
      root.render(<I18nProvider><OCRTab active /></I18nProvider>);
      await flushAsyncWork();
    });
    expect(autostart!.value).toBe("auto");
  });

  it("disables autostart without a game and keeps the saved mode after a failed save", async () => {
    await act(async () => {
      root.render(<I18nProvider><OCRTab active /></I18nProvider>);
      await flushAsyncWork();
    });
    const autostart = container.querySelector<HTMLSelectElement>("#ocr-autostart-mode");
    expect(autostart?.disabled).toBe(true);

    const scene = { id: "scene-1", name: "Example Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") return [scene];
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "settings.getSceneLaunchProfile") return { ocrMode: "manual" };
      if (channel === "settings.saveSceneLaunchProfile") return { success: false };
      return null;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await flushAsyncWork();
    });
    expect(autostart!.value).toBe("manual");

    await act(async () => {
      autostart!.value = "auto";
      autostart!.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });
    expect(autostart!.value).toBe("manual");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Failed to save OCR autostart settings."
    );
  });

  it("loads legacy gamepad bindings as enabled and suppresses them without erasing mappings", async () => {
    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    expect(container.querySelectorAll(".ocr-gamepad-hotkey")).toHaveLength(6);
    expect((container.querySelector("#manual-hotkey") as HTMLInputElement).value).toBe(
      "Ctrl+Shift+M"
    );
    expect((container.querySelector("#menu-hotkey") as HTMLInputElement).value).toBe(
      "A"
    );

    const toggle = container.querySelector(
      'button[aria-controls="ocr-gamepad-bindings"]'
    );
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      (toggle as HTMLButtonElement).click();
      await flushAsyncWork();
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await flushAsyncWork();
    });

    expect(container.querySelectorAll(".ocr-gamepad-hotkey")).toHaveLength(0);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sendMock).toHaveBeenCalledWith(
      "ocr.save-ocr-config",
      expect.objectContaining({
        gamepadHotkeysEnabled: false,
        manualOcrGamepad: "",
        menuOcrGamepad: "0",
        areaSelectOcrGamepad: "",
        wholeWindowOcrGamepad: "",
        globalPauseGamepad: "9"
      })
    );
  });

  it("renders hotkeys as compact rows with shared binding columns", async () => {
    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    const columns = container.querySelector(".ocr-hotkey-columns");
    expect(columns?.textContent).toContain("Action");
    expect(columns?.textContent).toContain("Keyboard");
    expect(columns?.textContent).toContain("Gamepad");
    expect(container.querySelectorAll(".ocr-hotkey-item")).toHaveLength(6);
    expect(
      container.querySelector(".ocr-hotkey-item > .ocr-hotkey-run")
    ).toBeInstanceOf(HTMLButtonElement);
  });

  it("starts disabled when no gamepad bindings are configured and reveals them when enabled", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return {
          manualOcrGamepad: "",
          menuOcrGamepad: "",
          areaSelectOcrGamepad: "",
          wholeWindowOcrGamepad: "",
          globalPauseGamepad: ""
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    const toggle = container.querySelector(
      'button[aria-controls="ocr-gamepad-bindings"]'
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".ocr-gamepad-hotkey")).toHaveLength(0);

    await act(async () => {
      (toggle as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".ocr-gamepad-hotkey")).toHaveLength(6);
  });

  it("runs Add new area and saves or clears its keyboard binding", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-running-state") return { isRunning: true, isManual: false };
      return null;
    });
    await act(async () => {
      root.render(<OCRTab active />);
      await flushAsyncWork();
    });

    const binding = container.querySelector<HTMLInputElement>("#add-area-hotkey")!;
    const row = binding.closest(".ocr-hotkey-item")!;
    expect(binding.value).toBe("Alt+Shift+N");
    expect(row.textContent).toContain("Add new area");
    await act(async () => {
      row.querySelector<HTMLButtonElement>(".ocr-hotkey-run")!.click();
    });
    expect(sendMock).toHaveBeenCalledWith("ocr.add-area");

    for (const [key, altKey, expected] of [["n", true, "Alt+N"], ["Escape", false, ""]] as const) {
      await act(async () => {
        binding.dispatchEvent(new KeyboardEvent("keydown", { key, altKey, bubbles: true }));
        await flushAsyncWork();
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
        await flushAsyncWork();
      });
      expect(sendMock).toHaveBeenCalledWith("ocr.save-ocr-config", expect.objectContaining({
        addAreaOcrHotkey: expected,
        addAreaOcrGamepad: ""
      }));
    }
  });

  it("loads a saved Add new area binding and gamepad mapping", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") return { addAreaOcrHotkey: "", addAreaOcrGamepad: "4" };
      return null;
    });
    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });
    expect(container.querySelector<HTMLInputElement>("#add-area-hotkey")!.value).toBe("");
    expect(container.querySelector<HTMLSelectElement>("#add-area-gamepad-hotkey")!.value).toBe("4");
  });

  it("loads and saves the manual green-area delay options", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return {
          gamepadHotkeysEnabled: true,
          manualOcrGamepad: "0",
          menuOcrHotkey: "Ctrl+Shift+G",
          manualOcrDelayMs: 350,
          manualOcrDelayGamepadOnly: true
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    const delayInput = container.querySelector(
      "#manual-ocr-delay-ms"
    ) as HTMLInputElement;
    const gamepadOnlyInput = container.querySelector(
      "#manual-ocr-delay-gamepad-only"
    ) as HTMLInputElement;
    expect(delayInput.value).toBe("350");
    expect(gamepadOnlyInput.checked).toBe(true);

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(delayInput, "500");
      delayInput.dispatchEvent(new Event("input", { bubbles: true }));
      await flushAsyncWork();
      vi.advanceTimersByTime(200);
      await flushAsyncWork();
    });

    expect(sendMock).toHaveBeenCalledWith(
      "ocr.save-ocr-config",
      expect.objectContaining({
        manualOcrDelayMs: 500,
        manualOcrDelayGamepadOnly: true
      })
    );
  });

  it("only shows the gamepad-only delay option while gamepad hotkeys are enabled", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return {
          gamepadHotkeysEnabled: false,
          menuOcrHotkey: "Ctrl+Shift+G",
          manualOcrDelayMs: 200,
          manualOcrDelayGamepadOnly: true
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    expect(container.querySelector("#manual-ocr-delay-ms")).toBeInstanceOf(
      HTMLInputElement
    );
    expect(
      container.querySelector("#manual-ocr-delay-gamepad-only")
    ).toBeNull();

    const toggle = container.querySelector(
      'button[aria-controls="ocr-gamepad-bindings"]'
    ) as HTMLButtonElement;
    await act(async () => {
      toggle.click();
      await flushAsyncWork();
    });

    expect(
      container.querySelector("#manual-ocr-delay-gamepad-only")
    ).toBeInstanceOf(HTMLInputElement);
  });

  it("does not expose a separate WGC capture rate setting", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return {
          advancedMode: true,
          scanRate: 0.2,
          scanRate_advanced: 0.2,
          wgcCaptureFps: 12
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    expect(container.querySelector("#ocr-advanced-scan-rate")).toBeInstanceOf(
      HTMLInputElement
    );
    expect(container.querySelector("#ocr-wgc-capture-fps")).toBeNull();

    const scanRateInput = container.querySelector(
      "#ocr-advanced-scan-rate"
    ) as HTMLInputElement;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(scanRateInput, "0.3");
      scanRateInput.dispatchEvent(new Event("input", { bubbles: true }));
      await flushAsyncWork();
      vi.advanceTimersByTime(200);
      await flushAsyncWork();
    });

    const saveCall = sendMock.mock.calls.find(
      ([channel]) => channel === "ocr.save-ocr-config"
    );
    expect(saveCall?.[1]).not.toHaveProperty("wgcCaptureFps");
  });

  it("opts into online scans in basic mode and preserves advanced choices", async () => {
    invokeMock.mockImplementation(async (channel: string) => channel === "ocr.get-ocr-config" ? {
      advancedMode: false, ocr1: "meiki_text_detector", ocr2: "glens",
      ocr1_advanced: "oneocr", ocr2_advanced: "bing"
    } : null);
    await act(async () => {
      root.render(<I18nProvider><OCRTab active={false} /></I18nProvider>);
      await flushAsyncWork();
    });
    const toggle = container.querySelector<HTMLInputElement>("#ocr-online-scans");
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle!.checked).toBe(false);
    expect(container.textContent).toContain("ScreenAI reads text locally");
    for (const enabled of [true, false]) {
      await act(async () => {
        toggle!.click();
        await flushAsyncWork();
        vi.advanceTimersByTime(200);
        await flushAsyncWork();
      });
      expect(sendMock).toHaveBeenLastCalledWith("ocr.save-ocr-config", expect.objectContaining({
        useOnlineOcr: enabled, ocr1: "screenai", ocr2: enabled ? "glens" : "screenai",
        ocr1_advanced: "oneocr", ocr2_advanced: "bing",
      }));
    }
    await act(async () => {
      container.querySelector<HTMLInputElement>("#ocr-advanced-toggle")!.click();
      await flushAsyncWork();
      vi.advanceTimersByTime(200);
      await flushAsyncWork();
    });
    expect(container.querySelector("#ocr-online-scans")).toBeNull();
    expect(sendMock).toHaveBeenLastCalledWith("ocr.save-ocr-config", expect.objectContaining({
      advancedMode: true, ocr1: "oneocr", ocr2: "bing", useOnlineOcr: false,
    }));
  });

  it("loads and persists advanced OCR debug logging", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return {
          advanced_debug_logging: true
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    const toggle = container.querySelector(
      "#advanced-debug-logging"
    ) as HTMLInputElement;
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle.checked).toBe(true);

    await act(async () => {
      toggle.click();
      await flushAsyncWork();
      vi.advanceTimersByTime(200);
      await flushAsyncWork();
    });

    expect(sendMock).toHaveBeenCalledWith(
      "ocr.save-ocr-config",
      expect.objectContaining({
        advanced_debug_logging: false
      })
    );
  });
});
