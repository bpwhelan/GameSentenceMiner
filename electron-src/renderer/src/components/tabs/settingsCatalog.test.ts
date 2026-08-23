import { describe, expect, it, vi } from "vitest";

import en from "../../i18n/en.json";
import ja from "../../i18n/ja.json";
import ukr from "../../i18n/ukr.json";
import {
  filterSettingsCatalogEntries,
  normalizeSettingsCatalogQuery,
  performSettingsCatalogAction,
  SETTINGS_CATALOG,
  SETTINGS_CATALOG_I18N_KEYS
} from "./settingsCatalog.js";

describe("SETTINGS_CATALOG", () => {
  it("defines stable entries with valid owners and open actions", () => {
    expect(SETTINGS_CATALOG.length).toBeGreaterThanOrEqual(30);

    const ids = new Set<string>();
    const owners = new Set<string>();

    for (const entry of SETTINGS_CATALOG) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(entry.id)).toBe(false);
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.shortDescription.trim().length).toBeGreaterThan(0);
      expect(entry.keywords.length).toBeGreaterThan(0);
      expect(entry.openAction.label.trim().length).toBeGreaterThan(0);

      ids.add(entry.id);
      owners.add(entry.owner);
    }

    expect(Array.from(owners).sort()).toEqual(["electron", "overlay", "python"]);
    expect(Object.keys(SETTINGS_CATALOG_I18N_KEYS).sort()).toEqual(
      Array.from(ids).sort()
    );
  });

  it("catalogues every current settings area and its direct GSM destination", () => {
    const entriesById = new Map(SETTINGS_CATALOG.map((entry) => [entry.id, entry]));
    const expectedDestinations = {
      "desktop-backups": ["current-tab", undefined, undefined],
      "desktop-data-folder": ["current-tab", undefined, undefined],
      "gsm-paths": ["open-gsm-settings", "general", "paths"],
      "gsm-discord": ["open-gsm-settings", "general", "discord"],
      "gsm-text-processing": ["open-gsm-settings", "general", "text_processing"],
      "gsm-anki-confirmation": ["open-gsm-settings", "anki", "confirmation"],
      "gsm-anki-field-grouping": ["open-gsm-settings", "anki", "field_grouping"],
      "gsm-anki-tags": ["open-gsm-settings", "anki", "tags"],
      "gsm-voice-detection": ["open-gsm-settings", "audio", "vad"],
      "gsm-hotkeys": ["open-gsm-settings", "hotkeys", undefined],
      "gsm-ai-prompts": ["open-gsm-settings", "ai", "prompts"],
      "gsm-overlay-capture": ["open-gsm-settings", "overlay", undefined],
      "gsm-advanced-network": ["open-gsm-settings", "advanced", undefined],
      "gsm-experimental": ["open-gsm-settings", "features", undefined],
      "overlay-reading-stats": ["open-overlay-settings", undefined, undefined],
      "overlay-furigana-tokenization": ["open-overlay-settings", undefined, undefined],
      "overlay-ocr": ["open-overlay-settings", undefined, undefined],
      "overlay-profiles-system": ["open-overlay-settings", undefined, undefined]
    } as const;

    for (const [id, [type, rootTabKey, subtabKey]] of Object.entries(
      expectedDestinations
    )) {
      const entry = entriesById.get(id);
      expect(entry, id).toBeDefined();
      expect(entry?.openAction).toMatchObject({ type });
      expect(entry?.openAction.rootTabKey, id).toBe(rootTabKey);
      expect(entry?.openAction.subtabKey, id).toBe(subtabKey);
    }
  });

  it("provides localized display copy for every catalogue entry", () => {
    const catalogs = [en.settings.catalog, ja.settings.catalog, ukr.settings.catalog];

    for (const i18nKey of Object.values(SETTINGS_CATALOG_I18N_KEYS)) {
      for (const catalog of catalogs) {
        const localizedEntry = catalog[i18nKey as keyof typeof catalog] as
          | { label?: string; description?: string }
          | undefined;
        expect(localizedEntry?.label, i18nKey).toBeTruthy();
        expect(localizedEntry?.description, i18nKey).toBeTruthy();
      }
    }
  });
});

