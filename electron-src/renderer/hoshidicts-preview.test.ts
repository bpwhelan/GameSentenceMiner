/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const syncScript = path.resolve(
  root,
  "electron-src/renderer/scripts/sync-legacy-assets.mjs"
);
const previewDirectory = path.resolve(
  root,
  "electron-src/renderer/public/hoshidicts-preview"
);

beforeAll(() => {
  execFileSync(process.execPath, [syncScript], { cwd: root });
});

describe("Hoshidicts popup preview assets", () => {
  it("initializes the browser reader API from the generated runtime", () => {
    const html = readFileSync(path.join(previewDirectory, "index.html"), "utf8");
    const scripts = Array.from(
      html.matchAll(/<script\s+defer\s+src="\.\/(.*?)"><\/script>/g),
      (match) => match[1]
    );
    expect(scripts).toEqual([
      "constants.js",
      "audio.js",
      "popup.js",
      "reader.js",
      "preview.js"
    ]);
    for (const fileName of scripts) {
      expect(readFileSync(path.join(previewDirectory, fileName), "utf8")).not.toBe("");
    }

    const browserWindow: Record<string, unknown> = {};
    const context = vm.createContext({
      window: browserWindow,
      URL,
      AbortController,
      TextDecoder,
      TextEncoder,
      setTimeout,
      clearTimeout
    });

    for (const fileName of [
      "constants.js",
      "audio.js",
      "popup.js",
      "reader.js"
    ]) {
      vm.runInContext(
        readFileSync(path.join(previewDirectory, fileName), "utf8"),
        context,
        { filename: fileName }
      );
    }

    const reader = browserWindow.GSMHoshidictsReader as
      | { createHoshidictsReader?: unknown }
      | undefined;
    expect(reader?.createHoshidictsReader).toBeTypeOf("function");
  });
});