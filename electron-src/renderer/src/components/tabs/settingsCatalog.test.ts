import { describe, expect, it, vi } from "vitest";

import {
  filterSettingsCatalogEntries,
  performSettingsCatalogAction,
  SETTINGS_CATALOG
} from "./settingsCatalog.js";

describe("SETTINGS_CATALOG", () => {
  it("defines stable entries with valid owners and open actions", () => {
    expect(SETTINGS_CATALOG.length).toBeGreaterThan(0);

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
