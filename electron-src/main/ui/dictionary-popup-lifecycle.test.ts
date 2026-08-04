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

type PopupPayload = {
  active: boolean;
  backendId: string;
  generation: number;
  popupCount: number;
};

type MainPopupOptions = {
  platform?: "win32" | "darwin" | "linux";
  focusOnLookup?: boolean;
  manualHold?: boolean;
  manualToggle?: boolean;
  gamepadNavigation?: boolean;
  windowFocused?: boolean;
};

function loadMainPopupHandlers(options: MainPopupOptions = {}) {
  const source = fs.readFileSync(MAIN_PATH, "utf8");
  const handlerSource = sourceBetween(
    source,
    "  const handleDictionaryPopupEvent",
    "\n  ipcMain.on('release-mouse'",
  );
  const calls: string[] = [];
  const handlers = new Map<string, (event: unknown, payload: unknown) => void>();
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
      on(
        channel: string,
        listener: (event: unknown, payload: unknown) => void,
      ) {
        handlers.set(channel, listener);
      },
    },
    resetActivityTimer() {
      calls.push("activity");
    },
    clearMagpieDictionaryPopupCloseVisibilityGuard() {
      calls.push("clear-close-guard");
    },
    focusOverlayForDictionaryLookup() {
      calls.push("focus-overlay");
    },
    requestDictionaryPopupOverlayTopmostReassert(reason: string) {
      calls.push(`topmost:${reason}`);
      return true;
    },
    beginMagpieDictionaryPopupCloseVisibilityGuard() {
      calls.push("begin-close-guard");
    },
    restoreOverlayAfterDictionaryLookup() {
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
    scheduleDictionaryPopupCloseRecovery() {
      calls.push("schedule-close-recovery");
    },
    console: {
      log(message: string) {
        calls.push(`log:${message}`);
      },
    },
    Date,
  };

  vm.runInNewContext(
    `
      let dictionaryPopupShown = false;
      let activeDictionaryPopupGeneration = 0;
      let activeDictionaryPopupBackendId = null;
      let activeDictionaryPopupCount = 0;
      let dictionaryPopupRecoveryVersion = 0;
      let lastDictionaryPopupEventAt = 0;
      let dictionaryPopupForegroundActive = false;
      let manualHotkeyPressed = ${options.manualHold === true};
      let manualModeToggleState = ${options.manualToggle === true};
      let gamepadNavigationActive = ${options.gamepadNavigation === true};
      let resizeMode = false;
      const userSettings = {
        focusOverlayOnYomitanLookup: ${options.focusOnLookup === true},
      };
      ${handlerSource}
      module.exports = {
        getState: () => ({
          active: dictionaryPopupShown,
          backendId: activeDictionaryPopupBackendId,
          generation: activeDictionaryPopupGeneration,
          popupCount: activeDictionaryPopupCount,
          recoveryVersion: dictionaryPopupRecoveryVersion,
        }),
      };
    `,
    context,
    { filename: "GSM_Overlay/main.js#dictionary-popup-event" },
  );

  const genericHandler = handlers.get("dictionary-popup-event");
  const legacyHandler = handlers.get("yomitan-event");
  if (!genericHandler || !legacyHandler) {
    throw new Error("Dictionary popup IPC handlers were not registered");
  }

  return {
    emit(payload: PopupPayload) {
      genericHandler({}, payload);
    },
    emitLegacy(state: boolean) {
      legacyHandler({}, state);
    },
    getState: module.exports.getState as () => {
      active: boolean;
      backendId: string | null;
      generation: number;
      popupCount: number;
      recoveryVersion: number;
    },
    calls,
  };
}

