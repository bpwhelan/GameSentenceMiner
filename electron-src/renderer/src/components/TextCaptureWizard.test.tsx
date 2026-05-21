// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { TextCaptureWizard } from "./TextCaptureWizard";

const invokeMock = vi.fn();
const sendMock = vi.fn();

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("TextCaptureWizard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockReset();
    sendMock.mockReset();

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
});
