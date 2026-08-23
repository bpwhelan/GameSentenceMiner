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

    expect(container.textContent).toContain("About text hooking");
    expect(container.querySelectorAll(".texthook-hook-row")).toHaveLength(1);
    expect(container.textContent).toContain("1 hooks");
    expect(container.textContent).toContain("Visible hook text");
    expect(container.textContent).not.toContain("Hook #5");
    expect(container.textContent).not.toContain("(no text yet)");
  });

  it("explains which hook engine to use and links to Text Processing", async () => {
    const onNavigateTab = vi.fn();

    await act(async () => {
      root.render(<TextHookTab active onNavigateTab={onNavigateTab} />);
      await flushAsyncWork();
    });

    const notice = container.querySelector('[aria-labelledby="texthook-notice-title"]');
    expect(notice?.textContent).toContain("Luna Hook or Textractor");
    expect(notice?.textContent).toContain("visual novels");
    expect(notice?.textContent).toContain("Agent");
    expect(notice?.textContent).toContain("games with supported scripts");

    const textProcessingLink = Array.from(notice?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Text Processing"
    );
    expect(textProcessingLink).toBeTruthy();

    await act(async () => {
      textProcessingLink?.click();
    });

    expect(onNavigateTab).toHaveBeenCalledWith("textprocessing");
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

  it("searches Agent scripts by the captured window title instead of the executable", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") return { running: false };
      if (channel === "texthook.listHooks") return { selectedHookId: null, hooks: [] };
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: "Resident Evil",
          sceneId: "scene-1",
          exeName: "re1.exe",
          windowTitle: "Resident Evil HD REMASTER",
        };
      }
      if (channel === "texthook.getProfile") return null;
      if (channel === "settings.listAgentScripts") {
        return {
          scripts: [
            "C:\\Agent\\data\\scripts\\PC_Steam_Resident_Evil_HD_REMASTER.js",
            "C:\\Agent\\data\\scripts\\PC_Unrelated_Game.js",
          ],
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const engineSelect = container.querySelector("#texthook-engine-select") as HTMLSelectElement;
    await act(async () => {
      engineSelect.value = "agent";
      engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const searchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Search"
    );
    await act(async () => {
      searchButton?.click();
      await flushAsyncWork();
    });

    const searchInput = container.querySelector(
      ".agent-script-search-dialog input[type='search']"
    ) as HTMLInputElement;
    expect(searchInput.value).toBe("Resident Evil HD REMASTER");
    expect(searchInput.value).not.toContain("re1");
    expect(container.querySelectorAll(".agent-script-search-option")).toHaveLength(1);
    expect(container.textContent).toContain("Resident Evil HD REMASTER");
  });

  it("labels the built-in game hook experimental and lists every supported target", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") return { running: false };
      if (channel === "texthook.listHooks") return { selectedHookId: null, hooks: [] };
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: "Scene", sceneId: "scene-1", exeName: "Game.exe" };
      }
      if (channel === "texthook.getProfile") return null;
      if (channel === "texthook.builtInHookTargets") {
        return [
          {
            id: "fixture-one",
            name: "Fixture Game One",
            details: { en: "Fixture details one", ja: "テスト説明" },
          },
          { id: "fixture-two", name: "Fixture Engine Two", details: { en: "Fixture details two" } },
        ];
      }
      return null;
    });

    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const engineSelect = container.querySelector("#texthook-engine-select") as HTMLSelectElement;
    await act(async () => {
      engineSelect.value = "mages";
      engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await flushAsyncWork();
    });

    expect(engineSelect.selectedOptions[0]?.textContent).toBe(
      "Built-in Game Hook (Experimental)"
    );
    expect(container.textContent).toContain(
      "works only with the games and engines listed below"
    );
    const supportedTargets = Array.from(
      container.querySelectorAll(".texthook-supported-games li")
    ).map((entry) => entry.textContent ?? "");
    expect(supportedTargets).toEqual([
      "Fixture Game OneFixture details one",
      "Fixture Engine TwoFixture details two",
    ]);
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

  it("hides the large-payload stress control outside development", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const testButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("120000 characters")
    );

    expect(testButton).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "texthook.devSendLargePayload",
      expect.anything()
    );
  });
});
