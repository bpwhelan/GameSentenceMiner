// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TextHookTab } from "./TextHookTab";
import { I18nProvider } from "../../i18n";

const invokeMock = vi.fn();
const writeTextMock = vi.fn();

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
    writeTextMock.mockReset();
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
      if (channel === "texthook.getSettings") return { maxBufferSize: 3000, targetLanguage: "ja" };
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

    Object.defineProperty(window, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
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

  it.each(["inactive tab", "hidden window"])("buffers hook output without rendering in an %s", async (hiddenMode) => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      if (hiddenMode === "hidden window") {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      } else root.render(<TextHookTab active={false} />);
    });
    const before = container.innerHTML;
    try {
      await act(async () => {
        ipcListeners.get("texthook.hooks")?.({}, {
          selectedHookId: null,
          hooks: [{ id: "9", function: "Hook #9", preview: "Buffered preview", samples: [] }],
        });
        for (let i = 0; i < 305; i++) {
          ipcListeners.get("texthook.text")?.({}, { text: `Buffered dialogue ${i}`, hookId: "9", ts: i });
          ipcListeners.get("texthook.log")?.({}, { message: `Buffered log ${i}`, ts: i });
        }
      });
      expect(container.innerHTML === before).toBe(true);
    } finally {
      await act(async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        root.render(<TextHookTab active />);
        await flushAsyncWork();
      });
    }
    expect(container.querySelectorAll(".texthook-output-line")).toHaveLength(20);
    expect(container.querySelector(".texthook-output-line")?.textContent).toContain("Buffered dialogue 285");
    expect(container.textContent).toContain("Buffered dialogue 304");
    expect(container.querySelectorAll(".texthook-log-line")).toHaveLength(50);
    expect(container.textContent).toContain("Buffered log 304");
  });

  it("preserves retained output and log rows when their histories fill up", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      for (let i = 0; i < 300; i++) {
        ipcListeners.get("texthook.text")?.({}, { text: `Dialogue ${i}`, hookId: "9", ts: i });
        ipcListeners.get("texthook.log")?.({}, { message: `Log ${i}`, ts: i });
      }
    });
    const retainedTextRow = container.querySelectorAll(".texthook-output-line")[1];
    const retainedLogRow = container.querySelectorAll(".texthook-log-line")[1];
    await act(async () => {
      ipcListeners.get("texthook.text")?.({}, { text: "Next dialogue", hookId: "9", ts: 300 });
      ipcListeners.get("texthook.log")?.({}, { message: "Next log", ts: 300 });
    });
    expect(container.querySelector(".texthook-output-line")).toBe(retainedTextRow);
    expect(container.querySelector(".texthook-log-line")).toBe(retainedLogRow);
  });

  it.each(["luna", "textractor"])("ranks %s hooks and lets users reveal and select likely noise", async (engine) => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus") return { ...(await original(channel)), engine };
      if (channel === "texthook.selectHook") return { success: true };
      return original(channel, ...args);
    });
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      ipcListeners.get("texthook.hooks")?.({}, {
        selectedHookId: null,
        hooks: [
          { id: "path", function: "Files", preview: "C:\\Game\\data.bin", samples: [] },
          { id: "english", function: "Menu", preview: "Welcome to the village.", samples: [] },
          { id: "jp", function: "Dialogue", preview: "今日は一緒に帰ろう。", samples: [] },
        ],
      });
    });
    const rowIds = () => Array.from(container.querySelectorAll(".texthook-hook-id"), (el) => el.textContent);
    expect(rowIds()).toEqual(["#jp", "#english"]);
    expect(container.textContent).toContain("Show likely noise (1)");
    expect(invokeMock).not.toHaveBeenCalledWith("texthook.selectHook", expect.anything());
    const toggle = container.querySelector("#texthook-show-noise") as HTMLInputElement;
    await act(async () => { toggle.click(); });
    expect(rowIds()).toEqual(["#jp", "#english", "#path"]);
    await act(async () => {
      (container.querySelector('[aria-label="Select hook #path: Files"]') as HTMLButtonElement).click();
      await flushAsyncWork();
    });
    expect(invokeMock).toHaveBeenCalledWith("texthook.selectHook", "path");
    await act(async () => { toggle.click(); });
    expect(rowIds()).toEqual(["#path", "#jp", "#english"]);
    expect(container.querySelector('[aria-label="Select hook #path: Files"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("explains when all hooks are hidden and recovers as dialogue arrives", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      ipcListeners.get("texthook.hooks")?.({}, {
        selectedHookId: null,
        hooks: [{ id: "1", function: "Game", preview: "C:\\Game\\data.bin", samples: [] }],
      });
    });
    expect(container.querySelectorAll(".texthook-hook-row")).toHaveLength(0);
    expect(container.textContent).toContain("Only likely noise so far");
    await act(async () => {
      ipcListeners.get("texthook.hooks")?.({}, {
        selectedHookId: null,
        hooks: [{ id: "1", function: "Game", preview: "こんにちは。", samples: ["C:\\Game\\data.bin", "こんにちは。"] }],
      });
    });
    expect(container.querySelectorAll(".texthook-hook-row")).toHaveLength(1);
    expect(container.textContent).toContain("こんにちは。");
  });

  it("re-ranks when the configured target language changes", async () => {
    let language = "ja";
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getSettings") return { maxBufferSize: 3000, targetLanguage: language };
      return original(channel, ...args);
    });
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      ipcListeners.get("texthook.hooks")?.({}, {
        selectedHookId: null,
        hooks: [
          { id: "en", function: "English", preview: "Welcome home.", samples: [] },
          { id: "ja", function: "Japanese", preview: "おかえりなさい。", samples: [] },
        ],
      });
    });
    expect(container.querySelector(".texthook-hook-id")?.textContent).toBe("#ja");
    language = "en";
    await act(async () => {
      vi.advanceTimersByTime(4000);
      await flushAsyncWork();
    });
    expect(container.querySelector(".texthook-hook-id")?.textContent).toBe("#en");
  });

  it.each(["agent", "mages"])("keeps %s hook listings unfiltered", async (engine) => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus") return { ...(await original(channel)), engine };
      return original(channel, ...args);
    });
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    expect(container.querySelectorAll(".texthook-hook-row")).toHaveLength(2);
    expect(container.querySelector("#texthook-show-noise")).toBeNull();
  });

  it("keeps the session available while switching between live text and configuration", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    const session = container.querySelector(".texthook-session-card")!;
    expect(container.querySelector(".th-target")?.textContent).toContain("game.exe");
    expect(session.textContent).toContain("Stop");
    const liveGrid = container.querySelector(".texthook-live-grid")!;
    expect(liveGrid.children).toHaveLength(2);
    expect(liveGrid.querySelector(".texthook-hooks")).toBeTruthy();
    expect(liveGrid.querySelector(".texthook-output")).toBeTruthy();
    expect(container.querySelector(".texthook-stepper")).toBeNull();
    for (const selector of [".texthook-help", ".texthook-engine-maintenance"]) {
      const section = container.querySelector<HTMLElement>(selector)!;
      expect(section.closest("details")).toBeNull();
      expect(section.closest("[hidden]")?.id).toBe("texthook-view-tools");
    }
    const live = container.querySelector<HTMLElement>("#texthook-view-live")!;
    const output = container.querySelector<HTMLElement>("#texthook-view-output")!;
    expect(live.hidden).toBe(false);
    expect(container.querySelector("#texthook-nav-engine")).toBeNull();
    expect(live.querySelector("#texthook-engine-select")?.closest("[hidden]")).toBeNull();
    expect(live.querySelector("#texthook-engine-select")).toBeTruthy();
    expect(live.querySelector("#texthook-manual-input")).toBeTruthy();
    expect(live.querySelector("#texthook-manual-input")?.closest("details, [hidden]")).toBeNull();
    expect(output.querySelector("#texthook-flush-delay-input")).toBeTruthy();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#texthook-nav-output")!.click();
      ipcListeners.get("texthook.text")?.({}, { hookId: "9", text: "Dialogue while configuring" });
    });
    expect(output.hidden).toBe(false);
    expect(live.hidden).toBe(true);
    expect(session.textContent).toContain("Stop");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#texthook-nav-live")!.click();
    });
    expect(live.hidden).toBe(false);
    expect(container.querySelector(".texthook-output-pre")?.textContent).toBe("Dialogue while configuring");
  });

  it("supports arrow, Home, and End navigation between workspace views", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    const key = async (view: string, pressed: string, target: string) => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("#texthook-nav-" + view)!.dispatchEvent(
          new KeyboardEvent("keydown", { key: pressed, bubbles: true })
        );
      });
      const tab = container.querySelector<HTMLButtonElement>("#texthook-nav-" + target)!;
      expect(tab.getAttribute("aria-selected")).toBe("true");
      expect(tab.tabIndex).toBe(0);
      expect(document.activeElement).toBe(tab);
      expect(container.querySelector<HTMLElement>("#texthook-view-" + target)!.hidden).toBe(false);
    };
    await key("live", "ArrowDown", "output");
    await key("output", "End", "tools");
    await key("tools", "ArrowDown", "live");
    await key("live", "ArrowUp", "tools");
    await key("tools", "Home", "live");
  });

  it("keeps the engine log mounted and returns to the previous view on Escape", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    const consolePanel = container.querySelector<HTMLElement>("#texthook-view-console")!;
    const log = container.querySelector(".texthook-log")!;
    const toggle = container.querySelector<HTMLButtonElement>("#texthook-log-toggle")!;
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#texthook-nav-output")!.click();
      toggle.click();
      ipcListeners.get("texthook.log")?.({}, { level: "info", message: "Engine attached" });
    });
    expect(consolePanel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(log.textContent).toContain("Engine attached");
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Clear log")!.click();
    });
    expect(log.textContent).not.toContain("Engine attached");
    await act(async () => {
      log.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      ipcListeners.get("texthook.log")?.({}, { level: "info", message: "Still receiving messages" });
    });
    expect(consolePanel.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>("#texthook-view-output")!.hidden).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect(container.querySelector(".texthook-log")).toBe(log);
    expect(log.textContent).toContain("Still receiving messages");
  });

  it("explains which hook engine to use and links to Text Processing when help is expanded", async () => {
    const onNavigateTab = vi.fn();

    await act(async () => {
      root.render(<TextHookTab active onNavigateTab={onNavigateTab} />);
      await flushAsyncWork();
    });

    const notice = container.querySelector('[aria-labelledby="texthook-notice-title"]');
    (notice as HTMLDetailsElement).open = true;
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

  it("starts Luna hook search from the sidebar and returns to live text", async () => {
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
      container.querySelector<HTMLButtonElement>("#texthook-nav-output")!.click();
    });
    expect(container.querySelector<HTMLElement>("#texthook-view-output")!.hidden).toBe(false);
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
    expect(container.querySelector<HTMLElement>("#texthook-view-live")!.hidden).toBe(false);
  });

  it("ranks Agent scripts from scene, window, and executable without a prefilled filter", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") return { running: false };
      if (channel === "texthook.listHooks") return { selectedHookId: null, hooks: [] };
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: "Tsukihime",
          sceneId: "scene-1",
          exeName: "UnicornOverlord.exe",
          windowTitle: "Resident Evil HD REMASTER",
        };
      }
      if (channel === "texthook.getProfile") return null;
      if (channel === "settings.listAgentScripts") {
        return {
          scripts: [
            "C:\\Agent\\data\\scripts\\PC_Steam_Resident_Evil_HD_REMASTER.js",
            "C:\\Agent\\data\\scripts\\PC_Unrelated_Game.js",
            "C:\\Agent\\data\\scripts\\PC_Tsukihime.js",
            "C:\\Agent\\data\\scripts\\PC_Unicorn_Overlord.js",
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
      (button) => button.textContent?.trim() === "Search scripts"
    );
    await act(async () => {
      searchButton?.click();
      await flushAsyncWork();
    });

    const searchInput = container.querySelector(
      ".agent-script-search-dialog input[type='search']"
    ) as HTMLInputElement;
    expect(searchInput.value).toBe("");
    const options = Array.from(container.querySelectorAll(".agent-script-search-option"));
    expect(options).toHaveLength(4);
    expect(options[3].textContent).toContain("Unrelated Game");
    expect(container.textContent).toContain("Resident Evil HD REMASTER");
    expect(container.textContent).toContain("Tsukihime");
    expect(container.textContent).toContain("Unicorn Overlord");
  });

  it("starts Agent detached by default without showing the option for other engines", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "texthook.getStatus") return { running: false };
      if (channel === "texthook.listHooks") return { selectedHookId: null, hooks: [] };
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: "Scene", sceneId: "scene-1", exeName: "game.exe" };
      }
      if (channel === "texthook.getProfile") return null;
      if (channel === "texthook.start") {
        return { success: true, pid: 1234, exeName: "game.exe" };
      }
      return null;
    });

    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    expect(container.querySelector("#texthook-agent-detached-input")).toBeNull();

    const engineSelect = container.querySelector("#texthook-engine-select") as HTMLSelectElement;
    await act(async () => {
      engineSelect.value = "agent";
      engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const detachedInput = container.querySelector(
      "#texthook-agent-detached-input"
    ) as HTMLInputElement;
    expect(detachedInput.checked).toBe(true);

    const scriptInput = container.querySelector(
      "#texthook-agent-script-input"
    ) as HTMLInputElement;
    expect(scriptInput.closest("#texthook-view-live")).toBeTruthy();
    expect(scriptInput.closest("[hidden]")).toBeNull();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(scriptInput, "C:\\Agent\\data\\scripts\\game.js");
      scriptInput.dispatchEvent(new Event("input", { bubbles: true }));
      await flushAsyncWork();
    });

    const startButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Start"
    );
    await act(async () => {
      startButton?.click();
      await flushAsyncWork();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "texthook.start",
      expect.objectContaining({
        engine: "agent",
        agentDetached: true,
      })
    );
  });

  it("resets detached Agent to on after switching from an opted-out Agent profile", async () => {
    let sceneId = "agent-scene";
    invokeMock.mockImplementation(async (channel: string, payload?: { sceneId?: string }) => {
      if (channel === "texthook.getStatus") return { running: false };
      if (channel === "texthook.listHooks") return { selectedHookId: null, hooks: [] };
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: "Scene", sceneId, exeName: "game.exe" };
      }
      if (channel === "texthook.getProfile" && payload?.sceneId === "agent-scene") {
        return {
          sceneId: "agent-scene",
          exeName: "game.exe",
          engine: "agent",
          autoHook: true,
          flushDelayMs: 100,
          agentScriptPath: "C:\\Agent\\game.js",
          agentDetached: false,
          lastUsed: 1,
        };
      }
      if (channel === "texthook.getProfile") {
        return {
          sceneId: "luna-scene",
          exeName: "game.exe",
          engine: "luna",
          autoHook: true,
          flushDelayMs: 100,
          agentDetached: false,
          lastUsed: 2,
        };
      }
      return null;
    });

    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });

    expect(
      (container.querySelector("#texthook-agent-detached-input") as HTMLInputElement).checked
    ).toBe(false);

    sceneId = "luna-scene";
    await act(async () => {
      vi.advanceTimersByTime(4000);
      await flushAsyncWork();
    });

    const engineSelect = container.querySelector("#texthook-engine-select") as HTMLSelectElement;
    expect(engineSelect.value).toBe("luna");
    await act(async () => {
      engineSelect.value = "agent";
      engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      (container.querySelector("#texthook-agent-detached-input") as HTMLInputElement).checked
    ).toBe(true);
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

  it.each([
    ["en", "Copy line"],
    ["ja", "行をコピー"],
    ["ukr", "Копіювати рядок"],
    ["zh", "复制此行"],
    ["ko", "줄 복사"],
    ["es", "Copiar línea"],
  ])("copies only the chosen output entry with its original line breaks in %s", async (locale, label) => {
    await act(async () => {
      root.render(<I18nProvider initialLocale={locale}><TextHookTab active /></I18nProvider>);
      await flushAsyncWork();
    });
    expect(container.querySelectorAll(".texthook-output button")).toHaveLength(0);

    const texts = ["  最初の行\n次の行  ", "<b>Second capture & text</b>"];
    await act(async () => {
      for (const text of texts) {
        ipcListeners.get("texthook.text")?.({}, { hookId: "9", text });
      }
    });

    const entries = container.querySelectorAll(".texthook-output-line");
    expect(entries).toHaveLength(2);
    expect(writeTextMock).not.toHaveBeenCalled();
    for (const index of [1, 0]) {
      const button = entries[index].querySelector<HTMLButtonElement>("button")!;
      expect(button).not.toBeNull();
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.title).toBe(label);
      await act(async () => { button.click(); });
      expect(writeTextMock).toHaveBeenLastCalledWith(texts[index]);
    }
    expect(writeTextMock).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".texthook-output-line")).toHaveLength(2);
    expect(invokeMock).not.toHaveBeenCalledWith("texthook.setCopyToClipboard", expect.anything());
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

  it.each([
    ["starting", "Starting"],
    ["waiting", "Waiting for text"],
    ["receiving", "Receiving text"],
  ])("shows the Agent %s phase", async (agentPhase, label) => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus") {
        return { ...(await original(channel)), engine: "agent", agentPhase, sessionId: "session-1" };
      }
      return original(channel, ...args);
    });
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    expect(container.querySelector(".th-session-state")?.textContent ?? container.textContent).toContain(label);
  });

  it("clears previous output on automatic Agent restart with the same PID and keeps new text", async () => {
    const original = invokeMock.getMockImplementation()!;
    let sessionId = "session-1";
    const status = () => ({
      running: true, engine: "agent", arch: "x64", pid: 1234, exeName: "game.exe",
      selectedHookId: "agent", hookCount: 1, agentPhase: "waiting", sessionId,
    });
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus") return status();
      return original(channel, ...args);
    });
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      ipcListeners.get("texthook.text")?.({}, { hookId: "agent", sessionId, text: "previous run" });
    });
    expect(container.querySelector(".texthook-output-pre")?.textContent).toBe("previous run");
    sessionId = "session-2";
    await act(async () => {
      ipcListeners.get("texthook.status")?.({}, status());
      ipcListeners.get("texthook.text")?.({}, { hookId: "agent", sessionId, text: "current run" });
      await flushAsyncWork();
    });
    expect(container.querySelectorAll(".texthook-output-pre")).toHaveLength(1);
    expect(container.querySelector(".texthook-output-pre")?.textContent).toBe("current run");
    await act(async () => {
      ipcListeners.get("texthook.status")?.({}, { ...status(), agentPhase: "receiving" });
      ipcListeners.get("texthook.text")?.({}, { hookId: "agent", sessionId: "session-1", text: "late old text" });
      await flushAsyncWork();
    });
    expect(container.querySelectorAll(".texthook-output-pre")).toHaveLength(1);
    expect(container.querySelector(".texthook-output-pre")?.textContent).toBe("current run");
  });

  it("surfaces automatic Agent initialization failures", async () => {
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      ipcListeners.get("texthook.agentError")?.({}, { error: "Unity was not ready. Load the game and attach again." });
    });
    expect(container.textContent).toContain("Unity was not ready. Load the game and attach again.");
    expect(container.querySelector("#texthook-view-console")?.hasAttribute("hidden")).toBe(false);
  });

  it("allows Stop during manual Agent startup without reporting cancellation as a failure", async () => {
    const original = invokeMock.getMockImplementation()!;
    let currentStatus: any = { running: false };
    let finishStart: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus") return currentStatus;
      if (channel === "texthook.getProfile") {
        return { engine: "agent", agentScriptPath: "C:\\scripts\\game.js" };
      }
      if (channel === "texthook.start") {
        currentStatus = {
          running: true, engine: "agent", arch: "x64", pid: 1234, exeName: "game.exe",
          selectedHookId: null, hookCount: 0, agentPhase: "starting", sessionId: "session-1",
        };
        ipcListeners.get("texthook.status")?.({}, currentStatus);
        return new Promise((resolve) => { finishStart = resolve; });
      }
      if (channel === "texthook.stop") {
        currentStatus = { running: false };
        ipcListeners.get("texthook.status")?.({}, currentStatus);
        finishStart({ success: false, error: "Agent startup was cancelled." });
        return { success: true };
      }
      return original(channel, ...args);
    });
    await act(async () => {
      root.render(<TextHookTab active />);
      await flushAsyncWork();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Start")!.click();
      await flushAsyncWork();
    });
    const stop = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Stop")!;
    expect(stop.disabled).toBe(false);
    await act(async () => { stop.click(); await flushAsyncWork(); });
    expect(invokeMock).toHaveBeenCalledWith("texthook.stop");
    expect(container.textContent).not.toContain("Agent startup was cancelled.");
  });

  it("does not let a stale status request replace a newer Agent session", async () => {
    const original = invokeMock.getMockImplementation()!;
    let finishStatus: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus") return new Promise((resolve) => { finishStatus = resolve; });
      return original(channel, ...args);
    });
    await act(async () => { root.render(<TextHookTab active />); await flushAsyncWork(); });
    const newStatus = {
      running: true, engine: "agent", arch: "x64", pid: 1234, exeName: "game.exe",
      selectedHookId: "agent", hookCount: 1, agentPhase: "receiving", sessionId: "new-session",
    };
    await act(async () => {
      ipcListeners.get("texthook.status")?.({}, newStatus);
      ipcListeners.get("texthook.text")?.({}, { hookId: "agent", sessionId: "new-session", text: "new dialogue" });
      finishStatus({ ...newStatus, sessionId: "old-session", agentPhase: "waiting" });
      await flushAsyncWork();
    });
    expect(container.querySelector(".th-session-state")?.textContent).toContain("Receiving text");
    expect(container.querySelector(".texthook-output-pre")?.textContent).toBe("new dialogue");
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
