// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOCRPreview } from "./useOCRPreview";

const invoke = vi.fn();
const frame = {sceneId:"id",sceneName:"Game",sourceName:"Game capture",width:16,height:9,
  imageData:"data:image/jpeg;base64,YQ==",capturedAt:1,boxes:[]};
let root: Root, renders: number, focused: boolean;
function Preview({active}: {active:boolean}) {
  const {frame: current} = useOCRPreview({active,sceneId:"id",sceneName:"Game",includeBoxes:true});
  renders++;
  return <span>{current?.imageData}</span>;
}
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const render = (active: boolean) => act(async () => { root.render(<Preview active={active} />); });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  renders = 0; focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  invoke.mockReset().mockImplementation(async () => ({...frame,capturedAt:Date.now()}));
  Object.defineProperty(window, "ipcRenderer", {configurable:true,value:{invoke}});
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers(); vi.restoreAllMocks();
});

it("refreshes every second in focus without rerendering identical frames", async () => {
  await render(true);
  const first = renders;
  await advance(3000);
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(renders).toBe(first);
});
it("switches to fifteen seconds on blur, resumes on focus and stops off tab", async () => {
  await render(true);
  focused = false; window.dispatchEvent(new Event("blur"));
  await advance(14999); expect(invoke).toHaveBeenCalledTimes(1);
  await advance(15001); expect(invoke).toHaveBeenCalledTimes(3);
  focused = true; await act(async () => { window.dispatchEvent(new Event("focus")); });
  await advance(1000); expect(invoke).toHaveBeenCalledTimes(5);
  await render(false); await advance(60000); expect(invoke).toHaveBeenCalledTimes(5);
});
it("keeps a slow capture single-flight and cancels polling on tab exit", async () => {
  let resolve!: (f: typeof frame) => void;
  invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render(true); await advance(20000); expect(invoke).toHaveBeenCalledTimes(1);
  await render(false); await act(async () => resolve(frame));
  await advance(30000); expect(invoke).toHaveBeenCalledTimes(1);
});
