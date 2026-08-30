// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../i18n";
import { SpeechRecognitionTab } from "./SpeechRecognitionTab";

const invokeMock = vi.fn();

describe("SpeechRecognitionTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: Map<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    listeners = new Map();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "obs.getScenes") {
        return [
          { id: "scene-a", name: "Game A" },
          { id: "scene-b", name: "Game B" }
        ];
      }
      if (channel === "obs.getActiveScene") {
        return { id: "scene-a", name: "Game A" };
      }
      if (channel === "speech-recognition.loadScene") {
        return {
          success: true,
          exists: true,
          scene: { id: "scene-a", name: "Game A" },
          settings: {
            backend: "embedded",
            language: "ja",
            modelPath: "",
            runtimePath: "",
            licenseFile: ""
          }
        };
      }
      if (channel === "speech-recognition.saveScene" || channel === "speech-recognition.start") {
        return { success: true };
      }
      return { success: true };
    });
    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke: invokeMock,
        send: vi.fn(),
        on: (channel: string, listener: (...args: unknown[]) => void) => {
          listeners.set(channel, listener);
          return () => listeners.delete(channel);
        }
      }
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("saves and starts speech recognition for the selected OBS scene", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <SpeechRecognitionTab active />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Game A");
    expect(invokeMock).toHaveBeenCalledWith("speech-recognition.loadScene", {
      scene: { id: "scene-a", name: "Game A" }
    });

    const backend = container.querySelector<HTMLSelectElement>("#speech-backend");
    await act(async () => {
      if (backend) {
        backend.value = "sapi";
        backend.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const startButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Start Speech Recognition"
    );
    await act(async () => {
      startButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("speech-recognition.start", {
      scene: { id: "scene-a", name: "Game A" },
      settings: expect.objectContaining({ backend: "sapi", language: "ja" })
    });
  });

  it("shows backend log events in the local console", async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <SpeechRecognitionTab active />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const consoleElement = container.querySelector<HTMLDivElement>(".speech-recognition-console");
    if (!consoleElement) throw new Error("Speech recognition console was not rendered");
    Object.defineProperty(consoleElement, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(consoleElement, "scrollTop", { configurable: true, value: 0, writable: true });

    await act(async () => {
      listeners.get("speech-recognition.log")?.(
        { sender: null },
        { level: "result", message: "[final] 認識された文", timestamp: 1234 }
      );
    });

    expect(container.textContent).toContain("[final] 認識された文");
    expect(consoleElement.scrollTop).toBe(240);
  });
});
