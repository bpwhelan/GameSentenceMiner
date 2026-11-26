// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { OCRCaptureMap } from "./OCRCaptureMap";

const scene = {id:"id",name:"Game"};
const frame = {sceneId:"id",sceneName:"Game",sourceName:"Capture",width:800,height:400,
  imageData:"data:image/jpeg;base64,YQ==",capturedAt:1,boxes:[]};
const invoke = vi.fn(), saved = vi.fn();
let container: HTMLDivElement, root: Root;
const render = (active: boolean) => act(async () => root.render(<I18nProvider><OCRCaptureMap active={active} disabled={false}
  config={null} scene={scene} ocrRunning={false} onSaved={saved} /></I18nProvider>));
beforeEach(async () => {
  localStorage.clear();
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  saved.mockReset();
  invoke.mockReset().mockImplementation(async (channel, req) => {
    if (channel === "ocr.get-preview") return frame;
    if (channel === "ocr.preview-layout") return {rects:[],revision:"before",help:false};
    if (channel === "ocr.apply-preview-layout") return {revision:"after",config:{rectangles:req.rects}};
    throw Error(channel);
  });
  Object.defineProperty(window,"ipcRenderer",{configurable:true,value:{invoke}});
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await render(true);
  await act(async () => container.querySelector<HTMLButtonElement>(".desk-map-canvas")!.click());
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const click = async (label: string) => act(async () => {
  const button = [...container.querySelectorAll(".ocr-selector-workspace button")].find(b => b.textContent?.includes(label));
  expect(button, label).toBeDefined(); button!.click();
});

it("opens the shared selector in the hub and keeps edits through live frames", async () => {
  expect(container.querySelector(".ocr-selector-workspace")).not.toBeNull();
  expect(container.querySelectorAll(".ocr-selector-toolbar button[title]").length).toBeGreaterThanOrEqual(5);
  await click("Auto-Refresh");
  await click("Auto-Send");
  await click("All");
  invoke.mockImplementationOnce(async () => ({...frame,imageData:"data:image/jpeg;base64,Yg=="}));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(container.querySelector(".ocr-selector-image img")?.getAttribute("src")).toContain("Yg==");
  expect(container.querySelectorAll(".ocr-selector-box")).toHaveLength(1);
  await click("Undo"); expect(container.querySelectorAll(".ocr-selector-box")).toHaveLength(0);
  await click("Redo");
  await click("Save areas");
  expect(invoke).toHaveBeenCalledWith("ocr.apply-preview-layout", expect.objectContaining({
    sceneId:"id",sceneName:"Game",revision:"before",rects:[expect.objectContaining({xywh:[0,0,1,1]})]
  }));
  expect(saved).toHaveBeenCalledOnce();
  expect(container.querySelector(".ocr-selector-workspace")).toBeNull();
});
it("keeps drafts on a conflicting save and discards them on cancel", async () => {
  await click("Auto-Send");
  await click("All");
  invoke.mockResolvedValueOnce({error:"conflict"});
  await click("Save areas");
  expect(container.querySelector("[role=alert]")?.textContent).toContain("changed elsewhere");
  expect(container.querySelectorAll(".ocr-selector-box")).toHaveLength(1);
  await click("Cancel");
  expect(saved).not.toHaveBeenCalled();
  expect(container.querySelector(".ocr-selector-workspace")).toBeNull();
});
it("serializes the final save after Auto-Send with the updated file revision", async () => {
  await click("All");
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  await click("Undo");
  await click("Save areas");
  const writes = invoke.mock.calls.filter(([channel]) => channel === "ocr.apply-preview-layout");
  expect(writes.map(([,req]) => req.revision)).toEqual(["before", "after"]);
  expect(writes[0][1].rects).toHaveLength(1);
  expect(writes[1][1].rects).toHaveLength(0);
});

it("opens frozen, refreshes every second when enabled even in the background, and restores compact timing", async () => {
  const count = () => invoke.mock.calls.filter(([channel]) => channel === "ocr.get-preview").length;
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const initial = count();
  await advance(16000);
  expect(count()).toBe(initial);
  await click("⟳ Refresh");
  expect(count()).toBe(initial + 1);

  await click("Auto-Refresh");
  const enabled = count();
  await advance(900);
  vi.mocked(document.hasFocus).mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  await advance(100);
  expect(count()).toBe(enabled + 1);
  await advance(2000);
  expect(count()).toBe(enabled + 3);
  await click("Auto-Refresh");
  await advance(15000);
  expect(count()).toBe(enabled + 3);
  await click("Auto-Refresh");

  await click("Close");
  expect(saved).not.toHaveBeenCalled();
  const closed = count();
  await advance(14999);
  expect(count()).toBe(closed);
  await advance(1);
  expect(count()).toBe(closed + 1);
  await act(async () => container.querySelector<HTMLButtonElement>(".desk-map-canvas")!.click());
  const reopened = count();
  await advance(1000);
  expect(count()).toBe(reopened + 1);
});

it("preserves drafts and undo across tabs, ignores hidden shortcuts, and restores the preference after remount", async () => {
  await click("Auto-Send");
  await click("All");
  await click("Auto-Refresh");
  await render(false);
  const count = invoke.mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(invoke).toHaveBeenCalledTimes(count);
  await render(true);
  expect(container.querySelectorAll(".ocr-selector-box")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "ocr.preview-layout")).toHaveLength(1);
  await click("Undo");
  expect(container.querySelectorAll(".ocr-selector-box")).toHaveLength(0);
  await act(async () => root.render(null));
  await render(true);
  await act(async () => container.querySelector<HTMLButtonElement>(".desk-map-canvas")!.click());
  const toggle = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Auto-Refresh"));
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");
});

it("keeps the manually refreshed image when returning to a frozen editor", async () => {
  const updated = {...frame, imageData: "data:image/jpeg;base64,Yg=="};
  invoke.mockResolvedValueOnce(updated);
  await click("⟳ Refresh");
  const requests = invoke.mock.calls.length;
  await render(false);
  await render(true);
  expect(container.querySelector(".ocr-selector-image img")?.getAttribute("src")).toBe(updated.imageData);
  expect(invoke.mock.calls).toHaveLength(requests);
});
