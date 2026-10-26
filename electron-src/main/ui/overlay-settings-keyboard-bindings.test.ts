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

function loadOverlaySettingsPage(platform = "win32") {
  const settingsPath = path.resolve(process.cwd(), "GSM_Overlay/settings.html");
  // These tests assert DOM/inline state. Real Chromium layout is covered by the
  // settings Electron suite; parsing the full theme here delays JSDOM's load event.
  const html = fs.readFileSync(settingsPath, "utf8").replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, "");
  const sent: Array<{ channel: string; payload: IpcPayload }> = [];
  const invoked: Array<{ channel: string; payload: IpcPayload }> = [];
  const listeners = new Map<string, IpcListener>();

  const ipcRenderer = {
    send: (channel: string, payload?: IpcPayload) => sent.push({ channel, payload }),
    invoke: async (channel: string, payload?: IpcPayload) => {
      invoked.push({ channel, payload });
      if (channel === "get-effective-platform") return platform;
      return channel === "settings.getTheme" ? "gsm-dark" : null;
    },
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
        if (moduleName === "node:fs") return { readFileSync: () => '{"theme":"gsm-dark"}' };
        if (moduleName === "node:path") return path;
        if (moduleName === "node:os") return { homedir: () => 'C:/test-home' };
        throw new Error(`Unexpected require: ${moduleName}`);
      };
      window.process = { platform, env: { GSM_DATA_DIR: 'C:/test-gsm', GSM_OVERLAY_IN_PROCESS: '1' } };
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

  return { dom, ready, sent, invoked, listeners };
}

