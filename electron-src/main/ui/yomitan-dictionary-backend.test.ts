import { EventEmitter } from "node:events";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/yomitan_dictionary_backend.js",
);

function createClassList() {
  const values = new Set<string>();
  return {
    add(value: string) {
      values.add(value);
    },
    remove(value: string) {
      values.delete(value);
    },
    contains(value: string) {
      return values.has(value);
    },
    toggle(value: string, force?: boolean) {
      const enabled = force === undefined ? !values.has(value) : force;
      if (enabled) values.add(value);
      else values.delete(value);
      return enabled;
    },
  };
}

function createHarness() {
  const events = new EventEmitter();
  const root = {
    classList: createClassList(),
    dataset: {} as Record<string, string>,
  };
  const messages: unknown[] = [];
  const frameMessages: unknown[] = [];
  const frame = {
    style: { display: "block", visibility: "visible" },
    getBoundingClientRect: () => ({ width: 200, height: 100 }),
    getClientRects: () => [{}],
    contentWindow: {
      postMessage(message: unknown) {
        frameMessages.push(message);
      },
    },
  };
  const windowObject = {
    addEventListener(type: string, listener: (...args: any[]) => void) {
      events.on(type, listener);
    },
    removeEventListener(type: string, listener: (...args: any[]) => void) {
      events.off(type, listener);
    },
    postMessage(message: unknown) {
      messages.push(message);
    },
    getComputedStyle(candidate: typeof frame) {
      return candidate.style;
    },
  };
  const documentObject = {
    documentElement: root,
    querySelectorAll(selector: string) {
      return selector === "iframe.yomitan-popup" ? [frame] : [];
    },
    querySelector() {
      return frame;
    },
  };
  const bridge = {
    tokenize: vi.fn(async (text: string) => [{ text }]),
    closePopups: vi.fn(async () => ({ closed: true })),
  };
  return {
    bridge,
    documentObject,
    events,
    frameMessages,
    messages,
    root,
    windowObject,
  };
}

describe("YomitanDictionaryBackend", () => {
  it("gates popup scanning without disabling the tokenizer bridge", async () => {
    const { YomitanDictionaryBackend } = await import(modulePath);
    const harness = createHarness();
    const backend = new YomitanDictionaryBackend({
      window: harness.windowObject,
      document: harness.documentObject,
      getBridge: () => harness.bridge,
    });

    await backend.start();
    expect(harness.root.classList.contains("scan-disable")).toBe(false);

    backend.setScannerEnabled(false);
    expect(harness.root.classList.contains("scan-disable")).toBe(true);
    expect(harness.root.dataset.gsmDictionaryScanner).toBe("disabled");
    await expect(backend.tokenize("食べた", 10)).resolves.toEqual([
      { text: "食べた" },
    ]);
    expect(harness.bridge.tokenize).toHaveBeenCalledWith("食べた", 10, {});

    backend.setScannerEnabled(true);
    expect(harness.root.classList.contains("scan-disable")).toBe(false);
  });

  it("tags popup events with the generation active when each popup opened", async () => {
    const { YomitanDictionaryBackend } = await import(modulePath);
    const harness = createHarness();
    let generation = 4;
    const backend = new YomitanDictionaryBackend({
      window: harness.windowObject,
      document: harness.documentObject,
      getBridge: () => harness.bridge,
      getGeneration: () => generation,
    });
    const opened: unknown[] = [];
    const closed: unknown[] = [];
    backend.on("popup-opened", (event: unknown) => opened.push(event));
    backend.on("popup-closed", (event: unknown) => closed.push(event));
    await backend.start();

    harness.events.emit("yomitan-popup-shown", {
      detail: { popupId: "parent" },
    });
    generation = 5;
    harness.events.emit("yomitan-popup-shown", {
      detail: { popupId: "child" },
    });
    harness.events.emit("yomitan-popup-hidden", {
      detail: { popupId: "parent" },
    });

    expect(opened).toEqual([
      expect.objectContaining({ popupId: "parent", generation: 4 }),
      expect.objectContaining({ popupId: "child", generation: 5 }),
    ]);
    expect(closed).toEqual([
      expect.objectContaining({ popupId: "parent", generation: 4 }),
    ]);
  });

  it("maps generic commands onto one Yomitan control path", async () => {
    const { YomitanDictionaryBackend } = await import(modulePath);
    const harness = createHarness();
    const backend = new YomitanDictionaryBackend({
      window: harness.windowObject,
      document: harness.documentObject,
      getBridge: () => harness.bridge,
    });
    await backend.start();

    await backend.lookup({
      anchor: { x: 10, y: 30, width: 4, height: 8 },
      pointer: { x: 12, y: 34 },
      generation: 2,
    });
    await backend.command("next-entry", {});
    await backend.command("scroll", { direction: "down", amount: 110 });
    await backend.command("select-action", { direction: "previous" });
    await backend.command("mine", {});

    expect(harness.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "gsm-yomitan-control",
          action: "lookup-point",
          x: 12,
          y: 34,
        }),
        expect.objectContaining({
          type: "gsm-yomitan-control",
          action: "next-entry",
        }),
        expect.objectContaining({
          type: "gsm-yomitan-control",
          action: "scroll",
          direction: -1,
          step: 110,
        }),
        expect.objectContaining({
          type: "gsm-yomitan-control",
          action: "select-action",
          direction: -1,
        }),
        expect.objectContaining({
          type: "gsm-trigger-anki-add",
          cardFormatIndex: 0,
        }),
      ]),
    );
    expect(harness.frameMessages).not.toHaveLength(0);
  });

  it("closes popups and disables scanning when stopped", async () => {
    const { YomitanDictionaryBackend } = await import(modulePath);
    const harness = createHarness();
    const backend = new YomitanDictionaryBackend({
      window: harness.windowObject,
      document: harness.documentObject,
      getBridge: () => harness.bridge,
    });
    await backend.start();
    await backend.stop({ reason: "backend-switch" });

    expect(harness.bridge.closePopups).toHaveBeenCalled();
    expect(harness.root.classList.contains("scan-disable")).toBe(true);
    expect(harness.events.listenerCount("yomitan-popup-shown")).toBe(0);
  });
});
