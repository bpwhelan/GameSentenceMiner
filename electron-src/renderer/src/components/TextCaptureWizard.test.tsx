// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { TextCaptureWizard } from "./TextCaptureWizard";

const invokeMock = vi.fn();
const sendMock = vi.fn();
const ipcListeners = new Map<string, Set<(...args: unknown[]) => void>>();

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function emitIpc(channel: string, ...args: unknown[]) {
  for (const listener of ipcListeners.get(channel) ?? []) {
    listener({}, ...args);
  }
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const button =
    buttons.find((candidate) => candidate.textContent?.trim() === text) ??
    buttons.find((candidate) => candidate.textContent?.includes(text));
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

async function clickButton(container: HTMLElement, text: string) {
  await act(async () => {
    findButton(container, text).click();
    await flushAsyncWork();
  });
}

describe("TextCaptureWizard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockReset();
    sendMock.mockReset();
    ipcListeners.clear();

    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke: invokeMock,
        send: sendMock,
        on: (channel: string, listener: (...args: unknown[]) => void) => {
          const listeners = ipcListeners.get(channel) ?? new Set();
          listeners.add(listener);
          ipcListeners.set(channel, listeners);
          return () => listeners.delete(listener);
        },
        once: () => {},
        removeListener: () => {},
        removeAllListeners: () => {},
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
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows the game capture switch when the preview snapshot has no capture mode", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          exeName: "ExampleGame.exe",
        };
      }
      if (channel === "obs.getScenePreviewSnapshot") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          sourceName: "Example Game",
          captureMode: null,
          imageData: null,
        };
      }
      if (channel === "obs.getSceneCaptureMode") return "window_capture";
      if (channel === "obs.switchSceneCaptureMode") return "game_capture";
      return null;
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard
            initialScene={scene}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
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

  it("shows Done next to Back in the footer on the final step", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    const onClose = vi.fn();
    invokeMock.mockResolvedValue(null);

    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard
            initialScene={scene}
            onClose={onClose}
          />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });

    const reviewStep = Array.from(container.querySelectorAll(".capture-wizard-crumb")).find(
      (button) => button.textContent?.includes("Review"),
    );
    expect(reviewStep).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (reviewStep as HTMLButtonElement).click();
    });

    const footerButtons = Array.from(container.querySelectorAll(".capture-wizard-footer-actions button"));
    expect(footerButtons.map((button) => button.textContent)).toEqual(["Back", "Done"]);

    await act(async () => {
      (footerButtons[1] as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens manual Agent script search and selects a script from the dialog", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          exeName: "ExampleGame.exe",
        };
      }
      if (channel === "settings.resolveAgentScriptForScene") {
        return {
          status: "success",
          path: "C:\\Agent\\data\\scripts\\PC_Steam_9-nine.js",
          candidates: [
            { path: "C:\\Agent\\data\\scripts\\PC_Steam_9-nine.js", score: 0.1 },
          ],
        };
      }
      if (channel === "settings.listAgentScripts") {
        return {
          scripts: [
            "C:\\Agent\\data\\scripts\\PC_Steam_9-nine.js",
            "C:\\Agent\\data\\scripts\\PC_Steam_Nier_Replicant.js",
          ],
        };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard
            initialScene={scene}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });

    const agentStep = Array.from(container.querySelectorAll(".capture-wizard-crumb")).find(
      (button) => button.textContent?.includes("Agent"),
    );
    expect(agentStep).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (agentStep as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    const searchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Search scripts",
    );
    expect(searchButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (searchButton as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    const searchInput = container.querySelector<HTMLInputElement>(
      ".agent-script-search-dialog input[type='search']",
    );
    expect(searchInput).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(searchInput, "Nier");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
      await flushAsyncWork();
    });

    const nierOption = Array.from(container.querySelectorAll(".agent-script-search-option")).find(
      (button) => button.textContent?.includes("Nier Replicant"),
    );
    expect(nierOption).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (nierOption as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    const selectedScript = container.querySelector(".capture-wizard-script[aria-pressed='true']");
    expect(selectedScript?.textContent).toContain("Nier Replicant");
  });

  it("saves Agent as an integrated text-hook profile without enabling the external launcher", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    const scriptPath = "C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js";
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          exeName: "ExampleGame.exe",
        };
      }
      if (channel === "settings.resolveAgentScriptForScene") {
        return { status: "success", path: scriptPath };
      }
      if (channel === "settings.listAgentScripts") return { scripts: [scriptPath] };
      if (channel === "settings.listGSMProfiles") return { profiles: ["Default"] };
      if (channel === "texthook.saveProfile") return { success: true };
      if (channel === "settings.saveSceneLaunchProfile") return { success: true };
      return null;
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard initialScene={scene} onClose={() => {}} />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });
    await clickButton(container, "Agent");
    await clickButton(container, "Use selected script");
    await clickButton(container, "Save setup");

    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", {
      scene,
      textHookMode: "none",
      ocrMode: "none",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", {
      exeName: "ExampleGame.exe",
      sceneId: scene.id,
      engine: "agent",
      autoHook: true,
      flushDelayMs: 100,
      copyToClipboard: false,
      hookId: null,
      hookFunction: null,
      manualHookCode: null,
      agentScriptPath: scriptPath,
    });
  });

  it("saves a Luna hook with the same scene-scoped profile fields as the Text Hook tab", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    const hook = {
      id: "hook-7",
      function: "Dialogue (123:456)",
      preview: "こんにちは",
      samples: ["こんにちは"],
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          exeName: "ExampleGame.exe",
        };
      }
      if (channel === "texthook.getStatus") {
        return {
          running: true,
          engine: "luna",
          arch: "x64",
          pid: 123,
          exeName: "ExampleGame.exe",
          selectedHookId: hook.id,
          hookCount: 1,
        };
      }
      if (channel === "texthook.listHooks") {
        return { hooks: [hook], selectedHookId: hook.id };
      }
      if (channel === "settings.listGSMProfiles") return { profiles: ["Default"] };
      if (channel === "texthook.saveProfile") return { success: true };
      if (channel === "settings.saveSceneLaunchProfile") return { success: true };
      return null;
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard initialScene={scene} onClose={() => {}} />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });
    await clickButton(container, "Hooks");
    await clickButton(container, "Use selected hook");
    await clickButton(container, "Save setup");

    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", {
      exeName: "ExampleGame.exe",
      sceneId: scene.id,
      engine: "luna",
      autoHook: true,
      flushDelayMs: 100,
      copyToClipboard: false,
      hookId: hook.id,
      hookFunction: hook.function,
      manualHookCode: null,
      agentScriptPath: null,
    });
  });

  it("runs one OCR scan after area selection and previews the captured text", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          exeName: "ExampleGame.exe",
        };
      }
      if (channel === "ocr.get-running-state") {
        return { isRunning: false, mode: "none", source: null };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard initialScene={scene} onClose={() => {}} />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });
    await clickButton(container, "OCR");
    await clickButton(container, "Select OCR area");

    expect(sendMock).toHaveBeenCalledWith("ocr.run-screen-selector");

    await act(async () => {
      emitIpc("ocr-screen-selector-finished", { success: true });
      await flushAsyncWork();
    });
    expect(sendMock).toHaveBeenCalledWith("ocr.start-ocr-ss-only");

    await act(async () => {
      emitIpc("ocr-ipc-started");
      await flushAsyncWork();
    });
    expect(sendMock).toHaveBeenCalledWith("ocr.manual-ocr");

    await act(async () => {
      emitIpc("ocr-ipc-message", {
        event: "ocr_result",
        data: { text: "最初の会話サンプル" },
      });
      await flushAsyncWork();
    });

    expect(container.querySelector(".capture-wizard-ocr-sample")?.textContent).toBe(
      "最初の会話サンプル",
    );
    expect(container.textContent).not.toContain("Smaller areas avoid menus");
  });

  it("saves the selected automatic OCR startup mode for the game", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return scene;
      if (channel === "texthook.getActiveCapture") {
        return {
          sceneName: scene.name,
          sceneId: scene.id,
          exeName: "ExampleGame.exe",
        };
      }
      if (channel === "settings.listGSMProfiles") return { profiles: ["Default"] };
      if (channel === "settings.saveSceneLaunchProfile") return { success: true };
      return null;
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard initialScene={scene} onClose={() => {}} />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });
    await clickButton(container, "OCR");

    const autoOcr = container.querySelector<HTMLInputElement>(
      'input[name="capture-wizard-ocr-automation"][value="auto"]',
    );
    expect(autoOcr).toBeInstanceOf(HTMLInputElement);
    await act(async () => {
      autoOcr!.click();
      await flushAsyncWork();
    });

    await clickButton(container, "Continue");
    await clickButton(container, "Save setup");

    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", {
      scene,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    });
  });
});
