// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TextHookTab } from "./TextHookTab";
import type { EngineUpdateState } from "../../../../shared/texthook_updates";

describe("TextHookTab background engine updates", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: Map<string, (...args: any[]) => void>;
  let invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>;
  let runtime: { running: boolean; engine?: string };
  let engineStatus: EngineUpdateState;

  const button = (label: string) => {
    const result = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === label
    );
    expect(result, `Button '${label}' should be present`).toBeDefined();
    return result!;
  };
  const render = async () => {
    await act(async () => { root.render(<TextHookTab active />); });
  };
  const maintenance = () => container.querySelector<HTMLElement>(".texthook-engine-maintenance")!;
  const support = () => container.querySelector<HTMLElement>("#texthook-view-tools")!;
  const live = () => container.querySelector<HTMLElement>("#texthook-view-live")!;
  const openSupport = async () => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#texthook-nav-tools")!.click();
    });
  };

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    listeners = new Map();
    runtime = { running: false };
    engineStatus = {
      installed: true, version: "1.0.0", remoteVersion: "1.0.0", updateAvailable: false,
      automatic: true, phase: "idle", pendingVersion: null, error: null, progress: null,
    };
    invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus") return runtime;
      if (channel === "texthook.getEngineStatus" || channel === "texthook.checkEngineUpdates") return engineStatus;
      if (channel === "texthook.setAutomaticEngineUpdates") return { ...engineStatus, automatic: args[0] };
      if (channel === "texthook.downloadEngines") return { success: true };
      if (channel === "texthook.installEngineVersion") return { success: true };
      if (channel === "texthook.listHooks") return { hooks: [], selectedHookId: null };
      if (channel === "texthook.getActiveCapture") return { sceneName: "Game", sceneId: "game", exeName: "game.exe" };
      if (channel === "texthook.getSettings") return { maxBufferSize: 3000 };
      return null;
    });
    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke,
        send: vi.fn(),
        on: (channel: string, callback: (...args: any[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows update controls immediately on the Support tab without starting an update", async () => {
    await render();
    expect(support().hidden).toBe(true);
    await openSupport();
    expect(support().hidden).toBe(false);
    expect(maintenance().closest("details, [hidden]")).toBeNull();
    expect(maintenance().textContent).toContain("Installed package: 1.0.0");
    expect(button("Check now").closest("[hidden]")).toBeNull();
    expect(button("Repair / reinstall").closest("[hidden]")).toBeNull();
    expect(container.querySelector(".texthook-update-bar")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("texthook.checkEngineUpdates");
    expect(invoke).not.toHaveBeenCalledWith("texthook.downloadEngines");
  });

  it.each(["checking", "downloading", "verifying", "waiting", "installing", "error", "idle"] as const)(
    "keeps the %s phase quiet during normal use", async (phase) => {
      await render();
      const before = live().textContent;
      await act(async () => {
        listeners.get("texthook.engineUpdateState")?.({}, {
          ...engineStatus, phase, remoteVersion: "2.0.0", updateAvailable: true,
          pendingVersion: "2.0.0", error: "Connection lost",
          progress: { file: "LunaHook64.dll", fileIndex: 1, totalFiles: 10, bytesDownloaded: 50, bytesTotal: 100 },
        });
      });
      expect(support().hidden).toBe(true);
      expect(live().textContent).toBe(before);
      expect(container.querySelector(".ocr-toast")).toBeNull();
    }
  );

  it("keeps a missing installation quiet and available for automatic preparation on first use", async () => {
    engineStatus = { ...engineStatus, installed: false, version: null, remoteVersion: "2.0.0" };
    await render();
    expect(support().hidden).toBe(true);
    expect(button("Search for hooks").disabled).toBe(false);
  });

  it("keeps installed engines usable until the final installation boundary", async () => {
    await render();
    for (const phase of ["downloading", "verifying", "waiting", "installing", "idle"] as const) {
      await act(async () => { listeners.get("texthook.engineUpdateState")?.({}, { ...engineStatus, phase }); });
      expect(button("Search for hooks").disabled).toBe(phase === "installing");
      expect(support().hidden).toBe(true);
    }
  });

  it("never stops a running hook or switches to Support for a queued update", async () => {
    runtime = { running: true, engine: "luna" };
    await render();
    await act(async () => {
      listeners.get("texthook.engineUpdateState")?.({}, { ...engineStatus, phase: "waiting", pendingVersion: "2.0.0" });
    });
    expect(button("Stop").disabled).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("texthook.stop");
    expect(support().hidden).toBe(true);
  });

  it("uses a generic preparation message on first use without filenames or update UI", async () => {
    await render();
    await act(async () => {
      listeners.get("texthook.engineDownloadStarted")?.({}, {});
      listeners.get("texthook.engineDownloadProgress")?.({}, {
        file: "LunaHook64.dll", fileIndex: 1, totalFiles: 10, bytesDownloaded: 50, bytesTotal: 100,
      });
    });
    expect(container.textContent).toContain("Preparing text capture…");
    expect(container.textContent).not.toContain("LunaHook64.dll");
    expect(container.textContent).not.toContain("Downloading hook engines");
    await act(async () => { listeners.get("texthook.engineDownloadComplete")?.({}, { success: true }); });
    expect(container.textContent).not.toContain("Preparing text capture…");
    expect(container.querySelector(".ocr-toast")).toBeNull();
  });

  it("checks and installs updates directly from Support", async () => {
    await render();
    await openSupport();
    expect(container.textContent).toContain("Installed package: 1.0.0");
    expect(maintenance().contains(button("Check now"))).toBe(true);
    engineStatus = { ...engineStatus, remoteVersion: "2.0.0", updateAvailable: true };
    await act(async () => { button("Check now").click(); });
    expect(invoke).toHaveBeenCalledWith("texthook.checkEngineUpdates");
    await act(async () => { button("Update now").click(); });
    expect(invoke).toHaveBeenCalledWith("texthook.downloadEngines");
    expect(maintenance().textContent).toContain("Hook engines are ready.");
    expect(container.querySelector(".ocr-toast")).toBeNull();
  });

  it("lets users choose an older package or install the latest without enabling automatic updates", async () => {
    engineStatus = { ...engineStatus, version: "1.0.4", remoteVersion: "1.0.3", availableVersions: [
      { version: "1.0.4" }, { version: "1.0.3" },
    ] };
    await render();
    await openSupport();
    const select = maintenance().querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("1.0.4");
    await act(async () => { select.value = "1.0.3"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { button("Install selected version").click(); });
    expect(invoke).toHaveBeenCalledWith("texthook.installEngineVersion", "1.0.3");
    expect(maintenance().textContent).toContain("Automatic updates turn off when you install a selected version");
    expect(invoke).not.toHaveBeenCalledWith("texthook.setAutomaticEngineUpdates", true);
    engineStatus = { ...engineStatus, version: "1.0.3", automatic: false };
    await act(async () => { listeners.get("texthook.engineUpdateState")?.({}, engineStatus); });
    await act(async () => { button("Update to latest").click(); });
    expect(invoke).toHaveBeenCalledWith("texthook.installEngineVersion", "1.0.4");
  });

  it.each([false, true])("keeps a manual repair failure inside Support (rejection: %s)", async (reject) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.downloadEngines") {
        if (reject) throw new Error("Connection lost");
        return { success: false, error: "Connection lost" };
      }
      return original(channel, ...args);
    });
    await render();
    await openSupport();
    await act(async () => { button("Repair / reinstall").click(); });
    expect(maintenance().textContent).toContain("Connection lost");
    expect(button("Repair / reinstall").disabled).toBe(false);
    expect(container.querySelector(".ocr-toast")).toBeNull();
  });

  it("allows the automatic update preference to be changed directly from Support", async () => {
    await render();
    await openSupport();
    const toggle = maintenance().querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.click(); });
    expect(invoke).toHaveBeenCalledWith("texthook.setAutomaticEngineUpdates", false);
    expect(toggle.checked).toBe(false);
  });

  it("keeps status request failures silent during capture and lets Support retry them", async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getEngineStatus") throw new Error("IPC unavailable");
      return original(channel, ...args);
    });
    await render();
    expect(support().hidden).toBe(true);
    expect(container.querySelector(".ocr-toast")).toBeNull();
    await openSupport();
    expect(maintenance().textContent).toContain("Could not check for engine updates. Try again.");
    await act(async () => { button("Check now").click(); });
    expect(maintenance().textContent).toContain("Up to date");
  });

  it("keeps Support available across tab changes and displays the latest update state", async () => {
    await render();
    await openSupport();
    const checkButton = button("Check now");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#texthook-nav-live")!.click();
      listeners.get("texthook.engineUpdateState")?.({}, { ...engineStatus, phase: "error", error: "Connection lost" });
    });
    expect(support().hidden).toBe(true);
    await openSupport();
    expect(button("Check now")).toBe(checkButton);
    expect(checkButton.closest("details, [hidden]")).toBeNull();
    expect(maintenance().textContent).toContain("Connection lost");
    expect(container.querySelector(".ocr-toast")).toBeNull();
  });
});
