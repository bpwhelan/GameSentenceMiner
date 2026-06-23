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

  it("uses normalized bindings for Yomitan entry navigation buttons saved as labels", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      config: {
        activationMode: string;
        controllerEnabled: boolean;
        nextEntryButton: string;
        prevEntryButton: string;
      };
      buttonStates: Map<string, Record<number, boolean>>;
      buttonBindings: Record<string, any>;
      bindingContainsButton: (binding: any, buttonIndex: number) => boolean;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, buttonIndex: number) => boolean;
      refreshButtonBindings: () => void;
      onButtonDown: (buttonIndex: number, device: string) => void;
      yomitanPopupVisible: boolean;
      isNavigationActive: () => boolean;
      shouldProcessNavigation: () => boolean;
      navigateYomitanNextEntry: () => void;
      navigateYomitanPrevEntry: () => void;
    };

    handler.config = {
      activationMode: "modifier",
      controllerEnabled: true,
      nextEntryButton: "RT",
      prevEntryButton: "LT"
    };
    handler.buttonStates = new Map([["pad-1", { 7: true }]]);
    handler.bindingContainsButton = GamepadHandler.prototype.bindingContainsButton;
    handler.isButtonBindingHeld = GamepadHandler.prototype.isButtonBindingHeld;
    handler.matchesButtonBindingDown = GamepadHandler.prototype.matchesButtonBindingDown;
    handler.refreshButtonBindings = GamepadHandler.prototype.refreshButtonBindings;
    handler.onButtonDown = GamepadHandler.prototype.onButtonDown;
    handler.yomitanPopupVisible = true;
    handler.isNavigationActive = () => false;
    handler.shouldProcessNavigation = () => false;

    const calls: string[] = [];
    handler.navigateYomitanNextEntry = () => {
      calls.push("next");
    };
    handler.navigateYomitanPrevEntry = () => {
      calls.push("prev");
    };

    handler.refreshButtonBindings();

    expect(handler.buttonBindings.nextEntryButton).toMatchObject({
      buttons: [7],
      disabled: false,
      label: "RT"
    });
    expect(handler.buttonBindings.prevEntryButton).toMatchObject({
      buttons: [6],
      disabled: false,
      label: "LT"
    });

    handler.onButtonDown(7, "pad-1");
    handler.buttonStates = new Map([["pad-1", { 6: true }]]);
    handler.onButtonDown(6, "pad-1");

    expect(calls).toEqual(["next", "prev"]);
  });

  it("uses configurable controller bindings for token toggle and mining", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      config: {
        activationMode: string;
        controllerEnabled: boolean;
        confirmButton: string;
        tokenModeToggleButton: string;
        mineButton: string;
      };
      buttonStates: Map<string, Record<number, boolean>>;
      buttonBindings: Record<string, any>;
      bindingContainsButton: (binding: any, buttonIndex: number) => boolean;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, buttonIndex: number) => boolean;
      areButtonBindingsEquivalent: (left: any, right: any) => boolean;
      refreshButtonBindings: () => void;
      onButtonDown: (buttonIndex: number, device: string) => void;
      yomitanPopupVisible: boolean;
      isNavigationActive: () => boolean;
      shouldProcessNavigation: () => boolean;
      confirmSelection: () => void;
      cancelSelection: () => void;
      toggleTokenMode: () => void;
      triggerMining: () => void;
    };

    handler.config = {
      activationMode: "modifier",
      controllerEnabled: true,
      confirmButton: "A",
      tokenModeToggleButton: "Y",
      mineButton: "X"
    };
    handler.buttonStates = new Map([["pad-1", { 3: true }]]);
    handler.bindingContainsButton = GamepadHandler.prototype.bindingContainsButton;
    handler.isButtonBindingHeld = GamepadHandler.prototype.isButtonBindingHeld;
    handler.matchesButtonBindingDown = GamepadHandler.prototype.matchesButtonBindingDown;
    handler.areButtonBindingsEquivalent = GamepadHandler.prototype.areButtonBindingsEquivalent;
    handler.refreshButtonBindings = GamepadHandler.prototype.refreshButtonBindings;
    handler.onButtonDown = GamepadHandler.prototype.onButtonDown;
    handler.yomitanPopupVisible = false;
    handler.isNavigationActive = () => true;
    handler.shouldProcessNavigation = () => false;

    const calls: string[] = [];
    handler.confirmSelection = () => {
      calls.push("confirm");
    };
    handler.cancelSelection = () => {
      calls.push("cancel");
    };
    handler.toggleTokenMode = () => {
      calls.push("token-toggle");
    };
    handler.triggerMining = () => {
      calls.push("mine");
    };

    handler.refreshButtonBindings();

    expect(handler.buttonBindings.tokenModeToggleButton).toMatchObject({
      buttons: [3],
      disabled: false,
      label: "Y"
    });
    expect(handler.buttonBindings.mineButton).toMatchObject({
      buttons: [2],
      disabled: false,
      label: "X"
    });

    handler.onButtonDown(3, "pad-1");
    handler.buttonStates = new Map([["pad-1", { 2: true }]]);
    handler.onButtonDown(2, "pad-1");

    expect(calls).toEqual(["token-toggle", "mine"]);
  });

  it("forwards the mouse click binding through the same IPC channel as curated keys", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      config: {
        activationMode: string;
        controllerEnabled: boolean;
        forwardMouseClickButton: string;
      };
      buttonStates: Map<string, Record<number, boolean>>;
      buttonBindings: Record<string, any>;
      bindingContainsButton: (binding: any, buttonIndex: number) => boolean;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, buttonIndex: number) => boolean;
      refreshButtonBindings: () => void;
      onButtonDown: (buttonIndex: number, device: string) => void;
      getIpcRenderer: () => { send: (...args: any[]) => void } | null;
      forwardMouseClickToTargetWindow: () => void;
    };

    handler.config = {
      activationMode: "modifier",
      controllerEnabled: true,
      forwardMouseClickButton: "Back/Select/View"
    };
    handler.buttonStates = new Map([["pad-1", { 8: true }]]);
    handler.bindingContainsButton = GamepadHandler.prototype.bindingContainsButton;
    handler.isButtonBindingHeld = GamepadHandler.prototype.isButtonBindingHeld;
    handler.matchesButtonBindingDown = GamepadHandler.prototype.matchesButtonBindingDown;
    handler.refreshButtonBindings = GamepadHandler.prototype.refreshButtonBindings;
    handler.onButtonDown = GamepadHandler.prototype.onButtonDown;
    handler.forwardMouseClickToTargetWindow = GamepadHandler.prototype.forwardMouseClickToTargetWindow;

    const calls: Array<[string, ...any[]]> = [];
    handler.getIpcRenderer = () => ({
      send: (...args: any[]) => {
        calls.push(args as [string, ...any[]]);
      }
    });

    handler.refreshButtonBindings();

    expect(handler.buttonBindings.forwardMouseClickButton).toMatchObject({
      buttons: [8],
      disabled: false,
      label: "Back"
    });

    handler.onButtonDown(8, "pad-1");

    expect(calls).toEqual([["gamepad-forward-key", "mouseclick"]]);
  });

  it("preserves confirm behavior when mine and confirm share the default A button", () => {
    const handler = Object.create(GamepadHandler.prototype) as {
      config: {
        activationMode: string;
        controllerEnabled: boolean;
        confirmButton: number;
        mineButton: number;
      };
      buttonStates: Map<string, Record<number, boolean>>;
      buttonBindings: Record<string, any>;
      bindingContainsButton: (binding: any, buttonIndex: number) => boolean;
      isButtonBindingHeld: (binding: any, device: string) => boolean;
      matchesButtonBindingDown: (binding: any, device: string, buttonIndex: number) => boolean;
      areButtonBindingsEquivalent: (left: any, right: any) => boolean;
      refreshButtonBindings: () => void;
      onButtonDown: (buttonIndex: number, device: string) => void;
      yomitanPopupVisible: boolean;
      isNavigationActive: () => boolean;
      shouldProcessNavigation: () => boolean;
      confirmSelection: () => void;
      cancelSelection: () => void;
      toggleTokenMode: () => void;
      triggerMining: () => void;
    };

    handler.config = {
      activationMode: "modifier",
      controllerEnabled: true,
      confirmButton: 0,
      mineButton: 0
    };
    handler.buttonStates = new Map([["pad-1", { 0: true }]]);
    handler.bindingContainsButton = GamepadHandler.prototype.bindingContainsButton;
    handler.isButtonBindingHeld = GamepadHandler.prototype.isButtonBindingHeld;
    handler.matchesButtonBindingDown = GamepadHandler.prototype.matchesButtonBindingDown;
    handler.areButtonBindingsEquivalent = GamepadHandler.prototype.areButtonBindingsEquivalent;
    handler.refreshButtonBindings = GamepadHandler.prototype.refreshButtonBindings;
    handler.onButtonDown = GamepadHandler.prototype.onButtonDown;
    handler.yomitanPopupVisible = false;
    handler.isNavigationActive = () => true;
    handler.shouldProcessNavigation = () => false;

    const calls: string[] = [];
    handler.confirmSelection = () => {
      calls.push("confirm");
    };
    handler.cancelSelection = () => {
      calls.push("cancel");
    };
    handler.toggleTokenMode = () => {
      calls.push("token-toggle");
    };
    handler.triggerMining = () => {
      calls.push("mine");
    };

    handler.refreshButtonBindings();
    handler.onButtonDown(0, "pad-1");

    expect(calls).toEqual(["confirm"]);
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

  it("preserves the current selection when overlay text render completes", () => {
    const calls: string[] = [];
    const snapshot = {
      rect: { left: 20, top: 20, right: 140, bottom: 50, width: 120, height: 30 },
      relativeX: 0.6,
      relativeY: 0.5
    };
    const handler = Object.create(GamepadHandler.prototype) as {
      lastSelectionSnapshot: typeof snapshot | null;
      skipNextTextRefresh: boolean;
      preserveSelectionOnNextTextRefresh: boolean;
      virtualMouse: { movedByAnalog: boolean; lastMoveTime: number };
      currentBlockIndex: number;
      currentCursorIndex: number;
      isNavigationActive: () => boolean;
      updateVirtualMouseCursor: () => void;
      refreshTextBlocks: () => void;
      restoreSelectionFromSnapshot: (snapshot: typeof snapshot) => boolean;
      prefetchTokenizationForAllBlocks: () => void;
      updateVisuals: () => void;
      handleOverlayTextRenderComplete: (options: { snapshot: typeof snapshot; preserveSelection: boolean }) => void;
    };

    handler.lastSelectionSnapshot = null;
    handler.skipNextTextRefresh = false;
    handler.preserveSelectionOnNextTextRefresh = false;
    handler.virtualMouse = { movedByAnalog: true, lastMoveTime: 123 };
    handler.currentBlockIndex = 0;
    handler.currentCursorIndex = 0;
    handler.isNavigationActive = () => true;
    handler.updateVirtualMouseCursor = () => calls.push("virtual");
    handler.refreshTextBlocks = () => calls.push("refresh");
    handler.restoreSelectionFromSnapshot = () => {
      calls.push("restore");
      handler.currentBlockIndex = 1;
      handler.currentCursorIndex = 3;
      return true;
    };
    handler.prefetchTokenizationForAllBlocks = () => calls.push("prefetch");
    handler.updateVisuals = () => calls.push("visuals");

    GamepadHandler.prototype.handleOverlayTextRenderComplete.call(handler, {
      snapshot,
      preserveSelection: true
    });

    expect(handler.lastSelectionSnapshot).toBe(snapshot);
    expect(handler.skipNextTextRefresh).toBe(true);
    expect(handler.preserveSelectionOnNextTextRefresh).toBe(true);
    expect(handler.virtualMouse).toMatchObject({ movedByAnalog: false, lastMoveTime: 0 });
    expect(handler.currentBlockIndex).toBe(1);
    expect(handler.currentCursorIndex).toBe(3);
    expect(calls).toEqual(["virtual", "refresh", "restore", "prefetch", "visuals"]);
  });

  it("clamps virtual mouse points to the only selectable block", () => {
    const block = { isConnected: true };
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: Array<typeof block>;
      currentBlockIndex: number;
      blockHasSelectableCharacters: () => boolean;
      getBlockBoundingRect: () => {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };
      constrainVirtualMousePointToBlocks: (x: number, y: number) => {
        x: number;
        y: number;
        block: typeof block | null;
        blockIndex: number;
        constrained: boolean;
      };
    };

    handler.textBlocks = [block];
    handler.currentBlockIndex = 0;
    handler.blockHasSelectableCharacters = () => true;
    handler.getBlockBoundingRect = () => ({
      left: 100,
      top: 50,
      right: 220,
      bottom: 110,
      width: 120,
      height: 60
    });

    const clamped = handler.constrainVirtualMousePointToBlocks(500, 10);
    expect(clamped).toMatchObject({ x: 220, y: 50, blockIndex: 0, constrained: true });
    expect(clamped.block).toBe(block);

    const inside = handler.constrainVirtualMousePointToBlocks(160, 75);
    expect(inside).toMatchObject({ x: 160, y: 75, blockIndex: 0, constrained: false });
    expect(inside.block).toBe(block);
  });

  it("snaps virtual mouse points to the nearest selectable block", () => {
    const blocks = [{ isConnected: true }, { isConnected: true }];
    const rects = new Map([
      [blocks[0], { left: 0, top: 0, right: 100, bottom: 60, width: 100, height: 60 }],
      [blocks[1], { left: 220, top: 0, right: 320, bottom: 60, width: 100, height: 60 }]
    ]);
    const handler = Object.create(GamepadHandler.prototype) as {
      textBlocks: typeof blocks;
      currentBlockIndex: number;
      blockHasSelectableCharacters: () => boolean;
      getBlockBoundingRect: (block: (typeof blocks)[number]) => {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };
      constrainVirtualMousePointToBlocks: (x: number, y: number) => {
        x: number;
        y: number;
        block: (typeof blocks)[number] | null;
        blockIndex: number;
        constrained: boolean;
      };
    };

    handler.textBlocks = blocks;
    handler.currentBlockIndex = 0;
    handler.blockHasSelectableCharacters = () => true;
    handler.getBlockBoundingRect = (block) => rects.get(block)!;

    const clampedToSecond = handler.constrainVirtualMousePointToBlocks(170, 30);
    expect(clampedToSecond).toMatchObject({ x: 220, y: 30, blockIndex: 1, constrained: true });
    expect(clampedToSecond.block).toBe(blocks[1]);

    const clampedToFirst = handler.constrainVirtualMousePointToBlocks(-30, 30);
    expect(clampedToFirst).toMatchObject({ x: 0, y: 30, blockIndex: 0, constrained: true });
    expect(clampedToFirst.block).toBe(blocks[0]);
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
