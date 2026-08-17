import { describe, expect, it } from "vitest";

import en from "./en.json";
import ja from "./ja.json";
import ukr from "./ukr.json";

type Tree = { [key: string]: string | Tree };

/**
 * The Hoshidicts renderer must not hardcode English in JSX (an enforced
 * convention), and i18n/index.ts leaves an unresolved `{placeholder}` in the
 * output verbatim. Comparing leaf keys and per-key placeholder sets across the
 * three locales that define settings.hoshidicts covers both failure modes for
 * every key, which is what the handful of rendered-in-ja/ukr tests used to do
 * for about thirty of them.
 */
function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const output = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") {
      output.set(`${prefix}${key}`, value);
    } else {
      for (const [nested, text] of leaves(value, `${prefix}${key}.`)) {
        output.set(nested, text);
      }
    }
  }
  return output;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)]
    .map((match) => match[1])
    .sort();
}

const hoshidicts = (locale: Tree) =>
  leaves((locale.settings as Tree).hoshidicts as Tree);

const english = hoshidicts(en as unknown as Tree);

describe("Hoshidicts locale parity", () => {
  it.each([
    ["ja", ja],
    ["ukr", ukr]
  ])("covers every en key in %s with matching placeholders", (_locale, file) => {
    expect(english.size).toBeGreaterThan(400);

    const translated = hoshidicts(file as unknown as Tree);

    expect([...translated.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of translated) {
      expect(placeholders(text), `${key} placeholders`).toEqual(
        placeholders(english.get(key) ?? "")
      );
    }
  });
});
