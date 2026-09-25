import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type IpcPayload = Record<string, unknown> | undefined;
type IpcListener = (event: unknown, payload: any) => void;

const requireModule = createRequire(import.meta.url);
const { JSDOM } = requireModule("jsdom") as {
  JSDOM: new (html: string, options: Record<string, unknown>) => any;
};

function nextTick(delay = 0) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function loadOverlaySettingsPage() {
  const settingsPath = path.resolve(process.cwd(), "GSM_Overlay/settings.html");
  const html = fs.readFileSync(settingsPath, "utf8");
  const sent: Array<{ channel: string; payload: IpcPayload }> = [];
  const listeners = new Map<string, IpcListener>();

  const ipcRenderer = {
    send: (channel: string, payload?: IpcPayload) => sent.push({ channel, payload }),
    invoke: async () => null,
    on: (channel: string, handler: IpcListener) => {
      const existing = listeners.get(channel);
      listeners.set(channel, existing
        ? (event, payload) => {
            existing(event, payload);
            handler(event, payload);
          }
        : handler);
    }
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    readyState = FakeWebSocket.CONNECTING;
    onopen?: () => void;
    onclose?: () => void;

    constructor() {
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send() {}

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const dom = new JSDOM(html, {
    url: pathToFileURL(settingsPath).href,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window: any) {
      window.require = (moduleName: string) => {
        if (moduleName === "electron") {
          return { ipcRenderer };
        }
        throw new Error(`Unexpected require: ${moduleName}`);
      };
      window.process = { platform: "win32" };
      window.WebSocket = FakeWebSocket;
      window.setInterval = () => 0;
      window.clearInterval = () => {};
      window.console = { ...window.console, log: () => {} };
      window.navigator.getGamepads = () => [];
      window.open = () => null;
    }
  });
  const ready = dom.window.document.readyState === "complete"
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        dom.window.addEventListener("load", () => resolve(), { once: true });
      });

  return { dom, ready, sent, listeners };
}

describe("overlay adaptive OCR retry settings", () => {
  it("defaults off, sends edits, and follows the active GSM profile", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: {}, defaultSettings: {},
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      const control = page.dom.window.document.getElementById("adaptive_ocr_retries");
      expect(control.checked).toBe(false);
      expect(control.closest('[data-tab="capture"]')).not.toBeNull();

      control.checked = true;
      control.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      await nextTick();
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "adaptive_ocr_retries", value: true
      });

      page.listeners.get("settings-updated")?.(null, { adaptive_ocr_retries: false });
      await nextTick();
      expect(control.checked).toBe(false);
      page.listeners.get("settings-updated")?.(null, { adaptive_ocr_retries: true });
      await nextTick();
      expect(control.checked).toBe(true);
    } finally {
      page.dom.window.close();
    }
  });
});

