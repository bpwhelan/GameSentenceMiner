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
  expect(button, `Expected a button containing "${text}"`).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

async function clickButton(container: HTMLElement, text: string) {
  await act(async () => {
    findButton(container, text).click();
    await flushAsyncWork();
  });
}

const exampleScene = { id: "scene-1", name: "Example Game" };

function mockSceneContext(responses: Record<string, unknown> = {}) {
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel in responses) return responses[channel];
    if (channel === "obs.getActiveScene") return exampleScene;
    if (channel === "texthook.getActiveCapture") {
      return { sceneName: exampleScene.name, sceneId: exampleScene.id, exeName: "ExampleGame.exe" };
    }
    if (channel === "texthook.getStatus") return { running: false };
    if (channel === "texthook.listHooks") return { hooks: [], selectedHookId: null };
    if (channel === "settings.listGSMProfiles") return { profiles: ["Default"] };
    if (channel === "settings.saveSceneLaunchProfile" || channel === "texthook.saveProfile") {
      return { success: true };
    }
    return null;
  });
}

describe("TextCaptureWizard", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderWizard(onClose = vi.fn()) {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TextCaptureWizard initialScene={exampleScene} onClose={onClose} />
        </I18nProvider>,
      );
      await flushAsyncWork();
    });
    return onClose;
  }

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

  it("guides users through four steps and saves from the final footer", async () => {
    const scene = { id: "scene-1", name: "Example Game" };
    const onClose = vi.fn();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "settings.saveSceneLaunchProfile") return { success: true };
      return null;
    });

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

    const crumbs = Array.from(container.querySelectorAll(".capture-wizard-crumb"));
    expect(crumbs).toHaveLength(4);
    expect(crumbs.map((button) => button.textContent?.replace(/^\d\s*/, "").trim())).toEqual([
      "Capture", "Texthook", "OCR", "Finalize",
    ]);
    expect(findButton(container, "Capture looks right — choose text")).toBeInstanceOf(HTMLButtonElement);

    await clickButton(container, "Capture looks right — choose text");
    expect(findButton(container, "Continue to OCR")).toBeInstanceOf(HTMLButtonElement);
    await clickButton(container, "Continue to OCR");
    expect(findButton(container, "Use OCR and finalize")).toBeInstanceOf(HTMLButtonElement);

    const reviewStep = crumbs.find(
      (button) => button.textContent?.includes("Finalize"),
    );
    expect(reviewStep).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (reviewStep as HTMLButtonElement).click();
    });

    const footerButtons = Array.from(container.querySelectorAll(".capture-wizard-footer-actions button"));
    expect(footerButtons.map((button) => button.textContent)).toEqual(["Back", "Save and close"]);

    await act(async () => {
      (footerButtons[1] as HTMLButtonElement).click();
      await flushAsyncWork();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining({ scene }));
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
      (button) => button.textContent?.includes("Texthook"),
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
    expect(searchInput?.value).toBe("");
    expect(container.querySelectorAll(".agent-script-search-option")).toHaveLength(2);

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

    expect(container.querySelector(".agent-script-search-dialog")).toBeNull();
    expect(container.textContent).toContain("Nier Replicant");
    await clickButton(container, "Use this script");
    expect(findButton(container, "Keep text hook and finalize")).toBeInstanceOf(HTMLButtonElement);
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
        return { status: "success", path: scriptPath, reason: "matched_exact_name", candidates: [{ path: scriptPath, score: 0 }] };
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
    await clickButton(container, "Texthook");
    await clickButton(container, "Use this script");
    await clickButton(container, "Keep text hook and finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", {
      scene,
      textHookMode: "none",
      ocrMode: "none",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining({
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
    }));
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
    await clickButton(container, "Texthook");
    await clickButton(container, "Use selected hook");
    await clickButton(container, "Skip OCR and finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining({
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
    }));
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

    await clickButton(container, "Use OCR and finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", {
      scene,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    });
  });

  it("offers only a strong Agent recommendation inside the Texthook step", async () => {
    const recommendedPath = "C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js";
    const unrelatedPath = "C:\\Agent\\data\\scripts\\PC_Steam_Unrelated_Adventure.js";
    mockSceneContext({
      "settings.resolveAgentScriptForScene": {
        status: "success",
        path: recommendedPath,
        reason: "matched_exact_name",
        candidates: [
          { path: recommendedPath, score: 0 },
          { path: unrelatedPath, score: 0.8 },
        ],
      },
      "settings.listAgentScripts": { scripts: [recommendedPath, unrelatedPath] },
    });
    await renderWizard();
    await clickButton(container, "Texthook");

    expect(container.textContent).toContain("Luna");
    expect(container.textContent).toContain("Textractor");
    expect(container.textContent).toMatch(/visual novels/i);
    expect(container.textContent).toContain("Example Game");
    expect(container.textContent).not.toContain("Unrelated Adventure");
    expect(findButton(container, "Use this script")).toBeInstanceOf(HTMLButtonElement);
  });

  it("does not promote a weak resolved Agent script into a recommendation", async () => {
    const unrelatedPath = "C:\\Agent\\data\\scripts\\PC_Steam_Unrelated_Adventure.js";
    mockSceneContext({
      "settings.resolveAgentScriptForScene": {
        status: "success",
        path: unrelatedPath,
        reason: "matched_fuzzy_name",
        candidates: [{ path: unrelatedPath, reason: "matched_fuzzy_name", score: 0.65 }],
      },
      "settings.listAgentScripts": { scripts: [unrelatedPath] },
    });
    await renderWizard();
    await clickButton(container, "Texthook");

    expect(container.textContent).not.toContain("Unrelated Adventure");
    expect(Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent === "Use this script",
    )).toBe(false);
    await clickButton(container, "Search scripts");
    expect(container.querySelector(".agent-script-search-option")?.textContent).toContain("Unrelated Adventure");
  });

  it("starts manual Agent search with all scripts ranked using capture context", async () => {
    const matchingPath = "C:\\Agent\\data\\scripts\\PC_Steam_Nier_Replicant.js";
    const unrelatedPath = "C:\\Agent\\data\\scripts\\PC_Steam_9-nine.js";
    mockSceneContext({
      "settings.resolveAgentScriptForScene": {
        status: "no_match",
        windowTitle: "NieR Replicant",
        processName: "NieRReplicant.exe",
        candidates: [],
      },
      "settings.listAgentScripts": { scripts: [unrelatedPath, matchingPath] },
    });
    await renderWizard();
    await clickButton(container, "Texthook");
    await clickButton(container, "Search scripts");

    expect(container.querySelector<HTMLInputElement>(".agent-script-search-dialog input[type='search']")?.value).toBe("");
    const options = container.querySelectorAll(".agent-script-search-option");
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain("Nier Replicant");
    expect(options[1].textContent).toContain("9-nine");
  });

  it("surfaces engine start errors and lets users retry and stop in the wizard", async () => {
    let running = false;
    let startCount = 0;
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return exampleScene;
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: exampleScene.name, sceneId: exampleScene.id, exeName: "ExampleGame.exe" };
      }
      if (channel === "texthook.getStatus") {
        return running
          ? { running: true, engine: "luna", exeName: "ExampleGame.exe", pid: 123, arch: "x64", selectedHookId: null, hookCount: 0 }
          : { running: false };
      }
      if (channel === "texthook.listHooks") return { hooks: [], selectedHookId: null };
      if (channel === "texthook.start") {
        startCount += 1;
        if (startCount === 1) throw new Error("Game process could not be opened");
        running = true;
        return { success: true };
      }
      if (channel === "texthook.stop") {
        running = false;
        return { success: true };
      }
      return null;
    });
    await renderWizard();
    await clickButton(container, "Texthook");
    await clickButton(container, "Start hook engine");
    expect(container.textContent).toMatch(/Game process could not be opened|Failed to start/i);
    expect(findButton(container, "Start hook engine").disabled).toBe(false);

    await clickButton(container, "Start hook engine");
    expect(invokeMock).toHaveBeenCalledWith("texthook.start", expect.objectContaining({
      engine: "luna", exeName: "ExampleGame.exe",
    }));
    await clickButton(container, "Stop engine");
    expect(invokeMock).toHaveBeenCalledWith("texthook.stop");
    expect(findButton(container, "Start hook engine").disabled).toBe(false);
  });

  it("keeps the wizard open when saving fails and closes after a successful retry", async () => {
    const onClose = vi.fn();
    mockSceneContext({ "settings.saveSceneLaunchProfile": { success: false, error: "Save unavailable" } });
    await renderWizard(onClose);
    await clickButton(container, "Finalize");
    await clickButton(container, "Save and close");

    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/Failed to save setup|Save unavailable/);
    expect(findButton(container, "Save and close").disabled).toBe(false);

    mockSceneContext();
    await clickButton(container, "Save and close");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("loads an existing setup on open and preserves advanced settings when navigating and saving", async () => {
    const savedScriptPath = "C:\\Agent\\data\\scripts\\PC_Steam_Saved_Adventure.js";
    const savedHookProfile = {
      exeName: "ExampleGame.exe",
      sceneId: exampleScene.id,
      engine: "agent",
      autoHook: false,
      flushDelayMs: 375,
      copyToClipboard: true,
      hookId: null,
      hookFunction: null,
      manualHookCode: null,
      agentScriptPath: savedScriptPath,
      agentDetached: false,
    };
    mockSceneContext({
      "texthook.getProfile": savedHookProfile,
      "settings.getSceneLaunchProfile": {
        textHookMode: "none", ocrMode: "manual", launchOverlay: true, launchDelaySeconds: 8,
      },
      "settings.listAgentScripts": { scripts: ["C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js"] },
    });
    await renderWizard();
    expect(invokeMock).toHaveBeenCalledWith("texthook.getProfile", {
      exeName: "ExampleGame.exe", sceneId: exampleScene.id,
    });
    expect(invokeMock).toHaveBeenCalledWith("settings.getSceneLaunchProfile", exampleScene);

    await clickButton(container, "Texthook");
    expect(container.textContent).toContain("Saved Adventure");
    await clickButton(container, "OCR");
    expect(container.querySelector<HTMLInputElement>('input[name="capture-wizard-ocr-automation"][value="manual"]')?.checked).toBe(true);
    await clickButton(container, "Keep text hook and finalize");
    expect(container.querySelector(".capture-wizard-summary")?.textContent).toContain("Agent script");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining(savedHookProfile));
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining({
      scene: exampleScene, textHookMode: "none", ocrMode: "manual", launchOverlay: true, launchDelaySeconds: 8,
    }));
  });

  it("keeps a saved Luna hook and manual code when the runtime is stopped", async () => {
    const savedHookProfile = {
      exeName: "ExampleGame.exe",
      sceneId: exampleScene.id,
      engine: "luna",
      autoHook: true,
      flushDelayMs: 240,
      copyToClipboard: true,
      hookId: "saved-hook",
      hookFunction: "Saved dialogue hook",
      manualHookCode: "/HSN4@1234:ExampleGame.exe",
      agentScriptPath: null,
    };
    mockSceneContext({ "texthook.getProfile": savedHookProfile });
    await renderWizard();
    await clickButton(container, "Texthook");
    await clickButton(container, "OCR");
    await clickButton(container, "Keep text hook and finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining(savedHookProfile));
  });

  it("disables the saved text hook only when explicitly switching to OCR", async () => {
    const savedHookProfile = {
      exeName: "ExampleGame.exe",
      sceneId: exampleScene.id,
      engine: "luna",
      autoHook: true,
      flushDelayMs: 240,
      copyToClipboard: false,
      hookId: "saved-hook",
      hookFunction: "Saved dialogue hook",
      manualHookCode: null,
      agentScriptPath: null,
    };
    mockSceneContext({ "texthook.getProfile": savedHookProfile });
    await renderWizard();
    await clickButton(container, "OCR");

    expect(findButton(container, "Keep text hook and finalize")).toBeInstanceOf(HTMLButtonElement);
    expect(invokeMock).not.toHaveBeenCalledWith("texthook.saveProfile", expect.anything());

    await clickButton(container, "Use OCR and finalize");
    expect(container.querySelector(".capture-wizard-summary")?.textContent).toContain("OCR");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", {
      ...savedHookProfile, autoHook: false,
    });
  });

  it("uses the running Agent script without misattributing its hook to Luna", async () => {
    const scriptPath = "C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js";
    const hook = { id: "agent-hook", function: "Dialogue", preview: "会話", samples: ["会話"] };
    mockSceneContext({
      "texthook.getStatus": {
        running: true, engine: "agent", exeName: "ExampleGame.exe", pid: 123, arch: "x64",
        selectedHookId: hook.id, hookCount: 1, agentScriptPath: scriptPath,
      },
      "texthook.listHooks": { hooks: [hook], selectedHookId: hook.id },
    });
    await renderWizard();
    await clickButton(container, "Texthook");
    expect(Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent === "Use selected hook",
    )).toBe(false);
    await clickButton(container, "Use this script");
    await clickButton(container, "Keep text hook and finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining({
      engine: "agent", agentScriptPath: scriptPath,
    }));
  });

  it("does not accept a running hook belonging to a different game", async () => {
    const hook = { id: "other-game-hook", function: "Other game's dialogue", preview: "別のゲーム", samples: ["別のゲーム"] };
    mockSceneContext({
      "texthook.getStatus": {
        running: true, engine: "luna", exeName: "OtherGame.exe", pid: 456, arch: "x64",
        selectedHookId: hook.id, hookCount: 1,
      },
      "texthook.listHooks": { hooks: [hook], selectedHookId: hook.id },
    });
    await renderWizard();
    await clickButton(container, "Texthook");

    const useHook = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Use selected hook",
    );
    expect(useHook?.disabled ?? true).toBe(true);
    await clickButton(container, "Finalize");
    await clickButton(container, "Save and close");
    expect(invokeMock).not.toHaveBeenCalledWith("texthook.saveProfile", expect.anything());
  });

  it.each(["agent", "luna"] as const)("preserves OCR fallback when accepting the saved %s source again", async (engine) => {
    const scriptPath = "C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js";
    const hook = { id: "saved-hook", function: "Dialogue", preview: "会話", samples: ["会話"] };
    mockSceneContext({
      "texthook.getProfile": {
        engine, autoHook: true, agentScriptPath: engine === "agent" ? scriptPath : null,
        hookId: engine === "luna" ? hook.id : null,
        hookFunction: engine === "luna" ? hook.function : null,
      },
      "settings.getSceneLaunchProfile": {
        textHookMode: "none", ocrMode: "manual", launchOverlay: false, launchDelaySeconds: 0,
      },
      "texthook.getStatus": {
        running: true, engine, exeName: "ExampleGame.exe", pid: 123, arch: "x64",
        selectedHookId: hook.id, hookCount: 1, agentScriptPath: scriptPath,
      },
      "texthook.listHooks": { hooks: [hook], selectedHookId: hook.id },
    });
    await renderWizard();
    await clickButton(container, "Texthook");
    await clickButton(container, engine === "agent" ? "Use this script" : "Use selected hook");
    expect(container.querySelector<HTMLInputElement>('input[name="capture-wizard-ocr-automation"][value="manual"]')?.checked).toBe(true);
    await clickButton(container, "Keep text hook and finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining({ ocrMode: "manual" }));
  });

  it.each(["agent", "luna", "textractor"] as const)("preserves existing external %s automation with OCR when saving without a new source choice", async (engine) => {
    const sceneAutomation = {
      textHookMode: engine,
      ocrMode: "manual",
      launchOverlay: true,
      launchDelaySeconds: 6,
      agentScriptPath: engine === "agent" ? "C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js" : "",
    };
    mockSceneContext({ "settings.getSceneLaunchProfile": sceneAutomation });
    await renderWizard();
    await clickButton(container, "Finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", {
      scene: exampleScene, ...sceneAutomation,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("texthook.saveProfile", expect.anything());
  });

  it("clears the previous game's selections when refreshing to an unconfigured scene", async () => {
    let currentScene = exampleScene;
    const nextScene = { id: "scene-2", name: "Another Game" };
    const oldScriptPath = "C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js";
    invokeMock.mockImplementation(async (channel: string, payload?: { sceneId?: string }) => {
      if (channel === "obs.getActiveScene") return currentScene;
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: currentScene.name, sceneId: currentScene.id, exeName: currentScene.id === exampleScene.id ? "ExampleGame.exe" : "AnotherGame.exe" };
      }
      if (channel === "texthook.getProfile" && payload?.sceneId === exampleScene.id) {
        return { engine: "agent", autoHook: true, agentScriptPath: oldScriptPath };
      }
      if (channel === "texthook.getStatus") return { running: false };
      if (channel === "texthook.listHooks") return { hooks: [], selectedHookId: null };
      if (channel === "settings.saveSceneLaunchProfile" || channel === "texthook.saveProfile") return { success: true };
      return null;
    });
    await renderWizard();
    await clickButton(container, "Texthook");
    expect(container.querySelector(".capture-wizard-script")?.textContent).toContain("Example Game");
    await clickButton(container, "Capture");
    currentScene = nextScene;
    await clickButton(container, "Refresh");
    await clickButton(container, "Texthook");
    expect(container.querySelector(".capture-wizard-script")).toBeNull();
    await clickButton(container, "Finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).not.toHaveBeenCalledWith("texthook.saveProfile", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining({ scene: nextScene }));
  });

  it.each(["settings.getSceneLaunchProfile", "texthook.getProfile"])("blocks saving after %s fails and reloads saved settings on refresh", async (failedChannel) => {
    let failedOnce = false;
    const savedHook = {
      engine: "luna", autoHook: true, flushDelayMs: 350, copyToClipboard: true,
      hookId: "saved-hook", hookFunction: "Saved dialogue", manualHookCode: null, agentScriptPath: null,
    };
    const savedAutomation = {
      textHookMode: "none", ocrMode: "manual", launchOverlay: true, launchDelaySeconds: 9,
    };
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === failedChannel && !failedOnce) {
        failedOnce = true;
        throw new Error("Profile could not be read");
      }
      if (channel === "obs.getActiveScene") return exampleScene;
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: exampleScene.name, sceneId: exampleScene.id, exeName: "ExampleGame.exe" };
      }
      if (channel === "settings.getSceneLaunchProfile") return savedAutomation;
      if (channel === "texthook.getProfile") return savedHook;
      if (channel === "texthook.getStatus") return { running: false };
      if (channel === "texthook.listHooks") return { hooks: [], selectedHookId: null };
      if (channel === "settings.saveSceneLaunchProfile" || channel === "texthook.saveProfile") return { success: true };
      return null;
    });
    const onClose = await renderWizard();
    expect(container.textContent).toContain("Failed to load the active capture.");
    await clickButton(container, "Finalize");
    expect(findButton(container, "Save and close").disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("texthook.saveProfile", expect.anything());

    await clickButton(container, "Capture");
    await clickButton(container, "Refresh");
    await clickButton(container, "Finalize");
    expect(findButton(container, "Save and close").disabled).toBe(false);
    await clickButton(container, "Save and close");

    expect(onClose).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining(savedHook));
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining(savedAutomation));
  });

  it("leaves an unsupported saved hook engine unchanged when saving OCR fallback preferences", async () => {
    mockSceneContext({
      "texthook.getProfile": { engine: "mages", autoHook: true, flushDelayMs: 100 },
      "settings.getSceneLaunchProfile": {
        textHookMode: "none", ocrMode: "manual", launchOverlay: false, launchDelaySeconds: 0,
      },
    });
    await renderWizard();
    await clickButton(container, "Finalize");
    await clickButton(container, "Save and close");

    expect(invokeMock).not.toHaveBeenCalledWith("texthook.saveProfile", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("settings.saveSceneLaunchProfile", expect.objectContaining({ ocrMode: "manual" }));
  });

  it("saves a successfully started Agent script when jumping directly to Finalize", async () => {
    const scriptPath = "C:\\Agent\\data\\scripts\\PC_Steam_Example_Game.js";
    let running = false;
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getActiveScene") return exampleScene;
      if (channel === "texthook.getActiveCapture") {
        return { sceneName: exampleScene.name, sceneId: exampleScene.id, exeName: "ExampleGame.exe" };
      }
      if (channel === "settings.listAgentScripts") return { scripts: [scriptPath] };
      if (channel === "texthook.getStatus") {
        return running
          ? { running: true, engine: "agent", exeName: "ExampleGame.exe", pid: 123, arch: "x64", agentScriptPath: scriptPath, selectedHookId: null, hookCount: 0 }
          : { running: false };
      }
      if (channel === "texthook.listHooks") return { hooks: [], selectedHookId: null };
      if (channel === "texthook.start") {
        running = true;
        return { success: true };
      }
      if (channel === "settings.saveSceneLaunchProfile" || channel === "texthook.saveProfile") return { success: true };
      return null;
    });
    const onClose = await renderWizard();
    await clickButton(container, "Texthook");
    await clickButton(container, "Start script");
    expect(invokeMock).toHaveBeenCalledWith("texthook.start", expect.objectContaining({
      engine: "agent", agentScriptPath: scriptPath,
    }));
    await act(async () => {
      emitIpc("texthook.text", { text: "スクリプトで取得した会話" });
      await flushAsyncWork();
    });
    expect(container.querySelector('[role="log"]')?.textContent).toContain("スクリプトで取得した会話");
    await clickButton(container, "Finalize");
    await clickButton(container, "Save and close");

    expect(onClose).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining({
      engine: "agent", agentScriptPath: scriptPath, autoHook: true,
    }));
  });

  it("keeps a clicked hook row selected when continuing through the footer and saving", async () => {
    const previousHook = { id: "old-hook", function: "Menu text", preview: "メニュー", samples: ["メニュー"] };
    const selectedHook = { id: "dialogue-hook", function: "Dialogue text", preview: "選んだ会話", samples: ["選んだ会話"] };
    mockSceneContext({
      "texthook.getStatus": {
        running: true, engine: "textractor", exeName: "ExampleGame.exe", pid: 123, arch: "x64",
        selectedHookId: previousHook.id, hookCount: 2,
      },
      "texthook.listHooks": { hooks: [previousHook, selectedHook], selectedHookId: previousHook.id },
      "texthook.selectHook": { success: true },
    });
    const onClose = await renderWizard();
    await clickButton(container, "Texthook");
    await clickButton(container, selectedHook.preview);
    expect(invokeMock).toHaveBeenCalledWith("texthook.selectHook", selectedHook.id);
    await clickButton(container, "Continue to OCR");
    expect(findButton(container, "Keep text hook and finalize")).toBeInstanceOf(HTMLButtonElement);
    await clickButton(container, "Finalize");
    await clickButton(container, "Save and close");

    expect(onClose).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("texthook.saveProfile", expect.objectContaining({
      engine: "textractor", hookId: selectedHook.id, hookFunction: selectedHook.function, autoHook: true,
    }));
  });
});
