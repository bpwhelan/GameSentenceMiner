import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

const overlayMainSource = fs.readFileSync(
  path.resolve(process.cwd(), "GSM_Overlay/main.js"),
  "utf8"
);

function sourceBetween(start: string, end: string): string {
  const startIndex = overlayMainSource.indexOf(start);
  const endIndex = overlayMainSource.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unable to find overlay main-process segment: ${start}`);
  }
  return overlayMainSource.slice(startIndex, endIndex);
}

function runMainSegment(source: string, context: Record<string, unknown>): Promise<unknown> {
  return vm.runInNewContext(`(async () => { ${source} })()`, context);
}

function loadReaderEngineSelection() {
  const modulePath = path.resolve(
    process.cwd(),
    "GSM_Overlay/features/reader_engine_selection.js"
  );
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath) as {
    selectDictionaryReaderEngine: (environment?: Record<string, string | undefined>) => {
      engine: "hoshidicts" | "yomitan";
      hoshidictsEnabled: boolean;
      yomitanEnabled: boolean;
    };
    startSelectedDictionaryReader: <T>(options: {
      environment?: Record<string, string | undefined>;
      startYomitan: () => Promise<T>;
    }) => Promise<{
      engine: "hoshidicts" | "yomitan";
      yomitanExtension: T | null;
    }>;
  };
}

describe("overlay dictionary reader selection", () => {
  it("defaults to Yomitan when Hoshidicts is disabled or unset", () => {
    const { selectDictionaryReaderEngine } = loadReaderEngineSelection();

    expect(selectDictionaryReaderEngine({})).toEqual({
      engine: "yomitan",
      hoshidictsEnabled: false,
      yomitanEnabled: true
    });
    expect(
      selectDictionaryReaderEngine({ GSM_HOSHIDICTS_ENABLED: "0" })
    ).toEqual({
      engine: "yomitan",
      hoshidictsEnabled: false,
      yomitanEnabled: true
    });
    expect(
      selectDictionaryReaderEngine({ GSM_HOSHIDICTS_ENABLED: "1" })
    ).toEqual({
      engine: "hoshidicts",
      hoshidictsEnabled: true,
      yomitanEnabled: false
    });
  });

  it.each([
    [
      "does not start the Yomitan extension when Hoshidicts is selected",
      "1",
      "hoshidicts",
      false
    ],
    [
      "starts Yomitan when Hoshidicts is not selected",
      "0",
      "yomitan",
      true
    ]
  ])("%s", async (_label, enabledFlag, engine, startsYomitan) => {
    const { startSelectedDictionaryReader } = loadReaderEngineSelection();
    const extension = { id: "yomitan-id" };
    const startYomitan = vi.fn(async () => extension);

    await expect(
      startSelectedDictionaryReader({
        environment: { GSM_HOSHIDICTS_ENABLED: enabledFlag },
        startYomitan
      })
    ).resolves.toEqual({
      engine,
      yomitanExtension: startsYomitan ? extension : null
    });
    expect(startYomitan).toHaveBeenCalledTimes(startsYomitan ? 1 : 0);
  });

  it("keeps Yomitan-only main-process effects disabled when Hoshidicts is selected", async () => {
    const fsEffects = {
      copyFileSync: vi.fn(),
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify({})),
      statSync: vi.fn(() => ({ mtimeMs: 1 })),
      watch: vi.fn(),
      writeFileSync: vi.fn()
    };
    const readerEngineSelection = loadReaderEngineSelection();
    const baseContext: Record<string, any> = {
      console,
      dictionaryReaderSelection: null,
      fs: fsEffects,
      isLinux: () => true,
      path,
      process: { env: { GSM_HOSHIDICTS_ENABLED: "1" } },
      selectDictionaryReaderEngine: readerEngineSelection.selectDictionaryReaderEngine,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn()
    };
    await runMainSegment(
      sourceBetween(
        "  dictionaryReaderSelection = selectDictionaryReaderEngine(process.env);",
        "\n\n  if (!IN_PROCESS_OVERLAY"
      ),
      baseContext
    );
    expect(baseContext.dictionaryReaderSelection).toEqual({
      engine: "hoshidicts",
      hoshidictsEnabled: true,
      yomitanEnabled: false
    });

    await runMainSegment(
      sourceBetween(
        "if (dictionaryReaderSelection.yomitanEnabled && isLinux()) {",
        "  // ===========================================================\n  // END MIGRATION LOGIC"
      ),
      Object.assign(baseContext, {
        IN_PROCESS_OVERLAY: true,
        Date,
        activeManifestPath: "manifest.json",
        app: { exit: vi.fn() },
        dialog: { showMessageBoxSync: vi.fn() },
        isMigrated: false,
        markerPath: "migration_complete.json",
        relaunchOverlayApp: vi.fn(),
        skipMigrationConfirmationInLinux: true,
        staticManifestPath: "manifest_static.json",
        userSettingsExists: false
      })
    );
    expect(fsEffects.copyFileSync).not.toHaveBeenCalled();
    expect(fsEffects.writeFileSync).not.toHaveBeenCalled();

    const loadExtension = vi.fn(async () => ({ id: "yomitan" }));
    const startSelectedDictionaryReader = vi.fn(
      readerEngineSelection.startSelectedDictionaryReader
    );
    Object.assign(baseContext, {
      __dirname: "/overlay",
      dataPath: "/data",
      getOverlaySession: () => ({ clearStorageData: vi.fn(async () => undefined) }),
      getPackagedResourcesPath: () => "/resources",
      isDev: true,
      loadExtension,
      markerPath: "migration_complete.json",
      startSelectedDictionaryReader,
      yomitanExt: null as { id: string } | null
    });
    await runMainSegment(
      sourceBetween(
        "const dictionaryReaderStartup = await startSelectedDictionaryReader({",
        "  console.log(`[DictionaryReader] Selected ${dictionaryReaderStartup.engine}.`);"
      ),
      baseContext
    );
    expect(startSelectedDictionaryReader).toHaveBeenCalledWith(
      expect.objectContaining({ environment: baseContext.process.env })
    );
    expect(baseContext.yomitanExt).toBeNull();
    expect(loadExtension).not.toHaveBeenCalled();

    await runMainSegment(
      sourceBetween(
        "if (yomitanExt && fs.existsSync(markerPath)) {",
        "  // Watch yomitan extension directory"
      ),
      baseContext
    );
    expect(fsEffects.readFileSync).not.toHaveBeenCalled();

    await runMainSegment(
      sourceBetween(
        "if (dictionaryReaderSelection.yomitanEnabled) {",
        "  // Create system tray icon"
      ),
      baseContext
    );
    expect(fsEffects.watch).not.toHaveBeenCalled();

    const BrowserWindow = vi.fn();
    await runMainSegment(
      `${sourceBetween(
        "function openYomitanSettings() {",
        "\nfunction openJitenReaderSettings()"
      )}\nopenYomitanSettings();`,
      Object.assign(baseContext, {
        BrowserWindow,
        yomitanExt: { id: "yomitan" },
        yomitanSettingsWindow: null
      })
    );
    expect(BrowserWindow).not.toHaveBeenCalled();

    const clearAppHotkey = vi.fn();
    const setAppHotkey = vi.fn();
    await runMainSegment(
      sourceBetween(
        "function registerYomitanSettingsHotkey(_oldHotkey) {",
        "  // Register overlay settings hotkey"
      ),
      Object.assign(baseContext, {
        clearAppHotkey,
        openYomitanSettings: vi.fn(),
        setAppHotkey,
        userSettings: {}
      })
    );
    expect(clearAppHotkey).toHaveBeenCalledWith("yomitanSettings");
    expect(setAppHotkey).not.toHaveBeenCalled();

    const menuTemplate: unknown[][] = [];
    await runMainSegment(
      `${sourceBetween(
        "function updateTrayMenu() {",
        "\n\n\nasync function startOverlayAppImpl()"
      )}\nupdateTrayMenu();`,
      Object.assign(baseContext, {
        Menu: { buildFromTemplate: (template: unknown[]) => (menuTemplate.push(template), template) },
        isDev: false,
        isManualMode: () => false,
        pomodoroRemainingMs: () => 0,
        pomodoroPhaseDurationMs: () => 0,
        pomodoroState: { running: false, phase: "work" },
        tray: { setContextMenu: vi.fn() },
        userSettings: {}
      })
    );
    expect(menuTemplate[0]).toContainEqual(expect.objectContaining({
      label: "Yomitan Settings",
      visible: false
    }));

    baseContext.process.env.GSM_HOSHIDICTS_ENABLED = "0";
    await runMainSegment(
      sourceBetween(
        "  dictionaryReaderSelection = selectDictionaryReaderEngine(process.env);",
        "\n\n  if (!IN_PROCESS_OVERLAY"
      ),
      baseContext
    );
    await runMainSegment(
      sourceBetween(
        "const dictionaryReaderStartup = await startSelectedDictionaryReader({",
        "  console.log(`[DictionaryReader] Selected ${dictionaryReaderStartup.engine}.`);"
      ),
      baseContext
    );
    expect(loadExtension).toHaveBeenCalledWith("yomitan");
    expect(baseContext.yomitanExt).toEqual({ id: "yomitan" });

    fsEffects.readFileSync.mockReturnValue(JSON.stringify({ extensionId: "old-extension" }));
    fsEffects.writeFileSync.mockClear();
    await runMainSegment(
      sourceBetween(
        "if (yomitanExt && fs.existsSync(markerPath)) {",
        "  // Watch yomitan extension directory"
      ),
      baseContext
    );
    expect(fsEffects.writeFileSync).toHaveBeenCalledOnce();
    expect(fsEffects.writeFileSync).toHaveBeenCalledWith(
      "migration_complete.json",
      JSON.stringify({ extensionId: "old-extension", id: "yomitan" })
    );
  });
});
