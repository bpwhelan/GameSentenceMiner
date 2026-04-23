import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

type OverlayLine = {
  text: string;
  bounding_rect: {
    x1: number;
    y1: number;
    x3: number;
    y3: number;
  };
};

function loadBlockDetectionModule() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/block_detection.js"),
    "utf8"
  );

  const module = { exports: {} as any };
  const context = {
    module,
    exports: module.exports,
    console,
    window: {},
    globalThis: {}
  };

  vm.runInNewContext(source, context, {
    filename: "GSM_Overlay/block_detection.js"
  });

  return module.exports;
}

function makeLine(
  text: string,
  x1: number,
  y1: number,
  x3: number,
  y3: number
): OverlayLine {
  return {
    text,
    bounding_rect: { x1, y1, x3, y3 }
  };
}

const { detectTextBlocks } = loadBlockDetectionModule();

describe("legacy overlay block detection", () => {
  it("splits multi-line columns separated by a persistent empty strip", () => {
    const lines: OverlayLine[] = [
      makeLine("left-1", 0.04, 0.08, 0.52, 0.16),
      makeLine("left-2", 0.04, 0.18, 0.50, 0.26),
      makeLine("left-3", 0.04, 0.28, 0.53, 0.36),
      makeLine("right-1", 0.68, 0.08, 0.93, 0.14),
      makeLine("right-2", 0.68, 0.16, 0.91, 0.22),
      makeLine("right-3", 0.68, 0.24, 0.90, 0.30)
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(2);
    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
    expect(result.lineBlocks.get(1)).toBe(result.lineBlocks.get(2));
    expect(result.lineBlocks.get(3)).toBe(result.lineBlocks.get(4));
    expect(result.lineBlocks.get(4)).toBe(result.lineBlocks.get(5));
    expect(result.lineBlocks.get(0)).not.toBe(result.lineBlocks.get(3));
  });

  it("does not split a single-row pair with a wide gap and no repeated support", () => {
    const lines: OverlayLine[] = [
      makeLine("left", 0.08, 0.10, 0.50, 0.18),
      makeLine("right", 0.64, 0.10, 0.82, 0.18)
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(1);
    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
  });
});
