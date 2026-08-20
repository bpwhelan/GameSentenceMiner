import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const requireModule = createRequire(import.meta.url);

describe("overlay hotkey recovery", () => {
  it("blocks only keyboard toggles during controller-navigation focus recovery", () => {
    const { shouldSuppressGamepadToggleDuringFocusTransition } = requireModule(
      path.resolve(process.cwd(), "GSM_Overlay/hotkey_settings.js")
    ) as {
      shouldSuppressGamepadToggleDuringFocusTransition: (options: {
        source: string;
        navigationActive: boolean;
        suppressedUntil: number;
        now: number;
      }) => boolean;
    };

    expect(shouldSuppressGamepadToggleDuringFocusTransition({
      source: "keyboard:Alt+G",
      navigationActive: true,
      suppressedUntil: 1630,
      now: 1400,
    })).toBe(true);
    expect(shouldSuppressGamepadToggleDuringFocusTransition({
      source: "keyboard:Alt+G",
      navigationActive: true,
      suppressedUntil: 1630,
      now: 1700,
    })).toBe(false);
    expect(shouldSuppressGamepadToggleDuringFocusTransition({
      source: "controller",
      navigationActive: true,
      suppressedUntil: 1630,
      now: 1400,
    })).toBe(false);
  });

  it("runs a hotkey immediately but ignores duplicate presses during its cooldown", () => {
    const { createLeadingEdgeCooldownHandler } = requireModule(
      path.resolve(process.cwd(), "GSM_Overlay/hotkey_settings.js")
    ) as {
      createLeadingEdgeCooldownHandler: (
        handler: () => void,
        cooldownMs: number,
        now: () => number
      ) => () => boolean;
    };
    const handler = vi.fn();
    // The first handler takes 400ms. A queued duplicate 50ms after completion
    // must still be suppressed even though it arrived 450ms after invocation.
    const times = [1000, 1400, 1450, 1700, 1700];
    const debounced = createLeadingEdgeCooldownHandler(
      handler,
      250,
      () => times.shift()!
    );

    expect(debounced()).toBe(true);
    expect(debounced()).toBe(false);
    expect(debounced()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("resets only an accelerator rejected by Electron and retries its default", () => {
    const { registerHotkeyWithFallback } = requireModule(
      path.resolve(process.cwd(), "GSM_Overlay/hotkey_settings.js")
    ) as {
      registerHotkeyWithFallback: (options: {
        accelerator: string;
        fallbackAccelerator: string;
        register: (accelerator: string) => boolean;
      }) => {
        accelerator: string;
        registered: boolean;
        reset: boolean;
      };
    };
    const register = vi.fn((accelerator: string) => {
      if (accelerator === "Ctrl") {
        throw new TypeError("conversion failure from Ctrl");
      }
      return true;
    });

    const result = registerHotkeyWithFallback({
      accelerator: "Ctrl",
      fallbackAccelerator: "Alt+Shift+W",
      register,
    });

    expect(result).toMatchObject({
      accelerator: "Alt+Shift+W",
      registered: true,
      reset: true,
    });
    expect(register.mock.calls).toEqual([["Ctrl"], ["Alt+Shift+W"]]);
  });

  it("does not reset a valid accelerator just because another app owns it", () => {
    const { registerHotkeyWithFallback } = requireModule(
      path.resolve(process.cwd(), "GSM_Overlay/hotkey_settings.js")
    ) as {
      registerHotkeyWithFallback: (options: {
        accelerator: string;
        fallbackAccelerator: string;
        register: (accelerator: string) => boolean;
      }) => {
        accelerator: string;
        registered: boolean;
        reset: boolean;
      };
    };

    const result = registerHotkeyWithFallback({
      accelerator: "Alt+Shift+W",
      fallbackAccelerator: "Alt+Shift+Q",
      register: () => false,
    });

    expect(result).toMatchObject({
      accelerator: "Alt+Shift+W",
      registered: false,
      reset: false,
    });
  });

  it("normalizes corrupt hotkey values without changing unrelated settings", () => {
    const { normalizeConfiguredHotkeyValues } = requireModule(
      path.resolve(process.cwd(), "GSM_Overlay/hotkey_settings.js")
    ) as {
      normalizeConfiguredHotkeyValues: (
        settings: Record<string, unknown>,
        defaults: Record<string, unknown>,
        keys: string[]
      ) => string[];
    };
    const settings = {
      texthookerHotkey: null,
      showHotkey: "  Shift + Space  ",
      translateHotkey: "DefinitelyNotAKey",
      fontSize: 64,
    };

    const changedKeys = normalizeConfiguredHotkeyValues(
      settings,
      {
        texthookerHotkey: "Alt+Shift+W",
        showHotkey: "Shift + Space",
        translateHotkey: "Alt+T",
      },
      ["texthookerHotkey", "showHotkey", "translateHotkey"]
    );

    expect(settings).toEqual({
      texthookerHotkey: "Alt+Shift+W",
      showHotkey: "Shift + Space",
      translateHotkey: "Alt+T",
      fontSize: 64,
    });
    expect(changedKeys).toEqual([
      "texthookerHotkey",
      "showHotkey",
      "translateHotkey",
    ]);
  });
});

describe("overlay settings window lifecycle", () => {
  it("opens settings when the main overlay window is unavailable", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "GSM_Overlay/main.js"),
      "utf8"
    );
    const start = source.indexOf("function openSettings() {");
    const end = source.indexOf("\nfunction openYomitanSettings", start);
    if (start < 0 || end < 0) {
      throw new Error("Unable to find openSettings in GSM_Overlay/main.js");
    }

    class FakeBrowserWindow {
      destroyed = false;
      shown = false;
      webContents = {
        on: () => {},
        once: () => {},
        setWindowOpenHandler: () => {},
        invalidate: () => {},
        send: () => {},
      };

      isDestroyed() { return this.destroyed; }
      setAlwaysOnTop() {}
      show() { this.shown = true; }
      focus() {}
      removeMenu() {}
      on() {}
      getSize() { return [1200, 980]; }
      setSize() {}
      setMenu() {}
      loadURL() {}
    }

    const module = { exports: {} as any };
    const context = {
      module,
      BrowserWindow: FakeBrowserWindow,
      FIND_IN_PAGE_PRELOAD_PATH: "preload.js",
      DEFAULT_USER_SETTINGS: {},
      backend: null,
      buildOverlaySettingsPayload: () => ({}),
      enableFindInPage: () => {},
      getManualHotkeyRuntimeStatus: () => ({}),
      getOverlayAppIconPath: () => "icon.png",
      getOverlayProfileState: () => ({}),
      isDev: false,
      loadOverlayPage: () => {},
      refreshOverlayTransportSettingsFromGSM: () => {},
      setTimeout: (callback: () => void) => callback(),
      syncGsmOwnedOverlaySettingsFromGSM: () => {},
      websocketStates: {},
    };

    vm.runInNewContext(
      `let mainWindow = null; let settingsWindow = null;\n${source.slice(start, end)}\n` +
        "module.exports = { openSettings, getSettingsWindow: () => settingsWindow };",
      context,
      { filename: "GSM_Overlay/main.js#openSettings" }
    );

    expect(() => module.exports.openSettings()).not.toThrow();
    expect(module.exports.getSettingsWindow()).toBeInstanceOf(FakeBrowserWindow);
  });
});
