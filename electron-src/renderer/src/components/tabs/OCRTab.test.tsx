// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OCRTab } from "./OCRTab";

const invokeMock = vi.fn();
const sendMock = vi.fn();
const ipcListeners = new Map<string, (event: unknown, payload?: unknown) => void>();

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
    ipcListeners.clear();
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
        on: (
          channel: string,
          listener: (event: unknown, payload?: unknown) => void
        ) => {
          ipcListeners.set(channel, listener);
          return () => ipcListeners.delete(channel);
        }
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

  it("persists and resets experimental automatic OCR areas", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return { autoConfigureAreas: true };
      }
      return null;
    });

    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    const toggle = container.querySelector("#ocr-auto-configure-areas") as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    const resetButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Reset learned areas")
    );
    expect(resetButton).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      resetButton?.click();
    });
    expect(sendMock).toHaveBeenCalledWith("ocr.reset-auto-regions");

    await act(async () => {
      toggle.click();
      vi.advanceTimersByTime(200);
      await flushAsyncWork();
    });
    expect(sendMock).toHaveBeenCalledWith(
      "ocr.save-ocr-config",
      expect.objectContaining({ autoConfigureAreas: false })
    );
  });

  it("opens the selector in the area type recommended by auto learning", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "ocr.get-ocr-config") {
        return { autoConfigureAreas: true };
      }
      return null;
    });

    await act(async () => {
      root.render(<OCRTab active={false} />);
      await flushAsyncWork();
    });

    await act(async () => {
      ipcListeners.get("ocr-ipc-status")?.({}, {
        auto_regions: {
          enabled: true,
          phase: "active",
          recommendations: [
            {
              id: "secondary:1:2:3:4",
              kind: "secondary",
              reason: "dense_text",
              confidence: 0.9,
              line_count: 4
            },
            {
              id: "black_hole:5:6:7:8",
              kind: "black_hole",
              reason: "unstable_large_text",
              confidence: 0.8,
              line_count: 4
            }
          ]
        }
      });
      await flushAsyncWork();
    });

    const purpleButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Select purple area")
    );
    const blackHoleButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Select black-hole area")
    );
    expect(purpleButton).toBeInstanceOf(HTMLButtonElement);
    expect(blackHoleButton).toBeInstanceOf(HTMLButtonElement);
    expect(container.textContent).toContain("OCR is repeatedly changing inside a large, stationary text area.");

    await act(async () => {
      purpleButton?.click();
      blackHoleButton?.click();
    });

    expect(sendMock).toHaveBeenCalledWith("ocr.run-screen-selector", {
      drawMode: "secondary"
    });
    expect(sendMock).toHaveBeenCalledWith("ocr.run-screen-selector", {
      drawMode: "black_hole"
    });
  });
});