describe("overlay settings navigation", () => {
  it("saves quick-action choices and order, restores profiles, and supports a saved custom question", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const checkbox = (id: string) => doc.querySelector(`[data-quick-action="${id}"]`) as HTMLInputElement;
      expect(checkbox('pause-input').checked).toBe(true);
      expect(checkbox('grammar').checked).toBe(false);
      checkbox('grammar').click();
      await nextTick();
      expect(page.sent.findLast(entry => entry.payload?.key === 'gamepadQuickActions')?.payload).toEqual({
        key: 'gamepadQuickActions', value: ['pause-input', 'replay-audio', 'furigana', 'translate-menu', 'grammar'],
      });
      const up = doc.querySelector('button[aria-label="Move up: Grammar"]') as HTMLButtonElement;
      up.click();
      await nextTick();
      expect(page.sent.findLast(entry => entry.payload?.key === 'gamepadQuickActions')?.payload).toEqual({
        key: 'gamepadQuickActions', value: ['pause-input', 'replay-audio', 'furigana', 'grammar', 'translate-menu'],
      });
      page.listeners.get('settings-updated')?.(null, { gamepadQuickActions: ['context', 'pause-input'] });
      expect(checkbox('grammar').checked).toBe(false);
      expect(Array.from(doc.querySelectorAll('[data-quick-action]')).slice(0, 2).map((node: any) => node.dataset.quickAction)).toEqual(['context', 'pause-input']);
      const question = doc.getElementById('gamepadQuickActionsQuestion') as HTMLInputElement;
      question.value = 'Explain the omitted subject.';
      question.dispatchEvent(new page.dom.window.Event('blur', { bubbles: true }));
      await nextTick();
      expect(page.sent.findLast(entry => entry.payload?.key === 'gamepadQuickActionsQuestion')?.payload).toEqual({
        key: 'gamepadQuickActionsQuestion', value: 'Explain the omitted subject.',
      });
    } finally { page.dom.window.close(); }
  });
  it("shows the selected category and activates its section shortcuts", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const category = (id: string) => doc.querySelector(`[data-settings-tab="${id}"]`);
      const subtab = (id: string) => doc.querySelector(`[data-settings-page="${id}"]`);
      const visiblePages = () => Array.from(doc.querySelectorAll("[data-page]")).filter((el: any) => !el.closest("[hidden]"));
      expect(visiblePages().every((el: any) => el.dataset.page === "overview-start")).toBe(true);
      category("reading").click();
      expect(subtab("reading-readings").getAttribute("aria-selected")).toBe("true");
      expect([...new Set(visiblePages().map((el: any) => el.dataset.page))]).toEqual([
        "reading-readings", "reading-jiten", "reading-indicators",
      ]);
      subtab("reading-jiten").click();
      expect(subtab("reading-jiten").getAttribute("aria-selected")).toBe("true");
      category("capture").click();
      expect(visiblePages().every((el: any) => el.dataset.page.startsWith("capture-"))).toBe(true);
      category("reading").click();
      expect(subtab("reading-readings").getAttribute("aria-selected")).toBe("true");
      expect(page.sent.filter(entry => entry.channel === "setting-changed")).toEqual([]);
    } finally { page.dom.window.close(); }
  });

  it("routes every setting and overview shortcut to its precise page", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const configured = new Set(Array.from(doc.querySelectorAll("[data-settings-page]")).map((el: any) => el.dataset.settingsPage));
      for (const control of doc.querySelectorAll(".setting-group input, .setting-group select")) {
        const region = control.closest("[data-page]");
        expect(region, control.id).not.toBeNull();
        expect(configured.has(region.dataset.page), control.id).toBe(true);
      }
      doc.defaultView.HTMLElement.prototype.scrollIntoView = () => {};
      doc.defaultView.gsmJumpToSetting("vnGuideEnabled");
      expect(doc.querySelector('[data-settings-tab="tools"]').getAttribute("aria-selected")).toBe("true");
      expect(doc.querySelector('[data-settings-page="tools-guide"]').getAttribute("aria-selected")).toBe("true");
      expect(doc.getElementById("vnGuideEnabled").closest("[data-page]").hidden).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it("supports arrow, Home, and End keys independently in both tab bars", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const first = doc.querySelector('[data-settings-tab="overview"]');
      first.focus();
      first.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(doc.activeElement.dataset.settingsTab).toBe("reading");
      const subtab = doc.querySelector('[data-settings-page="reading-readings"]');
      subtab.focus();
      subtab.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
      expect(doc.activeElement.dataset.settingsPage).toBe("reading-indicators");
      doc.activeElement.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect(doc.activeElement.dataset.settingsPage).toBe("reading-readings");
    } finally { page.dom.window.close(); }
  });

  it("searches across subtabs, opens advanced matches, and exits cleanly on navigation", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const input = doc.getElementById("settingsSearchInput");
      const control = doc.getElementById("periodic_ratio");
      const previouslyOpen = control.closest("details").open;
      input.value = "Periodic Scan Ratio";
      input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
      expect(control.closest("[data-page]").hidden).toBe(false);
      expect(control.closest("details").open).toBe(true);
      expect(doc.getElementById("settingsSearchCount").textContent).toContain("1 match");
      doc.querySelector('[data-settings-tab="gamepad"]').click();
      expect(input.value).toBe("");
      expect(doc.body.classList.contains("search-active")).toBe(false);
      expect(control.closest("details").open).toBe(previouslyOpen);
      expect(doc.querySelector('[data-settings-page="gamepad-setup"]').getAttribute("aria-selected")).toBe("true");
    } finally { page.dom.window.close(); }
  });

  it("restores conditional controls after search and handles no results and Escape", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const input = doc.getElementById("settingsSearchInput");
      const conditional = doc.getElementById("gamepadYomitanApiUrl").closest("label");
      const displayBefore = conditional.style.display;
      input.value = "no-such-overlay-setting";
      input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
      expect(doc.getElementById("settingsSearchNoResults").hidden).toBe(false);
      input.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(conditional.style.display).toBe(displayBefore);
      expect(doc.getElementById("settingsSearchNoResults").hidden).toBe(true);
      expect(doc.querySelector('[data-settings-page="overview-start"]').getAttribute("aria-selected")).toBe("true");
    } finally { page.dom.window.close(); }
  });

  it("keeps external System-tab requests working", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      page.dom.window.GSMSettingsNavigation.navigate("system-profiles");
      page.listeners.get("select-settings-tab")?.(null, "system");
      expect(page.dom.window.document.querySelector('[data-settings-page="system-dictionary"]').getAttribute("aria-selected")).toBe("true");
    } finally { page.dom.window.close(); }
  });

  it.each(["win32", "linux", "darwin"])("keeps platform-specific pages consistent on %s", async platform => {
    const page = loadOverlaySettingsPage(platform);
    try {
      await page.ready;
      await page.dom.window.applyPlatformSpecifics();
      const doc = page.dom.window.document;
      doc.querySelector('[data-settings-tab="capture"]').click();
      expect(doc.querySelector('[data-settings-page="capture-alignment"]').hidden).toBe(platform === "win32");
      if (platform !== "win32") {
        doc.querySelector('[data-settings-page="capture-alignment"]').click();
        expect(doc.getElementById("offsetX").closest("[data-page]").hidden).toBe(false);
        expect(doc.getElementById("text-offset-group").style.display).not.toBe("none");
      }
    } finally { page.dom.window.close(); }
  });

  it("keeps shared tokenizer controls, defaults, and profile updates synchronized across pages", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { gamepadTokenizerBackend: "mecab" },
        defaultSettings: { gamepadTokenizerBackend: "mecab" },
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      page.dom.window.GSMSettingsNavigation.navigate("reading-tokenizer");
      const readings = doc.getElementById("furiganaTokenizerBackend");
      const controller = doc.getElementById("gamepadTokenizerBackend");
      readings.value = "sudachi";
      readings.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      await nextTick();
      expect(controller.value).toBe("sudachi");
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({ key: "gamepadTokenizerBackend", value: "sudachi" });
      readings.closest(".setting-control-shell").querySelector(".setting-reset-button").click();
      await nextTick();
      expect(readings.value).toBe("mecab");
      expect(controller.value).toBe("mecab");
      page.listeners.get("settings-updated")?.(null, { gamepadTokenizerBackend: "yomitan-api" });
      await nextTick();
      page.dom.window.GSMSettingsNavigation.navigate("gamepad-navigation");
      expect(readings.value).toBe("yomitan-api");
      expect(controller.value).toBe("yomitan-api");
      expect(doc.getElementById("gamepadYomitanApiUrl").closest("label").style.display).not.toBe("none");
      const ids = Array.from(doc.querySelectorAll("[id]")).map((el: any) => el.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally { page.dom.window.close(); }
  });
});

