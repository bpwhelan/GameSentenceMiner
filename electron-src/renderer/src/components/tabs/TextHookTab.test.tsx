// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TextHookTab } from "./TextHookTab";

const invokeMock = vi.fn();

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("TextHookTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let ipcListeners: Map<string, (...args: any[]) => void>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invokeMock.mockReset();
    ipcListeners = new Map();

    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") {
        return {
          running: true,
          engine: "luna",
          arch: "x64",
          pid: 1234,
          exeName: "game.exe",
          selectedHookId: null,
          hookCount: 2,
          flushDelayMs: 100,
        };
      }
      if (channel === "texthook.listHooks") {
        return {
          selectedHookId: null,
          hooks: [
            {
              id: "5",
              function: "Hook #5",
              preview: "",
              samples: [],
            },
            {
              id: "9",
              function: "Hook #9",
              preview: "Visible hook text",
              samples: ["Visible hook text"],
            },
          ],
        };
      }
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: "Scene",
          sceneId: "scene-1",
          exeName: "game.exe",
        };
      }
      if (channel === "texthook.getProfile") return null;
      return null;
    });

    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke: invokeMock,
        send: vi.fn(),
        on: (channel: string, listener: (...args: any[]) => void) => {
          ipcListeners.set(channel, listener);
          return () => ipcListeners.delete(channel);
        },
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

  it("hides detected hooks until they have emitted text", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Experimental");
    expect(container.querySelectorAll(".texthook-hook-row")).toHaveLength(1);
    expect(container.textContent).toContain("1 hooks");
    expect(container.textContent).toContain("Visible hook text");
    expect(container.textContent).not.toContain("Hook #5");
    expect(container.textContent).not.toContain("(no text yet)");
  });

  it("opens upstream text hook project credits", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const links = Array.from(container.querySelectorAll(".texthook-credits a"));
    expect(links.map((link) => link.textContent)).toEqual([
      "Agent",
      "Textractor",
      "LunaTranslator",
    ]);

    await act(async () => {
      for (const link of links) {
        (link as HTMLAnchorElement).click();
      }
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "open-external-link",
      "https://github.com/0xDC00/agent/releases/latest"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "open-external-link",
      "https://github.com/Chenx221/Textractor/releases"
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "open-external-link",
      "https://github.com/HIllya51/LunaTranslator/releases"
    );
  });

  it("makes the selected hook visible in the detected hooks list", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") {
        return {
          running: true,
          engine: "luna",
          arch: "x64",
          pid: 1234,
          exeName: "game.exe",
          selectedHookId: "5",
          hookCount: 2,
          flushDelayMs: 100,
        };
      }
      if (channel === "texthook.listHooks") {
        return {
          selectedHookId: "5",
          hooks: [
            {
              id: "5",
              function: "Hook #5",
              preview: "",
              samples: [],
            },
            {
              id: "9",
              function: "Hook #9",
              preview: "Visible hook text",
              samples: ["Visible hook text"],
            },
          ],
        };
      }
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: "Scene",
          sceneId: "scene-1",
          exeName: "game.exe",
        };
      }
      if (channel === "texthook.getProfile") return null;
      return null;
    });

    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const selectedButton = container.querySelector(
      ".texthook-hook-row.selected .texthook-hook-button"
    );

    expect(container.textContent).toContain("Click a detected hook row");
    expect(container.querySelectorAll(".texthook-hook-row")).toHaveLength(2);
    expect(container.textContent).toContain("Selected #5");
    expect(container.textContent).toContain("Selected");
    expect(selectedButton?.getAttribute("aria-pressed")).toBe("true");
  });

  it("starts Luna hook search from the engine configuration button", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") {
        return {
          running: false,
        };
      }
      if (channel === "texthook.listHooks") {
        return {
          selectedHookId: null,
          hooks: [],
        };
      }
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: "Scene",
          sceneId: "scene-1",
          exeName: "game.exe",
        };
      }
      if (channel === "texthook.getProfile") return null;
      if (channel === "texthook.start") {
        return {
          success: true,
          pid: 1234,
          exeName: "game.exe",
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const searchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Search for hooks"
    ) as HTMLButtonElement | undefined;

    expect(searchButton).toBeTruthy();
    expect(searchButton?.disabled).toBe(false);

    await act(async () => {
      searchButton?.click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "texthook.start",
      expect.objectContaining({
        engine: "luna",
        exeName: "game.exe",
        flushDelayMs: 100,
      })
    );
  });

  it("caps displayed hook text and blocks excessive Japanese quote pairs", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    await act(async () => {
      ipcListeners.get("texthook.text")?.({}, { hookId: "9", text: "x".repeat(5000) });
    });

    expect(container.querySelector(".texthook-output-pre")?.textContent).toHaveLength(3000);

    await act(async () => {
      ipcListeners.get("texthook.text")?.({}, { hookId: "9", text: "「text」".repeat(11) });
    });

    expect(container.querySelectorAll(".texthook-output-pre")).toHaveLength(1);
  });

  it("sends the large-payload test through the truncation path", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") {
        return { running: false };
      }
      if (channel === "texthook.listHooks") {
        return { selectedHookId: null, hooks: [] };
      }
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: "Scene", sceneId: "scene-1", exeName: "game.exe" };
      }
      if (channel === "texthook.getProfile") return null;
      if (channel === "texthook.devSendLargePayload") {
        return { success: true, length: 3000, originalLength: 120000, truncated: true };
      }
      return null;
    });

    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const testButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("120000 characters")
    );

    await act(async () => {
      testButton?.click();
      await flushAsyncWork();
    });

    const payloadCall = invokeMock.mock.calls.find(([channel]) => channel === "texthook.devSendLargePayload");
    expect(payloadCall?.[1]).toHaveLength(120000);
    expect(container.textContent).toContain("Sent 3000 characters after truncating a 120000-character test payload.");
  });
});
