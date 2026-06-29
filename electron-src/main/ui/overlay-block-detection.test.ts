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

describe("overlay block detection", () => {
  it("merges stacked lines that are vertically close into one block", () => {
    const lines: OverlayLine[] = [
      makeLine("line-1", 0.04, 0.08, 0.52, 0.16),
      makeLine("line-2", 0.04, 0.18, 0.50, 0.26),
      makeLine("line-3", 0.04, 0.28, 0.53, 0.36),
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(1);
    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
    expect(result.lineBlocks.get(1)).toBe(result.lineBlocks.get(2));
  });

  it("keeps an indented first line in the same block as the body below it", () => {
    const lines: OverlayLine[] = [
      makeLine("indented-line-1", 0.12, 0.78, 0.90, 0.86),
      makeLine("body-line-2",     0.10, 0.88, 0.78, 0.96),
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(1);
    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
  });

  it("merges tall dialogue lines even when small UI text shrinks the median height", () => {
    // The two tall dialogue lines belong together. The surrounding small UI
    // labels must not drag the height unit down and split them apart.
    const lines: OverlayLine[] = [
      makeLine("dialogue-1", 0.12, 0.78, 0.90, 0.86),
      makeLine("dialogue-2", 0.10, 0.88, 0.78, 0.96),
      makeLine("ui-a", 0.02, 0.02, 0.10, 0.04),
      makeLine("ui-b", 0.20, 0.02, 0.30, 0.04),
      makeLine("ui-c", 0.85, 0.02, 0.95, 0.04),
      makeLine("ui-d", 0.02, 0.95, 0.09, 0.97),
      makeLine("ui-e", 0.40, 0.50, 0.46, 0.52),
    ];

    const result = detectTextBlocks(lines);

    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
  });

  it("merges text that is close on the same row into one block", () => {
    const lines: OverlayLine[] = [
      makeLine("Name",     0.02, 0.75, 0.15, 0.83),
      makeLine("Dialogue", 0.20, 0.75, 0.98, 0.83),
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(1);
    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
  });

  it("splits two columns separated by a wide empty strip", () => {
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

  it("splits a single-row pair separated by a wide horizontal gap", () => {
    const lines: OverlayLine[] = [
      makeLine("left", 0.08, 0.10, 0.50, 0.18),
      makeLine("right", 0.64, 0.10, 0.82, 0.18)
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(2);
    expect(result.lineBlocks.get(0)).not.toBe(result.lineBlocks.get(1));
  });

  it("does not merge unrelated same-row UI areas across most of the screen", () => {
    const lines: OverlayLine[] = [
      makeLine("洗濯物が乾きやすいですね", 0.02, 0.03, 0.31, 0.09),
      makeLine("A 決定  LT パーティステータス表示  メニュー", 0.51, 0.03, 0.97, 0.09),
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(2);
    expect(result.lineBlocks.get(0)).not.toBe(result.lineBlocks.get(1));
  });
});