describe("filterSettingsCatalogEntries", () => {
  it("filters by label and user-facing keywords", () => {
    const ankiMatches = filterSettingsCatalogEntries(SETTINGS_CATALOG, "anki");
    expect(ankiMatches).toHaveLength(1);
    expect(ankiMatches[0]?.id).toBe("gsm-anki");

    const controllerMatches = filterSettingsCatalogEntries(
      SETTINGS_CATALOG,
      "jpdb gamepad"
    );
    expect(controllerMatches[0]?.id).toBe("overlay-gamepad");
  });

  it("supports multi-word search and returns all entries for empty queries", () => {
    expect(filterSettingsCatalogEntries(SETTINGS_CATALOG, "")).toHaveLength(
      SETTINGS_CATALOG.length
    );

    const obsMatches = filterSettingsCatalogEntries(
      SETTINGS_CATALOG,
      "obs password"
    );
    expect(obsMatches[0]?.id).toBe("gsm-key-settings");
  });

  it("uses exact single-word matches to keep common searches focused", () => {
    const audioMatches = filterSettingsCatalogEntries(SETTINGS_CATALOG, "audio");
    expect(audioMatches).toHaveLength(1);
    expect(audioMatches[0]?.id).toBe("gsm-audio");

    const trayMatches = filterSettingsCatalogEntries(SETTINGS_CATALOG, "anime tray");
    expect(trayMatches[0]?.id).toBe("desktop-appearance-startup");

    const betaMatches = filterSettingsCatalogEntries(SETTINGS_CATALOG, "beta updates");
    expect(betaMatches[0]?.id).toBe("desktop-updates");
  });

  it.each([
    ["database backup retention", "desktop-backups"],
    ["move appdata folder", "desktop-data-folder"],
    ["clipboard websocket", "gsm-general"],
    ["replacement regex", "gsm-text-processing"],
    ["confirmation gamepad", "gsm-anki-confirmation"],
    ["duplicate field grouping", "gsm-anki-field-grouping"],
    ["whisper vad", "gsm-voice-detection"],
    ["mute target window", "gsm-hotkeys"],
    ["translation prompts", "gsm-ai-prompts"],
    ["game pausing denylist", "gsm-experimental"],
    ["sudachi backfill throttle", "gsm-experimental"],
    ["mute minimized game", "gsm-experimental"],
    ["pomodoro goals", "overlay-reading-stats"],
    ["furigana mecab sudachi", "overlay-furigana-tokenization"],
    ["oneocr image scaling", "overlay-ocr"],
    ["token mode jpdb", "overlay-gamepad"],
    ["profile specific overlay", "overlay-profiles-system"]
  ])("finds the audited setting for %s", (query, expectedId) => {
    expect(filterSettingsCatalogEntries(SETTINGS_CATALOG, query)[0]?.id).toBe(
      expectedId
    );
  });

  it("normalizes full-width text and tokenizes non-Latin searches", () => {
    expect(normalizeSettingsCatalogQuery("Ｆｕｒｉｇａｎａ／ＯＣＲ")).toBe(
      "furigana ocr"
    );

    const localizedEntries = [
      {
        id: "voice",
        label: "音声検出",
        owner: "python" as const,
        keywords: ["VAD"],
        shortDescription: "音声モデルを選択します。",
        openAction: { type: "current-tab" as const, label: "開く" }
      },
      {
        id: "capture",
        label: "画面キャプチャ",
        owner: "overlay" as const,
        keywords: ["OCR"],
        shortDescription: "画面を読み取ります。",
        openAction: { type: "current-tab" as const, label: "開く" }
      }
    ];

    expect(filterSettingsCatalogEntries(localizedEntries, "音声")).toEqual([
      localizedEntries[0]
    ]);
  });
});

describe("performSettingsCatalogAction", () => {
  it("does not invoke IPC for current-tab entries", async () => {
    const invoke = vi.fn();

    await performSettingsCatalogAction(
      { type: "current-tab", label: "Already Here" },
      invoke as never
    );

    expect(invoke).not.toHaveBeenCalled();
  });

  it("maps open actions to the expected IPC channels", async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });

    await performSettingsCatalogAction(
      {
        type: "open-gsm-settings",
        label: "Open GSM Settings",
        rootTabKey: "anki",
        subtabKey: "general"
      },
      invoke as never
    );
    await performSettingsCatalogAction(
      { type: "open-overlay-settings", label: "Open Overlay Settings" },
      invoke as never
    );

    expect(invoke).toHaveBeenNthCalledWith(1, "settings.openGSMSettings", {
      rootTabKey: "anki",
      subtabKey: "general"
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "settings.openOverlaySettings");
  });
});
