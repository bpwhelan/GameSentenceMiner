// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOCRPreview } from "./useOCRPreview";

const invoke = vi.fn();
const frame = {
  sceneId: "scene", sceneName: "Game", sourceName: "Window",
  width: 960, height: 540, imageData: "data:image/jpeg;base64,YQ==",
  capturedAt: 1, boxes: []
};
let container: HTMLDivElement, root: Root, renders: number;
function Preview() {
  const preview = useOCRPreview({ active: true, paused: false, sceneId: "scene", sceneName: "Game", includeBoxes: true });
  renders++;
  return <span>{preview.frame?.imageData}</span>;
}
const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  renders = 0;
  invoke.mockReset().mockImplementation(async () => ({ ...frame, capturedAt: Date.now() }));
  Object.defineProperty(window, "ipcRenderer", { configurable: true, value: { invoke } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<Preview />); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

it("backs off unchanged screenshots without committing repeated frames", async () => {
  const initialRenders = renders;
  await advance(30_000);
  expect(invoke.mock.calls.length).toBe(12);
  expect(renders).toBe(initialRenders);
});

it("returns to the live cadence after a change, including OCR geometry alone", async () => {
  await advance(12_000);
  invoke.mockResolvedValue({ ...frame, boxes: [{ text: "new", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }] });
  const beforeChange = invoke.mock.calls.length;
  for (let ms = 0; ms < 3000 && invoke.mock.calls.length === beforeChange; ms += 250) await advance(250);
  const count = invoke.mock.calls.length;
  await advance(1000);
  expect(invoke).toHaveBeenCalledTimes(count + 1);
});

it("resumes immediately on visibility and discards a request completed while hidden", async () => {
  let finish!: (result: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await advance(1000);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { finish({ ...frame, imageData: "data:image/jpeg;base64,Yg==" }); });
  expect(container.textContent).toBe(frame.imageData);
  const count = invoke.mock.calls.length;
  await advance(10_000);
  expect(invoke).toHaveBeenCalledTimes(count);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(invoke).toHaveBeenCalledTimes(count + 1);
});
