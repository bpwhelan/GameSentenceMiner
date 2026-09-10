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

describe("window scene switcher startup synchronization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    config = {
      schemaVersion: 1,
      collections: [
        {
          collectionName: "Games",
          collectionFileName: "Games.json",
          enabled: true,
          migrationVersion: 1,
          legacySwitcherDisabled: true,
          rules: [
            {
              sceneUuid: "scene-game",
              sceneName: "Steins;Gate",
              titlePattern: "Steins;Gate",
              executableName: "game.exe",
              enabled: true,
              source: "manual",
            },
          ],
        },
      ],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests the already-focused window and corrects the scene after OBS connects", async () => {
    const service = await loadService();
    const switchScene = vi.fn(async () => {});
    const requestForegroundSnapshot = vi.fn(() => {
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence: 2,
      });
    });
    const runtime = {
      isOBSConnected: () => false,
      getCurrentCollectionName: async () => "Games",
      getScenes: async () => {
        service.handleOBSSceneChanged({ id: "scene-other", name: "Other" });
        return [
          { id: "scene-other", name: "Other" },
          { id: "scene-game", name: "Steins;Gate" },
        ];
      },
      getCurrentScene: async () => ({ id: "scene-other", name: "Other" }),
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot,
    };

    service.configureWindowSceneSwitcherRuntime(runtime);
    service.handleForegroundWindowSnapshot({
      hwnd: "1234",
      pid: 999_999,
      title: "Steins;Gate",
      executableName: "game.exe",
      capturedAt: Date.now(),
      sequence: 1,
    });
    await service.handleOBSConnected();
    // OBS can deliver its initial scene event just after the connection
    // reconciliation finishes. It must not be treated as a manual override.
    service.handleOBSSceneChanged({ id: "scene-other", name: "Other" });
    await vi.advanceTimersByTimeAsync(200);

    expect(requestForegroundSnapshot).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-game");
    service.shutdownWindowSceneSwitcher();
  });

  it("hydrates the active collection when OBS was already connected during runtime setup", async () => {
    const service = await loadService();
    const switchScene = vi.fn(async () => {});
    const requestForegroundSnapshot = vi.fn(() => {
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence: 1,
      });
    });
    const runtime = {
      isOBSConnected: () => true,
      getCurrentCollectionName: async () => "Games",
      getScenes: async () => [
        { id: "scene-other", name: "Other" },
        { id: "scene-game", name: "Steins;Gate" },
      ],
      getCurrentScene: async () => ({ id: "scene-other", name: "Other" }),
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot,
    };

    service.configureWindowSceneSwitcherRuntime(runtime);
    await vi.advanceTimersByTimeAsync(200);

    expect(requestForegroundSnapshot).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-game");
    service.shutdownWindowSceneSwitcher();
  });

  it("does not let an older foreground timer end startup scene suppression", async () => {
    const service = await loadService();
    const switchScene = vi.fn(async () => {});
    let resolveScenes!: (scenes: Array<{ id: string; name: string }>) => void;
    const scenesPromise = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      resolveScenes = resolve;
    });
    const getScenes = vi.fn(() => scenesPromise);
    const runtime = {
      isOBSConnected: () => false,
      getCurrentCollectionName: async () => "Games",
      getScenes,
      getCurrentScene: async () => ({ id: "scene-other", name: "Other" }),
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot: vi.fn(),
    };

    service.configureWindowSceneSwitcherRuntime(runtime);
    service.handleForegroundWindowSnapshot({
      hwnd: "1234",
      pid: 999_999,
      title: "Steins;Gate",
      executableName: "game.exe",
      capturedAt: Date.now(),
      sequence: 1,
    });

    const connection = service.handleOBSConnected();
    await Promise.resolve();
    expect(getScenes).toHaveBeenCalledOnce();

    // This timer predates the OBS synchronization and must not end its scene
    // suppression while the scene list request is still unresolved.
    await vi.advanceTimersByTimeAsync(200);
    resolveScenes([
      { id: "scene-other", name: "Other" },
      { id: "scene-game", name: "Steins;Gate" },
    ]);
    await connection;

    service.handleOBSSceneChanged({ id: "scene-other", name: "Other" });
    await vi.advanceTimersByTimeAsync(200);

    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-game");
    service.shutdownWindowSceneSwitcher();
  });

  it("invalidates an in-flight OBS synchronization after disconnect", async () => {
    const service = await loadService();
    const switchScene = vi.fn(async () => {});
    let resolveScenes!: (scenes: Array<{ id: string; name: string }>) => void;
    const scenesPromise = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      resolveScenes = resolve;
    });
    const requestForegroundSnapshot = vi.fn();
    const runtime = {
      isOBSConnected: () => false,
      getCurrentCollectionName: async () => "Games",
      getScenes: () => scenesPromise,
      getCurrentScene: async () => ({ id: "scene-other", name: "Other" }),
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot,
    };

    service.configureWindowSceneSwitcherRuntime(runtime);
    service.handleForegroundWindowSnapshot({
      hwnd: "1234",
      pid: 999_999,
      title: "Steins;Gate",
      executableName: "game.exe",
      capturedAt: Date.now(),
      sequence: 1,
    });

    const connection = service.handleOBSConnected();
    await Promise.resolve();
    service.handleOBSDisconnected();
    resolveScenes([
      { id: "scene-other", name: "Other" },
      { id: "scene-game", name: "Steins;Gate" },
    ]);
    await connection;
    await vi.advanceTimersByTimeAsync(200);

    expect(requestForegroundSnapshot).not.toHaveBeenCalled();
    expect(switchScene).not.toHaveBeenCalled();
    service.shutdownWindowSceneSwitcher();
  });

  it("retries reconciliation when OBS is connected but still initializing", async () => {
    const service = await loadService();
    const switchScene = vi.fn(async () => {});
    const getCurrentCollectionName = vi.fn()
      .mockRejectedValueOnce(new Error("OBS is still initializing"))
      .mockResolvedValue("Games");
    const requestForegroundSnapshot = vi.fn(() => {
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence: 1,
      });
    });
    const runtime = {
      isOBSConnected: () => true,
      getCurrentCollectionName,
      getScenes: async () => [
        { id: "scene-other", name: "Other" },
        { id: "scene-game", name: "Steins;Gate" },
      ],
      getCurrentScene: async () => ({ id: "scene-other", name: "Other" }),
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot,
    };

    service.configureWindowSceneSwitcherRuntime(runtime);
    await vi.advanceTimersByTimeAsync(1_200);

    expect(getCurrentCollectionName).toHaveBeenCalledTimes(2);
    expect(requestForegroundSnapshot).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-game");
    service.shutdownWindowSceneSwitcher();
  });
});

