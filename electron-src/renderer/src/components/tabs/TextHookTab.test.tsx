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

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invokeMock.mockReset();

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
        on: () => () => {},
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

    expect(container.querySelectorAll(".texthook-hook-row")).toHaveLength(1);
    expect(container.textContent).toContain("1 hooks");
    expect(container.textContent).toContain("Visible hook text");
    expect(container.textContent).not.toContain("Hook #5");
    expect(container.textContent).not.toContain("(no text yet)");
  });
});
