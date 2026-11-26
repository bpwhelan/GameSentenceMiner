// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { OCRCaptureMap } from "./OCRCaptureMap";

const invoke = vi.fn();
const scene = { id: "scene", name: "Game" };
const frame = {
  sceneId: "scene",
  sceneName: "Game",
  sourceName: "Window",
  width: 960,
  height: 720,
  imageData: "data:image/jpeg;base64,YQ==",
  capturedAt: 1,
  boxes: [
    {
      text: "Hello",
      points: [
        [0.1, 0.7],
        [0.8, 0.7],
        [0.8, 0.9],
        [0.1, 0.9]
      ]
    }
  ]
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe("OCR capture preview", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValue(frame);
    Object.defineProperty(window, "ipcRenderer", { configurable: true, value: { invoke } });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });
  const render = async (active = true, currentScene = scene) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <OCRCaptureMap
            config={null}
            active={active}
            scene={currentScene}
            ocrRunning
            disabled={false}
            onSaved={() => {}}
          />
        </I18nProvider>
      );
      await flush();
    });
  };
  it("places the image and detected boxes in the same aspect-correct SVG", async () => {
    await render();
    expect(invoke).toHaveBeenCalledWith("ocr.get-preview", {
      sceneId: "scene",
      sceneName: "Game",
      includeBoxes: true
    });
    expect(container.querySelector("image")?.getAttribute("href")).toBe(frame.imageData);
    expect(container.querySelector("svg.desk-map-source")?.getAttribute("viewBox")).toBe(
      "0 0 1000 750"
    );
    expect(container.querySelector(".desk-preview-box")?.getAttribute("points")).toBe(
      "100,525 800,525 800,675 100,675"
    );
  });

  it("hides detected text boxes without disabling live capture", async () => {
    await render();
    await act(async () => { container.querySelector<HTMLInputElement>(".desk-preview-box-toggle input")!.click(); });
    expect(container.querySelector(".desk-preview-box")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(invoke).toHaveBeenLastCalledWith("ocr.get-preview", expect.objectContaining({includeBoxes:false}));
  });

  it("only captures while the OCR tab is open", async () => {
    await render(false);
    expect(invoke).not.toHaveBeenCalled();
    await render();
    expect(invoke).toHaveBeenCalledTimes(1);
    await render(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("discards late images from the previous scene and recovers after capture failure", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await render();
    invoke.mockResolvedValue(null);
    await render(true, { id: "new", name: "Other" });
    await act(async () => {
      finish(frame);
      await flush();
    });
    expect(container.querySelector("image")).toBeNull();
    invoke.mockResolvedValue({ ...frame, sceneId: "new", sceneName: "Other" });
    await act(async () => {
      vi.advanceTimersByTime(15000);
      await flush();
    });
    expect(container.querySelector("image")?.getAttribute("href")).toBe(frame.imageData);
  });
});
