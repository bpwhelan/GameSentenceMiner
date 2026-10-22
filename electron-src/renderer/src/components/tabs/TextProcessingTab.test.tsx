// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { TextProcessingTab } from "./TextProcessingTab";

describe("TextProcessingTab workspace", () => {
  let container: HTMLDivElement;
  let root: Root;
  const invoke = vi.fn();
  const listeners = new Map<string, (...args: any[]) => void>();

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    listeners.clear();
    let storedConfig: any = {
      string_replacement: { enabled: true, rules: [
        { enabled: true, mode: "plain", find: "old", replace: "new", case_sensitive: false, whole_word: false },
      ] },
    };
    invoke.mockReset().mockImplementation(async (channel: string, payload: any) => {
      if (channel === "textprocess.load") return storedConfig;
      if (channel === "textprocess.save") storedConfig = payload;
      if (channel === "textprocess.latestText") return { text: "latest game text" };
      if (channel === "textprocess.preview") {
        let result = payload.text;
        if (payload.config.string_replacement.enabled) {
          for (const rule of payload.config.string_replacement.rules) {
            if (rule.enabled && rule.find) result = result.replace(rule.find, rule.replace);
          }
        }
        return { success: true, result };
      }
      return { success: true };
    });
    Object.defineProperty(window, "ipcRenderer", { configurable: true, value: {
      invoke,
      on: (channel: string, listener: (...args: any[]) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function render(active = true) {
    await act(async () => root.render(<I18nProvider><TextProcessingTab active={active} /></I18nProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(300));
  }

  async function edit(selector: string, value: string) {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    await act(async () => {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function saveCalls() {
    return invoke.mock.calls.filter(([channel]) => channel === "textprocess.save");
  }

  it("shows every processor, replacement rules, and both preview fields without switching views", async () => {
    await render();
    expect(container.querySelectorAll('[role="list"] > [role="listitem"]')).toHaveLength(13);
    expect(container.querySelector<HTMLInputElement>(".rule-find-input")?.value).toBe("old");
    expect(container.querySelectorAll("textarea")).toHaveLength(2);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>("#text-preview-output")?.value).toBe("latest game text");
    expect(container.querySelector(".text-processing-header button")).toBeNull();
    expect(container.querySelector(".text-processing-header [role='status']")).toBeNull();
    expect(saveCalls()).toHaveLength(0);
  });

  it("keeps an empty manual sample until live text is explicitly resumed", async () => {
    await render();
    const input = container.querySelector<HTMLTextAreaElement>("#text-preview-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => listeners.get("textprocess-latest-text")?.({}, { text: "incoming" }));
    expect(input.value).toBe("");
    const follow = container.querySelector<HTMLButtonElement>(".text-preview-follow")!;
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    await act(async () => follow.click());
    expect(input.value).toBe("latest game text");
    expect(follow.getAttribute("aria-pressed")).toBe("true");
  });

  it("automatically saves the same reordered pipeline used by the preview", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('.processor-item-actions button[aria-label="Move down"]')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(300));
    const previewConfig = invoke.mock.calls.filter(([channel]) => channel === "textprocess.preview").slice(-1)[0][1].config;
    expect(previewConfig.processor_order.slice(0, 2)).toEqual(["remove_repeated_chars", "string_replacement"]);
    expect(invoke).toHaveBeenCalledWith("textprocess.save", previewConfig);
  });

  it("saves only the final replacement edit after typing pauses and refreshes the output", async () => {
    await render();
    await edit("#text-preview-input", "old text");
    await edit(".rule-replace-input", "n");
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await edit(".rule-replace-input", "newer");
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(saveCalls()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0][1].string_replacement.rules[0].replace).toBe("newer");
    expect(container.querySelector<HTMLTextAreaElement>("#text-preview-output")?.value).toBe("newer text");
    expect(saveCalls()[0][1]).not.toHaveProperty("previewInput");
  });

  it("saves processor toggles and updates the preview without persisting sample text", async () => {
    await render();
    await edit("#text-preview-input", "old text");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls()).toHaveLength(0);
    expect(container.querySelector<HTMLTextAreaElement>("#text-preview-output")?.value).toBe("new text");
    await act(async () => container.querySelector<HTMLInputElement>(".processor-toggle input")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0][1].string_replacement.enabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>("#text-preview-output")?.value).toBe("old text");
  });

  it("preserves pending edits when immediately switching away and back", async () => {
    await render();
    await edit(".rule-replace-input", "kept");
    await act(async () => root.render(<I18nProvider><TextProcessingTab active={false} /></I18nProvider>));
    await act(async () => root.render(<I18nProvider><TextProcessingTab active /></I18nProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls().slice(-1)[0]?.[1].string_replacement.rules[0].replace).toBe("kept");
    expect(container.querySelector<HTMLInputElement>(".rule-replace-input")?.value).toBe("kept");
  });

  it("keeps newer edits pending when an older save finishes", async () => {
    await render();
    const implementation = invoke.getMockImplementation()!;
    let finishSave!: (result: { success: boolean }) => void;
    invoke.mockImplementation((channel: string, payload: any) => {
      if (channel === "textprocess.save" && saveCalls().length === 1) {
        return new Promise((resolve) => { finishSave = resolve; });
      }
      return implementation(channel, payload);
    });
    await edit(".rule-replace-input", "first");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls()).toHaveLength(1);
    await edit(".rule-replace-input", "latest");
    await act(async () => finishSave({ success: true }));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls()).toHaveLength(2);
    expect(saveCalls()[1][1].string_replacement.rules[0].replace).toBe("latest");
  });

  it("does not replace a newly saved edit with a stale configuration load", async () => {
    await render();
    await render(false);
    const implementation = invoke.getMockImplementation()!;
    let finishLoad!: (config: unknown) => void;
    invoke.mockImplementation((channel: string, payload: any) => {
      if (channel === "textprocess.load") {
        return new Promise((resolve) => { finishLoad = resolve; });
      }
      return implementation(channel, payload);
    });
    await render();
    await edit(".rule-replace-input", "kept");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls()).toHaveLength(1);
    await act(async () => finishLoad({}));
    expect(container.querySelector<HTMLInputElement>(".rule-replace-input")?.value).toBe("kept");
  });

  it.each(["unmount", "beforeunload"])("flushes an edit before the debounce finishes on %s", async (event) => {
    await render();
    await edit(".rule-replace-input", "last edit");
    expect(saveCalls()).toHaveLength(0);
    await act(async () => {
      if (event === "unmount") root.render(<I18nProvider><div /></I18nProvider>);
      else window.dispatchEvent(new Event("beforeunload"));
    });
    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0][1].string_replacement.rules[0].replace).toBe("last edit");
  });

  it.each(["failure", "rejection"])("reports a save %s and saves again on the next edit", async (failure) => {
    await render();
    const implementation = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, payload: any) => {
      if (channel === "textprocess.save" && saveCalls().length === 1) {
        if (failure === "rejection") throw new Error("Save unavailable");
        return { success: false, error: "Save unavailable" };
      }
      return implementation(channel, payload);
    });
    await edit(".rule-replace-input", "first");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(container.querySelector("[role='status']")?.textContent).toMatch(/Save unavailable|Failed to save configuration/);
    await edit(".rule-replace-input", "retry");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(saveCalls()).toHaveLength(2);
    expect(saveCalls()[1][1].string_replacement.rules[0].replace).toBe("retry");
  });
});
