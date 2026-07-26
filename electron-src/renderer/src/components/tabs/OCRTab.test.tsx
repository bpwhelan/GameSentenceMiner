// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("OCRTab hotkeys", () => {
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

  it("loads legacy gamepad bindings as enabled and suppresses them without erasing mappings", async () => {
    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    expect(container.querySelectorAll(".ocr-gamepad-hotkey")).toHaveLength(5);
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
    expect(container.querySelectorAll(".ocr-gamepad-hotkey")).toHaveLength(5);
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
});
