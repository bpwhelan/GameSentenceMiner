import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function between(source: string, start: string, end: string) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error(`Missing overlay code: ${start}`);
  return source.slice(first, last);
}

function setup() {
  const source = fs.readFileSync(path.resolve("GSM_Overlay/main.js"), "utf8");
  const send = vi.fn();
  const listeners = new Map<string, (...args: any[]) => void>();
  let hotkey: () => void = () => {};
  const state = {
    translationRequested: false,
    userSettings: { gamepadEnabled: true, gamepadControllerEnabled: true, translateHotkey: "Alt+T" },
    mainWindow: { isDestroyed: () => false, webContents: { send } },
    backend: { connected: true },
    console: { log() {}, error() {} },
    TOGGLE_HOTKEY_COOLDOWN_MS: 250,
    setAppHotkey: (_id: string, _key: string, callback: () => void) => { hotkey = callback; },
    ipcMain: { on: (channel: string, callback: (...args: any[]) => void) => listeners.set(channel, callback) },
  };
  vm.runInNewContext([
    between(source, "  // Register translate hotkey", "  // Register toggle furigana hotkey"),
    between(source, '  ipcMain.on("gamepad-translate"', '  // On-demand pause/resume'),
    between(source, '  ipcMain.on("translation-request-failed"', '  ipcMain.on("action-tts"'),
  ].join("\n"), state);
  const controller = () => listeners.get("gamepad-translate")!({ sender: state.mainWindow.webContents });
  return { state, send, listeners, hotkey: () => hotkey(), controller };
}

describe("overlay translation controls", () => {
  it.each(["controller", "hotkey"] as const)("shares request/toggle state starting with %s", (first) => {
    const fixture = setup();
    fixture[first]();
    expect(fixture.send).toHaveBeenLastCalledWith("request-block-translation");
    expect(fixture.state.translationRequested).toBe(true);
    fixture[first === "controller" ? "hotkey" : "controller"]();
    expect(fixture.send).toHaveBeenLastCalledWith("toggle-translation-visibility");
    expect(fixture.send).toHaveBeenCalledTimes(2);
  });

  it("reports a disconnected backend and allows a later retry", () => {
    const { state, send, controller } = setup();
    state.backend.connected = false;
    controller();
    expect(send).toHaveBeenLastCalledWith("translation-error", "Backend not connected");
    expect(state.translationRequested).toBe(false);
    state.backend.connected = true;
    controller();
    expect(send).toHaveBeenLastCalledWith("request-block-translation");
  });

  it("requests again after a translation failure or new source text", () => {
    const { state, send, listeners, controller } = setup();
    controller();
    listeners.get("translation-request-failed")!({ sender: state.mainWindow.webContents });
    controller();
    expect(send.mock.calls.map(call => call[0])).toEqual(["request-block-translation", "request-block-translation"]);
    state.translationRequested = false;
    controller();
    expect(send).toHaveBeenLastCalledWith("request-block-translation");
  });

  it.each(["gamepadEnabled", "gamepadControllerEnabled"] as const)("respects %s", (setting) => {
    const { state, send, controller } = setup();
    state.userSettings[setting] = false;
    controller();
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores a translation binding request from another window", () => {
    const { send, listeners } = setup();
    listeners.get("gamepad-translate")!({ sender: {} });
    expect(send).not.toHaveBeenCalled();
  });
});

it("applies a translation binding edit to the running gamepad configuration", () => {
  const source = fs.readFileSync(path.resolve("GSM_Overlay/index.html"), "utf8");
  const context = vm.createContext({});
  vm.runInContext([
    between(source, "  const GAMEPAD_NAVIGATION_OPTIONS = [", "  // Keyboard setting keys"),
    "const KEYBOARD_SETTING_KEYS = []; const showFurigana = false;",
    "const dictionaryReader = 'yomitan'; const gamepadInputSuppressed = false;",
    between(source, "  function shouldUseGamepadHandler()", "  async function ensureGamepadModuleLoaded()"),
    "let currentConfig; function syncGamepadHandlerLifecycle() { currentConfig = getGamepadHandlerConfig(); }",
    "let update; const ipcRenderer = { on: (_channel, handler) => { update = handler; } };",
    between(source, "  // Re-initialize when settings change", "  // Expose for debugging"),
  ].join("\n"), context);
  expect(vm.runInContext("getGamepadHandlerConfig().translateButton", context)).toBe(-1);
  for (const binding of ["RB + X", "Disabled", 0]) {
    context.nextBinding = binding;
    expect(vm.runInContext("update(null, { gamepadTranslateButton: nextBinding }); currentConfig.translateButton", context)).toBe(binding);
  }
});
