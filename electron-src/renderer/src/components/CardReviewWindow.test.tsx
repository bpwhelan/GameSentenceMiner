// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CardReviewWindow } from "./CardReviewWindow";
import { keepRanges } from "./cardReviewAudio";
import * as reviewAudio from "./cardReviewAudio";

const invoke = vi.fn();
const form = {
  expression: "読む", expressionLabel: "Expression", sentence: "本を読む", translation: "Read a book",
  picture: "", previousPicture: "", canTranslate: true, canScreenshot: false,
  audio: { id: 0, url: null, duration: 0, available: false, reused: false, voice: false },
  dialogue: { id: 0, visible: false, lines: [] },
  preferences: { autoplay: false, timer: 0, step: 0.25, gamepad: null },
};
const entries = [
  { id: "abc", expression: "読む", sentence: "本を読む", scene: "Game", created: "2026-11-19T15:30:00Z" },
  { id: "def", expression: "見る", sentence: "映画を見る", scene: "Game", created: "2026-11-19T15:31:00Z" },
];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
  window.history.replaceState(null, "", "/");
  Object.defineProperty(window, "ipcRenderer", {
    configurable: true, value: { invoke, on: () => () => {} },
  });
  invoke.mockReset();
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => { root.render(<I18nProvider><CardReviewWindow /></I18nProvider>); });
}

async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button?.click());
}

async function type(text: string) {
  const input = container.querySelector("textarea");
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, text);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("sends immediate edits with the selected audio choice", async () => {
  invoke.mockImplementation(async (channel: string) => channel === "cardDialog.form" ? form : null);
  await render();
  await type("小説を読む");
  await click("Confirm");
  expect(invoke).toHaveBeenCalledWith("cardDialog.save", expect.objectContaining({
    entry: "", edit: expect.objectContaining({ sentence: "小説を読む", voice: false }),
  }));
});

it("advances while saving and keeps both drafts if the first card fails to save", async () => {
  window.history.replaceState(null, "", "/?window=session-review");
  let fail: (error: Error) => void = () => {};
  invoke.mockImplementation(async (channel: string, options) => {
    if (channel === "cardDialog.list") return { entries, autoAdvance: true };
    if (channel === "cardDialog.form") return options.entry === "abc" ? form : {
      ...form, expression: "見る", sentence: "映画を見る",
    };
    if (channel === "cardDialog.save") return new Promise((_, reject) => { fail = reject; });
    return null;
  });
  await render();
  await type("小説を読む");
  await click("Save");
  expect(container.querySelector("h2")?.textContent).toBe("見る");
  await type("ドラマを見る");
  await act(async () => fail(new Error("Anki is offline")));
  expect(container.querySelector("textarea")?.value).toBe("ドラマを見る");
  await click("読む · Retry");
  expect(container.querySelector("textarea")?.value).toBe("小説を読む");
});

it("skips overlapping audio cuts without repeating or dropping adjacent samples", () => {
  expect(keepRanges([2, 10], [[4, 6], [3, 5], [8, 12]])).toEqual([[2, 3], [6, 8]]);
});

it("keeps a live queue open after saving and appends arrivals without replacing edits", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/?window=session-review&live=1");
  let pending = entries.slice(0, 1);
  const playback = vi.spyOn(reviewAudio, "useReviewAudio");
  invoke.mockImplementation(async (channel: string, options) => {
    if (channel === "cardDialog.list") return { entries: pending, autoAdvance: true };
    if (channel === "cardDialog.form") return { ...form, preferences: { ...form.preferences, autoplay: true } };
    if (channel === "cardDialog.save") {
      pending = pending.filter(entry => entry.id !== options.entry);
      return "saved";
    }
  });
  try {
    await render();
    expect(invoke).toHaveBeenCalledWith("cardDialog.ready", expect.objectContaining({ live: true }));
    expect(document.activeElement).not.toBe(container.querySelector("input[type=search]"));
    expect(playback.mock.lastCall?.[3]).toBe(false);
    await type("My draft");
    pending = [...entries];
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(playback.mock.lastCall?.[3]).toBe(false);
    expect(container.querySelector("textarea")?.value).toBe("My draft");
    expect(container.querySelectorAll(".cr-queue button")).toHaveLength(2);
    await click("Save");
    expect(playback.mock.lastCall?.[3]).toBe(true);
    await click("Save");
    expect(invoke).not.toHaveBeenCalledWith("cardDialog.close", expect.anything());
    expect(container.querySelectorAll(".cr-queue button")).toHaveLength(0);
    pending = entries.slice(0, 1);
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(container.querySelector("textarea")?.value).toBe(form.sentence);
    expect(playback.mock.lastCall?.[3]).toBe(false);
  } finally {
    playback.mockRestore();
    vi.useRealTimers();
  }
});

it("edits and removes automatic cuts, restores them on reset, and saves the previewed filter", async () => {
  const fetch = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  invoke.mockImplementation(async (channel: string) => {
    if (channel === "cardDialog.form") return {
      ...form, audio: { ...form.audio, url: "/clip.wav", duration: 8, available: true, voice: true,
        initialRange: [1, 7], initialCuts: [[2, 3], [4, 5]] },
    };
    if (channel === "cardDialog.audioFilter") return "/filtered.wav";
    return null;
  });
  const press = (label: string, key: string) => act(async () => {
    const handle = container.querySelector(`button[aria-label="${label}"]`);
    expect(handle).not.toBeNull();
    handle?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await render();
  const graph = container.querySelector<HTMLDivElement>(".cr-wave-graph")!;
  graph.getBoundingClientRect = () => new DOMRect(0, 0, 800, 45);
  graph.setPointerCapture = vi.fn();
  const handle = graph.querySelector('[aria-label="Cut 1 start"]')!;
  await act(async () => handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 200 })));
  await act(async () => graph.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250 })));
  expect(graph.querySelector<HTMLElement>(".cr-wave-cut")?.style.left).toBe("31.25%");
  await act(async () => graph.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 250 })));
  await press("Cut 2 end", "Delete");
  expect(container.querySelectorAll(".cr-wave-cut")).toHaveLength(1);
  await click("Reset Edits");
  expect(container.querySelectorAll(".cr-wave-cut")).toHaveLength(2);
  await press("Cut 1 start", "ArrowRight");
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Audio filter"]')!;
  await act(async () => {
    select.value = "reduceRumble";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(invoke).toHaveBeenCalledWith("cardDialog.audioFilter", {
    entry: "", audio: 0, filter: "reduceRumble",
  });
  expect(fetch).toHaveBeenCalledWith("/filtered.wav", expect.anything());
  await click("Keep Audio");
  expect(invoke).toHaveBeenCalledWith("cardDialog.save", expect.objectContaining({
    edit: expect.objectContaining({ start: 1, end: 7, cuts: [[2.25, 3], [4, 5]], filter: "reduceRumble" }),
  }));
});
