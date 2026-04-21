// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeTab } from "./HomeTab";
import type { GsmStatus, ObsWindow } from "../../types/models";

const invokeMock = vi.fn();
const sendMock = vi.fn();

const okStatus: GsmStatus = {
  ready: true,
  status: "Running",
  websockets_connected: {},
  obs_connected: true,
  anki_connected: true,
  clipboard_enabled: true,
};

function setElementValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  eventName: "input" | "change",
) {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("HomeTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let windowFetchCount: number;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invokeMock.mockReset();
    sendMock.mockReset();
    windowFetchCount = 0;

    const firstWindowList: ObsWindow[] = [
      {
        title: "Original Window Title",
        value: "window-1",
        targetKind: "window",
      },
    ];
    const refreshedWindowList: ObsWindow[] = [
      {
        title: "Refreshed Window Title",
        value: "window-1",
        targetKind: "window",
      },
    ];

    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "get_gsm_status") {
        return okStatus;
      }
      if (channel === "obs.getScenes") {
        return [];
      }
      if (channel === "obs.getActiveScene") {
        return null;
      }
      if (channel === "obs.getCaptureCardProbeEnabled") {
        return false;
      }
      if (channel === "obs.getWindows") {
        windowFetchCount += 1;
        return windowFetchCount === 1 ? firstWindowList : refreshedWindowList;
      }
      return null;
    });

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

  it("does not overwrite a manually edited override scene name during window refresh polling", async () => {
    await act(async () => {
      root.render(<HomeTab active />);
      await flushAsyncWork();
    });

    const windowSelect = container.querySelector("#home-window-select");
    expect(windowSelect).toBeInstanceOf(HTMLSelectElement);

    await act(async () => {
      setElementValue(windowSelect as HTMLSelectElement, "window-1", "change");
      await flushAsyncWork();
    });

    const overrideInput = container.querySelector("#home-scene-name-override");
    expect(overrideInput).toBeInstanceOf(HTMLInputElement);
    expect((overrideInput as HTMLInputElement).value).toBe("Original Window Title");

    await act(async () => {
      setElementValue(overrideInput as HTMLInputElement, "My Custom Scene", "input");
      await flushAsyncWork();
    });

    expect((overrideInput as HTMLInputElement).value).toBe("My Custom Scene");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await flushAsyncWork();
    });

    const overrideInputAfterRefresh = container.querySelector("#home-scene-name-override");
    expect(overrideInputAfterRefresh).toBeInstanceOf(HTMLInputElement);
    expect((overrideInputAfterRefresh as HTMLInputElement).value).toBe("My Custom Scene");
  });
});
