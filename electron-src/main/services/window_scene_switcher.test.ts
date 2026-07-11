import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";

import type { WindowSceneSwitcherConfig } from "../../shared/window_scene_switcher";

let config: WindowSceneSwitcherConfig = { schemaVersion: 1, collections: [] };

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../store.js", () => ({
  getWindowSceneSwitcherConfig: () => config,
  setWindowSceneSwitcherConfig: (next: WindowSceneSwitcherConfig) => {
    config = structuredClone(next);
  },
}));

vi.mock("../util.js", () => ({
  getRendererEntryPath: () => "renderer.html",
  getSecureWebPreferences: () => ({}),
  isWindows: () => true,
}));

async function loadService() {
  vi.resetModules();
  return import("./window_scene_switcher.js");
}

describe("window scene switcher migration", () => {
  let directory = "";

  beforeEach(async () => {
    config = { schemaVersion: 1, collections: [] };
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "gsm-scene-switcher-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("imports once, disables only OBS's built-in checker, and retains legacy rules", async () => {
    const collectionPath = path.join(directory, "portable-name.json");
    await fs.writeFile(
      collectionPath,
      JSON.stringify({
        name: "My Collection",
        modules: {
          "auto-scene-switcher": {
            active: true,
            switches: [
              { scene: "Game", window_title: ".*Game A.*" },
              { scene: "Game", window_title: ".*Game B.*" },
              { scene: "Broken", window_title: "[" },
            ],
          },
          "advanced-scene-switcher": { enabled: true, marker: "preserve" },
        },
        sources: [
          {
            id: "scene",
            name: "Game",
            uuid: "scene-game",
            settings: { items: [{ name: "Game Capture" }] },
          },
          {
            id: "scene",
            name: "Broken",
            uuid: "scene-broken",
            settings: { items: [] },
          },
          {
            id: "game_capture",
            name: "Game Capture",
            settings: { window: "Game Window:Class:game.exe" },
          },
        ],
      }),
      "utf-8"
    );

    const {
      migrateLegacyWindowSceneSwitcherCollections,
      removeWindowSceneSwitcherRule,
    } = await loadService();
    const result = await migrateLegacyWindowSceneSwitcherCollections(directory);

    expect(result).toEqual({ migratedCollections: ["My Collection"], blockedCollections: [] });
    expect(config.collections).toEqual([
      expect.objectContaining({
        collectionName: "My Collection",
        collectionFileName: "portable-name.json",
        enabled: true,
        legacySwitcherDisabled: true,
        rules: [
          expect.objectContaining({
            sceneUuid: "scene-game",
            titlePattern: "(?:.*Game A.*)|(?:.*Game B.*)",
            executableName: "game.exe",
            enabled: true,
            source: "obs-migration",
          }),
          expect.objectContaining({
            sceneUuid: "scene-broken",
            titlePattern: "[",
            enabled: false,
          }),
        ],
      }),
    ]);

    const persisted = JSON.parse(await fs.readFile(collectionPath, "utf-8"));
    expect(persisted.modules["auto-scene-switcher"]).toEqual({
      active: false,
      switches: [
        { scene: "Game", window_title: ".*Game A.*" },
        { scene: "Game", window_title: ".*Game B.*" },
        { scene: "Broken", window_title: "[" },
      ],
    });
    expect(persisted.modules["advanced-scene-switcher"]).toEqual({
      enabled: true,
      marker: "preserve",
    });

    removeWindowSceneSwitcherRule("scene-game");
    await migrateLegacyWindowSceneSwitcherCollections(directory);
    expect(config.collections[0].rules.map((rule) => rule.sceneUuid)).toEqual([
      "scene-broken",
    ]);
  });
});

describe("window scene switcher hook status", () => {
  beforeEach(() => {
    config = { schemaVersion: 1, collections: [] };
    vi.mocked(ipcMain.handle).mockClear();
  });

  it("reports the hook as running after receiving a foreground snapshot", async () => {
    const service = await loadService();
    service.registerWindowSceneSwitcherIPC();

    service.handleForegroundWindowSnapshot({
      hwnd: "1234",
      pid: 999_999,
      title: "Game Window",
      capturedAt: Date.now(),
      sequence: 1,
    });
    service.setForegroundWindowHookStatus("starting");

    const getStateCall = vi.mocked(ipcMain.handle).mock.calls.find(
      ([channel]) => channel === "scene-switcher.getState"
    );
    expect(getStateCall).toBeDefined();

    const getState = getStateCall?.[1] as (
      event: unknown,
      sceneUuid?: string
    ) => Promise<{ hookStatus: string }>;
    await expect(getState({}, "scene-game")).resolves.toMatchObject({
      hookStatus: "running",
    });
  });
});