describe("overlay settings home dashboard", () => {
  it("combines quick setups with a small set of everyday controls", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      expect(doc.querySelector('[data-settings-page="overview-setups"]')).toBeNull();
      expect(doc.getElementById("overlayPresetCards").closest("[data-page]").dataset.page).toBe("overview-start");
      const values = (id: string) => Array.from(doc.getElementById(id).options).map((option: any) => option.value);
      expect(values("home-manualModeType")).toEqual(values("manualModeType"));
      expect(doc.getElementById("home-manualModeType").options[0].textContent).toBe("Hold to show");
      expect(doc.querySelectorAll("#settingsHome [data-setting-alias]")).toHaveLength(12);
      expect(doc.querySelectorAll(".home-card")).toHaveLength(4);
      for (const id of ["manualMode", "showHotkey", "engine_v2", "monitor_to_capture", "showFurigana", "showTextIndicators", "dictionaryReaderSelection", "textHoverClickThrough"]) {
        const shortcut = doc.getElementById(`home-${id}`);
        expect(shortcut, id).not.toBeNull();
        expect(shortcut.closest("[data-page]").dataset.page, id).toBe("overview-start");
        expect(doc.getElementById(id), id).not.toBeNull();
      }
      for (const id of ["gamepadEnabled", "showLiveStats", "pomodoroEnabled", "vnGuideUrl", "furiganaTokenizerBackend", "periodic_interval", "jitenHighlightingEnabled"]) {
        expect(doc.getElementById(`home-${id}`), id).toBeNull();
        expect(doc.getElementById(id).closest("[data-page]").dataset.page, id).not.toBe("overview-start");
      }
      expect(page.sent.filter(entry => entry.channel === "setting-changed")).toEqual([]);
    } finally { page.dom.window.close(); }
  });

  it("shares saving, defaults, and profile updates with the detailed controls", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { showTextIndicators: true }, defaultSettings: { showTextIndicators: true },
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      const shortcut = doc.getElementById("home-showTextIndicators");
      const detailed = doc.getElementById("showTextIndicators");
      shortcut.click();
      await nextTick();
      expect(detailed.checked).toBe(false);
      expect(page.sent.filter(entry => entry.channel === "setting-changed").map(entry => entry.payload)).toEqual([{ key: "showTextIndicators", value: false }]);
      shortcut.closest(".setting-control-shell").querySelector(".setting-reset-button").click();
      await nextTick();
      expect(shortcut.checked).toBe(true);
      expect(detailed.checked).toBe(true);
      page.listeners.get("settings-updated")?.(null, { showTextIndicators: false });
      await nextTick();
      expect(shortcut.checked).toBe(false);
      detailed.click();
      await nextTick();
      expect(shortcut.checked).toBe(true);
    } finally { page.dom.window.close(); }
  });

  it("applies expanded setup recipes without changing unrelated capture settings", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const engine = doc.getElementById("engine_v2").value;
      doc.querySelector('[data-preset-id="japanese-readings"]').click();
      await nextTick();
      expect(doc.getElementById("showFurigana").checked).toBe(true);
      expect(doc.getElementById("home-showFurigana").checked).toBe(true);
      expect(doc.getElementById("readingLanguage").value).toBe("japanese");
      expect(doc.getElementById("engine_v2").value).toBe(engine);
      expect(page.sent.filter(entry => entry.channel === "setting-changed").map(entry => entry.payload?.key)).toEqual(["readingLanguage", "showFurigana", "hideFuriganaOnStartup"]);
      expect(doc.querySelector('[data-preset-id="japanese-readings"]').getAttribute("aria-pressed")).toBe("true");
      page.listeners.get("settings-updated")?.(null, { readingLanguage: "chinese" });
      await nextTick();
      expect(doc.querySelector('[data-preset-id="japanese-readings"]').getAttribute("aria-pressed")).toBe("false");
      expect(doc.getElementById("home-readingLanguage").value).toBe("chinese");
    } finally { page.dom.window.close(); }
  });

  it("reuses hotkey capture and window actions from Home", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const hotkey = doc.getElementById("home-showHotkey");
      hotkey.focus();
      hotkey.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "j", code: "KeyJ", altKey: true, shiftKey: true, bubbles: true }));
      hotkey.blur();
      await nextTick();
      expect(doc.getElementById("showHotkey").value).toBe("Alt+Shift+J");
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({ key: "showHotkey", value: "Alt+Shift+J" });
      doc.querySelector('[data-home-action="selectOcrAreaButton"]').click();
      expect(page.sent.filter(entry => entry.channel === "overlay-select-ocr-area")).toHaveLength(1);
      const homeDictionaryButton = doc.querySelector('[data-home-action="openDictionarySettings"]');
      homeDictionaryButton.click();
      doc.getElementById("openYomitanSettings").click();
      expect(page.sent.filter(entry => entry.channel === "open-yomitan-settings")).toHaveLength(2);
      page.listeners.get("dictionary-reader-switching")?.(null, true);
      await nextTick();
      expect(homeDictionaryButton.disabled).toBe(true);
      expect(doc.getElementById("openYomitanSettings").disabled).toBe(true);
      page.listeners.get("dictionary-reader-switching")?.(null, false);
      await nextTick();
      expect(homeDictionaryButton.disabled).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it("names settings actions for the reader on load, profile updates, and user changes", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const actions = () => doc.querySelectorAll("button[data-dictionary-settings-label], button [data-dictionary-settings-label]");
      const expectReader = (name: string) => {
        expect(Array.from(actions()).map((el: any) => el.textContent.trim())).toEqual(Array(3).fill(`${name} Settings`));
        expect(doc.querySelector('[data-dictionary-settings-label=" Hotkey"]').textContent).toBe(`${name} Settings Hotkey`);
      };
      expectReader("Yomitan");
      page.listeners.get("preload-settings")?.(null, {
        userSettings: { dictionaryReaderSelection: "hachidori" }, defaultSettings: {},
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      expectReader("Hachidori");
      page.listeners.get("settings-updated")?.(null, { dictionaryReaderSelection: "yomitan" });
      await nextTick();
      expectReader("Yomitan");
      expect(page.sent.filter(entry => entry.channel === "setting-changed")).toEqual([]);
      const selection = doc.getElementById("home-dictionaryReaderSelection");
      selection.value = "hachidori";
      selection.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      await nextTick();
      expectReader("Hachidori");
      expect(doc.getElementById("dictionaryReaderSelection").value).toBe("hachidori");
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({ key: "dictionaryReaderSelection", value: "hachidori" });
      for (const label of actions()) label.closest("button").click();
      expect(page.sent.filter(entry => entry.channel === "open-yomitan-settings")).toHaveLength(3);
    } finally { page.dom.window.close(); }
  });

  it("keeps monitor options, profile context, and dependent controls current", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      page.listeners.get("settings-updated")?.(null, { monitor_to_capture: 1, manualMode: false });
      page.listeners.get("gsm-overlay-monitors")?.(null, ["Main display", "Game display"]);
      page.listeners.get("overlay-profile-state-updated")?.(null, { currentGSMProfileName: "My game", activeProfileName: "My game", enabled: true, profiles: [] });
      await nextTick();
      expect(doc.getElementById("home-monitor_to_capture").value).toBe("1");
      expect(doc.getElementById("home-monitor_to_capture").options[1].textContent).toBe("Game display");
      expect(doc.getElementById("home-manualModeType").closest("label").hidden).toBe(true);
      page.listeners.get("settings-updated")?.(null, { manualMode: true });
      await nextTick();
      expect(doc.getElementById("home-manualModeType").closest("label").hidden).toBe(false);
      expect(doc.getElementById("homeProfileName").textContent).toBe("My game");
    } finally { page.dom.window.close(); }
  });

  it.each(["linux", "darwin"])("respects platform restrictions on Home on %s", async platform => {
    const page = loadOverlaySettingsPage(platform);
    try {
      await page.ready;
      await page.dom.window.applyPlatformSpecifics();
      await nextTick();
      const doc = page.dom.window.document;
      const manual = doc.getElementById("home-manualMode");
      expect(manual.checked).toBe(true);
      expect(manual.disabled).toBe(true);
      expect(doc.querySelector('[data-preset-id="automatic"]').disabled).toBe(true);
    } finally { page.dom.window.close(); }
  });

  it("searches Home labels without duplicating the setting in results", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const doc = page.dom.window.document;
      const input = doc.getElementById("settingsSearchInput");
      input.value = "Show / hide shortcut";
      input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
      expect(doc.getElementById("settingsSearchCount").textContent).toBe("1 match");
      expect(doc.getElementById("showHotkey").closest(".setting-group").hidden).toBe(false);
      expect(doc.getElementById("home-showHotkey").closest(".setting-group").hidden).toBe(true);
    } finally { page.dom.window.close(); }
  });
});

