import { createRequire } from "node:module";
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
});
