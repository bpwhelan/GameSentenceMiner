import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

function loadLegacyGamepadHandler() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/gamepad.js"),
    "utf8"
  );

  const module = { exports: {} as any };
  const context = {
    module,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {
      querySelectorAll: () => [],
      querySelector: () => null
    },
    window: {},
    CustomEvent: class CustomEvent {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
  };

  vm.runInNewContext(source, context, {
    filename: "GSM_Overlay/gamepad.js"
  });

  return {
    GamepadHandler: module.exports,
    context
  };
}

const legacyGamepad = loadLegacyGamepadHandler();
const GamepadHandler = legacyGamepad.GamepadHandler;
const legacyGamepadContext = legacyGamepad.context;

describe("legacy gamepad button bindings", () => {
  it("normalizes legacy numeric buttons and human-readable combos", () => {
    expect(GamepadHandler.normalizeButtonBindingValue(8)).toMatchObject({
      buttons: [8],
      disabled: false,
      label: "Back"
    });

    expect(GamepadHandler.normalizeButtonBindingValue("LB + A")).toMatchObject({
      buttons: [4, 0],
      disabled: false,
      label: "LB + A"
    });

    expect(
      GamepadHandler.normalizeButtonBindingValue("Back/Select/View")
    ).toMatchObject({
      buttons: [8],
      disabled: false,
      label: "Back"
    });
  });

  it("keeps explicit disabled bindings while falling back from invalid ones", () => {
    expect(GamepadHandler.normalizeButtonBindingValue("Disabled", 4)).toMatchObject({
      buttons: [],
      disabled: true,
      label: "Disabled"
    });

    expect(
      GamepadHandler.normalizeButtonBindingValue("not-a-real-button", 4)
    ).toMatchObject({
      buttons: [4],
      disabled: false,
      label: "LB"
    });
  });

  it("matches held combos regardless of which combo button fired last", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      buttonStates: Map<string, Record<number, boolean>>;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, button: number) => boolean;
    };

    handler.buttonStates = new Map([["pad-1", { 0: true, 4: true }]]);

    const comboBinding = GamepadHandler.normalizeButtonBindingValue("LB + A");

    expect(handler.isButtonBindingHeld(comboBinding, "pad-1")).toBe(true);
    expect(handler.matchesButtonBindingDown(comboBinding, "pad-1", 0)).toBe(true);
    expect(handler.matchesButtonBindingDown(comboBinding, "pad-1", 4)).toBe(true);
    expect(handler.matchesButtonBindingDown(comboBinding, "pad-1", 5)).toBe(false);

    handler.buttonStates = new Map([["pad-1", { 4: true }]]);
    expect(handler.isButtonBindingHeld(comboBinding, "pad-1")).toBe(false);
  });
});

describe("legacy gamepad start block selection", () => {
  function createStartSelectionHandler(blocks: Array<{ area: number; text: string }>) {
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: Array<{ __area: number; textContent: string }>;
      blockHasSelectableCharacters: (block: { textContent: string }) => boolean;
      getBlockBoundingRect: (block: { __area: number }) => { width: number; height: number };
      getBlockSelectionMetrics: (block: { __area: number; textContent: string }) => { area: number; textLength: number };
      findFirstSelectableBlockIndex: () => number;
    };

    handler.textBlocks = blocks.map((block) => ({
      __area: block.area,
      textContent: block.text
    }));
    handler.blockHasSelectableCharacters = (block) => block.textContent.trim().length > 0;
    handler.getBlockBoundingRect = (block) => ({ width: block.__area, height: 1 });

    return handler;
  }

  it("prefers the dominant large block when one block is much larger than the rest", () => {
    const handler = createStartSelectionHandler([
      { area: 12, text: "small 1" },
      { area: 90, text: "big block" },
      { area: 15, text: "small 2" },
      { area: 10, text: "small 3" }
    ]);

    expect(handler.findFirstSelectableBlockIndex()).toBe(1);
  });

  it("keeps the first selectable block when sizes are similar", () => {
    const handler = createStartSelectionHandler([
      { area: 30, text: "first" },
      { area: 40, text: "second" },
      { area: 35, text: "third" }
    ]);

    expect(handler.findFirstSelectableBlockIndex()).toBe(0);
  });
});

