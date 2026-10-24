// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { getDevPreviewTab, installDevPreviewBridge } from "./devPreview";

const originalUrl = window.location.href;

afterEach(() => {
  window.history.replaceState(null, "", originalUrl);
  Reflect.deleteProperty(window, "ipcRenderer");
  Reflect.deleteProperty(window, "clipboard");
  Reflect.deleteProperty(window, "gsmEnv");
});

describe("dev renderer preview", () => {
  it("does not install a bridge without an explicit preview tab", () => {
    window.history.replaceState(null, "", "/");

    installDevPreviewBridge();

    expect(getDevPreviewTab()).toBeNull();
    expect(window.ipcRenderer).toBeUndefined();
  });

  it("installs deterministic OCR preview data when requested", async () => {
    window.history.replaceState(null, "", "/?preview=ocr");

    installDevPreviewBridge();

    expect(getDevPreviewTab()).toBe("ocr");
    await expect(window.ipcRenderer.invoke("obs.getScenes")).resolves.toEqual([
      { id: "agent-preview", name: "Agent Preview" }
    ]);
    await expect(
      window.ipcRenderer.invoke("ocr.get-running-state")
    ).resolves.toEqual({ isRunning: false, mode: null, source: "preview" });
    expect(window.gsmEnv.platform).toBe("win32");
  });

  it("simulates start, pause, resume, and stop without a native OCR process", async () => {
    window.history.replaceState(null, "", "/?preview=ocr");
    installDevPreviewBridge();
    const statuses: unknown[] = [];
    window.ipcRenderer.on("ocr-ipc-status", (_event, status) => statuses.push(status));
    for (const [channel, mode] of [["ocr.start-ocr", "auto"], ["ocr.start-ocr-ss-only", "manual"]]) {
      window.ipcRenderer.send(channel);
      await expect(window.ipcRenderer.invoke("ocr.get-running-state")).resolves.toMatchObject({ isRunning: true, mode });
      for (const paused of [true, false]) {
        window.ipcRenderer.send("ocr.toggle-pause");
        expect(statuses[statuses.length - 1]).toMatchObject({ paused, manual: mode === "manual" });
      }
      window.ipcRenderer.send("ocr.kill-ocr");
      await expect(window.ipcRenderer.invoke("ocr.get-running-state")).resolves.toMatchObject({ isRunning: false, mode: null });
    }
  });

  it("delivers sample text for automatic and quick captures only while OCR is running", () => {
    window.history.replaceState(null, "", "/?preview=ocr");
    installDevPreviewBridge();
    const results: unknown[] = [];
    window.ipcRenderer.on("ocr-ipc-message", (_event, payload) => results.push(payload));
    window.ipcRenderer.send("ocr.manual-ocr");
    expect(results).toHaveLength(0);
    window.ipcRenderer.send("ocr.start-ocr");
    expect(results[0]).toMatchObject({ event: "ocr_result", data: { source: "ocr", text: expect.any(String) } });
    for (const [channel, source] of [
      ["ocr.manual-ocr", "ocr_manual"],
      ["ocr.menu-ocr", "secondary"],
      ["ocr.area-select-ocr", "screen_cropper"],
      ["ocr.whole-window-ocr", "ocr_manual"]
    ]) {
      window.ipcRenderer.send(channel);
      expect(results[results.length - 1]).toMatchObject({ event: "ocr_result", data: { source, time: expect.any(String) } });
    }
    window.ipcRenderer.send("ocr.kill-ocr");
    window.ipcRenderer.send("ocr.manual-ocr");
    expect(results).toHaveLength(5);
  });
});