describe("window scene switcher continuous reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    config = {
      schemaVersion: 1,
      collections: [
        {
          collectionName: "Games",
          collectionFileName: "Games.json",
          enabled: true,
          migrationVersion: 1,
          legacySwitcherDisabled: true,
          rules: [
            {
              sceneUuid: "scene-game",
              sceneName: "Steins;Gate",
              titlePattern: "Steins;Gate",
              executableName: "game.exe",
              enabled: true,
              source: "manual",
            },
          ],
        },
      ],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers when both the foreground hook event and OBS scene event are missed", async () => {
    const service = await loadService();
    let sequence = 0;
    let currentScene = { id: "scene-game", name: "Steins;Gate" };
    const switchScene = vi.fn(async (sceneUuid: string) => {
      currentScene = { id: sceneUuid, name: "Steins;Gate" };
    });
    const requestForegroundSnapshot = vi.fn(() => {
      sequence += 1;
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence,
      });
    });

    service.configureWindowSceneSwitcherRuntime({
      isOBSConnected: () => true,
      getCurrentCollectionName: async () => "Games",
      getScenes: async () => [
        { id: "scene-other", name: "Other" },
        { id: "scene-game", name: "Steins;Gate" },
      ],
      getCurrentScene: async () => currentScene,
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(switchScene).not.toHaveBeenCalled();

    // Model OBS changing while both its websocket event and the WinEvent hook
    // transition are lost. The periodic foreground refresh must still repair it.
    currentScene = { id: "scene-other", name: "Other" };
    await vi.advanceTimersByTimeAsync(1_200);

    expect(requestForegroundSnapshot).toHaveBeenCalledTimes(2);
    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-game");
    service.shutdownWindowSceneSwitcher();
  });

  it("retries when OBS accepts a switch request but remains on the wrong scene", async () => {
    const service = await loadService();
    let sequence = 0;
    let currentScene = { id: "scene-other", name: "Other" };
    const switchScene = vi.fn(async (sceneUuid: string) => {
      if (switchScene.mock.calls.length >= 2) {
        currentScene = { id: sceneUuid, name: "Steins;Gate" };
      }
    });
    const requestForegroundSnapshot = vi.fn(() => {
      sequence += 1;
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence,
      });
    });

    service.configureWindowSceneSwitcherRuntime({
      isOBSConnected: () => true,
      getCurrentCollectionName: async () => "Games",
      getScenes: async () => [
        { id: "scene-other", name: "Other" },
        { id: "scene-game", name: "Steins;Gate" },
      ],
      getCurrentScene: async () => currentScene,
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(switchScene).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_200);

    expect(switchScene).toHaveBeenCalledTimes(2);
    expect(currentScene.id).toBe("scene-game");
    service.shutdownWindowSceneSwitcher();
  });

  it("releases a stale manual hold when a generated rule is saved for the focused game", async () => {
    config.collections[0].rules = [];
    const service = await loadService();
    let sequence = 0;
    let currentScene = { id: "scene-other", name: "Other" };
    const switchScene = vi.fn(async (sceneUuid: string) => {
      currentScene = { id: sceneUuid, name: "New Game Scene" };
    });
    const emitFocusedGame = () => {
      sequence += 1;
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence,
      });
    };

    service.configureWindowSceneSwitcherRuntime({
      isOBSConnected: () => true,
      getCurrentCollectionName: async () => "Games",
      getScenes: async () => [
        { id: "scene-other", name: "Other" },
        { id: "scene-created", name: "New Game Scene" },
      ],
      getCurrentScene: async () => currentScene,
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot: emitFocusedGame,
    });
    await vi.advanceTimersByTimeAsync(200);

    // Scene creation changes the program scene before the generated rule is
    // persisted. Previously this latched a manual hold onto the game forever.
    currentScene = { id: "scene-created", name: "New Game Scene" };
    service.handleOBSSceneChanged(currentScene);
    service.upsertGeneratedWindowSceneRule("Games", "Games.json", {
      sceneUuid: "scene-created",
      sceneName: "New Game Scene",
      titlePattern: "Steins;Gate",
      executableName: "game.exe",
    });
    await vi.advanceTimersByTimeAsync(200);

    currentScene = { id: "scene-other", name: "Other" };
    emitFocusedGame();
    await vi.advanceTimersByTimeAsync(200);

    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-created");
    service.shutdownWindowSceneSwitcher();
  });

  it("treats focusing a GSM window as leaving a manually held game context", async () => {
    const service = await loadService();
    let sequence = 0;
    let currentScene = { id: "scene-game", name: "Steins;Gate" };
    const switchScene = vi.fn(async (sceneUuid: string) => {
      currentScene = { id: sceneUuid, name: "Steins;Gate" };
    });
    const emitFocusedGame = () => {
      sequence += 1;
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence,
      });
    };

    service.configureWindowSceneSwitcherRuntime({
      isOBSConnected: () => true,
      getCurrentCollectionName: async () => "Games",
      getScenes: async () => [
        { id: "scene-other", name: "Other" },
        { id: "scene-game", name: "Steins;Gate" },
      ],
      getCurrentScene: async () => currentScene,
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot: emitFocusedGame,
    });
    await vi.advanceTimersByTimeAsync(200);

    currentScene = { id: "scene-other", name: "Other" };
    service.handleOBSSceneChanged(currentScene);
    sequence += 1;
    service.handleForegroundWindowSnapshot({
      hwnd: "5678",
      pid: process.pid,
      title: "GameSentenceMiner",
      executableName: "GameSentenceMiner.exe",
      capturedAt: Date.now(),
      sequence,
    });
    emitFocusedGame();
    await vi.advanceTimersByTimeAsync(200);

    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-game");
    service.shutdownWindowSceneSwitcher();
  });

  it("does not latch a manual hold when a scene-creation event arrives after its rule", async () => {
    config.collections[0].rules = [];
    const service = await loadService();
    let sequence = 0;
    let currentScene = { id: "scene-other", name: "Other" };
    const switchScene = vi.fn(async (sceneUuid: string) => {
      currentScene = { id: sceneUuid, name: "New Game Scene" };
    });
    const emitFocusedGame = () => {
      sequence += 1;
      service.handleForegroundWindowSnapshot({
        hwnd: "1234",
        pid: 999_999,
        title: "Steins;Gate",
        executableName: "game.exe",
        capturedAt: Date.now(),
        sequence,
      });
    };

    service.configureWindowSceneSwitcherRuntime({
      isOBSConnected: () => true,
      getCurrentCollectionName: async () => "Games",
      getScenes: async () => [
        { id: "scene-other", name: "Other" },
        { id: "scene-created", name: "New Game Scene" },
      ],
      getCurrentScene: async () => currentScene,
      switchScene,
      suggestRule: async () => null,
      restoreForegroundWindow: () => {},
      requestForegroundSnapshot: emitFocusedGame,
    });
    await vi.advanceTimersByTimeAsync(200);

    currentScene = { id: "scene-created", name: "New Game Scene" };
    service.upsertGeneratedWindowSceneRule("Games", "Games.json", {
      sceneUuid: "scene-created",
      sceneName: "New Game Scene",
      titlePattern: "Steins;Gate",
      executableName: "game.exe",
    });
    service.expectWindowSceneSwitcherOBSSceneChange("scene-created");
    service.handleOBSSceneChanged(currentScene);
    await vi.advanceTimersByTimeAsync(200);

    currentScene = { id: "scene-other", name: "Other" };
    emitFocusedGame();
    await vi.advanceTimersByTimeAsync(200);

    expect(switchScene).toHaveBeenCalledOnce();
    expect(switchScene).toHaveBeenCalledWith("scene-created");
    service.shutdownWindowSceneSwitcher();
  });
});
