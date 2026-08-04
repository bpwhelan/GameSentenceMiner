import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const INDEX_PATH = path.resolve(process.cwd(), "GSM_Overlay/index.html");
const MAIN_PATH = path.resolve(process.cwd(), "GSM_Overlay/main.js");

function sourceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to find source block: ${startMarker}`);
  }
  return source.slice(start, end);
}

function loadRendererPopupEvents() {
  const source = fs.readFileSync(INDEX_PATH, "utf8");
  const eventSource = sourceBetween(
    source,
    "  window.addEventListener('yomitan-popup-shown'",
    "\n  const textElement",
  );
  const listeners = new Map<string, (event: { detail?: { popupId?: string } }) => void>();
  const ipcStates: boolean[] = [];
  const manualReasons: string[] = [];
  const module = { exports: {} as any };

  const context = {
    module,
    window: {
      addEventListener(
        type: string,
        listener: (event: { detail?: { popupId?: string } }) => void,
      ) {
        listeners.set(type, listener);
      },
    },
    ipcRenderer: {
      send(channel: string, state: boolean) {
        if (channel === "yomitan-event") {
          ipcStates.push(state);
        }
      },
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback: () => void) {
      callback();
      return 0;
    },
    requestJitenReaderGradingSettings() {},
    pushJitenGradingConfig() {},
    requestMagpieMouseRelease() {},
    applyManualInactivePresentation(reason: string) {
      manualReasons.push(reason);
    },
  };

  vm.runInNewContext(
    `
      let yomitanShowing = false;
      let yomitanPopupCount = 0;
      let yomitanPopupIds = new Set();
      let isMagpieActive = false;
      let manualHotkeyPressed = false;
      let hideOnYomitanClose = false;
      ${eventSource}
      module.exports = {
        getState: () => ({
          showing: yomitanShowing,
          count: yomitanPopupCount,
          ids: Array.from(yomitanPopupIds),
        }),
        setHideOnClose: (value) => { hideOnYomitanClose = value; },
      };
    `,
    context,
    { filename: "GSM_Overlay/index.html#yomitan-popup-events" },
  );

  return {
    dispatch(type: string, popupId?: string) {
      const listener = listeners.get(type);
      if (!listener) {
        throw new Error(`No listener registered for ${type}`);
      }
      listener({ detail: popupId ? { popupId } : undefined });
    },
    getState: module.exports.getState as () => {
      showing: boolean;
      count: number;
      ids: string[];
    },
    setHideOnClose: module.exports.setHideOnClose as (value: boolean) => void,
    ipcStates,
    manualReasons,
  };
}

function loadDomPopupFallback(frames: Array<Record<string, unknown>>) {
  const source = fs.readFileSync(INDEX_PATH, "utf8");
  const fallbackSource = sourceBetween(
    source,
    "  function getVisibleYomitanPopupFrames()",
    "\n  setInterval(() => {",
  );
  const ipcStates: boolean[] = [];
  const module = { exports: {} as any };
  const context = {
    module,
    document: {
      querySelectorAll(selector: string) {
        return selector === "iframe.yomitan-popup" ? frames : [];
      },
    },
    window: {
      getComputedStyle(frame: { style?: Record<string, string> }) {
        return frame.style ?? {};
      },
    },
    ipcRenderer: {
      send(channel: string, state: boolean) {
        if (channel === "yomitan-event") {
          ipcStates.push(state);
        }
      },
    },
    console: { log() {} },
    Date,
  };

  vm.runInNewContext(
    `
      let yomitanShowing = false;
      let yomitanPopupCount = 0;
      let yomitanPopupIds = new Set();
      let lastPopupCount = 0;
      let lastPopupChangeTime = 0;
      ${fallbackSource}
      module.exports = {
        sync: syncYomitanPopupStateFromDom,
        getState: () => ({
          showing: yomitanShowing,
          count: yomitanPopupCount,
          ids: Array.from(yomitanPopupIds),
        }),
      };
    `,
    context,
    { filename: "GSM_Overlay/index.html#yomitan-dom-fallback" },
  );

  return {
    sync: module.exports.sync as (reason?: string) => boolean,
    getState: module.exports.getState as () => {
      showing: boolean;
      count: number;
      ids: string[];
    },
    ipcStates,
  };
}

function loadStalePopupRecovery() {
  const source = fs.readFileSync(INDEX_PATH, "utf8");
  const staleSource = sourceBetween(
    source,
    "  setInterval(() => {\n    if (syncYomitanPopupStateFromDom('stale-check'))",
    "\n  // window.addEventListener('mousemove'",
  );
  const ipcStates: boolean[] = [];
  const magpieReasons: string[] = [];
  const manualReasons: string[] = [];
  let intervalCallback: (() => void) | null = null;
  const module = { exports: {} as any };
  const context = {
    module,
    setInterval(callback: () => void) {
      intervalCallback = callback;
      return 1;
    },
    syncYomitanPopupStateFromDom() {
      return false;
    },
    ipcRenderer: {
      send(channel: string, state: boolean) {
        if (channel === "yomitan-event") {
          ipcStates.push(state);
        }
      },
    },
    requestMagpieMouseRelease(reason: string) {
      magpieReasons.push(reason);
    },
    applyManualInactivePresentation(reason: string) {
      manualReasons.push(reason);
    },
    console: { log() {}, warn() {} },
    Date: { now: () => 20_000 },
  };

  vm.runInNewContext(
    `
      let yomitanPopupCount = 1;
      let yomitanPopupIds = new Set(["stale"]);
      let yomitanShowing = true;
      let lastPopupCount = 1;
      let lastPopupChangeTime = 0;
      const STALE_TIMEOUT = 12000;
      let isMagpieActive = true;
      let manualHotkeyPressed = false;
      let hideOnYomitanClose = true;
      ${staleSource}
      module.exports = {
        getState: () => ({
          showing: yomitanShowing,
          count: yomitanPopupCount,
          ids: Array.from(yomitanPopupIds),
          hideOnYomitanClose,
        }),
      };
    `,
    context,
    { filename: "GSM_Overlay/index.html#yomitan-stale-recovery" },
  );

  if (!intervalCallback) {
    throw new Error("Stale popup interval was not registered");
  }

  return {
    run: intervalCallback,
    getState: module.exports.getState as () => {
      showing: boolean;
      count: number;
      ids: string[];
      hideOnYomitanClose: boolean;
    },
    ipcStates,
    magpieReasons,
    manualReasons,
  };
}

type MainPopupOptions = {
  platform?: "win32" | "darwin" | "linux";
  focusOnLookup?: boolean;
  manualHold?: boolean;
  manualToggle?: boolean;
  gamepadNavigation?: boolean;
  windowFocused?: boolean;
};

function loadMainPopupHandler(options: MainPopupOptions = {}) {
  const source = fs.readFileSync(MAIN_PATH, "utf8");
  const handlerSource = sourceBetween(
    source,
    '  ipcMain.on("yomitan-event"',
    "\n  ipcMain.on('release-mouse'",
  );
  const calls: string[] = [];
  let handler: ((event: unknown, state: boolean) => void) | null = null;
  const platform = options.platform ?? "win32";
  const module = { exports: {} as any };
  const mainWindow = {
    setIgnoreMouseEvents(ignore: boolean) {
      calls.push(`ignore:${ignore}`);
    },
    isFocused() {
      return options.windowFocused === true;
    },
  };
  const context = {
    module,
    mainWindow,
    ipcMain: {
      on(_channel: string, listener: (event: unknown, state: boolean) => void) {
        handler = listener;
      },
    },
    resetActivityTimer() {
      calls.push("activity");
    },
    clearMagpieYomitanCloseVisibilityGuard() {
      calls.push("clear-close-guard");
    },
    focusOverlayForYomitanLookup() {
      calls.push("focus-overlay");
    },
    requestYomitanOverlayTopmostReassert(reason: string) {
      calls.push(`topmost:${reason}`);
      return true;
    },
    beginMagpieYomitanCloseVisibilityGuard() {
      calls.push("begin-close-guard");
    },
    restoreOverlayAfterYomitanLookup() {
      calls.push("restore-overlay");
    },
    isWindows() {
      return platform === "win32";
    },
    isMac() {
      return platform === "darwin";
    },
    hideAndRestoreFocus() {
      calls.push("hide-and-restore-focus");
    },
    blurAndRestoreFocus() {
      calls.push("blur-and-restore-focus");
    },
    scheduleYomitanCloseRecovery() {
      calls.push("schedule-close-recovery");
    },
    Date,
  };

  vm.runInNewContext(
    `
      let yomitanRecoveryVersion = 0;
      let lastYomitanEventAt = 0;
      let yomitanShown = false;
      let yomitanForegroundActive = false;
      let manualHotkeyPressed = ${options.manualHold === true};
      let manualModeToggleState = ${options.manualToggle === true};
      let gamepadNavigationActive = ${options.gamepadNavigation === true};
      let resizeMode = false;
      const userSettings = {
        focusOverlayOnYomitanLookup: ${options.focusOnLookup === true},
      };
      ${handlerSource}
      module.exports = {
        getState: () => ({ yomitanShown, yomitanRecoveryVersion }),
      };
    `,
    context,
    { filename: "GSM_Overlay/main.js#yomitan-event" },
  );

  if (!handler) {
    throw new Error("Yomitan IPC handler was not registered");
  }

  return {
    emit(state: boolean) {
      handler?.({}, state);
    },
    getState: module.exports.getState as () => {
      yomitanShown: boolean;
      yomitanRecoveryVersion: number;
    },
    calls,
  };
}

describe("Yomitan renderer popup lifecycle", () => {
  it("reference-counts nested popup IDs and releases interaction only on final close", () => {
    const popup = loadRendererPopupEvents();

    popup.dispatch("yomitan-popup-shown", "parent");
    popup.dispatch("yomitan-popup-shown", "parent");
    popup.dispatch("yomitan-popup-shown", "child");

    expect(popup.getState()).toEqual({
      showing: true,
      count: 2,
      ids: ["parent", "child"],
    });

    popup.dispatch("yomitan-popup-hidden", "child");
    expect(popup.getState()).toEqual({
      showing: true,
      count: 1,
      ids: ["parent"],
    });
    expect(popup.ipcStates).not.toContain(false);

    popup.setHideOnClose(true);
    popup.dispatch("yomitan-popup-hidden", "parent");
    expect(popup.getState()).toEqual({
      showing: false,
      count: 0,
      ids: [],
    });
    expect(popup.ipcStates.at(-1)).toBe(false);
    expect(popup.manualReasons).toEqual(["yomitan-popup-hidden"]);
  });

  it("falls back to removing the oldest popup when a close event has no ID", () => {
    const popup = loadRendererPopupEvents();
    popup.dispatch("yomitan-popup-shown", "parent");
    popup.dispatch("yomitan-popup-shown", "child");

    popup.dispatch("yomitan-popup-hidden");

    expect(popup.getState()).toEqual({
      showing: true,
      count: 1,
      ids: ["child"],
    });
  });

  it("recovers popup state from visible DOM frames without duplicate open IPC", () => {
    const frames = [
      {
        style: { display: "block", visibility: "visible" },
        getBoundingClientRect: () => ({ width: 300, height: 200 }),
      },
      {
        style: { display: "block", visibility: "visible" },
        getBoundingClientRect: () => ({ width: 250, height: 180 }),
      },
      {
        style: { display: "none", visibility: "visible" },
        getBoundingClientRect: () => ({ width: 250, height: 180 }),
      },
    ];
    const popup = loadDomPopupFallback(frames);

    expect(popup.sync("test")).toBe(true);
    expect(popup.getState()).toEqual({
      showing: true,
      count: 2,
      ids: ["dom-popup-0", "dom-popup-1"],
    });
    expect(popup.ipcStates).toEqual([true]);

    expect(popup.sync("test-again")).toBe(true);
    expect(popup.ipcStates).toEqual([true]);
  });

  it("clears stale state only after DOM recovery finds no visible popup", () => {
    const popup = loadStalePopupRecovery();

    popup.run();

    expect(popup.getState()).toEqual({
      showing: false,
      count: 0,
      ids: [],
      hideOnYomitanClose: false,
    });
    expect(popup.ipcStates).toEqual([false]);
    expect(popup.magpieReasons).toEqual(["stale-yomitan-reset"]);
    expect(popup.manualReasons).toEqual(["yomitan-stale-reset"]);
  });
});

describe("Yomitan main-process interaction lifecycle", () => {
  it("makes a Windows overlay interactive while a popup is open", () => {
    const popup = loadMainPopupHandler();

    popup.emit(true);

    expect(popup.getState().yomitanShown).toBe(true);
    expect(popup.calls).toEqual([
      "activity",
      "clear-close-guard",
      "ignore:false",
      "topmost:yomitan-open",
    ]);
  });

  it("uses the focus-owned open and close path when configured", () => {
    const popup = loadMainPopupHandler({ focusOnLookup: true });

    popup.emit(true);
    popup.emit(false);

    expect(popup.calls).toContain("focus-overlay");
    expect(popup.calls).toContain("restore-overlay");
    expect(popup.calls).not.toContain("ignore:false");
    expect(popup.calls).not.toContain("ignore:true");
  });

  it("does not release manual-mode focus ownership when the popup closes", () => {
    const popup = loadMainPopupHandler({ manualHold: true });

    popup.emit(false);

    expect(popup.calls).toContain("topmost:yomitan-close-manual-active");
    expect(popup.calls).not.toContain("ignore:true");
    expect(popup.calls).not.toContain("blur-and-restore-focus");
  });

  it("restores click-through but preserves active gamepad focus on close", () => {
    const popup = loadMainPopupHandler({
      gamepadNavigation: true,
      windowFocused: true,
    });

    popup.emit(false);

    expect(popup.calls).toContain("ignore:true");
    expect(popup.calls).toContain("topmost:yomitan-close-gamepad-active");
    expect(popup.calls).not.toContain("blur-and-restore-focus");
  });

  it("runs Linux focus restoration and close recovery after a final close", () => {
    const popup = loadMainPopupHandler({
      platform: "linux",
      windowFocused: true,
    });

    popup.emit(false);

    expect(popup.calls).toContain("hide-and-restore-focus");
    expect(popup.calls).toContain("blur-and-restore-focus");
    expect(popup.calls).toContain("topmost:yomitan-close");
    expect(popup.calls).toContain("schedule-close-recovery");
    expect(popup.calls).not.toContain("ignore:true");
  });
});