describe("overlay settings keyboard binding capture", () => {
  it("captures, restores, and clears the translation controller binding", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { gamepadEnabled: true }, defaultSettings: {},
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      const input = page.dom.window.document.getElementById("gamepadTranslateButton");
      expect(input?.value).toBe("Disabled");
      expect(input.closest('[data-tab="gamepad"]')).not.toBeNull();
      input.focus();
      for (const [button, pressed] of [[5, true], [2, true], [2, false], [5, false]]) {
        page.dom.window.updateServerGamepadState({ type: "button", device: "pad", button, pressed });
      }
      await nextTick();
      expect(input.value).toBe("RB + X");
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "gamepadTranslateButton", value: "RB + X"
      });

      page.listeners.get("settings-updated")?.(null, { gamepadTranslateButton: "LT + Y" });
      expect(input.value).toBe("LT + Y");
      input.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await nextTick();
      expect(input.value).toBe("Disabled");
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "gamepadTranslateButton", value: "Disabled"
      });
      page.listeners.get("settings-updated")?.(null, { gamepadEnabled: false });
      expect(input.disabled).toBe(true);
    } finally {
      page.dom.window.close();
    }
  });

  it("loads unbound Jiten word actions, restores saved bumpers, and clears bindings", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { gamepadEnabled: true }, defaultSettings: {},
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      const doc = page.dom.window.document;
      for (const id of ["gamepadPrevJitenWordButton", "gamepadNextJitenWordButton",
        "keyboardPrevJitenWordKey", "keyboardNextJitenWordKey"]) {
        expect(doc.getElementById(id)?.value).toBe("Disabled");
      }
      page.listeners.get("settings-updated")?.(null, {
        gamepadPrevJitenWordButton: "LB", gamepadNextJitenWordButton: "RB"
      });
      await nextTick();
      for (const [id, label] of [["gamepadPrevJitenWordButton", "LB"], ["gamepadNextJitenWordButton", "RB"]]) {
        const input = doc.getElementById(id);
        expect(input.value).toBe(label);
        input.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
        await nextTick();
        expect(input.value).toBe("Disabled");
        expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
          key: id, value: "Disabled"
        });
      }
      page.listeners.get("settings-updated")?.(null, { gamepadEnabled: false });
      await nextTick();
      expect(doc.getElementById("gamepadPrevJitenWordButton").disabled).toBe(true);
      expect(doc.getElementById("gamepadNextJitenWordButton").disabled).toBe(true);
    } finally {
      page.dom.window.close();
    }
  });

  it("loads, edits, and restores navigation experiment settings through IPC", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const values = {
        gamepadHoldNavigation: "sentence", gamepadHorizontalWrap: "line",
        gamepadVerticalNavigation: "spatial", gamepadInitialPosition: "nearest",
        gamepadBlockJumpAnimation: true, gamepadAnalogAcceleration: true
      };
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { gamepadEnabled: true, ...values }, defaultSettings: {},
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      for (const [id, value] of Object.entries(values)) {
        const control = page.dom.window.document.getElementById(id);
        expect(typeof value === "boolean" ? control.checked : control.value).toBe(value);
        expect(control.disabled).toBe(false);
      }
      const select = page.dom.window.document.getElementById("gamepadHoldNavigation");
      select.value = "new";
      select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      await nextTick();
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "gamepadHoldNavigation", value: "new"
      });
      page.listeners.get("settings-updated")?.(null, { gamepadHoldNavigation: "repeat", gamepadBlockJumpAnimation: false });
      await nextTick();
      expect(select.value).toBe("repeat");
      expect(page.dom.window.document.getElementById("gamepadBlockJumpAnimation").checked).toBe(false);
    } finally {
      page.dom.window.close();
    }
  });
  it.each(["Backspace", "Delete"])(
    "clears a keyboard binding when the input server reports %s",
    async (key) => {
      const page = loadOverlaySettingsPage();
      try {
        await page.ready;
        const input = page.dom.window.document.getElementById("keyboardToggleKey") as HTMLInputElement;

        input.focus();
        page.dom.window.dispatchEvent(new page.dom.window.CustomEvent("gsm-keyboard-event", {
          detail: { key, pressed: true, modifiers: {} }
        }));
        await nextTick();

        const lastSettingChange = page.sent.findLast((entry) => entry.channel === "setting-changed");
        expect(input.value).toBe("Disabled");
        expect(lastSettingChange?.payload).toEqual({
          key: "keyboardToggleKey",
          value: "Disabled"
        });
      } finally {
        page.dom.window.close();
      }
    }
  );

  it("cancels a keyboard binding when the input server reports Escape", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const input = page.dom.window.document.getElementById("keyboardToggleKey") as HTMLInputElement;
      const settingChangesBefore = page.sent.filter((entry) => entry.channel === "setting-changed").length;

      input.focus();
      page.dom.window.dispatchEvent(new page.dom.window.CustomEvent("gsm-keyboard-event", {
        detail: { key: "Escape", pressed: true, modifiers: {} }
      }));
      await nextTick();

      const settingChangesAfter = page.sent.filter((entry) => entry.channel === "setting-changed").length;
      expect(input.value).toBe("Disabled");
      expect(settingChangesAfter).toBe(settingChangesBefore);
    } finally {
      page.dom.window.close();
    }
  });

  it("shows explicit disabled keyboard bindings instead of fallback defaults", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { keyboardConfirmKey: "Disabled" },
        websocketStates: { ws1: false, ws2: false },
        defaultSettings: { keyboardConfirmKey: "Enter" },
        runtimeSettings: {}
      });
      await nextTick();

      const input = page.dom.window.document.getElementById("keyboardConfirmKey") as HTMLInputElement;
      expect(input.value).toBe("Disabled");
    } finally {
      page.dom.window.close();
    }
  });

  it("renders GSM profile state from the preload payload", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { overlaySettingsProfilesEnabled: true },
        websocketStates: { ws1: false, ws2: false },
        defaultSettings: {},
        runtimeSettings: {},
        profileState: {
          enabled: true,
          activeProfileName: "VN",
          currentGSMProfileName: "VN",
          profiles: [
            { name: "Default", scenes: [], current: false },
            { name: "VN", scenes: ["Novel", "Reading"], current: true }
          ]
        }
      });
      await nextTick();

      const enabledCheckbox = page.dom.window.document.getElementById("overlaySettingsProfilesEnabled") as HTMLInputElement;
      const activeName = page.dom.window.document.getElementById("overlayActiveProfileName");
      const currentName = page.dom.window.document.getElementById("overlayCurrentGsmProfileName");
      const cards = Array.from(page.dom.window.document.querySelectorAll("#overlayProfilesList .profile-card"));

      expect(enabledCheckbox.checked).toBe(true);
      expect(activeName?.textContent).toBe("VN");
      expect(currentName?.textContent).toBe("VN");
      expect(cards).toHaveLength(2);
      expect(cards[1].classList.contains("active")).toBe(true);
      expect(cards[1].textContent).toContain("Scenes: Novel, Reading");
    } finally {
      page.dom.window.close();
    }
  });

  it("opens the main GSM profile settings from the profiles tab", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const button = page.dom.window.document.getElementById("openGSMProfileSettings") as HTMLButtonElement;

      button.click();
      await nextTick();

      expect(page.sent.findLast((entry) => entry.channel === "open-gsm-profile-settings")).toEqual({
        channel: "open-gsm-profile-settings",
        payload: undefined
      });
    } finally {
      page.dom.window.close();
    }
  });

  it("persists the overlay profile enable toggle through the unified settings channel", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const checkbox = page.dom.window.document.getElementById("overlaySettingsProfilesEnabled") as HTMLInputElement;

      checkbox.checked = true;
      checkbox.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      await nextTick();

      expect(page.sent.findLast((entry) => entry.channel === "setting-changed")?.payload).toEqual({
        key: "overlaySettingsProfilesEnabled",
        value: true
      });
    } finally {
      page.dom.window.close();
    }
  });
});