describe("legacy gamepad block redraw recovery", () => {
  it("prefers a nearby prior block over the dominant large block after redraw", () => {
    const blocks = [
      {
        textContent: "big block",
        isConnected: true,
        querySelectorAll: () => [{ textContent: "big", dataset: {}, getClientRects: () => [1] }]
      },
      {
        textContent: "nearby old block",
        isConnected: true,
        querySelectorAll: () => [{ textContent: "near", dataset: {}, getClientRects: () => [1] }]
      },
      {
        textContent: "small block",
        isConnected: true,
        querySelectorAll: () => [{ textContent: "small", dataset: {}, getClientRects: () => [1] }]
      }
    ];

    legacyGamepadContext.document.querySelectorAll = (selector: string) =>
      selector === ".text-block-container" ? blocks : [];

    const handler = Object.create(GamepadHandler.prototype) as {
      lastSelectionSnapshot: {
        rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
        relativeX: number;
        relativeY: number;
      };
      textBlocks: typeof blocks;
      tokenCacheByBlock: Map<number, unknown>;
      pendingTokenizationByBlock: Map<number, unknown>;
      currentBlockIndex: number;
      currentCursorIndex: number;
      currentLineIndex: number;
      lineNavPrefersCharacters: boolean;
      characters: Array<unknown>;
      lines: Array<unknown>;
      tokens: Array<unknown>;
      tokensBlockIndex: number;
      isElementVisible: (block: unknown) => boolean;
      isTextBoxSelectable: (box: { textContent?: string }) => boolean;
      getBlockBoundingRect: (block: (typeof blocks)[number]) => {
        left: number;
        top: number;
        width: number;
        height: number;
      };
      getBlockSelectionMetrics: (block: (typeof blocks)[number]) => { area: number; textLength: number };
      refreshCharacters: () => void;
      findFirstSelectableBlockIndex: () => number;
      findNearbySelectableBlockIndex: (snapshot?: unknown) => number;
      restoreCursorFromSelectionSnapshot: (snapshot?: unknown) => number;
      getLineIndexForCursor: () => number;
      rememberCurrentSelectionSnapshot: () => unknown;
      refreshTextBlocks: () => void;
    };

    const rects = new Map([
      [blocks[0], { left: 300, top: 20, width: 400, height: 220 }],
      [blocks[1], { left: 18, top: 16, width: 120, height: 30 }],
      [blocks[2], { left: 25, top: 200, width: 120, height: 30 }]
    ]);

    handler.lastSelectionSnapshot = {
      rect: { left: 20, top: 20, right: 140, bottom: 50, width: 120, height: 30 },
      relativeX: 0.5,
      relativeY: 0.5
    };
    handler.textBlocks = [];
    handler.tokenCacheByBlock = new Map();
    handler.pendingTokenizationByBlock = new Map();
    handler.currentBlockIndex = 7;
    handler.currentCursorIndex = 0;
    handler.currentLineIndex = 0;
    handler.lineNavPrefersCharacters = false;
    handler.characters = [];
    handler.lines = [];
    handler.tokens = [];
    handler.tokensBlockIndex = -1;
    handler.isElementVisible = () => true;
    handler.isTextBoxSelectable = (box) => Boolean(box.textContent?.trim());
    handler.getBlockBoundingRect = (block) => rects.get(block)!;
    handler.refreshCharacters = function refreshCharacters() {
      this.characters = [{ isConnected: true }, { isConnected: true }, { isConnected: true }];
    };
    handler.getLineIndexForCursor = () => 0;
    handler.rememberCurrentSelectionSnapshot = () => null;
    handler.findFirstSelectableBlockIndex = GamepadHandler.prototype.findFirstSelectableBlockIndex;
    handler.findNearbySelectableBlockIndex = GamepadHandler.prototype.findNearbySelectableBlockIndex;
    handler.restoreCursorFromSelectionSnapshot = () => 2;

    handler.refreshTextBlocks();

    expect(handler.currentBlockIndex).toBe(1);
    expect(handler.currentCursorIndex).toBe(2);
  });

  it("restores the nearest navigable unit to the prior relative position", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: Array<{ isConnected: boolean }>;
      currentBlockIndex: number;
      findFirstNavigableUnitIndex: (direction?: number) => number;
      getBlockBoundingRect: () => { left: number; top: number; width: number; height: number };
      getNavigableUnitIndices: () => number[];
      getNavigationUnitCount: () => number;
      getNavigationUnitCenter: (index: number) => { x: number; y: number } | null;
      findClosestNavigableUnitToPoint: (x: number, y: number) => number | null;
      restoreCursorFromSelectionSnapshot: (snapshot: {
        rect: { width: number; height: number };
        relativeX: number;
        relativeY: number;
      }) => number;
    };

    handler.textBlocks = [{ isConnected: true }];
    handler.currentBlockIndex = 0;
    handler.findFirstNavigableUnitIndex = () => 0;
    handler.getBlockBoundingRect = () => ({ left: 100, top: 200, width: 200, height: 100 });
    handler.getNavigableUnitIndices = () => [0, 1, 2];
    handler.getNavigationUnitCount = () => 3;
    handler.getNavigationUnitCenter = (index) => (
      [
        { x: 120, y: 220 },
        { x: 210, y: 250 },
        { x: 280, y: 280 }
      ][index] ?? null
    );
    handler.findClosestNavigableUnitToPoint = GamepadHandler.prototype.findClosestNavigableUnitToPoint;

    const restoredIndex = GamepadHandler.prototype.restoreCursorFromSelectionSnapshot.call(handler, {
      rect: { width: 100, height: 50 },
      relativeX: 0.55,
      relativeY: 0.52
    });

    expect(restoredIndex).toBe(1);
  });
});

