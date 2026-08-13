import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

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
  });

  it("selects Hoshidicts exclusively when its effective feature flag is on", () => {
    const { selectDictionaryReaderEngine } = loadReaderEngineSelection();

    expect(
      selectDictionaryReaderEngine({ GSM_HOSHIDICTS_ENABLED: "1" })
    ).toEqual({
      engine: "hoshidicts",
      hoshidictsEnabled: true,
      yomitanEnabled: false
    });
  });

  it("does not start the Yomitan extension when Hoshidicts is selected", async () => {
    const { startSelectedDictionaryReader } = loadReaderEngineSelection();
    const startYomitan = vi.fn(async () => ({ id: "yomitan-id" }));

    await expect(
      startSelectedDictionaryReader({
        environment: { GSM_HOSHIDICTS_ENABLED: "1" },
        startYomitan
      })
    ).resolves.toEqual({
      engine: "hoshidicts",
      yomitanExtension: null
    });
    expect(startYomitan).not.toHaveBeenCalled();
  });

  it("starts Yomitan when Hoshidicts is not selected", async () => {
    const { startSelectedDictionaryReader } = loadReaderEngineSelection();
    const extension = { id: "yomitan-id" };
    const startYomitan = vi.fn(async () => extension);

    await expect(
      startSelectedDictionaryReader({
        environment: { GSM_HOSHIDICTS_ENABLED: "0" },
        startYomitan
      })
    ).resolves.toEqual({
      engine: "yomitan",
      yomitanExtension: extension
    });
    expect(startYomitan).toHaveBeenCalledOnce();
  });

  it("gates every Yomitan startup and settings path in the overlay main process", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "GSM_Overlay/main.js"),
      "utf8"
    );
    const readerCss = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "GSM_Overlay/features/hoshidicts/reader.css"
      ),
      "utf8"
    );

    expect(source).toContain(
      "dictionaryReaderSelection = selectDictionaryReaderEngine(process.env);"
    );
    expect(source).toContain(
      "if (dictionaryReaderSelection.yomitanEnabled && isLinux()) {"
    );
    expect(source).toContain(
      "const dictionaryReaderStartup = await startSelectedDictionaryReader({"
    );
    expect(source).toContain(
      "if (yomitanExt && fs.existsSync(markerPath)) {"
    );
    expect(source).toContain(
      "// Watch yomitan extension directory for rebuilds and hot-reload on change (dev workflow)\n  if (dictionaryReaderSelection.yomitanEnabled) {"
    );
    expect(source).toContain(
      "if (!dictionaryReaderSelection.yomitanEnabled || !yomitanExt) {"
    );
    expect(source).toContain(
      "visible: dictionaryReaderSelection.yomitanEnabled,"
    );
    expect(source).toContain(
      "if (!dictionaryReaderSelection.yomitanEnabled) {\n      clearAppHotkey(\"yomitanSettings\");"
    );
    expect(readerCss).toContain(
      "html.gsm-hoshidicts-enabled #btn-yomitan"
    );
  });
});
