import path from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const modulePath = path.resolve(
  process.cwd(),
  "GSM_Overlay/hoshidicts_popup.js",
);

function model(generation = 1) {
  return Object.freeze({
    catalogGeneration: 3,
    requestGeneration: generation,
    matchedLength: 2,
    nativeElapsedMs: 4,
    entries: Object.freeze([
      Object.freeze({
        id: "result-cat",
        rank: 0,
        expression: "猫",
        reading: "ねこ",
        matched: "猫",
        deinflected: "猫",
        deinflectionReason: "",
        partOfSpeech: Object.freeze(["n"]),
        dictionaries: Object.freeze([
          Object.freeze({
            id: "result-cat-dictionary",
            dictionaryId: "11111111-1111-4111-8111-111111111111",
            title: "Fixture",
            displayTitle: "Fixture",
            glossaries: Object.freeze([
              Object.freeze({
                id: "result-cat-glossary-0",
                content: "cat",
                definitionTags: Object.freeze([]),
                termTags: Object.freeze([]),
              }),
            ]),
            frequencies: Object.freeze([]),
            pitches: Object.freeze([]),
          }),
        ]),
      }),
      Object.freeze({
        id: "result-run",
        rank: 1,
        expression: "走る",
        reading: "はしる",
        matched: "走る",
        deinflected: "走る",
        deinflectionReason: "",
        partOfSpeech: Object.freeze(["v5r"]),
        dictionaries: Object.freeze([
          Object.freeze({
            id: "result-run-dictionary",
            dictionaryId: "11111111-1111-4111-8111-111111111111",
            title: "Fixture",
            displayTitle: "Fixture",
            glossaries: Object.freeze([
              Object.freeze({
                id: "result-run-glossary-0",
                content: "to run",
                definitionTags: Object.freeze([]),
                termTags: Object.freeze([]),
              }),
            ]),
            frequencies: Object.freeze([]),
            pitches: Object.freeze([2]),
          }),
        ]),
      }),
    ]),
  });
}

function popupDom() {
  return new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://overlay.invalid/",
  });
}

describe("HoshiDicts popup placement", () => {
  it("places below the anchor when possible and clamps to the work area", async () => {
    const { computePopupPlacement } = await import(modulePath);

    expect(
      computePopupPlacement(
        { x: 200, y: 100, height: 20 },
        { width: 360, height: 300 },
        { x: 0, y: 0, width: 1280, height: 720 },
      ),
    ).toEqual({ left: 200, top: 128 });

    expect(
      computePopupPlacement(
        { x: 1240, y: 690, height: 20 },
        { width: 360, height: 300 },
        { x: 0, y: 0, width: 1280, height: 720 },
      ),
    ).toEqual({ left: 912, top: 382 });
  });
});