describe("overlay custom page settings", () => {
  it("starts disabled, saves a URL and hotkey, and restores profile settings", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      page.listeners.get("preload-settings")?.(null, {
        userSettings: {}, defaultSettings: {
          customPageEnabled: false, customPageUrl: "", customPageHotkey: "Alt+Shift+U"
        }, websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      await nextTick();
      const doc = page.dom.window.document;
      const enabled = doc.getElementById("customPageEnabled");
      const url = doc.getElementById("customPageUrl");
      const hotkey = doc.getElementById("customPageHotkey");
      expect(enabled.checked).toBe(false);
      expect(url.value).toBe("");
      expect(url.readOnly).toBe(false);
      expect(hotkey.value).toBe("Alt+Shift+U");
      expect(url.closest('[data-tab="interaction"]')).not.toBeNull();

      url.value = "  https://kanjieater.github.io/VN-Guide/  ";
      url.dispatchEvent(new page.dom.window.Event("blur"));
      await nextTick();
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "customPageUrl", value: "https://kanjieater.github.io/VN-Guide/"
      });
      enabled.checked = true;
      enabled.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      await nextTick();
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "customPageEnabled", value: true
      });
      hotkey.focus();
      hotkey.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", {
        key: "g", code: "KeyG", altKey: true, shiftKey: true, bubbles: true
      }));
      hotkey.dispatchEvent(new page.dom.window.KeyboardEvent("keyup", {
        key: "g", code: "KeyG", bubbles: true
      }));
      hotkey.blur();
      await nextTick();
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "customPageHotkey", value: "Alt+Shift+G"
      });

      page.listeners.get("settings-updated")?.(null, {
        customPageEnabled: false, customPageUrl: "https://example.com/guide", customPageHotkey: "Alt+Shift+J"
      });
      expect(enabled.checked).toBe(false);
      expect(url.value).toBe("https://example.com/guide");
      expect(hotkey.value).toBe("Alt+Shift+J");
      url.value = "javascript:alert(1)";
      url.dispatchEvent(new page.dom.window.Event("blur"));
      await nextTick();
      expect(url.validationMessage).not.toBe("");
    } finally {
      page.dom.window.close();
    }
  });
});

