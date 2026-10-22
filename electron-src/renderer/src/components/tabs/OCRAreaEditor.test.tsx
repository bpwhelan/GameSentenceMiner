// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { OCRCaptureMap, type CaptureMapConfig } from "./OCRCaptureMap";

const scene = { id: "scene", name: "Game" };
const frame = { sceneId: scene.id, sceneName: scene.name, sourceName: "Window", width: 1600, height: 900,
  imageData: "data:image/jpeg;base64,YQ==", capturedAt: 1, boxes: [] };
const invoke = vi.fn();
const onSaved = vi.fn();
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("editing OCR areas in the preview", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    invoke.mockReset().mockImplementation(async (channel, request) => channel === "ocr.get-preview" ? frame :
      { success: true, config: { coordinate_system: "percentage", rectangles: request.rectangles } });
    onSaved.mockReset();
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
  const render = async (config: CaptureMapConfig | null = null, currentScene = scene) => {
    await act(async () => {
      root.render(<I18nProvider><OCRCaptureMap key={currentScene.id} config={config} scene={currentScene}
        active disabled={false} ocrRunning onSaved={onSaved} /></I18nProvider>);
      await flush();
    });
  };
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => element.textContent === label || element.getAttribute("aria-label") === label)!;
  const click = async (label: string) => act(async () => { button(label).click(); await flush(); });
  const begin = async () => {
    await click("Edit areas in preview");
    const svg = container.querySelector<SVGSVGElement>(".desk-area-editor svg")!;
    // A 16:9 image inside a square SVG has 87.5px top/bottom letterboxing.
    svg.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 400 }) as DOMRect;
    svg.setPointerCapture = vi.fn();
    svg.hasPointerCapture = () => true;
    svg.releasePointerCapture = vi.fn();
    return svg;
  };
  const pointer = async (svg: SVGSVGElement, type: string, x: number, y: number, target: Element = svg, modifiers: MouseEventInit = {}) => {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ...modifiers });
      Object.defineProperty(event, "pointerId", { value: 1 });
      target.dispatchEvent(event);
    });
  };
  const draw = async (svg: SVGSVGElement) => {
    await pointer(svg, "pointerdown", 50, 130);
    await pointer(svg, "pointermove", 250, 220);
    await pointer(svg, "pointerup", 250, 220);
  };

  it.each([
    { modifiers: {}, excluded: false, secondary: false, exclusive: false, blackHole: false },
    { modifiers: { shiftKey: true }, excluded: true, secondary: false, exclusive: false, blackHole: false },
    { modifiers: { ctrlKey: true }, excluded: false, secondary: true, exclusive: false, blackHole: false },
    { modifiers: { altKey: true }, excluded: false, secondary: false, exclusive: true, blackHole: false },
    { modifiers: { shiftKey: true, ctrlKey: true }, excluded: true, secondary: true, exclusive: false, blackHole: false },
    { modifiers: { shiftKey: true, altKey: true }, excluded: false, secondary: false, exclusive: true, blackHole: false },
    { modifiers: { ctrlKey: true, altKey: true }, excluded: false, secondary: false, exclusive: false, blackHole: true },
    { modifiers: { shiftKey: true, ctrlKey: true, altKey: true }, excluded: false, secondary: false, exclusive: false, blackHole: true }
  ])("matches Qt's drag-start modifier flags for $modifiers", async ({ modifiers, excluded, secondary, exclusive, blackHole }) => {
    await render();
    const svg = await begin();
    await pointer(svg, "pointerdown", 50, 130, svg, modifiers);
    // Releasing modifiers mid-drag must not change the area type selected at pointerdown.
    await pointer(svg, "pointermove", 250, 220);
    const expectedKind = excluded ? "excluded" : blackHole ? "black-hole" : exclusive ? "exclusive" : secondary ? "secondary" : "normal";
    expect(container.querySelector(".is-drawing")?.classList.contains("desk-map-area--" + expectedKind)).toBe(true);
    await pointer(svg, "pointerup", 250, 220);
    // The next unmodified drag must return to normal, not keep the previous modifier mode.
    await draw(svg);
    await click("Save areas");
    const saved = invoke.mock.calls.find(([channel]) => channel === "ocr.save-preview-areas")![1];
    expect(saved.rectangles[0]).toMatchObject({ is_excluded: excluded, is_secondary: secondary, is_exclusive: exclusive, is_black_hole: blackHole });
    expect(saved.rectangles[1]).toMatchObject({ is_excluded: false, is_secondary: false, is_exclusive: false, is_black_hole: false });
  });

  it("keeps an explicitly selected type authoritative until keyboard modifiers are selected again", async () => {
    await render();
    const svg = await begin();
    const selectMode = async (mode: string) => act(async () => {
      const select = container.querySelector("select")!;
      select.value = mode;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await selectMode("excluded");
    await pointer(svg, "pointerdown", 50, 130, svg, { ctrlKey: true, altKey: true });
    await pointer(svg, "pointerup", 250, 220);
    await draw(svg);
    await selectMode("modifiers");
    await pointer(svg, "pointerdown", 50, 130, svg, { ctrlKey: true });
    await pointer(svg, "pointerup", 250, 220);
    await click("Save areas");
    const saved = invoke.mock.calls.find(([channel]) => channel === "ocr.save-preview-areas")![1];
    expect(saved.rectangles[0]).toMatchObject({ is_excluded: true, is_black_hole: false });
    expect(saved.rectangles[1]).toMatchObject({ is_excluded: true, is_black_hole: false });
    expect(saved.rectangles[2]).toMatchObject({ is_excluded: false, is_secondary: true });
  });

  it("freezes the preview and saves source-relative rectangles, excluding letterboxing", async () => {
    await render();
    const svg = await begin();
    const captures = invoke.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(3000); await flush(); });
    expect(invoke).toHaveBeenCalledTimes(captures);
    await draw(svg);
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(1);
    await click("Save areas");
    expect(invoke).toHaveBeenCalledWith("ocr.save-preview-areas", expect.objectContaining({
      sceneId: "scene", sceneName: "Game", rectangles: [expect.objectContaining({ coordinates: [0.1, 0.1, 0.5, 0.4] })]
    }));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(container.querySelector(".desk-area-editor")).toBeNull();
  });

  it("supports reverse drags, clamps to the image, and ignores clicks and letterbox starts", async () => {
    await render();
    const svg = await begin();
    await pointer(svg, "pointerdown", 50, 30);
    await pointer(svg, "pointerup", 250, 220);
    await pointer(svg, "pointerdown", 100, 150);
    await pointer(svg, "pointerup", 101, 151);
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(0);
    await pointer(svg, "pointerdown", 210, 220);
    await pointer(svg, "pointerup", -100, -100);
    await click("Save areas");
    expect(invoke).toHaveBeenCalledWith("ocr.save-preview-areas", expect.objectContaining({
      rectangles: [expect.objectContaining({ coordinates: [0, 0, 0.5, 0.5] })]
    }));
  });

  it("keeps existing metadata, draws special areas, and supports remove, undo, clear and cancel", async () => {
    const existing = { coordinates: [0, 0, 0.2, 0.2], monitor: { index: 2 }, is_excluded: true };
    await render({ coordinate_system: "percentage", rectangles: [existing] });
    const svg = await begin();
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "black-hole";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await draw(svg);
    expect(container.querySelectorAll(".desk-map-area--black-hole")).toHaveLength(1);
    await click("Remove");
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(1);
    await click("Undo");
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(2);
    await click("Clear all");
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(0);
    await click("Undo");
    await click("Save areas");
    const saved = invoke.mock.calls.find(([channel]) => channel === "ocr.save-preview-areas")![1];
    expect(saved.rectangles[0]).toEqual(existing);
    expect(saved.rectangles[1].is_black_hole).toBe(true);
    const secondSvg = await begin();
    await draw(secondSvg);
    await click("Cancel");
    expect(invoke.mock.calls.filter(([channel]) => channel === "ocr.save-preview-areas")).toHaveLength(1);
  });

  it("keeps a failed save editable, then retries successfully", async () => {
    await render();
    const svg = await begin();
    await draw(svg);
    invoke.mockResolvedValueOnce({ success: false, error: "conflict" });
    await click("Save areas");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
    invoke.mockRejectedValueOnce(new Error("Disconnected"));
    await click("Save areas");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
    await click("Save areas");
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("discards cancelled strokes and drafts from a previous scene", async () => {
    await render();
    const svg = await begin();
    await pointer(svg, "pointerdown", 50, 130);
    await pointer(svg, "pointermove", 250, 220);
    await pointer(svg, "pointercancel", 250, 220);
    expect(container.querySelectorAll(".desk-map-area")).toHaveLength(0);
    await draw(svg);
    await render(null, { id: "other", name: "Other" });
    expect(container.querySelector(".desk-area-editor")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not allow editing a legacy pixel layout or a missing preview", async () => {
    await render({ coordinate_system: "screen", rectangles: [{ coordinates: [10, 10, 200, 100] }] });
    expect(button("Edit areas in preview").disabled).toBe(true);
    expect(container.textContent).toContain("Use Open Area Selector");
    invoke.mockResolvedValue(null);
    await render(null, { id: "missing", name: "Missing" });
    expect(button("Edit areas in preview").disabled).toBe(true);
  });
});
