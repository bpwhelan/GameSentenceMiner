import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { JSDOM } from "jsdom";
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

const {
  createRecentBlockHistory,
  detectTextBlocks,
  insertBlockSeparatorAfter
} = loadBlockDetectionModule();

describe("overlay block detection", () => {
  it("splits the reported two-line NVL sequence across line IDs", () => {
    const history = createRecentBlockHistory();
    const previousLine = makeLine(
      "「それじゃあお別れね。バイ、志貴。",
      0.05,
      0.08,
      0.88,
      0.16
    );
    detectTextBlocks([previousLine], undefined, history, { resultKey: "line-1" });

    const result = detectTextBlocks(
      [
        previousLine,
        makeLine(
          "どんな人間だって人生ってのは落とし穴だらけなのよ。",
          0.07,
          0.20,
          0.90,
          0.28
        ),
      ],
      undefined,
      history,
      { resultKey: "line-2" }
    );

    expect(result.blockCount).toBe(2);
    expect(result.lineBlocks.get(0)).not.toBe(result.lineBlocks.get(1));
  });

  it("preserves a previous NVL block and starts a new block for appended text", () => {
    const history = createRecentBlockHistory();
    const firstFrame: OverlayLine[] = [
      makeLine("古い台詞、その一。", 0.08, 0.60, 0.70, 0.66),
      makeLine("古い台詞、その二。", 0.08, 0.68, 0.70, 0.74),
    ];

    const firstResult = detectTextBlocks(firstFrame, undefined, history);

    expect(firstResult.blockCount).toBe(1);
    expect(history.getRawTexts()).toEqual([
      "古い台詞、その一。古い台詞、その二。"
    ]);

    const secondFrame: OverlayLine[] = [
      ...firstFrame,
      makeLine("新しい台詞、その一。", 0.08, 0.76, 0.70, 0.82),
      makeLine("新しい台詞、その二。", 0.08, 0.84, 0.70, 0.90),
    ];
    const secondResult = detectTextBlocks(secondFrame, undefined, history);
    const preservedBlockId = secondResult.lineBlocks.get(0);
    const newBlockId = secondResult.lineBlocks.get(2);

    expect(secondResult.blockCount).toBe(2);
    expect(secondResult.lineBlocks.get(1)).toBe(preservedBlockId);
    expect(secondResult.lineBlocks.get(3)).toBe(newBlockId);
    expect(newBlockId).not.toBe(preservedBlockId);
    expect(history.getRawTexts()).toEqual([
      "古い台詞、その一。古い台詞、その二。",
      "新しい台詞、その一。新しい台詞、その二。"
    ]);

    const thirdFrame: OverlayLine[] = [
      ...secondFrame,
      makeLine("さらに新しい台詞。", 0.08, 0.92, 0.70, 0.98),
    ];
    const thirdResult = detectTextBlocks(thirdFrame, undefined, history);

    expect(thirdResult.blockCount).toBe(3);
    expect(thirdResult.lineBlocks.get(0)).toBe(thirdResult.lineBlocks.get(1));
    expect(thirdResult.lineBlocks.get(2)).toBe(thirdResult.lineBlocks.get(3));
    expect(thirdResult.lineBlocks.get(4)).not.toBe(thirdResult.lineBlocks.get(3));
  });

  it("matches any of the five recent raw blocks and evicts the oldest", () => {
    const history = createRecentBlockHistory();
    for (const text of ["one", "two", "three", "four", "five", "six"]) {
      history.remember(text);
    }

    expect(history.getRawTexts()).toEqual(["two", "three", "four", "five", "six"]);

    const lines: OverlayLine[] = [
      makeLine("three", 0.08, 0.70, 0.70, 0.76),
      makeLine("brand-new", 0.08, 0.78, 0.70, 0.84),
    ];
    const result = detectTextBlocks(lines, undefined, history);

    expect(result.blockCount).toBe(2);
    expect(result.lineBlocks.get(0)).not.toBe(result.lineBlocks.get(1));
  });

  it("replaces retries for one line without matching partial text against itself", () => {
    const history = createRecentBlockHistory();
    const partialLines: OverlayLine[] = [
      makeLine("partial OCR text", 0.08, 0.70, 0.70, 0.76),
    ];
    detectTextBlocks(partialLines, undefined, history, { resultKey: "line-1" });

    const completedLines: OverlayLine[] = [
      ...partialLines,
      makeLine(" completed", 0.08, 0.78, 0.70, 0.84),
    ];
    const retryResult = detectTextBlocks(
      completedLines,
      undefined,
      history,
      { resultKey: "line-1" }
    );

    expect(retryResult.blockCount).toBe(1);
    expect(history.getRawTexts()).toEqual(["partial OCR text completed"]);

    const nextResult = detectTextBlocks(
      [
        ...completedLines,
        makeLine("next line", 0.08, 0.86, 0.70, 0.92),
      ],
      undefined,
      history,
      { resultKey: "line-2" }
    );

    expect(nextResult.blockCount).toBe(2);
    expect(nextResult.lineBlocks.get(0)).toBe(nextResult.lineBlocks.get(1));
    expect(nextResult.lineBlocks.get(2)).not.toBe(nextResult.lineBlocks.get(1));
  });

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

  it("splits a short character name above a wider dialogue body", () => {
    const lines: OverlayLine[] = [
      makeLine("エステル", 0.061, 0.122, 0.113, 0.146),
      makeLine("ってことは、この向こう側は", 0.068, 0.176, 0.292, 0.207),
      makeLine("もうリベールじゃないんだ……", 0.068, 0.218, 0.310, 0.249),
    ];

    const result = detectTextBlocks(lines);
    const nameBlockId = result.lineBlocks.get(0);
    const dialogueBlockId = result.lineBlocks.get(1);

    expect(result.blockCount).toBe(2);
    expect(nameBlockId).not.toBe(dialogueBlockId);
    expect(result.lineBlocks.get(2)).toBe(dialogueBlockId);
    expect(result.blockMetadata.get(nameBlockId)).toMatchObject({
      role: "character-name",
      relatedBlockId: dialogueBlockId
    });
    expect(result.blockMetadata.get(dialogueBlockId)).toMatchObject({
      role: "dialogue",
      relatedBlockId: nameBlockId
    });
  });

  it("splits a centered nameplate even when it does not overlap the short first dialogue line", () => {
    const lines: OverlayLine[] = [
      makeLine("衛兵", 0.485, 0.806, 0.515, 0.833),
      makeLine("つい今しがた", 0.395, 0.855, 0.475, 0.889),
      makeLine("将軍がお戻りになったぞ。", 0.395, 0.904, 0.595, 0.940),
    ];

    const result = detectTextBlocks(lines);
    const nameBlockId = result.lineBlocks.get(0);
    const dialogueBlockId = result.lineBlocks.get(1);

    expect(result.blockCount).toBe(2);
    expect(nameBlockId).not.toBe(dialogueBlockId);
    expect(result.lineBlocks.get(2)).toBe(dialogueBlockId);
    expect(result.blockMetadata.get(nameBlockId)).toMatchObject({
      role: "character-name",
      relatedBlockId: dialogueBlockId
    });
    expect(result.blockMetadata.get(dialogueBlockId)).toMatchObject({
      role: "dialogue",
      relatedBlockId: nameBlockId
    });
  });

  it("does not treat a short first dialogue line as a name without a strong width difference", () => {
    const lines: OverlayLine[] = [
      makeLine("そうか。", 0.10, 0.72, 0.26, 0.79),
      makeLine("それなら先へ進もう。", 0.10, 0.81, 0.31, 0.88),
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(1);
    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
    expect(result.blockMetadata.get(result.lineBlocks.get(0))).toMatchObject({
      role: "text"
    });
  });

  it("keeps a short punctuation-free dialogue line when line spacing and font size match", () => {
    const lines: OverlayLine[] = [
      makeLine("でも", 0.10, 0.70, 0.16, 0.76),
      makeLine("この先に何があるのか", 0.10, 0.78, 0.42, 0.84),
      makeLine("確かめてみたいんだ", 0.10, 0.86, 0.38, 0.92),
    ];

    const result = detectTextBlocks(lines);

    expect(result.blockCount).toBe(1);
    expect(result.lineBlocks.get(0)).toBe(result.lineBlocks.get(1));
    expect(result.lineBlocks.get(1)).toBe(result.lineBlocks.get(2));
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

describe("overlay block separators", () => {
  it("keeps a recreated newline between reused block containers", () => {
    const dom = new JSDOM("<body></body>");
    const { document } = dom.window;
    const firstBlock = document.createElement("p");
    const secondBlock = document.createElement("p");
    firstBlock.className = "text-block-container";
    secondBlock.className = "text-block-container";
    firstBlock.textContent = "first";
    secondBlock.textContent = "second";
    document.body.append(firstBlock, secondBlock);

    insertBlockSeparatorAfter(document, firstBlock);

    expect(document.body.textContent).toBe("first\nsecond");
    expect(firstBlock.nextElementSibling?.className).toBe("block-separator");
  });
});
