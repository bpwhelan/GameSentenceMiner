import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSHIDICTS_CONTROL_METHODS,
  HoshidictsControlChannel,
} from "../../../electron-src/main/features/hoshidicts/control_channel";
import {
  HOSHIDICTS_THEMES,
  type HoshidictsTheme,
} from "../../../electron-src/shared/features/hoshidicts";

const require = createRequire(import.meta.url);
const {
  createHoshidictsActivationHotkeyController,
  createHoshidictsReaderPreferencesDelivery,
  createHoshidictsReaderPreferencesBridge,
  dispatchAppHotkeyInputServerMessage,
  HOSHIDICTS_ACTIVATION_HOTKEY_ID,
  normalizeHoshidictsActivationKey,
  normalizeHoshidictsExternalUrl,
  normalizeHoshidictsReaderPreferences,
  requestHoshidictsSettingsOpen,
  resolveHoshidictsControlConfig,
} = require("./desktop_bridge.js") as {
  createHoshidictsActivationHotkeyController: (options: {
    registry: Map<string, Record<string, unknown>>;
    onStateChange: (pressed: boolean) => void;
  }) => {
    clear: () => { changed: boolean; enabled: boolean };
    configure: (preferences: {
      activationKey?: string;
      enabled: boolean;
      lookupMode?: string;
    }) => { activationKey: string; changed: boolean; enabled: boolean };
    getActivationKey: () => string | null;
    isEnabled: () => boolean;
    isPressed: () => boolean;
    release: () => boolean;
  };
  createHoshidictsReaderPreferencesDelivery: (
    deliver: (preferences: unknown) => void
  ) => {
    enqueue: (preferences: unknown) => boolean;
    markReady: () => boolean;
    markNotReady: () => void;
    clear: () => void;
  };
  createHoshidictsReaderPreferencesBridge: (options: {
    env: Record<string, string>;
    onPreferences: (preferences: unknown) => Promise<void>;
    onAudioPreferences?: (preferences: unknown) => Promise<void>;
  }) => {
    destroy: () => void;
    requestAddCustomEntry: (
      entry: { term: string; reading: string; definition: string }
    ) => Promise<unknown>;
  };
  dispatchAppHotkeyInputServerMessage: (
    message: Record<string, unknown>,
    registry: Map<string, Record<string, unknown>>
  ) => boolean;
  requestHoshidictsSettingsOpen: (options: {
    env: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<unknown>;
  resolveHoshidictsControlConfig: (
    env: Record<string, string>
  ) => { port: number } | null;
  HOSHIDICTS_ACTIVATION_HOTKEY_ID: string;
  normalizeHoshidictsActivationKey: (
    value: unknown,
    fallback?: string | null
  ) => string | null;
  normalizeHoshidictsExternalUrl: (value: unknown) => string;
  normalizeHoshidictsReaderPreferences: (
    value: unknown
  ) => {
    lookupMode: "shift" | "hover";
    scanLength: number;
    maxResults: number;
    sortFrequencyDictionary: string | null;
    sortFrequencyDictionaryOrder: "ascending" | "descending";
    activationKey: string;
    sourceHighlightEnabled: boolean;
    onlyScanJapaneseText: boolean;
    popupHideDelayMs: number;
    popupNestingMaxDepth: number;
    popupWidthPx: number;
    popupHeightPx: number;
    popupColumns: number;
    popupOpacityPercent: number;
    popupToolbarPosition: "top" | "bottom";
    theme: HoshidictsTheme;
    dictionaryPresentation: Array<{
      title: string;
      favorite: boolean;
      displayName?: string;
    }>;
    frequencyDictionaries: string[];
    dictionaryTabGroups: Array<{
      id: string;
      name: string;
      dictionaries: string[];
    }>;
    popupButtons: {
      addToAnki: boolean;
      audio: boolean;
      customDefinition: boolean;
      viewInAnki: boolean;
      customLinks: Array<{ label: string; url: string }>;
    };
  };
};

const channels: HoshidictsControlChannel[] = [];
const bridges: Array<{ destroy: () => void }> = [];

afterEach(async () => {
  bridges.splice(0).forEach((bridge) => bridge.destroy());
  await Promise.all(channels.splice(0).map(async (channel) => channel.stop()));
});

async function startControlChannel(options: {
  openSettings?: () => unknown | Promise<unknown>;
  addCustomEntry?: (value: unknown) => unknown | Promise<unknown>;
  onReaderReady?: () => void;
} = {}) {
  const channel = new HoshidictsControlChannel({
    openSettings: options.openSettings ?? (() => ({ opened: true })),
    addCustomEntry: options.addCustomEntry ?? (() => ({ saved: true })),
    onReaderReady: options.onReaderReady,
  });
  channels.push(channel);
  const port = await channel.start();
  return {
    channel,
    env: { GSM_HOSHIDICTS_CONTROL_PORT: String(port) },
  };
}

describe("Hoshidicts desktop bridge", () => {
  const popupAppearance = {
    popupWidthPx: 680,
    popupHeightPx: 500,
    popupColumns: 3,
    popupOpacityPercent: 70,
    popupToolbarPosition: "bottom" as const,
    theme: "autumn" as const,
  };

  it("normalizes only canonical single-key accelerators supported by the input server", () => {
    expect(normalizeHoshidictsActivationKey(undefined)).toBe("Shift");
    expect(normalizeHoshidictsActivationKey(" f24 ")).toBe("F24");
    expect(normalizeHoshidictsActivationKey("pageup")).toBe("PageUp");
    expect(normalizeHoshidictsActivationKey("z")).toBe("Z");
    expect(normalizeHoshidictsActivationKey("=")).toBe("=");
    expect(normalizeHoshidictsActivationKey("Shift+Space", null)).toBeNull();
    expect(normalizeHoshidictsActivationKey("+", null)).toBeNull();
    expect(normalizeHoshidictsActivationKey("F25", null)).toBeNull();
  });

  it("allows only credential-free HTTP(S) links in the system browser", () => {
    expect(normalizeHoshidictsExternalUrl(" https://example.com/検索?q=文 ")).toBe(
      "https://example.com/%E6%A4%9C%E7%B4%A2?q=%E6%96%87"
    );
    expect(normalizeHoshidictsExternalUrl("http://example.com/path")).toBe(
      "http://example.com/path"
    );
    for (const value of [
      "javascript:alert(1)",
      "file:///tmp/test",
      "https://user:pass@example.com/",
      "https://example.com/\nnext",
      `https://example.com/${"x".repeat(2 * 1024 * 1024)}`
    ]) {
      expect(() => normalizeHoshidictsExternalUrl(value)).toThrow(
        "External link URL is invalid."
      );
    }
  });

  it("strictly preserves the source highlight preference for live delivery", () => {
    expect(normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      scanLength: 24,
      maxResults: 48,
      sortFrequencyDictionary: "Frequency",
      sortFrequencyDictionaryOrder: "ascending",
      activationKey: "f8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryPresentation: [
        {
          title: "Monolingual",
          favorite: false,
          displayName: "国語辞典",
          frequencyMode: "rank-based",
        },
        { title: "Bilingual", favorite: true, displayMode: "legacy-value" },
      ],
      frequencyDictionaries: ["Foo", "Foo!"],
      dictionaryTabGroups: [
        {
          id: "reference",
          name: " Reference ",
          dictionaries: ["Monolingual", "Bilingual"],
        },
      ],
      popupButtons: {
        addToAnki: true,
        audio: false,
        customDefinition: true,
        viewInAnki: true,
        customLinks: [
          { label: "Jisho", url: "https://jisho.org/search/%w" },
        ],
      },
    })).toEqual({
      lookupMode: "hover",
      scanLength: 24,
      maxResults: 48,
      sortFrequencyDictionary: "Frequency",
      sortFrequencyDictionaryOrder: "ascending",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      onlyScanJapaneseText: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryPresentation: [
        {
          title: "Monolingual",
          favorite: false,
          displayName: "国語辞典",
          frequencyMode: "rank-based",
        },
        { title: "Bilingual", favorite: true },
      ],
      frequencyDictionaries: ["Foo", "Foo!"],
      dictionaryTabGroups: [
        {
          id: "reference",
          name: "Reference",
          dictionaries: ["Monolingual", "Bilingual"],
        },
      ],
      popupButtons: {
        addToAnki: true,
        audio: false,
        customDefinition: true,
        viewInAnki: true,
        customLinks: [
          { label: "Jisho", url: "https://jisho.org/search/%w" },
        ],
      },
    });
    expect(normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
    }).dictionaryPresentation).toEqual([]);
    expect(normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
    }).frequencyDictionaries).toEqual([]);
    expect(normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
    }).dictionaryTabGroups).toEqual([]);
    expect(normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
    }).popupButtons).toEqual({
      addToAnki: true,
      audio: true,
      customDefinition: true,
      viewInAnki: false,
      customLinks: [],
    });
    expect(normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      popupColumns: undefined,
    }).popupColumns).toBe(1);
    for (const popupColumns of [0, 5, 1.5]) {
      expect(() => normalizeHoshidictsReaderPreferences({
        lookupMode: "hover",
        activationKey: "F8",
        sourceHighlightEnabled: true,
        popupHideDelayMs: 850,
        popupNestingMaxDepth: 4,
        ...popupAppearance,
        popupColumns,
      })).toThrow("Hoshidicts reader preferences are invalid.");
    }
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      popupButtons: {
        addToAnki: true,
        audio: true,
        customDefinition: true,
        viewInAnki: false,
        customLinks: [{ label: "Unsafe", url: "javascript:alert(1)" }],
      },
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: "true",
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: -1,
      ...popupAppearance,
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryPresentation: [
        { title: "Broken", favorite: "yes" },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryPresentation: [
        { title: "Repeated", favorite: true },
        { title: "Repeated", favorite: false },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      frequencyDictionaries: ["Foo", "Foo"],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      popupWidthPx: 279,
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      theme: "neon",
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      popupOpacityPercent: 101,
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryPresentation: [
        { title: "Broken", favorite: true, displayName: "   " },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryPresentation: [
        { title: "Broken", favorite: true, displayName: "x".repeat(4097) },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryPresentation: [
        { title: "Broken", favorite: true, frequencyMode: "most-popular" },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryTabGroups: [
        { id: "one", name: "Reference", dictionaries: ["Main"] },
        { id: "two", name: "Reference", dictionaries: ["Backup"] },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryTabGroups: [
        { id: "one", name: "g".repeat(129), dictionaries: ["Main"] },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
    expect(() => normalizeHoshidictsReaderPreferences({
      lookupMode: "hover",
      activationKey: "F8",
      sourceHighlightEnabled: true,
      popupHideDelayMs: 850,
      popupNestingMaxDepth: 4,
      ...popupAppearance,
      dictionaryTabGroups: [
        { id: "one", name: "Reference", dictionaries: ["Main", "Main"] },
      ],
    })).toThrow("Hoshidicts reader preferences are invalid.");
  });

  it("accepts every canonical popup theme for live preference delivery", () => {
    expect(HOSHIDICTS_THEMES).toHaveLength(41);
    for (const theme of HOSHIDICTS_THEMES) {
      expect(normalizeHoshidictsReaderPreferences({
        lookupMode: "hover",
        activationKey: "F8",
        sourceHighlightEnabled: true,
        popupHideDelayMs: 850,
        popupNestingMaxDepth: 4,
        popupWidthPx: 680,
        popupHeightPx: 500,
        popupColumns: 3,
        popupOpacityPercent: 70,
        popupToolbarPosition: "top",
        theme,
      }).theme).toBe(theme);
    }
  });

  it("adds a stateful activation binding without replacing route-all hotkeys", () => {
    const routeHandler = vi.fn();
    const registry = new Map<string, Record<string, unknown>>([
      ["toggleOverlay", { accelerator: "F10", handler: routeHandler }],
    ]);
    const states: boolean[] = [];
    const controller = createHoshidictsActivationHotkeyController({
      registry,
      onStateChange: (pressed) => states.push(pressed),
    });

    expect(controller.configure({
      enabled: true,
      lookupMode: "shift",
      activationKey: "F8",
    })).toEqual({ activationKey: "F8", changed: true, enabled: true });
    expect(registry.get("toggleOverlay")).toMatchObject({
      accelerator: "F10",
      handler: routeHandler,
    });
    const activationEntry = registry.get(HOSHIDICTS_ACTIVATION_HOTKEY_ID)!;
    expect(activationEntry).toMatchObject({ accelerator: "F8" });

    (activationEntry.onStateChange as (state: string) => void)("pressed");
    expect(controller.isPressed()).toBe(true);
    expect(states).toEqual([true]);

    controller.configure({
      enabled: true,
      lookupMode: "shift",
      activationKey: "F9",
    });
    expect(states).toEqual([true, false]);
    expect(registry.get(HOSHIDICTS_ACTIVATION_HOTKEY_ID)).toMatchObject({
      accelerator: "F9",
    });
    expect(registry.has("toggleOverlay")).toBe(true);

    controller.clear();
    expect(registry.has(HOSHIDICTS_ACTIVATION_HOTKEY_ID)).toBe(false);
    expect(registry.has("toggleOverlay")).toBe(true);
  });

  it("dispatches both state edges while ordinary app actions remain press-only", () => {
    const stateHandler = vi.fn();
    const actionHandler = vi.fn();
    const registry = new Map<string, Record<string, unknown>>([
      ["hoshidictsLookup", { onStateChange: stateHandler }],
      ["toggleOverlay", { handler: actionHandler }],
    ]);

    expect(dispatchAppHotkeyInputServerMessage({
      type: "app_hotkey_event",
      id: "hoshidictsLookup",
      state: "pressed",
    }, registry)).toBe(true);
    expect(dispatchAppHotkeyInputServerMessage({
      type: "app_hotkey_event",
      id: "hoshidictsLookup",
      state: "released",
    }, registry)).toBe(true);
    expect(stateHandler).toHaveBeenNthCalledWith(1, "pressed");
    expect(stateHandler).toHaveBeenNthCalledWith(2, "released");

    dispatchAppHotkeyInputServerMessage({
      type: "app_hotkey_event",
      id: "toggleOverlay",
      state: "pressed",
    }, registry);
    dispatchAppHotkeyInputServerMessage({
      type: "app_hotkey_event",
      id: "toggleOverlay",
      state: "released",
    }, registry);
    expect(actionHandler).toHaveBeenCalledTimes(1);
  });

  it("holds the latest reader preferences until the renderer is ready", () => {
    const delivered: unknown[] = [];
    const delivery = createHoshidictsReaderPreferencesDelivery((preferences) => {
      delivered.push(preferences);
    });

    expect(delivery.enqueue({
      lookupMode: "shift",
      popupHideDelayMs: 300,
      popupNestingMaxDepth: 10,
      showLookupCounts: true,
    }))
      .toBe(false);
    expect(delivery.enqueue({
      lookupMode: "hover",
      popupHideDelayMs: 800,
      popupNestingMaxDepth: 4,
      showLookupCounts: false,
    }))
      .toBe(false);
    expect(delivered).toEqual([]);

    expect(delivery.markReady()).toBe(true);
    expect(delivered).toEqual([
      {
        lookupMode: "hover",
        popupHideDelayMs: 800,
        popupNestingMaxDepth: 4,
        showLookupCounts: false,
      },
    ]);
    expect(delivery.enqueue({
      lookupMode: "shift",
      popupHideDelayMs: 500,
      popupNestingMaxDepth: 0,
      showLookupCounts: true,
    }))
      .toBe(true);
    expect(delivered.at(-1)).toEqual({
      lookupMode: "shift",
      popupHideDelayMs: 500,
      popupNestingMaxDepth: 0,
      showLookupCounts: true,
    });

    delivery.markNotReady();
    expect(delivery.markReady()).toBe(true);
    expect(delivered.at(-1)).toEqual({
      lookupMode: "shift",
      popupHideDelayMs: 500,
      popupNestingMaxDepth: 0,
      showLookupCounts: true,
    });

    delivery.markNotReady();
    delivery.enqueue({
      lookupMode: "hover",
      popupHideDelayMs: 900,
      popupNestingMaxDepth: 8,
      showLookupCounts: false,
    });
    delivery.clear();
    expect(delivery.markReady()).toBe(false);
    expect(delivered).toHaveLength(3);
  });

  it("rejects missing or malformed control settings", () => {
    expect(resolveHoshidictsControlConfig({})).toBeNull();
    expect(resolveHoshidictsControlConfig({
      GSM_HOSHIDICTS_CONTROL_PORT: "99999",
    })).toBeNull();
    expect(resolveHoshidictsControlConfig({
      GSM_HOSHIDICTS_CONTROL_PORT: "1234oops",
    })).toBeNull();
  });

  it("opens settings through independent loopback requests", async () => {
    let openCount = 0;
    const { env } = await startControlChannel({
      openSettings() {
        openCount += 1;
        return { opened: true };
      },
    });
    await expect(
      Promise.all([
        requestHoshidictsSettingsOpen({ env }),
        requestHoshidictsSettingsOpen({ env }),
      ])
    ).resolves.toEqual([{ opened: true }, { opened: true }]);
    expect(openCount).toBe(2);
  });

  it("applies reader preferences over a persistent loopback connection", async () => {
    const { channel, env } = await startControlChannel();
    const applied: unknown[] = [];
    const appliedAudio: unknown[] = [];
    bridges.push(
      createHoshidictsReaderPreferencesBridge({
        env,
        async onPreferences(preferences) {
          applied.push(preferences);
        },
        async onAudioPreferences(preferences) {
          appliedAudio.push(preferences);
        },
      })
    );

    await vi.waitFor(() => {
      expect(channel.isReaderConnected()).toBe(true);
    });
    await expect(
      channel.requestReader(
        HOSHIDICTS_CONTROL_METHODS.readerPreferences,
        {
          lookupMode: "hover",
          popupHideDelayMs: 800,
          popupNestingMaxDepth: 4,
          showLookupCounts: false,
        }
      )
    ).resolves.toEqual({ applied: true });
    expect(applied).toEqual([
      {
        lookupMode: "hover",
        popupHideDelayMs: 800,
        popupNestingMaxDepth: 4,
        showLookupCounts: false,
      },
    ]);
    const audioProfile = {
      version: 1,
      enabled: true,
      autoPlay: false,
      volume: 70,
      sources: [{
        id: "jisho",
        type: "jisho",
        url: "",
        voice: "",
      }],
    };
    await expect(
      channel.requestReader(
        HOSHIDICTS_CONTROL_METHODS.audioProfile,
        audioProfile
      )
    ).resolves.toEqual({ applied: true });
    expect(appliedAudio).toEqual([audioProfile]);
  });

  it("adds custom entries through correlated reader requests", async () => {
    const received: unknown[] = [];
    const { channel, env } = await startControlChannel({
      addCustomEntry(value) {
        received.push(value);
        return { saved: true };
      },
    });
    const bridge = createHoshidictsReaderPreferencesBridge({
      env,
      async onPreferences() {},
    });
    bridges.push(bridge);

    await vi.waitFor(() => {
      expect(channel.isReaderConnected()).toBe(true);
    });
    const entry = {
      term: "螺旋丸",
      reading: "らせんがん",
      definition: "Rotating chakra sphere attack",
    };
    await expect(bridge.requestAddCustomEntry(entry)).resolves.toEqual({
      saved: true,
    });
    expect(received).toEqual([entry]);
  });

  it("propagates desktop errors for custom-entry requests", async () => {
    const { channel, env } = await startControlChannel({
      addCustomEntry() {
        throw new Error("Custom dictionary save was rejected.");
      },
    });
    const bridge = createHoshidictsReaderPreferencesBridge({
      env,
      async onPreferences() {},
    });
    bridges.push(bridge);

    await vi.waitFor(() => {
      expect(channel.isReaderConnected()).toBe(true);
    });
    await expect(bridge.requestAddCustomEntry({
      term: "error",
      reading: "えらー",
      definition: "failure",
    })).rejects.toThrow("Custom dictionary save was rejected.");
  });

  it("keeps a queued custom-entry save pending until desktop responds", async () => {
    let respond!: (value: { saved: true }) => void;
    let requestReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    const { channel, env } = await startControlChannel({
      addCustomEntry() {
        requestReceived();
        return new Promise<{ saved: true }>((resolve) => {
          respond = resolve;
        });
      },
    });
    const bridge = createHoshidictsReaderPreferencesBridge({
      env,
      async onPreferences() {},
    });
    bridges.push(bridge);

    await vi.waitFor(() => {
      expect(channel.isReaderConnected()).toBe(true);
    });
    vi.useFakeTimers();
    try {
      const save = bridge.requestAddCustomEntry({
        term: "保留",
        reading: "ほりゅう",
        definition: "pending",
      });
      let settled = false;
      void save.then(
        () => { settled = true; },
        () => { settled = true; }
      );
      await received;
      await vi.advanceTimersByTimeAsync(31 * 60 * 1_000 + 1);
      expect(settled).toBe(false);

      respond({ saved: true });
      await expect(save).resolves.toEqual({ saved: true });

      const interruptedSave = bridge.requestAddCustomEntry({
        term: "中断",
        reading: "ちゅうだん",
        definition: "interrupted",
      });
      bridge.destroy();
      await expect(interruptedSave).rejects.toThrow(
        "Hoshidicts desktop bridge is closed."
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
