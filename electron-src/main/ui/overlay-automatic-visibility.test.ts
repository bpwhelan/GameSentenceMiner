import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const requireModule = createRequire(import.meta.url);

function loadVisibilityPolicy() {
  return requireModule(
    path.resolve(process.cwd(), "GSM_Overlay/automatic_visibility.js")
  ) as {
    shouldShowOverlayOnReady: (options: {
      hideOverlayOnStartup?: boolean;
      windowState?: string;
    }) => boolean;
    shouldRevealAutomaticOverlay: (options: {
      windowState?: string;
      outputAvailable?: boolean;
      manualMode?: boolean;
      texthookerMode?: boolean;
    }) => boolean;
  };
}

describe("automatic overlay visibility", () => {
  it("only performs the default startup reveal while the target state is still usable", () => {
    const { shouldShowOverlayOnReady } = loadVisibilityPolicy();

    expect(shouldShowOverlayOnReady({ windowState: "unknown" })).toBe(true);
    expect(shouldShowOverlayOnReady({ windowState: "active" })).toBe(true);
    expect(shouldShowOverlayOnReady({ windowState: "background" })).toBe(true);
    expect(shouldShowOverlayOnReady({ windowState: "minimized" })).toBe(false);
    expect(shouldShowOverlayOnReady({ windowState: "closed" })).toBe(false);
    expect(shouldShowOverlayOnReady({ windowState: "obscured" })).toBe(false);
    expect(shouldShowOverlayOnReady({
      hideOverlayOnStartup: true,
      windowState: "active",
    })).toBe(false);
  });

  it("defers the main BrowserWindow reveal until the latest target state is known", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "GSM_Overlay/main.js"),
      "utf8"
    );
    const mainWindowOptions = source.slice(
      source.indexOf("mainWindow = new BrowserWindow({"),
      source.indexOf("lastDisplaySyncSignature", source.indexOf("mainWindow = new BrowserWindow({"))
    );
    const readyHandler = source.slice(
      source.indexOf("mainWindow.once('ready-to-show'"),
      source.indexOf('ipcMain.on("app-close"', source.indexOf("mainWindow.once('ready-to-show'"))
    );

    expect(mainWindowOptions).toContain("show: false");
    expect(readyHandler).toContain("shouldShowOverlayOnReady({");
  });

  it("reveals for usable foreground and background window information", () => {
    const { shouldRevealAutomaticOverlay } = loadVisibilityPolicy();

    expect(shouldRevealAutomaticOverlay({ windowState: "active" })).toBe(true);
    expect(shouldRevealAutomaticOverlay({ windowState: "background" })).toBe(true);
  });

  it("reveals for OBS output without an HWND", () => {
    const { shouldRevealAutomaticOverlay } = loadVisibilityPolicy();

    expect(shouldRevealAutomaticOverlay({
      windowState: "unknown",
      outputAvailable: true,
    })).toBe(true);
  });

  it("does not override manual modes or a known hidden game window", () => {
    const { shouldRevealAutomaticOverlay } = loadVisibilityPolicy();

    expect(shouldRevealAutomaticOverlay({
      windowState: "background",
      manualMode: true,
    })).toBe(false);
    expect(shouldRevealAutomaticOverlay({
      windowState: "background",
      texthookerMode: true,
    })).toBe(false);
    expect(shouldRevealAutomaticOverlay({
      windowState: "minimized",
      outputAvailable: true,
    })).toBe(false);
    expect(shouldRevealAutomaticOverlay({
      windowState: "closed",
      outputAvailable: true,
    })).toBe(false);
  });

  it("wires background window state and received output into the reveal flow", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "GSM_Overlay/main.js"),
      "utf8"
    );
    const backgroundCase = source.slice(
      source.indexOf('case "background":'),
      source.indexOf('case "obscured":')
    );
    const textHandler = source.slice(
      source.indexOf('ipcMain.on("text-received"'),
      source.indexOf("// === AUTO TRANSLATE", source.indexOf('ipcMain.on("text-received"'))
    );

    expect(backgroundCase).toContain(
      'revealAutomaticOverlayForSignal("window-state-background")'
    );
    expect(textHandler).toContain(
      'revealAutomaticOverlayForSignal("text-received-output", { outputAvailable: true })'
    );
  });
});
