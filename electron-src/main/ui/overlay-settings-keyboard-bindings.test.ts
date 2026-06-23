import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

function loadOverlaySettingsPage(options: {
  gamepads?: Array<any>;
  setIntervalImpl?: (callback: () => void, delay?: number) => number;
  clearIntervalImpl?: (id: number) => void;
} = {}) {
  const html = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/settings.html"),
    "utf8"
  );
  const manualModeCardSource = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/components/manual-mode-card.js"),
    "utf8"
  );
  const sent: Array<{ channel: string; payload: IpcPayload }> = [];
  const listeners = new Map<string, IpcListener>();

  const ipcRenderer = {
    send: (channel: string, payload?: IpcPayload) => sent.push({ channel, payload }),
    invoke: async () => null,
    on: (channel: string, handler: IpcListener) => listeners.set(channel, handler)
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
    url: "file:///settings.html",
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
      window.eval(manualModeCardSource);
      window.setInterval = options.setIntervalImpl ?? (() => 0);
      window.clearInterval = options.clearIntervalImpl ?? (() => {});
      window.console = { ...window.console, log: () => {} };
      window.navigator.getGamepads = () => options.gamepads ?? [];
      window.open = () => null;
    }
  });

  return { dom, sent, listeners };
}

describe("overlay settings keyboard binding capture", () => {
  it.each(["Backspace", "Delete"])(
    "clears a keyboard binding when the input server reports %s",
    async (key) => {
      const page = loadOverlaySettingsPage();
      try {
        await nextTick(20);
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
      await nextTick(20);
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

  it("persists a mouse-click gamepad binding through the setting-changed channel", async () => {
    const intervals: Array<() => void> = [];
    const gamepads = [
      {
        index: 0,
        id: "Test Controller",
        buttons: [{ pressed: false, value: 0 }]
      }
    ];
    const page = loadOverlaySettingsPage({
      gamepads,
      setIntervalImpl: (callback: () => void) => {
        intervals.push(callback);
        return intervals.length;
      },
      clearIntervalImpl: () => {}
    });

    try {
      await nextTick(20);
      const input = page.dom.window.document.getElementById("gamepadForwardMouseClickButton") as HTMLInputElement;

      input.focus();
      await nextTick();
      expect(intervals.length).toBeGreaterThan(0);
      const captureInterval = intervals.at(-1)!;

      gamepads[0] = {
        index: 0,
        id: "Test Controller",
        buttons: [{ pressed: true, value: 1 }]
      };
      captureInterval();
      await nextTick();
      expect(input.value).toBe("A");

      gamepads[0] = {
        index: 0,
        id: "Test Controller",
        buttons: [{ pressed: false, value: 0 }]
      };
      captureInterval();
      await nextTick();

      expect(page.sent.findLast((entry) => entry.channel === "setting-changed")?.payload).toEqual({
        key: "gamepadForwardMouseClickButton",
        value: "A"
      });
    } finally {
      page.dom.window.close();
    }
  });

  it("shows explicit disabled keyboard bindings instead of fallback defaults", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await nextTick(20);
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
      await nextTick(20);
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
      await nextTick(20);
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
      await nextTick(20);
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
