import path from "node:path";

import { describe, expect, it } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/hoshidicts_result_model.js",
);

const dictionaries = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "JMdict",
    displayTitle: "JMdict",
    types: ["term"],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Frequency",
    displayTitle: "Frequency",
    types: ["frequency", "pitch"],
  },
];

function nativeLookup() {
  return {
    catalogGeneration: 4,
    requestGeneration: 9,
    matchedLength: 4,
    elapsedMs: 7,
    results: [
      {
        matched: "食べました",
        deinflected: "食べる",
        process: ["polite past", "dictionary"],
        preprocessorSteps: 0,
        term: {
          expression: "食べる",
          reading: "たべる",
          rules: "v1 transitive",
          glossaries: [
            {
              dictionary: dictionaries[0].id,
              glossary: "to eat",
              definitionTags: "common",
              termTags: "usually-kana",
            },
            {
              dictionary: dictionaries[0].id,
              glossary: JSON.stringify({
                type: "structured-content",
                content: [{ tag: "span", content: "consume" }],
              }),
              definitionTags: "",
              termTags: "",
            },
          ],
          frequencies: [
            {
              dictionary: dictionaries[1].id,
              values: [{ value: 100, displayValue: "100" }],
            },
          ],
          pitches: [
            {
              dictionary: dictionaries[1].id,
              positions: [2],
            },
          ],
        },
      },
      {
        matched: "食べ",
        deinflected: "食べ",
        process: [],
        preprocessorSteps: 0,
        term: {
          expression: "食べ",
          reading: "たべ",
          rules: "n",
          glossaries: [
            {
              dictionary: dictionaries[0].id,
              glossary: "food",
              definitionTags: "",
              termTags: "",
            },
          ],
          frequencies: [],
          pitches: [],
        },
      },
    ],
  };
}

describe("HoshiDicts result model", () => {
  it("preserves native rank and groups content by opaque dictionary ID", async () => {
    const { normalizeTermLookupResult } = await import(modulePath);
    const model = normalizeTermLookupResult(nativeLookup(), { dictionaries });

    expect(model).toMatchObject({
      catalogGeneration: 4,
      requestGeneration: 9,
      matchedLength: 4,
      nativeElapsedMs: 7,
    });
    expect(model.entries.map((entry: any) => entry.expression)).toEqual([
      "食べる",
      "食べ",
    ]);
    expect(model.entries[0]).toMatchObject({
      rank: 0,
      matched: "食べました",
      deinflected: "食べる",
      deinflectionReason: "polite past > dictionary",
      partOfSpeech: ["v1", "transitive"],
    });
    expect(model.entries[0].dictionaries).toHaveLength(2);
    expect(model.entries[0].dictionaries[0]).toMatchObject({
      dictionaryId: dictionaries[0].id,
      title: "JMdict",
    });
    expect(model.entries[0].dictionaries[0].glossaries).toHaveLength(2);
    expect(model.entries[0].dictionaries[1]).toMatchObject({
      dictionaryId: dictionaries[1].id,
      frequencies: [{ value: 100, displayValue: "100" }],
      pitches: [2],
    });
  });

  it("produces deterministic stable IDs and deeply immutable output", async () => {
    const { normalizeTermLookupResult } = await import(modulePath);
    const first = normalizeTermLookupResult(nativeLookup(), { dictionaries });
    const second = normalizeTermLookupResult(nativeLookup(), { dictionaries });

    expect(first.entries.map((entry: any) => entry.id)).toEqual(
      second.entries.map((entry: any) => entry.id),
    );
    expect(first.entries[0].dictionaries[0].glossaries[0].id).toBe(
      second.entries[0].dictionaries[0].glossaries[0].id,
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0].dictionaries[0].glossaries[0])).toBe(
      true,
    );
  });

  it("rejects results that cannot be tied to an active dictionary ID", async () => {
    const { normalizeTermLookupResult } = await import(modulePath);
    const response = nativeLookup();
    response.results[0].term.glossaries[0].dictionary =
      "GSM Hoshi Fixture";

    expect(() =>
      normalizeTermLookupResult(response, { dictionaries }),
    ).toThrowError(
      expect.objectContaining({
        code: "UNKNOWN_DICTIONARY",
      }),
    );
  });

  it("bounds native arrays and strings before creating a view model", async () => {
    const { normalizeTermLookupResult } = await import(modulePath);
    const response = nativeLookup();
    response.results[0].term.glossaries[0].glossary = "x".repeat(300_000);

    expect(() =>
      normalizeTermLookupResult(response, { dictionaries }),
    ).toThrowError(
      expect.objectContaining({
        code: "RESULT_LIMIT_EXCEEDED",
      }),
    );
  });
});