describe("legacy gamepad popup routing", () => {
  it("routes popup action controls only to the topmost visible popup frame", () => {
    const hostMessages: unknown[] = [];
    const parentMessages: unknown[] = [];
    const hiddenChildMessages: unknown[] = [];
    const visibleChildMessages: unknown[] = [];

    legacyGamepadContext.window.postMessage = (message: unknown) => {
      hostMessages.push(message);
    };

    const parentFrame = {
      style: { display: "block", visibility: "visible" },
      getClientRects: () => [1],
      contentWindow: {
        postMessage: (message: unknown) => {
          parentMessages.push(message);
        }
      }
    };
    const hiddenChildFrame = {
      style: { display: "block", visibility: "hidden" },
      getClientRects: () => [],
      contentWindow: {
        postMessage: (message: unknown) => {
          hiddenChildMessages.push(message);
        }
      }
    };
    const visibleChildFrame = {
      style: { display: "block", visibility: "visible" },
      getClientRects: () => [1],
      contentWindow: {
        postMessage: (message: unknown) => {
          visibleChildMessages.push(message);
        }
      }
    };

    legacyGamepadContext.document.querySelectorAll = (selector: string) =>
      selector === "iframe.yomitan-popup"
        ? [parentFrame, hiddenChildFrame, visibleChildFrame]
        : [];
    legacyGamepadContext.document.querySelector = () => null;

    const handler = Object.create(GamepadHandler.prototype) as {
      sendYomitanControlMessage: (action: string, params?: Record<string, unknown>) => void;
    };

    handler.sendYomitanControlMessage("reset-action-selection");

    expect(hostMessages).toEqual([
      {
        type: "gsm-yomitan-control",
        action: "reset-action-selection"
      }
    ]);
    expect(parentMessages).toEqual([]);
    expect(hiddenChildMessages).toEqual([]);
    expect(visibleChildMessages).toEqual([
      {
        type: "gsm-yomitan-control",
        action: "reset-action-selection"
      }
    ]);
  });
});
