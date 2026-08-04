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

function loadStartupGamepadSettings(settings: Record<string, unknown>) {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "GSM_Overlay/index.html"),
    "utf8"
  );
  const start = source.indexOf("    // Load gamepad settings");
  const end = source.indexOf("    // Apply hide furigana on startup", start);
  if (start < 0 || end < 0) {
    throw new Error("Unable to find startup gamepad settings in GSM_Overlay/index.html");
  }

  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(
    [
      `const newsettings = ${JSON.stringify(settings)};`,
      "const gamepadSettings = { enabled: true };",
      "const KEYBOARD_SETTING_KEYS = [];",
      source.slice(start, end),
      "module.exports = gamepadSettings;"
    ].join("\n"),
    { module },
    { filename: "GSM_Overlay/index.html#startup-gamepad-settings" }
  );

  return module.exports;
}

const legacyGamepad = loadLegacyGamepadHandler();
const GamepadHandler = legacyGamepad.GamepadHandler;
const legacyGamepadContext = legacyGamepad.context;

describe("legacy gamepad startup settings", () => {
  it("honors a disabled master gamepad setting before initialization", () => {
    expect(loadStartupGamepadSettings({ gamepadEnabled: false })).toMatchObject({
      enabled: false
    });
  });
});

describe("legacy gamepad Sudachi requests", () => {
  it("includes the configured dictionary in tokenization requests", () => {
    const sent: unknown[] = [];
    const handler = Object.create(GamepadHandler.prototype) as {
      config: { sudachiDictionary: string };
      wsConnected: boolean;
      ws: { send: (payload: string) => void };
      sudachiAvailable: boolean;
      mecabAvailable: boolean;
    };
    handler.config = { sudachiDictionary: "small" };
    handler.wsConnected = true;
    handler.ws = { send: (payload) => sent.push(JSON.parse(payload)) };
    handler.sudachiAvailable = true;
    handler.mecabAvailable = false;

    GamepadHandler.prototype.requestTokenizationFromServer.call(
      handler,
      2,
      "食べた。",
      "sudachi"
    );

    expect(sent).toEqual([
      {
        type: "tokenize",
        blockIndex: 2,
        text: "食べた。",
        backend: "sudachi",
        dictionary: "small"
      }
    ]);
  });
});

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

  it("uses normalized bindings for dictionary entry navigation buttons saved as labels", () => {
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
      dictionaryPopupVisible: boolean;
      isNavigationActive: () => boolean;
      shouldProcessNavigation: () => boolean;
      navigateDictionaryNextEntry: () => void;
      navigateDictionaryPreviousEntry: () => void;
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
    handler.dictionaryPopupVisible = true;
    handler.isNavigationActive = () => false;
    handler.shouldProcessNavigation = () => false;

    const calls: string[] = [];
    handler.navigateDictionaryNextEntry = () => {
      calls.push("next");
    };
    handler.navigateDictionaryPreviousEntry = () => {
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

  it("allows virtual mouse points to move freely between selectable blocks", () => {
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

    const betweenBlocks = handler.constrainVirtualMousePointToBlocks(170, 30);
    expect(betweenBlocks).toMatchObject({ x: 170, y: 30, blockIndex: -1, constrained: false });
    expect(betweenBlocks.block).toBeNull();

    const outsideBlocks = handler.constrainVirtualMousePointToBlocks(-30, 30);
    expect(outsideBlocks).toMatchObject({ x: -30, y: 30, blockIndex: -1, constrained: false });
    expect(outsideBlocks.block).toBeNull();

    const insideSecond = handler.constrainVirtualMousePointToBlocks(250, 30);
    expect(insideSecond).toMatchObject({ x: 250, y: 30, blockIndex: 1, constrained: false });
    expect(insideSecond.block).toBe(blocks[1]);
  });
});

describe("backend-neutral gamepad popup routing", () => {
  it("routes lookup and popup commands exclusively through the generic controller", () => {
    const controllerCalls: unknown[] = [];
    const legacyMessages: unknown[] = [];
    legacyGamepadContext.window.postMessage = (message: unknown) => {
      legacyMessages.push(message);
    };
    legacyGamepadContext.window.gsmDictionaryPopupController = {
      lookup(intent: unknown) {
        controllerCalls.push({ type: "lookup", intent });
        return Promise.resolve({ status: "applied" });
      },
      dismiss(reason: string) {
        controllerCalls.push({ type: "dismiss", reason });
        return Promise.resolve({ status: "handled" });
      },
      command(command: string, params: unknown) {
        controllerCalls.push({ type: "command", command, params });
        return Promise.resolve({ status: "handled" });
      }
    };

    const handler = Object.create(GamepadHandler.prototype) as {
      sendDictionaryControlCommand: (
        action: string,
        params?: Record<string, unknown>,
      ) => void;
    };

    handler.sendDictionaryControlCommand("lookup", {
      text: "猫",
      sourceSentence: "猫が走る。",
      anchor: { x: 9, y: 19, width: 2, height: 2 },
      pointer: { x: 10, y: 20 },
      anchorKey: "2:4",
      source: "gamepad",
    });
    handler.sendYomitanControlMessage("scroll", { direction: -1 });
    handler.sendYomitanControlMessage("hide-popup");

    expect(controllerCalls).toEqual([
      {
        type: "lookup",
        intent: {
          text: "猫",
          sourceSentence: "猫が走る。",
          anchor: { x: 9, y: 19, width: 2, height: 2 },
          pointer: { x: 10, y: 20 },
          anchorKey: "2:4",
          source: "gamepad",
        },
      },
      {
        type: "command",
        command: "scroll",
        params: { direction: -1 },
      },
      {
        type: "dismiss",
        reason: "gamepad-dismiss",
      },
    ]);
    expect(legacyMessages).toEqual([]);

    delete legacyGamepadContext.window.gsmDictionaryPopupController;
  });

  it("never bypasses the generic controller when it is unavailable", async () => {
    const hostMessages: unknown[] = [];
    const parentMessages: unknown[] = [];
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
        ? [parentFrame, visibleChildFrame]
        : [];
    legacyGamepadContext.document.querySelector = () => null;

    const handler = Object.create(GamepadHandler.prototype) as {
      sendDictionaryControlCommand: (
        action: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
    };

    await expect(
      handler.sendDictionaryControlCommand("reset-action-selection"),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(hostMessages).toEqual([]);
    expect(parentMessages).toEqual([]);
    expect(visibleChildMessages).toEqual([]);
  });

  it("tracks nested popup IDs and invalidates mining only after the final close", () => {
    const actions: string[] = [];
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.yomitanPopupCount = 0;
    handler.yomitanPopupIds = new Set();
    handler.yomitanPopupVisible = false;
    handler.popupActionSelectionActive = false;
    handler.pendingMineCandidate = { anchorKey: "0:0" };
    handler.lastLookupAnchorKey = "0:0";
    handler.thumbstickLatch = new Map();
    handler.dictionarySupports = () => true;
    handler.sendDictionaryControlCommand = (action: string) => {
      actions.push(action);
      return Promise.resolve({ status: "handled" });
    };
    handler.setThumbstickLatch = GamepadHandler.prototype.setThumbstickLatch;
    handler.clearPendingMineCandidate = GamepadHandler.prototype.clearPendingMineCandidate;
    handler.resetYomitanPopupActionSelection =
      GamepadHandler.prototype.resetYomitanPopupActionSelection;

    GamepadHandler.prototype.onYomitanPopupShown.call(handler, {
      detail: { popupId: "parent" }
    });
    GamepadHandler.prototype.onYomitanPopupShown.call(handler, {
      detail: { popupId: "parent" }
    });
    GamepadHandler.prototype.onYomitanPopupShown.call(handler, {
      detail: { popupId: "child" }
    });

    expect(handler.yomitanPopupCount).toBe(2);
    expect(handler.yomitanPopupVisible).toBe(true);
    expect(actions).toEqual(["reset-action-selection", "reset-action-selection"]);

    GamepadHandler.prototype.onYomitanPopupHidden.call(handler, {
      detail: { popupId: "child" }
    });
    expect(handler.yomitanPopupVisible).toBe(true);
    expect(handler.pendingMineCandidate).not.toBeNull();

    GamepadHandler.prototype.onYomitanPopupHidden.call(handler, {
      detail: { popupId: "parent" }
    });
    expect(handler.yomitanPopupCount).toBe(0);
    expect(handler.yomitanPopupVisible).toBe(false);
    expect(handler.pendingMineCandidate).toBeNull();
    expect(handler.lastLookupAnchorKey).toBeNull();
    expect(actions.at(-1)).toBe("clear-action-selection");
  });

  it("tracks backend-neutral Hoshi popup events and final-close cleanup", () => {
    const actions: string[] = [];
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.dictionaryPopupCount = 0;
    handler.dictionaryPopupVisible = false;
    handler.dictionaryPopupBackendId = null;
    handler.dictionaryPopupGeneration = 0;
    handler.popupActionSelectionActive = false;
    handler.pendingMineCandidate = { anchorKey: "0:0" };
    handler.lastLookupAnchorKey = "0:0";
    handler.thumbstickLatch = new Map();
    handler.dictionarySupports = () => true;
    handler.sendDictionaryControlCommand = (action: string) => {
      actions.push(action);
      return Promise.resolve({ status: "handled" });
    };
    handler.setThumbstickLatch = GamepadHandler.prototype.setThumbstickLatch;
    handler.clearPendingMineCandidate =
      GamepadHandler.prototype.clearPendingMineCandidate;
    handler.resetYomitanPopupActionSelection =
      GamepadHandler.prototype.resetYomitanPopupActionSelection;

    GamepadHandler.prototype.onDictionaryPopupShown.call(handler, {
      detail: {
        backendId: "hoshidicts",
        generation: 9,
        popupCount: 2,
      },
    });

    expect(handler.dictionaryPopupCount).toBe(2);
    expect(handler.dictionaryPopupVisible).toBe(true);
    expect(handler.dictionaryPopupBackendId).toBe("hoshidicts");
    expect(handler.dictionaryPopupGeneration).toBe(9);

    GamepadHandler.prototype.onDictionaryPopupShown.call(handler, {
      detail: {
        backendId: "hoshidicts",
        generation: 9,
        popupCount: 1,
        reason: "nested-popup-closed",
      },
    });
    expect(handler.dictionaryPopupVisible).toBe(true);
    expect(handler.pendingMineCandidate).not.toBeNull();

    GamepadHandler.prototype.onDictionaryPopupHidden.call(handler, {
      detail: {
        backendId: "hoshidicts",
        generation: 9,
        popupCount: 0,
      },
    });

    expect(handler.dictionaryPopupCount).toBe(0);
    expect(handler.dictionaryPopupVisible).toBe(false);
    expect(handler.dictionaryPopupBackendId).toBeNull();
    expect(handler.pendingMineCandidate).toBeNull();
    expect(handler.lastLookupAnchorKey).toBeNull();
    expect(actions.at(-1)).toBe("clear-action-selection");
  });

  it("invalidates armed mining and action state during a backend transition", () => {
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.pendingMineCandidate = {
      anchorKey: "19:line-42:2",
      backendId: "hoshidicts",
      generation: 9,
    };
    handler.dictionaryPopupBackendId = "hoshidicts";
    handler.popupActionSelectionActive = true;
    handler.popupActionSelectionExplicit = true;
    handler.thumbstickLatch = new Map([["right_x", true]]);
    handler.dictionaryAxisTransitionBlocks = new Set();
    handler.lastDictionaryStatusBackendId = "hoshidicts";
    handler.lastDictionaryStatusGeneration = 9;
    handler.clearPendingMineCandidate =
      GamepadHandler.prototype.clearPendingMineCandidate;
    handler.setThumbstickLatch = GamepadHandler.prototype.setThumbstickLatch;

    GamepadHandler.prototype.onDictionaryBackendStatus.call(handler, {
      detail: {
        state: "switching",
        backendId: "yomitan",
        controller: {
          backendId: "yomitan",
          generation: 10,
        },
      },
    });

    expect(handler.pendingMineCandidate).toBeNull();
    expect(handler.popupActionSelectionActive).toBe(false);
    expect(handler.popupActionSelectionExplicit).toBe(false);
    expect(Array.from(handler.dictionaryAxisTransitionBlocks).sort()).toEqual([
      "right_x",
      "right_y",
    ]);
    expect(handler.thumbstickLatch.get("right_x")).toBe(true);
  });

  it("requires a neutral right stick before commands resume after a transition", () => {
    const actions: string[] = [];
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.dictionaryPopupVisible = true;
    handler.dictionaryAxisTransitionBlocks = new Set(["right_x"]);
    handler.thumbstickLatch = new Map([["right_x", true]]);
    handler.popupActionSelectionActive = true;
    handler.popupActionSelectionExplicit = false;
    handler.dictionarySupports = () => true;
    handler.sendDictionaryControlCommand = (command: string) => {
      actions.push(command);
      return Promise.resolve({ status: "handled" });
    };
    handler.getThumbstickLatch = GamepadHandler.prototype.getThumbstickLatch;
    handler.setThumbstickLatch = GamepadHandler.prototype.setThumbstickLatch;
    handler.consumeDictionaryAxisTransitionBlock =
      GamepadHandler.prototype.consumeDictionaryAxisTransitionBlock;

    GamepadHandler.prototype.processRightStickHorizontalForPopup.call(
      handler,
      1,
      0.2,
    );
    GamepadHandler.prototype.processRightStickHorizontalForPopup.call(
      handler,
      0,
      0.2,
    );
    GamepadHandler.prototype.processRightStickHorizontalForPopup.call(
      handler,
      1,
      0.2,
    );

    expect(actions).toEqual(["select-action"]);
  });

  it("requires an unchanged target, backend, and generation before second-confirm mining", () => {
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.currentBlockIndex = 2;
    handler.currentCursorIndex = 4;
    handler.dictionaryPopupVisible = true;
    handler.dictionaryPopupBackendId = "hoshidicts";
    handler.dictionaryPopupGeneration = 9;
    handler.pendingMineCandidate = null;

    GamepadHandler.prototype.setPendingMineCandidate.call(handler, {
      anchorKey: "2:4",
      backendId: "hoshidicts",
      generation: 9,
    });

    expect(
      GamepadHandler.prototype.canMineFromCurrentConfirm.call(handler, {
        anchorKey: "2:4"
      })
    ).toBe(true);

    handler.currentCursorIndex = 5;
    expect(
      GamepadHandler.prototype.canMineFromCurrentConfirm.call(handler, {
        anchorKey: "2:4"
      })
    ).toBe(false);

    handler.currentCursorIndex = 4;
    handler.dictionaryPopupGeneration = 10;
    expect(
      GamepadHandler.prototype.canMineFromCurrentConfirm.call(handler, {
        anchorKey: "2:4"
      })
    ).toBe(false);

    handler.dictionaryPopupGeneration = 9;
    handler.dictionaryPopupBackendId = "yomitan";
    expect(
      GamepadHandler.prototype.canMineFromCurrentConfirm.call(handler, {
        anchorKey: "2:4"
      })
    ).toBe(false);
  });

  it("performs lookup on first confirm and mines on the second matching confirm", () => {
    const intents: Array<Record<string, unknown>> = [];
    let mined = 0;
    const targetChar = { textContent: "食" };
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.config = {};
    handler.currentBlockIndex = 1;
    handler.currentCursorIndex = 3;
    handler.dictionaryPopupVisible = false;
    handler.dictionaryPopupBackendId = "hoshidicts";
    handler.dictionaryPopupGeneration = 12;
    handler.pendingMineCandidate = null;
    handler.confirmDictionaryPopupActionSelection = () => false;
    handler.getLookupInfoForConfirm = () => ({
      targetChar,
      centerX: 10,
      centerY: 20,
      label: "character",
      anchorKey: "1:3"
    });
    handler.canMineFromCurrentConfirm =
      GamepadHandler.prototype.canMineFromCurrentConfirm;
    handler.setPendingMineCandidate =
      GamepadHandler.prototype.setPendingMineCandidate;
    handler.clearPendingMineCandidate =
      GamepadHandler.prototype.clearPendingMineCandidate;
    handler.buildDictionaryLookupIntent = () => ({
      text: "食べる",
      sourceSentence: "食べる",
      offset: 0,
      anchor: { x: 9, y: 19, width: 2, height: 2 },
      pointer: { x: 10, y: 20 },
      anchorKey: "1:3",
      source: "gamepad",
    });
    handler.lookupDictionaryAtSelection = () => {
      intents.push({ text: "食べる", anchorKey: "1:3" });
      return {
        backendId: "hoshidicts",
        generation: 12,
        anchorKey: "1:3",
      };
    };
    handler.triggerMining = () => {
      mined += 1;
    };

    GamepadHandler.prototype.confirmSelection.call(handler);

    expect(intents).toEqual([{ text: "食べる", anchorKey: "1:3" }]);
    expect(handler.pendingMineCandidate).toEqual({
      anchorKey: "1:3",
      blockIndex: 1,
      cursorIndex: 3,
      backendId: "hoshidicts",
      generation: 12,
    });

    handler.dictionaryPopupVisible = true;
    GamepadHandler.prototype.confirmSelection.call(handler);

    expect(mined).toBe(1);
    expect(handler.pendingMineCandidate).toBeNull();
    expect(intents).toHaveLength(1);
  });

  it("routes semantic scroll, action, entry, and dismiss controls through the generic controller", () => {
    const actions: Array<{ action: string; params?: Record<string, unknown> }> = [];
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.dictionaryPopupVisible = true;
    handler.popupActionSelectionActive = true;
    handler.popupActionSelectionExplicit = true;
    handler.thumbstickLatch = new Map();
    handler.lastPopupScrollTime = 0;
    handler.config = { repeatRate: 0 };
    handler.pendingMineCandidate = { anchorKey: "0:0" };
    handler.sendDictionaryControlCommand = (
      action: string,
      params?: Record<string, unknown>,
    ) => {
      actions.push({ action, params });
      return Promise.resolve({ status: "handled" });
    };
    handler.dictionarySupports = () => true;
    handler.getThumbstickLatch = GamepadHandler.prototype.getThumbstickLatch;
    handler.setThumbstickLatch = GamepadHandler.prototype.setThumbstickLatch;
    handler.clearPendingMineCandidate = GamepadHandler.prototype.clearPendingMineCandidate;
    handler.resetDictionaryPopupActionSelection =
      GamepadHandler.prototype.resetDictionaryPopupActionSelection;

    GamepadHandler.prototype.processRightStickVerticalForPopup.call(handler, 1, 0.2);
    GamepadHandler.prototype.processRightStickHorizontalForPopup.call(handler, 1, 0.2);
    GamepadHandler.prototype.confirmDictionaryPopupActionSelection.call(handler);
    GamepadHandler.prototype.navigateDictionaryNextEntry.call(handler);
    GamepadHandler.prototype.navigateDictionaryPreviousEntry.call(handler);
    GamepadHandler.prototype.dismissDictionaryPopup.call(handler);

    expect(actions).toEqual([
      { action: "scroll", params: { direction: "down", amount: 110 } },
      { action: "select-action", params: { direction: "next" } },
      { action: "confirm-action", params: undefined },
      { action: "next-entry", params: undefined },
      { action: "previous-entry", params: undefined },
      { action: "dismiss", params: { reason: "gamepad-dismiss" } },
    ]);
    expect(handler.pendingMineCandidate).toBeNull();
  });

  it("routes mining through controller capabilities and reports unsupported backends", async () => {
    const hostMessages: unknown[] = [];
    const frameMessages: unknown[] = [];
    const feedback: string[] = [];
    const commands: unknown[] = [];
    legacyGamepadContext.window.postMessage = (message: unknown) => {
      hostMessages.push(message);
    };
    legacyGamepadContext.document.querySelector = () => ({
      contentWindow: {
        postMessage: (message: unknown) => frameMessages.push(message)
      }
    });
    legacyGamepadContext.window.gsmDictionaryPopupController = {
      getSnapshot: () => ({
        active: true,
        backendId: "hoshidicts",
        generation: 4,
        capabilities: ["lookup", "dismiss"],
      }),
      command: (command: string, params: unknown) => {
        commands.push({ command, params });
        return Promise.resolve({ status: "handled" });
      },
    };

    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.showDictionaryActionFeedback = (message: string) => feedback.push(message);

    await GamepadHandler.prototype.triggerMining.call(handler);

    expect(commands).toEqual([]);
    expect(feedback).toContain("Mining is unavailable for this dictionary backend");
    expect(hostMessages).toEqual([]);
    expect(frameMessages).toEqual([]);

    legacyGamepadContext.window.gsmDictionaryPopupController.getSnapshot = () => ({
      active: true,
      backendId: "yomitan",
      generation: 5,
      capabilities: ["mine"],
    });
    await GamepadHandler.prototype.triggerMining.call(handler);
    expect(commands).toEqual([
      {
        command: "mine",
        params: {
          expectedBackendId: "yomitan",
          expectedGeneration: 5,
        },
      },
    ]);
    expect(feedback).toContain("Dictionary entry mined");
    expect(hostMessages).toEqual([]);
    expect(frameMessages).toEqual([]);

    delete legacyGamepadContext.window.gsmDictionaryPopupController;
  });

  it("builds a Hoshi lookup intent from line metadata and rendered text", () => {
    const makeBox = (
      text: string,
      left: number,
      dataset: Record<string, string>,
    ) => ({
      textContent: text,
      dataset,
      isConnected: true,
      getBoundingClientRect: () => ({
        left,
        top: 20,
        width: 10,
        height: 18,
        right: left + 10,
        bottom: 38,
      }),
    });
    const shared = {
      lineIndex: "7",
      lineId: "line-42",
      renderGeneration: "19",
      sourceSentence: "猫が走る。",
    };
    const boxes = [
      makeBox("猫", 10, shared),
      makeBox("が", 20, shared),
      makeBox("走る", 30, shared),
      makeBox("。", 40, shared),
    ];
    const block = {
      querySelectorAll: () => boxes,
    };
    for (const box of boxes) {
      (box as any).closest = (selector: string) =>
        selector === ".text-block-container" ? block : null;
    }

    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.characters = boxes;
    handler.currentBlockIndex = 2;
    handler.currentCursorIndex = 2;
    handler.lineNavPrefersCharacters = false;
    handler.tokenMode = false;
    handler.tokens = [];
    handler.isUsingTokenNavigation = () => false;

    expect(
      GamepadHandler.prototype.buildDictionaryLookupIntent.call(handler, {
        targetChar: boxes[2],
        targetIndex: 2,
        centerX: 35,
        centerY: 29,
        anchorKey: "2:2",
      }),
    ).toEqual({
      text: "走る。",
      sourceSentence: "猫が走る。",
      lineId: "line-42",
      offset: 2,
      anchor: { x: 30, y: 20, width: 10, height: 18 },
      pointer: { x: 35, y: 29 },
      anchorKey: "19:line-42:2",
      source: "gamepad",
    });
  });

  it("uses recursive back on cancel before dismissing a Hoshi popup", async () => {
    const actions: string[] = [];
    let cancelled = 0;
    const handler = Object.create(GamepadHandler.prototype) as any;
    handler.dictionaryPopupVisible = true;
    handler.dictionarySupports = (command: string) => command === "recursive-back";
    handler.clearPendingMineCandidate = GamepadHandler.prototype.clearPendingMineCandidate;
    handler.sendDictionaryControlCommand = async (command: string) => {
      actions.push(command);
      return { status: command === "recursive-back" ? "handled" : "ignored" };
    };
    handler.dismissDictionaryPopup = () => {
      actions.push("dismiss");
      return Promise.resolve({ status: "handled" });
    };
    handler.config = {
      onCancel: () => {
        cancelled += 1;
      },
    };

    await GamepadHandler.prototype.cancelSelection.call(handler);

    expect(actions).toEqual(["recursive-back"]);
    expect(cancelled).toBe(1);
  });
});