describe("overlay live stats period settings", () => {
  it("loads the Session default, persists Today, and restores saved/profile values", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const preload = (userSettings: Record<string, unknown>) => page.listeners.get("preload-settings")?.(null, {
        userSettings, defaultSettings: { liveStatsScope: "session" },
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      preload({});
      await nextTick();
      const control = page.dom.window.document.getElementById("liveStatsScope");
      expect(control.value).toBe("session");
      expect(control.closest('[data-tab="reading"]')).not.toBeNull();

      control.value = "today";
      control.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      await nextTick();
      expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
        key: "liveStatsScope", value: "today"
      });

      preload({ liveStatsScope: "today" });
      await nextTick();
      expect(control.value).toBe("today");
      page.listeners.get("settings-updated")?.(null, { liveStatsScope: "session" });
      await nextTick();
      expect(control.value).toBe("session");
      preload({ liveStatsScope: "invalid" });
      await nextTick();
      expect(control.value).toBe("session");
    } finally {
      page.dom.window.close();
    }
  });
});

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
  it("defaults to XInput only and saves/restores independent listener switches", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const preload = (settings: Record<string, boolean>) => page.listeners.get("preload-settings")?.(null, {
        userSettings: settings,
        defaultSettings: { gamepadXinputEnabled: true, gamepadDinputEnabled: false },
        websocketStates: { ws1: false, ws2: false }, runtimeSettings: {}
      });
      preload({ gamepadEnabled: false });
      await nextTick();
      const doc = page.dom.window.document;
      const xinput = doc.getElementById("gamepadXinputEnabled");
      const dinput = doc.getElementById("gamepadDinputEnabled");
      expect(xinput.checked).toBe(true);
      expect(dinput.checked).toBe(false);
      expect(xinput.disabled).toBe(false);
      expect(dinput.disabled).toBe(false);
      expect(xinput.closest('#gamepadSettingsDetails')).toBeNull();
      expect(doc.getElementById("windows-gamepad-listeners").textContent).toContain("Restart GSM");

      for (const [control, value] of [[xinput, false], [dinput, true]] as const) {
        control.checked = value;
        control.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
        await nextTick();
        expect(page.sent.findLast(entry => entry.channel === "setting-changed")?.payload).toEqual({
          key: control.id, value
        });
      }
      preload({ gamepadXinputEnabled: false, gamepadDinputEnabled: true });
      await nextTick();
      expect(xinput.checked).toBe(false);
      expect(dinput.checked).toBe(true);
      preload({ gamepadXinputEnabled: false, gamepadDinputEnabled: false });
      await nextTick();
      expect(xinput.checked).toBe(false);
      expect(dinput.checked).toBe(false);
    } finally {
      page.dom.window.close();
    }
  });

  it.each(["linux", "darwin"])("hides Windows listener switches on %s", async (platform) => {
    const page = loadOverlaySettingsPage(platform);
    try {
      await page.ready;
      await page.dom.window.applyPlatformSpecifics();
      expect(page.dom.window.document.getElementById("windows-gamepad-listeners").hidden).toBe(true);
    } finally {
      page.dom.window.close();
    }
  });

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

  it("renders guide routes safely, preserves a jump being typed, and sends explicit navigation commands", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const document = page.dom.window.document;
      const state = {
        enabled: true, title: 'Example', routeId: 'one', routeTitle: '<img src=x>', reviewed: true,
        routes: [{ id: 'one', title: '<img src=x>', reviewed: true }, { id: 'two', title: 'Second', reviewed: false }],
        text: '<script>bad()</script>', index: 2, startIndex: 1, total: 12, kind: 'choice', saveInstructions: ['セーブ1 <img src=x>'],
      };
      page.listeners.get('vn-guide-state')?.(null, state);
      const route = document.getElementById('vnGuideRoute');
      expect(route.value).toBe('one');
      expect(route.options[2].textContent).toContain('not reviewed upstream');
      expect(document.getElementById('vn-guide-current').textContent).toBe(state.text);
      expect(document.querySelector('#vn-guide-current script')).toBeNull();
      expect(document.getElementById('vn-guide-save').textContent).toBe('Save before choosing: セーブ1 <img src=x>');
      expect(document.getElementById('vn-guide-status').textContent).toContain('Steps 2–3 of 12');
      expect(document.querySelector('#vn-guide-save img')).toBeNull();
      page.listeners.get('vn-guide-state')?.(null, { ...state, recoveredFrom: 0 });
      expect(document.getElementById('vn-guide-status').textContent).toContain('Caught up from step 1');
      page.listeners.get('vn-guide-state')?.(null, { ...state, startIndex: 0 });
      expect(document.getElementById('vn-guide-back').disabled).toBe(true);
      const step = document.getElementById('vn-guide-step');
      step.focus();
      step.value = '8';
      page.listeners.get('vn-guide-state')?.(null, { ...state, index: 3 });
      expect(step.value).toBe('8');
      document.getElementById('vn-guide-jump').click();
      document.getElementById('vn-guide-next').click();
      document.getElementById('vn-guide-back').click();
      document.getElementById('vn-guide-import').click();
      expect(page.invoked.filter(entry => entry.channel === 'vn-guide-command').map(entry => entry.payload)).toEqual([
        { action: 'jump', value: 7 }, { action: 'next', value: undefined },
        { action: 'back', value: undefined }, { action: 'use-custom-page', value: undefined },
      ]);
      page.listeners.get('vn-guide-state')?.(null, { ...state, saveInstructions: [] });
      expect(document.getElementById('vn-guide-save').hidden).toBe(true);
      route.value = 'two';
      route.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
      await nextTick();
      expect(page.sent.findLast(entry => entry.channel === 'setting-changed')?.payload).toEqual({ key: 'vnGuideRoute', value: 'two' });
    } finally { page.dom.window.close(); }
  });

  it("shows guide update availability, check progress, and offline failures without losing instructions", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const document = page.dom.window.document;
      const state = { enabled: true, total: 2, index: 1, text: 'Current instruction', routes: [], lastCheckedAt: 1000 };
      const render = (extra = {}) => page.listeners.get('vn-guide-state')?.(null, { ...state, ...extra });
      render();
      expect(document.getElementById('vn-guide-update-status').textContent).toContain('up to date');
      document.getElementById('vn-guide-check-updates').click();
      expect(page.invoked.findLast(entry => entry.channel === 'vn-guide-command')?.payload).toEqual({ action: 'check-updates', value: undefined });
      render({ checkingUpdates: true });
      expect(document.getElementById('vn-guide-check-updates').disabled).toBe(true);
      expect(document.getElementById('vn-guide-refresh').disabled).toBe(true);
      expect(document.getElementById('vn-guide-next').disabled).toBe(false);
      expect(document.getElementById('vn-guide-update-status').textContent).toContain('Checking');
      render({ updateAvailable: true });
      expect(document.getElementById('vn-guide-update-status').textContent).toContain('update is available');
      expect(document.getElementById('vn-guide-refresh').textContent).toBe('Update guide from source');
      document.getElementById('vn-guide-refresh').click();
      expect(page.invoked.findLast(entry => entry.channel === 'vn-guide-command')?.payload).toEqual({ action: 'refresh', value: undefined });
      render({ updateError: 'Offline <img src=x>' });
      expect(document.getElementById('vn-guide-update-status').textContent).toContain('cached guide is still available');
      expect(document.querySelector('#vn-guide-update-status img')).toBeNull();
      expect(document.getElementById('vn-guide-current').textContent).toBe('Current instruction');
    } finally { page.dom.window.close(); }
  });

  it("persists guide modes and uses the keyboard binding capture for each guide hotkey", async () => {
    const page = loadOverlaySettingsPage();
    try {
      await page.ready;
      const document = page.dom.window.document;
      const mode = document.getElementById('vnGuideMode');
      mode.value = 'always';
      mode.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
      expect(page.sent.findLast(entry => entry.channel === 'setting-changed')?.payload).toEqual({ key: 'vnGuideMode', value: 'always' });
      const appearance = document.getElementById('vnGuideDisplayStyle');
      expect(appearance.value).toBe('card');
      appearance.value = 'text';
      appearance.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
      expect(page.sent.findLast(entry => entry.channel === 'setting-changed')?.payload).toEqual({ key: 'vnGuideDisplayStyle', value: 'text' });
      page.listeners.get('settings-updated')?.(null, { vnGuideDisplayStyle: 'card' });
      await nextTick();
      expect(appearance.value).toBe('card');
      for (const id of ['vnGuideToggleHotkey', 'vnGuideNextHotkey', 'vnGuideBackHotkey']) {
        const control = document.getElementById(id);
        control.focus();
        control.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', altKey: true, shiftKey: true, bubbles: true }));
        control.blur();
        await nextTick();
        expect(page.sent.filter(entry => entry.channel === 'setting-changed').findLast(entry => entry.payload?.key === id)?.payload).toEqual({ key: id, value: 'Alt+Shift+J' });
      }
    } finally { page.dom.window.close(); }
  });
});