describe("generic dictionary popup main-process lifecycle", () => {
  it("makes a Windows overlay interactive while a popup is open", () => {
    const popup = loadMainPopupHandlers();

    popup.emit({
      active: true,
      backendId: "hoshidicts",
      generation: 4,
      popupCount: 1,
    });

    expect(popup.getState()).toMatchObject({
      active: true,
      backendId: "hoshidicts",
      generation: 4,
      popupCount: 1,
    });
    expect(popup.calls).toEqual([
      "activity",
      "clear-close-guard",
      "ignore:false",
      "topmost:dictionary-popup-open",
    ]);
  });

  it("uses the focus-owned open and close path when configured", () => {
    const popup = loadMainPopupHandlers({ focusOnLookup: true });

    popup.emit({
      active: true,
      backendId: "yomitan",
      generation: 1,
      popupCount: 1,
    });
    popup.emit({
      active: false,
      backendId: "yomitan",
      generation: 1,
      popupCount: 0,
    });

    expect(popup.calls).toContain("focus-overlay");
    expect(popup.calls).toContain("restore-overlay");
    expect(popup.calls).not.toContain("ignore:false");
    expect(popup.calls).not.toContain("ignore:true");
  });

  it("does not release manual-mode focus ownership when the popup closes", () => {
    const popup = loadMainPopupHandlers({ manualHold: true });

    popup.emit({
      active: false,
      backendId: "hoshidicts",
      generation: 2,
      popupCount: 0,
    });

    expect(popup.calls).toContain(
      "topmost:dictionary-popup-close-manual-active",
    );
    expect(popup.calls).not.toContain("ignore:true");
    expect(popup.calls).not.toContain("blur-and-restore-focus");
  });

  it("does not release manual-toggle focus ownership when the popup closes", () => {
    const popup = loadMainPopupHandlers({ manualToggle: true });

    popup.emit({
      active: false,
      backendId: "hoshidicts",
      generation: 2,
      popupCount: 0,
    });

    expect(popup.calls).toContain(
      "topmost:dictionary-popup-close-manual-active",
    );
    expect(popup.calls).not.toContain("ignore:true");
    expect(popup.calls).not.toContain("blur-and-restore-focus");
  });

  it("restores click-through but preserves active gamepad focus on close", () => {
    const popup = loadMainPopupHandlers({
      gamepadNavigation: true,
      windowFocused: true,
    });

    popup.emit({
      active: false,
      backendId: "hoshidicts",
      generation: 3,
      popupCount: 0,
    });

    expect(popup.calls).toContain("ignore:true");
    expect(popup.calls).toContain(
      "topmost:dictionary-popup-close-gamepad-active",
    );
    expect(popup.calls).not.toContain("blur-and-restore-focus");
  });

  it("runs Linux focus restoration and close recovery after a final close", () => {
    const popup = loadMainPopupHandlers({
      platform: "linux",
      windowFocused: true,
    });

    popup.emit({
      active: false,
      backendId: "hoshidicts",
      generation: 5,
      popupCount: 0,
    });

    expect(popup.calls).toContain("hide-and-restore-focus");
    expect(popup.calls).toContain("blur-and-restore-focus");
    expect(popup.calls).toContain("topmost:dictionary-popup-close");
    expect(popup.calls).toContain("schedule-close-recovery");
    expect(popup.calls).not.toContain("ignore:true");
  });

  it("ignores an older-generation close from a stale backend", () => {
    const popup = loadMainPopupHandlers();
    popup.emit({
      active: true,
      backendId: "hoshidicts",
      generation: 8,
      popupCount: 2,
    });
    const callsBeforeStaleClose = popup.calls.length;

    popup.emit({
      active: false,
      backendId: "yomitan",
      generation: 7,
      popupCount: 0,
    });

    expect(popup.getState()).toMatchObject({
      active: true,
      backendId: "hoshidicts",
      generation: 8,
      popupCount: 2,
    });
    expect(popup.calls.slice(callsBeforeStaleClose)).toHaveLength(1);
    expect(popup.calls.at(-1)).toMatch(/^log:\[DictionaryPopup\] Ignoring stale event/);
  });

  it("keeps the legacy Yomitan event bridge during migration", () => {
    const popup = loadMainPopupHandlers();

    popup.emitLegacy(true);
    expect(popup.getState()).toMatchObject({
      active: true,
      backendId: "yomitan",
      generation: 1,
      popupCount: 1,
    });

    popup.emitLegacy(false);
    expect(popup.getState()).toMatchObject({
      active: false,
      backendId: null,
      generation: 1,
      popupCount: 0,
    });
  });
});

describe("renderer dictionary popup ownership", () => {
  it("publishes generic events and leaves Yomitan lifecycle to its adapter", () => {
    const source = fs.readFileSync(INDEX_PATH, "utf8");

    expect(source).toContain('ipcRenderer.send("dictionary-popup-event", event)');
    expect(source).toContain("new YomitanDictionaryBackend");
    expect(source).not.toMatch(/ipcRenderer\.send\(['"]yomitan-event['"]/);
    expect(source).not.toMatch(/\blet yomitanShowing\b/);
    expect(source).not.toMatch(/\blet yomitanPopupCount\b/);
    expect(source).not.toMatch(/\blet yomitanPopupIds\b/);
    expect(source).not.toMatch(
      /window\.addEventListener\(['"]yomitan-popup-(?:shown|hidden)['"]/,
    );
    expect(source).toContain("new DictionaryPointerScanner");
    expect(source).toContain("classifyDictionaryPointerEvent(event");
    expect(source).toContain('closeDictionaryLookups("outside-mousedown")');
    expect(source).toContain('"dictionary-popup-dismiss-request"');
  });

  it("dismisses generic popups when the tracked game window becomes unusable", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf8");
    const resetSource = sourceBetween(
      source,
      "function resetOverlayInteractionStateForHiddenGameWindow",
      "\nfunction restoreAutomaticOverlayPassThrough",
    );

    expect(resetSource).toContain("const hadDictionaryPopup = dictionaryPopupShown");
    expect(resetSource).toContain('"dictionary-popup-dismiss-request"');
    expect(source).toContain('"dictionary-interaction-snapshot"');
  });
});
