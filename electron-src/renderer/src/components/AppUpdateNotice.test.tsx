// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppUpdateNotice } from "./AppUpdateNotice";

const availableUpdate = {
  currentVersion: "2026.9.4",
  latestVersion: "2026.10.0",
  updateAvailable: true,
  checkedAt: "2026-09-30T12:00:00Z",
  error: null,
  checking: false,
  downloading: false,
  channel: "latest"
};

const releaseNotes = {
  fromVersion: availableUpdate.currentVersion,
  toVersion: availableUpdate.latestVersion,
  status: "ready",
  source: "remote",
  title: "What's Changed in 2026.10.0",
  markdown: "A **new feature**.\n\n[Enable feature](https://gsm-setting.invalid/example/enable)",
  assetBaseUrl: "https://example.com/",
  error: null
};

describe("AppUpdateNotice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let invoke: ReturnType<typeof vi.fn>;
  const listeners = new Map<string, (...args: unknown[]) => void>();

  function button(label: string): HTMLButtonElement {
    const result = Array.from(document.body.querySelectorAll("button")).find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label
    );
    expect(result, label).toBeDefined();
    return result!;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
  }

  async function render() {
    await act(async () => root.render(<AppUpdateNotice />));
  }

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    listeners.clear();
    invoke = vi.fn(async (channel: string) => {
      if (channel === "settings.getAppUpdateStatus") return availableUpdate;
      if (channel === "settings.getAppUpdateChangelog") return releaseNotes;
      if (channel === "settings.installAppUpdate") return { ...availableUpdate, downloading: true };
      return null;
    });
    Object.defineProperty(window, "ipcRenderer", {
      configurable: true,
      value: {
        invoke,
        on: (channel: string, listener: (...args: unknown[]) => void) => {
          listeners.set(channel, listener);
          return () => listeners.delete(channel);
        }
      }
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("stays hidden when no desktop update is available and reacts to new status", async () => {
    invoke.mockResolvedValueOnce({ ...availableUpdate, updateAvailable: false, latestVersion: null });
    await render();
    expect(document.body.querySelector("button")).toBeNull();
    await act(async () => listeners.get("settings-app-update-status")?.({}, availableUpdate));
    expect(button("Update Available")).toBeDefined();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("settings.getAppUpdateChangelog");
  });

  it("opens release notes, refuses without installing, and can reopen later", async () => {
    await render();
    button("Update Available").focus();
    await click("Update Available");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector("strong")?.textContent).toBe("new feature");
    expect(button("Enable feature").disabled).toBe(true);
    expect(document.body.textContent).toContain("GSM will download the update and restart to install it.");
    await click("Not Now");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Update Available"));
    expect(invoke.mock.calls.some(([channel]) => channel === "settings.installAppUpdate")).toBe(false);
    await click("Update Available");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("installs only the reviewed version and blocks repeated clicks while downloading", async () => {
    await render();
    await click("Update Available");
    await click("Update and Restart");
    expect(invoke).toHaveBeenCalledWith("settings.installAppUpdate", "2026.10.0");
    expect(button("Updating…").disabled).toBe(true);
    expect(button("Not Now").disabled).toBe(true);
    await click("Updating…");
    expect(invoke.mock.calls.filter(([channel]) => channel === "settings.installAppUpdate")).toHaveLength(1);
  });

  it("keeps the dialog usable when release notes fail and retries them", async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "settings.getAppUpdateStatus") return availableUpdate;
      if (channel === "settings.getAppUpdateChangelog") throw new Error("Offline");
      return null;
    });
    await render();
    await click("Update Available");
    expect(document.body.textContent).toContain("Release notes could not be loaded.");
    expect(button("Update and Restart").disabled).toBe(false);
    invoke.mockResolvedValueOnce(releaseNotes);
    await click("Retry");
    expect(document.body.querySelector("strong")?.textContent).toBe("new feature");
  });

  it("offers another attempt after an installation failure", async () => {
    await render();
    await click("Update Available");
    invoke.mockRejectedValueOnce(new Error("Network failure"));
    await click("Update and Restart");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("The update could not be installed.");
    expect(button("Update and Restart").disabled).toBe(false);
    await click("Update and Restart");
    expect(button("Updating…").disabled).toBe(true);
  });

  it("does not offer a different version from the release notes being reviewed", async () => {
    await render();
    await click("Update Available");
    await act(async () => listeners.get("settings-app-update-status")?.({}, {
      ...availableUpdate,
      latestVersion: "2026.10.1"
    }));
    expect(button("Update and Restart").disabled).toBe(true);
    expect(document.body.textContent).toContain("The available update has changed.");
  });

  it("ignores an older initial status response after receiving a live update", async () => {
    let resolveInitial!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }));
    await render();
    await act(async () => listeners.get("settings-app-update-status")?.({}, availableUpdate));
    await act(async () => resolveInitial({ ...availableUpdate, updateAvailable: false }));
    expect(button("Update Available")).toBeDefined();
  });

  it("does not reopen a dismissed dialog when a slow notes request finishes", async () => {
    await render();
    let resolveNotes!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveNotes = resolve; }));
    await click("Update Available");
    await click("Not Now");
    await act(async () => resolveNotes(releaseNotes));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("supports keyboard dismissal and returns focus to the update control", async () => {
    await render();
    button("Update Available").focus();
    await click("Update Available");
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Update Available"));
  });

  it("shows a development preview with real notes and disables installation", async () => {
    invoke.mockResolvedValueOnce({ ...availableUpdate, preview: true });
    await render();
    await click("Update Available");
    expect(document.body.querySelector("strong")?.textContent).toBe("new feature");
    expect(document.body.textContent).toContain("Development preview using the latest online release notes. Installation is disabled.");
    expect(button("Update and Restart").disabled).toBe(true);
    await click("Update and Restart");
    expect(invoke.mock.calls.some(([channel]) => channel === "settings.installAppUpdate")).toBe(false);
    await click("Not Now");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