describe("HoshiDicts popup", () => {
  it("renders distinct loading, empty, unavailable, rebuilding, and error states", async () => {
    const { HoshiDictsPopup } = await import(modulePath);
    const dom = popupDom();
    const popup = new HoshiDictsPopup({
      document: dom.window.document,
      window: dom.window,
      getWorkArea: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    });

    popup.showLoading({
      generation: 1,
      anchor: { x: 20, y: 30, height: 18 },
    });
    expect(popup.getSnapshot().state).toBe("loading");
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toContain(
      "Looking up",
    );

    for (const [state, expected] of [
      ["empty", "No dictionary result"],
      ["host-unavailable", "HoshiDicts is unavailable"],
      ["no-dictionaries", "No term dictionaries are enabled"],
      ["catalog-rebuilding", "Dictionary catalog is rebuilding"],
      ["error", "Dictionary lookup failed"],
    ] as const) {
      popup.showState(state, {
        generation: 1,
        anchor: { x: 20, y: 30, height: 18 },
        errorCode: state === "error" ? "LOOKUP_FAILED" : undefined,
      });
      expect(popup.getSnapshot().state).toBe(state);
      expect(
        dom.window.document.querySelector(".hoshidicts-popup-state")?.textContent,
      ).toContain(expected);
    }
  });

  it("keeps stable action selection while navigating top-level entries", async () => {
    const { HoshiDictsPopup } = await import(modulePath);
    const dom = popupDom();
    const popup = new HoshiDictsPopup({
      document: dom.window.document,
      window: dom.window,
      getWorkArea: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    });
    popup.showResults(model(), {
      generation: 1,
      anchor: { x: 20, y: 30, height: 18 },
      sourceSentence: "猫が走る。",
    });

    expect(popup.getSnapshot()).toMatchObject({
      state: "results",
      entryIndex: 0,
      entryId: "result-cat",
      selectedActionId: "hoshi-action:previous-entry",
    });
    expect(
      dom.window.document.querySelector(".hoshidicts-expression")?.textContent,
    ).toBe("猫");

    await popup.command("next-entry");
    expect(popup.getSnapshot()).toMatchObject({
      entryIndex: 1,
      entryId: "result-run",
      selectedActionId: "hoshi-action:previous-entry",
    });
    expect(
      dom.window.document.querySelector(".hoshidicts-expression")?.textContent,
    ).toBe("走る");

    await popup.command("next-entry");
    expect(popup.getSnapshot().entryId).toBe("result-cat");
    await popup.command("previous-entry");
    expect(popup.getSnapshot().entryId).toBe("result-run");

    await popup.command("select-action", { direction: "next" });
    expect(popup.getSnapshot().selectedActionId).toBe(
      "hoshi-action:next-entry",
    );
    popup.showResults(model(), {
      generation: 1,
      anchor: { x: 20, y: 30, height: 18 },
      sourceSentence: "猫が走る。",
    });
    expect(popup.getSnapshot().selectedActionId).toBe(
      "hoshi-action:next-entry",
    );
  });

  it("bounds recursive history and preserves the original source sentence", async () => {
    const { HoshiDictsPopup } = await import(modulePath);
    const dom = popupDom();
    const requestLookup = vi.fn(async () => ({ status: "applied" }));
    const popup = new HoshiDictsPopup({
      document: dom.window.document,
      window: dom.window,
      requestLookup,
      maxHistory: 3,
      getWorkArea: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    });
    popup.showResults(model(1), {
      generation: 1,
      anchor: { x: 20, y: 30, height: 18 },
      sourceSentence: "猫が走る。",
    });

    await popup.requestRecursiveLookup("走る");
    expect(requestLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "走る",
        recursive: true,
        sourceSentence: "猫が走る。",
      }),
    );
    popup.showResults(model(2), {
      generation: 2,
      anchor: { x: 20, y: 30, height: 18 },
      sourceSentence: "猫が走る。",
    });
    expect(popup.getSnapshot().historyDepth).toBe(1);

    await popup.command("recursive-back");
    expect(popup.getSnapshot()).toMatchObject({
      historyDepth: 0,
      entryId: "result-cat",
      sourceSentence: "猫が走る。",
    });
  });

  it("does not paint stale generations over a newer result", async () => {
    const { HoshiDictsPopup } = await import(modulePath);
    const dom = popupDom();
    const popup = new HoshiDictsPopup({
      document: dom.window.document,
      window: dom.window,
      getWorkArea: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    });
    popup.showResults(model(4), {
      generation: 4,
      anchor: { x: 20, y: 30, height: 18 },
    });
    const before = dom.window.document.querySelector(
      ".hoshidicts-expression",
    )?.textContent;

    expect(
      popup.showResults(model(3), {
        generation: 3,
        anchor: { x: 100, y: 100, height: 18 },
      }),
    ).toBe(false);
    expect(
      dom.window.document.querySelector(".hoshidicts-expression")?.textContent,
    ).toBe(before);
    expect(popup.getSnapshot().generation).toBe(4);
  });

  it("renders a nonblank accessible popup inside constrained bounds", async () => {
    const { HoshiDictsPopup } = await import(modulePath);
    const dom = popupDom();
    const popup = new HoshiDictsPopup({
      document: dom.window.document,
      window: dom.window,
      getWorkArea: () => ({ x: 0, y: 0, width: 420, height: 320 }),
    });
    popup.showResults(model(), {
      generation: 1,
      anchor: { x: 400, y: 300, height: 16 },
    });

    const root = dom.window.document.querySelector(
      "#hoshidicts-popup-root",
    ) as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.textContent?.trim().length).toBeGreaterThan(10);
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-label")).toBe("Dictionary results");
    expect(Number.parseFloat(root.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(root.style.top)).toBeGreaterThanOrEqual(8);
    expect(root.style.maxWidth).toContain("404px");
    expect(root.style.maxHeight).toContain("304px");
  });
});
