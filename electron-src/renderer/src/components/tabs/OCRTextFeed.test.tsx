// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { IpcEventLike } from "../../types/global";
import { OCRTextFeed } from "./OCRTextFeed";

describe("OCR captured text", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: Map<string, Set<(event: IpcEventLike, ...args: unknown[]) => void>>;
  const writeText = vi.fn();

  const emit = (channel: string, payload?: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener({ sender: null }, payload);
  };
  const result = (text: string, extra: Record<string, unknown> = {}) => {
    emit("ocr-ipc-message", { event: "ocr_result", data: { text, ...extra } });
  };
  const render = async (running = true, paused = false, manual = false) => {
    await act(async () => {
      root.render(<I18nProvider><OCRTextFeed running={running} paused={paused} manual={manual} /></I18nProvider>);
    });
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listeners = new Map();
    writeText.mockReset();
    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        on: (channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void) => {
          const callbacks = listeners.get(channel) ?? new Set();
          callbacks.add(listener);
          listeners.set(channel, callbacks);
          return () => callbacks.delete(listener);
        }
      }
    });
    Object.defineProperty(window, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows only delivered text, preserving multiline output and keeping the newest capture first", async () => {
    await render();
    await act(async () => {
      emit("ocr-log", "OCR Run 1: Text recognized in 0.030s using OneOCR: unfinished");
      emit("ocr-log", "OCR Run 2: Text recognized in 0.200s using Google Lens: console-only");
      emit("ocr-log", "DEBUG OCR bus command received: get_status");
      result("最初の行\n次の行", { time: "2026-10-22T15:40:07", source: "ocr" });
      result("<b>そのままのテキスト</b>", { source: "secondary" });
    });
    const entries = container.querySelectorAll(".desk-text-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector(".desk-text-content")?.textContent).toBe("<b>そのままのテキスト</b>");
    expect(entries[0].querySelector("b")).toBeNull();
    expect(entries[1].querySelector(".desk-text-content")?.textContent).toBe("最初の行\n次の行");
    expect(entries[1].querySelector("time")?.dateTime).toBe(new Date("2026-10-22T15:40:07").toISOString());
    expect(container.textContent).not.toContain("console-only");
    expect(container.textContent).not.toContain("get_status");
    expect(entries[0].textContent).toContain("Menu capture");
  });

  it("ignores malformed and empty events, deduplicates deliveries, and bounds the history", async () => {
    await render();
    await act(async () => {
      for (const payload of [null, "noise", {}, { event: "status", data: { text: "noise" } },
        { event: "ocr_result" }, { event: "ocr_result", data: { text: 10 } }]) {
        emit("ocr-ipc-message", payload);
      }
      result("  \n  ");
      result("one delivery", { observationId: "same" });
      result("one delivery", { observationId: "same" });
    });
    expect(container.querySelectorAll(".desk-text-entry")).toHaveLength(1);
    await act(async () => {
      for (let index = 0; index < 60; index++) result(`line ${index}`);
    });
    const entries = container.querySelectorAll(".desk-text-content");
    expect(entries).toHaveLength(20);
    expect(entries[0].textContent).toBe("line 59");
    expect(entries[19].textContent).toBe("line 40");
  });

  it("summarizes repeated idle and skip messages without adding them to the history", async () => {
    await render();
    const status = () => container.querySelector('[role="status"]')!.textContent;
    expect(status()).toContain("Watching for text");
    await act(async () => {
      for (let index = 0; index < 10; index++) {
        emit("ocr-log", "2026-10-22 13:20:08 | BACKGROUND | No text detected, sleeping.");
      }
    });
    expect(status()).toContain("No text detected");
    await act(async () => emit("ocr-log", "\x1b[33mText is identified as all menu items, skipping further processing.\x1b[0m"));
    expect(status()).toContain("Menu text skipped");
    await act(async () => emit("ocr-log", "Text is inside a black hole OCR box, skipping further processing."));
    expect(status()).toContain("Text in an ignored area skipped");
    await act(async () => emit("ocr-log", "Seems like Text we already sent"));
    expect(status()).toContain("Repeated text skipped");
    expect(container.querySelectorAll(".desk-text-entry")).toHaveLength(0);
  });

  it("retains captured text through pause, stop and restart and resets stale activity", async () => {
    await render();
    await act(async () => {
      result("Keep this capture");
      emit("ocr-log", "No text detected, sleeping.");
    });
    await render(true, true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Paused");
    await render(false);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Stopped");
    await act(async () => emit("ocr-started"));
    await render(true, false, true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Starting OCR");
    await act(async () => emit("ocr-ipc-status", { manual: true }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Waiting for a capture");
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("No text detected");
    expect(container.querySelector(".desk-text-content")?.textContent).toBe("Keep this capture");
  });

  it("shows errors as brief activity and clears them on the next successful capture", async () => {
    await render();
    await act(async () => emit("ocr-ipc-error", "Very long technical error"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("OCR needs attention");
    expect(container.textContent).not.toContain("Very long technical error");
    await act(async () => result("Recovered"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Text captured");
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("OCR needs attention");
  });

  it("copies a capture and clears only this view", async () => {
    await render();
    await act(async () => result("Copy this\nwhole capture"));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy captured text"]')!.click());
    expect(writeText).toHaveBeenCalledWith("Copy this\nwhole capture");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Clear captured text"]')!.click());
    expect(container.querySelectorAll(".desk-text-entry")).toHaveLength(0);
    expect(container.textContent).toContain("Your captured text appears here");
  });

  it("buffers captured text while its view is hidden", async () => {
    await act(async () => root.render(<OCRTextFeed active={false} running paused={false} manual={false} />));
    await act(async () => {
      for (let i = 0; i < 25; i++) result(`Hidden capture ${i}`);
    });
    expect(container.querySelectorAll(".desk-text-entry")).toHaveLength(0);
    await act(async () => root.render(<OCRTextFeed active running paused={false} manual={false} />));
    const entries = container.querySelectorAll(".desk-text-content");
    expect(entries).toHaveLength(20);
    expect(entries[0].textContent).toBe("Hidden capture 24");
    expect(entries[19].textContent).toBe("Hidden capture 5");
  });

  it.each([
    ["en", "Captured text"],
    ["ja", "読み取ったテキスト"],
    ["ukr", "Захоплений текст"],
    ["zh", "捕获的文本"],
    ["ko", "캡처한 텍스트"],
    ["es", "Texto capturado"]
  ])("localizes the panel in %s", async (locale, title) => {
    await act(async () => {
      root.render(<I18nProvider initialLocale={locale}><OCRTextFeed running paused={false} manual={false} /></I18nProvider>);
    });
    expect(container.querySelector("h2")?.textContent).toBe(title);
    expect(container.textContent).not.toContain("ocr.activity.");
  });

  it("unsubscribes when unmounted", async () => {
    await render();
    await act(async () => root.unmount());
    expect([...listeners.values()].every((callbacks) => callbacks.size === 0)).toBe(true);
    root = createRoot(container);
  });
});
